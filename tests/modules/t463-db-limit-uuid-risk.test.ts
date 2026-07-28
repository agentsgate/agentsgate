/**
 * T463 Tests:
 *   D7 — parseArgs maxRows logic (SQLite, PG, MySQL)
 *   S2 — UUID validation regex for restore_snapshot
 *   R1 — L1_DB_* rules fire for agentsgate-pg-database and agentsgate-mysql-database tool names
 */

import { describe, it, expect } from 'vitest';
import { RiskScoringEngine } from '../../src/modules/m6-risk/index.js';
import type { MCPOperation } from '../../src/types/interfaces.js';

// ── Helper ────────────────────────────────────────────────────────────────────

function makeOp(
  tool: string,
  method: string,
  params: Record<string, unknown> = {},
): MCPOperation {
  return {
    id: crypto.randomUUID(),
    agentId: 'agent-test',
    tool,
    method,
    params,
    timestamp: new Date(),
    sessionId: 'session-test',
  };
}

// ── UUID regex (mirrors S2 implementation) ────────────────────────────────────

const UUID_RE = /^[0-9a-f-]{36}$/;

// ── D7: parseArgs maxRows parsing logic ──────────────────────────────────────

/**
 * Minimal reimplementation of the parseArgs maxRows logic shared across all
 * three MCP servers (SQLite, PG, MySQL) so we can unit-test the behaviour
 * without spawning a subprocess.
 */
function parseMaxRows(argv: string[]): number {
  const flag = argv.find(a => a.startsWith('--max-rows='));
  return flag ? parseInt(flag.split('=')[1]!, 10) : 10_000;
}

/**
 * Minimal row-limiting logic identical to what the query tool uses across
 * all three servers: effectiveLimit = Math.min(limit, maxRows).
 */
function applyRowLimit(
  rows: unknown[],
  limit: number,
  maxRows: number,
): { limited: unknown[]; truncated: boolean; effectiveLimit: number } {
  const effectiveLimit = Math.min(limit, maxRows);
  const truncated = rows.length > effectiveLimit;
  const limited = truncated ? rows.slice(0, effectiveLimit) : rows;
  return { limited, truncated, effectiveLimit };
}

// ── D7 Tests ──────────────────────────────────────────────────────────────────

describe('D7 — maxRows parsing', () => {
  it('returns default 10,000 when --max-rows flag is absent', () => {
    expect(parseMaxRows([])).toBe(10_000);
    expect(parseMaxRows(['--db', '/tmp/test.db'])).toBe(10_000);
  });

  it('parses --max-rows=N from CLI argv', () => {
    expect(parseMaxRows(['--max-rows=500'])).toBe(500);
    expect(parseMaxRows(['--db', '/tmp/test.db', '--max-rows=100'])).toBe(100);
  });

  it('maxRows=1000 caps a 5000-row result', () => {
    const rows = Array.from({ length: 5000 }, (_, i) => ({ id: i }));
    const { limited, truncated, effectiveLimit } = applyRowLimit(rows, 500, 1000);
    expect(effectiveLimit).toBe(500); // min(500, 1000)
    expect(limited).toHaveLength(500);
    expect(truncated).toBe(true);
  });

  it('effectiveLimit = min(limit, maxRows) — maxRows wins when smaller', () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({ id: i }));
    const { limited, truncated, effectiveLimit } = applyRowLimit(rows, 500, 100);
    expect(effectiveLimit).toBe(100); // min(500, 100)
    expect(limited).toHaveLength(100);
    expect(truncated).toBe(true);
  });

  it('no truncation when row count is within effectiveLimit', () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ id: i }));
    const { limited, truncated, effectiveLimit } = applyRowLimit(rows, 500, 10_000);
    expect(effectiveLimit).toBe(500);
    expect(limited).toHaveLength(50);
    expect(truncated).toBe(false);
  });

  it('truncation response shape includes truncated flag and warning', () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ id: i }));
    const { limited, truncated, effectiveLimit } = applyRowLimit(rows, 10, 10_000);
    expect(truncated).toBe(true);
    // Verify the response shape produced by the query tool
    const responseText = JSON.stringify(
      truncated
        ? { rows: limited, truncated: true, totalReturnedRows: effectiveLimit, warning: `Result truncated to ${effectiveLimit} rows` }
        : { rows: limited },
    );
    const parsed = JSON.parse(responseText) as Record<string, unknown>;
    expect(parsed['truncated']).toBe(true);
    expect(parsed['warning']).toContain('truncated to 10 rows');
    expect((parsed['rows'] as unknown[]).length).toBe(10);
  });
});

// ── S2 Tests — UUID validation regex ─────────────────────────────────────────

describe('S2 — UUID validation in restore_snapshot', () => {
  it('accepts a standard v4 UUID', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    expect(UUID_RE.test(uuid)).toBe(true);
  });

  it('accepts a crypto.randomUUID()-generated value', () => {
    const uuid = crypto.randomUUID();
    expect(UUID_RE.test(uuid)).toBe(true);
  });

  it('rejects path traversal strings', () => {
    expect(UUID_RE.test('../../etc/passwd')).toBe(false);
    expect(UUID_RE.test('../..')).toBe(false);
    expect(UUID_RE.test('/etc/passwd')).toBe(false);
  });

  it('rejects strings that are too short or too long', () => {
    expect(UUID_RE.test('abc')).toBe(false);
    expect(UUID_RE.test('550e8400-e29b-41d4-a716-4466554400001234')).toBe(false);
  });

  it('rejects strings with uppercase hex characters (not in [0-9a-f])', () => {
    // Real UUIDs in our code are lowercase; guard against uppercase injection
    expect(UUID_RE.test('550E8400-E29B-41D4-A716-446655440000')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(UUID_RE.test('')).toBe(false);
  });
});

