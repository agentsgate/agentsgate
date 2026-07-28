/**
 * T300 — GET /operations/export?sort=riskScore&order=asc/desc
 * T301 — GET /agents?limit=N&offset=M
 * T302 — GET /tools?limit=N&offset=M
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

// ── T301 — GET /agents?limit=N&offset=M ──────────────────────────────────────

describe('GET /agents pagination (T301)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('1. empty DB returns { agents: [], count: 0, limit, offset }', async () => {
    ctx = await setup();
    const { status, body } = await getJSON(ctx.port, '/agents?limit=10&offset=0');
    expect(status).toBe(200);
    const b = body as { agents: unknown[]; count: number; limit: number; offset: number };
    expect(b.agents).toEqual([]);
    expect(b.count).toBe(0);
    expect(b.limit).toBe(10);
    expect(b.offset).toBe(0);
  });

  it('2. response shape includes agents, count, limit, offset', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'fs'), dec('allow', 0.3));

    const { status, body } = await getJSON(ctx.port, '/agents?limit=5&offset=0');
    expect(status).toBe(200);
    const b = body as { agents: unknown[]; count: number; limit: number; offset: number };
    expect(b).toHaveProperty('agents');
    expect(b).toHaveProperty('count');
    expect(b).toHaveProperty('limit');
    expect(b).toHaveProperty('offset');
    expect(b.limit).toBe(5);
    expect(b.offset).toBe(0);
  });

  it('3. count reflects total agents, not just the current page', async () => {
    ctx = await setup();
    // Insert 5 agents, each with 1 op
    for (let i = 1; i <= 5; i++) {
      await ctx.logger.log(makeOp(`agent-${i}`, 'fs'), dec('allow', 0.1));
    }

    // Request only 2 per page
    const { body } = await getJSON(ctx.port, '/agents?limit=2&offset=0');
    const b = body as { agents: unknown[]; count: number; limit: number; offset: number };
    // count = total (5), not page size (2)
    expect(b.count).toBe(5);
    expect(b.agents.length).toBeLessThanOrEqual(2);
  });

  it('4. agents.length is <= limit', async () => {
    ctx = await setup();
    for (let i = 1; i <= 10; i++) {
      await ctx.logger.log(makeOp(`agt-${i}`, 'fs'), dec('allow', 0.1));
    }

    const { body } = await getJSON(ctx.port, '/agents?limit=3&offset=0');
    const b = body as { agents: unknown[] };
    expect(b.agents.length).toBeLessThanOrEqual(3);
    expect(b.agents.length).toBe(3);
  });

  it('5. offset skips agents correctly (page 2 returns next slice)', async () => {
    ctx = await setup();
    // 4 agents, sorted descending by totalOps — give each a unique op count
    await ctx.logger.log(makeOp('agt-w', 'fs'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agt-w', 'fs'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agt-w', 'fs'), dec('allow', 0.1)); // 3 ops
    await ctx.logger.log(makeOp('agt-x', 'fs'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agt-x', 'fs'), dec('allow', 0.1)); // 2 ops
    await ctx.logger.log(makeOp('agt-y', 'fs'), dec('allow', 0.1)); // 1 op
    await ctx.logger.log(makeOp('agt-z', 'shell'), dec('allow', 0.1)); // 1 op (different tool)

    // Page 1: limit=2, offset=0 → top 2 agents
    const page1 = (await getJSON(ctx.port, '/agents?limit=2&offset=0')).body as {
      agents: Array<{ agentId: string }>; count: number;
    };
    expect(page1.count).toBe(4);
    expect(page1.agents).toHaveLength(2);
    expect(page1.agents[0].agentId).toBe('agt-w'); // most ops

    // Page 2: limit=2, offset=2 → next 2 agents
    const page2 = (await getJSON(ctx.port, '/agents?limit=2&offset=2')).body as {
      agents: Array<{ agentId: string }>; count: number;
    };
    expect(page2.count).toBe(4);
    expect(page2.agents).toHaveLength(2);
    // agt-w and agt-x should NOT appear in page 2
    const page2Ids = page2.agents.map(a => a.agentId);
    expect(page2Ids).not.toContain('agt-w');
    expect(page2Ids).not.toContain('agt-x');
  });

  it('6. offset beyond total agent count returns empty agents array', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('only-agent', 'fs'), dec('allow', 0.2));

    const { body } = await getJSON(ctx.port, '/agents?limit=10&offset=999');
    const b = body as { agents: unknown[]; count: number };
    expect(b.count).toBe(1);
    expect(b.agents).toHaveLength(0);
  });

  it('7. no limit/offset params returns default page with all agents', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'fs'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-b', 'fs'), dec('allow', 0.2));

    const { status, body } = await getJSON(ctx.port, '/agents');
    expect(status).toBe(200);
    const b = body as { agents: unknown[]; count: number };
    expect(b.count).toBe(2);
    expect(b.agents.length).toBe(2);
  });

  it('8. page 1 and page 2 together contain all agents with no overlap', async () => {
    ctx = await setup();
    for (let i = 1; i <= 6; i++) {
      await ctx.logger.log(makeOp(`agt-${i}`, 'fs'), dec('allow', 0.1 * i));
    }

    const page1 = (await getJSON(ctx.port, '/agents?limit=3&offset=0')).body as {
      agents: Array<{ agentId: string }>;
    };
    const page2 = (await getJSON(ctx.port, '/agents?limit=3&offset=3')).body as {
      agents: Array<{ agentId: string }>;
    };

    const ids1 = new Set(page1.agents.map(a => a.agentId));
    const ids2 = new Set(page2.agents.map(a => a.agentId));
    // No overlap
    for (const id of ids2) {
      expect(ids1.has(id)).toBe(false);
    }
    // Together cover all 6 agents
    expect(ids1.size + ids2.size).toBe(6);
  });
});

// ── T302 — GET /tools?limit=N&offset=M ───────────────────────────────────────

describe('GET /tools pagination (T302)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('1. empty DB returns { tools: [], count: 0, limit, offset }', async () => {
    ctx = await setup();
    const { status, body } = await getJSON(ctx.port, '/tools?limit=10&offset=0');
    expect(status).toBe(200);
    const b = body as { tools: unknown[]; count: number; limit: number; offset: number };
    expect(b.tools).toEqual([]);
    expect(b.count).toBe(0);
    expect(b.limit).toBe(10);
    expect(b.offset).toBe(0);
  });

  it('2. response shape includes tools, count, limit, offset', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'fs'), dec('allow', 0.3));

    const { status, body } = await getJSON(ctx.port, '/tools?limit=5&offset=0');
    expect(status).toBe(200);
    const b = body as { tools: unknown[]; count: number; limit: number; offset: number };
    expect(b).toHaveProperty('tools');
    expect(b).toHaveProperty('count');
    expect(b).toHaveProperty('limit');
    expect(b).toHaveProperty('offset');
    expect(b.limit).toBe(5);
    expect(b.offset).toBe(0);
  });

  it('3. count reflects total tools, not just the current page', async () => {
    ctx = await setup();
    // 5 distinct tools
    for (let i = 1; i <= 5; i++) {
      await ctx.logger.log(makeOp('agent-a', `tool-${i}`), dec('allow', 0.1));
    }

    const { body } = await getJSON(ctx.port, '/tools?limit=2&offset=0');
    const b = body as { tools: unknown[]; count: number };
    expect(b.count).toBe(5);
    expect(b.tools.length).toBeLessThanOrEqual(2);
  });

  it('4. tools.length is <= limit', async () => {
    ctx = await setup();
    for (let i = 1; i <= 10; i++) {
      await ctx.logger.log(makeOp('agent-a', `tool-${i}`), dec('allow', 0.1));
    }

    const { body } = await getJSON(ctx.port, '/tools?limit=4&offset=0');
    const b = body as { tools: unknown[] };
    expect(b.tools.length).toBeLessThanOrEqual(4);
    expect(b.tools.length).toBe(4);
  });

  it('5. offset skips tools correctly (page 2 returns next slice)', async () => {
    ctx = await setup();
    // Insert tools with distinct op counts so sort order is deterministic
    // tool-alpha: 3 ops, tool-beta: 2 ops, tool-gamma: 1 op, tool-delta: 1 op
    await ctx.logger.log(makeOp('a', 'tool-alpha'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('a', 'tool-alpha'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('a', 'tool-alpha'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('a', 'tool-beta'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('a', 'tool-beta'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('a', 'tool-gamma'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('a', 'tool-delta'), dec('allow', 0.1));

    const page1 = (await getJSON(ctx.port, '/tools?limit=2&offset=0')).body as {
      tools: Array<{ tool: string }>; count: number;
    };
    expect(page1.count).toBe(4);
    expect(page1.tools).toHaveLength(2);
    expect(page1.tools[0].tool).toBe('tool-alpha'); // most ops

    const page2 = (await getJSON(ctx.port, '/tools?limit=2&offset=2')).body as {
      tools: Array<{ tool: string }>; count: number;
    };
    expect(page2.count).toBe(4);
    expect(page2.tools).toHaveLength(2);

    const page2Names = page2.tools.map(t => t.tool);
    expect(page2Names).not.toContain('tool-alpha');
    expect(page2Names).not.toContain('tool-beta');
  });

  it('6. offset beyond total tool count returns empty tools array', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('a', 'only-tool'), dec('allow', 0.2));

    const { body } = await getJSON(ctx.port, '/tools?limit=10&offset=999');
    const b = body as { tools: unknown[]; count: number };
    expect(b.count).toBe(1);
    expect(b.tools).toHaveLength(0);
  });

  it('7. no limit/offset params returns default page with all tools', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('a', 'tool-x'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('a', 'tool-y'), dec('allow', 0.2));

    const { status, body } = await getJSON(ctx.port, '/tools');
    expect(status).toBe(200);
    const b = body as { tools: unknown[]; count: number };
    expect(b.count).toBe(2);
    expect(b.tools.length).toBe(2);
  });

  it('8. page 1 and page 2 together contain all tools with no overlap', async () => {
    ctx = await setup();
    for (let i = 1; i <= 6; i++) {
      await ctx.logger.log(makeOp('agent-a', `tool-${i}`), dec('allow', 0.1 * i));
    }

    const page1 = (await getJSON(ctx.port, '/tools?limit=3&offset=0')).body as {
      tools: Array<{ tool: string }>;
    };
    const page2 = (await getJSON(ctx.port, '/tools?limit=3&offset=3')).body as {
      tools: Array<{ tool: string }>;
    };

    const names1 = new Set(page1.tools.map(t => t.tool));
    const names2 = new Set(page2.tools.map(t => t.tool));
    for (const name of names2) {
      expect(names1.has(name)).toBe(false);
    }
    expect(names1.size + names2.size).toBe(6);
  });
});

// ── T300 — GET /operations/export?sort=riskScore&order=asc/desc ──────────────

describe('GET /operations/export sort (T300)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('1. sort=riskScore&order=asc returns CSV rows sorted by riskScore ascending', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('a', 'fs', { id: 'op-high' }),   dec('allow', 0.9));
    await ctx.logger.log(makeOp('a', 'db', { id: 'op-low' }),    dec('allow', 0.1));
    await ctx.logger.log(makeOp('a', 'net', { id: 'op-medium' }), dec('allow', 0.5));

    const { status, body } = await getText(ctx.port, '/operations/export?sort=riskScore&order=asc');
    expect(status).toBe(200);

    const rows = parseCSV(body);
    expect(rows.length).toBe(3);
    const scores = rows.map(r => parseFloat(r['riskScore']));
    // Ascending: each score must be >= the previous
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeGreaterThanOrEqual(scores[i - 1]);
    }
    // First row should be the lowest risk score
    expect(scores[0]).toBeCloseTo(0.1, 5);
    expect(scores[scores.length - 1]).toBeCloseTo(0.9, 5);
  });

  it('2. sort=riskScore&order=desc returns CSV rows sorted by riskScore descending', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('a', 'fs', { id: 'op-high' }),   dec('allow', 0.9));
    await ctx.logger.log(makeOp('a', 'db', { id: 'op-low' }),    dec('allow', 0.1));
    await ctx.logger.log(makeOp('a', 'net', { id: 'op-medium' }), dec('allow', 0.5));

    const { status, body } = await getText(ctx.port, '/operations/export?sort=riskScore&order=desc');
    expect(status).toBe(200);

    const rows = parseCSV(body);
    expect(rows.length).toBe(3);
    const scores = rows.map(r => parseFloat(r['riskScore']));
    // Descending: each score must be <= the previous
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeLessThanOrEqual(scores[i - 1]);
    }
    expect(scores[0]).toBeCloseTo(0.9, 5);
    expect(scores[scores.length - 1]).toBeCloseTo(0.1, 5);
  });

  it('3. sort=riskScore with no order defaults to descending', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('a', 'fs', { id: 'op-low' }),  dec('allow', 0.2));
    await ctx.logger.log(makeOp('a', 'db', { id: 'op-high' }), dec('allow', 0.8));

    const { body } = await getText(ctx.port, '/operations/export?sort=riskScore');

    const rows = parseCSV(body);
    expect(rows.length).toBe(2);
    const scores = rows.map(r => parseFloat(r['riskScore']));
    // Default is desc → highest first
    expect(scores[0]).toBeCloseTo(0.8, 5);
    expect(scores[1]).toBeCloseTo(0.2, 5);
  });

  it('4. sort=timestamp&order=asc returns rows sorted by timestamp ascending', async () => {
    ctx = await setup();
    const t1 = new Date('2024-01-01T10:00:00Z');
    const t2 = new Date('2024-01-01T11:00:00Z');
    const t3 = new Date('2024-01-01T12:00:00Z');

    // Insert in reverse order so the store's default descending order differs
    await ctx.logger.log(makeOp('a', 'net', { id: 'op-latest',   timestamp: t3 }), dec('allow', 0.5));
    await ctx.logger.log(makeOp('a', 'db',  { id: 'op-middle',   timestamp: t2 }), dec('allow', 0.5));
    await ctx.logger.log(makeOp('a', 'fs',  { id: 'op-earliest', timestamp: t1 }), dec('allow', 0.5));

    const { status, body } = await getText(ctx.port, '/operations/export?sort=timestamp&order=asc');
    expect(status).toBe(200);

    const rows = parseCSV(body);
    expect(rows.length).toBe(3);
    const timestamps = rows.map(r => new Date(r['timestamp']).getTime());
    // Ascending: each timestamp must be >= the previous
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i]).toBeGreaterThanOrEqual(timestamps[i - 1]);
    }
  });

  it('5. sort=riskScore&order=asc with multiple equal scores produces stable CSV output', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('a', 'fs',  { id: 'op-a' }), dec('allow', 0.5));
    await ctx.logger.log(makeOp('a', 'db',  { id: 'op-b' }), dec('allow', 0.5));
    await ctx.logger.log(makeOp('a', 'net', { id: 'op-c' }), dec('block', 0.9));

    const { body } = await getText(ctx.port, '/operations/export?sort=riskScore&order=asc');
    const rows = parseCSV(body);
    expect(rows.length).toBe(3);
    const scores = rows.map(r => parseFloat(r['riskScore']));
    // First two are 0.5, last is 0.9
    expect(scores[0]).toBeCloseTo(0.5, 5);
    expect(scores[1]).toBeCloseTo(0.5, 5);
    expect(scores[2]).toBeCloseTo(0.9, 5);
  });

  it('6. export with no sort param returns CSV (default ordering) without error', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('a', 'fs'), dec('allow', 0.3));
    await ctx.logger.log(makeOp('a', 'db'), dec('block', 0.7));

    const { status, body } = await getText(ctx.port, '/operations/export');
    expect(status).toBe(200);
    const rows = parseCSV(body);
    expect(rows.length).toBe(2);
  });

  it('7. sort=riskScore&order=asc correctly orders high-risk blocked ops last', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('a', 'shell', { id: 'op-blocked-high' }), dec('block', 0.95));
    await ctx.logger.log(makeOp('a', 'fs',    { id: 'op-allowed-low' }),  dec('allow', 0.05));
    await ctx.logger.log(makeOp('a', 'db',    { id: 'op-allowed-mid' }),  dec('allow', 0.45));

    const { body } = await getText(ctx.port, '/operations/export?sort=riskScore&order=asc');
    const rows = parseCSV(body);
    expect(rows.length).toBe(3);
    // First row = lowest risk, last row = highest risk
    expect(rows[0]['id']).toBe('op-allowed-low');
    expect(rows[rows.length - 1]['id']).toBe('op-blocked-high');
  });

  it('8. sort=riskScore&order=desc correctly orders high-risk blocked ops first', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('a', 'shell', { id: 'op-blocked-high' }), dec('block', 0.95));
    await ctx.logger.log(makeOp('a', 'fs',    { id: 'op-allowed-low' }),  dec('allow', 0.05));
    await ctx.logger.log(makeOp('a', 'db',    { id: 'op-allowed-mid' }),  dec('allow', 0.45));

    const { body } = await getText(ctx.port, '/operations/export?sort=riskScore&order=desc');
    const rows = parseCSV(body);
    expect(rows.length).toBe(3);
    expect(rows[0]['id']).toBe('op-blocked-high');
    expect(rows[rows.length - 1]['id']).toBe('op-allowed-low');
  });
});
