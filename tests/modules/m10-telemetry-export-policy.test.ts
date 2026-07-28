/**
 * T280/T281/T282/T284 — GET /telemetry/agents, GET /telemetry/tools,
 * GET /operations/export with tags+parentId filters, GET /policy/rules/:id
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { StateStore } from '../../src/modules/m2-store/index.js';
import { DashboardAPI } from '../../src/modules/m10-dashboard/index.js';
import { OperationLogger } from '../../src/modules/m3-logger/index.js';
import type { MCPOperation, ProxyDecision } from '../../src/types/interfaces.js';
import type { AgentsGatePolicy } from '../../src/policy.js';

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

async function setup(policy?: AgentsGatePolicy): Promise<Ctx> {
  const store = new StateStore(':memory:');
  await store.initialize();
  const logger = new OperationLogger(store);
  const dash = new DashboardAPI(store, policy ? { policy } : {});
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

async function getText(port: number, path: string): Promise<{ status: number; body: string; contentType: string }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, body: await res.text(), contentType: res.headers.get('content-type') ?? '' };
}

// ── T280 — GET /telemetry/agents ──────────────────────────────────────────────

describe('GET /telemetry/agents (T280)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('1. empty DB returns { agents: [], count: 0 }', async () => {
    ctx = await setup();
    const { status, body } = await getJSON(ctx.port, '/telemetry/agents');
    expect(status).toBe(200);
    const b = body as { agents: unknown[]; count: number };
    expect(b.agents).toEqual([]);
    expect(b.count).toBe(0);
  });

  it('2. each agent entry has agentId, totalOps, blockRate, avgRisk', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'fs'), dec('allow', 0.4));
    await ctx.logger.log(makeOp('agent-a', 'shell'), dec('block', 0.8));

    const { status, body } = await getJSON(ctx.port, '/telemetry/agents');
    expect(status).toBe(200);
    const b = body as { agents: Array<{ agentId: string; totalOps: number; blockRate: number; avgRisk: number }>; count: number };
    expect(b.count).toBe(1);
    expect(b.agents).toHaveLength(1);

    const a = b.agents[0];
    expect(a.agentId).toBe('agent-a');
    expect(a.totalOps).toBe(2);
    expect(a).toHaveProperty('blockRate');
    expect(a).toHaveProperty('avgRisk');
  });

  it('3. blockRate = blocked ops / total ops', async () => {
    ctx = await setup();
    // 2 allow, 1 block → blockRate = 1/3
    await ctx.logger.log(makeOp('agt', 'fs'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agt', 'fs'), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agt', 'shell'), dec('block', 0.9));

    const { body } = await getJSON(ctx.port, '/telemetry/agents');
    const b = body as { agents: Array<{ agentId: string; blockRate: number }> };
    const a = b.agents.find(x => x.agentId === 'agt')!;
    expect(a).toBeDefined();
    expect(a.blockRate).toBeCloseTo(1 / 3, 5);
  });

  it('4. avgRisk = average riskScore across all ops for that agent', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agt2', 'fs'), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agt2', 'db'), dec('block', 0.6));

    const { body } = await getJSON(ctx.port, '/telemetry/agents');
    const b = body as { agents: Array<{ agentId: string; avgRisk: number }> };
    const a = b.agents.find(x => x.agentId === 'agt2')!;
    expect(a).toBeDefined();
    // avg = (0.2 + 0.6) / 2 = 0.4
    expect(a.avgRisk).toBeCloseTo(0.4, 5);
  });

  it('5. two agents — both returned, sorted by totalOps descending', async () => {
    ctx = await setup();
    // agent-x: 3 ops, agent-y: 1 op
    await ctx.logger.log(makeOp('agent-x', 'fs'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-x', 'fs'), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-x', 'db'), dec('block', 0.9));
    await ctx.logger.log(makeOp('agent-y', 'fs'), dec('allow', 0.3));

    const { body } = await getJSON(ctx.port, '/telemetry/agents');
    const b = body as { agents: Array<{ agentId: string; totalOps: number }>; count: number };
    expect(b.count).toBe(2);
    expect(b.agents[0].agentId).toBe('agent-x');
    expect(b.agents[0].totalOps).toBe(3);
    expect(b.agents[1].agentId).toBe('agent-y');
    expect(b.agents[1].totalOps).toBe(1);
  });

  it('6. blockRate is 0 when no ops are blocked', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('clean', 'fs'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('clean', 'db'), dec('allow', 0.2));

    const { body } = await getJSON(ctx.port, '/telemetry/agents');
    const b = body as { agents: Array<{ agentId: string; blockRate: number }> };
    const a = b.agents.find(x => x.agentId === 'clean')!;
    expect(a.blockRate).toBe(0);
  });

  it('7. blockRate is 1 when all ops are blocked', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('risky', 'shell'), dec('block', 0.95));
    await ctx.logger.log(makeOp('risky', 'shell'), dec('block', 0.99));

    const { body } = await getJSON(ctx.port, '/telemetry/agents');
    const b = body as { agents: Array<{ agentId: string; blockRate: number }> };
    const a = b.agents.find(x => x.agentId === 'risky')!;
    expect(a.blockRate).toBe(1);
  });
});

// ── T281 — GET /telemetry/tools ───────────────────────────────────────────────

describe('GET /telemetry/tools (T281)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('1. empty DB returns { tools: [], count: 0 }', async () => {
    ctx = await setup();
    const { status, body } = await getJSON(ctx.port, '/telemetry/tools');
    expect(status).toBe(200);
    const b = body as { tools: unknown[]; count: number };
    expect(b.tools).toEqual([]);
    expect(b.count).toBe(0);
  });

  it('2. each tool entry has tool, totalOps, blockRate, avgRisk', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'shell'), dec('allow', 0.5));
    await ctx.logger.log(makeOp('agent-b', 'shell'), dec('block', 0.9));

    const { status, body } = await getJSON(ctx.port, '/telemetry/tools');
    expect(status).toBe(200);
    const b = body as { tools: Array<{ tool: string; totalOps: number; blockRate: number; avgRisk: number }>; count: number };
    expect(b.count).toBe(1);
    expect(b.tools).toHaveLength(1);

    const t = b.tools[0];
    expect(t.tool).toBe('shell');
    expect(t.totalOps).toBe(2);
    expect(t).toHaveProperty('blockRate');
    expect(t).toHaveProperty('avgRisk');
  });

  it('3. blockRate = blocked ops / total ops for that tool', async () => {
    ctx = await setup();
    // 1 block out of 4 → blockRate = 0.25
    await ctx.logger.log(makeOp('a', 'net'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('b', 'net'), dec('allow', 0.2));
    await ctx.logger.log(makeOp('c', 'net'), dec('allow', 0.3));
    await ctx.logger.log(makeOp('d', 'net'), dec('block', 0.9));

    const { body } = await getJSON(ctx.port, '/telemetry/tools');
    const b = body as { tools: Array<{ tool: string; blockRate: number }> };
    const t = b.tools.find(x => x.tool === 'net')!;
    expect(t).toBeDefined();
    expect(t.blockRate).toBeCloseTo(0.25, 5);
  });

  it('4. avgRisk = average riskScore across all ops for that tool', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('a', 'db'), dec('allow', 0.3));
    await ctx.logger.log(makeOp('b', 'db'), dec('allow', 0.7));

    const { body } = await getJSON(ctx.port, '/telemetry/tools');
    const b = body as { tools: Array<{ tool: string; avgRisk: number }> };
    const t = b.tools.find(x => x.tool === 'db')!;
    expect(t).toBeDefined();
    // avg = (0.3 + 0.7) / 2 = 0.5
    expect(t.avgRisk).toBeCloseTo(0.5, 5);
  });

  it('5. two tools — both returned, sorted by totalOps descending', async () => {
    ctx = await setup();
    // shell: 3 ops, fs: 1 op
    await ctx.logger.log(makeOp('a', 'shell'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('b', 'shell'), dec('allow', 0.2));
    await ctx.logger.log(makeOp('c', 'shell'), dec('block', 0.9));
    await ctx.logger.log(makeOp('d', 'fs'), dec('allow', 0.3));

    const { body } = await getJSON(ctx.port, '/telemetry/tools');
    const b = body as { tools: Array<{ tool: string; totalOps: number }>; count: number };
    expect(b.count).toBe(2);
    expect(b.tools[0].tool).toBe('shell');
    expect(b.tools[0].totalOps).toBe(3);
    expect(b.tools[1].tool).toBe('fs');
    expect(b.tools[1].totalOps).toBe(1);
  });

  it('6. blockRate is 0 when no ops are blocked for that tool', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('a', 'safe-tool'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('b', 'safe-tool'), dec('allow', 0.2));

    const { body } = await getJSON(ctx.port, '/telemetry/tools');
    const b = body as { tools: Array<{ tool: string; blockRate: number }> };
    const t = b.tools.find(x => x.tool === 'safe-tool')!;
    expect(t.blockRate).toBe(0);
  });

  it('7. blockRate is 1 when all ops are blocked for that tool', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('a', 'danger-tool'), dec('block', 0.99));
    await ctx.logger.log(makeOp('b', 'danger-tool'), dec('block', 0.95));

    const { body } = await getJSON(ctx.port, '/telemetry/tools');
    const b = body as { tools: Array<{ tool: string; blockRate: number }> };
    const t = b.tools.find(x => x.tool === 'danger-tool')!;
    expect(t.blockRate).toBe(1);
  });
});

// ── T282 — GET /operations/export with tags and parentId filters ──────────────

describe('GET /operations/export — tags and parentId filters (T282)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('1. ?tags= filter: only returns ops that have ALL specified tags (CSV)', async () => {
    ctx = await setup();
    // op with tags [pci, critical]
    await ctx.logger.log(makeOp('a', 'fs', { id: 'op-tagged', tags: ['pci', 'critical'] }), dec());
    // op with only one tag
    await ctx.logger.log(makeOp('a', 'db', { id: 'op-one-tag', tags: ['pci'] }), dec());
    // op with no tags
    await ctx.logger.log(makeOp('a', 'net', { id: 'op-no-tags' }), dec());

    const { status, body } = await getText(ctx.port, '/operations/export?tags=pci,critical');
    expect(status).toBe(200);
    // only op-tagged has BOTH pci AND critical
    expect(body).toContain('op-tagged');
    expect(body).not.toContain('op-one-tag');
    expect(body).not.toContain('op-no-tags');
  });

  it('2. ?tags= with a single tag returns all ops that have that tag (CSV)', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('a', 'fs', { id: 'op-pci', tags: ['pci'] }), dec());
    await ctx.logger.log(makeOp('a', 'db', { id: 'op-none' }), dec());

    const { body } = await getText(ctx.port, '/operations/export?tags=pci');
    expect(body).toContain('op-pci');
    expect(body).not.toContain('op-none');
  });

  it('3. ?parentId= filter: only returns ops with matching parentId (CSV)', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('a', 'fs', { id: 'op-child', parentId: 'parent-123' }), dec());
    await ctx.logger.log(makeOp('a', 'db', { id: 'op-other-parent', parentId: 'parent-999' }), dec());
    await ctx.logger.log(makeOp('a', 'net', { id: 'op-no-parent' }), dec());

    const { status, body } = await getText(ctx.port, '/operations/export?parentId=parent-123');
    expect(status).toBe(200);
    expect(body).toContain('op-child');
    expect(body).not.toContain('op-other-parent');
    expect(body).not.toContain('op-no-parent');
  });

  it('4. ?tags= filter works with NDJSON format', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('a', 'fs', { id: 'op-tagged-ndjson', tags: ['audit'] }), dec());
    await ctx.logger.log(makeOp('a', 'db', { id: 'op-no-tag-ndjson' }), dec());

    const { status, body, contentType } = await getText(ctx.port, '/operations/export?format=ndjson&tags=audit');
    expect(status).toBe(200);
    expect(contentType).toContain('ndjson');
    expect(body).toContain('op-tagged-ndjson');
    expect(body).not.toContain('op-no-tag-ndjson');
  });

  it('5. ?parentId= filter works with NDJSON format', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('a', 'fs', { id: 'op-child-ndjson', parentId: 'parent-abc' }), dec());
    await ctx.logger.log(makeOp('a', 'db', { id: 'op-root-ndjson' }), dec());

    const { status, body, contentType } = await getText(ctx.port, '/operations/export?format=ndjson&parentId=parent-abc');
    expect(status).toBe(200);
    expect(contentType).toContain('ndjson');
    expect(body).toContain('op-child-ndjson');
    expect(body).not.toContain('op-root-ndjson');
  });

  it('6. tags filter requires ALL specified tags (not any/some) — CSV', async () => {
    ctx = await setup();
    // op with tags [a, b, c]
    await ctx.logger.log(makeOp('a', 'fs', { id: 'op-all-three-tags', tags: ['a', 'b', 'c'] }), dec());
    // op with tags [a, b] — missing c
    await ctx.logger.log(makeOp('a', 'db', { id: 'op-two-tags-only', tags: ['a', 'b'] }), dec());

    const { body } = await getText(ctx.port, '/operations/export?tags=a,b,c');
    // only op-all-three-tags has all three tags
    expect(body).toContain('op-all-three-tags');
    expect(body).not.toContain('op-two-tags-only');
  });

  it('7. combined tags and parentId filters narrow results correctly', async () => {
    ctx = await setup();
    // op with both matching tag and matching parentId
    await ctx.logger.log(makeOp('a', 'fs', { id: 'op-both', tags: ['pci'], parentId: 'root-op' }), dec());
    // op with matching tag but wrong parentId
    await ctx.logger.log(makeOp('a', 'db', { id: 'op-tag-only', tags: ['pci'], parentId: 'other-root' }), dec());
    // op with matching parentId but wrong tag
    await ctx.logger.log(makeOp('a', 'net', { id: 'op-parent-only', tags: ['other'], parentId: 'root-op' }), dec());

    const { body } = await getText(ctx.port, '/operations/export?tags=pci&parentId=root-op');
    expect(body).toContain('op-both');
    expect(body).not.toContain('op-tag-only');
    expect(body).not.toContain('op-parent-only');
  });

  it('8. no matching tags returns only the CSV header row', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('a', 'fs', { id: 'op-x', tags: ['other'] }), dec());

    const { body } = await getText(ctx.port, '/operations/export?tags=nonexistent-tag');
    const lines = body.split('\r\n').filter(Boolean);
    // only header row — no data rows
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('id');
  });
});

// ── T284 — GET /policy/rules/:id ──────────────────────────────────────────────

describe('GET /policy/rules/:id (T284)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('1. GET /policy/rules/:id returns the specific rule object', async () => {
    const policy: AgentsGatePolicy = {
      rules: [
        { id: 'rule-shell-block', match: { tool: 'shell' }, action: 'block' },
        { id: 'rule-fs-score', match: { tool: 'fs' }, score: 0.5 },
      ],
    };
    ctx = await setup(policy);

    const { status, body } = await getJSON(ctx.port, '/policy/rules/rule-shell-block');
    expect(status).toBe(200);
    const b = body as { id: string; action?: string };
    expect(b.id).toBe('rule-shell-block');
    expect(b.action).toBe('block');
  });

  it('2. GET /policy/rules/:id returns 404 for nonexistent rule', async () => {
    const policy: AgentsGatePolicy = {
      rules: [
        { id: 'rule-exists', match: { tool: 'fs' } },
      ],
    };
    ctx = await setup(policy);

    const { status } = await getJSON(ctx.port, '/policy/rules/nonexistent-rule-id');
    expect(status).toBe(404);
  });

  it('3. GET /policy/rules/:id returns 404 when no policy is configured', async () => {
    ctx = await setup(); // no policy
    const { status } = await getJSON(ctx.port, '/policy/rules/any-rule-id');
    expect(status).toBe(404);
  });

  it('4. GET /policy/rules/:id returns the correct rule when multiple rules exist', async () => {
    const policy: AgentsGatePolicy = {
      rules: [
        { id: 'rule-1', match: { tool: 'shell' }, action: 'block' },
        { id: 'rule-2', match: { tool: 'db' }, score: 0.7, description: 'DB access scoring rule' },
        { id: 'rule-3', match: { tool: 'net' }, action: 'require_approval' },
      ],
    };
    ctx = await setup(policy);

    const { status, body } = await getJSON(ctx.port, '/policy/rules/rule-2');
    expect(status).toBe(200);
    const b = body as { id: string; score?: number; description?: string };
    expect(b.id).toBe('rule-2');
    expect(b.score).toBe(0.7);
    expect(b.description).toBe('DB access scoring rule');
  });

  it('5. GET /policy/rules/:id rule object does NOT include other rules', async () => {
    const policy: AgentsGatePolicy = {
      rules: [
        { id: 'rule-alpha', match: { tool: 'shell' } },
        { id: 'rule-beta', match: { tool: 'fs' } },
      ],
    };
    ctx = await setup(policy);

    const { status, body } = await getJSON(ctx.port, '/policy/rules/rule-alpha');
    expect(status).toBe(200);
    // Response should be the rule object itself, not wrapped in { rules: [...] }
    const b = body as { id: string; rules?: unknown };
    expect(b.id).toBe('rule-alpha');
    expect(b.rules).toBeUndefined();
  });
});
