/**
 * v0.68 tests
 *
 * T454 — GET /agents?minRiskScore=X filters agents by their minimum risk score
 * T455 — GET /tools?minRiskScore=X filters tools by their minimum risk score
 * T456 — GET /agents/:agentId returns riskBuckets distribution object
 * T457 — GET /operations/summary returns topBlockedAgents[] sorted by block count desc
 * T458 — GET /tools?sort=minRiskScore&order=asc sorts tools by minRiskScore ascending
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

// ── T454 — GET /agents?minRiskScore=X filters agents ─────────────────────────

describe('GET /agents?minRiskScore — filter by minimum risk score (T454)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * Seeds two agents:
   *   agent-P: riskScores [0.5, 0.8] → minRiskScore = 0.5
   *   agent-Q: riskScores [0.1, 0.2] → minRiskScore = 0.1
   */
  async function seedAgents(ctx: Ctx): Promise<void> {
    // agent-P: two ops with scores 0.5 and 0.8
    await ctx.logger.log(makeOp('agent-P', 'tool-x', { id: crypto.randomUUID() }), dec('allow', 0.5));
    await ctx.logger.log(makeOp('agent-P', 'tool-y', { id: crypto.randomUUID() }), dec('allow', 0.8));
    // agent-Q: two ops with scores 0.1 and 0.2
    await ctx.logger.log(makeOp('agent-Q', 'tool-x', { id: crypto.randomUUID() }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-Q', 'tool-y', { id: crypto.randomUUID() }), dec('allow', 0.2));
  }

  it('1. GET /agents?minRiskScore=0.4 returns only agent-P (minRiskScore >= 0.4)', async () => {
    ctx = await setup();
    await seedAgents(ctx);

    const { status, body } = await getJSON(ctx.port, '/agents?minRiskScore=0.4');
    expect(status).toBe(200);
    const b = body as { agents: Array<{ agentId: string }> };
    const ids = b.agents.map(a => a.agentId);
    expect(ids).toContain('agent-P');
    expect(ids).not.toContain('agent-Q');
  });

  it('2. GET /agents?minRiskScore=0.4 result contains exactly 1 agent', async () => {
    ctx = await setup();
    await seedAgents(ctx);

    const { body } = await getJSON(ctx.port, '/agents?minRiskScore=0.4');
    const b = body as { agents: unknown[] };
    expect(b.agents).toHaveLength(1);
  });

  it('3. agent-P has minRiskScore of 0.5 in the response', async () => {
    ctx = await setup();
    await seedAgents(ctx);

    const { body } = await getJSON(ctx.port, '/agents?minRiskScore=0.4');
    const b = body as { agents: Array<{ agentId: string; minRiskScore: number }> };
    const agentP = b.agents.find(a => a.agentId === 'agent-P');
    expect(agentP).toBeDefined();
    expect(agentP!.minRiskScore).toBeCloseTo(0.5, 5);
  });

  it('4. GET /agents?maxMinRiskScore=0.2 returns only agent-Q (minRiskScore <= 0.2)', async () => {
    ctx = await setup();
    await seedAgents(ctx);

    const { status, body } = await getJSON(ctx.port, '/agents?maxMinRiskScore=0.2');
    expect(status).toBe(200);
    const b = body as { agents: Array<{ agentId: string }> };
    const ids = b.agents.map(a => a.agentId);
    expect(ids).toContain('agent-Q');
    expect(ids).not.toContain('agent-P');
  });

  it('5. GET /agents?maxMinRiskScore=0.2 result contains exactly 1 agent', async () => {
    ctx = await setup();
    await seedAgents(ctx);

    const { body } = await getJSON(ctx.port, '/agents?maxMinRiskScore=0.2');
    const b = body as { agents: unknown[] };
    expect(b.agents).toHaveLength(1);
  });

  it('6. agent-Q has minRiskScore of 0.1 in the maxMinRiskScore response', async () => {
    ctx = await setup();
    await seedAgents(ctx);

    const { body } = await getJSON(ctx.port, '/agents?maxMinRiskScore=0.2');
    const b = body as { agents: Array<{ agentId: string; minRiskScore: number }> };
    const agentQ = b.agents.find(a => a.agentId === 'agent-Q');
    expect(agentQ).toBeDefined();
    expect(agentQ!.minRiskScore).toBeCloseTo(0.1, 5);
  });

  it('7. GET /agents?minRiskScore=0.0 returns both agents', async () => {
    ctx = await setup();
    await seedAgents(ctx);

    const { body } = await getJSON(ctx.port, '/agents?minRiskScore=0.0');
    const b = body as { agents: Array<{ agentId: string }> };
    const ids = b.agents.map(a => a.agentId);
    expect(ids).toContain('agent-P');
    expect(ids).toContain('agent-Q');
  });

  it('8. GET /agents?minRiskScore=0.9 returns no agents (threshold above both mins)', async () => {
    ctx = await setup();
    await seedAgents(ctx);

    const { body } = await getJSON(ctx.port, '/agents?minRiskScore=0.9');
    const b = body as { agents: unknown[] };
    expect(b.agents).toHaveLength(0);
  });
});

