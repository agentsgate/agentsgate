/**
 * T290 — GET /operations/export?minRisk=X&maxRisk=Y
 * T291 — GET /agents/:agentId/sessions
 * T293 — GET /sessions?agentId=<id>
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { StateStore } from '../../src/modules/m2-store/index.js';
import { DashboardAPI } from '../../src/modules/m10-dashboard/index.js';
import { OperationLogger } from '../../src/modules/m3-logger/index.js';
import type { MCPOperation, ProxyDecision } from '../../src/types/interfaces.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeOp(
  id: string,
  agentId: string,
  sessionId: string,
  overrides: Partial<MCPOperation> = {}
): MCPOperation {
  return {
    id,
    agentId,
    tool: 'fs',
    method: 'read',
    params: {},
    timestamp: new Date(),
    sessionId,
    ...overrides,
  };
}

function dec(
  action: ProxyDecision['action'] = 'allow',
  riskScore = 0.5
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
  const port = (
    (dash as unknown as { server: http.Server }).server.address() as { port: number }
  ).port;
  return { store, logger, dash, port };
}

async function teardown(ctx: Ctx): Promise<void> {
  await ctx.dash.stop();
  await ctx.store.close();
}

async function getJSON(
  port: number,
  path: string
): Promise<{ status: number; body: unknown }> {
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

// Helper: parse CSV into an array of objects keyed by header row
function parseCsvRows(csv: string): Record<string, string>[] {
  const lines = csv.split('\r\n').filter(Boolean);
  if (lines.length < 1) return [];
  const headers = lines[0]!.split(',');
  return lines.slice(1).map(line => {
    const cols = line.split(',');
    return Object.fromEntries(headers.map((h, i) => [h, cols[i] ?? '']));
  });
}

// ── T290 — GET /operations/export?minRisk=X&maxRisk=Y ────────────────────────

describe('GET /operations/export — minRisk / maxRisk filter (T290)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('1. ?minRisk=0.7 — only exports ops with riskScore >= 0.7 (CSV)', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('op-low',  'agent-a', 'sess-1'), dec('allow', 0.2));
    await ctx.logger.log(makeOp('op-mid',  'agent-a', 'sess-1'), dec('allow', 0.5));
    await ctx.logger.log(makeOp('op-high', 'agent-a', 'sess-1'), dec('allow', 0.8));

    const { status, body, contentType } = await getText(ctx.port, '/operations/export?minRisk=0.7');
    expect(status).toBe(200);
    expect(contentType).toContain('text/csv');
    expect(body).toContain('op-high');
    expect(body).not.toContain('op-low');
    expect(body).not.toContain('op-mid');
  });

  it('2. ?maxRisk=0.3 — only exports ops with riskScore <= 0.3 (CSV)', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('op-low',  'agent-a', 'sess-1'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('op-mid',  'agent-a', 'sess-1'), dec('allow', 0.5));
    await ctx.logger.log(makeOp('op-high', 'agent-a', 'sess-1'), dec('block', 0.9));

    const { status, body } = await getText(ctx.port, '/operations/export?maxRisk=0.3');
    expect(status).toBe(200);
    expect(body).toContain('op-low');
    expect(body).not.toContain('op-mid');
    expect(body).not.toContain('op-high');
  });

  it('3. ?minRisk=0.3&maxRisk=0.6 — only exports ops within [0.3, 0.6] (CSV)', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('op-below', 'agent-a', 'sess-1'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('op-in1',   'agent-a', 'sess-1'), dec('allow', 0.3));
    await ctx.logger.log(makeOp('op-in2',   'agent-a', 'sess-1'), dec('allow', 0.5));
    await ctx.logger.log(makeOp('op-in3',   'agent-a', 'sess-1'), dec('allow', 0.6));
    await ctx.logger.log(makeOp('op-above', 'agent-a', 'sess-1'), dec('block', 0.9));

    const { status, body } = await getText(ctx.port, '/operations/export?minRisk=0.3&maxRisk=0.6');
    expect(status).toBe(200);
    expect(body).toContain('op-in1');
    expect(body).toContain('op-in2');
    expect(body).toContain('op-in3');
    expect(body).not.toContain('op-below');
    expect(body).not.toContain('op-above');
  });

  it('4. riskScore column values match the filter range — verify parsed CSV values', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('op-r20', 'agent-a', 'sess-1'), dec('allow', 0.2));
    await ctx.logger.log(makeOp('op-r50', 'agent-a', 'sess-1'), dec('allow', 0.5));
    await ctx.logger.log(makeOp('op-r80', 'agent-a', 'sess-1'), dec('block', 0.8));

    const { body } = await getText(ctx.port, '/operations/export?minRisk=0.4&maxRisk=0.9');
    const rows = parseCsvRows(body);
    // Only op-r50 and op-r80 fall in [0.4, 0.9]
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const risk = parseFloat(row['riskScore'] ?? '');
      expect(risk).toBeGreaterThanOrEqual(0.4);
      expect(risk).toBeLessThanOrEqual(0.9);
    }
  });

  it('5. ?minRisk=X&maxRisk=Y combined with ?agentId= — narrows to agent AND range', async () => {
    ctx = await setup();
    // agent-a ops
    await ctx.logger.log(makeOp('op-a-low',  'agent-a', 'sess-1'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('op-a-high', 'agent-a', 'sess-1'), dec('block', 0.9));
    // agent-b ops that fall in range — should NOT appear because agentId differs
    await ctx.logger.log(makeOp('op-b-high', 'agent-b', 'sess-2'), dec('block', 0.9));

    const { status, body } = await getText(
      ctx.port,
      '/operations/export?agentId=agent-a&minRisk=0.7'
    );
    expect(status).toBe(200);
    expect(body).toContain('op-a-high');
    expect(body).not.toContain('op-a-low');
    expect(body).not.toContain('op-b-high');
  });

  it('6. ?minRisk= with no matching ops returns only the CSV header row', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('op-low', 'agent-a', 'sess-1'), dec('allow', 0.1));

    const { body } = await getText(ctx.port, '/operations/export?minRisk=0.9');
    const lines = body.split('\r\n').filter(Boolean);
    // only the header row
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('id');
    expect(lines[0]).toContain('riskScore');
  });

  it('7. minRisk boundary — op with exactly minRisk value IS included', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('op-exact', 'agent-a', 'sess-1'), dec('allow', 0.5));
    await ctx.logger.log(makeOp('op-below', 'agent-a', 'sess-1'), dec('allow', 0.49));

    const { body } = await getText(ctx.port, '/operations/export?minRisk=0.5');
    expect(body).toContain('op-exact');
    expect(body).not.toContain('op-below');
  });

  it('8. maxRisk boundary — op with exactly maxRisk value IS included', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('op-exact', 'agent-a', 'sess-1'), dec('allow', 0.5));
    await ctx.logger.log(makeOp('op-above', 'agent-a', 'sess-1'), dec('block', 0.51));

    const { body } = await getText(ctx.port, '/operations/export?maxRisk=0.5');
    expect(body).toContain('op-exact');
    expect(body).not.toContain('op-above');
  });
});

// ── T291 — GET /agents/:agentId/sessions ─────────────────────────────────────

describe('GET /agents/:agentId/sessions (T291)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('1. returns { data, count } shape', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('op-1', 'agent-x', 'sess-x1'), dec());

    const { status, body } = await getJSON(ctx.port, '/agents/agent-x/sessions');
    expect(status).toBe(200);
    const b = body as { data: unknown[]; count: number };
    expect(b).toHaveProperty('data');
    expect(b).toHaveProperty('count');
    expect(Array.isArray(b.data)).toBe(true);
  });

  it('2. each session object has sessionId, agentId, operationCount, blocked fields', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('op-1', 'agent-x', 'sess-x1'), dec('allow', 0.2));
    await ctx.logger.log(makeOp('op-2', 'agent-x', 'sess-x1'), dec('block', 0.9));

    const { body } = await getJSON(ctx.port, '/agents/agent-x/sessions');
    const b = body as { data: Array<Record<string, unknown>>; count: number };
    expect(b.count).toBe(1);
    const session = b.data[0]!;
    expect(session).toHaveProperty('sessionId');
    expect(session).toHaveProperty('agentId');
    expect(session).toHaveProperty('operationCount');
    expect(session).toHaveProperty('blocked');
  });

  it('3. only returns sessions belonging to the specified agentId', async () => {
    ctx = await setup();
    // agent-x has two different sessions
    await ctx.logger.log(makeOp('op-1', 'agent-x', 'sess-x1'), dec());
    await ctx.logger.log(makeOp('op-2', 'agent-x', 'sess-x2'), dec());
    // agent-y has its own session — must NOT appear in agent-x results
    await ctx.logger.log(makeOp('op-3', 'agent-y', 'sess-y1'), dec());

    const { body } = await getJSON(ctx.port, '/agents/agent-x/sessions');
    const b = body as { data: Array<{ sessionId: string; agentId: string }>; count: number };
    expect(b.count).toBe(2);
    const sessionIds = b.data.map(s => s.sessionId);
    expect(sessionIds).toContain('sess-x1');
    expect(sessionIds).toContain('sess-x2');
    expect(sessionIds).not.toContain('sess-y1');
    for (const s of b.data) {
      expect(s.agentId).toBe('agent-x');
    }
  });

  it('4. returns 200 with count=0 (not 404) when agent has no operations', async () => {
    ctx = await setup();
    // no operations at all

    const { status, body } = await getJSON(ctx.port, '/agents/nonexistent-agent/sessions');
    expect(status).toBe(200);
    const b = body as { data: unknown[]; count: number };
    expect(b.count).toBe(0);
    expect(b.data).toHaveLength(0);
  });

  it('5. operationCount reflects total ops in that session', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('op-1', 'agent-x', 'sess-x1'), dec());
    await ctx.logger.log(makeOp('op-2', 'agent-x', 'sess-x1'), dec());
    await ctx.logger.log(makeOp('op-3', 'agent-x', 'sess-x1'), dec());

    const { body } = await getJSON(ctx.port, '/agents/agent-x/sessions');
    const b = body as { data: Array<{ sessionId: string; operationCount: number }>; count: number };
    expect(b.count).toBe(1);
    const session = b.data.find(s => s.sessionId === 'sess-x1')!;
    expect(session).toBeDefined();
    expect(session.operationCount).toBe(3);
  });

  it('6. blocked count reflects the number of blocked ops in that session', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('op-1', 'agent-x', 'sess-x1'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('op-2', 'agent-x', 'sess-x1'), dec('block', 0.9));
    await ctx.logger.log(makeOp('op-3', 'agent-x', 'sess-x1'), dec('block', 0.95));

    const { body } = await getJSON(ctx.port, '/agents/agent-x/sessions');
    const b = body as { data: Array<{ sessionId: string; blocked: number }>; count: number };
    const session = b.data.find(s => s.sessionId === 'sess-x1')!;
    expect(session).toBeDefined();
    expect(session.blocked).toBe(2);
  });

  it('7. multiple sessions are all returned for the same agent', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('op-1', 'agent-x', 'sess-a'), dec());
    await ctx.logger.log(makeOp('op-2', 'agent-x', 'sess-b'), dec());
    await ctx.logger.log(makeOp('op-3', 'agent-x', 'sess-c'), dec());

    const { body } = await getJSON(ctx.port, '/agents/agent-x/sessions');
    const b = body as { data: Array<{ sessionId: string }>; count: number };
    expect(b.count).toBe(3);
    const sessionIds = b.data.map(s => s.sessionId);
    expect(sessionIds).toContain('sess-a');
    expect(sessionIds).toContain('sess-b');
    expect(sessionIds).toContain('sess-c');
  });

  it('8. agentId on each returned session matches the requested agentId', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('op-1', 'agent-z', 'sess-z1'), dec());
    await ctx.logger.log(makeOp('op-2', 'agent-z', 'sess-z2'), dec());

    const { body } = await getJSON(ctx.port, '/agents/agent-z/sessions');
    const b = body as { data: Array<{ agentId: string }>; count: number };
    for (const s of b.data) {
      expect(s.agentId).toBe('agent-z');
    }
  });
});

// ── T293 — GET /sessions?agentId=<id> ────────────────────────────────────────

describe('GET /sessions?agentId=<id> (T293)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('1. returns only sessions belonging to the specified agentId', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('op-1', 'agent-p', 'sess-p1'), dec());
    await ctx.logger.log(makeOp('op-2', 'agent-p', 'sess-p2'), dec());
    await ctx.logger.log(makeOp('op-3', 'agent-q', 'sess-q1'), dec());

    const { status, body } = await getJSON(ctx.port, '/sessions?agentId=agent-p');
    expect(status).toBe(200);
    const b = body as { data: Array<{ sessionId: string; agentId: string }>; count: number };
    expect(b.count).toBe(2);
    const sessionIds = b.data.map(s => s.sessionId);
    expect(sessionIds).toContain('sess-p1');
    expect(sessionIds).toContain('sess-p2');
    expect(sessionIds).not.toContain('sess-q1');
  });

  it('2. returns { data, count } shape with session objects', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('op-1', 'agent-p', 'sess-p1'), dec());

    const { status, body } = await getJSON(ctx.port, '/sessions?agentId=agent-p');
    expect(status).toBe(200);
    const b = body as { data: unknown[]; count: number };
    expect(b).toHaveProperty('data');
    expect(b).toHaveProperty('count');
    expect(Array.isArray(b.data)).toBe(true);
    expect(b.count).toBe(1);
  });

  it('3. each session object includes sessionId, agentId, operationCount, blocked', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('op-1', 'agent-p', 'sess-p1'), dec('block', 0.8));
    await ctx.logger.log(makeOp('op-2', 'agent-p', 'sess-p1'), dec('allow', 0.2));

    const { body } = await getJSON(ctx.port, '/sessions?agentId=agent-p');
    const b = body as { data: Array<Record<string, unknown>>; count: number };
    const session = b.data[0]!;
    expect(session).toHaveProperty('sessionId', 'sess-p1');
    expect(session).toHaveProperty('agentId', 'agent-p');
    expect(session).toHaveProperty('operationCount', 2);
    expect(session).toHaveProperty('blocked', 1);
  });

  it('4. returns 200 with count=0 when the agent has no sessions', async () => {
    ctx = await setup();
    // no ops at all

    const { status, body } = await getJSON(ctx.port, '/sessions?agentId=no-such-agent');
    expect(status).toBe(200);
    const b = body as { data: unknown[]; count: number };
    expect(b.count).toBe(0);
    expect(b.data).toHaveLength(0);
  });

  it('5. without ?agentId= filter returns all sessions across agents', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('op-1', 'agent-p', 'sess-p1'), dec());
    await ctx.logger.log(makeOp('op-2', 'agent-q', 'sess-q1'), dec());

    const { status, body } = await getJSON(ctx.port, '/sessions');
    expect(status).toBe(200);
    const b = body as { data: Array<{ sessionId: string }>; count: number };
    expect(b.count).toBe(2);
    const sessionIds = b.data.map(s => s.sessionId);
    expect(sessionIds).toContain('sess-p1');
    expect(sessionIds).toContain('sess-q1');
  });

  it('6. results from GET /sessions?agentId=X match GET /agents/X/sessions (T291 alias parity)', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('op-1', 'agent-x', 'sess-x1'), dec('allow', 0.3));
    await ctx.logger.log(makeOp('op-2', 'agent-x', 'sess-x2'), dec('block', 0.7));
    await ctx.logger.log(makeOp('op-3', 'agent-y', 'sess-y1'), dec());

    const [viaFilter, viaAlias] = await Promise.all([
      getJSON(ctx.port, '/sessions?agentId=agent-x'),
      getJSON(ctx.port, '/agents/agent-x/sessions'),
    ]);

    expect(viaFilter.status).toBe(200);
    expect(viaAlias.status).toBe(200);

    const fData = (viaFilter.body as { data: Array<{ sessionId: string }>; count: number });
    const aData = (viaAlias.body as { data: Array<{ sessionId: string }>; count: number });

    expect(fData.count).toBe(aData.count);
    const fIds = fData.data.map(s => s.sessionId).sort();
    const aIds = aData.data.map(s => s.sessionId).sort();
    expect(fIds).toEqual(aIds);
  });

  it('7. sessions are isolated — different agentId filters return non-overlapping sets', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('op-1', 'agent-p', 'sess-p1'), dec());
    await ctx.logger.log(makeOp('op-2', 'agent-q', 'sess-q1'), dec());

    const [rP, rQ] = await Promise.all([
      getJSON(ctx.port, '/sessions?agentId=agent-p'),
      getJSON(ctx.port, '/sessions?agentId=agent-q'),
    ]);

    const pIds = (rP.body as { data: Array<{ sessionId: string }> }).data.map(s => s.sessionId);
    const qIds = (rQ.body as { data: Array<{ sessionId: string }> }).data.map(s => s.sessionId);

    expect(pIds).toContain('sess-p1');
    expect(pIds).not.toContain('sess-q1');
    expect(qIds).toContain('sess-q1');
    expect(qIds).not.toContain('sess-p1');
  });
});
