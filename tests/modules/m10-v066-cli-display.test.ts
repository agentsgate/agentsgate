/**
 * v0.66 tests — Dashboard API fields used by CLI display commands
 *
 * T444 — GET /agents/:agentId includes medianRiskScore, blockStreak, allowStreak,
 *         pendingCount, topSessions
 * T445 — GET /tools/:tool includes allowRate, pendingCount, blockStreak, topSessions
 * T446 — GET /sessions/:id includes firstSeen, lastSeen, sessionDuration, recentBlockedOps
 * T447 — GET /operations/summary has uniqueAgents / uniqueTools
 * T448 — GET /sessions has totalBlocked / avgBlockRate
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { StateStore } from '../../src/modules/m2-store/index.js';
import { DashboardAPI } from '../../src/modules/m10-dashboard/index.js';
import { OperationLogger } from '../../src/modules/m3-logger/index.js';
import type { MCPOperation, ProxyDecision } from '../../src/types/interfaces.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeOp(
  agentId: string,
  tool: string,
  overrides: Partial<MCPOperation> = {}
): MCPOperation {
  return {
    id: crypto.randomUUID(),
    agentId,
    tool,
    method: 'call',
    params: {},
    timestamp: new Date(),
    sessionId: 'sess-default',
    ...overrides,
  };
}

function dec(
  action: ProxyDecision['action'] = 'allow',
  riskScore = 0.1
): ProxyDecision {
  return { action, riskScore, reasons: [] };
}

interface Ctx {
  store: StateStore;
  logger: OperationLogger;
  dash: DashboardAPI;
  port: number;
}

async function setup(): Promise<Ctx> {
  const store = new StateStore(':memory:');
  await store.initialize();
  const logger = new OperationLogger(store);
  const dash = new DashboardAPI(store, {});
  await dash.start(0);
  const port = ((dash as unknown as { server: http.Server }).server.address() as { port: number }).port;
  return { store, logger, dash, port };
}

async function teardown(ctx: Ctx): Promise<void> {
  await ctx.dash.stop();
  await ctx.store.close();
}

async function getJSON(port: number, path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, body: await res.json() };
}

// ── T444 — GET /agents/:agentId extended fields ───────────────────────────────

describe('GET /agents/:agentId — v0.66 fields (T444)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * Seeds agent-K with 5 allow ops, riskScores [0.1, 0.3, 0.5, 0.7, 0.9],
   * spread across 2 sessions so topSessions is populated.
   */
  async function seedAgentK(ctx: Ctx): Promise<void> {
    const scores = [0.1, 0.3, 0.5, 0.7, 0.9];
    for (let i = 0; i < scores.length; i++) {
      const sessId = i < 3 ? 'sess-k1' : 'sess-k2';
      await ctx.logger.log(
        makeOp('agent-K', 'tool-x', { id: crypto.randomUUID(), sessionId: sessId }),
        dec('allow', scores[i]!)
      );
    }
  }

  it('1. GET /agents/agent-K returns 200', async () => {
    ctx = await setup();
    await seedAgentK(ctx);

    const { status } = await getJSON(ctx.port, '/agents/agent-K');
    expect(status).toBe(200);
  });

  it('2. response includes medianRiskScore field', async () => {
    ctx = await setup();
    await seedAgentK(ctx);

    const { body } = await getJSON(ctx.port, '/agents/agent-K');
    const b = body as Record<string, unknown>;
    expect(b['medianRiskScore']).toBeDefined();
  });

  it('3. medianRiskScore is 0.5 for scores [0.1, 0.3, 0.5, 0.7, 0.9]', async () => {
    ctx = await setup();
    await seedAgentK(ctx);

    const { body } = await getJSON(ctx.port, '/agents/agent-K');
    const b = body as { medianRiskScore: number };
    expect(b.medianRiskScore).toBeCloseTo(0.5, 5);
  });

  it('4. response includes blockStreak field', async () => {
    ctx = await setup();
    await seedAgentK(ctx);

    const { body } = await getJSON(ctx.port, '/agents/agent-K');
    const b = body as Record<string, unknown>;
    expect(b['blockStreak']).toBeDefined();
  });

  it('5. blockStreak is 0 (all ops are allow, no recent blocks)', async () => {
    ctx = await setup();
    await seedAgentK(ctx);

    const { body } = await getJSON(ctx.port, '/agents/agent-K');
    const b = body as { blockStreak: number };
    expect(b.blockStreak).toBe(0);
  });

  it('6. response includes allowStreak field', async () => {
    ctx = await setup();
    await seedAgentK(ctx);

    const { body } = await getJSON(ctx.port, '/agents/agent-K');
    const b = body as Record<string, unknown>;
    expect(b['allowStreak']).toBeDefined();
  });

  it('7. allowStreak is 5 (all 5 ops are allow)', async () => {
    ctx = await setup();
    await seedAgentK(ctx);

    const { body } = await getJSON(ctx.port, '/agents/agent-K');
    const b = body as { allowStreak: number };
    expect(b.allowStreak).toBe(5);
  });

  it('8. response includes pendingCount field', async () => {
    ctx = await setup();
    await seedAgentK(ctx);

    const { body } = await getJSON(ctx.port, '/agents/agent-K');
    const b = body as Record<string, unknown>;
    expect(b['pendingCount']).toBeDefined();
  });

  it('9. pendingCount is 0 (no require_approval ops)', async () => {
    ctx = await setup();
    await seedAgentK(ctx);

    const { body } = await getJSON(ctx.port, '/agents/agent-K');
    const b = body as { pendingCount: number };
    expect(b.pendingCount).toBe(0);
  });

  it('10. response includes topSessions field', async () => {
    ctx = await setup();
    await seedAgentK(ctx);

    const { body } = await getJSON(ctx.port, '/agents/agent-K');
    const b = body as Record<string, unknown>;
    expect(b['topSessions']).toBeDefined();
    expect(Array.isArray(b['topSessions'])).toBe(true);
  });

  it('11. topSessions contains entries with sessionId and count', async () => {
    ctx = await setup();
    await seedAgentK(ctx);

    const { body } = await getJSON(ctx.port, '/agents/agent-K');
    const b = body as { topSessions: Array<Record<string, unknown>> };
    expect(b.topSessions.length).toBeGreaterThan(0);
    for (const entry of b.topSessions) {
      expect(entry['sessionId']).toBeDefined();
      expect(typeof entry['count']).toBe('number');
    }
  });

  it('12. topSessions has at most 2 entries for 2 seeded sessions', async () => {
    ctx = await setup();
    await seedAgentK(ctx);

    const { body } = await getJSON(ctx.port, '/agents/agent-K');
    const b = body as { topSessions: unknown[] };
    expect(b.topSessions.length).toBeLessThanOrEqual(5);
    expect(b.topSessions.length).toBe(2);
  });

  it('13. blockStreak is non-zero when the most recent ops are all blocks', async () => {
    ctx = await setup();
    // Seed 2 allows then 3 blocks — because API sorts DESC, blocks appear first
    await ctx.logger.log(makeOp('agent-streak', 'tool-a', { id: crypto.randomUUID(), sessionId: 'sess-s1' }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-streak', 'tool-b', { id: crypto.randomUUID(), sessionId: 'sess-s1' }), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-streak', 'tool-c', { id: crypto.randomUUID(), sessionId: 'sess-s1' }), dec('block', 0.8));
    await ctx.logger.log(makeOp('agent-streak', 'tool-d', { id: crypto.randomUUID(), sessionId: 'sess-s1' }), dec('block', 0.9));
    await ctx.logger.log(makeOp('agent-streak', 'tool-e', { id: crypto.randomUUID(), sessionId: 'sess-s1' }), dec('block', 0.95));

    const { body } = await getJSON(ctx.port, '/agents/agent-streak');
    const b = body as { blockStreak: number; allowStreak: number };
    expect(b.blockStreak).toBe(3);
    expect(b.allowStreak).toBe(0);
  });
});