// ── T455 — GET /tools?minRiskScore=X filters tools ───────────────────────────

describe('GET /tools?minRiskScore — filter by minimum risk score (T455)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * Seeds two tools:
   *   clean_disk: riskScores [0.1, 0.2] → minRiskScore = 0.1
   *   rm_file:    riskScores [0.6, 0.9] → minRiskScore = 0.6
   */
  async function seedTools(ctx: Ctx): Promise<void> {
    await ctx.logger.log(makeOp('agent-a', 'clean_disk', { id: crypto.randomUUID() }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-b', 'clean_disk', { id: crypto.randomUUID() }), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-a', 'rm_file', { id: crypto.randomUUID() }), dec('block', 0.6));
    await ctx.logger.log(makeOp('agent-b', 'rm_file', { id: crypto.randomUUID() }), dec('block', 0.9));
  }

  it('9. GET /tools?minRiskScore=0.5 returns only rm_file', async () => {
    ctx = await setup();
    await seedTools(ctx);

    const { status, body } = await getJSON(ctx.port, '/tools?minRiskScore=0.5');
    expect(status).toBe(200);
    const b = body as { tools: Array<{ tool: string }> };
    const toolNames = b.tools.map(t => t.tool);
    expect(toolNames).toContain('rm_file');
    expect(toolNames).not.toContain('clean_disk');
  });

  it('10. GET /tools?minRiskScore=0.5 result contains exactly 1 tool', async () => {
    ctx = await setup();
    await seedTools(ctx);

    const { body } = await getJSON(ctx.port, '/tools?minRiskScore=0.5');
    const b = body as { tools: unknown[] };
    expect(b.tools).toHaveLength(1);
  });

  it('11. rm_file has minRiskScore of 0.6 in the filtered response', async () => {
    ctx = await setup();
    await seedTools(ctx);

    const { body } = await getJSON(ctx.port, '/tools?minRiskScore=0.5');
    const b = body as { tools: Array<{ tool: string; minRiskScore: number }> };
    const rmFile = b.tools.find(t => t.tool === 'rm_file');
    expect(rmFile).toBeDefined();
    expect(rmFile!.minRiskScore).toBeCloseTo(0.6, 5);
  });

  it('12. GET /tools?minRiskScore=0.0 returns both tools', async () => {
    ctx = await setup();
    await seedTools(ctx);

    const { body } = await getJSON(ctx.port, '/tools?minRiskScore=0.0');
    const b = body as { tools: Array<{ tool: string }> };
    const toolNames = b.tools.map(t => t.tool);
    expect(toolNames).toContain('clean_disk');
    expect(toolNames).toContain('rm_file');
  });

  it('13. GET /tools?minRiskScore=0.95 returns no tools', async () => {
    ctx = await setup();
    await seedTools(ctx);

    const { body } = await getJSON(ctx.port, '/tools?minRiskScore=0.95');
    const b = body as { tools: unknown[] };
    expect(b.tools).toHaveLength(0);
  });
});

// ── T456 — GET /agents/:agentId returns riskBuckets ──────────────────────────

