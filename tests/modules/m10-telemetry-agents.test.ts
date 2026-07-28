/**
 * T295 — GET /operations/export?q=<term>
 * T298 — GET /telemetry/agents/:agentId
 * T297 — GET /agents/:agentId/risk
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
    sessionId: 'sess-1',
    ...overrides,
  };
}

function dec(
  action: ProxyDecision['action'] = 'allow',
  riskScore = 0.2
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

async function getText(
  port: number,
  path: string
): Promise<{ status: number; body: string; contentType: string }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return {
    status: res.status,
    body: await res.text(),
    contentType: res.headers.get('content-type') ?? '',
  };
}

// ── T295 — GET /operations/export?q=<term> ───────────────────────────────────

describe('GET /operations/export?q= full-text search (T295)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('1. returns only ops whose agentId matches the search term', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-alpha', 'fs', { id: 'op-alpha' }), dec());
    await ctx.logger.log(makeOp('agent-beta', 'fs', { id: 'op-beta' }), dec());

    const { status, body } = await getText(ctx.port, '/operations/export?q=alpha');
    expect(status).toBe(200);
    expect(body).toContain('op-alpha');
    expect(body).not.toContain('op-beta');
  });

  it('2. returns only ops whose tool matches the search term', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-x', 'shell', { id: 'op-shell' }), dec());
    await ctx.logger.log(makeOp('agent-x', 'filesystem', { id: 'op-fs' }), dec());
    await ctx.logger.log(makeOp('agent-x', 'database', { id: 'op-db' }), dec());

    const { status, body } = await getText(ctx.port, '/operations/export?q=shell');
    expect(status).toBe(200);
    expect(body).toContain('op-shell');
    expect(body).not.toContain('op-fs');
    expect(body).not.toContain('op-db');
  });

  it('3. returns only ops whose method matches the search term', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-x', 'fs', { id: 'op-call', method: 'call' }), dec());
    await ctx.logger.log(makeOp('agent-x', 'fs', { id: 'op-notify', method: 'notify' }), dec());

    const { status, body } = await getText(ctx.port, '/operations/export?q=notify');
    expect(status).toBe(200);
    expect(body).toContain('op-notify');
    expect(body).not.toContain('op-call');
  });

  it('4. search is case-insensitive against agentId', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('Agent-CaseSensitive', 'fs', { id: 'op-case' }), dec());
    await ctx.logger.log(makeOp('unrelated-agent', 'fs', { id: 'op-unrelated' }), dec());

    const { body } = await getText(ctx.port, '/operations/export?q=casesensitive');
    expect(body).toContain('op-case');
    expect(body).not.toContain('op-unrelated');
  });

  it('5. search is case-insensitive against tool', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-x', 'SHELL', { id: 'op-upper-shell' }), dec());
    await ctx.logger.log(makeOp('agent-x', 'database', { id: 'op-db' }), dec());

    const { body } = await getText(ctx.port, '/operations/export?q=shell');
    expect(body).toContain('op-upper-shell');
    expect(body).not.toContain('op-db');
  });

  it('6. search is case-insensitive against method', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-x', 'fs', { id: 'op-call-upper', method: 'CALL' }), dec());
    await ctx.logger.log(makeOp('agent-x', 'fs', { id: 'op-notify', method: 'notify' }), dec());

    const { body } = await getText(ctx.port, '/operations/export?q=call');
    expect(body).toContain('op-call-upper');
    expect(body).not.toContain('op-notify');
  });

  it('7. search works with CSV format — response has CSV content-type', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-csv', 'fs', { id: 'op-csv' }), dec());

    const { status, body, contentType } = await getText(ctx.port, '/operations/export?q=csv');
    expect(status).toBe(200);
    expect(contentType).toContain('text/csv');
    expect(body).toContain('op-csv');
  });

  it('8. no match returns only the CSV header row', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-x', 'fs', { id: 'op-present' }), dec());

    const { body } = await getText(ctx.port, '/operations/export?q=zzz-no-match-zzz');
    const lines = body.split('\r\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('id');
  });

  it('9. empty q= parameter returns all ops (no filtering)', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-x', 'fs', { id: 'op-one' }), dec());
    await ctx.logger.log(makeOp('agent-y', 'shell', { id: 'op-two' }), dec());

    const { body } = await getText(ctx.port, '/operations/export?q=');
    const lines = body.split('\r\n').filter(Boolean);
    // header + 2 data rows
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(body).toContain('op-one');
    expect(body).toContain('op-two');
  });

  it('10. partial match on agentId substring is returned', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('production-worker-42', 'fs', { id: 'op-worker' }), dec());
    await ctx.logger.log(makeOp('staging-agent', 'fs', { id: 'op-staging' }), dec());

    const { body } = await getText(ctx.port, '/operations/export?q=worker');
    expect(body).toContain('op-worker');
    expect(body).not.toContain('op-staging');
  });
});

// ── T298 — GET /telemetry/agents/:agentId ─────────────────────────────────────

describe('GET /telemetry/agents/:agentId (T298)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('1. returns 404 when agent has no operations', async () => {
    ctx = await setup();
    const { status, body } = await getJSON(ctx.port, '/telemetry/agents/ghost-agent');
    expect(status).toBe(404);
    const b = body as { error: string };
    expect(b.error).toBeDefined();
  });

  it('2. returns { agentId, totalOps, blockRate, avgRisk } shape', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-shape', 'fs'), dec('allow', 0.3));

    const { status, body } = await getJSON(ctx.port, '/telemetry/agents/agent-shape');
    expect(status).toBe(200);
    const b = body as { agentId: string; totalOps: number; blockRate: number; avgRisk: number };
    expect(b.agentId).toBe('agent-shape');
    expect(b).toHaveProperty('totalOps');
    expect(b).toHaveProperty('blockRate');
    expect(b).toHaveProperty('avgRisk');
  });

  it('3. totalOps counts all operations for the agent', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-count', 'fs'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-count', 'shell'), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-count', 'db'), dec('block', 0.9));

    const { body } = await getJSON(ctx.port, '/telemetry/agents/agent-count');
    const b = body as { totalOps: number };
    expect(b.totalOps).toBe(3);
  });

  it('4. blockRate = blocked ops / total ops', async () => {
    ctx = await setup();
    // 1 block out of 3 → blockRate = 1/3
    await ctx.logger.log(makeOp('agent-br', 'fs'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-br', 'fs'), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-br', 'shell'), dec('block', 0.9));

    const { body } = await getJSON(ctx.port, '/telemetry/agents/agent-br');
    const b = body as { blockRate: number };
    expect(b.blockRate).toBeCloseTo(1 / 3, 5);
  });

  it('5. blockRate is 0 when no ops are blocked', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-clean', 'fs'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-clean', 'fs'), dec('allow', 0.2));

    const { body } = await getJSON(ctx.port, '/telemetry/agents/agent-clean');
    const b = body as { blockRate: number };
    expect(b.blockRate).toBe(0);
  });

  it('6. blockRate is 1 when all ops are blocked', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-risky', 'shell'), dec('block', 0.95));
    await ctx.logger.log(makeOp('agent-risky', 'shell'), dec('block', 0.99));

    const { body } = await getJSON(ctx.port, '/telemetry/agents/agent-risky');
    const b = body as { blockRate: number };
    expect(b.blockRate).toBe(1);
  });

  it('7. avgRisk = average riskScore across all ops for the agent', async () => {
    ctx = await setup();
    // (0.2 + 0.6) / 2 = 0.4
    await ctx.logger.log(makeOp('agent-avg', 'fs'), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-avg', 'db'), dec('block', 0.6));

    const { body } = await getJSON(ctx.port, '/telemetry/agents/agent-avg');
    const b = body as { avgRisk: number };
    expect(b.avgRisk).toBeCloseTo(0.4, 5);
  });

  it('8. only returns stats for the requested agent, not others', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-target', 'fs'), dec('allow', 0.3));
    // another agent with higher risk
    await ctx.logger.log(makeOp('agent-other', 'shell'), dec('block', 0.9));
    await ctx.logger.log(makeOp('agent-other', 'shell'), dec('block', 0.9));

    const { body } = await getJSON(ctx.port, '/telemetry/agents/agent-target');
    const b = body as { agentId: string; totalOps: number; blockRate: number; avgRisk: number };
    expect(b.agentId).toBe('agent-target');
    expect(b.totalOps).toBe(1);
    expect(b.blockRate).toBe(0);
    expect(b.avgRisk).toBeCloseTo(0.3, 5);
  });

  it('9. single op — blockRate and avgRisk match that op exactly', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-single', 'db'), dec('block', 0.75));

    const { body } = await getJSON(ctx.port, '/telemetry/agents/agent-single');
    const b = body as { totalOps: number; blockRate: number; avgRisk: number };
    expect(b.totalOps).toBe(1);
    expect(b.blockRate).toBe(1);
    expect(b.avgRisk).toBeCloseTo(0.75, 5);
  });
});

// ── T297 — GET /agents/:agentId/risk ──────────────────────────────────────────

describe('GET /agents/:agentId/risk (T297)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('1. returns 404 for an unknown agentId', async () => {
    ctx = await setup();
    const { status, body } = await getJSON(ctx.port, '/agents/no-such-agent/risk');
    expect(status).toBe(404);
    const b = body as { error: string };
    expect(b.error).toBeDefined();
  });

  it('2. returns { agentId, totalOps, avgRisk, maxRisk, riskBuckets } shape', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-risk-shape', 'fs'), dec('allow', 0.3));

    const { status, body } = await getJSON(ctx.port, '/agents/agent-risk-shape/risk');
    expect(status).toBe(200);
    const b = body as {
      agentId: string;
      totalOps: number;
      avgRisk: number;
      maxRisk: number;
      riskBuckets: Record<string, number>;
    };
    expect(b.agentId).toBe('agent-risk-shape');
    expect(b).toHaveProperty('totalOps');
    expect(b).toHaveProperty('avgRisk');
    expect(b).toHaveProperty('maxRisk');
    expect(b).toHaveProperty('riskBuckets');
  });

  it('3. riskBuckets has exactly the five expected keys', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-buckets', 'fs'), dec('allow', 0.5));

    const { body } = await getJSON(ctx.port, '/agents/agent-buckets/risk');
    const b = body as { riskBuckets: Record<string, number> };
    const keys = Object.keys(b.riskBuckets).sort();
    expect(keys).toEqual(['0.0-0.2', '0.2-0.4', '0.4-0.6', '0.6-0.8', '0.8-1.0']);
  });

  it('4. ops are correctly bucketed across all five ranges', async () => {
    ctx = await setup();
    // One op per bucket band
    await ctx.logger.log(makeOp('agent-5bkts', 'fs'), dec('allow', 0.1));   // 0.0-0.2
    await ctx.logger.log(makeOp('agent-5bkts', 'fs'), dec('allow', 0.3));   // 0.2-0.4
    await ctx.logger.log(makeOp('agent-5bkts', 'fs'), dec('allow', 0.5));   // 0.4-0.6
    await ctx.logger.log(makeOp('agent-5bkts', 'fs'), dec('allow', 0.7));   // 0.6-0.8
    await ctx.logger.log(makeOp('agent-5bkts', 'shell'), dec('block', 0.9)); // 0.8-1.0

    const { body } = await getJSON(ctx.port, '/agents/agent-5bkts/risk');
    const b = body as { riskBuckets: Record<string, number> };
    expect(b.riskBuckets['0.0-0.2']).toBe(1);
    expect(b.riskBuckets['0.2-0.4']).toBe(1);
    expect(b.riskBuckets['0.4-0.6']).toBe(1);
    expect(b.riskBuckets['0.6-0.8']).toBe(1);
    expect(b.riskBuckets['0.8-1.0']).toBe(1);
  });

  it('5. avgRisk is computed correctly', async () => {
    ctx = await setup();
    // (0.2 + 0.4 + 0.6) / 3 = 0.4
    await ctx.logger.log(makeOp('agent-avg-risk', 'fs'), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-avg-risk', 'db'), dec('allow', 0.4));
    await ctx.logger.log(makeOp('agent-avg-risk', 'shell'), dec('block', 0.6));

    const { body } = await getJSON(ctx.port, '/agents/agent-avg-risk/risk');
    const b = body as { avgRisk: number };
    expect(b.avgRisk).toBeCloseTo(0.4, 5);
  });

  it('6. maxRisk is the highest riskScore among all ops', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-max', 'fs'), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-max', 'shell'), dec('block', 0.95));
    await ctx.logger.log(makeOp('agent-max', 'db'), dec('allow', 0.4));

    const { body } = await getJSON(ctx.port, '/agents/agent-max/risk');
    const b = body as { maxRisk: number };
    expect(b.maxRisk).toBeCloseTo(0.95, 5);
  });

  it('7. totalOps reflects the correct count', async () => {
    ctx = await setup();
    for (let i = 0; i < 5; i++) {
      await ctx.logger.log(makeOp('agent-total', 'fs'), dec('allow', 0.3));
    }

    const { body } = await getJSON(ctx.port, '/agents/agent-total/risk');
    const b = body as { totalOps: number };
    expect(b.totalOps).toBe(5);
  });

  it('8. only includes ops for the requested agent', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-isolated', 'fs'), dec('allow', 0.1));
    // Noise from a different agent with high risk
    await ctx.logger.log(makeOp('agent-noise', 'shell'), dec('block', 0.99));
    await ctx.logger.log(makeOp('agent-noise', 'shell'), dec('block', 0.99));

    const { body } = await getJSON(ctx.port, '/agents/agent-isolated/risk');
    const b = body as { totalOps: number; avgRisk: number; maxRisk: number };
    expect(b.totalOps).toBe(1);
    expect(b.avgRisk).toBeCloseTo(0.1, 5);
    expect(b.maxRisk).toBeCloseTo(0.1, 5);
  });

  it('9. score of exactly 0.8 falls in the 0.8-1.0 bucket', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-boundary', 'shell'), dec('block', 0.8));

    const { body } = await getJSON(ctx.port, '/agents/agent-boundary/risk');
    const b = body as { riskBuckets: Record<string, number> };
    expect(b.riskBuckets['0.8-1.0']).toBe(1);
    expect(b.riskBuckets['0.6-0.8']).toBe(0);
  });

  it('10. multiple ops can accumulate in the same bucket', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-accum', 'fs'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-accum', 'fs'), dec('allow', 0.15));
    await ctx.logger.log(makeOp('agent-accum', 'shell'), dec('block', 0.9));

    const { body } = await getJSON(ctx.port, '/agents/agent-accum/risk');
    const b = body as { riskBuckets: Record<string, number> };
    expect(b.riskBuckets['0.0-0.2']).toBe(2);
    expect(b.riskBuckets['0.8-1.0']).toBe(1);
  });
});
