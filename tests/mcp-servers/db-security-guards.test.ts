/**
 * Security regression tests for the database MCP server guards.
 *
 * Covers the hardening added after the 2026-07 security review:
 *  - SQLite filesystem-escape blocklist (ATTACH / DETACH / VACUUM ... INTO)
 *  - MySQL server-side file access blocklist (INTO OUTFILE/DUMPFILE, LOAD_FILE)
 *  - URL-aware connection-string password redaction
 *  - Snapshot-reference validation used by the M9 rollback adapters
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import {
  assertNoSqliteFileEscape,
  assertNoMysqlFileEscape,
  redactConnectionString,
} from '../../src/mcp-servers/shared/db-server-utils.js';
import { isSafeSnapshotRef } from '../../src/modules/m9-adapters/rollback-adapter-utils.js';

describe('SQLite filesystem-escape guard', () => {
  it('rejects ATTACH DATABASE (sandbox escape)', () => {
    expect(() => assertNoSqliteFileEscape("ATTACH DATABASE '/etc/passwd' AS x")).toThrow();
    expect(() => assertNoSqliteFileEscape("attach database '/tmp/other.db' as y")).toThrow();
  });

  it('rejects DETACH and VACUUM ... INTO', () => {
    expect(() => assertNoSqliteFileEscape('DETACH DATABASE x')).toThrow();
    expect(() => assertNoSqliteFileEscape("VACUUM INTO '/tmp/leak.db'")).toThrow();
    expect(() => assertNoSqliteFileEscape("VACUUM main INTO '/tmp/leak.db'")).toThrow();
  });

  it('allows ordinary read/write statements', () => {
    expect(() => assertNoSqliteFileEscape('SELECT * FROM users')).not.toThrow();
    expect(() => assertNoSqliteFileEscape('INSERT INTO users (id) VALUES (1)')).not.toThrow();
    expect(() => assertNoSqliteFileEscape('UPDATE accounts SET balance = 0')).not.toThrow();
    // "INTO" alone (INSERT ... INTO) must not be mistaken for VACUUM ... INTO
    expect(() => assertNoSqliteFileEscape('INSERT INTO t SELECT * FROM s')).not.toThrow();
  });

  it('actually prevents cross-database reads end-to-end', () => {
    // A real better-sqlite3 connection would happily ATTACH another file;
    // the guard is what stops it before .prepare()/.run() ever sees the SQL.
    const db = new Database(':memory:');
    try {
      const attack = "ATTACH DATABASE '/tmp/should-never-open.db' AS victim";
      expect(() => assertNoSqliteFileEscape(attack)).toThrow();
    } finally {
      db.close();
    }
  });
});

describe('MySQL file-access guard', () => {
  it('rejects SELECT ... INTO OUTFILE / DUMPFILE', () => {
    expect(() => assertNoMysqlFileEscape("SELECT * FROM users INTO OUTFILE '/tmp/x'")).toThrow();
    expect(() => assertNoMysqlFileEscape("SELECT a INTO DUMPFILE '/tmp/x'")).toThrow();
  });

  it('rejects LOAD_FILE()', () => {
    expect(() => assertNoMysqlFileEscape("SELECT LOAD_FILE('/etc/passwd')")).toThrow();
  });

  it('allows ordinary SELECT statements', () => {
    expect(() => assertNoMysqlFileEscape('SELECT * FROM users')).not.toThrow();
    expect(() => assertNoMysqlFileEscape('WITH cte AS (SELECT 1) SELECT * FROM cte')).not.toThrow();
  });
});

describe('redactConnectionString', () => {
  it('fully masks a simple password', () => {
    const out = redactConnectionString('postgresql://user:hunter2@db.example.com:5432/prod');
    expect(out).not.toContain('hunter2');
    expect(out).toContain('db.example.com');
    expect(out).toContain('user');
  });

  it('fully masks a password containing ":" (no partial leak)', () => {
    const out = redactConnectionString('postgresql://user:s3cr:et@host/db');
    // The naive /:([^:@]+)@/ regex would leave "s3cr" visible — must not happen.
    expect(out).not.toContain('s3cr');
    expect(out).not.toContain('et@');
  });

  it('leaves credential-less strings untouched', () => {
    const out = redactConnectionString('postgresql://db.example.com:5432/prod');
    expect(out).toContain('db.example.com');
  });
});

describe('isSafeSnapshotRef (M9 adapter path-traversal guard)', () => {
  const uuid = '123e4567-e89b-12d3-a456-426614174000';

  it('accepts a valid uuid + table name', () => {
    expect(isSafeSnapshotRef(uuid, 'users')).toBe(true);
  });

  it('rejects path-traversal table names', () => {
    expect(isSafeSnapshotRef(uuid, '../../etc/passwd')).toBe(false);
    expect(isSafeSnapshotRef(uuid, '..')).toBe(false);
    expect(isSafeSnapshotRef(uuid, 'a/b')).toBe(false);
  });

  it('rejects malformed snapshot ids', () => {
    expect(isSafeSnapshotRef('../evil', 'users')).toBe(false);
    expect(isSafeSnapshotRef('not-a-uuid', 'users')).toBe(false);
  });
});