describe('GET /agents/:agentId — riskBuckets distribution (T456)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * Seeds 5 ops for agent-bucket with risk scores one per bucket:
   *   0.1 → '0.0-0.2'
   *   0.3 → '0.2-0.4'
   *   0.5 → '0.4-0.6'
   *   0.7 → '0.6-0.8'
   *   0.9 → '0.8-1.0'
   */
  async function seedBucketAgent(ctx: Ctx): Promise<void> {
    const scores = [0.1, 0.3, 0.5, 0.7, 0.9];
    for (const score of scores) {
      await ctx.logger.log(
        makeOp('agent-bucket', 'tool-x', { id: crypto.randomUUID() }),
        dec('allow', score)
      );
    }
  }

  it('14. riskBuckets is present in GET /agents/:agentId response', async () => {
    ctx = await setup();
    await seedBucketAgent(ctx);

    const { status, body } = await getJSON(ctx.port, '/agents/agent-bucket');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['riskBuckets']).toBeDefined();
  });

  it('15. riskBuckets is an object', async () => {
    ctx = await setup();
    await seedBucketAgent(ctx);

    const { body } = await getJSON(ctx.port, '/agents/agent-bucket');
    const b = body as { riskBuckets: unknown };
    expect(typeof b.riskBuckets).toBe('object');
    expect(b.riskBuckets).not.toBeNull();
    expect(Array.isArray(b.riskBuckets)).toBe(false);
  });

  it('16. riskBuckets["0.0-0.2"] === 1 for score 0.1', async () => {
    ctx = await setup();
    await seedBucketAgent(ctx);

    const { body } = await getJSON(ctx.port, '/agents/agent-bucket');
    const b = body as { riskBuckets: Record<string, number> };
    expect(b.riskBuckets['0.0-0.2']).toBe(1);
  });

  it('17. riskBuckets["0.2-0.4"] === 1 for score 0.3', async () => {
    ctx = await setup();
    await seedBucketAgent(ctx);

    const { body } = await getJSON(ctx.port, '/agents/agent-bucket');
    const b = body as { riskBuckets: Record<string, number> };
    expect(b.riskBuckets['0.2-0.4']).toBe(1);
  });

  it('18. riskBuckets["0.4-0.6"] === 1 for score 0.5', async () => {
    ctx = await setup();
    await seedBucketAgent(ctx);

    const { body } = await getJSON(ctx.port, '/agents/agent-bucket');
    const b = body as { riskBuckets: Record<string, number> };
    expect(b.riskBuckets['0.4-0.6']).toBe(1);
  });

  it('19. riskBuckets["0.6-0.8"] === 1 for score 0.7', async () => {
    ctx = await setup();
    await seedBucketAgent(ctx);

    const { body } = await getJSON(ctx.port, '/agents/agent-bucket');
    const b = body as { riskBuckets: Record<string, number> };
    expect(b.riskBuckets['0.6-0.8']).toBe(1);
  });

  it('20. riskBuckets["0.8-1.0"] === 1 for score 0.9', async () => {
    ctx = await setup();
    await seedBucketAgent(ctx);

    const { body } = await getJSON(ctx.port, '/agents/agent-bucket');
    const b = body as { riskBuckets: Record<string, number> };
    expect(b.riskBuckets['0.8-1.0']).toBe(1);
  });

  it('21. riskBuckets has exactly 5 keys (one per bucket range)', async () => {
    ctx = await setup();
    await seedBucketAgent(ctx);

    const { body } = await getJSON(ctx.port, '/agents/agent-bucket');
    const b = body as { riskBuckets: Record<string, number> };
    expect(Object.keys(b.riskBuckets)).toHaveLength(5);
  });

  it('22. riskBuckets total count equals totalOps', async () => {
    ctx = await setup();
    await seedBucketAgent(ctx);

    const { body } = await getJSON(ctx.port, '/agents/agent-bucket');
    const b = body as { riskBuckets: Record<string, number>; totalOps: number };
    const total = Object.values(b.riskBuckets).reduce((s, n) => s + n, 0);
    expect(total).toBe(b.totalOps);
  });

  it('23. riskBuckets accumulates multiple ops in the same bucket', async () => {
    ctx = await setup();
    // Score two more ops into the 0.0-0.2 bucket
    await ctx.logger.log(makeOp('agent-bucket2', 'tool-a', { id: crypto.randomUUID() }), dec('allow', 0.05));
    await ctx.logger.log(makeOp('agent-bucket2', 'tool-b', { id: crypto.randomUUID() }), dec('allow', 0.15));
    await ctx.logger.log(makeOp('agent-bucket2', 'tool-c', { id: crypto.randomUUID() }), dec('block', 0.95));

    const { body } = await getJSON(ctx.port, '/agents/agent-bucket2');
    const b = body as { riskBuckets: Record<string, number> };
    expect(b.riskBuckets['0.0-0.2']).toBe(2);
    expect(b.riskBuckets['0.8-1.0']).toBe(1);
  });
});

