/**
 * T453 + T454 — MCP server snapshot tool logic tests
 *
 * Tests the delete_snapshot and maxSnapshotBytes logic inline (same pattern
 * as tests/mcp-servers/database.test.ts — helper functions are mirrored
 * from the implementation to test behavior without spawning the server process).
 *
 * Covers:
 * - delete_snapshot UUID validation (invalid format rejected)
 * - delete_snapshot removes file when it exists
 * - delete_snapshot returns not-found when file doesn't exist
 * - maxSnapshotBytes: snapshot larger than limit causes error
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Helpers inlined from implementation (same logic as MCP server)
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

/**
 * Mirrors the saveSnapshot() function in the MCP server.
 * Throws if the payload exceeds maxBytes.
 */
async function saveSnapshot(
  db: Database.Database,
  dbDir: string,
  tableName: string,
  maxBytes: number,
): Promise<string> {
  validateTableName(tableName);

  const rows = db.prepare(`SELECT * FROM ${quoteIdentifier(tableName)}`).all() as Record<string, unknown>[];
  const columns = rows.length > 0
    ? Object.keys(rows[0]!)
    : (db.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all() as Array<{ name: string }>).map(c => c.name);
  const payload = JSON.stringify({ tableName, capturedAt: new Date().toISOString(), rows, columns });
  const estimatedBytes = Buffer.byteLength(payload, 'utf8');

  if (estimatedBytes > maxBytes) {
    throw new Error(
      `Snapshot too large: ${estimatedBytes} bytes exceeds limit of ${maxBytes} bytes. ` +
      `Use --max-snapshot-bytes to increase the limit or remove snapshot_table parameter.`,
    );
  }

  const snapshotDir = path.join(dbDir, '.agentsgate-snapshots');
  await fs.mkdir(snapshotDir, { recursive: true });
  const snapshotId = randomUUID();
  const fileName = `${snapshotId}_${tableName}.json`;
  await fs.writeFile(path.join(snapshotDir, fileName), payload, 'utf8');
  return snapshotId;
}

/**
 * Mirrors the delete_snapshot tool handler in the MCP server.
 * Returns { deleted, snapshot_id, table } on success,
 * { deleted: false, reason: 'not found' } on ENOENT,
 * or throws for invalid snapshot_id format.
 */
