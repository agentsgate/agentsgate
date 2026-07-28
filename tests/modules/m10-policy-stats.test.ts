/**
 * T216 — Dashboard GET /policy/stats endpoint.
 * Tests for ruleHitCounts tracking via recordFiredRules() and the /policy/stats route.
 */
import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { StateStore } from '../../src/modules/m2-store/index.js';
import { DashboardAPI } from '../../src/modules/m10-dashboard/index.js';

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

async function setup(): Promise<SetupResult> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'as-ps-'));
  const store = new StateStore(path.join(tmpDir, 'test.db'));
  await store.initialize();
  const dash = new DashboardAPI(store, {});
  await dash.start(0);
  const port = dash.getPort();
  return { dash, port, store, tmpDir };
}

async function teardown(ctx: SetupResult): Promise<void> {
  await ctx.dash.stop();
  await ctx.store.close();
  await fs.rm(ctx.tmpDir, { recursive: true, force: true });
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

type StatsBody = {
  rules: Array<{ ruleId: string; hits: number }>;
  totalRules: number;
};

// ── tests ─────────────────────────────────────────────────────────────────────

describe('DashboardAPI — GET /policy/stats', () => {
  let ctx: SetupResult;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('1. fresh dashboard returns { rules: [], totalRules: 0 }', async () => {
    ctx = await setup();
    const { status, body } = await getJSON(ctx.port, '/policy/stats');
    expect(status).toBe(200);
    const b = body as StatsBody;
    expect(b.rules).toEqual([]);
    expect(b.totalRules).toBe(0);
  });

  it('2. recordFiredRules called once with one rule → hits = 1', async () => {
    ctx = await setup();
    ctx.dash.recordFiredRules(['rule-a']);
    const { status, body } = await getJSON(ctx.port, '/policy/stats');
    expect(status).toBe(200);
    const b = body as StatsBody;
    expect(b.totalRules).toBe(1);
    expect(b.rules).toHaveLength(1);
    expect(b.rules[0]).toEqual({ ruleId: 'rule-a', hits: 1 });
  });

  it('3. same rule recorded 3 times across separate calls → hits = 3', async () => {
    ctx = await setup();
    ctx.dash.recordFiredRules(['rule-b']);
    ctx.dash.recordFiredRules(['rule-b']);
    ctx.dash.recordFiredRules(['rule-b']);
    const { status, body } = await getJSON(ctx.port, '/policy/stats');
    expect(status).toBe(200);
    const b = body as StatsBody;
    expect(b.totalRules).toBe(1);
    const entry = b.rules.find(r => r.ruleId === 'rule-b');
    expect(entry).toBeDefined();
    expect(entry!.hits).toBe(3);
  });

  it('4. two rules with different hit counts → sorted by hits descending', async () => {
    ctx = await setup();
    // rule-high: 5 hits, rule-low: 2 hits
    ctx.dash.recordFiredRules(['rule-high']);
    ctx.dash.recordFiredRules(['rule-high']);
    ctx.dash.recordFiredRules(['rule-high']);
    ctx.dash.recordFiredRules(['rule-high']);
    ctx.dash.recordFiredRules(['rule-high']);
    ctx.dash.recordFiredRules(['rule-low']);
    ctx.dash.recordFiredRules(['rule-low']);
    const { status, body } = await getJSON(ctx.port, '/policy/stats');
    expect(status).toBe(200);
    const b = body as StatsBody;
    expect(b.totalRules).toBe(2);
    expect(b.rules).toHaveLength(2);
    expect(b.rules[0].ruleId).toBe('rule-high');
    expect(b.rules[0].hits).toBe(5);
    expect(b.rules[1].ruleId).toBe('rule-low');
    expect(b.rules[1].hits).toBe(2);
  });

  it('5. recordFiredRules([]) is a no-op — no entries added, totalRules stays 0', async () => {
    ctx = await setup();
    ctx.dash.recordFiredRules([]);
    ctx.dash.recordFiredRules([]);
    const { status, body } = await getJSON(ctx.port, '/policy/stats');
    expect(status).toBe(200);
    const b = body as StatsBody;
    expect(b.rules).toEqual([]);
    expect(b.totalRules).toBe(0);
  });

  it('6. multiple rules in a single call → all recorded with hits = 1', async () => {
    ctx = await setup();
    ctx.dash.recordFiredRules(['rule-x', 'rule-y', 'rule-z']);
    const { status, body } = await getJSON(ctx.port, '/policy/stats');
    expect(status).toBe(200);
    const b = body as StatsBody;
    expect(b.totalRules).toBe(3);
    expect(b.rules).toHaveLength(3);
    const ruleIds = b.rules.map(r => r.ruleId);
    expect(ruleIds).toContain('rule-x');
    expect(ruleIds).toContain('rule-y');
    expect(ruleIds).toContain('rule-z');
    for (const r of b.rules) {
      expect(r.hits).toBe(1);
    }
  });

  it('7. response has status 200 and content-type application/json', async () => {
    ctx = await setup();
    ctx.dash.recordFiredRules(['rule-ct']);
    const { status, headers } = await getJSON(ctx.port, '/policy/stats');
    expect(status).toBe(200);
    expect(headers['content-type']).toMatch(/application\/json/);
  });
});
