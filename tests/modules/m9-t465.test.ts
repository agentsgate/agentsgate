/**
 * T465 — Tests for:
 *   DX3  quoteIdentifier / quoteIdentifierMysql utilities
 *   DX4  Snapshot JSON version field
 *   RB2  rollbackMultiple() on DatabaseRollbackAdapter
 *   RB5  rollbackWithUndo() on DatabaseRollbackAdapter
 *
 * Uses real SQLite (:memory: via temp file) — no mocks for the database.
 * Temp dirs are cleaned up in afterEach.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';

import { quoteIdentifier, quoteIdentifierMysql } from '../../src/utils/sql.js';
import { DatabaseRollbackAdapter } from '../../src/modules/m9-adapters/database-rollback-adapter.js';
import type { StateSnapshot } from '../../src/types/interfaces.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temp directory and return its path. */
async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ag-t465-'));
}

/** Create a SQLite DB in the given dir, create tables, and return the db path. */
function makeSqliteDb(dir: string, tables: Array<{ name: string; rows: Record<string, unknown>[] }>): string {
  const dbPath = path.join(dir, `test-${randomUUID()}.db`);
  const db = new Database(dbPath);
  for (const { name, rows } of tables) {
    if (rows.length === 0) {
      db.prepare(`CREATE TABLE IF NOT EXISTS "${name}" (id INTEGER PRIMARY KEY, value TEXT)`).run();
    } else {
      const cols = Object.keys(rows[0]!);
      const colDefs = cols.map(c => `"${c}" TEXT`).join(', ');
      db.prepare(`CREATE TABLE IF NOT EXISTS "${name}" (${colDefs})`).run();
      const placeholders = cols.map(() => '?').join(', ');
      const colList = cols.map(c => `"${c}"`).join(', ');
      const stmt = db.prepare(`INSERT INTO "${name}" (${colList}) VALUES (${placeholders})`);
      for (const row of rows) {
        stmt.run(cols.map(c => row[c] ?? null));
      }
    }
  }
  db.close();
  return dbPath;
}

/** Write a snapshot JSON file and return the snapshotId. */
async function writeSnapshotFile(
  snapDir: string,
  tableName: string,
  rows: Record<string, unknown>[],
  columns: string[],
  includeVersion = true,
): Promise<string> {
  await fs.mkdir(snapDir, { recursive: true });
  const snapshotId = randomUUID();
  const payload: Record<string, unknown> = { tableName, capturedAt: new Date().toISOString(), rows, columns };
  if (includeVersion) payload['version'] = 1;
  await fs.writeFile(
    path.join(snapDir, `${snapshotId}_${tableName}.json`),
    JSON.stringify(payload),
    'utf8',
  );
  return snapshotId;
}

/** Read all rows from a SQLite table. */
function readTableRows(dbPath: string, tableName: string): Record<string, unknown>[] {
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare(`SELECT * FROM "${tableName}"`).all() as Record<string, unknown>[];
  db.close();
  return rows;
}

const tempDirs: string[] = [];
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// DX3 — quoteIdentifier
// ---------------------------------------------------------------------------

describe('DX3 — quoteIdentifier (ANSI SQL / SQLite / PG)', () => {
  it('wraps a normal identifier in double-quotes', () => {
    expect(quoteIdentifier('users')).toBe('"users"');
  });

  it('escapes embedded double-quotes by doubling them', () => {
    expect(quoteIdentifier('my"table')).toBe('"my""table"');
  });

  it('handles an empty string', () => {
    expect(quoteIdentifier('')).toBe('""');
  });

  it('handles identifiers with multiple embedded double-quotes', () => {
    expect(quoteIdentifier('a"b"c')).toBe('"a""b""c"');
  });

  it('does not alter identifiers that have no special chars', () => {
    expect(quoteIdentifier('order_items_2024')).toBe('"order_items_2024"');
  });
});

describe('DX3 — quoteIdentifierMysql (MySQL / MariaDB backtick quoting)', () => {
  it('wraps a normal identifier in backticks', () => {
    expect(quoteIdentifierMysql('users')).toBe('`users`');
  });

  it('escapes embedded backticks by doubling them', () => {
    expect(quoteIdentifierMysql('my`table')).toBe('`my``table`');
  });

  it('handles an empty string', () => {
    expect(quoteIdentifierMysql('')).toBe('``');
  });

  it('handles identifiers with multiple embedded backticks', () => {
    expect(quoteIdentifierMysql('a`b`c')).toBe('`a``b``c`');
  });

  it('does not alter normal identifiers', () => {
    expect(quoteIdentifierMysql('order_items')).toBe('`order_items`');
  });
});

