/**
 * v0.57 feature tests
 *
 * T399/T400 — GET /operations/count supports ?method=<name> filter
 *   - Only counts ops with that operation.method value
 *   - Combined with other filters (agentId + method)
 *   - Invalid/unknown method returns 0
 *
 * T402 — GET /agents/:agentId/tools supports ?since=<iso> filter
 *   - Tools only used before the since date are excluded
 *   - Tools used after the since date are included
 *   - Since filter compares tool lastSeen >= sinceISO
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { StateStore } from '../../src/modules/m2-store/index.js';
import { OperationLogger } from '../../src/modules/m3-logger/index.js';
import { DashboardAPI } from '../../src/modules/m10-dashboard/index.js';
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
  riskScore = 0.3
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

// ── T399/T400 — GET /operations/count ?method= filter ─────────────────────────

describe('GET /operations/count — ?method= filter (T399/T400)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * Seeds mixed ops:
   *   3 ops with method: 'call'  for agent-a
   *   2 ops with method: 'read'  for agent-b
   *   1 op  with method: 'call'  for agent-b
   */
  async function seedMixedMethodOps(ctx: Ctx): Promise<void> {
    // agent-a: 3 call ops
    await ctx.logger.log(makeOp('agent-a', 'tool-x', 'sess-1', { method: 'call' }), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-a', 'tool-x', 'sess-2', { method: 'call' }), dec('allow', 0.3));
    await ctx.logger.log(makeOp('agent-a', 'tool-y', 'sess-3', { method: 'call' }), dec('allow', 0.4));
    // agent-b: 2 read ops + 1 call op
    await ctx.logger.log(makeOp('agent-b', 'tool-z', 'sess-4', { method: 'read' }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-b', 'tool-z', 'sess-5', { method: 'read' }), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-b', 'tool-x', 'sess-6', { method: 'call' }), dec('allow', 0.3));
  }

  it('1. ?method=call returns count of call-method ops only (4 total)', async () => {
    ctx = await setup();
    await seedMixedMethodOps(ctx);

    const { status, body } = await getJSON(ctx.port, '/operations/count?method=call');
    expect(status).toBe(200);
    const b = body as { count: number };
    expect(b.count).toBe(4);
  });

  it('2. ?method=read returns count of read-method ops only (2 total)', async () => {
    ctx = await setup();
    await seedMixedMethodOps(ctx);

    const { status, body } = await getJSON(ctx.port, '/operations/count?method=read');
    expect(status).toBe(200);
    const b = body as { count: number };
    expect(b.count).toBe(2);
  });

  it('3. ?method=nonexistent returns count 0 for unknown method name', async () => {
    ctx = await setup();
    await seedMixedMethodOps(ctx);

    const { status, body } = await getJSON(ctx.port, '/operations/count?method=nonexistent');
    expect(status).toBe(200);
    const b = body as { count: number };
    expect(b.count).toBe(0);
  });

  it('4. ?method=write returns count 0 when no write-method ops exist', async () => {
    ctx = await setup();
    await seedMixedMethodOps(ctx);

    const { status, body } = await getJSON(ctx.port, '/operations/count?method=write');
    expect(status).toBe(200);
    const b = body as { count: number };
    expect(b.count).toBe(0);
  });

  it('5. combined filter ?agentId=agent-a&method=call returns only agent-a call ops (3)', async () => {
    ctx = await setup();
    await seedMixedMethodOps(ctx);

    const { status, body } = await getJSON(ctx.port, '/operations/count?agentId=agent-a&method=call');
    expect(status).toBe(200);
    const b = body as { count: number };
    expect(b.count).toBe(3);
  });

  it('6. combined filter ?agentId=agent-b&method=read returns only agent-b read ops (2)', async () => {
    ctx = await setup();
    await seedMixedMethodOps(ctx);

    const { status, body } = await getJSON(ctx.port, '/operations/count?agentId=agent-b&method=read');
    expect(status).toBe(200);
    const b = body as { count: number };
    expect(b.count).toBe(2);
  });

  it('7. combined filter ?agentId=agent-b&method=call returns only agent-b call ops (1)', async () => {
    ctx = await setup();
    await seedMixedMethodOps(ctx);

    const { status, body } = await getJSON(ctx.port, '/operations/count?agentId=agent-b&method=call');
    expect(status).toBe(200);
    const b = body as { count: number };
    expect(b.count).toBe(1);
  });

  it('8. combined filter ?agentId=agent-a&method=read returns 0 (agent-a has no read ops)', async () => {
    ctx = await setup();
    await seedMixedMethodOps(ctx);

    const { status, body } = await getJSON(ctx.port, '/operations/count?agentId=agent-a&method=read');
    expect(status).toBe(200);
    const b = body as { count: number };
    expect(b.count).toBe(0);
  });

  it('9. no method filter — returns all ops (6 total)', async () => {
    ctx = await setup();
    await seedMixedMethodOps(ctx);

    const { status, body } = await getJSON(ctx.port, '/operations/count');
    expect(status).toBe(200);
    const b = body as { count: number };
    expect(b.count).toBe(6);
  });

  it('10. empty DB with ?method=call returns 0', async () => {
    ctx = await setup();
    // No ops seeded

    const { status, body } = await getJSON(ctx.port, '/operations/count?method=call');
    expect(status).toBe(200);
    const b = body as { count: number };
    expect(b.count).toBe(0);
  });

  it('11. ?method=call count + ?method=read count = total count when only those two methods exist', async () => {
    ctx = await setup();
    await seedMixedMethodOps(ctx);

    const { body: allBody } = await getJSON(ctx.port, '/operations/count');
    const { body: callBody } = await getJSON(ctx.port, '/operations/count?method=call');
    const { body: readBody } = await getJSON(ctx.port, '/operations/count?method=read');

    const all  = (allBody  as { count: number }).count;
    const call = (callBody as { count: number }).count;
    const read = (readBody as { count: number }).count;
    expect(call + read).toBe(all);
  });

  it('12. combined ?agentId=agent-b&method=nonexistent returns 0 (no match)', async () => {
    ctx = await setup();
    await seedMixedMethodOps(ctx);

    const { status, body } = await getJSON(ctx.port, '/operations/count?agentId=agent-b&method=nonexistent');
    expect(status).toBe(200);
    const b = body as { count: number };
    expect(b.count).toBe(0);
  });
});

