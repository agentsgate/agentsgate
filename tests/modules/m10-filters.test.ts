/**
 * Sprint v0.27 — T250–T254 filter and policy-evaluate tests.
 * Tests for:
 *   T250: GET /operations?tags=…  (AND tag filter)
 *   T251: GET /operations?minRisk=…&maxRisk=… (risk score range filter)
 *   T252: GET /operations/export?format=ndjson (NDJSON export)
 *   T254: POST /policy/evaluate (dry-eval against loaded policy, 503 when no policy)
 */
import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { StateStore } from '../../src/modules/m2-store/index.js';
import { DashboardAPI } from '../../src/modules/m10-dashboard/index.js';
import type { OperationLog, MCPOperation, ProxyDecision } from '../../src/types/interfaces.js';
import type { AgentsGatePolicy } from '../../src/policy.js';

// Ports come from start(0). A hand-picked base sits inside the OS ephemeral
// range (49152-65535), so a concurrent listen(0) can be handed the same number
// and this suite loses the race with EADDRINUSE.

// ── helpers ───────────────────────────────────────────────────────────────────

interface SetupResult {
  dash: DashboardAPI;
  port: number;
  store: StateStore;
  tmpDir: string;
}

async function setup(policy?: AgentsGatePolicy): Promise<SetupResult> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'as-filt-'));
  const store = new StateStore(path.join(tmpDir, 'test.db'));
  await store.initialize();
  const dash = new DashboardAPI(store, policy ? { policy } : {});
  await dash.start(0);
  const port = dash.getPort();
  return { dash, port, store, tmpDir };
}

async function teardown(ctx: SetupResult): Promise<void> {
  await ctx.dash.stop();
  await ctx.store.close();
  await fs.rm(ctx.tmpDir, { recursive: true, force: true });
}

/** Build a minimal OperationLog with overridable fields. */
function makeLog(overrides: {
  id?: string;
  agentId?: string;
  tool?: string;
  method?: string;
  riskScore?: number;
  action?: ProxyDecision['action'];
  tags?: string[];
}): OperationLog {
  const id = overrides.id ?? crypto.randomUUID();
  const op: MCPOperation = {
    id,
    agentId: overrides.agentId ?? 'agent-test',
    tool: overrides.tool ?? 'filesystem',
    method: overrides.method ?? 'read_file',
    params: {},
    timestamp: new Date(),
    sessionId: 'sess-1',
    tags: overrides.tags,
  };
  const decision: ProxyDecision = {
    action: overrides.action ?? 'allow',
    riskScore: overrides.riskScore ?? 0.5,
    reasons: [],
  };
  return {
    operationId: id,
    operation: op,
    decision,
    createdAt: new Date(),
  };
}

async function getJSON(
  port: number,
  p: string
): Promise<{ status: number; headers: Record<string, string | null>; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${p}`);
  return {
    status: res.status,
    headers: { 'content-type': res.headers.get('content-type') },
    body: await res.json(),
  };
}

async function getRaw(
  port: number,
  p: string
): Promise<{ status: number; contentType: string | null; text: string }> {
  const res = await fetch(`http://127.0.0.1:${port}${p}`);
  return {
    status: res.status,
    contentType: res.headers.get('content-type'),
    text: await res.text(),
  };
}

