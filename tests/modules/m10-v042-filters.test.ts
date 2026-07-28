/**
 * v0.42 filter tests
 *
 * T325 — GET /agents?minOps=N&maxOps=M: filter agents by totalOps range
 * T326 — GET /tools?minOps=N: filter tools by totalOps minimum
 * T327 — GET /risk?sort=riskScore&order=asc/desc: risk list sorted by riskScore
 * Fix  — GET /operations/export?sort=timestamp&order=asc: CSV timestamp column sorted ascending
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

async function getText(port: number, path: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, body: await res.text() };
}

/** Parse CSV body into an array of objects keyed by header row. */
function parseCSV(body: string): Record<string, string>[] {
  const lines = body.split('\r\n').filter(Boolean);
  if (lines.length < 1) return [];
  const headers = lines[0].split(',');
  return lines.slice(1).map(line => {
    const cols = line.split(',');
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = cols[i] ?? ''; });
    return row;
  });
}

// ── T325 — GET /agents?minOps=N ───────────────────────────────────────────────

describe('GET /agents?minOps=N (T325)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('1. minOps filters out agents with totalOps below the threshold', async () => {
    ctx = await setup();
    // agent-high: 5 ops, agent-low: 1 op
    for (let i = 0; i < 5; i++) await ctx.logger.log(makeOp('agent-high', 'fs'), dec());
    await ctx.logger.log(makeOp('agent-low', 'fs'), dec());

    const { status, body } = await getJSON(ctx.port, '/agents?minOps=3');
    expect(status).toBe(200);
    const b = body as { agents: Array<{ agentId: string; totalOps: number }>; count: number };
    expect(b.agents.every(a => a.totalOps >= 3)).toBe(true);
    const ids = b.agents.map(a => a.agentId);
    expect(ids).toContain('agent-high');
    expect(ids).not.toContain('agent-low');
  });

  it('2. minOps=1 returns all agents (no agent has 0 ops)', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'fs'), dec());
    await ctx.logger.log(makeOp('agent-b', 'fs'), dec());

    const { body } = await getJSON(ctx.port, '/agents?minOps=1');
    const b = body as { agents: Array<{ agentId: string }>; count: number };
    expect(b.count).toBe(2);
    expect(b.agents).toHaveLength(2);
  });

  it('3. minOps higher than any agent totalOps returns empty agents array', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'fs'), dec());
    await ctx.logger.log(makeOp('agent-b', 'fs'), dec());

    const { body } = await getJSON(ctx.port, '/agents?minOps=999');
    const b = body as { agents: Array<unknown>; count: number };
    expect(b.agents).toHaveLength(0);
    expect(b.count).toBe(0);
  });

  it('4. minOps=exact match includes agents with exactly that many ops', async () => {
    ctx = await setup();
    // agent-exact: exactly 3 ops
    for (let i = 0; i < 3; i++) await ctx.logger.log(makeOp('agent-exact', 'fs'), dec());
    // agent-under: 2 ops
    for (let i = 0; i < 2; i++) await ctx.logger.log(makeOp('agent-under', 'fs'), dec());

    const { body } = await getJSON(ctx.port, '/agents?minOps=3');
    const b = body as { agents: Array<{ agentId: string; totalOps: number }>; count: number };
    expect(b.agents.some(a => a.agentId === 'agent-exact')).toBe(true);
    expect(b.agents.every(a => a.totalOps >= 3)).toBe(true);
  });
});

// ── T325 — GET /agents?maxOps=N ───────────────────────────────────────────────

