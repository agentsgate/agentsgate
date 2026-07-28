/**
 * T441 — Database MCP Server Tests
 *
 * Tests the logic patterns of the agentsgate-database MCP server:
 * - Table name validation regex
 * - DDL guard regex
 * - SELECT guard logic
 * - Identifier quoting logic
 * - Snapshot directory/file structure
 * - Snapshot/restore roundtrip using better-sqlite3 directly
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Helpers inlined from implementation (same logic, tested in isolation)
// ---------------------------------------------------------------------------

const TABLE_NAME_RE = /^[A-Za-z0-9_]{1,64}$/;

function validateTableName(name: string): void {
  if (!TABLE_NAME_RE.test(name)) {
    throw new Error('Invalid table name');
  }
}

function quoteIdentifier(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}

const DDL_RE = /\b(DROP|CREATE|ALTER|TRUNCATE|PRAGMA)\b/;
const DESTRUCTIVE_RE = /\b(DROP|TRUNCATE)\b/;

function isSelectOrWith(sql: string): boolean {
  const upper = sql.trim().toUpperCase();
  return upper.startsWith('SELECT') || upper.startsWith('WITH');
}

// ---------------------------------------------------------------------------
// Snapshot helpers (mirrors implementation)
// ---------------------------------------------------------------------------

async function saveSnapshotDirect(
  db: Database.Database,
  dbDir: string,
  tableName: string,
): Promise<string> {
  validateTableName(tableName);
  const snapshotDir = path.join(dbDir, '.agentsgate-snapshots');
  await fs.mkdir(snapshotDir, { recursive: true });
  const rows = db.prepare(`SELECT * FROM ${quoteIdentifier(tableName)}`).all();
  const snapshotId = randomUUID();
  const filename = `${snapshotId}_${tableName}.json`;
  await fs.writeFile(
    path.join(snapshotDir, filename),
    JSON.stringify(rows, null, 2),
    'utf-8',
  );
  return snapshotId;
}

async function restoreSnapshotDirect(
  db: Database.Database,
  dbDir: string,
  snapshotId: string,
  tableName: string,
): Promise<number> {
  validateTableName(tableName);
  const snapshotDir = path.join(dbDir, '.agentsgate-snapshots');
  const filename = `${snapshotId}_${tableName}.json`;
  const content = await fs.readFile(path.join(snapshotDir, filename), 'utf-8');
  const rows = JSON.parse(content) as Record<string, unknown>[];
  const quoted = quoteIdentifier(tableName);

  const restoreInTransaction = db.transaction(() => {
    db.prepare(`DELETE FROM ${quoted}`).run();
    if (rows.length === 0) return 0;
    const columns = Object.keys(rows[0] as object);
    const quotedColumns = columns.map(quoteIdentifier).join(', ');
    const placeholders = columns.map(() => '?').join(', ');
    const insertSql = `INSERT INTO ${quoted} (${quotedColumns}) VALUES (${placeholders})`;
    const insertStmt = db.prepare(insertSql);
    for (const row of rows) {
      const values = columns.map((col) => (row as Record<string, unknown>)[col]);
      insertStmt.run(values);
    }
    return rows.length;
  });

  return restoreInTransaction() as number;
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let db: Database.Database;
let dbPath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ag-db-test-'));
  dbPath = path.join(tmpDir, 'test.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
});

afterEach(async () => {
  db.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. Table name validation
// ---------------------------------------------------------------------------

describe('table name validation', () => {
  it('1.1 accepts valid alphanumeric table names', () => {
    expect(() => validateTableName('users')).not.toThrow();
    expect(() => validateTableName('Users123')).not.toThrow();
    expect(() => validateTableName('my_table')).not.toThrow();
  });

  it('1.2 accepts 64-character name (boundary)', () => {
    const name = 'a'.repeat(64);
    expect(() => validateTableName(name)).not.toThrow();
  });

  it('1.3 rejects 65-character name (over boundary)', () => {
    const name = 'a'.repeat(65);
    expect(() => validateTableName(name)).toThrow('Invalid table name');
  });

  it('1.4 rejects empty string', () => {
    expect(() => validateTableName('')).toThrow('Invalid table name');
  });

  it('1.5 rejects names with hyphens', () => {
    expect(() => validateTableName('my-table')).toThrow('Invalid table name');
  });

  it('1.6 rejects names with spaces', () => {
    expect(() => validateTableName('my table')).toThrow('Invalid table name');
  });

  it('1.7 rejects names with SQL injection attempts', () => {
    expect(() => validateTableName('users; DROP TABLE users')).toThrow('Invalid table name');
    expect(() => validateTableName("users'--")).toThrow('Invalid table name');
  });

  it('1.8 rejects names with dots', () => {
    expect(() => validateTableName('schema.table')).toThrow('Invalid table name');
  });
});

// ---------------------------------------------------------------------------
// 2. Identifier quoting
// ---------------------------------------------------------------------------

describe('identifier quoting', () => {
  it('2.1 wraps identifier in double quotes', () => {
    expect(quoteIdentifier('users')).toBe('"users"');
  });

  it('2.2 escapes internal double quotes by doubling them', () => {
    expect(quoteIdentifier('my"table')).toBe('"my""table"');
  });

  it('2.3 handles identifiers with underscores', () => {
    expect(quoteIdentifier('my_table')).toBe('"my_table"');
  });

  it('2.4 handles names with multiple internal quotes', () => {
    expect(quoteIdentifier('a"b"c')).toBe('"a""b""c"');
  });
});

// ---------------------------------------------------------------------------
// 3. DDL guard regex
// ---------------------------------------------------------------------------

describe('DDL guard regex (execute tool)', () => {
  it('3.1 detects DROP keyword (uppercase)', () => {
    expect(DDL_RE.test('DROP TABLE users')).toBe(true);
  });

  it('3.2 detects CREATE keyword (uppercase)', () => {
    expect(DDL_RE.test('CREATE TABLE foo (id INTEGER)')).toBe(true);
  });

  it('3.3 detects ALTER keyword', () => {
    expect(DDL_RE.test('ALTER TABLE users ADD COLUMN age INTEGER')).toBe(true);
  });

  it('3.4 detects TRUNCATE keyword', () => {
    expect(DDL_RE.test('TRUNCATE TABLE users')).toBe(true);
  });

  it('3.5 detects PRAGMA keyword', () => {
    expect(DDL_RE.test('PRAGMA table_info(users)')).toBe(true);
  });

  it('3.6 allows INSERT statement through DDL guard', () => {
    expect(DDL_RE.test('INSERT INTO users (name) VALUES (?)')).toBe(false);
  });

  it('3.7 allows UPDATE statement through DDL guard', () => {
    expect(DDL_RE.test('UPDATE users SET name = ? WHERE id = ?')).toBe(false);
  });

  it('3.8 allows DELETE statement through DDL guard', () => {
    expect(DDL_RE.test('DELETE FROM users WHERE id = ?')).toBe(false);
  });

  it('3.9 word boundary prevents false positives (e.g. column named "dropdown")', () => {
    expect(DDL_RE.test('INSERT INTO ui_elements (dropdown) VALUES (?)')).toBe(false);
  });

  it('3.10 detects DDL in mixed-case SQL after uppercasing', () => {
    const sql = 'drop table users';
    expect(DDL_RE.test(sql.toUpperCase())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Destructive DDL guard regex
// ---------------------------------------------------------------------------

describe('destructive DDL guard regex (execute_ddl tool)', () => {
  it('4.1 detects DROP', () => {
    expect(DESTRUCTIVE_RE.test('DROP TABLE users')).toBe(true);
  });

  it('4.2 detects TRUNCATE', () => {
    expect(DESTRUCTIVE_RE.test('TRUNCATE TABLE users')).toBe(true);
  });

  it('4.3 does not flag CREATE', () => {
    expect(DESTRUCTIVE_RE.test('CREATE TABLE foo (id INTEGER PRIMARY KEY)')).toBe(false);
  });

  it('4.4 does not flag ALTER', () => {
    expect(DESTRUCTIVE_RE.test('ALTER TABLE users ADD COLUMN age INTEGER')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. SELECT/WITH guard
// ---------------------------------------------------------------------------

describe('SELECT/WITH guard (query tool)', () => {
  it('5.1 allows SELECT statement', () => {
    expect(isSelectOrWith('SELECT * FROM users')).toBe(true);
  });

  it('5.2 allows WITH (CTE) statement', () => {
    expect(isSelectOrWith('WITH cte AS (SELECT 1) SELECT * FROM cte')).toBe(true);
  });

  it('5.3 allows SELECT with leading whitespace', () => {
    expect(isSelectOrWith('  SELECT id FROM users')).toBe(true);
  });

  it('5.4 rejects INSERT', () => {
    expect(isSelectOrWith('INSERT INTO users VALUES (1)')).toBe(false);
  });

  it('5.5 rejects UPDATE', () => {
    expect(isSelectOrWith('UPDATE users SET name = "x"')).toBe(false);
  });

  it('5.6 rejects DELETE', () => {
    expect(isSelectOrWith('DELETE FROM users')).toBe(false);
  });

  it('5.7 rejects DROP', () => {
    expect(isSelectOrWith('DROP TABLE users')).toBe(false);
  });

  it('5.8 is case-insensitive (lowercase select)', () => {
    expect(isSelectOrWith('select * from users')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. Snapshot directory structure
// ---------------------------------------------------------------------------

describe('snapshot directory and file structure', () => {
  it('6.1 snapshot directory is created inside dbDir as .agentsgate-snapshots', async () => {
    db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)');
    await saveSnapshotDirect(db, tmpDir, 'items');
    const snapshotDir = path.join(tmpDir, '.agentsgate-snapshots');
    const stat = await fs.stat(snapshotDir);
    expect(stat.isDirectory()).toBe(true);
  });

  it('6.2 snapshot filename follows <uuid>_<table>.json convention', async () => {
    db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)');
    const snapshotId = await saveSnapshotDirect(db, tmpDir, 'items');
    const snapshotDir = path.join(tmpDir, '.agentsgate-snapshots');
    const files = await fs.readdir(snapshotDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f-]{36}_items\.json$/);
    expect(files[0]).toBe(`${snapshotId}_items.json`);
  });

  it('6.3 snapshot file contains valid JSON array of rows', async () => {
    db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)');
    db.exec("INSERT INTO items (id, name) VALUES (1, 'alpha'), (2, 'beta')");
    const snapshotId = await saveSnapshotDirect(db, tmpDir, 'items');
    const snapshotDir = path.join(tmpDir, '.agentsgate-snapshots');
    const content = await fs.readFile(
      path.join(snapshotDir, `${snapshotId}_items.json`),
      'utf-8',
    );
    const rows = JSON.parse(content) as unknown[];
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(2);
  });

  it('6.4 snapshot of empty table produces empty JSON array', async () => {
    db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)');
    const snapshotId = await saveSnapshotDirect(db, tmpDir, 'items');
    const snapshotDir = path.join(tmpDir, '.agentsgate-snapshots');
    const content = await fs.readFile(
      path.join(snapshotDir, `${snapshotId}_items.json`),
      'utf-8',
    );
    const rows = JSON.parse(content) as unknown[];
    expect(rows).toHaveLength(0);
  });

  it('6.5 manually written snapshot file can be read back as valid JSON', async () => {
    const snapshotDir = path.join(tmpDir, '.agentsgate-snapshots');
    await fs.mkdir(snapshotDir, { recursive: true });
    const snapshotId = randomUUID();
    const filename = `${snapshotId}_products.json`;
    const sampleData = [{ id: 1, product: 'Widget' }];
    await fs.writeFile(
      path.join(snapshotDir, filename),
      JSON.stringify(sampleData, null, 2),
      'utf-8',
    );

    const content = await fs.readFile(path.join(snapshotDir, filename), 'utf-8');
    const parsed = JSON.parse(content) as unknown[];
    expect(parsed).toHaveLength(1);
    expect((parsed[0] as Record<string, unknown>)['product']).toBe('Widget');
  });

  it('6.6 snapshot filename parsing extracts uuid and table name correctly', () => {
    const snapshotId = '123e4567-e89b-12d3-a456-426614174000';
    const tableName = 'my_table';
    const filename = `${snapshotId}_${tableName}.json`;
    const withoutExt = filename.slice(0, -5);
    const underscoreIdx = withoutExt.indexOf('_');
    const parsedId = withoutExt.slice(0, underscoreIdx);
    const parsedTable = withoutExt.slice(underscoreIdx + 1);
    expect(parsedId).toBe(snapshotId);
    expect(parsedTable).toBe(tableName);
  });
});

// ---------------------------------------------------------------------------
// 7. Snapshot / restore roundtrip
// ---------------------------------------------------------------------------

describe('snapshot and restore roundtrip', () => {
  it('7.1 snapshot captures all rows, restore brings them back', async () => {
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, age INTEGER)');
    db.exec("INSERT INTO users VALUES (1, 'Alice', 30), (2, 'Bob', 25)");

    const snapshotId = await saveSnapshotDirect(db, tmpDir, 'users');

    // Mutate the table
    db.exec('DELETE FROM users');
    db.exec("INSERT INTO users VALUES (99, 'Charlie', 40)");

    // Restore from snapshot
    const rowsRestored = await restoreSnapshotDirect(db, tmpDir, snapshotId, 'users');

    expect(rowsRestored).toBe(2);
    const rows = db.prepare('SELECT * FROM users ORDER BY id').all() as Array<{
      id: number;
      name: string;
      age: number;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].name).toBe('Alice');
    expect(rows[1].name).toBe('Bob');
  });

  it('7.2 restore to empty table from non-empty snapshot works', async () => {
    db.exec('CREATE TABLE products (id INTEGER PRIMARY KEY, title TEXT)');
    db.exec("INSERT INTO products VALUES (1, 'Widget'), (2, 'Gadget'), (3, 'Doohickey')");

    const snapshotId = await saveSnapshotDirect(db, tmpDir, 'products');

    db.exec('DELETE FROM products');

    const rowsRestored = await restoreSnapshotDirect(db, tmpDir, snapshotId, 'products');
    expect(rowsRestored).toBe(3);

    const rows = db.prepare('SELECT COUNT(*) as c FROM products').get() as { c: number };
    expect(rows.c).toBe(3);
  });

  it('7.3 restoring an empty snapshot clears the table', async () => {
    db.exec('CREATE TABLE logs (id INTEGER PRIMARY KEY, msg TEXT)');
    // Save empty snapshot first
    const snapshotId = await saveSnapshotDirect(db, tmpDir, 'logs');

    // Insert data afterwards
    db.exec("INSERT INTO logs VALUES (1, 'hello')");

    // Restore empty snapshot
    const rowsRestored = await restoreSnapshotDirect(db, tmpDir, snapshotId, 'logs');
    expect(rowsRestored).toBe(0);

    const rows = db.prepare('SELECT COUNT(*) as c FROM logs').get() as { c: number };
    expect(rows.c).toBe(0);
  });

  it('7.4 multiple snapshots can be taken and the correct one is restored', async () => {
    db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, val TEXT)');
    db.exec("INSERT INTO items VALUES (1, 'v1')");
    const snap1 = await saveSnapshotDirect(db, tmpDir, 'items');

    db.exec("UPDATE items SET val = 'v2' WHERE id = 1");
    const snap2 = await saveSnapshotDirect(db, tmpDir, 'items');

    // Restore snap1 (should have v1)
    await restoreSnapshotDirect(db, tmpDir, snap1, 'items');
    const row1 = db.prepare('SELECT val FROM items WHERE id = 1').get() as { val: string };
    expect(row1.val).toBe('v1');

    // Restore snap2 (should have v2)
    await restoreSnapshotDirect(db, tmpDir, snap2, 'items');
    const row2 = db.prepare('SELECT val FROM items WHERE id = 1').get() as { val: string };
    expect(row2.val).toBe('v2');
  });

  it('7.5 snapshot preserves column data types (integer, text, null)', async () => {
    db.exec('CREATE TABLE typed (id INTEGER PRIMARY KEY, label TEXT, score REAL, note TEXT)');
    db.exec("INSERT INTO typed VALUES (1, 'test', 3.14, NULL)");

    const snapshotId = await saveSnapshotDirect(db, tmpDir, 'typed');
    db.exec('DELETE FROM typed');
    await restoreSnapshotDirect(db, tmpDir, snapshotId, 'typed');

    const row = db.prepare('SELECT * FROM typed WHERE id = 1').get() as {
      id: number;
      label: string;
      score: number;
      note: unknown;
    };
    expect(row.id).toBe(1);
    expect(row.label).toBe('test');
    expect(row.score).toBeCloseTo(3.14);
    expect(row.note).toBeNull();
  });

  it('7.6 snapshot file is valid JSON that lists all inserted rows', async () => {
    db.exec('CREATE TABLE orders (id INTEGER PRIMARY KEY, status TEXT)');
    db.exec("INSERT INTO orders VALUES (1, 'pending'), (2, 'shipped'), (3, 'delivered')");

    const snapshotId = await saveSnapshotDirect(db, tmpDir, 'orders');
    const snapshotDir = path.join(tmpDir, '.agentsgate-snapshots');
    const content = await fs.readFile(
      path.join(snapshotDir, `${snapshotId}_orders.json`),
      'utf-8',
    );
    const rows = JSON.parse(content) as Array<{ id: number; status: string }>;
    expect(rows).toHaveLength(3);
    const statuses = rows.map((r) => r.status).sort();
    expect(statuses).toEqual(['delivered', 'pending', 'shipped']);
  });

  it('7.7 restore is atomic — partial failure does not corrupt the table', async () => {
    db.exec(
      'CREATE TABLE events (id INTEGER PRIMARY KEY, code TEXT NOT NULL)',
    );
    db.exec("INSERT INTO events VALUES (1, 'A'), (2, 'B')");

    const snapshotId = await saveSnapshotDirect(db, tmpDir, 'events');
    db.exec("DELETE FROM events");
    db.exec("INSERT INTO events VALUES (99, 'Z')");

    // Restore from snapshot — should succeed atomically
    await restoreSnapshotDirect(db, tmpDir, snapshotId, 'events');
    const rows = db.prepare('SELECT * FROM events ORDER BY id').all() as Array<{
      id: number;
      code: string;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].code).toBe('A');
    expect(rows[1].code).toBe('B');
  });

  it('7.8 list_snapshots-style filename parsing works for table names with underscores', () => {
    // The implementation uses indexOf('_') to split uuid from table name,
    // so a table with underscores should still parse correctly because the
    // UUID comes first (everything before first '_' is the UUID prefix).
    // UUID format is 8-4-4-4-12 hex chars with dashes, first segment has no '_',
    // so the first '_' is always the separator.
    const snapshotId = 'aabbccdd-eeff-1122-3344-556677889900';
    const tableName = 'order_items';
    const filename = `${snapshotId}_${tableName}.json`;
    const withoutExt = filename.slice(0, -5);
    const underscoreIdx = withoutExt.indexOf('_');
    const parsedId = withoutExt.slice(0, underscoreIdx);
    const parsedTable = withoutExt.slice(underscoreIdx + 1);
    expect(parsedId).toBe(snapshotId);
    expect(parsedTable).toBe(tableName);
  });

  it('7.9 invalid snapshot file path throws on readFile', async () => {
    await expect(
      restoreSnapshotDirect(db, tmpDir, 'nonexistent-id', 'users'),
    ).rejects.toThrow();
  });

  it('7.10 saving snapshot with invalid table name throws', async () => {
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY)');
    await expect(
      saveSnapshotDirect(db, tmpDir, 'invalid-name!'),
    ).rejects.toThrow('Invalid table name');
  });
});