// ── T457 — GET /operations/summary returns topBlockedAgents[] ────────────────

describe('GET /operations/summary — topBlockedAgents (T457)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * Seeds:
   *   agent-X: 3 blocked ops
   *   agent-Y: 1 blocked op
   *   agent-Z: 5 blocked ops
   * Expected topBlockedAgents order: agent-Z (5), agent-X (3), agent-Y (1)
   */
  async function seedBlockedAgents(ctx: Ctx): Promise<void> {
    // agent-Z: 5 blocks
    for (let i = 0; i < 5; i++) {
      await ctx.logger.log(makeOp('agent-Z', 'tool-a', { id: crypto.randomUUID() }), dec('block', 0.9));
    }
    // agent-X: 3 blocks
    for (let i = 0; i < 3; i++) {
      await ctx.logger.log(makeOp('agent-X', 'tool-b', { id: crypto.randomUUID() }), dec('block', 0.8));
    }
    // agent-Y: 1 block
    await ctx.logger.log(makeOp('agent-Y', 'tool-c', { id: crypto.randomUUID() }), dec('block', 0.7));
  }

  it('24. topBlockedAgents is present in GET /operations/summary response', async () => {
    ctx = await setup();
    await seedBlockedAgents(ctx);

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['topBlockedAgents']).toBeDefined();
  });

  it('25. topBlockedAgents is an array', async () => {
    ctx = await setup();
    await seedBlockedAgents(ctx);

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { topBlockedAgents: unknown };
    expect(Array.isArray(b.topBlockedAgents)).toBe(true);
  });

  it('26. topBlockedAgents[0].agentId === "agent-Z" (highest block count)', async () => {
    ctx = await setup();
    await seedBlockedAgents(ctx);

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { topBlockedAgents: Array<{ agentId: string; blocked: number }> };
    expect(b.topBlockedAgents[0]!.agentId).toBe('agent-Z');
  });

  it('27. topBlockedAgents[0].blocked === 5', async () => {
    ctx = await setup();
    await seedBlockedAgents(ctx);

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { topBlockedAgents: Array<{ agentId: string; blocked: number }> };
    expect(b.topBlockedAgents[0]!.blocked).toBe(5);
  });

  it('28. topBlockedAgents[1].agentId === "agent-X" (second highest)', async () => {
    ctx = await setup();
    await seedBlockedAgents(ctx);

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { topBlockedAgents: Array<{ agentId: string; blocked: number }> };
    expect(b.topBlockedAgents[1]!.agentId).toBe('agent-X');
  });

  it('29. topBlockedAgents[1].blocked === 3', async () => {
    ctx = await setup();
    await seedBlockedAgents(ctx);

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { topBlockedAgents: Array<{ agentId: string; blocked: number }> };
    expect(b.topBlockedAgents[1]!.blocked).toBe(3);
  });

  it('30. topBlockedAgents is sorted by blocked count descending', async () => {
    ctx = await setup();
    await seedBlockedAgents(ctx);

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { topBlockedAgents: Array<{ blocked: number }> };
    const counts = b.topBlockedAgents.map(a => a.blocked);
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]).toBeLessThanOrEqual(counts[i - 1]!);
    }
  });

  it('31. topBlockedAgents is empty when no ops are blocked', async () => {
    ctx = await setup();
    // Only allowed ops
    await ctx.logger.log(makeOp('agent-safe', 'tool-safe', { id: crypto.randomUUID() }), dec('allow', 0.1));

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { topBlockedAgents: unknown[] };
    expect(b.topBlockedAgents).toHaveLength(0);
  });

  it('32. topBlockedAgents contains at most 5 entries', async () => {
    ctx = await setup();
    // Seed 6 distinct agents each with 1 block
    for (let i = 1; i <= 6; i++) {
      await ctx.logger.log(makeOp(`agent-many-${i}`, 'tool-x', { id: crypto.randomUUID() }), dec('block', 0.8));
    }

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { topBlockedAgents: unknown[] };
    expect(b.topBlockedAgents.length).toBeLessThanOrEqual(5);
  });

  it('33. topBlockedAgents entries include agentId and blocked fields', async () => {
    ctx = await setup();
    await seedBlockedAgents(ctx);

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { topBlockedAgents: Array<Record<string, unknown>> };
    for (const entry of b.topBlockedAgents) {
      expect(typeof entry['agentId']).toBe('string');
      expect(typeof entry['blocked']).toBe('number');
    }
  });
});

