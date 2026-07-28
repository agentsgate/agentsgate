/**
 * T310 — GET /agents?q=<term>
 * T311 — GET /tools?q=<term>
 * T312 — GET /sessions/:id includes maxRisk
 * T313 — GET /sessions?q=<term>
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
  sessionId = 'sess-default',
  overrides: Partial<MCPOperation> = {}
): MCPOperation {
  return {
    id: crypto.randomUUID(),
    agentId,
    tool,
    method: 'call',
    params: {},
    timestamp: new Date(),
    sessionId,
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

// ── T310 — GET /agents?q=<term> ───────────────────────────────────────────────

describe('GET /agents?q= search filter (T310)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('1. ?q= absent returns all agents', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('alpha-bot', 'fs'), dec());
    await ctx.logger.log(makeOp('beta-bot', 'shell'), dec());
    await ctx.logger.log(makeOp('gamma-agent', 'db'), dec());

    const { status, body } = await getJSON(ctx.port, '/agents');
    expect(status).toBe(200);
    const b = body as { agents: Array<{ agentId: string }>; count: number };
    expect(b.count).toBe(3);
    const ids = b.agents.map(a => a.agentId);
    expect(ids).toContain('alpha-bot');
    expect(ids).toContain('beta-bot');
    expect(ids).toContain('gamma-agent');
  });

  it('2. ?q= matching a substring returns only matching agents', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('alpha-bot', 'fs'), dec());
    await ctx.logger.log(makeOp('beta-bot', 'shell'), dec());
    await ctx.logger.log(makeOp('gamma-agent', 'db'), dec());

    const { status, body } = await getJSON(ctx.port, '/agents?q=bot');
    expect(status).toBe(200);
    const b = body as { agents: Array<{ agentId: string }>; count: number };
    expect(b.count).toBe(2);
    const ids = b.agents.map(a => a.agentId);
    expect(ids).toContain('alpha-bot');
    expect(ids).toContain('beta-bot');
    expect(ids).not.toContain('gamma-agent');
  });

  it('3. ?q= is case-insensitive', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('Alpha-Bot', 'fs'), dec());
    await ctx.logger.log(makeOp('beta-bot', 'shell'), dec());

    const { status, body } = await getJSON(ctx.port, '/agents?q=ALPHA');
    expect(status).toBe(200);
    const b = body as { agents: Array<{ agentId: string }>; count: number };
    expect(b.count).toBe(1);
    expect(b.agents[0].agentId).toBe('Alpha-Bot');
  });

  it('4. ?q= with no match returns empty agents list', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('alpha-bot', 'fs'), dec());
    await ctx.logger.log(makeOp('beta-bot', 'shell'), dec());

    const { status, body } = await getJSON(ctx.port, '/agents?q=zzz-no-match');
    expect(status).toBe(200);
    const b = body as { agents: Array<{ agentId: string }>; count: number };
    expect(b.count).toBe(0);
    expect(b.agents).toHaveLength(0);
  });

  it('5. ?q= matches only agents whose agentId contains the term, not tool names', async () => {
    ctx = await setup();
    // agentId does not contain "shell", but tool does
    await ctx.logger.log(makeOp('plain-agent', 'shell'), dec());
    await ctx.logger.log(makeOp('shell-agent', 'fs'), dec());

    const { status, body } = await getJSON(ctx.port, '/agents?q=shell');
    expect(status).toBe(200);
    const b = body as { agents: Array<{ agentId: string }>; count: number };
    // Only shell-agent has "shell" in its agentId
    expect(b.count).toBe(1);
    expect(b.agents[0].agentId).toBe('shell-agent');
  });

  it('6. ?q= with exact full agentId returns exactly that agent', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('exact-match-agent', 'fs'), dec());
    await ctx.logger.log(makeOp('other-agent', 'db'), dec());

    const { status, body } = await getJSON(ctx.port, '/agents?q=exact-match-agent');
    expect(status).toBe(200);
    const b = body as { agents: Array<{ agentId: string }>; count: number };
    expect(b.count).toBe(1);
    expect(b.agents[0].agentId).toBe('exact-match-agent');
  });
});

// ── T311 — GET /tools?q=<term> ────────────────────────────────────────────────

describe('GET /tools?q= search filter (T311)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('1. ?q= absent returns all tools', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'file-read'), dec());
    await ctx.logger.log(makeOp('agent-b', 'file-write'), dec());
    await ctx.logger.log(makeOp('agent-c', 'shell-exec'), dec());

    const { status, body } = await getJSON(ctx.port, '/tools');
    expect(status).toBe(200);
    const b = body as { tools: Array<{ tool: string }>; count: number };
    expect(b.count).toBe(3);
    const names = b.tools.map(t => t.tool);
    expect(names).toContain('file-read');
    expect(names).toContain('file-write');
    expect(names).toContain('shell-exec');
  });

  it('2. ?q= matching a substring returns only matching tools', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'file-read'), dec());
    await ctx.logger.log(makeOp('agent-b', 'file-write'), dec());
    await ctx.logger.log(makeOp('agent-c', 'shell-exec'), dec());

    const { status, body } = await getJSON(ctx.port, '/tools?q=file');
    expect(status).toBe(200);
    const b = body as { tools: Array<{ tool: string }>; count: number };
    expect(b.count).toBe(2);
    const names = b.tools.map(t => t.tool);
    expect(names).toContain('file-read');
    expect(names).toContain('file-write');
    expect(names).not.toContain('shell-exec');
  });

  it('3. ?q= is case-insensitive', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'FileRead'), dec());
    await ctx.logger.log(makeOp('agent-b', 'shell-exec'), dec());

    const { status, body } = await getJSON(ctx.port, '/tools?q=FILEREAD');
    expect(status).toBe(200);
    const b = body as { tools: Array<{ tool: string }>; count: number };
    expect(b.count).toBe(1);
    expect(b.tools[0].tool).toBe('FileRead');
  });

  it('4. ?q= with no match returns empty tools list', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'file-read'), dec());
    await ctx.logger.log(makeOp('agent-b', 'shell-exec'), dec());

    const { status, body } = await getJSON(ctx.port, '/tools?q=zzz-no-match');
    expect(status).toBe(200);
    const b = body as { tools: Array<{ tool: string }>; count: number };
    expect(b.count).toBe(0);
    expect(b.tools).toHaveLength(0);
  });

  it('5. ?q= matches only tools whose name contains the term, not agentId', async () => {
    ctx = await setup();
    // agentId contains "read" but tool does not
    await ctx.logger.log(makeOp('read-agent', 'shell-exec'), dec());
    // tool contains "read"
    await ctx.logger.log(makeOp('other-agent', 'file-read'), dec());

    const { status, body } = await getJSON(ctx.port, '/tools?q=read');
    expect(status).toBe(200);
    const b = body as { tools: Array<{ tool: string }>; count: number };
    // Only file-read has "read" in its tool name
    expect(b.count).toBe(1);
    expect(b.tools[0].tool).toBe('file-read');
  });

  it('6. ?q= with exact full tool name returns exactly that tool', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'exact-tool-name'), dec());
    await ctx.logger.log(makeOp('agent-b', 'other-tool'), dec());

    const { status, body } = await getJSON(ctx.port, '/tools?q=exact-tool-name');
    expect(status).toBe(200);
    const b = body as { tools: Array<{ tool: string }>; count: number };
    expect(b.count).toBe(1);
    expect(b.tools[0].tool).toBe('exact-tool-name');
  });
});

// ── T312 — GET /sessions/:id includes maxRisk ─────────────────────────────────

describe('GET /sessions/:id includes maxRisk (T312)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('1. response includes maxRisk field', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-max-test'), dec('allow', 0.3));

    const { status, body } = await getJSON(ctx.port, '/sessions/sess-max-test');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b).toHaveProperty('maxRisk');
  });

  it('2. maxRisk is the highest riskScore seen in that session', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-max-risk'), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-a', 'shell', 'sess-max-risk'), dec('block', 0.9));
    await ctx.logger.log(makeOp('agent-a', 'db', 'sess-max-risk'), dec('allow', 0.5));

    const { status, body } = await getJSON(ctx.port, '/sessions/sess-max-risk');
    expect(status).toBe(200);
    const b = body as { maxRisk: number };
    expect(b.maxRisk).toBeCloseTo(0.9, 5);
  });

  it('3. maxRisk is the single riskScore when there is only one operation', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-single-op'), dec('allow', 0.65));

    const { status, body } = await getJSON(ctx.port, '/sessions/sess-single-op');
    expect(status).toBe(200);
    const b = body as { maxRisk: number };
    expect(b.maxRisk).toBeCloseTo(0.65, 5);
  });

  it('4. maxRisk equals the last op riskScore when all are equal', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-equal-risk'), dec('allow', 0.4));
    await ctx.logger.log(makeOp('agent-a', 'db', 'sess-equal-risk'), dec('allow', 0.4));
    await ctx.logger.log(makeOp('agent-a', 'net', 'sess-equal-risk'), dec('allow', 0.4));

    const { status, body } = await getJSON(ctx.port, '/sessions/sess-equal-risk');
    expect(status).toBe(200);
    const b = body as { maxRisk: number };
    expect(b.maxRisk).toBeCloseTo(0.4, 5);
  });

  it('5. maxRisk is not contaminated by operations in a different session', async () => {
    ctx = await setup();
    // Session A has a high-risk op
    await ctx.logger.log(makeOp('agent-a', 'shell', 'sess-a'), dec('block', 0.99));
    // Session B has only a low-risk op
    await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-b'), dec('allow', 0.1));

    const { status, body } = await getJSON(ctx.port, '/sessions/sess-b');
    expect(status).toBe(200);
    const b = body as { maxRisk: number; sessionId: string };
    expect(b.sessionId).toBe('sess-b');
    expect(b.maxRisk).toBeCloseTo(0.1, 5);
  });

  it('6. response also includes sessionId, agentId, totalOps, avgRisk alongside maxRisk', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-field-check', 'fs', 'sess-fields'), dec('allow', 0.3));
    await ctx.logger.log(makeOp('agent-field-check', 'db', 'sess-fields'), dec('block', 0.7));

    const { status, body } = await getJSON(ctx.port, '/sessions/sess-fields');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b).toHaveProperty('sessionId', 'sess-fields');
    expect(b).toHaveProperty('agentId', 'agent-field-check');
    expect(b).toHaveProperty('totalOps', 2);
    expect(b).toHaveProperty('avgRisk');
    expect(b).toHaveProperty('maxRisk');
  });
});

// ── T313 — GET /sessions?q=<term> ─────────────────────────────────────────────

describe('GET /sessions?q= search filter (T313)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('1. ?q= absent returns all sessions', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'fs', 'alpha-session'), dec());
    await ctx.logger.log(makeOp('agent-b', 'shell', 'beta-session'), dec());
    await ctx.logger.log(makeOp('agent-c', 'db', 'gamma-session'), dec());

    const { status, body } = await getJSON(ctx.port, '/sessions');
    expect(status).toBe(200);
    const b = body as { data: Array<{ sessionId: string }>; count: number };
    expect(b.count).toBe(3);
    const ids = b.data.map(s => s.sessionId);
    expect(ids).toContain('alpha-session');
    expect(ids).toContain('beta-session');
    expect(ids).toContain('gamma-session');
  });

  it('2. ?q= matching a substring returns only matching sessions', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'fs', 'alpha-session'), dec());
    await ctx.logger.log(makeOp('agent-b', 'shell', 'beta-session'), dec());
    await ctx.logger.log(makeOp('agent-c', 'db', 'gamma-session'), dec());

    const { status, body } = await getJSON(ctx.port, '/sessions?q=alpha');
    expect(status).toBe(200);
    const b = body as { data: Array<{ sessionId: string }>; count: number };
    expect(b.count).toBe(1);
    expect(b.data[0].sessionId).toBe('alpha-session');
  });

  it('3. ?q= is case-insensitive', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'fs', 'Alpha-Session'), dec());
    await ctx.logger.log(makeOp('agent-b', 'shell', 'beta-session'), dec());

    const { status, body } = await getJSON(ctx.port, '/sessions?q=ALPHA');
    expect(status).toBe(200);
    const b = body as { data: Array<{ sessionId: string }>; count: number };
    expect(b.count).toBe(1);
    expect(b.data[0].sessionId).toBe('Alpha-Session');
  });

  it('4. ?q= with no match returns empty data list', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'fs', 'alpha-session'), dec());
    await ctx.logger.log(makeOp('agent-b', 'shell', 'beta-session'), dec());

    const { status, body } = await getJSON(ctx.port, '/sessions?q=zzz-no-match');
    expect(status).toBe(200);
    const b = body as { data: Array<{ sessionId: string }>; count: number };
    expect(b.count).toBe(0);
    expect(b.data).toHaveLength(0);
  });

  it('5. ?q= shared substring returns all sessions that contain it', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'fs', 'prod-session-1'), dec());
    await ctx.logger.log(makeOp('agent-b', 'db', 'prod-session-2'), dec());
    await ctx.logger.log(makeOp('agent-c', 'net', 'dev-session-1'), dec());

    const { status, body } = await getJSON(ctx.port, '/sessions?q=prod');
    expect(status).toBe(200);
    const b = body as { data: Array<{ sessionId: string }>; count: number };
    expect(b.count).toBe(2);
    const ids = b.data.map(s => s.sessionId);
    expect(ids).toContain('prod-session-1');
    expect(ids).toContain('prod-session-2');
    expect(ids).not.toContain('dev-session-1');
  });

  it('6. ?q= matches only sessionId, not agentId', async () => {
    ctx = await setup();
    // agentId contains "search" but sessionId does not
    await ctx.logger.log(makeOp('search-agent', 'fs', 'plain-session'), dec());
    // sessionId contains "search"
    await ctx.logger.log(makeOp('other-agent', 'db', 'search-session'), dec());

    const { status, body } = await getJSON(ctx.port, '/sessions?q=search');
    expect(status).toBe(200);
    const b = body as { data: Array<{ sessionId: string }>; count: number };
    // Only search-session has "search" in its sessionId
    expect(b.count).toBe(1);
    expect(b.data[0].sessionId).toBe('search-session');
  });

  it('7. ?q= with exact full sessionId returns exactly that session', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'fs', 'exact-session-id'), dec());
    await ctx.logger.log(makeOp('agent-b', 'shell', 'other-session-id'), dec());

    const { status, body } = await getJSON(ctx.port, '/sessions?q=exact-session-id');
    expect(status).toBe(200);
    const b = body as { data: Array<{ sessionId: string }>; count: number };
    expect(b.count).toBe(1);
    expect(b.data[0].sessionId).toBe('exact-session-id');
  });
});