describe('GET /agents?maxOps=N (T325)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('5. maxOps filters out agents with totalOps above the threshold', async () => {
    ctx = await setup();
    // agent-high: 5 ops, agent-low: 1 op
    for (let i = 0; i < 5; i++) await ctx.logger.log(makeOp('agent-high', 'fs'), dec());
    await ctx.logger.log(makeOp('agent-low', 'fs'), dec());

    const { status, body } = await getJSON(ctx.port, '/agents?maxOps=2');
    expect(status).toBe(200);
    const b = body as { agents: Array<{ agentId: string; totalOps: number }>; count: number };
    expect(b.agents.every(a => a.totalOps <= 2)).toBe(true);
    const ids = b.agents.map(a => a.agentId);
    expect(ids).toContain('agent-low');
    expect(ids).not.toContain('agent-high');
  });

  it('6. maxOps=exact match includes agents with exactly that many ops', async () => {
    ctx = await setup();
    // agent-exact: exactly 3 ops
    for (let i = 0; i < 3; i++) await ctx.logger.log(makeOp('agent-exact', 'fs'), dec());
    // agent-over: 4 ops
    for (let i = 0; i < 4; i++) await ctx.logger.log(makeOp('agent-over', 'fs'), dec());

    const { body } = await getJSON(ctx.port, '/agents?maxOps=3');
    const b = body as { agents: Array<{ agentId: string; totalOps: number }>; count: number };
    expect(b.agents.some(a => a.agentId === 'agent-exact')).toBe(true);
    expect(b.agents.every(a => a.totalOps <= 3)).toBe(true);
  });

  it('7. maxOps lower than all agents totalOps returns empty agents array', async () => {
    ctx = await setup();
    for (let i = 0; i < 5; i++) await ctx.logger.log(makeOp('agent-a', 'fs'), dec());
    for (let i = 0; i < 3; i++) await ctx.logger.log(makeOp('agent-b', 'fs'), dec());

    const { body } = await getJSON(ctx.port, '/agents?maxOps=0');
    const b = body as { agents: Array<unknown>; count: number };
    expect(b.agents).toHaveLength(0);
    expect(b.count).toBe(0);
  });

  it('8. minOps and maxOps together define a range', async () => {
    ctx = await setup();
    // agent-low: 1 op, agent-mid: 3 ops, agent-high: 7 ops
    await ctx.logger.log(makeOp('agent-low', 'fs'), dec());
    for (let i = 0; i < 3; i++) await ctx.logger.log(makeOp('agent-mid', 'fs'), dec());
    for (let i = 0; i < 7; i++) await ctx.logger.log(makeOp('agent-high', 'fs'), dec());

    const { body } = await getJSON(ctx.port, '/agents?minOps=2&maxOps=5');
    const b = body as { agents: Array<{ agentId: string; totalOps: number }>; count: number };
    expect(b.agents.every(a => a.totalOps >= 2 && a.totalOps <= 5)).toBe(true);
    const ids = b.agents.map(a => a.agentId);
    expect(ids).toContain('agent-mid');
    expect(ids).not.toContain('agent-low');
    expect(ids).not.toContain('agent-high');
  });
});

// ── T326 — GET /tools?minOps=N ────────────────────────────────────────────────

describe('GET /tools?minOps=N (T326)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('9. minOps filters out tools with totalOps below the threshold', async () => {
    ctx = await setup();
    // tool-heavy: 4 uses, tool-rare: 1 use
    for (let i = 0; i < 4; i++) await ctx.logger.log(makeOp('agent-a', 'tool-heavy'), dec());
    await ctx.logger.log(makeOp('agent-a', 'tool-rare'), dec());

    const { status, body } = await getJSON(ctx.port, '/tools?minOps=3');
    expect(status).toBe(200);
    const b = body as { tools: Array<{ tool: string; totalOps: number }>; count: number };
    expect(b.tools.every(t => t.totalOps >= 3)).toBe(true);
    const names = b.tools.map(t => t.tool);
    expect(names).toContain('tool-heavy');
    expect(names).not.toContain('tool-rare');
  });

  it('10. minOps=1 returns all tools', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'tool-x'), dec());
    await ctx.logger.log(makeOp('agent-a', 'tool-y'), dec());
    await ctx.logger.log(makeOp('agent-a', 'tool-z'), dec());

    const { body } = await getJSON(ctx.port, '/tools?minOps=1');
    const b = body as { tools: Array<{ tool: string }>; count: number };
    expect(b.count).toBe(3);
    expect(b.tools).toHaveLength(3);
  });

  it('11. minOps higher than any tool totalOps returns empty tools array', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'tool-a'), dec());
    await ctx.logger.log(makeOp('agent-a', 'tool-b'), dec());

    const { body } = await getJSON(ctx.port, '/tools?minOps=999');
    const b = body as { tools: Array<unknown>; count: number };
    expect(b.tools).toHaveLength(0);
    expect(b.count).toBe(0);
  });

  it('12. minOps=exact match includes tools with exactly that many ops', async () => {
    ctx = await setup();
    // tool-exact: 2 uses, tool-under: 1 use
    for (let i = 0; i < 2; i++) await ctx.logger.log(makeOp('agent-a', 'tool-exact'), dec());
    await ctx.logger.log(makeOp('agent-a', 'tool-under'), dec());

    const { body } = await getJSON(ctx.port, '/tools?minOps=2');
    const b = body as { tools: Array<{ tool: string; totalOps: number }>; count: number };
    expect(b.tools.some(t => t.tool === 'tool-exact')).toBe(true);
    expect(b.tools.every(t => t.totalOps >= 2)).toBe(true);
    const names = b.tools.map(t => t.tool);
    expect(names).not.toContain('tool-under');
  });

  it('13. minOps with no matching tools still returns 200 with empty tools array', async () => {
    ctx = await setup();
    // empty DB
    const { status, body } = await getJSON(ctx.port, '/tools?minOps=5');
    expect(status).toBe(200);
    const b = body as { tools: Array<unknown>; count: number };
    expect(b.tools).toHaveLength(0);
    expect(b.count).toBe(0);
  });
});