// ── T458 — GET /tools?sort=minRiskScore&order=asc sorts by minRiskScore ──────

describe('GET /tools?sort=minRiskScore&order=asc — sort tools by minRiskScore (T458)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * Seeds two tools:
   *   tool-A: riskScores [0.8, 0.9] → minRiskScore = 0.8
   *   tool-B: riskScores [0.1, 0.2] → minRiskScore = 0.1
   */
  async function seedSortTools(ctx: Ctx): Promise<void> {
    await ctx.logger.log(makeOp('agent-a', 'tool-A', { id: crypto.randomUUID() }), dec('allow', 0.8));
    await ctx.logger.log(makeOp('agent-b', 'tool-A', { id: crypto.randomUUID() }), dec('block', 0.9));
    await ctx.logger.log(makeOp('agent-a', 'tool-B', { id: crypto.randomUUID() }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-b', 'tool-B', { id: crypto.randomUUID() }), dec('allow', 0.2));
  }

  it('34. GET /tools?sort=minRiskScore&order=asc returns 200', async () => {
    ctx = await setup();
    await seedSortTools(ctx);

    const { status } = await getJSON(ctx.port, '/tools?sort=minRiskScore&order=asc');
    expect(status).toBe(200);
  });

  it('35. tools[0].tool === "tool-B" (lowest minRiskScore first)', async () => {
    ctx = await setup();
    await seedSortTools(ctx);

    const { body } = await getJSON(ctx.port, '/tools?sort=minRiskScore&order=asc');
    const b = body as { tools: Array<{ tool: string }> };
    expect(b.tools[0]!.tool).toBe('tool-B');
  });

  it('36. tools[0].minRiskScore === 0.1', async () => {
    ctx = await setup();
    await seedSortTools(ctx);

    const { body } = await getJSON(ctx.port, '/tools?sort=minRiskScore&order=asc');
    const b = body as { tools: Array<{ tool: string; minRiskScore: number }> };
    expect(b.tools[0]!.minRiskScore).toBeCloseTo(0.1, 5);
  });

  it('37. tools[1].tool === "tool-A" (highest minRiskScore last in asc)', async () => {
    ctx = await setup();
    await seedSortTools(ctx);

    const { body } = await getJSON(ctx.port, '/tools?sort=minRiskScore&order=asc');
    const b = body as { tools: Array<{ tool: string }> };
    expect(b.tools[1]!.tool).toBe('tool-A');
  });

  it('38. tools[1].minRiskScore === 0.8', async () => {
    ctx = await setup();
    await seedSortTools(ctx);

    const { body } = await getJSON(ctx.port, '/tools?sort=minRiskScore&order=asc');
    const b = body as { tools: Array<{ tool: string; minRiskScore: number }> };
    expect(b.tools[1]!.minRiskScore).toBeCloseTo(0.8, 5);
  });

  it('39. tools array is sorted ascending by minRiskScore throughout', async () => {
    ctx = await setup();
    // Seed a third tool to verify ordering beyond 2 entries
    await ctx.logger.log(makeOp('agent-c', 'tool-C', { id: crypto.randomUUID() }), dec('block', 0.4));
    await ctx.logger.log(makeOp('agent-c', 'tool-C', { id: crypto.randomUUID() }), dec('block', 0.5));
    await seedSortTools(ctx);

    const { body } = await getJSON(ctx.port, '/tools?sort=minRiskScore&order=asc');
    const b = body as { tools: Array<{ minRiskScore: number }> };
    const scores = b.tools.map(t => t.minRiskScore);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeGreaterThanOrEqual(scores[i - 1]!);
    }
  });

  it('40. GET /tools?sort=minRiskScore&order=desc returns tool-A first (highest min)', async () => {
    ctx = await setup();
    await seedSortTools(ctx);

    const { body } = await getJSON(ctx.port, '/tools?sort=minRiskScore&order=desc');
    const b = body as { tools: Array<{ tool: string; minRiskScore: number }> };
    expect(b.tools[0]!.tool).toBe('tool-A');
    expect(b.tools[0]!.minRiskScore).toBeCloseTo(0.8, 5);
  });
});