async function postJSON(
  port: number,
  p: string,
  body: unknown
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('DashboardAPI — T251 minRisk / maxRisk filter', () => {
  let ctx: SetupResult;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('1. GET /operations?minRisk=0.8 — only returns ops with riskScore >= 0.8', async () => {
    ctx = await setup();
    await ctx.store.saveOperationLog(makeLog({ id: 'op-low',  riskScore: 0.2 }));
    await ctx.store.saveOperationLog(makeLog({ id: 'op-mid',  riskScore: 0.5 }));
    await ctx.store.saveOperationLog(makeLog({ id: 'op-high', riskScore: 0.9 }));

    const { status, body } = await getJSON(ctx.port, '/operations?minRisk=0.8');
    expect(status).toBe(200);
    const b = body as { data: OperationLog[] };
    expect(b.data.every(l => l.decision.riskScore >= 0.8)).toBe(true);
    const ids = b.data.map(l => l.operationId);
    expect(ids).toContain('op-high');
    expect(ids).not.toContain('op-low');
    expect(ids).not.toContain('op-mid');
  });

  it('2. GET /operations?maxRisk=0.2 — only returns ops with riskScore <= 0.2', async () => {
    ctx = await setup();
    await ctx.store.saveOperationLog(makeLog({ id: 'op-low',  riskScore: 0.1 }));
    await ctx.store.saveOperationLog(makeLog({ id: 'op-mid',  riskScore: 0.5 }));
    await ctx.store.saveOperationLog(makeLog({ id: 'op-high', riskScore: 0.9 }));

    const { status, body } = await getJSON(ctx.port, '/operations?maxRisk=0.2');
    expect(status).toBe(200);
    const b = body as { data: OperationLog[] };
    expect(b.data.every(l => l.decision.riskScore <= 0.2)).toBe(true);
    const ids = b.data.map(l => l.operationId);
    expect(ids).toContain('op-low');
    expect(ids).not.toContain('op-mid');
    expect(ids).not.toContain('op-high');
  });

  it('3. GET /operations?minRisk=0.3&maxRisk=0.7 — only returns ops in range [0.3, 0.7]', async () => {
    ctx = await setup();
    await ctx.store.saveOperationLog(makeLog({ id: 'op-below', riskScore: 0.1 }));
    await ctx.store.saveOperationLog(makeLog({ id: 'op-in1',   riskScore: 0.3 }));
    await ctx.store.saveOperationLog(makeLog({ id: 'op-in2',   riskScore: 0.5 }));
    await ctx.store.saveOperationLog(makeLog({ id: 'op-in3',   riskScore: 0.7 }));
    await ctx.store.saveOperationLog(makeLog({ id: 'op-above', riskScore: 0.9 }));

    const { status, body } = await getJSON(ctx.port, '/operations?minRisk=0.3&maxRisk=0.7');
    expect(status).toBe(200);
    const b = body as { data: OperationLog[] };
    expect(b.data.every(l => l.decision.riskScore >= 0.3 && l.decision.riskScore <= 0.7)).toBe(true);
    const ids = b.data.map(l => l.operationId);
    expect(ids).toContain('op-in1');
    expect(ids).toContain('op-in2');
    expect(ids).toContain('op-in3');
    expect(ids).not.toContain('op-below');
    expect(ids).not.toContain('op-above');
  });
});

describe('DashboardAPI — T252 NDJSON export', () => {
  let ctx: SetupResult;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('4. GET /operations/export?format=ndjson — returns application/x-ndjson; each line is valid JSON with operationId', async () => {
    ctx = await setup();
    await ctx.store.saveOperationLog(makeLog({ id: 'ndjson-op-1' }));
    await ctx.store.saveOperationLog(makeLog({ id: 'ndjson-op-2' }));
    await ctx.store.saveOperationLog(makeLog({ id: 'ndjson-op-3' }));

    const { status, contentType, text } = await getRaw(ctx.port, '/operations/export?format=ndjson');
    expect(status).toBe(200);
    expect(contentType).toMatch(/application\/x-ndjson/);

    // Split on newlines, drop trailing empty line
    const lines = text.split('\n').filter(l => l.trim().length > 0);
    expect(lines.length).toBe(3);

    for (const line of lines) {
      let parsed: unknown;
      expect(() => { parsed = JSON.parse(line); }).not.toThrow();
      expect((parsed as Record<string, unknown>)['operationId']).toBeDefined();
      expect(typeof (parsed as Record<string, unknown>)['operationId']).toBe('string');
    }

    const ids = lines.map(l => (JSON.parse(l) as { operationId: string }).operationId);
    expect(ids).toContain('ndjson-op-1');
    expect(ids).toContain('ndjson-op-2');
    expect(ids).toContain('ndjson-op-3');
  });
});

describe('DashboardAPI — T254 POST /policy/evaluate', () => {
  let ctx: SetupResult;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('5. POST /policy/evaluate returns 503 when no policy configured', async () => {
    ctx = await setup(); // no policy option
    const { status, body } = await postJSON(ctx.port, '/policy/evaluate', {
      tool: 'filesystem',
      method: 'write_file',
    });
    expect(status).toBe(503);
    expect((body as Record<string, unknown>)['error']).toBeDefined();
  });

  it('6. POST /policy/evaluate returns {score, action, matched:true} when policy has a matching rule', async () => {
    const policy: AgentsGatePolicy = {
      rules: [
        {
          id: 'TEST_BLOCK_DELETE',
          match: { tool: 'filesystem', method: 'delete_file' },
          action: 'block',
          score: 0.95,
        },
      ],
    };
    ctx = await setup(policy);

    const { status, body } = await postJSON(ctx.port, '/policy/evaluate', {
      tool: 'filesystem',
      method: 'delete_file',
      agentId: 'agent-x',
      sessionId: 'sess-x',
    });

    expect(status).toBe(200);
    const b = body as { score: number | null; action: string | null; matched: boolean; redactKeys: string[] };
    expect(b.matched).toBe(true);
    // The rule sets both score and action, so at least one should be non-null
    expect(b.score !== null || b.action !== null).toBe(true);
    // action should be 'block' per our rule
    expect(b.action).toBe('block');
    // score should be 0.95
    expect(b.score).toBeCloseTo(0.95, 5);
  });
});

describe('DashboardAPI — T250 tag filter', () => {
  let ctx: SetupResult;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('7. GET /operations?tags=urgent — only returns ops that have "urgent" in their tags', async () => {
    ctx = await setup();
    // ops with the 'urgent' tag
    await ctx.store.saveOperationLog(makeLog({ id: 'tagged-1',   tags: ['urgent'] }));
    await ctx.store.saveOperationLog(makeLog({ id: 'tagged-2',   tags: ['urgent', 'pci'] }));
    // ops without 'urgent'
    await ctx.store.saveOperationLog(makeLog({ id: 'untagged-1', tags: [] }));
    await ctx.store.saveOperationLog(makeLog({ id: 'untagged-2', tags: ['pci'] }));
    await ctx.store.saveOperationLog(makeLog({ id: 'untagged-3' })); // no tags field at all

    const { status, body } = await getJSON(ctx.port, '/operations?tags=urgent');
    expect(status).toBe(200);
    const b = body as { data: OperationLog[] };

    const ids = b.data.map(l => l.operationId);
    expect(ids).toContain('tagged-1');
    expect(ids).toContain('tagged-2');
    expect(ids).not.toContain('untagged-1');
    expect(ids).not.toContain('untagged-2');
    expect(ids).not.toContain('untagged-3');

    // All returned ops must have 'urgent' in their tags
    for (const log of b.data) {
      expect(log.operation.tags).toBeDefined();
      expect(log.operation.tags).toContain('urgent');
    }
  });
});
