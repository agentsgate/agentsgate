/**
 * T458 — MySQL MCP Server helper logic tests
 *
 * Tests the pure helper functions and snapshot file format by mirroring
 * the implementation inline (same pattern as tests/mcp-servers/pg-database-helpers.test.ts).
 * Does NOT spawn the MCP server or connect to MySQL.
 *
 * Covers:
 * - validateTableName regex (same as PG/SQLite server)
 * - quoteIdentifier logic (backtick-based for MySQL)
 * - DDL guard regex (no PRAGMA for MySQL)
 * - delete_snapshot UUID validation regex
 * - Snapshot directory naming from connection string (host_db tag)
 * - Snapshot file format compatibility with MySQLRollbackAdapter
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';
import { MySQLRollbackAdapter } from '../../src/modules/m9-adapters/mysql-rollback-adapter.js';
import type { StateSnapshot } from '../../src/types/interfaces.js';

// ---------------------------------------------------------------------------
// Helpers inlined from implementation (same logic as the MySQL MCP server)
// ---------------------------------------------------------------------------

const TABLE_NAME_RE = /^[A-Za-z0-9_]{1,64}$/;

function validateTableName(name: string): void {
  if (!TABLE_NAME_RE.test(name)) {
    throw new Error(`Invalid table name: "${name}". Only alphanumeric and underscore allowed.`);
  }
}

// MySQL uses backtick identifier quoting
function quoteIdentifier(name: string): string {
  return `\`${name.replace(/`/g, '``')}\``;
}

// MySQL has no PRAGMA — DDL_RE omits it
const DDL_RE = /\b(DROP|CREATE|ALTER|TRUNCATE)\b/i;
const DESTRUCTIVE_RE = /\b(DROP|TRUNCATE)\b/i;

// UUID validation from delete_snapshot tool
const UUID_RE = /^[0-9a-f-]{36}$/;

function isSelectOrWith(sql: string): boolean {
  const upper = sql.trim().toUpperCase();
  return upper.startsWith('SELECT') || upper.startsWith('WITH');
}

/** Mirror the connection-string → snapshot dir tag derivation used by the MySQL server */
function resolveSnapshotDirTag(connectionString: string): string {
  let tag = 'mysql-unknown';
  try {
    const url = new URL(connectionString);
    const host = url.hostname.replace(/[^a-zA-Z0-9._-]/g, '_');
    const dbName = url.pathname.replace(/^\//, '').replace(/[^a-zA-Z0-9._-]/g, '_') || 'default';
    tag = `${host}_${dbName}`;
  } catch { /* use default tag */ }
  return tag;
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ag-mysql-helpers-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. Table name validation
// ---------------------------------------------------------------------------

describe('mysql-database table name validation', () => {
  it('1.1 accepts valid alphanumeric table names', () => {
    expect(() => validateTableName('users')).not.toThrow();
    expect(() => validateTableName('Users123')).not.toThrow();
    expect(() => validateTableName('my_table')).not.toThrow();
  });

  it('1.2 accepts 64-character name (boundary)', () => {
    expect(() => validateTableName('a'.repeat(64))).not.toThrow();
  });

  it('1.3 rejects 65-character name (over boundary)', () => {
    expect(() => validateTableName('a'.repeat(65))).toThrow('Invalid table name');
  });

  it('1.4 rejects empty string', () => {
    expect(() => validateTableName('')).toThrow('Invalid table name');
  });

  it('1.5 rejects names with hyphens', () => {
    expect(() => validateTableName('my-table')).toThrow('Invalid table name');
  });

  it('1.6 rejects names with dots', () => {
    expect(() => validateTableName('schema.table')).toThrow('Invalid table name');
  });

  it('1.7 rejects SQL injection attempts', () => {
    expect(() => validateTableName('users; DROP TABLE users')).toThrow('Invalid table name');
    expect(() => validateTableName("users'--")).toThrow('Invalid table name');
  });

  it('1.8 rejects names with spaces', () => {
    expect(() => validateTableName('my table')).toThrow('Invalid table name');
  });
});

// ---------------------------------------------------------------------------
// 2. Identifier quoting (MySQL backtick style)
// ---------------------------------------------------------------------------

describe('mysql-database identifier quoting', () => {
  it('2.1 wraps identifier in backticks', () => {
    expect(quoteIdentifier('users')).toBe('`users`');
  });

  it('2.2 escapes internal backticks by doubling them', () => {
    expect(quoteIdentifier('my`table')).toBe('`my``table`');
  });

  it('2.3 handles underscores', () => {
    expect(quoteIdentifier('my_table')).toBe('`my_table`');
  });

  it('2.4 handles multiple internal backticks', () => {
    expect(quoteIdentifier('a`b`c')).toBe('`a``b``c`');
  });
});

// ---------------------------------------------------------------------------
// 3. DDL guard regex
// ---------------------------------------------------------------------------

describe('mysql-database DDL guard regex (execute tool)', () => {
  it('3.1 detects DROP', () => {
    expect(DDL_RE.test('DROP TABLE users')).toBe(true);
  });

  it('3.2 detects CREATE', () => {
    expect(DDL_RE.test('CREATE TABLE foo (id INTEGER)')).toBe(true);
  });

  it('3.3 detects ALTER', () => {
    expect(DDL_RE.test('ALTER TABLE users ADD COLUMN age INTEGER')).toBe(true);
  });

  it('3.4 detects TRUNCATE', () => {
    expect(DDL_RE.test('TRUNCATE TABLE users')).toBe(true);
  });

  it('3.5 does NOT detect PRAGMA (MySQL has no PRAGMA)', () => {
    // MySQL DDL_RE omits PRAGMA — this should NOT match
    expect(DDL_RE.test('PRAGMA table_info(users)')).toBe(false);
  });

  it('3.6 allows INSERT through DDL guard', () => {
    expect(DDL_RE.test('INSERT INTO users (name) VALUES (?)')).toBe(false);
  });

  it('3.7 allows UPDATE through DDL guard', () => {
    expect(DDL_RE.test('UPDATE users SET name = ? WHERE id = ?')).toBe(false);
  });

  it('3.8 allows DELETE through DDL guard', () => {
    expect(DDL_RE.test('DELETE FROM users WHERE id = ?')).toBe(false);
  });

  it('3.9 word boundary prevents false positive on column named "dropdown"', () => {
    expect(DDL_RE.test('INSERT INTO ui_elements (dropdown) VALUES (?)')).toBe(false);
  });

  it('3.10 is case-insensitive', () => {
    expect(DDL_RE.test('drop table users')).toBe(true);
    expect(DDL_RE.test('create table foo (id int)')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Destructive DDL guard regex
// ---------------------------------------------------------------------------

describe('mysql-database destructive DDL guard (execute_ddl tool)', () => {
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
// 5. SELECT/WITH guard (query tool)
// ---------------------------------------------------------------------------

describe('mysql-database SELECT/WITH guard', () => {
  it('5.1 allows SELECT', () => {
    expect(isSelectOrWith('SELECT * FROM users')).toBe(true);
  });

  it('5.2 allows WITH (CTE)', () => {
    expect(isSelectOrWith('WITH cte AS (SELECT 1) SELECT * FROM cte')).toBe(true);
  });

  it('5.3 allows SELECT with leading whitespace', () => {
    expect(isSelectOrWith('  SELECT id FROM users')).toBe(true);
  });

  it('5.4 rejects INSERT', () => {
    expect(isSelectOrWith('INSERT INTO users VALUES (?)')).toBe(false);
  });

  it('5.5 rejects UPDATE', () => {
    expect(isSelectOrWith('UPDATE users SET name = ?')).toBe(false);
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
// 6. delete_snapshot UUID validation
// ---------------------------------------------------------------------------

describe('mysql-database delete_snapshot UUID validation', () => {
  it('6.1 accepts a standard UUID', () => {
    expect(UUID_RE.test('123e4567-e89b-12d3-a456-426614174000')).toBe(true);
  });

  it('6.2 accepts a randomUUID()-generated value', () => {
    const id = randomUUID();
    expect(UUID_RE.test(id)).toBe(true);
  });

  it('6.3 rejects a string with path separators', () => {
    expect(UUID_RE.test('../../../etc/passwd')).toBe(false);
  });

  it('6.4 rejects a string with dots', () => {
    expect(UUID_RE.test('abc.def.ghi.jkl.mnop')).toBe(false);
  });

  it('6.5 rejects an empty string', () => {
    expect(UUID_RE.test('')).toBe(false);
  });

  it('6.6 rejects a string shorter than 36 characters', () => {
    expect(UUID_RE.test('123e4567-e89b-12d3-a456')).toBe(false);
  });

  it('6.7 rejects a string longer than 36 characters', () => {
    expect(UUID_RE.test('123e4567-e89b-12d3-a456-4266141740001')).toBe(false);
  });

  it('6.8 rejects uppercase hex (UUID must be lowercase)', () => {
    // Uppercase letters are not in [0-9a-f-] so the UUID_RE should reject them
    expect(UUID_RE.test('123E4567-E89B-12D3-A456-426614174000')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. Snapshot directory tag derivation from connection string
// ---------------------------------------------------------------------------

describe('mysql-database snapshot directory naming', () => {
  it('7.1 extracts host and dbname for tag', () => {
    const tag = resolveSnapshotDirTag('mysql://u:p@myhost:3306/mydb');
    expect(tag).toBe('myhost_mydb');
  });

  it('7.2 handles connection string without port', () => {
    const tag = resolveSnapshotDirTag('mysql://user:pass@localhost/testdb');
    expect(tag).toBe('localhost_testdb');
  });

  it('7.3 uses default tag when connection string is unparseable', () => {
    const tag = resolveSnapshotDirTag('not-a-url');
    expect(tag).toBe('mysql-unknown');
  });

  it('7.4 uses "default" for empty database name', () => {
    const tag = resolveSnapshotDirTag('mysql://user:pass@localhost/');
    expect(tag).toBe('localhost_default');
  });

  it('7.5 MySQLRollbackAdapter.resolveSnapshotDir includes host_db segment', async () => {
    const connStr = 'mysql://u:p@myhost:3306/mydb';
    const adapterNoDir = new MySQLRollbackAdapter(connStr);

    const snapshot: StateSnapshot = {
      adapterId: 'agentsgate-mysql-database',
      operationId: crypto.randomUUID(),
      data: {
        snapshotId: crypto.randomUUID(),
        snapshotTable: 'users',
        connectionString: connStr,
      },
      capturedAt: new Date(),
    };
    const result = await adapterNoDir.rollback(snapshot);
    // The error message includes the full path which should contain the tag
    expect(result.error).toContain('myhost_mydb');
  });
});

// ---------------------------------------------------------------------------
// 8. Snapshot file format compatibility with MySQLRollbackAdapter
// ---------------------------------------------------------------------------

describe('mysql-database snapshot file format compatibility', () => {
  it('8.1 valid snapshot JSON (mysql-database format) can be read and parsed correctly', async () => {
    // Write a snapshot file in the format the MySQL MCP server writes
    const snapshotId = randomUUID();
    const snapshotFile = path.join(tmpDir, `${snapshotId}_users.json`);
    const payload = {
      tableName: 'users',
      capturedAt: new Date().toISOString(),
      rows: [{ id: 1, name: 'Alice' }],
      columns: ['id', 'name'],
    };
    await fs.writeFile(snapshotFile, JSON.stringify(payload), 'utf8');

    // Verify file can be read and parsed — simulating what rollback() does before connecting to MySQL
    const raw = await fs.readFile(snapshotFile, 'utf8');
    const parsed = JSON.parse(raw) as typeof payload;
    expect(parsed.tableName).toBe('users');
    expect(Array.isArray(parsed.rows)).toBe(true);
    expect(Array.isArray(parsed.columns)).toBe(true);
    expect(parsed.rows[0]).toEqual({ id: 1, name: 'Alice' });
    expect(parsed.columns).toContain('id');
    expect(parsed.columns).toContain('name');
  });

  it('8.2 snapshot filename follows <uuid>_<table>.json convention', async () => {
    const snapshotId = randomUUID();
    const tableName = 'my_orders';
    const filename = `${snapshotId}_${tableName}.json`;
    await fs.writeFile(path.join(tmpDir, filename), JSON.stringify({ rows: [], columns: [] }), 'utf8');

    const files = await fs.readdir(tmpDir);
    expect(files.filter(f => f.endsWith('.json'))).toContain(filename);
  });

  it('8.3 snapshot file contains rows and columns fields', async () => {
    const snapshotId = randomUUID();
    const payload = {
      tableName: 'products',
      capturedAt: new Date().toISOString(),
      rows: [{ id: 1, name: 'Widget', price: 9.99 }],
      columns: ['id', 'name', 'price'],
    };
    const filename = `${snapshotId}_products.json`;
    await fs.writeFile(path.join(tmpDir, filename), JSON.stringify(payload), 'utf8');

    const content = await fs.readFile(path.join(tmpDir, filename), 'utf8');
    const parsed = JSON.parse(content) as typeof payload;
    expect(Array.isArray(parsed.rows)).toBe(true);
    expect(Array.isArray(parsed.columns)).toBe(true);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.columns).toContain('name');
  });

  it('8.4 empty-rows snapshot is valid JSON and readable', async () => {
    const snapshotId = randomUUID();
    const payload = {
      tableName: 'empty_table',
      capturedAt: new Date().toISOString(),
      rows: [] as unknown[],
      columns: ['id', 'value'],
    };
    const filename = `${snapshotId}_empty_table.json`;
    await fs.writeFile(path.join(tmpDir, filename), JSON.stringify(payload), 'utf8');

    // Verify the file can be read and the rows/columns arrays are present and empty/non-empty
    const raw = await fs.readFile(path.join(tmpDir, filename), 'utf8');
    const parsed = JSON.parse(raw) as typeof payload;
    expect(parsed.tableName).toBe('empty_table');
    expect(Array.isArray(parsed.rows)).toBe(true);
    expect(parsed.rows).toHaveLength(0);
    expect(parsed.columns).toEqual(['id', 'value']);

    // Adapter rollback should return "not found" for a non-existent snapshotId,
    // verifying the adapter checks file existence first
    const adapter = new MySQLRollbackAdapter(
      'mysql://invalid:invalid@127.0.0.1:33099/nonexistent',
      tmpDir,
    );
    const snapshot: StateSnapshot = {
      adapterId: 'agentsgate-mysql-database',
      operationId: crypto.randomUUID(),
      data: {
        snapshotId: randomUUID(), // intentionally wrong ID — file not found
        snapshotTable: 'empty_table',
        connectionString: 'mysql://invalid:invalid@127.0.0.1:33099/nonexistent',
      },
      capturedAt: new Date(),
    };
    const result = await adapter.rollback(snapshot);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/i);
  });
});
