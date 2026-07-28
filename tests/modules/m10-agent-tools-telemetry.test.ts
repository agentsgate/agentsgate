/**
 * v0.34 — T285, T287, T288, T289
 *
 * T285: GET /agents/:agentId/tools
 *   Returns { agentId, tools: [...], count } with per-tool breakdown.
 *   404 when agentId has no operations.
 *   blockRate = blocked / total per tool, sorted by totalOps desc.
 *
 * T287: GET /operations/export?method=<name>
 *   Filters CSV export to only ops with that method.
 *   Works with format=ndjson.
 *   Combines with other filters like agentId.
 *
 * T288: GET /telemetry/tools/:tool
 *   Returns { tool, totalOps, blockRate, avgRisk }.
 *   404 when tool has no operations.
 *   blockRate and avgRisk computed correctly.
 *
 * T289: GET /policy/rules/:id
 *   Returns the rule object when found.
 *   Returns 404 for unknown rule ID.
 *   Requires policy set in DashboardOptions.
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

// ── T285 — GET /agents/:agentId/tools ─────────────────────────────────────────

describe('GET /agents/:agentId/tools (T285)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('1. returns { agentId, tools, count } shape for a known agent', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'fs'), dec('allow', 0.3));
    await ctx.logger.log(makeOp('agent-a', 'shell'), dec('block', 0.8));

    const { status, body } = await getJSON(ctx.port, '/agents/agent-a/tools');
    expect(status).toBe(200);
    const b = body as {
      agentId: string;
      tools: Array<{ tool: string; totalOps: number; blockRate: number; avgRisk: number }>;
      count: number;
    };
    expect(b.agentId).toBe('agent-a');
    expect(Array.isArray(b.tools)).toBe(true);
    expect(typeof b.count).toBe('number');
    expect(b.count).toBe(b.tools.length);
  });

  it('2. each tool entry has tool, totalOps, blockRate, avgRisk fields', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agt', 'fs'), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agt', 'fs'), dec('block', 0.9));

    const { body } = await getJSON(ctx.port, '/agents/agt/tools');
    const b = body as { tools: Array<{ tool: string; totalOps: number; blockRate: number; avgRisk: number }> };
    expect(b.tools).toHaveLength(1);
    const t = b.tools[0];
    expect(t).toHaveProperty('tool');
    expect(t).toHaveProperty('totalOps');
    expect(t).toHaveProperty('blockRate');
    expect(t).toHaveProperty('avgRisk');
  });

  it('3. returns 404 when agentId has no operations', async () => {
    ctx = await setup();
    const { status } = await getJSON(ctx.port, '/agents/ghost-agent/tools');
    expect(status).toBe(404);
  });

  it('4. blockRate is computed as blocked / total per tool', async () => {
    ctx = await setup();
    // 3 ops on "shell": 1 blocked → blockRate = 1/3
    await ctx.logger.log(makeOp('agt-br', 'shell'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agt-br', 'shell'), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agt-br', 'shell'), dec('block', 0.9));

    const { body } = await getJSON(ctx.port, '/agents/agt-br/tools');
    const b = body as { tools: Array<{ tool: string; blockRate: number }> };
    const t = b.tools.find(x => x.tool === 'shell')!;
    expect(t).toBeDefined();
    expect(t.blockRate).toBeCloseTo(1 / 3, 5);
  });

  it('5. blockRate is 0 when no ops for a tool are blocked', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agt-safe', 'db'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agt-safe', 'db'), dec('allow', 0.2));

    const { body } = await getJSON(ctx.port, '/agents/agt-safe/tools');
    const b = body as { tools: Array<{ tool: string; blockRate: number }> };
    const t = b.tools.find(x => x.tool === 'db')!;
    expect(t.blockRate).toBe(0);
  });

  it('6. blockRate is 1 when all ops for a tool are blocked', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agt-risky', 'shell'), dec('block', 0.95));
    await ctx.logger.log(makeOp('agt-risky', 'shell'), dec('block', 0.99));

    const { body } = await getJSON(ctx.port, '/agents/agt-risky/tools');
    const b = body as { tools: Array<{ tool: string; blockRate: number }> };
    const t = b.tools.find(x => x.tool === 'shell')!;
    expect(t.blockRate).toBe(1);
  });

  it('7. tools are sorted by totalOps descending', async () => {
    ctx = await setup();
    // "fs": 1 op, "shell": 3 ops, "db": 2 ops → sorted: shell, db, fs
    await ctx.logger.log(makeOp('agt-sort', 'shell'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agt-sort', 'shell'), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agt-sort', 'shell'), dec('block', 0.8));
    await ctx.logger.log(makeOp('agt-sort', 'db'), dec('allow', 0.3));
    await ctx.logger.log(makeOp('agt-sort', 'db'), dec('allow', 0.4));
    await ctx.logger.log(makeOp('agt-sort', 'fs'), dec('allow', 0.2));

    const { body } = await getJSON(ctx.port, '/agents/agt-sort/tools');
    const b = body as { tools: Array<{ tool: string; totalOps: number }>; count: number };
    expect(b.count).toBe(3);
    expect(b.tools[0].tool).toBe('shell');
    expect(b.tools[0].totalOps).toBe(3);
    expect(b.tools[1].tool).toBe('db');
    expect(b.tools[1].totalOps).toBe(2);
    expect(b.tools[2].tool).toBe('fs');
    expect(b.tools[2].totalOps).toBe(1);
  });

  it('8. avgRisk is the mean riskScore across all ops for that tool', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agt-avg', 'net'), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agt-avg', 'net'), dec('allow', 0.6));

    const { body } = await getJSON(ctx.port, '/agents/agt-avg/tools');
    const b = body as { tools: Array<{ tool: string; avgRisk: number }> };
    const t = b.tools.find(x => x.tool === 'net')!;
    // avg = (0.2 + 0.6) / 2 = 0.4
    expect(t.avgRisk).toBeCloseTo(0.4, 5);
  });

  it('9. count field equals the number of distinct tools', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agt-cnt', 'fs'), dec());
    await ctx.logger.log(makeOp('agt-cnt', 'db'), dec());
    await ctx.logger.log(makeOp('agt-cnt', 'shell'), dec());

    const { body } = await getJSON(ctx.port, '/agents/agt-cnt/tools');
    const b = body as { count: number; tools: unknown[] };
    expect(b.count).toBe(3);
    expect(b.tools).toHaveLength(3);
  });

  it('10. only includes tools used by the requested agent, not other agents', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-x', 'x-tool'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-y', 'y-tool'), dec('allow', 0.2));

    const { body } = await getJSON(ctx.port, '/agents/agent-x/tools');
    const b = body as { tools: Array<{ tool: string }> };
    expect(b.tools.every(t => t.tool === 'x-tool')).toBe(true);
    expect(b.tools.find(t => t.tool === 'y-tool')).toBeUndefined();
  });
});

// ── T287 — GET /operations/export?method=<name> ───────────────────────────────

describe('GET /operations/export?method=<name> (T287)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('1. only returns ops with the matching method in CSV output', async () => {
    ctx = await setup();
    await ctx.logger.log(
      makeOp('a', 'fs', { id: 'op-write', method: 'write_file' }),
      dec()
    );
    await ctx.logger.log(
      makeOp('a', 'fs', { id: 'op-read', method: 'read_file' }),
      dec()
    );

    const { status, body } = await getText(ctx.port, '/operations/export?method=write_file');
    expect(status).toBe(200);
    expect(body).toContain('op-write');
    expect(body).not.toContain('op-read');
  });

  it('2. method column appears in the CSV header', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('a', 'fs', { method: 'read_file' }), dec());

    const { body, contentType } = await getText(ctx.port, '/operations/export?method=read_file');
    expect(contentType).toContain('text/csv');
    const headerLine = body.split('\r\n')[0];
    expect(headerLine).toContain('method');
  });

  it('3. returns only the header row when no ops match the method', async () => {
    ctx = await setup();
    await ctx.logger.log(
      makeOp('a', 'fs', { id: 'op-other', method: 'read_file' }),
      dec()
    );

    const { body } = await getText(ctx.port, '/operations/export?method=nonexistent_method');
    const lines = body.split('\r\n').filter(Boolean);
    // Only the header row — no data rows
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('id');
  });

  it('4. method filter works combined with agentId filter', async () => {
    ctx = await setup();
    // Same method, different agents
    await ctx.logger.log(
      makeOp('agent-1', 'fs', { id: 'op-a1-write', method: 'write_file' }),
      dec()
    );
    await ctx.logger.log(
      makeOp('agent-2', 'fs', { id: 'op-a2-write', method: 'write_file' }),
      dec()
    );
    // Different method, same agent
    await ctx.logger.log(
      makeOp('agent-1', 'fs', { id: 'op-a1-read', method: 'read_file' }),
      dec()
    );

    const { body } = await getText(
      ctx.port,
      '/operations/export?method=write_file&agentId=agent-1'
    );
    expect(body).toContain('op-a1-write');
    expect(body).not.toContain('op-a2-write');
    expect(body).not.toContain('op-a1-read');
  });

  it('5. method filter works with ndjson format', async () => {
    ctx = await setup();
    await ctx.logger.log(
      makeOp('a', 'db', { id: 'op-query', method: 'query' }),
      dec()
    );
    await ctx.logger.log(
      makeOp('a', 'db', { id: 'op-delete', method: 'delete' }),
      dec()
    );

    const { status, body, contentType } = await getText(
      ctx.port,
      '/operations/export?format=ndjson&method=query'
    );
    expect(status).toBe(200);
    expect(contentType).toContain('ndjson');
    expect(body).toContain('op-query');
    expect(body).not.toContain('op-delete');
  });

  it('6. method filter is case-sensitive (exact match)', async () => {
    ctx = await setup();
    await ctx.logger.log(
      makeOp('a', 'fs', { id: 'op-exact', method: 'write_file' }),
      dec()
    );

    // Wrong case should not match
    const { body } = await getText(ctx.port, '/operations/export?method=Write_File');
    const lines = body.split('\r\n').filter(Boolean);
    // Only the header — op-exact should not appear
    expect(lines).toHaveLength(1);
  });

  it('7. method filter combined with action filter', async () => {
    ctx = await setup();
    await ctx.logger.log(
      makeOp('a', 'shell', { id: 'op-blocked-exec', method: 'exec' }),
      dec('block', 0.9)
    );
    await ctx.logger.log(
      makeOp('a', 'shell', { id: 'op-allowed-exec', method: 'exec' }),
      dec('allow', 0.1)
    );
    await ctx.logger.log(
      makeOp('a', 'shell', { id: 'op-blocked-run', method: 'run' }),
      dec('block', 0.9)
    );

    const { body } = await getText(
      ctx.port,
      '/operations/export?method=exec&action=block'
    );
    expect(body).toContain('op-blocked-exec');
    expect(body).not.toContain('op-allowed-exec');
    expect(body).not.toContain('op-blocked-run');
  });
});

// ── T288 — GET /telemetry/tools/:tool ─────────────────────────────────────────

describe('GET /telemetry/tools/:tool (T288)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('1. returns { tool, totalOps, blockRate, avgRisk } for a known tool', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('a', 'shell'), dec('allow', 0.3));
    await ctx.logger.log(makeOp('b', 'shell'), dec('block', 0.9));

    const { status, body } = await getJSON(ctx.port, '/telemetry/tools/shell');
    expect(status).toBe(200);
    const b = body as { tool: string; totalOps: number; blockRate: number; avgRisk: number };
    expect(b.tool).toBe('shell');
    expect(typeof b.totalOps).toBe('number');
    expect(typeof b.blockRate).toBe('number');
    expect(typeof b.avgRisk).toBe('number');
  });

  it('2. returns 404 when tool has no operations', async () => {
    ctx = await setup();
    const { status } = await getJSON(ctx.port, '/telemetry/tools/nonexistent-tool');
    expect(status).toBe(404);
  });

  it('3. totalOps reflects all ops for that tool across all agents', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-1', 'fs'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-2', 'fs'), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-3', 'fs'), dec('block', 0.8));

    const { body } = await getJSON(ctx.port, '/telemetry/tools/fs');
    const b = body as { totalOps: number };
    expect(b.totalOps).toBe(3);
  });

  it('4. blockRate = blocked ops / total ops for that tool', async () => {
    ctx = await setup();
    // 1 block out of 4 → blockRate = 0.25
    await ctx.logger.log(makeOp('a', 'net'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('b', 'net'), dec('allow', 0.2));
    await ctx.logger.log(makeOp('c', 'net'), dec('allow', 0.3));
    await ctx.logger.log(makeOp('d', 'net'), dec('block', 0.9));

    const { body } = await getJSON(ctx.port, '/telemetry/tools/net');
    const b = body as { blockRate: number };
    expect(b.blockRate).toBeCloseTo(0.25, 5);
  });

  it('5. avgRisk = average riskScore across all ops for that tool', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('a', 'db'), dec('allow', 0.2));
    await ctx.logger.log(makeOp('b', 'db'), dec('allow', 0.6));

    const { body } = await getJSON(ctx.port, '/telemetry/tools/db');
    const b = body as { avgRisk: number };
    // avg = (0.2 + 0.6) / 2 = 0.4
    expect(b.avgRisk).toBeCloseTo(0.4, 5);
  });

  it('6. blockRate is 0 when no ops for the tool are blocked', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('a', 'safe-read'), dec('allow', 0.05));
    await ctx.logger.log(makeOp('b', 'safe-read'), dec('allow', 0.10));

    const { body } = await getJSON(ctx.port, '/telemetry/tools/safe-read');
    const b = body as { blockRate: number };
    expect(b.blockRate).toBe(0);
  });

  it('7. blockRate is 1 when all ops for the tool are blocked', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('a', 'danger-exec'), dec('block', 0.95));
    await ctx.logger.log(makeOp('b', 'danger-exec'), dec('block', 0.99));

    const { body } = await getJSON(ctx.port, '/telemetry/tools/danger-exec');
    const b = body as { blockRate: number };
    expect(b.blockRate).toBe(1);
  });

  it('8. different tools have independent telemetry records', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('a', 'tool-alpha'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('a', 'tool-beta'), dec('block', 0.9));

    const { body: bodyA } = await getJSON(ctx.port, '/telemetry/tools/tool-alpha');
    const { body: bodyB } = await getJSON(ctx.port, '/telemetry/tools/tool-beta');

    const a = bodyA as { totalOps: number; blockRate: number };
    const b = bodyB as { totalOps: number; blockRate: number };
    expect(a.totalOps).toBe(1);
    expect(a.blockRate).toBe(0);
    expect(b.totalOps).toBe(1);
    expect(b.blockRate).toBe(1);
  });
});

// ── T289 — GET /policy/rules/:id ──────────────────────────────────────────────

describe('GET /policy/rules/:id (T289)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('1. returns the rule object when rule id is found', async () => {
    const policy: AgentsGatePolicy = {
      rules: [
        { id: 'rule-block-shell', match: { tool: 'shell' }, action: 'block' },
        { id: 'rule-score-fs', match: { tool: 'fs' }, score: 0.5 },
      ],
    };
    ctx = await setup(policy);

    const { status, body } = await getJSON(ctx.port, '/policy/rules/rule-block-shell');
    expect(status).toBe(200);
    const b = body as { id: string; action?: string };
    expect(b.id).toBe('rule-block-shell');
    expect(b.action).toBe('block');
  });

  it('2. returns 404 for an unknown rule id', async () => {
    const policy: AgentsGatePolicy = {
      rules: [{ id: 'rule-known', match: { tool: 'fs' } }],
    };
    ctx = await setup(policy);

    const { status } = await getJSON(ctx.port, '/policy/rules/rule-does-not-exist');
    expect(status).toBe(404);
  });

  it('3. returns 404 when no policy is configured', async () => {
    ctx = await setup(); // no policy
    const { status } = await getJSON(ctx.port, '/policy/rules/any-rule');
    expect(status).toBe(404);
  });

  it('4. returns the correct rule when multiple rules are present', async () => {
    const policy: AgentsGatePolicy = {
      rules: [
        { id: 'rule-1', match: { tool: 'shell' }, action: 'block' },
        { id: 'rule-2', match: { tool: 'db' }, score: 0.7, description: 'DB scoring rule' },
        { id: 'rule-3', match: { tool: 'net' }, action: 'require_approval' },
      ],
    };
    ctx = await setup(policy);

    const { status, body } = await getJSON(ctx.port, '/policy/rules/rule-2');
    expect(status).toBe(200);
    const b = body as { id: string; score?: number; description?: string };
    expect(b.id).toBe('rule-2');
    expect(b.score).toBe(0.7);
    expect(b.description).toBe('DB scoring rule');
  });

  it('5. response is the rule object itself, not wrapped in { rules: [...] }', async () => {
    const policy: AgentsGatePolicy = {
      rules: [
        { id: 'rule-alpha', match: { tool: 'shell' } },
        { id: 'rule-beta', match: { tool: 'db' } },
      ],
    };
    ctx = await setup(policy);

    const { status, body } = await getJSON(ctx.port, '/policy/rules/rule-alpha');
    expect(status).toBe(200);
    const b = body as { id: string; rules?: unknown };
    expect(b.id).toBe('rule-alpha');
    // Must not be wrapped in a rules array
    expect(b.rules).toBeUndefined();
  });

  it('6. returns rule with all its fields intact (match, score, description, action)', async () => {
    const policy: AgentsGatePolicy = {
      rules: [
        {
          id: 'rule-full',
          description: 'Block all writes',
          match: { tool: 'fs', method: 'write_file' },
          action: 'block',
          score: 0.95,
        },
      ],
    };
    ctx = await setup(policy);

    const { status, body } = await getJSON(ctx.port, '/policy/rules/rule-full');
    expect(status).toBe(200);
    const b = body as {
      id: string;
      description?: string;
      match: { tool?: string; method?: string };
      action?: string;
      score?: number;
    };
    expect(b.id).toBe('rule-full');
    expect(b.description).toBe('Block all writes');
    expect(b.match.tool).toBe('fs');
    expect(b.match.method).toBe('write_file');
    expect(b.action).toBe('block');
    expect(b.score).toBe(0.95);
  });
});