// ---------------------------------------------------------------------------
// DX4 — Snapshot JSON version field
// ---------------------------------------------------------------------------

describe('DX4 — Snapshot version field', () => {
  it('saveSnapshot (via captureCurrentState) writes version: 1 to the snapshot file', async () => {
    const dir = await makeTempDir();
    tempDirs.push(dir);
    const dbPath = makeSqliteDb(dir, [{ name: 'items', rows: [{ id: '1', name: 'foo' }] }]);
    const snapDir = path.join(dir, '.agentsgate-snapshots');

    const adapter = new DatabaseRollbackAdapter(dbPath);
    // Trigger captureCurrentState by calling rollbackWithUndo with a snapshot that has snapshotTable
    // but no snapshotId (so rollback fails, but captureCurrentState still runs)
    const snap: StateSnapshot = {
      adapterId: 'agentsgate-database',
      operationId: 'op-dx4-1',
      data: { snapshotTable: 'items', snapshotId: undefined },
      capturedAt: new Date(),
    };
    const result = await (adapter as any).captureCurrentState('items');
    // A snapshotId string was returned
    expect(typeof result).toBe('string');
    // The file exists
    const files = await fs.readdir(snapDir);
    const snapshotFile = files.find(f => f.endsWith('_items.json'));
    expect(snapshotFile).toBeDefined();
    const content = JSON.parse(await fs.readFile(path.join(snapDir, snapshotFile!), 'utf8'));
    expect(content.version).toBe(1);
  });

  it('rollback can parse old snapshots without a version field (backward compat)', async () => {
    const dir = await makeTempDir();
    tempDirs.push(dir);
    // Create DB with some rows
    const dbPath = makeSqliteDb(dir, [
      { name: 'legacy', rows: [{ id: '1', name: 'old' }] },
    ]);
    const snapDir = path.join(dir, '.agentsgate-snapshots');
    // Write snapshot WITHOUT version field (old format)
    const snapshotId = await writeSnapshotFile(snapDir, 'legacy', [{ id: '42', name: 'restored' }], ['id', 'name'], false);

    const adapter = new DatabaseRollbackAdapter(dbPath);
    const snap: StateSnapshot = {
      adapterId: 'agentsgate-database',
      operationId: 'op-dx4-2',
      data: { snapshotId, snapshotTable: 'legacy', dbPath },
      capturedAt: new Date(),
    };
    const result = await adapter.rollback(snap);
    expect(result.success).toBe(true);
    const rows = readTableRows(dbPath, 'legacy');
    expect(rows).toHaveLength(1);
    expect(rows[0]!['name']).toBe('restored');
  });

  it('rollback accepts snapshots that include version: 1', async () => {
    const dir = await makeTempDir();
    tempDirs.push(dir);
    const dbPath = makeSqliteDb(dir, [
      { name: 'products', rows: [{ id: '10', name: 'original' }] },
    ]);
    const snapDir = path.join(dir, '.agentsgate-snapshots');
    const snapshotId = await writeSnapshotFile(snapDir, 'products', [{ id: '99', name: 'v1snap' }], ['id', 'name'], true);

    const adapter = new DatabaseRollbackAdapter(dbPath);
    const snap: StateSnapshot = {
      adapterId: 'agentsgate-database',
      operationId: 'op-dx4-3',
      data: { snapshotId, snapshotTable: 'products', dbPath },
      capturedAt: new Date(),
    };
    const result = await adapter.rollback(snap);
    expect(result.success).toBe(true);
    const rows = readTableRows(dbPath, 'products');
    expect(rows).toHaveLength(1);
    expect(rows[0]!['name']).toBe('v1snap');
  });
});

// ---------------------------------------------------------------------------
// RB2 — rollbackMultiple() on DatabaseRollbackAdapter
// ---------------------------------------------------------------------------