// ── T402 — GET /agents/:agentId/tools ?since= filter ─────────────────────────

describe('GET /agents/:agentId/tools — ?since= filter (T402)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * Builds timestamps for seeding:
   *   old:    2020-01-01T00:00:00.000Z  (well in the past)
   *   cutoff: 2022-06-01T00:00:00.000Z  (between old and recent)
   *   recent: 2024-01-01T00:00:00.000Z  (well after cutoff)
   */
  const OLD_TS    = new Date('2020-01-01T00:00:00.000Z');
  const CUTOFF_TS = new Date('2022-06-01T00:00:00.000Z');
  const RECENT_TS = new Date('2024-01-01T00:00:00.000Z');

  /**
   * Seeds agent-ts with:
   *   tool-old  → only used at OLD_TS
   *   tool-new  → only used at RECENT_TS
   */
  async function seedAgentWithTimestampedTools(ctx: Ctx, agentId = 'agent-ts'): Promise<void> {
    await ctx.logger.log(
      makeOp(agentId, 'tool-old', 'sess-old', { timestamp: OLD_TS }),
      dec('allow', 0.2)
    );
    await ctx.logger.log(
      makeOp(agentId, 'tool-new', 'sess-new', { timestamp: RECENT_TS }),
      dec('allow', 0.3)
    );
  }

  it('13. no ?since filter — both tool-old and tool-new are returned', async () => {
    ctx = await setup();
    await seedAgentWithTimestampedTools(ctx, 'agent-ts-1');

    const { status, body } = await getJSON(ctx.port, '/agents/agent-ts-1/tools');
    expect(status).toBe(200);
    const b = body as { tools: Array<{ tool: string }> };
    const names = b.tools.map(t => t.tool);
    expect(names).toContain('tool-old');
    expect(names).toContain('tool-new');
  });

  it('14. ?since=cutoff excludes tool-old (lastSeen < since) and includes tool-new (lastSeen >= since)', async () => {
    ctx = await setup();
    await seedAgentWithTimestampedTools(ctx, 'agent-ts-2');

    const since = CUTOFF_TS.toISOString();
    const { status, body } = await getJSON(ctx.port, `/agents/agent-ts-2/tools?since=${encodeURIComponent(since)}`);
    expect(status).toBe(200);
    const b = body as { tools: Array<{ tool: string }>; count: number };
    const names = b.tools.map(t => t.tool);
    expect(names).not.toContain('tool-old');
    expect(names).toContain('tool-new');
  });

  it('15. ?since=cutoff count reflects only the tools that pass the filter (1)', async () => {
    ctx = await setup();
    await seedAgentWithTimestampedTools(ctx, 'agent-ts-3');

    const since = CUTOFF_TS.toISOString();
    const { body } = await getJSON(ctx.port, `/agents/agent-ts-3/tools?since=${encodeURIComponent(since)}`);
    const b = body as { count: number };
    expect(b.count).toBe(1);
  });

  it('16. ?since= very early date (before OLD_TS) — both tools included', async () => {
    ctx = await setup();
    await seedAgentWithTimestampedTools(ctx, 'agent-ts-4');

    const veryEarly = new Date('2000-01-01T00:00:00.000Z').toISOString();
    const { body } = await getJSON(ctx.port, `/agents/agent-ts-4/tools?since=${encodeURIComponent(veryEarly)}`);
    const b = body as { tools: Array<{ tool: string }>; count: number };
    expect(b.count).toBe(2);
    const names = b.tools.map(t => t.tool);
    expect(names).toContain('tool-old');
    expect(names).toContain('tool-new');
  });

  it('17. ?since= very recent date (after RECENT_TS) — no tools included', async () => {
    ctx = await setup();
    await seedAgentWithTimestampedTools(ctx, 'agent-ts-5');

    const veryRecent = new Date('2030-01-01T00:00:00.000Z').toISOString();
    const { body } = await getJSON(ctx.port, `/agents/agent-ts-5/tools?since=${encodeURIComponent(veryRecent)}`);
    const b = body as { tools: Array<unknown>; count: number };
    expect(b.count).toBe(0);
    expect(b.tools).toHaveLength(0);
  });

  it('18. ?since= exactly equal to RECENT_TS — tool-new is included (>= comparison)', async () => {
    ctx = await setup();
    await seedAgentWithTimestampedTools(ctx, 'agent-ts-6');

    const sinceExact = RECENT_TS.toISOString();
    const { body } = await getJSON(ctx.port, `/agents/agent-ts-6/tools?since=${encodeURIComponent(sinceExact)}`);
    const b = body as { tools: Array<{ tool: string }>; count: number };
    const names = b.tools.map(t => t.tool);
    expect(names).toContain('tool-new');
    expect(b.count).toBeGreaterThanOrEqual(1);
  });

  it('19. ?since= boundary exactly at OLD_TS — tool-old included, tool-new also included', async () => {
    ctx = await setup();
    await seedAgentWithTimestampedTools(ctx, 'agent-ts-7');

    const sinceOld = OLD_TS.toISOString();
    const { body } = await getJSON(ctx.port, `/agents/agent-ts-7/tools?since=${encodeURIComponent(sinceOld)}`);
    const b = body as { tools: Array<{ tool: string }>; count: number };
    const names = b.tools.map(t => t.tool);
    // tool-old.lastSeen == OLD_TS.toISOString() >= sinceOld, so included
    expect(names).toContain('tool-old');
    expect(names).toContain('tool-new');
    expect(b.count).toBe(2);
  });

  it('20. multiple ops for same tool — lastSeen is max; old+new ops for tool-multi excluded by cutoff if lastSeen < since', async () => {
    ctx = await setup();
    const agentId = 'agent-ts-8';
    // tool-multi: two ops in the past, so lastSeen stays in the past
    await ctx.logger.log(
      makeOp(agentId, 'tool-multi', 'sess-m1', { timestamp: OLD_TS }),
      dec('allow', 0.2)
    );
    await ctx.logger.log(
      makeOp(agentId, 'tool-multi', 'sess-m2', { timestamp: new Date('2021-01-01T00:00:00.000Z') }),
      dec('allow', 0.3)
    );
    // tool-new: op in the future
    await ctx.logger.log(
      makeOp(agentId, 'tool-new', 'sess-n1', { timestamp: RECENT_TS }),
      dec('allow', 0.4)
    );

    const since = CUTOFF_TS.toISOString();
    const { body } = await getJSON(ctx.port, `/agents/${agentId}/tools?since=${encodeURIComponent(since)}`);
    const b = body as { tools: Array<{ tool: string }>; count: number };
    const names = b.tools.map(t => t.tool);
    // tool-multi lastSeen = 2021-01-01 < cutoff (2022-06-01) → excluded
    expect(names).not.toContain('tool-multi');
    // tool-new lastSeen = 2024-01-01 >= cutoff → included
    expect(names).toContain('tool-new');
    expect(b.count).toBe(1);
  });

  it('21. tool with one old op and one recent op — lastSeen = recent so included by cutoff filter', async () => {
    ctx = await setup();
    const agentId = 'agent-ts-9';
    // tool-both gets an old op AND a recent op — lastSeen should be RECENT_TS
    await ctx.logger.log(
      makeOp(agentId, 'tool-both', 'sess-b1', { timestamp: OLD_TS }),
      dec('allow', 0.2)
    );
    await ctx.logger.log(
      makeOp(agentId, 'tool-both', 'sess-b2', { timestamp: RECENT_TS }),
      dec('allow', 0.3)
    );

    const since = CUTOFF_TS.toISOString();
    const { body } = await getJSON(ctx.port, `/agents/${agentId}/tools?since=${encodeURIComponent(since)}`);
    const b = body as { tools: Array<{ tool: string }>; count: number };
    const names = b.tools.map(t => t.tool);
    // lastSeen = RECENT_TS >= CUTOFF_TS → included
    expect(names).toContain('tool-both');
    expect(b.count).toBe(1);
  });

  it('22. response includes agentId field matching the requested agent', async () => {
    ctx = await setup();
    await seedAgentWithTimestampedTools(ctx, 'agent-ts-10');

    const since = CUTOFF_TS.toISOString();
    const { status, body } = await getJSON(ctx.port, `/agents/agent-ts-10/tools?since=${encodeURIComponent(since)}`);
    expect(status).toBe(200);
    const b = body as { agentId: string };
    expect(b.agentId).toBe('agent-ts-10');
  });

  it('23. tools returned by since filter have lastSeen field as ISO string', async () => {
    ctx = await setup();
    await seedAgentWithTimestampedTools(ctx, 'agent-ts-11');

    const since = CUTOFF_TS.toISOString();
    const { body } = await getJSON(ctx.port, `/agents/agent-ts-11/tools?since=${encodeURIComponent(since)}`);
    const b = body as { tools: Array<Record<string, unknown>> };
    for (const t of b.tools) {
      expect(t).toHaveProperty('lastSeen');
      expect(typeof t['lastSeen']).toBe('string');
      // Verify it parses as a valid date
      const d = new Date(t['lastSeen'] as string);
      expect(isNaN(d.getTime())).toBe(false);
    }
  });

  it('24. tools returned by since filter all have lastSeen >= since', async () => {
    ctx = await setup();
    await seedAgentWithTimestampedTools(ctx, 'agent-ts-12');

    const since = CUTOFF_TS.toISOString();
    const { body } = await getJSON(ctx.port, `/agents/agent-ts-12/tools?since=${encodeURIComponent(since)}`);
    const b = body as { tools: Array<{ lastSeen: string }> };
    for (const t of b.tools) {
      expect(t.lastSeen >= since).toBe(true);
    }
  });
});
