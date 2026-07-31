/**
 * `L1_EXECUTE_COMMAND` is about shells, not about the word "execute".
 *
 * It matched on the method name alone, whatever tool the call was for. The
 * database MCP servers name their write method `execute`, so a one-row
 * `UPDATE ... WHERE id = 1` was scored as arbitrary code execution: 0.80,
 * blocked under the default thresholds. `L1_DB_EXECUTE` scores that same
 * operation 0.30, and scoring takes the maximum, so the database rule could
 * never have any effect at all.
 */
import { describe, it, expect } from 'vitest';
import { RiskScoringEngine } from '../src/modules/m6-risk/index.js';
import type { MCPOperation } from '../src/types/interfaces.js';

const engine = new RiskScoringEngine();

async function assess(tool: string, method: string, params: Record<string, unknown> = {}) {
  return engine.assess({
    id: 'op', agentId: 'a', tool, method, params,
    timestamp: new Date(), sessionId: 's',
  } as MCPOperation);
}

describe('a database execute', () => {
  it('is not treated as a shell command', async () => {
    for (const tool of ['database', 'agentsgate-pg-database', 'agentsgate-mysql-database', 'pg-database']) {
      const r = await assess(tool, 'execute', { sql: 'UPDATE orders SET status = 1 WHERE id = 1' });
      expect(r.triggeredRules, tool).not.toContain('L1_EXECUTE_COMMAND');
    }
  });

  it('scores as the database rule says it should', async () => {
    const r = await assess('database', 'execute', { sql: 'UPDATE orders SET status = 1 WHERE id = 1' });
    expect(r.triggeredRules).toContain('L1_DB_EXECUTE');
    expect(r.finalScore).toBe(0.3);
  });

  it('still blocks the destructive shapes on their own merits', async () => {
    const noWhere = await assess('database', 'execute', { sql: 'DELETE FROM orders' });
    expect(noWhere.finalScore).toBe(0.9);
    const drop = await assess('database', 'execute_ddl', { sql: 'DROP TABLE orders' });
    expect(drop.finalScore).toBe(1);
  });
});

describe('an actual shell command', () => {
  it('still scores as arbitrary code execution', async () => {
    for (const [tool, method] of [
      ['shell', 'execute'], ['bash', 'run_command'], ['terminal', 'exec'],
      ['cmd', 'spawn'], ['mcp', 'shell'],
    ]) {
      const r = await assess(tool!, method!, { command: 'rm -rf /' });
      expect(r.triggeredRules, `${tool}.${method}`).toContain('L1_EXECUTE_COMMAND');
      expect(r.finalScore).toBeGreaterThanOrEqual(0.8);
    }
  });

  it('is recognised on a tool whose name only hints at it', async () => {
    const r = await assess('my-shell-server', 'execute', { command: 'ls' });
    expect(r.triggeredRules).toContain('L1_EXECUTE_COMMAND');
  });
});

describe('everyday work', () => {
  it('no longer blocks reading and single-row edits', async () => {
    const read = await assess('filesystem', 'read_file', { path: '/app/x.ts' });
    expect(read.finalScore).toBeLessThan(0.3);

    const update = await assess('database', 'execute', { sql: 'UPDATE orders SET status = 1 WHERE id = 1' });
    expect(update.finalScore).toBeLessThan(0.7);
  });
});