describe('RB2 — rollbackMultiple() on DatabaseRollbackAdapter', () => {
  it('happy path: restores two tables atomically in a single call', async () => {
    const dir = await makeTempDir();
    tempDirs.push(dir);
    const dbPath = makeSqliteDb(dir, [
      { name: 'users', rows: [{ id: '1', name: 'Alice' }] },
      { name: 'orders', rows: [{ id: '100', amount: '50' }] },
    ]);
    const snapDir = path.join(dir, '.agentsgate-snapshots');

    const usersSnapId = await writeSnapshotFile(snapDir, 'users', [{ id: '1', name: 'Restored-Alice' }], ['id', 'name']);
    const ordersSnapId = await writeSnapshotFile(snapDir, 'orders', [{ id: '100', amount: '999' }], ['id', 'amount']);

    const adapter = new DatabaseRollbackAdapter(dbPath);
    const result = await adapter.rollbackMultiple([
      { snapshotId: usersSnapId, snapshotTable: 'users' },
      { snapshotId: ordersSnapId, snapshotTable: 'orders' },
    ]);

    expect(result.success).toBe(true);
    expect(result.restoredFiles).toContain('users');
    expect(result.restoredFiles).toContain('orders');
    expect(result.failedFiles).toHaveLength(0);

    const userRows = readTableRows(dbPath, 'users');
    expect(userRows).toHaveLength(1);
    expect(userRows[0]!['name']).toBe('Restored-Alice');

    const orderRows = readTableRows(dbPath, 'orders');
    expect(orderRows).toHaveLength(1);
    expect(orderRows[0]!['amount']).toBe('999');
  });

  it('empty snapshots array returns success immediately without touching the DB', async () => {
    const dir = await makeTempDir();
    tempDirs.push(dir);
    const dbPath = makeSqliteDb(dir, [{ name: 'noop', rows: [{ id: '1', name: 'keep' }] }]);

    const adapter = new DatabaseRollbackAdapter(dbPath);
    const result = await adapter.rollbackMultiple([]);

    expect(result.success).toBe(true);
    expect(result.restoredFiles).toHaveLength(0);
    expect(result.failedFiles).toHaveLength(0);

    // DB should be untouched
    const rows = readTableRows(dbPath, 'noop');
    expect(rows).toHaveLength(1);
  });

  it('returns failure when a snapshot file is missing (fail-fast before touching DB)', async () => {
    const dir = await makeTempDir();
    tempDirs.push(dir);
    const dbPath = makeSqliteDb(dir, [
      { name: 'safe', rows: [{ id: '1', name: 'original' }] },
    ]);
    const snapDir = path.join(dir, '.agentsgate-snapshots');
    // Write only one valid snapshot
    const goodSnapId = await writeSnapshotFile(snapDir, 'safe', [{ id: '2', name: 'shouldNotApply' }], ['id', 'name']);

    const adapter = new DatabaseRollbackAdapter(dbPath);
    const result = await adapter.rollbackMultiple([
      { snapshotId: goodSnapId, snapshotTable: 'safe' },
      { snapshotId: 'nonexistent-uuid', snapshotTable: 'missing_table' },
    ]);

    expect(result.success).toBe(false);
    expect(result.failedFiles).toContain('missing_table');
    expect(result.error).toMatch(/not found/i);

    // The 'safe' table must NOT have been modified (fail-fast before DB transaction)
    const rows = readTableRows(dbPath, 'safe');
    expect(rows[0]!['name']).toBe('original');
  });

  it('rolls back ALL tables when a DB error occurs mid-transaction (atomicity)', async () => {
    const dir = await makeTempDir();
    tempDirs.push(dir);
    // Create DB with just one table; second snapshot references a non-existent table
    const dbPath = makeSqliteDb(dir, [
      { name: 'real_table', rows: [{ id: '1', name: 'before' }] },
    ]);
    const snapDir = path.join(dir, '.agentsgate-snapshots');
    const snap1 = await writeSnapshotFile(snapDir, 'real_table', [{ id: '1', name: 'after' }], ['id', 'name']);
    const snap2 = await writeSnapshotFile(snapDir, 'ghost_table', [], []);

    const adapter = new DatabaseRollbackAdapter(dbPath);
    const result = await adapter.rollbackMultiple([
      { snapshotId: snap1, snapshotTable: 'real_table' },
      { snapshotId: snap2, snapshotTable: 'ghost_table' },  // ghost_table doesn't exist → DB error
    ]);

    expect(result.success).toBe(false);
    // real_table should NOT have been changed due to transaction rollback
    const rows = readTableRows(dbPath, 'real_table');
    expect(rows[0]!['name']).toBe('before');
  });
});

// ---------------------------------------------------------------------------
// RB5 — rollbackWithUndo() on DatabaseRollbackAdapter
// ---------------------------------------------------------------------------