// ── T445 — GET /tools/:tool extended fields ───────────────────────────────────

describe('GET /tools/:tool — v0.66 fields (T445)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * Seeds git_commit tool with 3 allow + 1 require_approval ops across 2 sessions.
   */
  async function seedGitCommitTool(ctx: Ctx): Promise<void> {
    await ctx.logger.log(makeOp('agent-a', 'git_commit', { id: crypto.randomUUID(), sessionId: 'sess-gc1' }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-b', 'git_commit', { id: crypto.randomUUID(), sessionId: 'sess-gc1' }), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-c', 'git_commit', { id: crypto.randomUUID(), sessionId: 'sess-gc2' }), dec('allow', 0.3));
    await ctx.logger.log(makeOp('agent-d', 'git_commit', { id: crypto.randomUUID(), sessionId: 'sess-gc2' }), dec('require_approval', 0.6));
  }

  it('14. GET /tools/git_commit returns 200', async () => {
    ctx = await setup();
    await seedGitCommitTool(ctx);

    const { status } = await getJSON(ctx.port, '/tools/git_commit');
    expect(status).toBe(200);
  });

  it('15. response includes allowRate field', async () => {
    ctx = await setup();
    await seedGitCommitTool(ctx);

    const { body } = await getJSON(ctx.port, '/tools/git_commit');
    const b = body as Record<string, unknown>;
    expect(b['allowRate']).toBeDefined();
  });

  it('16. allowRate is approximately 0.75 (3 allow out of 4 total)', async () => {
    ctx = await setup();
    await seedGitCommitTool(ctx);

    const { body } = await getJSON(ctx.port, '/tools/git_commit');
    const b = body as { allowRate: number };
    expect(b.allowRate).toBeCloseTo(0.75, 5);
  });

  it('17. response includes pendingCount field', async () => {
    ctx = await setup();
    await seedGitCommitTool(ctx);

    const { body } = await getJSON(ctx.port, '/tools/git_commit');
    const b = body as Record<string, unknown>;
    expect(b['pendingCount']).toBeDefined();
  });

  it('18. pendingCount is 1 (one require_approval op)', async () => {
    ctx = await setup();
    await seedGitCommitTool(ctx);

    const { body } = await getJSON(ctx.port, '/tools/git_commit');
    const b = body as { pendingCount: number };
    expect(b.pendingCount).toBe(1);
  });

  it('19. response includes topSessions field as an array', async () => {
    ctx = await setup();
    await seedGitCommitTool(ctx);

    const { body } = await getJSON(ctx.port, '/tools/git_commit');
    const b = body as Record<string, unknown>;
    expect(b['topSessions']).toBeDefined();
    expect(Array.isArray(b['topSessions'])).toBe(true);
  });

  it('20. topSessions entries have sessionId and count', async () => {
    ctx = await setup();
    await seedGitCommitTool(ctx);

    const { body } = await getJSON(ctx.port, '/tools/git_commit');
    const b = body as { topSessions: Array<Record<string, unknown>> };
    expect(b.topSessions.length).toBeGreaterThan(0);
    for (const entry of b.topSessions) {
      expect(entry['sessionId']).toBeDefined();
      expect(typeof entry['count']).toBe('number');
    }
  });

  it('21. response includes blockStreak field', async () => {
    ctx = await setup();
    await seedGitCommitTool(ctx);

    const { body } = await getJSON(ctx.port, '/tools/git_commit');
    const b = body as Record<string, unknown>;
    expect(b['blockStreak']).toBeDefined();
  });

  it('22. blockStreak is 0 (most recent op is require_approval, not block)', async () => {
    ctx = await setup();
    await seedGitCommitTool(ctx);

    const { body } = await getJSON(ctx.port, '/tools/git_commit');
    const b = body as { blockStreak: number };
    expect(b.blockStreak).toBe(0);
  });

  it('23. allowRate is a number between 0 and 1', async () => {
    ctx = await setup();
    await seedGitCommitTool(ctx);

    const { body } = await getJSON(ctx.port, '/tools/git_commit');
    const b = body as { allowRate: number };
    expect(typeof b.allowRate).toBe('number');
    expect(b.allowRate).toBeGreaterThanOrEqual(0);
    expect(b.allowRate).toBeLessThanOrEqual(1);
  });

  it('24. allowRate is 1.0 when all ops are allowed', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'tool-pure-allow', { id: crypto.randomUUID() }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-b', 'tool-pure-allow', { id: crypto.randomUUID() }), dec('allow', 0.2));

    const { body } = await getJSON(ctx.port, '/tools/tool-pure-allow');
    const b = body as { allowRate: number };
    expect(b.allowRate).toBeCloseTo(1.0, 5);
  });
});