// ── T327 — GET /risk?sort=riskScore&order=asc/desc ───────────────────────────

describe('GET /risk?sort=riskScore&order=asc (T327)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('14. order=asc returns logs sorted by riskScore ascending', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('a', 'fs',   { id: 'op-high' }),   dec('allow', 0.9));
    await ctx.logger.log(makeOp('a', 'db',   { id: 'op-low' }),    dec('allow', 0.1));
    await ctx.logger.log(makeOp('a', 'net',  { id: 'op-mid' }),    dec('allow', 0.5));

    const { status, body } = await getJSON(ctx.port, '/risk?sort=riskScore&order=asc');
    expect(status).toBe(200);
    const b = body as { data: Array<{ operationId: string; riskScore: number }>; count: number };
    expect(b.count).toBe(3);

    const scores = b.data.map(e => e.riskScore);
    // Each score must be >= previous (ascending)
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeGreaterThanOrEqual(scores[i - 1]);
    }
    expect(scores[0]).toBeCloseTo(0.1, 5);
    expect(scores[scores.length - 1]).toBeCloseTo(0.9, 5);
  });

  it('15. order=asc puts lowest-risk op first and highest-risk op last', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('a', 'shell', { id: 'op-critical' }), dec('block', 0.95));
    await ctx.logger.log(makeOp('a', 'fs',    { id: 'op-safe' }),     dec('allow', 0.05));
    await ctx.logger.log(makeOp('a', 'db',    { id: 'op-medium' }),   dec('allow', 0.4));

    const { body } = await getJSON(ctx.port, '/risk?sort=riskScore&order=asc');
    const b = body as { data: Array<{ operationId: string; riskScore: number }> };
    expect(b.data[0].operationId).toBe('op-safe');
    expect(b.data[b.data.length - 1].operationId).toBe('op-critical');
  });
});

describe('GET /risk?sort=riskScore&order=desc (T327)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('16. order=desc returns logs sorted by riskScore descending', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('a', 'fs',  { id: 'op-high' }),  dec('allow', 0.9));
    await ctx.logger.log(makeOp('a', 'db',  { id: 'op-low' }),   dec('allow', 0.1));
    await ctx.logger.log(makeOp('a', 'net', { id: 'op-mid' }),   dec('allow', 0.5));

    const { status, body } = await getJSON(ctx.port, '/risk?sort=riskScore&order=desc');
    expect(status).toBe(200);
    const b = body as { data: Array<{ operationId: string; riskScore: number }>; count: number };
    expect(b.count).toBe(3);

    const scores = b.data.map(e => e.riskScore);
    // Each score must be <= previous (descending)
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeLessThanOrEqual(scores[i - 1]);
    }
    expect(scores[0]).toBeCloseTo(0.9, 5);
    expect(scores[scores.length - 1]).toBeCloseTo(0.1, 5);
  });

  it('17. order=desc puts highest-risk op first and lowest-risk op last', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('a', 'shell', { id: 'op-critical' }), dec('block', 0.95));
    await ctx.logger.log(makeOp('a', 'fs',    { id: 'op-safe' }),     dec('allow', 0.05));
    await ctx.logger.log(makeOp('a', 'db',    { id: 'op-medium' }),   dec('allow', 0.4));

    const { body } = await getJSON(ctx.port, '/risk?sort=riskScore&order=desc');
    const b = body as { data: Array<{ operationId: string; riskScore: number }> };
    expect(b.data[0].operationId).toBe('op-critical');
    expect(b.data[b.data.length - 1].operationId).toBe('op-safe');
  });

  it('18. sort=riskScore with equal scores maintains stable order within ties', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('a', 'fs',  { id: 'op-tie-1' }), dec('allow', 0.5));
    await ctx.logger.log(makeOp('a', 'db',  { id: 'op-tie-2' }), dec('allow', 0.5));
    await ctx.logger.log(makeOp('a', 'net', { id: 'op-unique' }), dec('block', 0.9));

    const { body } = await getJSON(ctx.port, '/risk?sort=riskScore&order=desc');
    const b = body as { data: Array<{ riskScore: number }> };
    const scores = b.data.map(e => e.riskScore);
    // Highest first
    expect(scores[0]).toBeCloseTo(0.9, 5);
    // Both remaining entries should be 0.5
    expect(scores[1]).toBeCloseTo(0.5, 5);
    expect(scores[2]).toBeCloseTo(0.5, 5);
  });

  it('19. /risk with no sort param returns 200 without error (default ordering)', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('a', 'fs'), dec('allow', 0.3));
    await ctx.logger.log(makeOp('a', 'db'), dec('block', 0.8));

    const { status, body } = await getJSON(ctx.port, '/risk');
    expect(status).toBe(200);
    const b = body as { data: Array<unknown>; count: number };
    expect(b.count).toBe(2);
    expect(b.data).toHaveLength(2);
  });
});