async function deleteSnapshot(
  dbDir: string,
  snapshot_id: string,
  table: string,
): Promise<{ deleted: boolean; snapshot_id?: string; table?: string; reason?: string }> {
  validateTableName(table);
  const snapshotDir = path.join(dbDir, '.agentsgate-snapshots');
  const file = path.join(snapshotDir, `${snapshot_id}_${table}.json`);

  // UUID format guard (matches MCP server implementation)
  if (!/^[0-9a-f-]{36}$/.test(snapshot_id)) {
    throw new Error('Invalid snapshot_id format');
  }

  try {
    await fs.unlink(file);
    return { deleted: true, snapshot_id, table };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      return { deleted: false, reason: 'not found' };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let db: Database.Database;
let dbPath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ag-snap-tools-'));
  dbPath = path.join(tmpDir, 'test.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
});

afterEach(async () => {
  db.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// delete_snapshot: UUID validation
// ---------------------------------------------------------------------------

describe('delete_snapshot — UUID validation', () => {
  it('rejects an empty snapshot_id string', async () => {
    db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY)');
    await expect(deleteSnapshot(tmpDir, '', 'items')).rejects.toThrow('Invalid snapshot_id format');
  });

  it('rejects a snapshot_id with non-hex characters', async () => {
    db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY)');
    const badId = 'ZZZZZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZZZZZZZZZ';
    await expect(deleteSnapshot(tmpDir, badId, 'items')).rejects.toThrow('Invalid snapshot_id format');
  });

  it('rejects a snapshot_id that is too short', async () => {
    db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY)');
    await expect(deleteSnapshot(tmpDir, 'abc123', 'items')).rejects.toThrow('Invalid snapshot_id format');
  });

  it('accepts a valid UUID format snapshot_id', async () => {
    db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY)');
    // Create the snapshot file first
    const snapshotId = randomUUID();
    const snapshotDir = path.join(tmpDir, '.agentsgate-snapshots');
    await fs.mkdir(snapshotDir, { recursive: true });
    await fs.writeFile(path.join(snapshotDir, `${snapshotId}_items.json`), '{}', 'utf8');

    const result = await deleteSnapshot(tmpDir, snapshotId, 'items');
    expect(result.deleted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// delete_snapshot: file removal
// ---------------------------------------------------------------------------

describe('delete_snapshot — file removal', () => {
  it('removes snapshot file when it exists', async () => {
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
    db.exec("INSERT INTO users VALUES (1, 'Alice')");

    const snapshotId = await saveSnapshot(db, tmpDir, 'users', 100 * 1024 * 1024);
    const snapshotDir = path.join(tmpDir, '.agentsgate-snapshots');
    const filePath = path.join(snapshotDir, `${snapshotId}_users.json`);

    // File should exist before deletion
    await expect(fs.access(filePath)).resolves.toBeUndefined();

    const result = await deleteSnapshot(tmpDir, snapshotId, 'users');
    expect(result.deleted).toBe(true);
    expect(result.snapshot_id).toBe(snapshotId);
    expect(result.table).toBe('users');

    // File should no longer exist
    await expect(fs.access(filePath)).rejects.toThrow();
  });

  it('returns not-found when snapshot file does not exist', async () => {
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY)');
    const nonExistentId = randomUUID();

    const result = await deleteSnapshot(tmpDir, nonExistentId, 'users');
    expect(result.deleted).toBe(false);
    expect(result.reason).toBe('not found');
  });

  it('does not affect other snapshot files when deleting one', async () => {
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
    db.exec("INSERT INTO users VALUES (1, 'Alice'), (2, 'Bob')");

    const snap1 = await saveSnapshot(db, tmpDir, 'users', 100 * 1024 * 1024);

    db.exec("UPDATE users SET name = 'Charlie' WHERE id = 1");
    const snap2 = await saveSnapshot(db, tmpDir, 'users', 100 * 1024 * 1024);

    const snapshotDir = path.join(tmpDir, '.agentsgate-snapshots');

    // Delete only snap1
    await deleteSnapshot(tmpDir, snap1, 'users');

    // snap2 should still exist
    const snap2Path = path.join(snapshotDir, `${snap2}_users.json`);
    await expect(fs.access(snap2Path)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// maxSnapshotBytes: size cap
// ---------------------------------------------------------------------------

describe('maxSnapshotBytes cap', () => {
  it('throws when snapshot exceeds maxSnapshotBytes limit', async () => {
    db.exec('CREATE TABLE bigtable (id INTEGER PRIMARY KEY, data TEXT)');
    // Insert enough rows to exceed a tiny limit
    for (let i = 0; i < 10; i++) {
      db.exec(`INSERT INTO bigtable VALUES (${i}, 'some data row ${i} padded to be larger')`);
    }

    // Set a very small limit (1 byte) to force the error
    await expect(saveSnapshot(db, tmpDir, 'bigtable', 1)).rejects.toThrow(/exceeds limit/i);
  });

  it('succeeds when snapshot is within maxSnapshotBytes limit', async () => {
    db.exec('CREATE TABLE small (id INTEGER PRIMARY KEY)');
    db.exec('INSERT INTO small VALUES (1)');

    // 100 MB limit — should succeed easily
    const snapshotId = await saveSnapshot(db, tmpDir, 'small', 100 * 1024 * 1024);
    expect(typeof snapshotId).toBe('string');
    expect(snapshotId).toHaveLength(36); // UUID length
  });

  it('error message includes byte count and limit', async () => {
    db.exec('CREATE TABLE data (id INTEGER PRIMARY KEY, val TEXT)');
    db.exec("INSERT INTO data VALUES (1, 'hello')");

    let errorMessage = '';
    try {
      await saveSnapshot(db, tmpDir, 'data', 1);
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
    }

    expect(errorMessage).toMatch(/bytes/i);
    expect(errorMessage).toMatch(/limit/i);
  });

  it('snapshot file is NOT created when limit is exceeded', async () => {
    db.exec('CREATE TABLE check_tbl (id INTEGER PRIMARY KEY, val TEXT)');
    db.exec("INSERT INTO check_tbl VALUES (1, 'hello world test data')");

    const snapshotDir = path.join(tmpDir, '.agentsgate-snapshots');

    try {
      await saveSnapshot(db, tmpDir, 'check_tbl', 1);
    } catch {
      // expected to throw
    }

    // The snapshot directory may or may not exist, but no .json file should be there
    try {
      const files = await fs.readdir(snapshotDir);
      const jsonFiles = files.filter(f => f.endsWith('.json'));
      expect(jsonFiles).toHaveLength(0);
    } catch (err) {
      // snapshotDir doesn't exist at all — that is also acceptable
      const e = err as NodeJS.ErrnoException;
      expect(e.code).toBe('ENOENT');
    }
  });
});