// ── T446 — GET /sessions/:id extended fields ──────────────────────────────────

describe('GET /sessions/:id — v0.66 fields (T446)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * Seeds session-Z with 2 ops exactly 2 minutes apart using explicit timestamps.
   * The first op is at t0, the second at t0 + 2 minutes.
   */
  async function seedSessionZ(ctx: Ctx): Promise<{ t0: Date; t1: Date }> {
    const t0 = new Date(Date.now() - 5 * 60 * 1000); // 5 minutes ago
    const t1 = new Date(t0.getTime() + 2 * 60 * 1000); // 2 minutes after t0

    await ctx.store.saveOperationLog({
      operationId: crypto.randomUUID(),
      operation: makeOp('agent-z', 'tool-alpha', { id: crypto.randomUUID(), sessionId: 'session-Z', timestamp: t0 }),
      decision: dec('allow', 0.2),
      createdAt: t0,
    });
    await ctx.store.saveOperationLog({
      operationId: crypto.randomUUID(),
      operation: makeOp('agent-z', 'tool-beta', { id: crypto.randomUUID(), sessionId: 'session-Z', timestamp: t1 }),
      decision: dec('block', 0.8),
      createdAt: t1,
    });

    return { t0, t1 };
  }

  it('25. GET /sessions/session-Z returns 200', async () => {
    ctx = await setup();
    await seedSessionZ(ctx);

    const { status } = await getJSON(ctx.port, '/sessions/session-Z');
    expect(status).toBe(200);
  });

  it('26. response includes firstSeen field', async () => {
    ctx = await setup();
    await seedSessionZ(ctx);

    const { body } = await getJSON(ctx.port, '/sessions/session-Z');
    const b = body as Record<string, unknown>;
    expect(b['firstSeen']).toBeDefined();
  });

  it('27. firstSeen is an ISO string', async () => {
    ctx = await setup();
    await seedSessionZ(ctx);

    const { body } = await getJSON(ctx.port, '/sessions/session-Z');
    const b = body as { firstSeen: string };
    expect(typeof b.firstSeen).toBe('string');
    // Validate ISO format: must parse to a valid date
    const parsed = new Date(b.firstSeen);
    expect(Number.isNaN(parsed.getTime())).toBe(false);
    expect(b.firstSeen).toContain('T'); // ISO format contains 'T' separator
  });

  it('28. response includes lastSeen field', async () => {
    ctx = await setup();
    await seedSessionZ(ctx);

    const { body } = await getJSON(ctx.port, '/sessions/session-Z');
    const b = body as Record<string, unknown>;
    expect(b['lastSeen']).toBeDefined();
  });

  it('29. lastSeen is an ISO string', async () => {
    ctx = await setup();
    await seedSessionZ(ctx);

    const { body } = await getJSON(ctx.port, '/sessions/session-Z');
    const b = body as { lastSeen: string };
    expect(typeof b.lastSeen).toBe('string');
    const parsed = new Date(b.lastSeen);
    expect(Number.isNaN(parsed.getTime())).toBe(false);
    expect(b.lastSeen).toContain('T');
  });

  it('30. lastSeen is after firstSeen when ops span 2 minutes', async () => {
    ctx = await setup();
    await seedSessionZ(ctx);

    const { body } = await getJSON(ctx.port, '/sessions/session-Z');
    const b = body as { firstSeen: string; lastSeen: string };
    expect(new Date(b.lastSeen).getTime()).toBeGreaterThan(new Date(b.firstSeen).getTime());
  });

  it('31. response includes sessionDuration field', async () => {
    ctx = await setup();
    await seedSessionZ(ctx);

    const { body } = await getJSON(ctx.port, '/sessions/session-Z');
    const b = body as Record<string, unknown>;
    expect(b['sessionDuration']).toBeDefined();
  });

  it('32. sessionDuration is approximately 2 minutes in milliseconds (within 1s tolerance)', async () => {
    ctx = await setup();
    await seedSessionZ(ctx);

    const { body } = await getJSON(ctx.port, '/sessions/session-Z');
    const b = body as { sessionDuration: number };
    const expectedMs = 2 * 60 * 1000;
    expect(typeof b.sessionDuration).toBe('number');
    expect(Math.abs(b.sessionDuration - expectedMs)).toBeLessThan(1000);
  });

  it('33. sessionDuration is 0 for a session with a single op', async () => {
    ctx = await setup();
    const t = new Date();
    await ctx.store.saveOperationLog({
      operationId: crypto.randomUUID(),
      operation: makeOp('agent-z', 'tool-solo', { id: crypto.randomUUID(), sessionId: 'sess-single-op', timestamp: t }),
      decision: dec('allow', 0.1),
      createdAt: t,
    });

    const { body } = await getJSON(ctx.port, '/sessions/sess-single-op');
    const b = body as { sessionDuration: number };
    expect(b.sessionDuration).toBe(0);
  });

  it('34. response includes recentBlockedOps field', async () => {
    ctx = await setup();
    await seedSessionZ(ctx);

    const { body } = await getJSON(ctx.port, '/sessions/session-Z');
    const b = body as Record<string, unknown>;
    expect(b['recentBlockedOps']).toBeDefined();
    expect(Array.isArray(b['recentBlockedOps'])).toBe(true);
  });

  it('35. recentBlockedOps contains the blocked op from session-Z', async () => {
    ctx = await setup();
    await seedSessionZ(ctx);

    const { body } = await getJSON(ctx.port, '/sessions/session-Z');
    const b = body as { recentBlockedOps: Array<Record<string, unknown>> };
    // We seeded 1 blocked op
    expect(b.recentBlockedOps.length).toBe(1);
    expect(b.recentBlockedOps[0]!['tool']).toBe('tool-beta');
  });

  it('36. recentBlockedOps is empty when no ops in session are blocked', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'tool-x', { id: crypto.randomUUID(), sessionId: 'sess-no-blocks' }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-a', 'tool-y', { id: crypto.randomUUID(), sessionId: 'sess-no-blocks' }), dec('allow', 0.2));

    const { body } = await getJSON(ctx.port, '/sessions/sess-no-blocks');
    const b = body as { recentBlockedOps: unknown[] };
    expect(b.recentBlockedOps).toHaveLength(0);
  });

  it('37. recentBlockedOps entries include operationId, tool, riskScore fields', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'tool-danger', { id: crypto.randomUUID(), sessionId: 'sess-fields-check' }), dec('block', 0.95));

    const { body } = await getJSON(ctx.port, '/sessions/sess-fields-check');
    const b = body as { recentBlockedOps: Array<Record<string, unknown>> };
    expect(b.recentBlockedOps.length).toBe(1);
    const entry = b.recentBlockedOps[0]!;
    expect(entry['operationId']).toBeDefined();
    expect(entry['tool']).toBe('tool-danger');
    expect(typeof entry['riskScore']).toBe('number');
  });

  it('38. recentBlockedOps caps at 5 entries even when more blocked ops exist', async () => {
    ctx = await setup();
    for (let i = 0; i < 8; i++) {
      await ctx.logger.log(
        makeOp('agent-a', `tool-${i}`, { id: crypto.randomUUID(), sessionId: 'sess-many-blocks' }),
        dec('block', 0.9)
      );
    }

    const { body } = await getJSON(ctx.port, '/sessions/sess-many-blocks');
    const b = body as { recentBlockedOps: unknown[] };
    expect(b.recentBlockedOps.length).toBeLessThanOrEqual(5);
  });
});