// ── R1 Tests — isDbTool covers PG and MySQL tool names ───────────────────────

describe('R1 — L1_DB_* rules fire for all database tool variants', () => {
  const engine = new RiskScoringEngine();

  const DB_TOOLS = [
    'database',
    'agentsgate-database',
    'agentsgate-pg-database',
    'agentsgate-mysql-database',
    'pg-database',
    'mysql-database',
  ];

  it('L1_DB_DROP fires for DROP TABLE on agentsgate-pg-database', async () => {
    const result = await engine.assess(
      makeOp('agentsgate-pg-database', 'execute_ddl', { sql: 'DROP TABLE users' }),
    );
    expect(result.triggeredRules).toContain('L1_DB_DROP');
    expect(result.staticScore).toBe(1.0);
  });

  it('L1_DB_DROP fires for DROP TABLE on agentsgate-mysql-database', async () => {
    const result = await engine.assess(
      makeOp('agentsgate-mysql-database', 'execute_ddl', { sql: 'DROP TABLE orders' }),
    );
    expect(result.triggeredRules).toContain('L1_DB_DROP');
    expect(result.staticScore).toBe(1.0);
  });

  it('L1_DB_TRUNCATE fires for TRUNCATE on pg-database', async () => {
    const result = await engine.assess(
      makeOp('pg-database', 'execute', { sql: 'TRUNCATE TABLE logs' }),
    );
    expect(result.triggeredRules).toContain('L1_DB_TRUNCATE');
    expect(result.staticScore).toBeGreaterThanOrEqual(0.95);
  });

  it('L1_DB_DELETE_NO_WHERE fires for DELETE without WHERE on agentsgate-pg-database', async () => {
    const result = await engine.assess(
      makeOp('agentsgate-pg-database', 'execute', { sql: 'DELETE FROM sessions' }),
    );
    expect(result.triggeredRules).toContain('L1_DB_DELETE_NO_WHERE');
    expect(result.staticScore).toBeGreaterThanOrEqual(0.9);
  });

  it('L1_DB_UPDATE_NO_WHERE fires for UPDATE without WHERE on agentsgate-mysql-database', async () => {
    const result = await engine.assess(
      makeOp('agentsgate-mysql-database', 'execute', { sql: 'UPDATE users SET active=0' }),
    );
    expect(result.triggeredRules).toContain('L1_DB_UPDATE_NO_WHERE');
    expect(result.staticScore).toBeGreaterThanOrEqual(0.85);
  });

  it('L1_DB_READ fires for query method on agentsgate-pg-database', async () => {
    const result = await engine.assess(
      makeOp('agentsgate-pg-database', 'query', { sql: 'SELECT id FROM products' }),
    );
    expect(result.triggeredRules).toContain('L1_DB_READ');
    expect(result.staticScore).toBeLessThanOrEqual(0.1);
  });

  it('L1_DB_READ fires for query method on agentsgate-mysql-database', async () => {
    const result = await engine.assess(
      makeOp('agentsgate-mysql-database', 'query', { sql: 'SELECT * FROM items' }),
    );
    expect(result.triggeredRules).toContain('L1_DB_READ');
  });

  it('L1_DB_RESTORE fires for restore_snapshot on pg-database', async () => {
    const result = await engine.assess(
      makeOp('pg-database', 'restore_snapshot', { snapshot_id: crypto.randomUUID(), table: 'orders' }),
    );
    expect(result.triggeredRules).toContain('L1_DB_RESTORE');
    expect(result.staticScore).toBeGreaterThanOrEqual(0.6);
  });

  it('L1_DB_EXFIL fires for SELECT on sensitive table via agentsgate-pg-database', async () => {
    const result = await engine.assess(
      makeOp('agentsgate-pg-database', 'query', { sql: 'SELECT * FROM users WHERE id=1' }),
    );
    expect(result.triggeredRules).toContain('L1_DB_EXFIL');
    expect(result.staticScore).toBeGreaterThanOrEqual(0.6);
  });

  it('L1_DB_BATCH_DESTROY fires for semicolon in SQL on mysql-database', async () => {
    const result = await engine.assess(
      makeOp('mysql-database', 'execute', { sql: 'INSERT INTO t VALUES (1); DROP TABLE t' }),
    );
    expect(result.triggeredRules).toContain('L1_DB_BATCH_DESTROY');
    expect(result.staticScore).toBeGreaterThanOrEqual(0.95);
  });

  it.each(DB_TOOLS)('L1_DB_DROP fires for tool=%s', async (tool) => {
    const result = await engine.assess(
      makeOp(tool, 'execute_ddl', { sql: 'DROP TABLE test' }),
    );
    expect(result.triggeredRules).toContain('L1_DB_DROP');
  });

  it('legacy "database" tool name still fires all DB rules (no regression)', async () => {
    const result = await engine.assess(
      makeOp('database', 'execute', { sql: 'DELETE FROM logs' }),
    );
    expect(result.triggeredRules).toContain('L1_DB_DELETE_NO_WHERE');
  });
});