describe('RB5 — rollbackWithUndo() on DatabaseRollbackAdapter', () => {
  it('happy path: returns a redoSnapshotId that can restore original state', async () => {
    const dir = await makeTempDir();
    tempDirs.push(dir);
    const dbPath = makeSqliteDb(dir, [
      { name: 'catalog', rows: [{ id: '1', name: 'before-rollback' }] },
    ]);
    const snapDir = path.join(dir, '.agentsgate-snapshots');
    // Snapshot to roll BACK to (old state)
    const oldSnapId = await writeSnapshotFile(snapDir, 'catalog', [{ id: '1', name: 'old-state' }], ['id', 'name']);

    const adapter = new DatabaseRollbackAdapter(dbPath);
    const snap: StateSnapshot = {
      adapterId: 'agentsgate-database',
      operationId: 'op-rb5-1',
      data: { snapshotId: oldSnapId, snapshotTable: 'catalog', dbPath },
      capturedAt: new Date(),
    };

    const result = await adapter.rollbackWithUndo(snap);

    // The rollback itself should succeed
    expect(result.success).toBe(true);
    // A redo snapshot ID was created
    expect(typeof result.redoSnapshotId).toBe('string');
    expect(result.redoSnapshotId).not.toBe('');

    // DB is now in old-state
    const rowsAfterRollback = readTableRows(dbPath, 'catalog');
    expect(rowsAfterRollback[0]!['name']).toBe('old-state');

    // Use redoSnapshotId to restore the "before-rollback" state
    const redoSnap: StateSnapshot = {
      adapterId: 'agentsgate-database',
      operationId: 'op-rb5-redo',
      data: { snapshotId: result.redoSnapshotId, snapshotTable: 'catalog', dbPath },
      capturedAt: new Date(),
    };
    const redoResult = await adapter.rollback(redoSnap);
    expect(redoResult.success).toBe(true);

    const rowsAfterRedo = readTableRows(dbPath, 'catalog');
    expect(rowsAfterRedo[0]!['name']).toBe('before-rollback');
  });

  it('missing snapshotTable in snapshot data: still performs rollback, redoSnapshotId is undefined', async () => {
    const dir = await makeTempDir();
    tempDirs.push(dir);
    const dbPath = makeSqliteDb(dir, [
      { name: 'data', rows: [{ id: '1', name: 'current' }] },
    ]);
    const snapDir = path.join(dir, '.agentsgate-snapshots');
    const snapId = await writeSnapshotFile(snapDir, 'data', [{ id: '1', name: 'restored' }], ['id', 'name']);

    const adapter = new DatabaseRollbackAdapter(dbPath);
    // No snapshotTable in data
    const snap: StateSnapshot = {
      adapterId: 'agentsgate-database',
      operationId: 'op-rb5-notable',
      data: { snapshotId: snapId, dbPath },   // intentionally no snapshotTable
      capturedAt: new Date(),
    };

    const result = await adapter.rollbackWithUndo(snap);

    // redoSnapshotId should be undefined when snapshotTable is missing
    expect(result.redoSnapshotId).toBeUndefined();
    // The rollback itself should fail gracefully (missing snapshotTable → rollback returns error)
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/snapshotTable/i);
  });

  it('captureCurrentState failure does not block rollback (redo unavailable but rollback proceeds)', async () => {
    // Simulate by passing a non-existent dbPath for capture but valid snapshotFile
    const dir = await makeTempDir();
    tempDirs.push(dir);
    // We use a VALID db for the rollback, but will monkey-patch captureCurrentState to throw
    const dbPath = makeSqliteDb(dir, [
      { name: 'events', rows: [{ id: '7', name: 'now' }] },
    ]);
    const snapDir = path.join(dir, '.agentsgate-snapshots');
    const snapId = await writeSnapshotFile(snapDir, 'events', [{ id: '7', name: 'past' }], ['id', 'name']);

    const adapter = new DatabaseRollbackAdapter(dbPath);
    // Force captureCurrentState to throw
    (adapter as any).captureCurrentState = async () => { throw new Error('forced capture failure'); };

    const snap: StateSnapshot = {
      adapterId: 'agentsgate-database',
      operationId: 'op-rb5-capturefail',
      data: { snapshotId: snapId, snapshotTable: 'events', dbPath },
      capturedAt: new Date(),
    };

    const result = await adapter.rollbackWithUndo(snap);

    // Rollback should still succeed even though capture failed
    expect(result.success).toBe(true);
    // redoSnapshotId should be undefined (capture failed silently)
    expect(result.redoSnapshotId).toBeUndefined();

    // DB should reflect the rolled-back state
    const rows = readTableRows(dbPath, 'events');
    expect(rows[0]!['name']).toBe('past');
  });
});