// ── Fix verification — GET /operations/export?sort=timestamp&order=asc ────────

describe('GET /operations/export?sort=timestamp&order=asc (fix verification)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('20. CSV "timestamp" column is sorted ascending when sort=timestamp&order=asc', async () => {
    ctx = await setup();
    const t1 = new Date('2024-01-01T08:00:00Z');
    const t2 = new Date('2024-01-01T12:00:00Z');
    const t3 = new Date('2024-01-01T18:00:00Z');

    // Insert in descending order so default store ordering would differ
    await ctx.logger.log(makeOp('a', 'net', { id: 'op-latest',   timestamp: t3 }), dec('allow', 0.3));
    await ctx.logger.log(makeOp('a', 'db',  { id: 'op-middle',   timestamp: t2 }), dec('allow', 0.5));
    await ctx.logger.log(makeOp('a', 'fs',  { id: 'op-earliest', timestamp: t1 }), dec('allow', 0.1));

    const { status, body } = await getText(ctx.port, '/operations/export?sort=timestamp&order=asc');
    expect(status).toBe(200);

    const rows = parseCSV(body);
    expect(rows).toHaveLength(3);

    // The "timestamp" column must exist and be sorted ascending
    const timestamps = rows.map(r => new Date(r['timestamp']).getTime());
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i]).toBeGreaterThanOrEqual(timestamps[i - 1]);
    }

    // Exact order: earliest → middle → latest
    expect(timestamps[0]).toBe(t1.getTime());
    expect(timestamps[1]).toBe(t2.getTime());
    expect(timestamps[2]).toBe(t3.getTime());
  });

  it('21. CSV "timestamp" column header exists in the export', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('a', 'fs'), dec());

    const { status, body } = await getText(ctx.port, '/operations/export?sort=timestamp&order=asc');
    expect(status).toBe(200);

    const lines = body.split('\r\n').filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const headers = lines[0].split(',');
    // The header must be "timestamp" (not "createdAt")
    expect(headers).toContain('timestamp');
    expect(headers).not.toContain('createdAt');
  });

  it('22. three ops with distinct timestamps produce exactly ascending order in CSV', async () => {
    ctx = await setup();
    const t1 = new Date('2023-06-01T00:00:00Z');
    const t2 = new Date('2023-07-01T00:00:00Z');
    const t3 = new Date('2023-08-01T00:00:00Z');

    // Insert newest first to ensure sort is actually applied
    await ctx.logger.log(makeOp('a', 'shell', { id: 'op-aug', timestamp: t3 }), dec('block', 0.9));
    await ctx.logger.log(makeOp('a', 'fs',    { id: 'op-jun', timestamp: t1 }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('a', 'db',    { id: 'op-jul', timestamp: t2 }), dec('allow', 0.4));

    const { body } = await getText(ctx.port, '/operations/export?sort=timestamp&order=asc');
    const rows = parseCSV(body);
    expect(rows).toHaveLength(3);

    // Verify "id" column order is: jun, jul, aug
    expect(rows[0]['id']).toBe('op-jun');
    expect(rows[1]['id']).toBe('op-jul');
    expect(rows[2]['id']).toBe('op-aug');

    // Verify timestamps are ascending
    const timestamps = rows.map(r => new Date(r['timestamp']).getTime());
    expect(timestamps[0]).toBeLessThan(timestamps[1]);
    expect(timestamps[1]).toBeLessThan(timestamps[2]);
  });
});