// ── T447 — GET /operations/summary uniqueAgents / uniqueTools ─────────────────

describe('GET /operations/summary — uniqueAgents / uniqueTools (T447)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * Seeds ops from 2 distinct agents using 3 distinct tools.
   */
  async function seedSummaryMultiAgentTools(ctx: Ctx): Promise<void> {
    // agent-ua1 uses tool-ta and tool-tb
    await ctx.logger.log(makeOp('agent-ua1', 'tool-ta', { id: crypto.randomUUID() }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-ua1', 'tool-tb', { id: crypto.randomUUID() }), dec('allow', 0.2));
    // agent-ua2 uses tool-tb (shared) and tool-tc (unique to agent-ua2)
    await ctx.logger.log(makeOp('agent-ua2', 'tool-tb', { id: crypto.randomUUID() }), dec('block', 0.8));
    await ctx.logger.log(makeOp('agent-ua2', 'tool-tc', { id: crypto.randomUUID() }), dec('allow', 0.3));
  }

  it('39. GET /operations/summary returns 200', async () => {
    ctx = await setup();
    await seedSummaryMultiAgentTools(ctx);

    const { status } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);
  });

  it('40. response includes uniqueAgents field', async () => {
    ctx = await setup();
    await seedSummaryMultiAgentTools(ctx);

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as Record<string, unknown>;
    expect(b['uniqueAgents']).toBeDefined();
  });

  it('41. uniqueAgents is 2 for ops from 2 distinct agents', async () => {
    ctx = await setup();
    await seedSummaryMultiAgentTools(ctx);

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { uniqueAgents: number };
    expect(b.uniqueAgents).toBe(2);
  });

  it('42. uniqueAgents is a number type', async () => {
    ctx = await setup();
    await seedSummaryMultiAgentTools(ctx);

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { uniqueAgents: unknown };
    expect(typeof b.uniqueAgents).toBe('number');
  });

  it('43. response includes uniqueTools field', async () => {
    ctx = await setup();
    await seedSummaryMultiAgentTools(ctx);

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as Record<string, unknown>;
    expect(b['uniqueTools']).toBeDefined();
  });

  it('44. uniqueTools is 3 for ops using 3 distinct tools', async () => {
    ctx = await setup();
    await seedSummaryMultiAgentTools(ctx);

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { uniqueTools: number };
    expect(b.uniqueTools).toBe(3);
  });

  it('45. uniqueTools is a number type', async () => {
    ctx = await setup();
    await seedSummaryMultiAgentTools(ctx);

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { uniqueTools: unknown };
    expect(typeof b.uniqueTools).toBe('number');
  });

  it('46. uniqueAgents is 0 when no ops exist', async () => {
    ctx = await setup();

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { uniqueAgents: number };
    expect(b.uniqueAgents).toBe(0);
  });

  it('47. uniqueTools is 0 when no ops exist', async () => {
    ctx = await setup();

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { uniqueTools: number };
    expect(b.uniqueTools).toBe(0);
  });

  it('48. same agent using same tool multiple times still counts as 1 agent and 1 tool', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-solo', 'tool-only', { id: crypto.randomUUID() }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-solo', 'tool-only', { id: crypto.randomUUID() }), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-solo', 'tool-only', { id: crypto.randomUUID() }), dec('block', 0.9));

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { uniqueAgents: number; uniqueTools: number };
    expect(b.uniqueAgents).toBe(1);
    expect(b.uniqueTools).toBe(1);
  });
});