// ---------------------------------------------------------------------------
// RB2/RB5 — Non-connection paths for PG and MySQL adapters
// ---------------------------------------------------------------------------

describe('RB2 — PostgreSQLRollbackAdapter.rollbackMultiple: missing snapshot file → early return', async () => {
  const { PostgreSQLRollbackAdapter } = await import('../../src/modules/m9-adapters/pg-rollback-adapter.js');

  it('returns failure with error message when snapshot file is missing', async () => {
    const dir = await makeTempDir();
    tempDirs.push(dir);
    const adapter = new PostgreSQLRollbackAdapter('postgresql://localhost/testdb', dir);

    const result = await adapter.rollbackMultiple([
      { snapshotId: 'nonexistent-id', snapshotTable: 'some_table' },
    ]);

    expect(result.success).toBe(false);
    expect(result.failedFiles).toContain('some_table');
    expect(result.error).toMatch(/not found/i);
  });

  it('empty array returns immediate success without connecting to PG', async () => {
    const dir = await makeTempDir();
    tempDirs.push(dir);
    const adapter = new PostgreSQLRollbackAdapter('postgresql://localhost/testdb', dir);
    const result = await adapter.rollbackMultiple([]);
    expect(result.success).toBe(true);
    expect(result.restoredFiles).toHaveLength(0);
  });
});

describe('RB2 — MySQLRollbackAdapter.rollbackMultiple: missing snapshot file → early return', async () => {
  const { MySQLRollbackAdapter } = await import('../../src/modules/m9-adapters/mysql-rollback-adapter.js');

  it('returns failure with error message when snapshot file is missing', async () => {
    const dir = await makeTempDir();
    tempDirs.push(dir);
    const adapter = new MySQLRollbackAdapter('mysql://localhost/testdb', dir);

    const result = await adapter.rollbackMultiple([
      { snapshotId: 'nonexistent-id', snapshotTable: 'some_table' },
    ]);

    expect(result.success).toBe(false);
    expect(result.failedFiles).toContain('some_table');
    expect(result.error).toMatch(/not found/i);
  });

  it('empty array returns immediate success without connecting to MySQL', async () => {
    const dir = await makeTempDir();
    tempDirs.push(dir);
    const adapter = new MySQLRollbackAdapter('mysql://localhost/testdb', dir);
    const result = await adapter.rollbackMultiple([]);
    expect(result.success).toBe(true);
    expect(result.restoredFiles).toHaveLength(0);
  });
});

describe('RB5 — PostgreSQLRollbackAdapter.rollbackWithUndo: no snapshotTable → redoSnapshotId undefined, no redo attempt', async () => {
  const { PostgreSQLRollbackAdapter } = await import('../../src/modules/m9-adapters/pg-rollback-adapter.js');

  it('returns undefined redoSnapshotId when snapshotTable is absent', async () => {
    const dir = await makeTempDir();
    tempDirs.push(dir);
    const adapter = new PostgreSQLRollbackAdapter('postgresql://localhost/testdb', dir);

    const snap: StateSnapshot = {
      adapterId: 'agentsgate-pg-database',
      operationId: 'op-pg-rb5',
      data: { snapshotId: 'some-id' },  // no snapshotTable
      capturedAt: new Date(),
    };

    const result = await adapter.rollbackWithUndo(snap);
    expect(result.redoSnapshotId).toBeUndefined();
    // No connection should have been attempted — just a failed rollback
    expect(result.success).toBe(false);
  });
});

describe('RB5 — MySQLRollbackAdapter.rollbackWithUndo: no snapshotTable → redoSnapshotId undefined', async () => {
  const { MySQLRollbackAdapter } = await import('../../src/modules/m9-adapters/mysql-rollback-adapter.js');

  it('returns undefined redoSnapshotId when snapshotTable is absent', async () => {
    const dir = await makeTempDir();
    tempDirs.push(dir);
    const adapter = new MySQLRollbackAdapter('mysql://localhost/testdb', dir);

    const snap: StateSnapshot = {
      adapterId: 'agentsgate-mysql-database',
      operationId: 'op-mysql-rb5',
      data: { snapshotId: 'some-id' },  // no snapshotTable
      capturedAt: new Date(),
    };

    const result = await adapter.rollbackWithUndo(snap);
    expect(result.redoSnapshotId).toBeUndefined();
    expect(result.success).toBe(false);
  });
});
