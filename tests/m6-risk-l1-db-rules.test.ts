/**
 * T446 + T447 — L1_DB_EXFIL and L1_DB_BATCH_DESTROY risk rule tests
 *
 * Tests for the two new L1 static rules added to m6-risk:
 * - L1_DB_EXFIL: SELECT targeting sensitive table names (score 0.6)
 * - L1_DB_BATCH_DESTROY: SQL containing semicolon (score 0.95)
 */

import { describe, it, expect } from 'vitest';
import { RiskScoringEngine } from '../src/modules/m6-risk/index.js';
import type { MCPOperation } from '../src/types/interfaces.js';

function makeOp(
  tool: string,
  method: string,
  params: Record<string, unknown> = {},
): MCPOperation {
  return {
    id: crypto.randomUUID(),
    agentId: 'test-agent',
    tool,
    method,
    params,
    timestamp: new Date(),
    sessionId: 'test-session',
  };
}

const engine = new RiskScoringEngine();

// ---------------------------------------------------------------------------
// L1_DB_EXFIL
// ---------------------------------------------------------------------------

describe('L1_DB_EXFIL rule', () => {
  it('fires for SELECT on users table', async () => {
    const op = makeOp('database', 'query', { sql: 'SELECT * FROM users' });
    const result = await engine.assess(op);
    expect(result.triggeredRules).toContain('L1_DB_EXFIL');
  });

  it('fires for SELECT on passwords table', async () => {
    const op = makeOp('database', 'query', { sql: 'SELECT * FROM passwords' });
    const result = await engine.assess(op);
    expect(result.triggeredRules).toContain('L1_DB_EXFIL');
  });

  it('fires for SELECT on tokens table', async () => {
    const op = makeOp('database', 'query', { sql: 'SELECT token FROM tokens WHERE user_id = 1' });
    const result = await engine.assess(op);
    expect(result.triggeredRules).toContain('L1_DB_EXFIL');
  });

  it('fires for SELECT on secrets table', async () => {
    const op = makeOp('database', 'query', { sql: 'SELECT * FROM secrets' });
    const result = await engine.assess(op);
    expect(result.triggeredRules).toContain('L1_DB_EXFIL');
  });

  it('fires for SELECT on credentials table', async () => {
    const op = makeOp('database', 'query', { sql: 'SELECT * FROM credentials' });
    const result = await engine.assess(op);
    expect(result.triggeredRules).toContain('L1_DB_EXFIL');
  });

  it('fires for SELECT on api_keys table', async () => {
    const op = makeOp('database', 'query', { sql: 'SELECT key FROM api_keys' });
    const result = await engine.assess(op);
    expect(result.triggeredRules).toContain('L1_DB_EXFIL');
  });

  it('does NOT fire for SELECT on orders table (non-sensitive)', async () => {
    const op = makeOp('database', 'query', { sql: 'SELECT * FROM orders' });
    const result = await engine.assess(op);
    expect(result.triggeredRules).not.toContain('L1_DB_EXFIL');
  });

  it('does NOT fire for execute method (only query method is targeted)', async () => {
    const op = makeOp('database', 'execute', { sql: 'SELECT * FROM users WHERE id = 1' });
    const result = await engine.assess(op);
    expect(result.triggeredRules).not.toContain('L1_DB_EXFIL');
  });

  it('does NOT fire for non-database tools', async () => {
    const op = makeOp('filesystem', 'query', { sql: 'SELECT * FROM users' });
    const result = await engine.assess(op);
    expect(result.triggeredRules).not.toContain('L1_DB_EXFIL');
  });

  it('has score 0.6 in firedRuleDetails', async () => {
    const op = makeOp('database', 'query', { sql: 'SELECT * FROM users' });
    const result = await engine.assess(op);
    const fired = result.firedRuleDetails.find(r => r.id === 'L1_DB_EXFIL');
    expect(fired).toBeDefined();
    expect(fired!.score).toBeCloseTo(0.6, 5);
  });

  it('fired rule has layer L1', async () => {
    const op = makeOp('database', 'query', { sql: 'SELECT id FROM tokens' });
    const result = await engine.assess(op);
    const fired = result.firedRuleDetails.find(r => r.id === 'L1_DB_EXFIL');
    expect(fired).toBeDefined();
    expect(fired!.layer).toBe('L1');
  });
});

// ---------------------------------------------------------------------------
// L1_DB_BATCH_DESTROY
// ---------------------------------------------------------------------------

describe('L1_DB_BATCH_DESTROY rule', () => {
  it('fires when SQL contains semicolon in execute method', async () => {
    const op = makeOp('database', 'execute', {
      sql: 'INSERT INTO orders VALUES (1); DROP TABLE orders',
    });
    const result = await engine.assess(op);
    expect(result.triggeredRules).toContain('L1_DB_BATCH_DESTROY');
  });

  it('fires when SQL contains semicolon in execute_ddl method', async () => {
    const op = makeOp('database', 'execute_ddl', {
      sql: 'CREATE TABLE foo (id INTEGER); DROP TABLE users',
    });
    const result = await engine.assess(op);
    expect(result.triggeredRules).toContain('L1_DB_BATCH_DESTROY');
  });

  it('fires when SQL contains semicolon in query method', async () => {
    const op = makeOp('database', 'query', {
      sql: 'SELECT 1; SELECT * FROM users',
    });
    const result = await engine.assess(op);
    expect(result.triggeredRules).toContain('L1_DB_BATCH_DESTROY');
  });

  it('does NOT fire for clean SQL without semicolon', async () => {
    const op = makeOp('database', 'execute', {
      sql: 'INSERT INTO orders (id, status) VALUES (1, "pending")',
    });
    const result = await engine.assess(op);
    expect(result.triggeredRules).not.toContain('L1_DB_BATCH_DESTROY');
  });

  it('does NOT fire for non-database tools', async () => {
    const op = makeOp('filesystem', 'execute', { sql: 'SELECT 1; DELETE FROM users' });
    const result = await engine.assess(op);
    expect(result.triggeredRules).not.toContain('L1_DB_BATCH_DESTROY');
  });

  it('has score 0.95', async () => {
    const op = makeOp('database', 'execute', { sql: 'UPDATE users SET role = "admin"; DROP TABLE users' });
    const result = await engine.assess(op);
    const fired = result.firedRuleDetails.find(r => r.id === 'L1_DB_BATCH_DESTROY');
    expect(fired).toBeDefined();
    expect(fired!.score).toBeCloseTo(0.95, 5);
  });

  it('firedRuleDetails has layer L1', async () => {
    const op = makeOp('database', 'execute', { sql: 'SELECT 1; DROP TABLE foo' });
    const result = await engine.assess(op);
    const fired = result.firedRuleDetails.find(r => r.id === 'L1_DB_BATCH_DESTROY');
    expect(fired).toBeDefined();
    expect(fired!.layer).toBe('L1');
  });

  it('staticScore is at least 0.95 when L1_DB_BATCH_DESTROY fires', async () => {
    const op = makeOp('database', 'execute', { sql: 'DELETE FROM users; DROP TABLE users' });
    const result = await engine.assess(op);
    expect(result.triggeredRules).toContain('L1_DB_BATCH_DESTROY');
    expect(result.staticScore).toBeGreaterThanOrEqual(0.95);
  });
});