// ── T448 — GET /sessions totalBlocked / avgBlockRate ─────────────────────────

describe('GET /sessions — totalBlocked / avgBlockRate (T448)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * Seeds 2 sessions:
   *   sess-p: 2 ops — 1 block, 1 allow  → blockRate = 0.5
   *   sess-q: 3 ops — 0 block, 3 allow  → blockRate = 0.0
   * Total blocked across sessions: 1
   * avgBlockRate across sessions: (0.5 + 0.0) / 2 = 0.25
   */
  async function seedTwoSessions(ctx: Ctx): Promise<void> {
    // sess-p: 1 block, 1 allow
    await ctx.logger.log(makeOp('agent-p', 'tool-x', { id: crypto.randomUUID(), sessionId: 'sess-p' }), dec('block', 0.9));
    await ctx.logger.log(makeOp('agent-p', 'tool-y', { id: crypto.randomUUID(), sessionId: 'sess-p' }), dec('allow', 0.1));
    // sess-q: 3 allows
    await ctx.logger.log(makeOp('agent-q', 'tool-a', { id: crypto.randomUUID(), sessionId: 'sess-q' }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-q', 'tool-b', { id: crypto.randomUUID(), sessionId: 'sess-q' }), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-q', 'tool-c', { id: crypto.randomUUID(), sessionId: 'sess-q' }), dec('allow', 0.3));
  }

  it('49. GET /sessions returns 200', async () => {
    ctx = await setup();
    await seedTwoSessions(ctx);

    const { status } = await getJSON(ctx.port, '/sessions');
    expect(status).toBe(200);
  });

  it('50. response includes totalBlocked field', async () => {
    ctx = await setup();
    await seedTwoSessions(ctx);

    const { body } = await getJSON(ctx.port, '/sessions');
    const b = body as Record<string, unknown>;
    expect(b['totalBlocked']).toBeDefined();
  });

  it('51. totalBlocked is 1 (one block op across 2 seeded sessions)', async () => {
    ctx = await setup();
    await seedTwoSessions(ctx);

    const { body } = await getJSON(ctx.port, '/sessions');
    const b = body as { totalBlocked: number };
    expect(b.totalBlocked).toBe(1);
  });

  it('52. totalBlocked is a number type', async () => {
    ctx = await setup();
    await seedTwoSessions(ctx);

    const { body } = await getJSON(ctx.port, '/sessions');
    const b = body as { totalBlocked: unknown };
    expect(typeof b.totalBlocked).toBe('number');
  });

  it('53. response includes totalAllowed field', async () => {
    ctx = await setup();
    await seedTwoSessions(ctx);

    const { body } = await getJSON(ctx.port, '/sessions');
    const b = body as Record<string, unknown>;
    expect(b['totalAllowed']).toBeDefined();
  });

  it('54. response includes avgBlockRate field', async () => {
    ctx = await setup();
    await seedTwoSessions(ctx);

    const { body } = await getJSON(ctx.port, '/sessions');
    const b = body as Record<string, unknown>;
    expect(b['avgBlockRate']).toBeDefined();
  });

  it('55. avgBlockRate is approximately 0.25 (mean of 0.5 and 0.0 per session)', async () => {
    ctx = await setup();
    await seedTwoSessions(ctx);

    const { body } = await getJSON(ctx.port, '/sessions');
    const b = body as { avgBlockRate: number };
    expect(b.avgBlockRate).toBeCloseTo(0.25, 5);
  });

  it('56. avgBlockRate is a number between 0 and 1', async () => {
    ctx = await setup();
    await seedTwoSessions(ctx);

    const { body } = await getJSON(ctx.port, '/sessions');
    const b = body as { avgBlockRate: number };
    expect(typeof b.avgBlockRate).toBe('number');
    expect(b.avgBlockRate).toBeGreaterThanOrEqual(0);
    expect(b.avgBlockRate).toBeLessThanOrEqual(1);
  });

  it('57. totalBlocked is 0 when no ops are blocked', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'tool-x', { id: crypto.randomUUID(), sessionId: 'sess-safe' }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-a', 'tool-y', { id: crypto.randomUUID(), sessionId: 'sess-safe' }), dec('allow', 0.2));

    const { body } = await getJSON(ctx.port, '/sessions');
    const b = body as { totalBlocked: number };
    expect(b.totalBlocked).toBe(0);
  });

  it('58. avgBlockRate is 0 when no sessions have blocked ops', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'tool-x', { id: crypto.randomUUID(), sessionId: 'sess-all-good' }), dec('allow', 0.1));

    const { body } = await getJSON(ctx.port, '/sessions');
    const b = body as { avgBlockRate: number };
    expect(b.avgBlockRate).toBeCloseTo(0.0, 5);
  });

  it('59. totalAllowed is 4 (4 allow ops across 2 seeded sessions)', async () => {
    ctx = await setup();
    await seedTwoSessions(ctx);

    const { body } = await getJSON(ctx.port, '/sessions');
    const b = body as { totalAllowed: number };
    expect(b.totalAllowed).toBe(4);
  });
});
