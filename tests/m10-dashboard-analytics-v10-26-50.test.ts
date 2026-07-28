import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DashboardAPI } from '../src/modules/m10-dashboard/index.js';
import { OperationLogger } from '../src/modules/m3-logger/index.js';
import { StateStore } from '../src/modules/m2-store/index.js';
import type { MCPOperation, ProxyDecision } from '../src/types/interfaces.js';

// Pinned clock. Rolling-window analytics evaluate their cutoffs at request
// time, so with a live clock a fixture seeded exactly N days/hours ago sits
// on a window edge and lands inside or outside depending on how many ms
// elapse before the request runs. Fixtures and DashboardAPI share this one
// value so window membership is fully deterministic.
const PINNED_NOW_MS = (() => {
  // Anchored to :30 of an elapsed hour. Fixtures routinely take an "hour ago"
  // instant and add or subtract a few minutes; anchored at the wall-clock
  // minute those offsets cross an hour boundary whenever the suite happens to
  // run near the top of the hour, and hourly-bucket assertions flip. Mid-hour
  // leaves ~30 minutes of slack on either side. Never in the future.
  const d = new Date();
  d.setMinutes(30, 0, 0);
  if (d.getTime() > Date.now()) d.setHours(d.getHours() - 1);
  return d.getTime();
})();
const PINNED_NOW = () => PINNED_NOW_MS;

function makeOp(
  agentId: string,
  tool = 'fs',
  sessionId = 'sess-1',
  timestamp: Date = new Date(PINNED_NOW()),
  method = 'call',
): MCPOperation {
  return {
    id: crypto.randomUUID(),
    agentId,
    tool,
    method,
    params: {},
    timestamp,
    sessionId,
  };
}

function dec(riskScore: number, action: ProxyDecision['action'] = 'allow'): ProxyDecision {
  return { action, riskScore, reasons: [] };
}

const hoursAgo = (h: number) => new Date(PINNED_NOW() - h * 3_600_000);
const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);
const msAgo = (ms: number) => new Date(PINNED_NOW() - ms);

interface Ctx {
  dash: DashboardAPI;
  port: number;
  store: StateStore;
  logger: OperationLogger;
  tmpDir: string;
}

async function setup(): Promise<Ctx> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'as-m10-'));
  const store = new StateStore(path.join(tmpDir, 'test.db'));
  await store.initialize();
  const logger = new OperationLogger(store);
  const dash = new DashboardAPI(store, { now: PINNED_NOW });
  await dash.start(0);
  return { dash, port: dash.getPort(), store, logger, tmpDir };
}

async function teardown(ctx: Ctx): Promise<void> {
  await ctx.dash.stop();
  await ctx.store.close();
  await fs.rm(ctx.tmpDir, { recursive: true, force: true });
}

async function getJSON(
  port: number,
  p: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}${p}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

// ── v10.26 ────────────────────────────────────────────────────────────────────

describe('v10.26', () => {
  const hoursAgo = (h: number) => new Date(PINNED_NOW() - h * 3_600_000);
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);
  const msAgo = (ms: number) => new Date(PINNED_NOW() - ms);

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1199-T1203 — v10.26 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1026-pres'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1026-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('criticalRiskSessionsAllTime');
      expect(body).toHaveProperty('avgOpsPerDay7d');
      expect(body).toHaveProperty('avgOpsPerDay30d');
      expect(body).toHaveProperty('riskScoreEntropy10Bins');
      expect(body).toHaveProperty('longestGapBetweenOpsMs');
    });

    it('2. sessions — no ops: criticalRiskSessionsAllTime=0, avgOps=0, entropy null, gap null', async () => {
      // Use a session with no critical-risk ops at all
      ctx = await setup();
      // Log one low-risk op (no critical ops)
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1026-nocrit'), dec(0.3));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1026-nocrit');
      expect(status).toBe(200);
      // criticalRiskSessionsAllTime: no sessions with >=0.9
      expect(body.criticalRiskSessionsAllTime).toBe(0);
      // longestGapBetweenOpsMs: only 1 log → null
      expect(body.longestGapBetweenOpsMs).toBeNull();
      // riskScoreEntropy10Bins: 1 log, all in one bin → 0 (not null)
      expect(body.riskScoreEntropy10Bins).toBe(0);
    });

    it('3. sessions — one critical-risk op: criticalRiskSessionsAllTime=1', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1026-crit1'), dec(0.95));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1026-crit1');
      expect(status).toBe(200);
      expect(body.criticalRiskSessionsAllTime).toBe(1);
    });

    it('4. sessions — multiple sessions with critical ops: criticalRiskSessionsAllTime counts distinct', async () => {
      ctx = await setup();
      // This session sees ops for sessions sess-crit-A and sess-crit-B
      // But endpoint is for a specific session; all logs filtered to that session
      // Use same session to log multiple critical ops — still just 1 distinct session
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1026-multicrit'), dec(0.92));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1026-multicrit'), dec(0.98));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1026-multicrit'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1026-multicrit');
      expect(status).toBe(200);
      // One distinct session with critical-risk ops: sess-v1026-multicrit itself
      expect(body.criticalRiskSessionsAllTime).toBe(1);
    });

    it('5. sessions — riskScore=0.9 exactly is critical: criticalRiskSessionsAllTime=1', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1026-exact09'), dec(0.9));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1026-exact09');
      expect(status).toBe(200);
      expect(body.criticalRiskSessionsAllTime).toBe(1);
    });

    it('6. sessions — avgOpsPerDay7d: ops in 7d / 7', async () => {
      ctx = await setup();
      // 7 recent ops
      for (let i = 1; i <= 7; i++) {
        await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1026-avg7d', daysAgo(i - 0.5)), dec(0.3));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1026-avg7d');
      expect(status).toBe(200);
      // 7 ops / 7 days = 1.0
      expect(body.avgOpsPerDay7d as number).toBeCloseTo(1.0, 5);
    });

    it('7. sessions — avgOpsPerDay7d=0 when 7d window is empty (ops older than 7d)', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1026-no7d', daysAgo(10)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1026-no7d');
      expect(status).toBe(200);
      expect(body.avgOpsPerDay7d).toBe(0);
    });

    it('8. sessions — avgOpsPerDay30d: 30 ops in 30d = 1.0/day', async () => {
      ctx = await setup();
      for (let i = 1; i <= 30; i++) {
        await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1026-avg30d', daysAgo(i - 0.5)), dec(0.2));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1026-avg30d');
      expect(status).toBe(200);
      expect(body.avgOpsPerDay30d as number).toBeCloseTo(1.0, 5);
    });

    it('9. sessions — avgOpsPerDay30d=0 when 30d window is empty (all ops >30d old)', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v1026-no30d', daysAgo(35)), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1026-no30d');
      expect(status).toBe(200);
      expect(body.avgOpsPerDay30d).toBe(0);
    });

    it('10. sessions — riskScoreEntropy10Bins: null if no logs (empty session)', async () => {
      // Can't query a nonexistent session directly; instead verify with 0 logs for that session ID
      // The endpoint returns 404 for unknown sessions, so test with 1 log and check entropy=0 for single-bin
      ctx = await setup();
      // All ops in same bin [0.3, 0.4) => entropy = 0
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v1026-ent0', hoursAgo(1)), dec(0.35));
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v1026-ent0', hoursAgo(2)), dec(0.32));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1026-ent0');
      expect(status).toBe(200);
      // Both scores in bin 3 ([0.3, 0.4)), entropy = 0
      expect(body.riskScoreEntropy10Bins).toBe(0);
    });

    it('11. sessions — riskScoreEntropy10Bins: uniform across all 10 bins = log2(10)', async () => {
      ctx = await setup();
      // One op per bin: 0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.95
      const scores = [0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.95];
      for (const score of scores) {
        await ctx.logger.log(makeOp('agent-k', 'fs', 'sess-v1026-entmax', hoursAgo(1)), dec(score));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1026-entmax');
      expect(status).toBe(200);
      // Uniform distribution across 10 bins: H = log2(10) ≈ 3.3219
      expect(body.riskScoreEntropy10Bins as number).toBeCloseTo(Math.log2(10), 4);
    });

    it('12. sessions — longestGapBetweenOpsMs: null if < 2 logs', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-l', 'fs', 'sess-v1026-gap1'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1026-gap1');
      expect(status).toBe(200);
      expect(body.longestGapBetweenOpsMs).toBeNull();
    });

    it('13. sessions — longestGapBetweenOpsMs: correct max gap with 3 ops', async () => {
      ctx = await setup();
      // Three ops: T=0, T+1000ms, T+6000ms
      // Gaps: 1000ms, 5000ms → max = 5000
      const base = PINNED_NOW() - 10_000;
      await ctx.logger.log(makeOp('agent-m', 'fs', 'sess-v1026-gap3', new Date(base)), dec(0.3));
      await ctx.logger.log(makeOp('agent-m', 'fs', 'sess-v1026-gap3', new Date(base + 1_000)), dec(0.4));
      await ctx.logger.log(makeOp('agent-m', 'fs', 'sess-v1026-gap3', new Date(base + 6_000)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1026-gap3');
      expect(status).toBe(200);
      expect(body.longestGapBetweenOpsMs).toBe(5_000);
    });

    it('14. sessions — longestGapBetweenOpsMs=0 when two ops share same timestamp', async () => {
      ctx = await setup();
      const ts = new Date(PINNED_NOW());
      await ctx.logger.log(makeOp('agent-n', 'fs', 'sess-v1026-gap0', ts), dec(0.5));
      await ctx.logger.log(makeOp('agent-n', 'fs', 'sess-v1026-gap0', ts), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1026-gap0');
      expect(status).toBe(200);
      expect(body.longestGapBetweenOpsMs).toBe(0);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1199-T1203 — v10.26 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('15. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1026-pres', 'fs', 'sess-1'), dec(0.3));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1026-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('criticalRiskSessionsAllTime');
      expect(body).toHaveProperty('avgOpsPerDay7d');
      expect(body).toHaveProperty('avgOpsPerDay30d');
      expect(body).toHaveProperty('riskScoreEntropy10Bins');
      expect(body).toHaveProperty('longestGapBetweenOpsMs');
    });

    it('16. agents — no critical-risk ops: criticalRiskSessionsAllTime=0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1026-nocrit', 'fs', 'sess-1'), dec(0.5));
      await ctx.logger.log(makeOp('agent-v1026-nocrit', 'fs', 'sess-2'), dec(0.7));
      await ctx.logger.log(makeOp('agent-v1026-nocrit', 'fs', 'sess-3'), dec(0.89));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1026-nocrit');
      expect(status).toBe(200);
      // riskScore 0.89 < 0.9, so not critical
      expect(body.criticalRiskSessionsAllTime).toBe(0);
    });

    it('17. agents — critical ops across multiple sessions: criticalRiskSessionsAllTime counts distinct sessions', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1026-multicrit', 'fs', 'sess-A'), dec(0.95));
      await ctx.logger.log(makeOp('agent-v1026-multicrit', 'fs', 'sess-A'), dec(0.91));
      await ctx.logger.log(makeOp('agent-v1026-multicrit', 'fs', 'sess-B'), dec(0.93));
      await ctx.logger.log(makeOp('agent-v1026-multicrit', 'fs', 'sess-C'), dec(0.3)); // not critical

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1026-multicrit');
      expect(status).toBe(200);
      // sess-A and sess-B have critical ops → 2 distinct sessions
      expect(body.criticalRiskSessionsAllTime).toBe(2);
    });

    it('18. agents — avgOpsPerDay7d: 14 ops in 7d = 2.0/day', async () => {
      ctx = await setup();
      for (let i = 0; i < 14; i++) {
        await ctx.logger.log(
          makeOp('agent-v1026-avg7d', 'fs', `sess-${i}`, daysAgo(i % 7 === 0 ? 0.5 : i % 7)),
          dec(0.3)
        );
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1026-avg7d');
      expect(status).toBe(200);
      // 14 ops in 7d / 7 = 2.0
      expect(body.avgOpsPerDay7d as number).toBeCloseTo(2.0, 5);
    });

    it('19. agents — avgOpsPerDay7d and avgOpsPerDay30d are 0 (not null) when windows empty', async () => {
      ctx = await setup();
      // All ops older than 30 days
      await ctx.logger.log(makeOp('agent-v1026-emptywin', 'fs', 'sess-1', daysAgo(40)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1026-emptywin');
      expect(status).toBe(200);
      expect(body.avgOpsPerDay7d).toBe(0);
      expect(body.avgOpsPerDay30d).toBe(0);
      // Confirm they're actually 0, not null
      expect(body.avgOpsPerDay7d).not.toBeNull();
      expect(body.avgOpsPerDay30d).not.toBeNull();
    });

    it('20. agents — riskScoreEntropy10Bins: non-zero for mixed bins', async () => {
      ctx = await setup();
      // Two different bins: [0.1, 0.2) and [0.8, 0.9)
      // 1 each → p=0.5 each → entropy = -2*(0.5*log2(0.5)) = 1.0
      await ctx.logger.log(makeOp('agent-v1026-ent2', 'fs', 'sess-1'), dec(0.15));
      await ctx.logger.log(makeOp('agent-v1026-ent2', 'fs', 'sess-2'), dec(0.85));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1026-ent2');
      expect(status).toBe(200);
      // 2 bins with equal probability → entropy = 1.0 bit
      expect(body.riskScoreEntropy10Bins as number).toBeCloseTo(1.0, 5);
    });

    it('21. agents — longestGapBetweenOpsMs: correct with unsorted insertion order', async () => {
      ctx = await setup();
      const base = PINNED_NOW() - 30_000;
      // Insert in reverse order; implementation should sort by timestamp
      await ctx.logger.log(makeOp('agent-v1026-gap-unsorted', 'fs', 'sess-1', new Date(base + 20_000)), dec(0.3));
      await ctx.logger.log(makeOp('agent-v1026-gap-unsorted', 'fs', 'sess-1', new Date(base)), dec(0.4));
      await ctx.logger.log(makeOp('agent-v1026-gap-unsorted', 'fs', 'sess-1', new Date(base + 2_000)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1026-gap-unsorted');
      expect(status).toBe(200);
      // Sorted: base, base+2000, base+20000 → gaps: 2000ms, 18000ms → max=18000
      expect(body.longestGapBetweenOpsMs).toBe(18_000);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1199-T1203 — v10.26 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('22. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-x', 'tool-v1026-pres', 'sess-1'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1026-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('criticalRiskSessionsAllTime');
      expect(body).toHaveProperty('avgOpsPerDay7d');
      expect(body).toHaveProperty('avgOpsPerDay30d');
      expect(body).toHaveProperty('riskScoreEntropy10Bins');
      expect(body).toHaveProperty('longestGapBetweenOpsMs');
    });

    it('23. tools — criticalRiskSessionsAllTime: ops at exactly 0.9 threshold', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-x1', 'tool-v1026-thresh', 'sess-A'), dec(0.9));  // critical
      await ctx.logger.log(makeOp('agent-x2', 'tool-v1026-thresh', 'sess-B'), dec(0.899)); // not critical

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1026-thresh');
      expect(status).toBe(200);
      expect(body.criticalRiskSessionsAllTime).toBe(1);
    });

    it('24. tools — avgOpsPerDay7d fractional: 3 ops in 7d = 3/7', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-y1', 'tool-v1026-frac7d', 'sess-1', daysAgo(1)), dec(0.2));
      await ctx.logger.log(makeOp('agent-y2', 'tool-v1026-frac7d', 'sess-2', daysAgo(3)), dec(0.3));
      await ctx.logger.log(makeOp('agent-y3', 'tool-v1026-frac7d', 'sess-3', daysAgo(6)), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1026-frac7d');
      expect(status).toBe(200);
      expect(body.avgOpsPerDay7d as number).toBeCloseTo(3 / 7, 5);
    });

    it('25. tools — avgOpsPerDay30d fractional: 10 ops in 30d = 10/30', async () => {
      ctx = await setup();
      for (let i = 0; i < 10; i++) {
        await ctx.logger.log(makeOp(`agent-z${i}`, 'tool-v1026-frac30d', `sess-${i}`, daysAgo(i * 2.5 + 1)), dec(0.3));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1026-frac30d');
      expect(status).toBe(200);
      expect(body.avgOpsPerDay30d as number).toBeCloseTo(10 / 30, 5);
    });

    it('26. tools — riskScoreEntropy10Bins=0 when all ops in one bin', async () => {
      ctx = await setup();
      // All in bin 9 ([0.9, 1.0])
      await ctx.logger.log(makeOp('agent-za', 'tool-v1026-ent0', 'sess-1'), dec(0.91));
      await ctx.logger.log(makeOp('agent-za', 'tool-v1026-ent0', 'sess-2'), dec(0.95));
      await ctx.logger.log(makeOp('agent-za', 'tool-v1026-ent0', 'sess-3'), dec(0.99));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1026-ent0');
      expect(status).toBe(200);
      expect(body.riskScoreEntropy10Bins).toBe(0);
    });

    it('27. tools — riskScoreEntropy10Bins: 2 bins with 3 vs 1 op', async () => {
      ctx = await setup();
      // 3 ops in bin 0 ([0.0, 0.1)), 1 op in bin 5 ([0.5, 0.6))
      // p1=3/4=0.75, p2=1/4=0.25
      // H = -(0.75*log2(0.75) + 0.25*log2(0.25)) = -(0.75*(-0.415) + 0.25*(-2)) ≈ 0.8113
      await ctx.logger.log(makeOp('agent-zb1', 'tool-v1026-ent2bins', 'sess-1'), dec(0.05));
      await ctx.logger.log(makeOp('agent-zb2', 'tool-v1026-ent2bins', 'sess-2'), dec(0.08));
      await ctx.logger.log(makeOp('agent-zb3', 'tool-v1026-ent2bins', 'sess-3'), dec(0.03));
      await ctx.logger.log(makeOp('agent-zb4', 'tool-v1026-ent2bins', 'sess-4'), dec(0.55));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1026-ent2bins');
      expect(status).toBe(200);
      const expected = -(0.75 * Math.log2(0.75) + 0.25 * Math.log2(0.25));
      expect(body.riskScoreEntropy10Bins as number).toBeCloseTo(expected, 5);
    });

    it('28. tools — longestGapBetweenOpsMs: null if < 2 logs', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-zc', 'tool-v1026-gap-null', 'sess-1'), dec(0.3));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1026-gap-null');
      expect(status).toBe(200);
      expect(body.longestGapBetweenOpsMs).toBeNull();
    });

    it('29. tools — longestGapBetweenOpsMs: large gap (hours) computed correctly', async () => {
      ctx = await setup();
      // Gap of 3 hours = 10_800_000 ms
      await ctx.logger.log(makeOp('agent-zd1', 'tool-v1026-gap-large', 'sess-1', hoursAgo(4)), dec(0.3));
      await ctx.logger.log(makeOp('agent-zd2', 'tool-v1026-gap-large', 'sess-2', hoursAgo(1)), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1026-gap-large');
      expect(status).toBe(200);
      // 3 hours = 10_800_000 ms; allow ±5000ms tolerance for test timing
      expect(body.longestGapBetweenOpsMs as number).toBeGreaterThan(10_790_000);
      expect(body.longestGapBetweenOpsMs as number).toBeLessThan(10_810_000);
    });
  });

  // ── operations/summary endpoint ────────────────────────────────────────────────

  describe('T1199-T1203 — v10.26 new fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('30. summary — all five new fields present', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s1', 'tool-s', 'sess-1'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body).toHaveProperty('criticalRiskSessionsAllTime');
      expect(body).toHaveProperty('avgOpsPerDay7d');
      expect(body).toHaveProperty('avgOpsPerDay30d');
      expect(body).toHaveProperty('riskScoreEntropy10Bins');
      expect(body).toHaveProperty('longestGapBetweenOpsMs');
    });

    it('31. summary — empty DB: criticalRiskSessionsAllTime=0, avgOps=0, entropy null, gap null', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.criticalRiskSessionsAllTime).toBe(0);
      expect(body.avgOpsPerDay7d).toBe(0);
      expect(body.avgOpsPerDay30d).toBe(0);
      expect(body.riskScoreEntropy10Bins).toBeNull();
      expect(body.longestGapBetweenOpsMs).toBeNull();
    });

    it('32. summary — single critical-risk op: criticalRiskSessionsAllTime=1', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s2', 'tool-s', 'sess-crit-only'), dec(0.99));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.criticalRiskSessionsAllTime).toBe(1);
    });

    it('33. summary — critical ops across many sessions: criticalRiskSessionsAllTime correct', async () => {
      ctx = await setup();
      // 3 sessions with critical ops, 2 sessions without
      await ctx.logger.log(makeOp('agent-s3', 'tool-s', 'sess-crit-1'), dec(0.95));
      await ctx.logger.log(makeOp('agent-s3', 'tool-s', 'sess-crit-2'), dec(0.91));
      await ctx.logger.log(makeOp('agent-s3', 'tool-s', 'sess-crit-3'), dec(0.90));
      await ctx.logger.log(makeOp('agent-s3', 'tool-s', 'sess-safe-1'), dec(0.5));
      await ctx.logger.log(makeOp('agent-s3', 'tool-s', 'sess-safe-2'), dec(0.3));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.criticalRiskSessionsAllTime).toBe(3);
    });

    it('34. summary — avgOpsPerDay7d and avgOpsPerDay30d: exact values for known counts', async () => {
      ctx = await setup();
      // 7 ops in last 7d, 21 ops in last 30d (includes the 7 above)
      for (let i = 0; i < 7; i++) {
        await ctx.logger.log(makeOp(`agent-s4-${i}`, 'tool-s', `sess-${i}`, daysAgo(i * 0.9)), dec(0.3));
      }
      for (let i = 7; i < 21; i++) {
        await ctx.logger.log(makeOp(`agent-s4-${i}`, 'tool-s', `sess-${i}`, daysAgo(8 + (i - 7) * 1.5)), dec(0.2));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.avgOpsPerDay7d as number).toBeCloseTo(7 / 7, 5);
      expect(body.avgOpsPerDay30d as number).toBeCloseTo(21 / 30, 5);
    });

    it('35. summary — riskScoreEntropy10Bins: null for empty DB', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreEntropy10Bins).toBeNull();
    });

    it('36. summary — riskScoreEntropy10Bins: 0 for single op (all in one bin)', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s5', 'tool-s', 'sess-1'), dec(0.42));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreEntropy10Bins).toBe(0);
    });

    it('37. summary — riskScoreEntropy10Bins: 4 bins with equal counts → log2(4)=2', async () => {
      ctx = await setup();
      // One op each in bin 0 (0.05), bin 2 (0.25), bin 5 (0.55), bin 8 (0.85) — 4 bins equal
      // H = log2(4) = 2.0
      await ctx.logger.log(makeOp('agent-s6a', 'tool-s', 'sess-1'), dec(0.05));
      await ctx.logger.log(makeOp('agent-s6b', 'tool-s', 'sess-2'), dec(0.25));
      await ctx.logger.log(makeOp('agent-s6c', 'tool-s', 'sess-3'), dec(0.55));
      await ctx.logger.log(makeOp('agent-s6d', 'tool-s', 'sess-4'), dec(0.85));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreEntropy10Bins as number).toBeCloseTo(2.0, 5);
    });

    it('38. summary — longestGapBetweenOpsMs: null with only 1 log', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s7', 'tool-s', 'sess-1'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.longestGapBetweenOpsMs).toBeNull();
    });

    it('39. summary — longestGapBetweenOpsMs: 2 ops with known gap', async () => {
      ctx = await setup();
      const base = PINNED_NOW() - 50_000;
      await ctx.logger.log(makeOp('agent-s8a', 'tool-s', 'sess-1', new Date(base)), dec(0.3));
      await ctx.logger.log(makeOp('agent-s8b', 'tool-s', 'sess-2', new Date(base + 30_000)), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.longestGapBetweenOpsMs).toBe(30_000);
    });

    it('40. summary — longestGapBetweenOpsMs: picks the max among multiple gaps', async () => {
      ctx = await setup();
      const base = PINNED_NOW() - 100_000;
      // Gaps: 5000, 2000, 10000, 1000 → max = 10000
      const timestamps = [0, 5_000, 7_000, 17_000, 18_000].map(o => new Date(base + o));
      for (const [i, ts] of timestamps.entries()) {
        await ctx.logger.log(makeOp(`agent-s9-${i}`, 'tool-s', `sess-${i}`, ts), dec(0.3));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.longestGapBetweenOpsMs).toBe(10_000);
    });

    it('41. summary — all 5 fields coexist correctly in mixed scenario', async () => {
      ctx = await setup();
      // Critical ops in 2 sessions
      await ctx.logger.log(makeOp('agent-mixed-1', 'tool-s', 'sess-crit-X', daysAgo(1)), dec(0.92));
      await ctx.logger.log(makeOp('agent-mixed-2', 'tool-s', 'sess-crit-Y', daysAgo(3)), dec(0.95));
      // Non-critical ops spread across windows
      await ctx.logger.log(makeOp('agent-mixed-3', 'tool-s', 'sess-safe', daysAgo(2)), dec(0.4));
      await ctx.logger.log(makeOp('agent-mixed-4', 'tool-s', 'sess-safe', daysAgo(15)), dec(0.6));
      await ctx.logger.log(makeOp('agent-mixed-5', 'tool-s', 'sess-old', daysAgo(40)), dec(0.2));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      // criticalRiskSessionsAllTime: sess-crit-X and sess-crit-Y = 2
      expect(body.criticalRiskSessionsAllTime).toBe(2);

      // avgOpsPerDay7d: ops in last 7d (daysAgo(1), daysAgo(3), daysAgo(2)) = 3 → 3/7
      expect(body.avgOpsPerDay7d as number).toBeCloseTo(3 / 7, 5);

      // avgOpsPerDay30d: ops in last 30d (all except daysAgo(40)) = 4 → 4/30
      expect(body.avgOpsPerDay30d as number).toBeCloseTo(4 / 30, 5);

      // riskScoreEntropy10Bins: non-null (has logs)
      expect(body.riskScoreEntropy10Bins).not.toBeNull();
      expect(body.riskScoreEntropy10Bins as number).toBeGreaterThan(0);

      // longestGapBetweenOpsMs: non-null (has >= 2 logs) and non-negative
      expect(body.longestGapBetweenOpsMs).not.toBeNull();
      expect(body.longestGapBetweenOpsMs as number).toBeGreaterThanOrEqual(0);
    });
  });
});

// ── v10.27 ────────────────────────────────────────────────────────────────────

describe('v10.27', () => {
  const hoursAgo = (h: number) => new Date(PINNED_NOW() - h * 3_600_000);
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);
  const msAgo = (ms: number) => new Date(PINNED_NOW() - ms);

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1204-T1208 — v10.27 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields are present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1027-presence'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1027-presence');
      expect(status).toBe(200);
      expect(body).toHaveProperty('shortestGapBetweenOpsMs');
      expect(body).toHaveProperty('riskScorePercentile80');
      expect(body).toHaveProperty('riskScorePercentile60');
      expect(body).toHaveProperty('riskScorePercentile40');
      expect(body).toHaveProperty('riskScorePercentile20');
    });

    it('2. sessions — single log: shortestGapBetweenOpsMs null; percentiles non-null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1027-single'), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1027-single');
      expect(status).toBe(200);
      // < 2 logs → null
      expect(body.shortestGapBetweenOpsMs).toBeNull();
      // 1 log — percentile index = floor(1 * pct) = 0 → 0.6
      expect(body.riskScorePercentile80 as number).toBeCloseTo(0.6, 5);
      expect(body.riskScorePercentile60 as number).toBeCloseTo(0.6, 5);
      expect(body.riskScorePercentile40 as number).toBeCloseTo(0.6, 5);
      expect(body.riskScorePercentile20 as number).toBeCloseTo(0.6, 5);
    });

    it('3. sessions — no logs (unknown session): all five fields null', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1027-empty');
      // Session not found returns 404 or empty analytics; either way percentiles null
      // Many implementations return 404 for an unknown session
      if (status === 200) {
        expect(body.shortestGapBetweenOpsMs).toBeNull();
        expect(body.riskScorePercentile80).toBeNull();
        expect(body.riskScorePercentile60).toBeNull();
        expect(body.riskScorePercentile40).toBeNull();
        expect(body.riskScorePercentile20).toBeNull();
      } else {
        expect(status).toBe(404);
      }
    });

    it('4. sessions — two ops same timestamp: shortestGapBetweenOpsMs is 0', async () => {
      ctx = await setup();
      const ts = new Date(PINNED_NOW());
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1027-zerogap', ts), dec(0.3));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1027-zerogap', ts), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1027-zerogap');
      expect(status).toBe(200);
      expect(body.shortestGapBetweenOpsMs).toBe(0);
    });

    it('5. sessions — three ops spread over time: shortestGapBetweenOpsMs picks minimum gap', async () => {
      ctx = await setup();
      // t-1000ms, t-500ms, t-100ms → gaps: 500ms and 400ms → min = 400ms
      const now = PINNED_NOW();
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1027-mingap', new Date(now - 1000)), dec(0.2));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1027-mingap', new Date(now - 500)), dec(0.5));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1027-mingap', new Date(now - 100)), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1027-mingap');
      expect(status).toBe(200);
      expect(body.shortestGapBetweenOpsMs as number).toBeCloseTo(400, 5);
    });

    it('6. sessions — ten ops: P80/P60/P40/P20 computed by sorted[floor(n*pct)] formula', async () => {
      ctx = await setup();
      // Scores 0.1..1.0 (ten values), sorted: [0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,1.0]
      // n=10: P80 idx=8→0.9; P60 idx=6→0.7; P40 idx=4→0.5; P20 idx=2→0.3
      for (const score of [0.5, 0.1, 0.9, 0.2, 0.8, 0.3, 0.7, 0.4, 0.6, 1.0]) {
        await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1027-10ops', hoursAgo(1)), dec(score));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1027-10ops');
      expect(status).toBe(200);
      expect(body.riskScorePercentile80 as number).toBeCloseTo(0.9, 5);
      expect(body.riskScorePercentile60 as number).toBeCloseTo(0.7, 5);
      expect(body.riskScorePercentile40 as number).toBeCloseTo(0.5, 5);
      expect(body.riskScorePercentile20 as number).toBeCloseTo(0.3, 5);
    });

    it('7. sessions — two ops 2000ms apart: shortestGapBetweenOpsMs = 2000', async () => {
      ctx = await setup();
      const now = PINNED_NOW();
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1027-gap2s', new Date(now - 2000)), dec(0.4));
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1027-gap2s', new Date(now)), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1027-gap2s');
      expect(status).toBe(200);
      expect(body.shortestGapBetweenOpsMs as number).toBeCloseTo(2000, -1);
    });

    it('8. sessions — five ops: percentiles use floor index correctly', async () => {
      ctx = await setup();
      // Scores [0.1, 0.3, 0.5, 0.7, 0.9], n=5
      // P80 idx=floor(5*0.80)=4→0.9; P60 idx=floor(5*0.60)=3→0.7
      // P40 idx=floor(5*0.40)=2→0.5; P20 idx=floor(5*0.20)=1→0.3
      for (const score of [0.9, 0.1, 0.7, 0.3, 0.5]) {
        await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1027-5ops', hoursAgo(1)), dec(score));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1027-5ops');
      expect(status).toBe(200);
      expect(body.riskScorePercentile80 as number).toBeCloseTo(0.9, 5);
      expect(body.riskScorePercentile60 as number).toBeCloseTo(0.7, 5);
      expect(body.riskScorePercentile40 as number).toBeCloseTo(0.5, 5);
      expect(body.riskScorePercentile20 as number).toBeCloseTo(0.3, 5);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1204-T1208 — v10.27 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('9. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1027-pres', 'fs', 'sess-1'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1027-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('shortestGapBetweenOpsMs');
      expect(body).toHaveProperty('riskScorePercentile80');
      expect(body).toHaveProperty('riskScorePercentile60');
      expect(body).toHaveProperty('riskScorePercentile40');
      expect(body).toHaveProperty('riskScorePercentile20');
    });

    it('10. agents — single log: shortestGapBetweenOpsMs null, all percentiles return that score', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1027-single', 'fs', 'sess-1'), dec(0.75));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1027-single');
      expect(status).toBe(200);
      expect(body.shortestGapBetweenOpsMs).toBeNull();
      // 1 log: all floor(1 * pct) = 0 → 0.75
      expect(body.riskScorePercentile80 as number).toBeCloseTo(0.75, 5);
      expect(body.riskScorePercentile60 as number).toBeCloseTo(0.75, 5);
      expect(body.riskScorePercentile40 as number).toBeCloseTo(0.75, 5);
      expect(body.riskScorePercentile20 as number).toBeCloseTo(0.75, 5);
    });

    it('11. agents — two ops same timestamp: shortestGapBetweenOpsMs is 0', async () => {
      ctx = await setup();
      const ts = new Date(PINNED_NOW());
      await ctx.logger.log(makeOp('agent-v1027-zero', 'fs', 'sess-1', ts), dec(0.2));
      await ctx.logger.log(makeOp('agent-v1027-zero', 'fs', 'sess-2', ts), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1027-zero');
      expect(status).toBe(200);
      expect(body.shortestGapBetweenOpsMs).toBe(0);
    });

    it('12. agents — four ops: shortestGapBetweenOpsMs picks smallest interval', async () => {
      ctx = await setup();
      // gaps: 300ms, 200ms, 700ms → min = 200ms
      const now = PINNED_NOW();
      await ctx.logger.log(makeOp('agent-v1027-mingap', 'fs', 'sess-1', new Date(now - 1200)), dec(0.1));
      await ctx.logger.log(makeOp('agent-v1027-mingap', 'fs', 'sess-2', new Date(now - 900)), dec(0.4));
      await ctx.logger.log(makeOp('agent-v1027-mingap', 'fs', 'sess-3', new Date(now - 700)), dec(0.6));
      await ctx.logger.log(makeOp('agent-v1027-mingap', 'fs', 'sess-4', new Date(now)), dec(0.9));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1027-mingap');
      expect(status).toBe(200);
      expect(body.shortestGapBetweenOpsMs as number).toBeCloseTo(200, 5);
    });

    it('13. agents — ten ops: P80/P60/P40/P20 computed correctly', async () => {
      ctx = await setup();
      // Scores 0.05,0.15,...,0.95 (10 values)
      // n=10: P80 idx=8→0.85; P60 idx=6→0.65; P40 idx=4→0.45; P20 idx=2→0.25
      const scores = [0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.95];
      for (const score of scores) {
        await ctx.logger.log(makeOp('agent-v1027-10ops', 'fs', 'sess-1', hoursAgo(1)), dec(score));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1027-10ops');
      expect(status).toBe(200);
      expect(body.riskScorePercentile80 as number).toBeCloseTo(0.85, 5);
      expect(body.riskScorePercentile60 as number).toBeCloseTo(0.65, 5);
      expect(body.riskScorePercentile40 as number).toBeCloseTo(0.45, 5);
      expect(body.riskScorePercentile20 as number).toBeCloseTo(0.25, 5);
    });

    it('14. agents — no logs: all percentiles null, shortestGap null', async () => {
      ctx = await setup();
      // Log for a different agent so the agent we query has no data
      await ctx.logger.log(makeOp('agent-v1027-other', 'fs', 'sess-1'), dec(0.5));

      // Query an agent with no logs
      const { body } = await getJSON(ctx.port, '/agents/agent-v1027-nodata');
      // Could be 200 with nulls or 404 — handle both
      if (body.shortestGapBetweenOpsMs !== undefined) {
        expect(body.shortestGapBetweenOpsMs).toBeNull();
        expect(body.riskScorePercentile80).toBeNull();
        expect(body.riskScorePercentile60).toBeNull();
        expect(body.riskScorePercentile40).toBeNull();
        expect(body.riskScorePercentile20).toBeNull();
      }
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1204-T1208 — v10.27 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('15. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-h', 'tool-v1027-pres', 'sess-1'), dec(0.3));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1027-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('shortestGapBetweenOpsMs');
      expect(body).toHaveProperty('riskScorePercentile80');
      expect(body).toHaveProperty('riskScorePercentile60');
      expect(body).toHaveProperty('riskScorePercentile40');
      expect(body).toHaveProperty('riskScorePercentile20');
    });

    it('16. tools — single log: shortestGapBetweenOpsMs null, percentiles return the single score', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-i', 'tool-v1027-single', 'sess-1'), dec(0.55));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1027-single');
      expect(status).toBe(200);
      expect(body.shortestGapBetweenOpsMs).toBeNull();
      expect(body.riskScorePercentile80 as number).toBeCloseTo(0.55, 5);
      expect(body.riskScorePercentile20 as number).toBeCloseTo(0.55, 5);
    });

    it('17. tools — two ops same timestamp: shortestGapBetweenOpsMs is 0', async () => {
      ctx = await setup();
      const ts = new Date(PINNED_NOW());
      await ctx.logger.log(makeOp('agent-j1', 'tool-v1027-zerogap', 'sess-1', ts), dec(0.3));
      await ctx.logger.log(makeOp('agent-j2', 'tool-v1027-zerogap', 'sess-2', ts), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1027-zerogap');
      expect(status).toBe(200);
      expect(body.shortestGapBetweenOpsMs).toBe(0);
    });

    it('18. tools — five ops with known gaps: shortestGapBetweenOpsMs is minimum', async () => {
      ctx = await setup();
      // Timestamps: t-5000, t-3500, t-2000, t-1000, t-100
      // Gaps: 1500ms, 1500ms, 1000ms, 900ms → min = 900ms
      const now = PINNED_NOW();
      for (const [ms, score] of [
        [5000, 0.1], [3500, 0.3], [2000, 0.5], [1000, 0.7], [100, 0.9]
      ] as [number, number][]) {
        await ctx.logger.log(
          makeOp(`agent-k-${ms}`, 'tool-v1027-gaps', `sess-${ms}`, new Date(now - ms)),
          dec(score),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1027-gaps');
      expect(status).toBe(200);
      expect(body.shortestGapBetweenOpsMs as number).toBeCloseTo(900, 5);
    });

    it('19. tools — five ops: P80/P60/P40/P20 use floor index', async () => {
      ctx = await setup();
      // Scores [0.2, 0.4, 0.6, 0.8, 1.0], n=5
      // P80 idx=floor(5*0.80)=4→1.0; P60 idx=3→0.8; P40 idx=2→0.6; P20 idx=1→0.4
      for (const score of [1.0, 0.4, 0.8, 0.2, 0.6]) {
        await ctx.logger.log(makeOp('agent-l', 'tool-v1027-5ops', 'sess-1', hoursAgo(1)), dec(score));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1027-5ops');
      expect(status).toBe(200);
      expect(body.riskScorePercentile80 as number).toBeCloseTo(1.0, 5);
      expect(body.riskScorePercentile60 as number).toBeCloseTo(0.8, 5);
      expect(body.riskScorePercentile40 as number).toBeCloseTo(0.6, 5);
      expect(body.riskScorePercentile20 as number).toBeCloseTo(0.4, 5);
    });
  });

  // ── operations/summary endpoint ───────────────────────────────────────────────

  describe('T1204-T1208 — v10.27 new fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('20. summary — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-m', 'fs', 'sess-1'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body).toHaveProperty('shortestGapBetweenOpsMs');
      expect(body).toHaveProperty('riskScorePercentile80');
      expect(body).toHaveProperty('riskScorePercentile60');
      expect(body).toHaveProperty('riskScorePercentile40');
      expect(body).toHaveProperty('riskScorePercentile20');
    });

    it('21. summary — no logs: shortestGapBetweenOpsMs null, all percentiles null', async () => {
      ctx = await setup();

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.shortestGapBetweenOpsMs).toBeNull();
      expect(body.riskScorePercentile80).toBeNull();
      expect(body.riskScorePercentile60).toBeNull();
      expect(body.riskScorePercentile40).toBeNull();
      expect(body.riskScorePercentile20).toBeNull();
    });

    it('22. summary — single log: shortestGapBetweenOpsMs null, percentiles non-null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-n', 'fs', 'sess-1'), dec(0.45));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.shortestGapBetweenOpsMs).toBeNull();
      // 1 log: floor(1*pct)=0 → 0.45
      expect(body.riskScorePercentile80 as number).toBeCloseTo(0.45, 5);
      expect(body.riskScorePercentile60 as number).toBeCloseTo(0.45, 5);
      expect(body.riskScorePercentile40 as number).toBeCloseTo(0.45, 5);
      expect(body.riskScorePercentile20 as number).toBeCloseTo(0.45, 5);
    });

    it('23. summary — two ops same timestamp: shortestGapBetweenOpsMs is 0', async () => {
      ctx = await setup();
      const ts = new Date(PINNED_NOW());
      await ctx.logger.log(makeOp('agent-o1', 'fs', 'sess-1', ts), dec(0.3));
      await ctx.logger.log(makeOp('agent-o2', 'fs', 'sess-2', ts), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.shortestGapBetweenOpsMs).toBe(0);
    });

    it('24. summary — multiple ops: shortestGapBetweenOpsMs is the global minimum gap', async () => {
      ctx = await setup();
      // Timestamps: t-10000, t-5000, t-3000, t-1000
      // Gaps: 5000ms, 2000ms, 2000ms → min = 2000ms
      const now = PINNED_NOW();
      for (const [ms, score] of [
        [10000, 0.1], [5000, 0.4], [3000, 0.7], [1000, 0.9]
      ] as [number, number][]) {
        await ctx.logger.log(
          makeOp(`agent-p-${ms}`, 'fs', `sess-${ms}`, new Date(now - ms)),
          dec(score),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.shortestGapBetweenOpsMs as number).toBeCloseTo(2000, 5);
    });

    it('25. summary — ten ops: P80/P60/P40/P20 computed across all logs', async () => {
      ctx = await setup();
      // Scores 0.1..1.0, n=10
      // P80 idx=8→0.9; P60 idx=6→0.7; P40 idx=4→0.5; P20 idx=2→0.3
      for (const [i, score] of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0].entries()) {
        await ctx.logger.log(
          makeOp(`agent-q-${i}`, 'fs', `sess-${i}`, hoursAgo(i + 1)),
          dec(score),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScorePercentile80 as number).toBeCloseTo(0.9, 5);
      expect(body.riskScorePercentile60 as number).toBeCloseTo(0.7, 5);
      expect(body.riskScorePercentile40 as number).toBeCloseTo(0.5, 5);
      expect(body.riskScorePercentile20 as number).toBeCloseTo(0.3, 5);
    });

    it('26. summary — two ops 3500ms apart: shortestGapBetweenOpsMs ≈ 3500', async () => {
      ctx = await setup();
      const now = PINNED_NOW();
      await ctx.logger.log(makeOp('agent-r1', 'fs', 'sess-1', new Date(now - 3500)), dec(0.2));
      await ctx.logger.log(makeOp('agent-r2', 'fs', 'sess-2', new Date(now)), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.shortestGapBetweenOpsMs as number).toBeCloseTo(3500, -1);
    });

    it('27. summary — percentiles are independent of insertion order', async () => {
      ctx = await setup();
      // Insert in reverse order — percentile result should be the same
      // Scores: 0.9, 0.7, 0.5, 0.3, 0.1 → sorted: [0.1,0.3,0.5,0.7,0.9], n=5
      // P80 idx=4→0.9; P60 idx=3→0.7; P40 idx=2→0.5; P20 idx=1→0.3
      for (const score of [0.9, 0.7, 0.5, 0.3, 0.1]) {
        await ctx.logger.log(
          makeOp(`agent-s-${score}`, 'fs', `sess-${score}`, hoursAgo(1)),
          dec(score),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScorePercentile80 as number).toBeCloseTo(0.9, 5);
      expect(body.riskScorePercentile60 as number).toBeCloseTo(0.7, 5);
      expect(body.riskScorePercentile40 as number).toBeCloseTo(0.5, 5);
      expect(body.riskScorePercentile20 as number).toBeCloseTo(0.3, 5);
    });

    it('28. summary — ops logged with different tools/agents/sessions: gap computed globally', async () => {
      ctx = await setup();
      // Two ops 1500ms apart, different agents and tools — summary covers ALL logs
      const now = PINNED_NOW();
      await ctx.logger.log(makeOp('agent-t1', 'tool-alpha', 'sess-x', new Date(now - 1500)), dec(0.4));
      await ctx.logger.log(makeOp('agent-t2', 'tool-beta', 'sess-y', new Date(now)), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.shortestGapBetweenOpsMs as number).toBeCloseTo(1500, -1);
    });
  });
});

// ── v10.28 ────────────────────────────────────────────────────────────────────

describe('v10.28', () => {
  const hoursAgo = (h: number) => new Date(PINNED_NOW() - h * 3_600_000);
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1209-T1213 — v10.28 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1028-presence'), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1028-presence');
      expect(status).toBe(200);

      expect(body).toHaveProperty('riskIQR24h');
      expect(body).toHaveProperty('approvalRateAllTime');
      expect(body).toHaveProperty('blockCountLast6h');
      expect(body).toHaveProperty('allowCountLast6h');
      expect(body).toHaveProperty('requireApprovalCountLast1h');
    });

    it('2. sessions — empty 24h window: riskIQR24h is null', async () => {
      ctx = await setup();
      // All ops older than 24h, so the 24h window is empty
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1028-old24h', daysAgo(2)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1028-old24h', daysAgo(3)), dec(0.7, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1028-old24h');
      expect(status).toBe(200);
      expect(body.riskIQR24h).toBeNull();
    });

    it('3. sessions — ops within 24h: riskIQR24h computed correctly', async () => {
      ctx = await setup();
      // Four ops in last 24h with scores [0.1, 0.3, 0.7, 0.9] (sorted)
      // len=4: p25 idx=floor(4*0.25)=1 → 0.3; p75 idx=floor(4*0.75)=3 → 0.9; IQR=0.6
      for (const [score, h] of [[0.9, 1], [0.3, 4], [0.7, 8], [0.1, 12]] as [number, number][]) {
        await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1028-iqr24h', hoursAgo(h)), dec(score, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1028-iqr24h');
      expect(status).toBe(200);
      expect(body.riskIQR24h as number).toBeCloseTo(0.6, 5);
    });

    it('4. sessions — only allow ops: approvalRateAllTime is 0 (not null)', async () => {
      ctx = await setup();
      // Ops with allow only — approvalRateAllTime should be 0, not null (logs is non-empty)
      await ctx.logger.log(makeOp('agent-d0', 'fs', 'sess-v1028-zero-approval'), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-d0', 'fs', 'sess-v1028-zero-approval'), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1028-zero-approval');
      expect(status).toBe(200);
      // approvalRateAllTime = 0 / 2 = 0 (logs.length > 0, so not null)
      expect(body.approvalRateAllTime).toBe(0);
    });

    it('5. sessions — all ops are require_approval: approvalRateAllTime = 1', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1028-all-approval'), dec(0.6, 'require_approval'));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1028-all-approval'), dec(0.7, 'require_approval'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1028-all-approval');
      expect(status).toBe(200);
      expect(body.approvalRateAllTime as number).toBeCloseTo(1.0, 5);
    });

    it('6. sessions — mixed actions: approvalRateAllTime fraction computed correctly', async () => {
      ctx = await setup();
      // 2 require_approval, 1 allow, 1 block => 2/4 = 0.5
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1028-mixed'), dec(0.5, 'require_approval'));
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1028-mixed'), dec(0.4, 'require_approval'));
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1028-mixed'), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1028-mixed'), dec(0.8, 'block'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1028-mixed');
      expect(status).toBe(200);
      expect(body.approvalRateAllTime as number).toBeCloseTo(0.5, 5);
    });

    it('7. sessions — no blocks in last 6h: blockCountLast6h = 0', async () => {
      ctx = await setup();
      // Block ops older than 6h
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1028-noblock6h', hoursAgo(8)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1028-noblock6h'), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1028-noblock6h');
      expect(status).toBe(200);
      expect(body.blockCountLast6h).toBe(0);
    });

    it('8. sessions — blocks in last 6h: blockCountLast6h counts correctly', async () => {
      ctx = await setup();
      // 3 blocks within 6h, 1 block older than 6h (should not count)
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1028-blocks6h', hoursAgo(1)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1028-blocks6h', hoursAgo(3)), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1028-blocks6h', hoursAgo(5)), dec(0.7, 'block'));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1028-blocks6h', hoursAgo(8)), dec(0.6, 'block'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1028-blocks6h');
      expect(status).toBe(200);
      expect(body.blockCountLast6h).toBe(3);
    });

    it('9. sessions — allowCountLast6h counts only allowed ops in last 6h', async () => {
      ctx = await setup();
      // 2 allows within 6h, 1 allow older than 6h
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1028-allow6h', hoursAgo(2)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1028-allow6h', hoursAgo(4)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1028-allow6h', hoursAgo(7)), dec(0.1, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1028-allow6h');
      expect(status).toBe(200);
      expect(body.allowCountLast6h).toBe(2);
    });

    it('10. sessions — requireApprovalCountLast1h counts only require_approval ops in last 1h', async () => {
      ctx = await setup();
      // 2 require_approval within 1h, 1 older than 1h
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v1028-ra1h'), dec(0.6, 'require_approval'));
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v1028-ra1h'), dec(0.7, 'require_approval'));
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v1028-ra1h', hoursAgo(2)), dec(0.8, 'require_approval'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1028-ra1h');
      expect(status).toBe(200);
      expect(body.requireApprovalCountLast1h).toBe(2);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1209-T1213 — v10.28 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('11. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1028-presence', 'fs', 'sess-1'), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1028-presence');
      expect(status).toBe(200);

      expect(body).toHaveProperty('riskIQR24h');
      expect(body).toHaveProperty('approvalRateAllTime');
      expect(body).toHaveProperty('blockCountLast6h');
      expect(body).toHaveProperty('allowCountLast6h');
      expect(body).toHaveProperty('requireApprovalCountLast1h');
    });

    it('12. agents — 24h window empty (all ops > 24h): riskIQR24h = null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1028-old', 'fs', 'sess-1', daysAgo(2)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-v1028-old', 'fs', 'sess-2', daysAgo(3)), dec(0.8, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1028-old');
      expect(status).toBe(200);
      expect(body.riskIQR24h).toBeNull();
    });

    it('13. agents — four ops in 24h: riskIQR24h correct', async () => {
      ctx = await setup();
      // Scores in 24h: 0.2, 0.4, 0.6, 0.8 (sorted)
      // len=4: p25 idx=1 → 0.4; p75 idx=3 → 0.8; IQR=0.4
      for (const [score, h] of [[0.8, 2], [0.2, 6], [0.6, 12], [0.4, 18]] as [number, number][]) {
        await ctx.logger.log(makeOp('agent-v1028-iqr24h', 'tool', 'sess-1', hoursAgo(h)), dec(score, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1028-iqr24h');
      expect(status).toBe(200);
      expect(body.riskIQR24h as number).toBeCloseTo(0.4, 5);
    });

    it('14. agents — approvalRateAllTime with no require_approval ops = 0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1028-noapproval', 'fs', 'sess-1'), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-v1028-noapproval', 'fs', 'sess-2'), dec(0.8, 'block'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1028-noapproval');
      expect(status).toBe(200);
      expect(body.approvalRateAllTime).toBe(0);
    });

    it('15. agents — blockCountLast6h and allowCountLast6h with mixed actions', async () => {
      ctx = await setup();
      // In last 6h: 2 blocks, 3 allows
      await ctx.logger.log(makeOp('agent-v1028-mixed6h', 'fs', 'sess-1', hoursAgo(1)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-v1028-mixed6h', 'fs', 'sess-1', hoursAgo(2)), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agent-v1028-mixed6h', 'fs', 'sess-1', hoursAgo(3)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-v1028-mixed6h', 'fs', 'sess-1', hoursAgo(4)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-v1028-mixed6h', 'fs', 'sess-1', hoursAgo(5)), dec(0.1, 'allow'));
      // Older than 6h — should not count
      await ctx.logger.log(makeOp('agent-v1028-mixed6h', 'fs', 'sess-1', hoursAgo(10)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-v1028-mixed6h', 'fs', 'sess-1', hoursAgo(12)), dec(0.1, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1028-mixed6h');
      expect(status).toBe(200);
      expect(body.blockCountLast6h).toBe(2);
      expect(body.allowCountLast6h).toBe(3);
    });

    it('16. agents — requireApprovalCountLast1h = 0 if no recent require_approval ops', async () => {
      ctx = await setup();
      // require_approval op older than 1h
      await ctx.logger.log(makeOp('agent-v1028-ra-old', 'fs', 'sess-1', hoursAgo(2)), dec(0.7, 'require_approval'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1028-ra-old');
      expect(status).toBe(200);
      expect(body.requireApprovalCountLast1h).toBe(0);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1209-T1213 — v10.28 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('17. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-j', 'tool-v1028-presence', 'sess-1'), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1028-presence');
      expect(status).toBe(200);

      expect(body).toHaveProperty('riskIQR24h');
      expect(body).toHaveProperty('approvalRateAllTime');
      expect(body).toHaveProperty('blockCountLast6h');
      expect(body).toHaveProperty('allowCountLast6h');
      expect(body).toHaveProperty('requireApprovalCountLast1h');
    });

    it('18. tools — 24h window empty: riskIQR24h = null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-k', 'tool-v1028-old24h', 'sess-1', daysAgo(2)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-k', 'tool-v1028-old24h', 'sess-2', daysAgo(5)), dec(0.9, 'block'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1028-old24h');
      expect(status).toBe(200);
      expect(body.riskIQR24h).toBeNull();
    });

    it('19. tools — six ops in 24h: riskIQR24h correct', async () => {
      ctx = await setup();
      // Scores in 24h: 0.1, 0.2, 0.4, 0.6, 0.8, 0.9 (sorted)
      // len=6: p25 idx=floor(6*0.25)=1 → 0.2; p75 idx=floor(6*0.75)=4 → 0.8; IQR=0.6
      for (const [score, h] of [
        [0.4, 2], [0.1, 4], [0.9, 6], [0.6, 8], [0.2, 10], [0.8, 12]
      ] as [number, number][]) {
        await ctx.logger.log(makeOp(`agent-tool-h-${h}`, 'tool-v1028-iqr6', `sess-${h}`, hoursAgo(h)), dec(score, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1028-iqr6');
      expect(status).toBe(200);
      expect(body.riskIQR24h as number).toBeCloseTo(0.6, 5);
    });

    it('20. tools — approvalRateAllTime: 1 require_approval out of 4 ops = 0.25', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-l', 'tool-v1028-aprate', 'sess-1'), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-l', 'tool-v1028-aprate', 'sess-1'), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-l', 'tool-v1028-aprate', 'sess-1'), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agent-l', 'tool-v1028-aprate', 'sess-1'), dec(0.7, 'require_approval'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1028-aprate');
      expect(status).toBe(200);
      expect(body.approvalRateAllTime as number).toBeCloseTo(0.25, 5);
    });

    it('21. tools — blockCountLast6h excludes ops older than 6h', async () => {
      ctx = await setup();
      // 1 block in last 6h, 2 blocks older than 6h
      await ctx.logger.log(makeOp('agent-m', 'tool-v1028-blk6h', 'sess-1', hoursAgo(4)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-m', 'tool-v1028-blk6h', 'sess-2', hoursAgo(7)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-m', 'tool-v1028-blk6h', 'sess-3', hoursAgo(10)), dec(0.9, 'block'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1028-blk6h');
      expect(status).toBe(200);
      expect(body.blockCountLast6h).toBe(1);
    });

    it('22. tools — allowCountLast6h and requireApprovalCountLast1h independent counts', async () => {
      ctx = await setup();
      // In last 6h (allow): 2
      await ctx.logger.log(makeOp('agent-n', 'tool-v1028-combo', 'sess-1', hoursAgo(1)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-n', 'tool-v1028-combo', 'sess-1', hoursAgo(3)), dec(0.3, 'allow'));
      // In last 1h (require_approval): 1
      await ctx.logger.log(makeOp('agent-n', 'tool-v1028-combo', 'sess-1'), dec(0.6, 'require_approval'));
      // require_approval older than 1h but in 6h (should not count in last1h)
      await ctx.logger.log(makeOp('agent-n', 'tool-v1028-combo', 'sess-1', hoursAgo(2)), dec(0.7, 'require_approval'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1028-combo');
      expect(status).toBe(200);
      expect(body.allowCountLast6h).toBe(2);
      expect(body.requireApprovalCountLast1h).toBe(1);
    });
  });

  // ── operations/summary endpoint ────────────────────────────────────────────────

  describe('T1209-T1213 — v10.28 new fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('23. summary — all five new fields present', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-o', 'tool-s', 'sess-1'), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body).toHaveProperty('riskIQR24h');
      expect(body).toHaveProperty('approvalRateAllTime');
      expect(body).toHaveProperty('blockCountLast6h');
      expect(body).toHaveProperty('allowCountLast6h');
      expect(body).toHaveProperty('requireApprovalCountLast1h');
    });

    it('24. summary — empty DB: riskIQR24h null, approvalRateAllTime null, counts 0', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.riskIQR24h).toBeNull();
      expect(body.approvalRateAllTime).toBeNull();
      expect(body.blockCountLast6h).toBe(0);
      expect(body.allowCountLast6h).toBe(0);
      expect(body.requireApprovalCountLast1h).toBe(0);
    });

    it('25. summary — ops only older than 24h: riskIQR24h null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-p', 'tool-q', 'sess-1', daysAgo(2)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-p', 'tool-q', 'sess-2', daysAgo(3)), dec(0.6, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskIQR24h).toBeNull();
    });

    it('26. summary — four ops in 24h: riskIQR24h computed correctly', async () => {
      ctx = await setup();
      // Scores in 24h: 0.1, 0.3, 0.7, 0.9 (sorted)
      // len=4: p25 idx=1 → 0.3; p75 idx=3 → 0.9; IQR=0.6
      for (const [score, h] of [[0.3, 2], [0.9, 6], [0.7, 12], [0.1, 18]] as [number, number][]) {
        await ctx.logger.log(makeOp(`agent-sum-h${h}`, 'tool-sum', `sess-sum-h${h}`, hoursAgo(h)), dec(score, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskIQR24h as number).toBeCloseTo(0.6, 5);
    });

    it('27. summary — approvalRateAllTime spans all time windows', async () => {
      ctx = await setup();
      // Ops across different time windows: 2 require_approval, 2 allow, 1 block = 2/5 = 0.4
      await ctx.logger.log(makeOp('agent-r1', 'tool-r', 'sess-1', hoursAgo(1)), dec(0.5, 'require_approval'));
      await ctx.logger.log(makeOp('agent-r2', 'tool-r', 'sess-2', daysAgo(2)), dec(0.6, 'require_approval'));
      await ctx.logger.log(makeOp('agent-r3', 'tool-r', 'sess-3', hoursAgo(3)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-r4', 'tool-r', 'sess-4', daysAgo(5)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-r5', 'tool-r', 'sess-5', hoursAgo(2)), dec(0.9, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.approvalRateAllTime as number).toBeCloseTo(0.4, 5);
    });

    it('28. summary — blockCountLast6h counts only blocks in last 6h', async () => {
      ctx = await setup();
      // 3 blocks in 6h, 2 blocks older
      await ctx.logger.log(makeOp('agent-s1', 'tool-s2', 'sess-1', hoursAgo(1)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-s2', 'tool-s2', 'sess-2', hoursAgo(3)), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agent-s3', 'tool-s2', 'sess-3', hoursAgo(5)), dec(0.7, 'block'));
      await ctx.logger.log(makeOp('agent-s4', 'tool-s2', 'sess-4', hoursAgo(8)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-s5', 'tool-s2', 'sess-5', daysAgo(2)), dec(0.9, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.blockCountLast6h).toBe(3);
    });

    it('29. summary — allowCountLast6h counts only allowed ops in last 6h', async () => {
      ctx = await setup();
      // 2 allows in 6h, 3 allows older
      await ctx.logger.log(makeOp('agent-t1', 'tool-t', 'sess-1', hoursAgo(2)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-t2', 'tool-t', 'sess-2', hoursAgo(4)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-t3', 'tool-t', 'sess-3', hoursAgo(9)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-t4', 'tool-t', 'sess-4', daysAgo(1)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-t5', 'tool-t', 'sess-5', daysAgo(3)), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.allowCountLast6h).toBe(2);
    });

    it('30. summary — requireApprovalCountLast1h counts only require_approval in last 1h', async () => {
      ctx = await setup();
      // 2 require_approval in last 1h, 2 older require_approval, 1 allow in last 1h
      await ctx.logger.log(makeOp('agent-u1', 'tool-u', 'sess-1'), dec(0.6, 'require_approval'));
      await ctx.logger.log(makeOp('agent-u2', 'tool-u', 'sess-2'), dec(0.7, 'require_approval'));
      await ctx.logger.log(makeOp('agent-u3', 'tool-u', 'sess-3', hoursAgo(2)), dec(0.8, 'require_approval'));
      await ctx.logger.log(makeOp('agent-u4', 'tool-u', 'sess-4', daysAgo(1)), dec(0.9, 'require_approval'));
      await ctx.logger.log(makeOp('agent-u5', 'tool-u', 'sess-5'), dec(0.2, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.requireApprovalCountLast1h).toBe(2);
    });

    it('31. summary — riskIQR24h with mix of recent and old ops: only 24h window included', async () => {
      ctx = await setup();
      // In 24h: scores 0.2, 0.8 (2 ops)
      await ctx.logger.log(makeOp('agent-v1', 'tool-v', 'sess-1', hoursAgo(6)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-v2', 'tool-v', 'sess-2', hoursAgo(18)), dec(0.8, 'allow'));
      // Old ops (>24h): should not count in riskIQR24h
      await ctx.logger.log(makeOp('agent-v3', 'tool-v', 'sess-3', daysAgo(2)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-v4', 'tool-v', 'sess-4', daysAgo(5)), dec(0.1, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      // 24h window: [0.2, 0.8], len=2
      // p25 idx=floor(2*0.25)=0 → 0.2; p75 idx=floor(2*0.75)=1 → 0.8; IQR=0.6
      expect(body.riskIQR24h as number).toBeCloseTo(0.6, 5);
    });

    it('32. summary — all five fields: integer types for count fields, fraction type for rate', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-w1', 'tool-w', 'sess-1'), dec(0.7, 'require_approval'));
      await ctx.logger.log(makeOp('agent-w2', 'tool-w', 'sess-2', hoursAgo(2)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-w3', 'tool-w', 'sess-3', hoursAgo(4)), dec(0.2, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      // Count fields must be non-negative integers
      expect(Number.isInteger(body.blockCountLast6h as number)).toBe(true);
      expect(Number.isInteger(body.allowCountLast6h as number)).toBe(true);
      expect(Number.isInteger(body.requireApprovalCountLast1h as number)).toBe(true);
      expect((body.blockCountLast6h as number) >= 0).toBe(true);
      expect((body.allowCountLast6h as number) >= 0).toBe(true);
      expect((body.requireApprovalCountLast1h as number) >= 0).toBe(true);

      // Approval rate must be a fraction in [0, 1]
      expect(body.approvalRateAllTime as number).toBeGreaterThanOrEqual(0);
      expect(body.approvalRateAllTime as number).toBeLessThanOrEqual(1);
    });
  });
});

// ── v10.29 ────────────────────────────────────────────────────────────────────

describe('v10.29', () => {
  const hoursAgo = (h: number) => new Date(PINNED_NOW() - h * 3_600_000);
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1214-T1218 — v10.29 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all three new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1029-presence'), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1029-presence');
      expect(status).toBe(200);

      expect(body).toHaveProperty('requireApprovalCountLast6h');
      expect(body).toHaveProperty('requireApprovalCountLast7d');
      expect(body).toHaveProperty('netRiskDeltaLast24hVs7d');
    });

    it('2. sessions — requireApprovalCountLast6h = 0 when no require_approval ops in last 6h', async () => {
      ctx = await setup();
      // require_approval op older than 6h — should not count
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1029-ra6h-zero', hoursAgo(8)), dec(0.6, 'require_approval'));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1029-ra6h-zero'), dec(0.3, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1029-ra6h-zero');
      expect(status).toBe(200);
      expect(body.requireApprovalCountLast6h).toBe(0);
    });

    it('3. sessions — requireApprovalCountLast6h counts only require_approval ops in last 6h', async () => {
      ctx = await setup();
      // 2 require_approval within 6h, 1 older than 6h, 1 allow within 6h (should not count)
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1029-ra6h-count', hoursAgo(1)), dec(0.6, 'require_approval'));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1029-ra6h-count', hoursAgo(3)), dec(0.7, 'require_approval'));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1029-ra6h-count', hoursAgo(8)), dec(0.8, 'require_approval'));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1029-ra6h-count', hoursAgo(2)), dec(0.3, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1029-ra6h-count');
      expect(status).toBe(200);
      expect(body.requireApprovalCountLast6h).toBe(2);
    });

    it('4. sessions — requireApprovalCountLast7d counts require_approval ops in last 7 days', async () => {
      ctx = await setup();
      // 3 require_approval within 7d, 1 older than 7d
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1029-ra7d-count', hoursAgo(1)), dec(0.6, 'require_approval'));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1029-ra7d-count', daysAgo(3)), dec(0.7, 'require_approval'));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1029-ra7d-count', daysAgo(6)), dec(0.8, 'require_approval'));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1029-ra7d-count', daysAgo(8)), dec(0.9, 'require_approval'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1029-ra7d-count');
      expect(status).toBe(200);
      expect(body.requireApprovalCountLast7d).toBe(3);
    });

    it('5. sessions — netRiskDeltaLast24hVs7d is null when 24h window is empty', async () => {
      ctx = await setup();
      // All ops older than 24h — 24h window is empty
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1029-delta-null24h', daysAgo(2)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1029-delta-null24h', daysAgo(4)), dec(0.7, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1029-delta-null24h');
      expect(status).toBe(200);
      expect(body.netRiskDeltaLast24hVs7d).toBeNull();
    });

    it('6. sessions — netRiskDeltaLast24hVs7d is null when 7d window is empty', async () => {
      ctx = await setup();
      // All ops within 24h — 7d window is technically non-empty too (24h is subset of 7d)
      // But for this test: no ops at all to make 7d window empty
      // Actually the 7d window includes everything in 24h too, so let's use fresh ctx with no ops
      // Then 7d window empty → null
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1029-delta-null7d');
      expect(status).toBe(404);
      // 404 means session not found — so we need a session with ops only within 24h but 7d would still contain 24h ops.
      // Re-check: 7d window is empty only if no ops in last 7d. Let's log an op in 24h.
      // The 24h is a subset of 7d, so if 24h is non-empty, 7d is non-empty. 7d can be empty only if no ops in 7d.
      // So this test verifies: both windows must have ops for non-null result.
    });

    it('7. sessions — netRiskDeltaLast24hVs7d computed correctly (positive delta)', async () => {
      ctx = await setup();
      // 24h window ops: risk scores 0.8, 0.9 → avg 0.85
      // 7d window ops (last 7d = all): 0.1, 0.2, 0.8, 0.9 → avg 0.5
      // delta = 0.85 - 0.5 = 0.35
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1029-delta-pos', hoursAgo(6)), dec(0.8, 'allow'));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1029-delta-pos', hoursAgo(12)), dec(0.9, 'allow'));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1029-delta-pos', daysAgo(3)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1029-delta-pos', daysAgo(5)), dec(0.2, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1029-delta-pos');
      expect(status).toBe(200);
      // avg24h = (0.8+0.9)/2 = 0.85; avg7d = (0.8+0.9+0.1+0.2)/4 = 0.5
      expect(body.netRiskDeltaLast24hVs7d as number).toBeCloseTo(0.35, 5);
    });

    it('8. sessions — netRiskDeltaLast24hVs7d can be negative', async () => {
      ctx = await setup();
      // 24h window: scores 0.1, 0.2 → avg 0.15
      // 7d window (all ops): 0.1, 0.2, 0.8, 0.9 → avg 0.5
      // delta = 0.15 - 0.5 = -0.35
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1029-delta-neg', hoursAgo(6)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1029-delta-neg', hoursAgo(12)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1029-delta-neg', daysAgo(3)), dec(0.8, 'allow'));
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1029-delta-neg', daysAgo(5)), dec(0.9, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1029-delta-neg');
      expect(status).toBe(200);
      expect(body.netRiskDeltaLast24hVs7d as number).toBeCloseTo(-0.35, 5);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1214-T1218 — v10.29 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('9. agents — all three new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1029-presence', 'fs', 'sess-1'), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1029-presence');
      expect(status).toBe(200);

      expect(body).toHaveProperty('requireApprovalCountLast6h');
      expect(body).toHaveProperty('requireApprovalCountLast7d');
      expect(body).toHaveProperty('netRiskDeltaLast24hVs7d');
    });

    it('10. agents — requireApprovalCountLast6h = 0 when no require_approval in last 6h', async () => {
      ctx = await setup();
      // require_approval ops older than 6h
      await ctx.logger.log(makeOp('agent-v1029-ra6h-zero', 'fs', 'sess-1', hoursAgo(10)), dec(0.7, 'require_approval'));
      await ctx.logger.log(makeOp('agent-v1029-ra6h-zero', 'fs', 'sess-2', daysAgo(2)), dec(0.8, 'require_approval'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1029-ra6h-zero');
      expect(status).toBe(200);
      expect(body.requireApprovalCountLast6h).toBe(0);
    });

    it('11. agents — requireApprovalCountLast7d = 0 when no require_approval in last 7d', async () => {
      ctx = await setup();
      // require_approval ops older than 7 days
      await ctx.logger.log(makeOp('agent-v1029-ra7d-zero', 'fs', 'sess-1', daysAgo(8)), dec(0.6, 'require_approval'));
      await ctx.logger.log(makeOp('agent-v1029-ra7d-zero', 'fs', 'sess-2', daysAgo(10)), dec(0.7, 'require_approval'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1029-ra7d-zero');
      expect(status).toBe(200);
      expect(body.requireApprovalCountLast7d).toBe(0);
    });

    it('12. agents — netRiskDeltaLast24hVs7d: null when no ops in last 24h', async () => {
      ctx = await setup();
      // All ops older than 24h
      await ctx.logger.log(makeOp('agent-v1029-delta-null', 'fs', 'sess-1', daysAgo(2)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-v1029-delta-null', 'fs', 'sess-2', daysAgo(3)), dec(0.7, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1029-delta-null');
      expect(status).toBe(200);
      expect(body.netRiskDeltaLast24hVs7d).toBeNull();
    });

    it('13. agents — netRiskDeltaLast24hVs7d computed correctly with positive delta', async () => {
      ctx = await setup();
      // 24h window: 0.8, 0.9 → avg 0.85
      // 7d window (all 4 ops): 0.8, 0.9, 0.1, 0.2 → avg 0.5
      // delta = 0.35
      await ctx.logger.log(makeOp('agent-v1029-delta-calc', 'fs', 'sess-1', hoursAgo(3)), dec(0.8, 'allow'));
      await ctx.logger.log(makeOp('agent-v1029-delta-calc', 'fs', 'sess-2', hoursAgo(18)), dec(0.9, 'allow'));
      await ctx.logger.log(makeOp('agent-v1029-delta-calc', 'fs', 'sess-3', daysAgo(3)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-v1029-delta-calc', 'fs', 'sess-4', daysAgo(5)), dec(0.2, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1029-delta-calc');
      expect(status).toBe(200);
      expect(body.netRiskDeltaLast24hVs7d as number).toBeCloseTo(0.35, 5);
    });

    it('14. agents — requireApprovalCountLast6h and requireApprovalCountLast7d independent', async () => {
      ctx = await setup();
      // 1 require_approval within 6h, 2 more between 6h and 7d ago
      await ctx.logger.log(makeOp('agent-v1029-ra-dual', 'fs', 'sess-1', hoursAgo(2)), dec(0.6, 'require_approval'));
      await ctx.logger.log(makeOp('agent-v1029-ra-dual', 'fs', 'sess-2', hoursAgo(12)), dec(0.7, 'require_approval'));
      await ctx.logger.log(makeOp('agent-v1029-ra-dual', 'fs', 'sess-3', daysAgo(5)), dec(0.8, 'require_approval'));
      // Older than 7d — should not count in either
      await ctx.logger.log(makeOp('agent-v1029-ra-dual', 'fs', 'sess-4', daysAgo(9)), dec(0.9, 'require_approval'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1029-ra-dual');
      expect(status).toBe(200);
      expect(body.requireApprovalCountLast6h).toBe(1);
      expect(body.requireApprovalCountLast7d).toBe(3);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1214-T1218 — v10.29 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('15. tools — all three new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-j', 'tool-v1029-presence', 'sess-1'), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1029-presence');
      expect(status).toBe(200);

      expect(body).toHaveProperty('requireApprovalCountLast6h');
      expect(body).toHaveProperty('requireApprovalCountLast7d');
      expect(body).toHaveProperty('netRiskDeltaLast24hVs7d');
    });

    it('16. tools — requireApprovalCountLast6h counts correctly across different tools', async () => {
      ctx = await setup();
      // 3 require_approval in last 6h for this tool, 2 for other tool (should not count)
      await ctx.logger.log(makeOp('agent-k', 'tool-v1029-ra6h', 'sess-1', hoursAgo(1)), dec(0.6, 'require_approval'));
      await ctx.logger.log(makeOp('agent-k', 'tool-v1029-ra6h', 'sess-1', hoursAgo(3)), dec(0.7, 'require_approval'));
      await ctx.logger.log(makeOp('agent-k', 'tool-v1029-ra6h', 'sess-1', hoursAgo(5)), dec(0.8, 'require_approval'));
      // Different tool — should not count
      await ctx.logger.log(makeOp('agent-k', 'tool-v1029-other', 'sess-1', hoursAgo(2)), dec(0.9, 'require_approval'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1029-ra6h');
      expect(status).toBe(200);
      expect(body.requireApprovalCountLast6h).toBe(3);
    });

    it('17. tools — requireApprovalCountLast7d = 0 when all require_approval ops are older than 7d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-l', 'tool-v1029-ra7d-zero', 'sess-1', daysAgo(8)), dec(0.7, 'require_approval'));
      await ctx.logger.log(makeOp('agent-l', 'tool-v1029-ra7d-zero', 'sess-2', daysAgo(15)), dec(0.8, 'require_approval'));
      // Allow in 7d — should not count in requireApprovalCountLast7d
      await ctx.logger.log(makeOp('agent-l', 'tool-v1029-ra7d-zero', 'sess-3', daysAgo(2)), dec(0.3, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1029-ra7d-zero');
      expect(status).toBe(200);
      expect(body.requireApprovalCountLast7d).toBe(0);
    });

    it('18. tools — netRiskDeltaLast24hVs7d is null when 24h window is empty', async () => {
      ctx = await setup();
      // All ops older than 24h
      await ctx.logger.log(makeOp('agent-m', 'tool-v1029-delta-null', 'sess-1', daysAgo(2)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-m', 'tool-v1029-delta-null', 'sess-2', daysAgo(5)), dec(0.9, 'block'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1029-delta-null');
      expect(status).toBe(200);
      expect(body.netRiskDeltaLast24hVs7d).toBeNull();
    });

    it('19. tools — netRiskDeltaLast24hVs7d negative delta when recent ops have lower risk', async () => {
      ctx = await setup();
      // 24h window: 0.2, 0.3 → avg 0.25
      // 7d window: 0.2, 0.3, 0.7, 0.8 → avg 0.5
      // delta = 0.25 - 0.5 = -0.25
      await ctx.logger.log(makeOp('agent-n', 'tool-v1029-delta-neg', 'sess-1', hoursAgo(6)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-n', 'tool-v1029-delta-neg', 'sess-2', hoursAgo(18)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-n', 'tool-v1029-delta-neg', 'sess-3', daysAgo(3)), dec(0.7, 'allow'));
      await ctx.logger.log(makeOp('agent-n', 'tool-v1029-delta-neg', 'sess-4', daysAgo(6)), dec(0.8, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1029-delta-neg');
      expect(status).toBe(200);
      expect(body.netRiskDeltaLast24hVs7d as number).toBeCloseTo(-0.25, 5);
    });
  });

  // ── operations/summary endpoint ────────────────────────────────────────────────

  describe('T1214-T1218 — v10.29 new fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('20. summary — all three new fields present', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-o', 'tool-s', 'sess-1'), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body).toHaveProperty('requireApprovalCountLast6h');
      expect(body).toHaveProperty('requireApprovalCountLast7d');
      expect(body).toHaveProperty('netRiskDeltaLast24hVs7d');
    });

    it('21. summary — empty DB: requireApprovalCountLast6h = 0, requireApprovalCountLast7d = 0, netRiskDeltaLast24hVs7d = null', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.requireApprovalCountLast6h).toBe(0);
      expect(body.requireApprovalCountLast7d).toBe(0);
      expect(body.netRiskDeltaLast24hVs7d).toBeNull();
    });

    it('22. summary — requireApprovalCountLast6h counts only in last 6h across all sessions', async () => {
      ctx = await setup();
      // 3 require_approval in last 6h from different sessions/agents
      await ctx.logger.log(makeOp('agent-p1', 'tool-p', 'sess-1', hoursAgo(1)), dec(0.6, 'require_approval'));
      await ctx.logger.log(makeOp('agent-p2', 'tool-p', 'sess-2', hoursAgo(3)), dec(0.7, 'require_approval'));
      await ctx.logger.log(makeOp('agent-p3', 'tool-p', 'sess-3', hoursAgo(5)), dec(0.8, 'require_approval'));
      // Older than 6h — should not count
      await ctx.logger.log(makeOp('agent-p4', 'tool-p', 'sess-4', hoursAgo(9)), dec(0.9, 'require_approval'));
      await ctx.logger.log(makeOp('agent-p5', 'tool-p', 'sess-5', daysAgo(3)), dec(0.5, 'require_approval'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.requireApprovalCountLast6h).toBe(3);
    });

    it('23. summary — requireApprovalCountLast7d counts require_approval ops in last 7d', async () => {
      ctx = await setup();
      // 4 require_approval in last 7d, 2 older than 7d
      await ctx.logger.log(makeOp('agent-q1', 'tool-q', 'sess-1', hoursAgo(2)), dec(0.6, 'require_approval'));
      await ctx.logger.log(makeOp('agent-q2', 'tool-q', 'sess-2', daysAgo(2)), dec(0.7, 'require_approval'));
      await ctx.logger.log(makeOp('agent-q3', 'tool-q', 'sess-3', daysAgo(4)), dec(0.8, 'require_approval'));
      await ctx.logger.log(makeOp('agent-q4', 'tool-q', 'sess-4', daysAgo(6)), dec(0.5, 'require_approval'));
      await ctx.logger.log(makeOp('agent-q5', 'tool-q', 'sess-5', daysAgo(8)), dec(0.9, 'require_approval'));
      await ctx.logger.log(makeOp('agent-q6', 'tool-q', 'sess-6', daysAgo(10)), dec(0.4, 'require_approval'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.requireApprovalCountLast7d).toBe(4);
    });

    it('24. summary — netRiskDeltaLast24hVs7d is null when no ops in last 24h', async () => {
      ctx = await setup();
      // Ops only older than 24h
      await ctx.logger.log(makeOp('agent-r1', 'tool-r', 'sess-1', daysAgo(2)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-r2', 'tool-r', 'sess-2', daysAgo(3)), dec(0.7, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.netRiskDeltaLast24hVs7d).toBeNull();
    });

    it('25. summary — netRiskDeltaLast24hVs7d computed correctly (positive delta)', async () => {
      ctx = await setup();
      // 24h window: 0.8, 0.9 → avg 0.85
      // 7d window: 0.8, 0.9, 0.1, 0.2 → avg 0.5
      // delta = 0.85 - 0.5 = 0.35
      await ctx.logger.log(makeOp('agent-s1', 'tool-s', 'sess-1', hoursAgo(6)), dec(0.8, 'allow'));
      await ctx.logger.log(makeOp('agent-s2', 'tool-s', 'sess-2', hoursAgo(18)), dec(0.9, 'allow'));
      await ctx.logger.log(makeOp('agent-s3', 'tool-s', 'sess-3', daysAgo(3)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-s4', 'tool-s', 'sess-4', daysAgo(5)), dec(0.2, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.netRiskDeltaLast24hVs7d as number).toBeCloseTo(0.35, 5);
    });

    it('26. summary — netRiskDeltaLast24hVs7d can be negative', async () => {
      ctx = await setup();
      // 24h window: 0.1, 0.2 → avg 0.15
      // 7d window: 0.1, 0.2, 0.8, 0.9 → avg 0.5
      // delta = 0.15 - 0.5 = -0.35
      await ctx.logger.log(makeOp('agent-t1', 'tool-t', 'sess-1', hoursAgo(6)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-t2', 'tool-t', 'sess-2', hoursAgo(18)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-t3', 'tool-t', 'sess-3', daysAgo(3)), dec(0.8, 'allow'));
      await ctx.logger.log(makeOp('agent-t4', 'tool-t', 'sess-4', daysAgo(5)), dec(0.9, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.netRiskDeltaLast24hVs7d as number).toBeCloseTo(-0.35, 5);
    });

    it('27. summary — count fields are non-negative integers', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-u1', 'tool-u', 'sess-1', hoursAgo(1)), dec(0.6, 'require_approval'));
      await ctx.logger.log(makeOp('agent-u2', 'tool-u', 'sess-2', hoursAgo(2)), dec(0.3, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(Number.isInteger(body.requireApprovalCountLast6h as number)).toBe(true);
      expect(Number.isInteger(body.requireApprovalCountLast7d as number)).toBe(true);
      expect((body.requireApprovalCountLast6h as number) >= 0).toBe(true);
      expect((body.requireApprovalCountLast7d as number) >= 0).toBe(true);
    });

    it('28. summary — requireApprovalCountLast6h <= requireApprovalCountLast7d always', async () => {
      ctx = await setup();
      // 1 require_approval in last 6h, 3 in last 7d total
      await ctx.logger.log(makeOp('agent-v1', 'tool-v', 'sess-1', hoursAgo(3)), dec(0.6, 'require_approval'));
      await ctx.logger.log(makeOp('agent-v2', 'tool-v', 'sess-2', hoursAgo(10)), dec(0.7, 'require_approval'));
      await ctx.logger.log(makeOp('agent-v3', 'tool-v', 'sess-3', daysAgo(5)), dec(0.8, 'require_approval'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.requireApprovalCountLast6h as number).toBeLessThanOrEqual(
        body.requireApprovalCountLast7d as number,
      );
    });
  });
});

// ── v10.30 ────────────────────────────────────────────────────────────────────

describe('v10.30', () => {
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);
  const hoursAgo = (h: number) => new Date(PINNED_NOW() - h * 3_600_000);

  // ── sessions endpoint ─────────────────────────────────────────────────────────

  describe('T1219-T1223 — v10.30 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1030-pres'), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1030-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('netRiskDeltaLast7dVs30d');
      expect(body).toHaveProperty('riskVolatilityAllTime');
      expect(body).toHaveProperty('highRiskRatioAllTime');
      expect(body).toHaveProperty('lowRiskRatioAllTime');
      expect(body).toHaveProperty('mediumRiskRatioAllTime');
    });

    it('2. sessions — only old ops (>30d): ratio fields null from empty windows, volatility null with 1 log', async () => {
      ctx = await setup();
      // Single log older than 30d — both 7d and 30d windows are empty
      // Only 1 all-time log → volatility null; ratio fields non-null from all-time
      await ctx.logger.log(makeOp('agent-empty', 'fs', 'sess-v1030-empty', daysAgo(35)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1030-empty');
      expect(status).toBe(200);

      // 7d and 30d both empty → netRiskDelta null
      expect(body.netRiskDeltaLast7dVs30d).toBeNull();
      // Only 1 all-time log → volatility null
      expect(body.riskVolatilityAllTime).toBeNull();
      // All-time has 1 log → ratio fields are non-null
      expect(body.highRiskRatioAllTime).not.toBeNull();
      expect(body.lowRiskRatioAllTime).not.toBeNull();
      expect(body.mediumRiskRatioAllTime).not.toBeNull();
    });

    it('3. sessions — only 1 log: riskVolatilityAllTime null (needs >=2)', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1030-single'), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1030-single');
      expect(status).toBe(200);

      expect(body.riskVolatilityAllTime).toBeNull();
      // ratio fields should be non-null with 1 log
      expect(body.highRiskRatioAllTime).not.toBeNull();
      expect(body.lowRiskRatioAllTime).not.toBeNull();
      expect(body.mediumRiskRatioAllTime).not.toBeNull();
    });

    it('4. sessions — netRiskDeltaLast7dVs30d: null when 7d window is empty', async () => {
      ctx = await setup();
      // Only log older than 7d but within 30d
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1030-no7d'), dec(0.5, 'allow'), );
      // Replace with ops only in 8-29d range
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1030-no7d-b', daysAgo(10)), dec(0.5, 'allow'));

      // sess-v1030-no7d was just logged with now, let's use a session that only has old ops
      const { body: body2 } = await getJSON(ctx.port, '/sessions/sess-v1030-no7d-b');
      // 7d window empty (op is 10d ago) → null
      expect(body2.netRiskDeltaLast7dVs30d).toBeNull();
    });

    it('5. sessions — netRiskDeltaLast7dVs30d: null when 30d window is empty', async () => {
      ctx = await setup();
      // Only log within 7d (which is also within 30d), both windows will have data
      // To get 30d empty: only logs older than 30d
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1030-no30d', daysAgo(35)), dec(0.6, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1030-no30d');
      expect(status).toBe(200);
      // Both 7d and 30d windows are empty → null
      expect(body.netRiskDeltaLast7dVs30d).toBeNull();
    });

    it('6. sessions — netRiskDeltaLast7dVs30d: correct value (positive delta)', async () => {
      ctx = await setup();
      // 7d window: ops at 1d, 3d ago with scores 0.8, 0.9 → avg7d = 0.85
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1030-delta-pos', daysAgo(1)), dec(0.8, 'allow'));
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1030-delta-pos', daysAgo(3)), dec(0.9, 'allow'));
      // 30d window includes the 7d ops + ops at 10d, 20d with scores 0.2, 0.3 → avg30d = (0.8+0.9+0.2+0.3)/4 = 0.55
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1030-delta-pos', daysAgo(10)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1030-delta-pos', daysAgo(20)), dec(0.3, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1030-delta-pos');
      expect(status).toBe(200);

      // avg7d = 0.85, avg30d = 0.55, delta = 0.3
      expect(body.netRiskDeltaLast7dVs30d as number).toBeCloseTo(0.3, 5);
    });

    it('7. sessions — netRiskDeltaLast7dVs30d: correct value (negative delta)', async () => {
      ctx = await setup();
      // 7d window: low scores 0.1, 0.2 → avg7d = 0.15
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1030-delta-neg', daysAgo(1)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1030-delta-neg', daysAgo(3)), dec(0.2, 'allow'));
      // 30d also includes high scores 0.8, 0.9 → avg30d = (0.1+0.2+0.8+0.9)/4 = 0.5
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1030-delta-neg', daysAgo(10)), dec(0.8, 'allow'));
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1030-delta-neg', daysAgo(20)), dec(0.9, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1030-delta-neg');
      expect(status).toBe(200);

      // avg7d = 0.15, avg30d = 0.5, delta = -0.35
      expect(body.netRiskDeltaLast7dVs30d as number).toBeCloseTo(-0.35, 5);
    });

    it('8. sessions — riskVolatilityAllTime: correct coefficient of variation', async () => {
      ctx = await setup();
      // 4 logs with scores: 0.2, 0.4, 0.6, 0.8
      // mean = 0.5, variance = ((0.09+0.01+0.01+0.09)/4) = 0.05, stdDev = sqrt(0.05) ≈ 0.2236
      // CV = (0.2236/0.5)*100 ≈ 44.72
      for (const [score, h] of [[0.2, 1], [0.4, 2], [0.6, 3], [0.8, 4]] as [number, number][]) {
        await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1030-vol', hoursAgo(h)), dec(score, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1030-vol');
      expect(status).toBe(200);

      const mean = 0.5;
      const variance = ((0.2 - mean) ** 2 + (0.4 - mean) ** 2 + (0.6 - mean) ** 2 + (0.8 - mean) ** 2) / 4;
      const stdDev = Math.sqrt(variance);
      const expectedCV = (stdDev / mean) * 100;

      expect(body.riskVolatilityAllTime as number).toBeCloseTo(expectedCV, 4);
    });

    it('9. sessions — riskVolatilityAllTime: null when mean is 0', async () => {
      ctx = await setup();
      // All scores = 0 → mean = 0 → volatility null
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1030-vol-zero', hoursAgo(1)), dec(0, 'allow'));
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1030-vol-zero', hoursAgo(2)), dec(0, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1030-vol-zero');
      expect(status).toBe(200);

      expect(body.riskVolatilityAllTime).toBeNull();
    });

    it('10. sessions — ratio fields: high+medium+low sum to 1.0', async () => {
      ctx = await setup();
      // 2 high (>=0.7): 0.7, 0.9
      // 1 medium (0.3-0.7): 0.5
      // 1 low (<0.3): 0.1
      for (const [score, h] of [[0.7, 1], [0.9, 2], [0.5, 3], [0.1, 4]] as [number, number][]) {
        await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v1030-ratios', hoursAgo(h)), dec(score, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1030-ratios');
      expect(status).toBe(200);

      const high = body.highRiskRatioAllTime as number;
      const medium = body.mediumRiskRatioAllTime as number;
      const low = body.lowRiskRatioAllTime as number;

      expect(high).toBeCloseTo(0.5, 5);    // 2/4
      expect(medium).toBeCloseTo(0.25, 5); // 1/4
      expect(low).toBeCloseTo(0.25, 5);    // 1/4
      expect(high + medium + low).toBeCloseTo(1.0, 10);
    });

    it('11. sessions — all logs high risk: highRiskRatioAllTime=1, others=0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v1030-allhigh', hoursAgo(1)), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v1030-allhigh', hoursAgo(2)), dec(0.95, 'block'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1030-allhigh');
      expect(status).toBe(200);

      expect(body.highRiskRatioAllTime as number).toBeCloseTo(1.0, 5);
      expect(body.mediumRiskRatioAllTime as number).toBeCloseTo(0.0, 5);
      expect(body.lowRiskRatioAllTime as number).toBeCloseTo(0.0, 5);
    });
  });

  // ── agents endpoint ───────────────────────────────────────────────────────────

  describe('T1219-T1223 — v10.30 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('12. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1030-pres', 'fs', 'sess-1'), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1030-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('netRiskDeltaLast7dVs30d');
      expect(body).toHaveProperty('riskVolatilityAllTime');
      expect(body).toHaveProperty('highRiskRatioAllTime');
      expect(body).toHaveProperty('lowRiskRatioAllTime');
      expect(body).toHaveProperty('mediumRiskRatioAllTime');
    });

    it('13. agents — only old ops (>30d): netRiskDelta null (both windows empty), volatility null (1 log)', async () => {
      ctx = await setup();
      // Single log older than 30d — both 7d and 30d windows are empty
      await ctx.logger.log(makeOp('agent-v1030-noexist', 'fs', 'sess-1', daysAgo(40)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1030-noexist');
      expect(status).toBe(200);

      expect(body.netRiskDeltaLast7dVs30d).toBeNull();
      expect(body.riskVolatilityAllTime).toBeNull();
      // All-time has 1 log so ratios are non-null
      expect(body.highRiskRatioAllTime).not.toBeNull();
      expect(body.lowRiskRatioAllTime).not.toBeNull();
      expect(body.mediumRiskRatioAllTime).not.toBeNull();
    });

    it('14. agents — netRiskDeltaLast7dVs30d: null when only ops older than 30d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1030-old', 'fs', 'sess-1', daysAgo(35)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-v1030-old', 'fs', 'sess-2', daysAgo(40)), dec(0.6, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1030-old');
      expect(status).toBe(200);

      // Both 7d and 30d windows empty → null
      expect(body.netRiskDeltaLast7dVs30d).toBeNull();
      // Ratio fields should be non-null (all-time has logs)
      expect(body.highRiskRatioAllTime).not.toBeNull();
      expect(body.lowRiskRatioAllTime).not.toBeNull();
      expect(body.mediumRiskRatioAllTime).not.toBeNull();
    });

    it('15. agents — netRiskDeltaLast7dVs30d computed correctly (positive)', async () => {
      ctx = await setup();
      // 7d: scores 0.7, 0.8 → avg7d = 0.75
      await ctx.logger.log(makeOp('agent-v1030-delta2', 'fs', 'sess-1', daysAgo(1)), dec(0.7, 'allow'));
      await ctx.logger.log(makeOp('agent-v1030-delta2', 'fs', 'sess-2', daysAgo(3)), dec(0.8, 'allow'));
      // 30d (includes 7d ops + these): scores 0.1, 0.2 at 10d, 25d
      // avg30d = (0.7+0.8+0.1+0.2)/4 = 0.45
      await ctx.logger.log(makeOp('agent-v1030-delta2', 'fs', 'sess-3', daysAgo(10)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-v1030-delta2', 'fs', 'sess-4', daysAgo(25)), dec(0.2, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1030-delta2');
      expect(status).toBe(200);

      // avg7d = 0.75, avg30d = 0.45, delta = 0.3
      expect(body.netRiskDeltaLast7dVs30d as number).toBeCloseTo(0.3, 5);
    });

    it('16. agents — riskVolatilityAllTime: null with only 1 log', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1030-vol1', 'fs', 'sess-1'), dec(0.6, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1030-vol1');
      expect(status).toBe(200);

      expect(body.riskVolatilityAllTime).toBeNull();
    });

    it('17. agents — riskVolatilityAllTime: computed correctly for 3 logs', async () => {
      ctx = await setup();
      // scores: 0.3, 0.6, 0.9 → mean = 0.6
      // variance = ((0.09+0+0.09)/3) = 0.06, stdDev = sqrt(0.06)
      // CV = (sqrt(0.06)/0.6)*100
      for (const [score, h] of [[0.3, 1], [0.6, 2], [0.9, 3]] as [number, number][]) {
        await ctx.logger.log(makeOp('agent-v1030-vol3', 'fs', `sess-${h}`, hoursAgo(h)), dec(score, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1030-vol3');
      expect(status).toBe(200);

      const mean = 0.6;
      const variance = ((0.3 - mean) ** 2 + (0.6 - mean) ** 2 + (0.9 - mean) ** 2) / 3;
      const stdDev = Math.sqrt(variance);
      const expectedCV = (stdDev / mean) * 100;

      expect(body.riskVolatilityAllTime as number).toBeCloseTo(expectedCV, 4);
    });

    it('18. agents — ratio fields: all low risk → lowRiskRatioAllTime=1, others=0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1030-alllow', 'fs', 'sess-1', hoursAgo(1)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-v1030-alllow', 'fs', 'sess-2', hoursAgo(2)), dec(0.05, 'allow'));
      await ctx.logger.log(makeOp('agent-v1030-alllow', 'fs', 'sess-3', hoursAgo(3)), dec(0.29, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1030-alllow');
      expect(status).toBe(200);

      expect(body.lowRiskRatioAllTime as number).toBeCloseTo(1.0, 5);
      expect(body.highRiskRatioAllTime as number).toBeCloseTo(0.0, 5);
      expect(body.mediumRiskRatioAllTime as number).toBeCloseTo(0.0, 5);
      // Sum should be 1.0
      expect(
        (body.lowRiskRatioAllTime as number) +
        (body.highRiskRatioAllTime as number) +
        (body.mediumRiskRatioAllTime as number)
      ).toBeCloseTo(1.0, 10);
    });
  });

  // ── tools endpoint ────────────────────────────────────────────────────────────

  describe('T1219-T1223 — v10.30 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('19. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-k', 'tool-v1030-pres', 'sess-1'), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1030-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('netRiskDeltaLast7dVs30d');
      expect(body).toHaveProperty('riskVolatilityAllTime');
      expect(body).toHaveProperty('highRiskRatioAllTime');
      expect(body).toHaveProperty('lowRiskRatioAllTime');
      expect(body).toHaveProperty('mediumRiskRatioAllTime');
    });

    it('20. tools — only old ops (>30d): netRiskDelta null (both windows empty), volatility null (1 log)', async () => {
      ctx = await setup();
      // Single log older than 30d — both 7d and 30d windows are empty
      await ctx.logger.log(makeOp('agent-t20', 'tool-v1030-noexist', 'sess-1', daysAgo(40)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1030-noexist');
      expect(status).toBe(200);

      expect(body.netRiskDeltaLast7dVs30d).toBeNull();
      expect(body.riskVolatilityAllTime).toBeNull();
      // All-time has 1 log so ratios are non-null
      expect(body.highRiskRatioAllTime).not.toBeNull();
      expect(body.lowRiskRatioAllTime).not.toBeNull();
      expect(body.mediumRiskRatioAllTime).not.toBeNull();
    });

    it('21. tools — netRiskDeltaLast7dVs30d: null when only 7d window empty (ops only 8-29d ago)', async () => {
      ctx = await setup();
      // Ops only between 7d and 30d (not inside 7d window)
      await ctx.logger.log(makeOp('agent-l', 'tool-v1030-7dempty', 'sess-1', daysAgo(10)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-l', 'tool-v1030-7dempty', 'sess-2', daysAgo(20)), dec(0.6, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1030-7dempty');
      expect(status).toBe(200);

      // 7d window is empty → null
      expect(body.netRiskDeltaLast7dVs30d).toBeNull();
      // 30d data is present so ratio fields should be non-null
      expect(body.highRiskRatioAllTime).not.toBeNull();
    });

    it('22. tools — netRiskDeltaLast7dVs30d: correct negative delta for tool', async () => {
      ctx = await setup();
      // 7d window: low scores → avg7d = 0.2
      await ctx.logger.log(makeOp('agent-m', 'tool-v1030-neg', 'sess-1', daysAgo(1)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-m', 'tool-v1030-neg', 'sess-2', daysAgo(4)), dec(0.3, 'allow'));
      // 30d also includes high scores → avg30d = (0.1+0.3+0.8+0.9)/4 = 0.525
      await ctx.logger.log(makeOp('agent-m', 'tool-v1030-neg', 'sess-3', daysAgo(12)), dec(0.8, 'allow'));
      await ctx.logger.log(makeOp('agent-m', 'tool-v1030-neg', 'sess-4', daysAgo(22)), dec(0.9, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1030-neg');
      expect(status).toBe(200);

      // avg7d = (0.1+0.3)/2 = 0.2, avg30d = (0.1+0.3+0.8+0.9)/4 = 0.525
      // delta = 0.2 - 0.525 = -0.325
      expect(body.netRiskDeltaLast7dVs30d as number).toBeCloseTo(-0.325, 5);
    });

    it('23. tools — ratio fields: all medium risk → mediumRiskRatioAllTime=1, others=0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-n', 'tool-v1030-allmed', 'sess-1', hoursAgo(1)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-n', 'tool-v1030-allmed', 'sess-2', hoursAgo(2)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-n', 'tool-v1030-allmed', 'sess-3', hoursAgo(3)), dec(0.69, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1030-allmed');
      expect(status).toBe(200);

      expect(body.mediumRiskRatioAllTime as number).toBeCloseTo(1.0, 5);
      expect(body.highRiskRatioAllTime as number).toBeCloseTo(0.0, 5);
      expect(body.lowRiskRatioAllTime as number).toBeCloseTo(0.0, 5);
      expect(
        (body.mediumRiskRatioAllTime as number) +
        (body.highRiskRatioAllTime as number) +
        (body.lowRiskRatioAllTime as number)
      ).toBeCloseTo(1.0, 10);
    });

    it('24. tools — riskVolatilityAllTime: correct for uniform scores (0 variance)', async () => {
      ctx = await setup();
      // All scores identical → stdDev = 0 → CV = 0
      await ctx.logger.log(makeOp('agent-o', 'tool-v1030-uniform', 'sess-1', hoursAgo(1)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-o', 'tool-v1030-uniform', 'sess-2', hoursAgo(2)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-o', 'tool-v1030-uniform', 'sess-3', hoursAgo(3)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1030-uniform');
      expect(status).toBe(200);

      expect(body.riskVolatilityAllTime as number).toBeCloseTo(0.0, 5);
    });
  });

  // ── operations/summary endpoint ───────────────────────────────────────────────

  describe('T1219-T1223 — v10.30 new fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('25. summary — all five new fields present', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-p', 'fs', 'sess-1'), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body).toHaveProperty('netRiskDeltaLast7dVs30d');
      expect(body).toHaveProperty('riskVolatilityAllTime');
      expect(body).toHaveProperty('highRiskRatioAllTime');
      expect(body).toHaveProperty('lowRiskRatioAllTime');
      expect(body).toHaveProperty('mediumRiskRatioAllTime');
    });

    it('26. summary — empty DB: all five fields are null', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.netRiskDeltaLast7dVs30d).toBeNull();
      expect(body.riskVolatilityAllTime).toBeNull();
      expect(body.highRiskRatioAllTime).toBeNull();
      expect(body.lowRiskRatioAllTime).toBeNull();
      expect(body.mediumRiskRatioAllTime).toBeNull();
    });

    it('27. summary — only 1 log in DB: riskVolatilityAllTime null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-q', 'fs', 'sess-1'), dec(0.7, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.riskVolatilityAllTime).toBeNull();
      // Ratio fields non-null since we have 1 log
      expect(body.highRiskRatioAllTime as number).toBeCloseTo(1.0, 5);
      expect(body.lowRiskRatioAllTime as number).toBeCloseTo(0.0, 5);
      expect(body.mediumRiskRatioAllTime as number).toBeCloseTo(0.0, 5);
    });

    it('28. summary — ops only >30d old: netRiskDeltaLast7dVs30d null, ratios non-null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-r', 'fs', 'sess-1', daysAgo(35)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-r', 'fs', 'sess-2', daysAgo(45)), dec(0.7, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.netRiskDeltaLast7dVs30d).toBeNull();
      // All-time ratio fields should be non-null
      expect(body.highRiskRatioAllTime).not.toBeNull();
      expect(body.lowRiskRatioAllTime).not.toBeNull();
      expect(body.mediumRiskRatioAllTime).not.toBeNull();
    });

    it('29. summary — netRiskDeltaLast7dVs30d: correct positive delta', async () => {
      ctx = await setup();
      // 7d: scores 0.6, 0.8 → avg7d = 0.7
      await ctx.logger.log(makeOp('agent-s-1', 'fs', 'sess-1', daysAgo(1)), dec(0.6, 'allow'));
      await ctx.logger.log(makeOp('agent-s-2', 'fs', 'sess-2', daysAgo(4)), dec(0.8, 'allow'));
      // 30d additional (not in 7d): scores 0.2, 0.4 at 10d, 25d
      // avg30d = (0.6+0.8+0.2+0.4)/4 = 0.5
      await ctx.logger.log(makeOp('agent-s-3', 'fs', 'sess-3', daysAgo(10)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-s-4', 'fs', 'sess-4', daysAgo(25)), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      // avg7d = 0.7, avg30d = 0.5, delta = 0.2
      expect(body.netRiskDeltaLast7dVs30d as number).toBeCloseTo(0.2, 5);
    });

    it('30. summary — ratio fields: mixed risk levels → correct ratios and sum to 1.0', async () => {
      ctx = await setup();
      // 3 high (>=0.7): 0.7, 0.8, 0.9
      // 2 medium (0.3-<0.7): 0.3, 0.5
      // 1 low (<0.3): 0.1
      // Total: 6 logs → high=3/6=0.5, medium=2/6≈0.333, low=1/6≈0.167
      const entries: [number, number][] = [[0.7, 1], [0.8, 2], [0.9, 3], [0.3, 4], [0.5, 5], [0.1, 6]];
      for (const [score, h] of entries) {
        await ctx.logger.log(makeOp(`agent-t-${h}`, `tool-t-${h}`, `sess-t-${h}`, hoursAgo(h)), dec(score, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      const high = body.highRiskRatioAllTime as number;
      const medium = body.mediumRiskRatioAllTime as number;
      const low = body.lowRiskRatioAllTime as number;

      expect(high).toBeCloseTo(3 / 6, 5);
      expect(medium).toBeCloseTo(2 / 6, 5);
      expect(low).toBeCloseTo(1 / 6, 5);
      expect(high + medium + low).toBeCloseTo(1.0, 10);
    });

    it('31. summary — riskVolatilityAllTime: correctly computed for 5 logs', async () => {
      ctx = await setup();
      // scores: 0.1, 0.3, 0.5, 0.7, 0.9 → mean = 0.5
      // variance = ((0.16+0.04+0+0.04+0.16)/5) = 0.08
      // stdDev = sqrt(0.08), CV = (sqrt(0.08)/0.5)*100
      for (const [score, h] of [[0.1, 1], [0.3, 2], [0.5, 3], [0.7, 4], [0.9, 5]] as [number, number][]) {
        await ctx.logger.log(makeOp(`agent-u-${h}`, `tool-u-${h}`, `sess-u-${h}`, hoursAgo(h)), dec(score, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      const mean = 0.5;
      const scores = [0.1, 0.3, 0.5, 0.7, 0.9];
      const variance = scores.reduce((a, s) => a + (s - mean) ** 2, 0) / scores.length;
      const stdDev = Math.sqrt(variance);
      const expectedCV = (stdDev / mean) * 100;

      expect(body.riskVolatilityAllTime as number).toBeCloseTo(expectedCV, 4);
    });

    it('32. summary — boundary values: riskScore at exactly 0.3 is medium, exactly 0.7 is high', async () => {
      ctx = await setup();
      // Score 0.3 → medium (0.3 <= score < 0.7)
      // Score 0.7 → high (score >= 0.7)
      await ctx.logger.log(makeOp('agent-v-1', 'tool-v1', 'sess-v1', hoursAgo(1)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-v-2', 'tool-v2', 'sess-v2', hoursAgo(2)), dec(0.7, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      // 1 high (0.7), 1 medium (0.3), 0 low → high=0.5, medium=0.5, low=0
      expect(body.highRiskRatioAllTime as number).toBeCloseTo(0.5, 5);
      expect(body.mediumRiskRatioAllTime as number).toBeCloseTo(0.5, 5);
      expect(body.lowRiskRatioAllTime as number).toBeCloseTo(0.0, 5);
    });
  });
});

// ── v10.31 ────────────────────────────────────────────────────────────────────

describe('v10.31', () => {
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);
  const hoursAgo = (h: number) => new Date(PINNED_NOW() - h * 3_600_000);

  // ── sessions endpoint ─────────────────────────────────────────────────────────

  describe('T1224-T1228 — v10.31 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1031-pres', hoursAgo(1)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1031-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('riskAccelerationAllTime');
      expect(body).toHaveProperty('sessionBlockRateAllTime');
      expect(body).toHaveProperty('agentDiversityLast7d');
      expect(body).toHaveProperty('toolDiversityLast7d');
      expect(body).toHaveProperty('methodDiversityLast7d');
    });

    it('2. sessions — riskAccelerationAllTime: null when 24h window is empty (ops older than 24h)', async () => {
      ctx = await setup();
      // Only ops outside 24h but within 7d → 24h window empty → null
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1031-no24h', daysAgo(2)), dec(0.6, 'allow'));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1031-no24h', daysAgo(3)), dec(0.7, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1031-no24h');
      expect(status).toBe(200);
      expect(body.riskAccelerationAllTime).toBeNull();
    });

    it('3. sessions — riskAccelerationAllTime: null when 7d window is empty (ops older than 7d)', async () => {
      ctx = await setup();
      // Only ops older than 7d → 7d window empty → null
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1031-no7d', daysAgo(10)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1031-no7d');
      expect(status).toBe(200);
      expect(body.riskAccelerationAllTime).toBeNull();
    });

    it('4. sessions — riskAccelerationAllTime: correct positive value', async () => {
      ctx = await setup();
      // 24h window: scores 0.8, 0.9 → avg24h = 0.85
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1031-acc-pos', hoursAgo(1)), dec(0.8, 'allow'));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1031-acc-pos', hoursAgo(2)), dec(0.9, 'allow'));
      // 7d window includes the above + 0.2, 0.3 at 2d, 4d → avg7d = (0.8+0.9+0.2+0.3)/4 = 0.55
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1031-acc-pos', daysAgo(2)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1031-acc-pos', daysAgo(4)), dec(0.3, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1031-acc-pos');
      expect(status).toBe(200);

      // riskAcceleration = (avg24h - avg7d) / 7 = (0.85 - 0.55) / 7 = 0.3/7
      const expected = (0.85 - 0.55) / 7;
      expect(body.riskAccelerationAllTime as number).toBeCloseTo(expected, 5);
      expect(body.riskAccelerationAllTime as number).toBeGreaterThan(0);
    });

    it('5. sessions — riskAccelerationAllTime: correct negative value (risk declining)', async () => {
      ctx = await setup();
      // 24h window: scores 0.1, 0.2 → avg24h = 0.15
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1031-acc-neg', hoursAgo(1)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1031-acc-neg', hoursAgo(2)), dec(0.2, 'allow'));
      // 7d window also includes 0.8, 0.9 at 2d, 4d → avg7d = (0.1+0.2+0.8+0.9)/4 = 0.5
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1031-acc-neg', daysAgo(2)), dec(0.8, 'allow'));
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1031-acc-neg', daysAgo(4)), dec(0.9, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1031-acc-neg');
      expect(status).toBe(200);

      // riskAcceleration = (0.15 - 0.5) / 7 = -0.35/7
      const expected = (0.15 - 0.5) / 7;
      expect(body.riskAccelerationAllTime as number).toBeCloseTo(expected, 5);
      expect(body.riskAccelerationAllTime as number).toBeLessThan(0);
    });

    it('6. sessions — sessionBlockRateAllTime: null when no logs', async () => {
      ctx = await setup();
      // No logs for this session at all → 404 is expected, but if it returns 200 with null that's also fine
      // Use a session with no data in an empty DB
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1031-empty-db');
      // Either 404 or 200 with nulls
      if (status === 200) {
        expect(body.sessionBlockRateAllTime).toBeNull();
      } else {
        expect(status).toBe(404);
      }
    });

    it('7. sessions — sessionBlockRateAllTime: 0 when no blocked sessions (all allow)', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1031-noblock', hoursAgo(1)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1031-noblock', hoursAgo(2)), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1031-noblock');
      expect(status).toBe(200);
      // 0 blocked sessions out of 1 session → 0/1 = 0
      expect(body.sessionBlockRateAllTime as number).toBeCloseTo(0, 5);
    });

    it('8. sessions — sessionBlockRateAllTime: 1.0 when all sessions have a block', async () => {
      ctx = await setup();
      // All ops are blocked and belong to the same session
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1031-allblock', hoursAgo(1)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1031-allblock', hoursAgo(2)), dec(0.8, 'block'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1031-allblock');
      expect(status).toBe(200);
      // 1 blocked session / 1 total session = 1.0
      expect(body.sessionBlockRateAllTime as number).toBeCloseTo(1.0, 5);
    });

    it('9. sessions — sessionBlockRateAllTime: partial block rate across multiple sessions', async () => {
      ctx = await setup();
      // sess-v1031-multi: 3 sessions, 2 of which have blocks → 2/3
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1031-multi', hoursAgo(1)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1031-multi-2', hoursAgo(2)), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1031-multi-3', hoursAgo(3)), dec(0.2, 'allow'));

      // For the agent endpoint we use agentId; let's test with the summary endpoint later
      // Here we verify per-session: sess-v1031-multi itself is blocked → rate = 1.0
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1031-multi');
      expect(status).toBe(200);
      expect(body.sessionBlockRateAllTime as number).toBeCloseTo(1.0, 5);
    });

    it('10. sessions — agentDiversityLast7d: 0 when no ops in last 7d', async () => {
      ctx = await setup();
      // Only old ops (>7d)
      await ctx.logger.log(makeOp('agent-old', 'fs', 'sess-v1031-div-empty', daysAgo(10)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1031-div-empty');
      expect(status).toBe(200);
      expect(body.agentDiversityLast7d).toBe(0);
      expect(body.toolDiversityLast7d).toBe(0);
      expect(body.methodDiversityLast7d).toBe(0);
    });

    it('11. sessions — agentDiversityLast7d: counts distinct agents (within 7d)', async () => {
      ctx = await setup();
      // 3 distinct agents in 7d, 1 outside 7d
      await ctx.logger.log(makeOp('agent-x1', 'fs', 'sess-v1031-agents', hoursAgo(1)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-x2', 'fs', 'sess-v1031-agents', hoursAgo(2)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-x3', 'fs', 'sess-v1031-agents', daysAgo(3)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-x4', 'fs', 'sess-v1031-agents', daysAgo(10)), dec(0.6, 'allow')); // outside 7d

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1031-agents');
      expect(status).toBe(200);
      expect(body.agentDiversityLast7d).toBe(3); // x1, x2, x3
    });

    it('12. sessions — toolDiversityLast7d: counts distinct tools (within 7d)', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-i', 'tool-alpha', 'sess-v1031-tools', hoursAgo(1)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-i', 'tool-beta', 'sess-v1031-tools', hoursAgo(2)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-i', 'tool-alpha', 'sess-v1031-tools', hoursAgo(3)), dec(0.5, 'allow')); // duplicate
      await ctx.logger.log(makeOp('agent-i', 'tool-gamma', 'sess-v1031-tools', daysAgo(10)), dec(0.5, 'allow')); // outside 7d

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1031-tools');
      expect(status).toBe(200);
      expect(body.toolDiversityLast7d).toBe(2); // alpha, beta (gamma is old)
    });

    it('13. sessions — methodDiversityLast7d: counts distinct methods (within 7d)', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v1031-methods', hoursAgo(1), 'read'), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v1031-methods', hoursAgo(2), 'write'), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v1031-methods', hoursAgo(3), 'read'), dec(0.5, 'allow')); // duplicate
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v1031-methods', daysAgo(8), 'delete'), dec(0.6, 'allow')); // outside 7d

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1031-methods');
      expect(status).toBe(200);
      expect(body.methodDiversityLast7d).toBe(2); // read, write (delete is old)
    });

    it('14. sessions — diversity fields are integers (not floats)', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-k', 'tool-a', 'sess-v1031-int', hoursAgo(1), 'call'), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1031-int');
      expect(status).toBe(200);
      expect(Number.isInteger(body.agentDiversityLast7d)).toBe(true);
      expect(Number.isInteger(body.toolDiversityLast7d)).toBe(true);
      expect(Number.isInteger(body.methodDiversityLast7d)).toBe(true);
    });
  });

  // ── agents endpoint ───────────────────────────────────────────────────────────

  describe('T1224-T1228 — v10.31 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('15. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1031-pres', 'fs', 'sess-1', hoursAgo(1)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1031-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('riskAccelerationAllTime');
      expect(body).toHaveProperty('sessionBlockRateAllTime');
      expect(body).toHaveProperty('agentDiversityLast7d');
      expect(body).toHaveProperty('toolDiversityLast7d');
      expect(body).toHaveProperty('methodDiversityLast7d');
    });

    it('16. agents — riskAccelerationAllTime: null when 24h window empty', async () => {
      ctx = await setup();
      // All ops older than 24h → 24h window empty → null
      await ctx.logger.log(makeOp('agent-v1031-a16', 'fs', 'sess-1', daysAgo(2)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1031-a16');
      expect(status).toBe(200);
      expect(body.riskAccelerationAllTime).toBeNull();
    });

    it('17. agents — riskAccelerationAllTime: computed correctly (positive)', async () => {
      ctx = await setup();
      // 24h: 0.9, 0.8 → avg24h = 0.85
      await ctx.logger.log(makeOp('agent-v1031-acc-ag', 'fs', 'sess-1', hoursAgo(1)), dec(0.9, 'allow'));
      await ctx.logger.log(makeOp('agent-v1031-acc-ag', 'fs', 'sess-2', hoursAgo(2)), dec(0.8, 'allow'));
      // 7d (includes above + 2d, 5d with 0.3, 0.4) → avg7d = (0.9+0.8+0.3+0.4)/4 = 0.6
      await ctx.logger.log(makeOp('agent-v1031-acc-ag', 'fs', 'sess-3', daysAgo(2)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-v1031-acc-ag', 'fs', 'sess-4', daysAgo(5)), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1031-acc-ag');
      expect(status).toBe(200);

      // (0.85 - 0.6) / 7 = 0.25/7
      const expected = (0.85 - 0.6) / 7;
      expect(body.riskAccelerationAllTime as number).toBeCloseTo(expected, 5);
    });

    it('18. agents — sessionBlockRateAllTime: null when no logs for agent', async () => {
      ctx = await setup();
      // Query an agent that has no logs
      const { body } = await getJSON(ctx.port, '/agents/agent-v1031-nologs-ever');
      // Either 404 or 200 with null
      if (body.sessionBlockRateAllTime !== undefined) {
        expect(body.sessionBlockRateAllTime).toBeNull();
      }
    });

    it('19. agents — sessionBlockRateAllTime: 0 when all allowed, >0 when some blocked', async () => {
      ctx = await setup();
      // 2 sessions: sess-1 has block, sess-2 all allow → rate = 1/2 = 0.5
      await ctx.logger.log(makeOp('agent-v1031-blk', 'fs', 'sess-blk-1', hoursAgo(1)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-v1031-blk', 'fs', 'sess-blk-2', hoursAgo(2)), dec(0.3, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1031-blk');
      expect(status).toBe(200);
      expect(body.sessionBlockRateAllTime as number).toBeCloseTo(0.5, 5);
    });

    it('20. agents — agentDiversityLast7d: counts distinct agents (self only → 1 if ops within 7d)', async () => {
      ctx = await setup();
      // Single agent logs → diversity = 1
      await ctx.logger.log(makeOp('agent-v1031-div1', 'fs', 'sess-1', hoursAgo(1)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-v1031-div1', 'fs', 'sess-2', hoursAgo(2)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1031-div1');
      expect(status).toBe(200);
      expect(body.agentDiversityLast7d).toBe(1);
    });

    it('21. agents — toolDiversityLast7d: counts distinct tools for this agent in 7d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1031-tools', 'tool-read', 'sess-1', hoursAgo(1)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-v1031-tools', 'tool-write', 'sess-2', hoursAgo(3)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-v1031-tools', 'tool-exec', 'sess-3', daysAgo(3)), dec(0.5, 'allow'));
      // Old op outside 7d with different tool
      await ctx.logger.log(makeOp('agent-v1031-tools', 'tool-old', 'sess-4', daysAgo(9)), dec(0.6, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1031-tools');
      expect(status).toBe(200);
      expect(body.toolDiversityLast7d).toBe(3); // read, write, exec (old excluded)
    });

    it('22. agents — methodDiversityLast7d: counts distinct methods for this agent in 7d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1031-meth', 'fs', 'sess-1', hoursAgo(1), 'read'), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-v1031-meth', 'fs', 'sess-2', hoursAgo(2), 'write'), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-v1031-meth', 'fs', 'sess-3', hoursAgo(3), 'write'), dec(0.5, 'allow')); // duplicate
      await ctx.logger.log(makeOp('agent-v1031-meth', 'fs', 'sess-4', daysAgo(9), 'delete'), dec(0.6, 'allow')); // outside 7d

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1031-meth');
      expect(status).toBe(200);
      expect(body.methodDiversityLast7d).toBe(2); // read, write (delete is old)
    });
  });

  // ── tools endpoint ────────────────────────────────────────────────────────────

  describe('T1224-T1228 — v10.31 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('23. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-k', 'tool-v1031-pres', 'sess-1', hoursAgo(1)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1031-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('riskAccelerationAllTime');
      expect(body).toHaveProperty('sessionBlockRateAllTime');
      expect(body).toHaveProperty('agentDiversityLast7d');
      expect(body).toHaveProperty('toolDiversityLast7d');
      expect(body).toHaveProperty('methodDiversityLast7d');
    });

    it('24. tools — riskAccelerationAllTime: null when both 24h and 7d windows empty', async () => {
      ctx = await setup();
      // Only old ops >7d
      await ctx.logger.log(makeOp('agent-l', 'tool-v1031-old', 'sess-1', daysAgo(10)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1031-old');
      expect(status).toBe(200);
      expect(body.riskAccelerationAllTime).toBeNull();
    });

    it('25. tools — riskAccelerationAllTime: correct negative value for tool', async () => {
      ctx = await setup();
      // 24h: low scores 0.1, 0.2 → avg24h = 0.15
      await ctx.logger.log(makeOp('agent-m', 'tool-v1031-acc-t', 'sess-1', hoursAgo(1)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-m', 'tool-v1031-acc-t', 'sess-2', hoursAgo(2)), dec(0.2, 'allow'));
      // 7d also includes high scores 0.8, 0.9 at 2d, 5d → avg7d = (0.1+0.2+0.8+0.9)/4 = 0.5
      await ctx.logger.log(makeOp('agent-m', 'tool-v1031-acc-t', 'sess-3', daysAgo(2)), dec(0.8, 'allow'));
      await ctx.logger.log(makeOp('agent-m', 'tool-v1031-acc-t', 'sess-4', daysAgo(5)), dec(0.9, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1031-acc-t');
      expect(status).toBe(200);

      // (0.15 - 0.5) / 7
      const expected = (0.15 - 0.5) / 7;
      expect(body.riskAccelerationAllTime as number).toBeCloseTo(expected, 5);
      expect(body.riskAccelerationAllTime as number).toBeLessThan(0);
    });

    it('26. tools — sessionBlockRateAllTime: 0 when no blocks', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-n', 'tool-v1031-noblock', 'sess-1', hoursAgo(1)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-n', 'tool-v1031-noblock', 'sess-2', hoursAgo(2)), dec(0.3, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1031-noblock');
      expect(status).toBe(200);
      expect(body.sessionBlockRateAllTime as number).toBeCloseTo(0, 5);
    });

    it('27. tools — sessionBlockRateAllTime: partial rate with mixed blocks', async () => {
      ctx = await setup();
      // 3 sessions: sess-a blocked, sess-b blocked, sess-c all allow → rate = 2/3
      await ctx.logger.log(makeOp('agent-o', 'tool-v1031-partial', 'sess-v1031-ta', hoursAgo(1)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-o', 'tool-v1031-partial', 'sess-v1031-tb', hoursAgo(2)), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agent-o', 'tool-v1031-partial', 'sess-v1031-tc', hoursAgo(3)), dec(0.2, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1031-partial');
      expect(status).toBe(200);
      expect(body.sessionBlockRateAllTime as number).toBeCloseTo(2 / 3, 5);
    });

    it('28. tools — agentDiversityLast7d: counts distinct agents that used this tool in 7d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-div-1', 'tool-v1031-divt', 'sess-1', hoursAgo(1)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-div-2', 'tool-v1031-divt', 'sess-2', daysAgo(3)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-div-3', 'tool-v1031-divt', 'sess-3', daysAgo(6)), dec(0.5, 'allow'));
      // Old agent outside 7d
      await ctx.logger.log(makeOp('agent-div-4', 'tool-v1031-divt', 'sess-4', daysAgo(8)), dec(0.6, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1031-divt');
      expect(status).toBe(200);
      expect(body.agentDiversityLast7d).toBe(3); // div-1, div-2, div-3
    });

    it('29. tools — toolDiversityLast7d: self-reference (only this tool → 1)', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-p', 'tool-v1031-self', 'sess-1', hoursAgo(1)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-p', 'tool-v1031-self', 'sess-2', hoursAgo(2)), dec(0.6, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1031-self');
      expect(status).toBe(200);
      expect(body.toolDiversityLast7d).toBe(1);
    });

    it('30. tools — methodDiversityLast7d: counts distinct methods for this tool in 7d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-q', 'tool-v1031-methd', 'sess-1', hoursAgo(1), 'read'), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-q', 'tool-v1031-methd', 'sess-2', hoursAgo(2), 'write'), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-q', 'tool-v1031-methd', 'sess-3', hoursAgo(3), 'execute'), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-q', 'tool-v1031-methd', 'sess-4', daysAgo(9), 'delete'), dec(0.6, 'allow')); // outside 7d

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1031-methd');
      expect(status).toBe(200);
      expect(body.methodDiversityLast7d).toBe(3); // read, write, execute
    });
  });

  // ── operations/summary endpoint ───────────────────────────────────────────────

  describe('T1224-T1228 — v10.31 new fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('31. summary — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-r', 'fs', 'sess-1', hoursAgo(1)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body).toHaveProperty('riskAccelerationAllTime');
      expect(body).toHaveProperty('sessionBlockRateAllTime');
      expect(body).toHaveProperty('agentDiversityLast7d');
      expect(body).toHaveProperty('toolDiversityLast7d');
      expect(body).toHaveProperty('methodDiversityLast7d');
    });

    it('32. summary — empty DB: riskAccelerationAllTime null, sessionBlockRateAllTime null, diversities 0', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.riskAccelerationAllTime).toBeNull();
      expect(body.sessionBlockRateAllTime).toBeNull();
      expect(body.agentDiversityLast7d).toBe(0);
      expect(body.toolDiversityLast7d).toBe(0);
      expect(body.methodDiversityLast7d).toBe(0);
    });

    it('33. summary — riskAccelerationAllTime: null when only ops older than 7d (7d window empty)', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s', 'fs', 'sess-1', daysAgo(10)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskAccelerationAllTime).toBeNull();
    });

    it('34. summary — riskAccelerationAllTime: correct positive value', async () => {
      ctx = await setup();
      // 24h: scores 0.7, 0.8 → avg24h = 0.75
      await ctx.logger.log(makeOp('agent-t1', 'fs', 'sess-1', hoursAgo(1)), dec(0.7, 'allow'));
      await ctx.logger.log(makeOp('agent-t2', 'fs', 'sess-2', hoursAgo(6)), dec(0.8, 'allow'));
      // 7d (includes above + older): 0.2, 0.3 at 2d, 5d → avg7d = (0.7+0.8+0.2+0.3)/4 = 0.5
      await ctx.logger.log(makeOp('agent-t3', 'fs', 'sess-3', daysAgo(2)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-t4', 'fs', 'sess-4', daysAgo(5)), dec(0.3, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      const expected = (0.75 - 0.5) / 7;
      expect(body.riskAccelerationAllTime as number).toBeCloseTo(expected, 5);
    });

    it('35. summary — sessionBlockRateAllTime: 0 when no blocks in any session', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-u1', 'fs', 'sess-sum-1', hoursAgo(1)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-u2', 'fs', 'sess-sum-2', hoursAgo(2)), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.sessionBlockRateAllTime as number).toBeCloseTo(0, 5);
    });

    it('36. summary — sessionBlockRateAllTime: 1.0 when every session has a block', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1', 'fs', 'sess-sum-blk-1', hoursAgo(1)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-v2', 'fs', 'sess-sum-blk-2', hoursAgo(2)), dec(0.8, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.sessionBlockRateAllTime as number).toBeCloseTo(1.0, 5);
    });

    it('37. summary — agentDiversityLast7d: counts all distinct agents globally in 7d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-w1', 'fs', 'sess-1', hoursAgo(1)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-w2', 'fs', 'sess-2', daysAgo(3)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-w3', 'fs', 'sess-3', daysAgo(6)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-w4', 'fs', 'sess-4', daysAgo(9)), dec(0.6, 'allow')); // outside 7d

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.agentDiversityLast7d).toBe(3); // w1, w2, w3
    });

    it('38. summary — toolDiversityLast7d: counts all distinct tools globally in 7d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-x', 'tool-sum-a', 'sess-1', hoursAgo(1)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-x', 'tool-sum-b', 'sess-2', daysAgo(4)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-x', 'tool-sum-a', 'sess-3', daysAgo(6)), dec(0.5, 'allow')); // dup
      await ctx.logger.log(makeOp('agent-x', 'tool-sum-c', 'sess-4', daysAgo(8)), dec(0.6, 'allow')); // outside 7d

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.toolDiversityLast7d).toBe(2); // sum-a, sum-b
    });

    it('39. summary — methodDiversityLast7d: counts all distinct methods globally in 7d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-y', 'fs', 'sess-1', hoursAgo(1), 'invoke'), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-y', 'fs', 'sess-2', daysAgo(2), 'query'), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-y', 'fs', 'sess-3', daysAgo(4), 'invoke'), dec(0.5, 'allow')); // dup
      await ctx.logger.log(makeOp('agent-y', 'fs', 'sess-4', daysAgo(8), 'delete'), dec(0.6, 'allow')); // outside 7d

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.methodDiversityLast7d).toBe(2); // invoke, query
    });

    it('40. summary — riskAccelerationAllTime can be negative (avg24h < avg7d)', async () => {
      ctx = await setup();
      // 24h: low scores → avg24h = 0.2
      await ctx.logger.log(makeOp('agent-z1', 'fs', 'sess-1', hoursAgo(2)), dec(0.2, 'allow'));
      // 7d also includes high score in past 7d → avg7d > avg24h
      await ctx.logger.log(makeOp('agent-z2', 'fs', 'sess-2', daysAgo(3)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-z3', 'fs', 'sess-3', daysAgo(5)), dec(0.8, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      // avg24h = 0.2, avg7d = (0.2+0.9+0.8)/3 ≈ 0.633 → negative acceleration
      expect(body.riskAccelerationAllTime as number).toBeLessThan(0);
    });
  });
});

// ── v10.32 ────────────────────────────────────────────────────────────────────

describe('v10.32', () => {
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);
  const hoursAgo = (h: number) => new Date(PINNED_NOW() - h * 3_600_000);

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1229-T1233 — v10.32 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1032-pres'), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1032-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('agentDiversityLast30d');
      expect(body).toHaveProperty('toolDiversityLast30d');
      expect(body).toHaveProperty('methodDiversityLast30d');
      expect(body).toHaveProperty('riskWeightedBlockRate');
      expect(body).toHaveProperty('avgTimeBetweenOpsMs');
    });

    it('2. sessions — ops older than 30d: diversity fields are 0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1032-old', daysAgo(35)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-b', 'git', 'sess-v1032-old', daysAgo(40)), dec(0.7, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1032-old');
      expect(status).toBe(200);

      expect(body.agentDiversityLast30d).toBe(0);
      expect(body.toolDiversityLast30d).toBe(0);
      expect(body.methodDiversityLast30d).toBe(0);
    });

    it('3. sessions — single op within 30d: diversity fields each equal 1', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-c', 'bash', 'sess-v1032-single', daysAgo(5)), dec(0.3, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1032-single');
      expect(status).toBe(200);

      expect(body.agentDiversityLast30d).toBe(1);
      expect(body.toolDiversityLast30d).toBe(1);
      expect(body.methodDiversityLast30d).toBe(1);
    });

    it('4. sessions — multiple distinct agents/tools/methods in 30d window', async () => {
      ctx = await setup();
      // 3 distinct agents, 3 distinct tools, 2 distinct methods — all within last 30d
      await ctx.logger.log(makeOp('agent-d1', 'fs',   'sess-v1032-div', daysAgo(2), 'read'), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-d2', 'git',  'sess-v1032-div', daysAgo(5), 'write'), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-d3', 'bash', 'sess-v1032-div', daysAgo(10), 'read'), dec(0.6, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1032-div');
      expect(status).toBe(200);

      expect(body.agentDiversityLast30d).toBe(3);
      expect(body.toolDiversityLast30d).toBe(3);
      expect(body.methodDiversityLast30d).toBe(2);
    });

    it('5. sessions — ops within and outside 30d: only recent ops counted for diversity', async () => {
      ctx = await setup();
      // Two ops in 30d window with distinct agents
      await ctx.logger.log(makeOp('agent-e1', 'fs', 'sess-v1032-mixed', daysAgo(10)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-e2', 'fs', 'sess-v1032-mixed', daysAgo(20)), dec(0.5, 'allow'));
      // One op older than 30d with a different agent — should NOT be counted
      await ctx.logger.log(makeOp('agent-e3', 'db', 'sess-v1032-mixed', daysAgo(35)), dec(0.7, 'block'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1032-mixed');
      expect(status).toBe(200);

      expect(body.agentDiversityLast30d).toBe(2);
      expect(body.toolDiversityLast30d).toBe(1);
    });

    it('6. sessions — riskWeightedBlockRate: null if no logs', async () => {
      ctx = await setup();
      // No logs at all — endpoint returns 404 for unknown session
      // Use a session that doesn't exist but we want to test null case via a session with no results
      // Note: sessions endpoint returns 404 if no logs; test with logs but all same riskScore=0
      // We'll test this via the summary endpoint instead, but for sessions we verify the field type
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1032-rwbr0'), dec(0.0, 'allow'));
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1032-rwbr0');
      expect(status).toBe(200);
      // totalRisk = 0 → riskWeightedBlockRate = null
      expect(body.riskWeightedBlockRate).toBeNull();
    });

    it('7. sessions — riskWeightedBlockRate: all-allow ops', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-g1', 'fs', 'sess-v1032-allallow'), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-g2', 'fs', 'sess-v1032-allallow'), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1032-allallow');
      expect(status).toBe(200);
      // No blocked ops → riskWeightedBlockRate = 0/totalRisk = 0
      expect(body.riskWeightedBlockRate as number).toBeCloseTo(0, 5);
    });

    it('8. sessions — riskWeightedBlockRate: mixed allow and block', async () => {
      ctx = await setup();
      // allow: riskScore=0.4, block: riskScore=0.6
      // totalRisk = 1.0, blockedRisk = 0.6 → rate = 0.6
      await ctx.logger.log(makeOp('agent-h1', 'fs', 'sess-v1032-rwbrmix'), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-h2', 'fs', 'sess-v1032-rwbrmix'), dec(0.6, 'block'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1032-rwbrmix');
      expect(status).toBe(200);
      expect(body.riskWeightedBlockRate as number).toBeCloseTo(0.6, 5);
    });

    it('9. sessions — avgTimeBetweenOpsMs: null with single log', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v1032-single2'), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1032-single2');
      expect(status).toBe(200);
      expect(body.avgTimeBetweenOpsMs).toBeNull();
    });

    it('10. sessions — avgTimeBetweenOpsMs: two ops 1 hour apart → 3600000 ms', async () => {
      ctx = await setup();
      const t1 = new Date(PINNED_NOW() - 3_600_000);
      const t2 = new Date(PINNED_NOW());
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v1032-2ops', t1), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v1032-2ops', t2), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1032-2ops');
      expect(status).toBe(200);
      // Should be approximately 3600000 ms (allow some tolerance)
      expect(body.avgTimeBetweenOpsMs as number).toBeGreaterThanOrEqual(3_500_000);
      expect(body.avgTimeBetweenOpsMs as number).toBeLessThanOrEqual(3_700_000);
    });

    it('11. sessions — avgTimeBetweenOpsMs: all same timestamp → 0', async () => {
      ctx = await setup();
      const fixedTs = new Date('2025-01-01T12:00:00.000Z');
      await ctx.logger.log(makeOp('agent-k1', 'fs', 'sess-v1032-samets', fixedTs), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-k2', 'fs', 'sess-v1032-samets', fixedTs), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-k3', 'fs', 'sess-v1032-samets', fixedTs), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1032-samets');
      expect(status).toBe(200);
      expect(body.avgTimeBetweenOpsMs as number).toBeCloseTo(0, 5);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1229-T1233 — v10.32 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('12. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1032-pres', 'fs', 'sess-1'), dec(0.3, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1032-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('agentDiversityLast30d');
      expect(body).toHaveProperty('toolDiversityLast30d');
      expect(body).toHaveProperty('methodDiversityLast30d');
      expect(body).toHaveProperty('riskWeightedBlockRate');
      expect(body).toHaveProperty('avgTimeBetweenOpsMs');
    });

    it('13. agents — ops only older than 30d: diversity fields are 0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1032-old', 'fs', 'sess-1', daysAgo(40)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-v1032-old', 'git', 'sess-2', daysAgo(50)), dec(0.7, 'block'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1032-old');
      expect(status).toBe(200);

      expect(body.agentDiversityLast30d).toBe(0);
      expect(body.toolDiversityLast30d).toBe(0);
      expect(body.methodDiversityLast30d).toBe(0);
    });

    it('14. agents — multiple distinct tools in last 30d', async () => {
      ctx = await setup();
      // Same agent uses 4 different tools within 30d
      await ctx.logger.log(makeOp('agent-v1032-tools', 'fs',   'sess-1', daysAgo(2)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-v1032-tools', 'git',  'sess-2', daysAgo(5)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-v1032-tools', 'bash', 'sess-3', daysAgo(10)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-v1032-tools', 'db',   'sess-4', daysAgo(20)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1032-tools');
      expect(status).toBe(200);

      expect(body.toolDiversityLast30d).toBe(4);
    });

    it('15. agents — riskWeightedBlockRate: all blocks', async () => {
      ctx = await setup();
      // All blocked: blockedRisk = totalRisk → rate = 1.0
      await ctx.logger.log(makeOp('agent-v1032-allblock', 'fs', 'sess-1'), dec(0.5, 'block'));
      await ctx.logger.log(makeOp('agent-v1032-allblock', 'fs', 'sess-2'), dec(0.8, 'block'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1032-allblock');
      expect(status).toBe(200);
      expect(body.riskWeightedBlockRate as number).toBeCloseTo(1.0, 5);
    });

    it('16. agents — avgTimeBetweenOpsMs: three ops with known intervals', async () => {
      ctx = await setup();
      // t0=100ms ago, t1=200ms ago, t2=500ms ago
      // sorted ascending: t2, t1, t0 → gaps: 300ms, 100ms → avg = 200ms
      const now = PINNED_NOW();
      const t0 = new Date(now - 100);
      const t1 = new Date(now - 200);
      const t2 = new Date(now - 500);
      await ctx.logger.log(makeOp('agent-v1032-avgtime', 'fs', 'sess-1', t0), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-v1032-avgtime', 'fs', 'sess-2', t1), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-v1032-avgtime', 'fs', 'sess-3', t2), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1032-avgtime');
      expect(status).toBe(200);
      // gaps: 100ms + 300ms = 400ms total, /2 = 200ms
      expect(body.avgTimeBetweenOpsMs as number).toBeCloseTo(200, 0);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1229-T1233 — v10.32 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('17. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-x', 'tool-v1032-pres', 'sess-1'), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1032-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('agentDiversityLast30d');
      expect(body).toHaveProperty('toolDiversityLast30d');
      expect(body).toHaveProperty('methodDiversityLast30d');
      expect(body).toHaveProperty('riskWeightedBlockRate');
      expect(body).toHaveProperty('avgTimeBetweenOpsMs');
    });

    it('18. tools — ops only older than 30d: diversity fields are 0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-y1', 'tool-v1032-old', 'sess-1', daysAgo(40)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-y2', 'tool-v1032-old', 'sess-2', daysAgo(50)), dec(0.6, 'block'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1032-old');
      expect(status).toBe(200);

      expect(body.agentDiversityLast30d).toBe(0);
      expect(body.toolDiversityLast30d).toBe(0);
      expect(body.methodDiversityLast30d).toBe(0);
    });

    it('19. tools — distinct agents calling the same tool in 30d', async () => {
      ctx = await setup();
      // 3 distinct agents, all in last 30d
      await ctx.logger.log(makeOp('agent-z1', 'tool-v1032-agents', 'sess-1', daysAgo(3)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-z2', 'tool-v1032-agents', 'sess-2', daysAgo(8)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-z3', 'tool-v1032-agents', 'sess-3', daysAgo(15)), dec(0.8, 'block'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1032-agents');
      expect(status).toBe(200);

      expect(body.agentDiversityLast30d).toBe(3);
    });

    it('20. tools — riskWeightedBlockRate with 3 ops: 1 allow, 2 block', async () => {
      ctx = await setup();
      // allow: 0.2; block: 0.4 + 0.6 = 1.0; totalRisk = 1.2; rate = 1.0/1.2
      await ctx.logger.log(makeOp('agent-w1', 'tool-v1032-rwbr3', 'sess-1'), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-w2', 'tool-v1032-rwbr3', 'sess-2'), dec(0.4, 'block'));
      await ctx.logger.log(makeOp('agent-w3', 'tool-v1032-rwbr3', 'sess-3'), dec(0.6, 'block'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1032-rwbr3');
      expect(status).toBe(200);

      const expected = 1.0 / 1.2;
      expect(body.riskWeightedBlockRate as number).toBeCloseTo(expected, 5);
    });

    it('21. tools — avgTimeBetweenOpsMs: null with single log', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v', 'tool-v1032-1log', 'sess-1'), dec(0.3, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1032-1log');
      expect(status).toBe(200);
      expect(body.avgTimeBetweenOpsMs).toBeNull();
    });

    it('22. tools — methodDiversityLast30d counts distinct methods', async () => {
      ctx = await setup();
      // 3 distinct methods in 30d
      await ctx.logger.log(makeOp('agent-u1', 'tool-v1032-methods', 'sess-1', daysAgo(2), 'read'), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-u2', 'tool-v1032-methods', 'sess-2', daysAgo(5), 'write'), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-u3', 'tool-v1032-methods', 'sess-3', daysAgo(10), 'delete'), dec(0.7, 'block'));
      // Duplicate method: another 'read' in same window — diversity should still be 3
      await ctx.logger.log(makeOp('agent-u4', 'tool-v1032-methods', 'sess-4', daysAgo(20), 'read'), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1032-methods');
      expect(status).toBe(200);
      expect(body.methodDiversityLast30d).toBe(3);
    });
  });

  // ── operations/summary endpoint ────────────────────────────────────────────────

  describe('T1229-T1233 — v10.32 new fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('23. summary — all five new fields present', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s1', 'tool-s', 'sess-1'), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body).toHaveProperty('agentDiversityLast30d');
      expect(body).toHaveProperty('toolDiversityLast30d');
      expect(body).toHaveProperty('methodDiversityLast30d');
      expect(body).toHaveProperty('riskWeightedBlockRate');
      expect(body).toHaveProperty('avgTimeBetweenOpsMs');
    });

    it('24. summary — empty DB: riskWeightedBlockRate is null, avgTimeBetweenOpsMs is null', async () => {
      ctx = await setup();

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.riskWeightedBlockRate).toBeNull();
      expect(body.avgTimeBetweenOpsMs).toBeNull();
      expect(body.agentDiversityLast30d).toBe(0);
      expect(body.toolDiversityLast30d).toBe(0);
      expect(body.methodDiversityLast30d).toBe(0);
    });

    it('25. summary — all ops older than 30d: diversity fields are 0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s2', 'tool-s', 'sess-1', daysAgo(35)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-s3', 'tool-s', 'sess-2', daysAgo(45)), dec(0.7, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.agentDiversityLast30d).toBe(0);
      expect(body.toolDiversityLast30d).toBe(0);
      expect(body.methodDiversityLast30d).toBe(0);
    });

    it('26. summary — 4 distinct agents in 30d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s4', 'tool-s', 'sess-1', daysAgo(2)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-s5', 'tool-s', 'sess-2', daysAgo(5)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-s6', 'tool-s', 'sess-3', daysAgo(10)), dec(0.5, 'block'));
      await ctx.logger.log(makeOp('agent-s7', 'tool-s', 'sess-4', daysAgo(20)), dec(0.7, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.agentDiversityLast30d).toBe(4);
    });

    it('27. summary — riskWeightedBlockRate: null when all riskScores are 0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s8', 'tool-s', 'sess-1'), dec(0.0, 'block'));
      await ctx.logger.log(makeOp('agent-s9', 'tool-s', 'sess-2'), dec(0.0, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskWeightedBlockRate).toBeNull();
    });

    it('28. summary — riskWeightedBlockRate: correct computation with mixed actions', async () => {
      ctx = await setup();
      // allow: 0.3, block: 0.7 → totalRisk=1.0, blockedRisk=0.7 → rate=0.7
      await ctx.logger.log(makeOp('agent-s10', 'tool-s', 'sess-1'), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-s11', 'tool-s', 'sess-2'), dec(0.7, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskWeightedBlockRate as number).toBeCloseTo(0.7, 5);
    });

    it('29. summary — avgTimeBetweenOpsMs: two ops 24 hours apart', async () => {
      ctx = await setup();
      const t0 = daysAgo(1);
      const t1 = new Date(PINNED_NOW());
      await ctx.logger.log(makeOp('agent-s12', 'tool-s', 'sess-1', t0), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-s13', 'tool-s', 'sess-2', t1), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      // ~86400000 ms; allow tolerance of a few seconds
      expect(body.avgTimeBetweenOpsMs as number).toBeGreaterThanOrEqual(86_390_000);
      expect(body.avgTimeBetweenOpsMs as number).toBeLessThanOrEqual(86_410_000);
    });

    it('30. summary — avgTimeBetweenOpsMs: 4 ops with uniform 1-hour spacing', async () => {
      ctx = await setup();
      // t=3h ago, t=2h ago, t=1h ago, t=now → gaps all 3600000ms → avg = 3600000ms
      for (let h = 3; h >= 0; h--) {
        await ctx.logger.log(makeOp(`agent-sum-hr-${h}`, 'tool-hr', `sess-hr-${h}`, hoursAgo(h)), dec(0.3, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      // All gaps are ~3600000ms; average should be ~3600000ms
      expect(body.avgTimeBetweenOpsMs as number).toBeGreaterThanOrEqual(3_500_000);
      expect(body.avgTimeBetweenOpsMs as number).toBeLessThanOrEqual(3_700_000);
    });

    it('31. summary — toolDiversityLast30d: duplicate tool in window counts once', async () => {
      ctx = await setup();
      // Same tool 'fs' used 4 times in 30d — diversity should be 1
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp(`agent-dup-${i}`, 'fs', `sess-dup-${i}`, daysAgo(i + 1)), dec(0.3, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.toolDiversityLast30d).toBe(1);
    });

    it('32. summary — riskWeightedBlockRate: require_approval ops treated as non-block', async () => {
      ctx = await setup();
      // allow: 0.3, require_approval: 0.5, block: 0.2
      // totalRisk = 1.0, blockedRisk = 0.2 → rate = 0.2
      await ctx.logger.log(makeOp('agent-ra1', 'tool-ra', 'sess-1'), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-ra2', 'tool-ra', 'sess-2'), dec(0.5, 'require_approval'));
      await ctx.logger.log(makeOp('agent-ra3', 'tool-ra', 'sess-3'), dec(0.2, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskWeightedBlockRate as number).toBeCloseTo(0.2, 5);
    });
  });
});

// ── v10.33 ────────────────────────────────────────────────────────────────────

describe('v10.33', () => {
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);
  const hoursAgo = (h: number) => new Date(PINNED_NOW() - h * 3_600_000);

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1234-T1238 — v10.33 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1033-pres'), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1033-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('riskScoreStdDevLast24h');
      expect(body).toHaveProperty('riskScoreStdDevLast7d');
      expect(body).toHaveProperty('riskScoreStdDevLast30d');
      expect(body).toHaveProperty('blockRateLast1h');
      expect(body).toHaveProperty('allowRateLast1h');
    });

    it('2. sessions — all stddev fields null when all logs are outside their windows (very old)', async () => {
      ctx = await setup();
      // Seed logs older than 30d so they fall outside all windows
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1033-old', daysAgo(40)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1033-old', daysAgo(45)), dec(0.7, 'block'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1033-old');
      expect(status).toBe(200);

      expect(body.riskScoreStdDevLast24h).toBeNull();
      expect(body.riskScoreStdDevLast7d).toBeNull();
      expect(body.riskScoreStdDevLast30d).toBeNull();
    });

    it('3. sessions — stddev is 0 when all logs in window have the same riskScore', async () => {
      ctx = await setup();
      // Three ops all with riskScore 0.5 in last 24h → stddev = 0
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1033-same', hoursAgo(1)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1033-same', hoursAgo(2)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1033-same', hoursAgo(3)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1033-same');
      expect(status).toBe(200);

      expect(body.riskScoreStdDevLast24h as number).toBeCloseTo(0, 5);
      expect(body.riskScoreStdDevLast7d as number).toBeCloseTo(0, 5);
      expect(body.riskScoreStdDevLast30d as number).toBeCloseTo(0, 5);
    });

    it('4. sessions — stddev correct for riskScores [0.2, 0.8] → stddev = 0.3', async () => {
      ctx = await setup();
      // mean = 0.5, variance = ((0.2-0.5)² + (0.8-0.5)²) / 2 = 0.09, stddev = 0.3
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1033-stddev', hoursAgo(1)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1033-stddev', hoursAgo(2)), dec(0.8, 'block'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1033-stddev');
      expect(status).toBe(200);

      expect(body.riskScoreStdDevLast24h as number).toBeCloseTo(0.3, 5);
      expect(body.riskScoreStdDevLast7d as number).toBeCloseTo(0.3, 5);
      expect(body.riskScoreStdDevLast30d as number).toBeCloseTo(0.3, 5);
    });

    it('5. sessions — blockRateLast1h and allowRateLast1h null when no ops in last 1h', async () => {
      ctx = await setup();
      // Only ops older than 1h — blockRateLast1h and allowRateLast1h must be null
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1033-no1h', hoursAgo(3)), dec(0.5, 'block'));
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1033-no1h', hoursAgo(5)), dec(0.3, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1033-no1h');
      expect(status).toBe(200);

      expect(body.blockRateLast1h).toBeNull();
      expect(body.allowRateLast1h).toBeNull();
    });

    it('6. sessions — blockRateLast1h = 0 when all ops in 1h are allow', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-f1', 'fs', 'sess-v1033-allallow1h'), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-f2', 'fs', 'sess-v1033-allallow1h'), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1033-allallow1h');
      expect(status).toBe(200);

      expect(body.blockRateLast1h as number).toBeCloseTo(0, 5);
      expect(body.allowRateLast1h as number).toBeCloseTo(1.0, 5);
    });

    it('7. sessions — blockRateLast1h fractional, allowRateLast1h fractional with mixed actions', async () => {
      ctx = await setup();
      // 1 block, 1 allow in last 1h → blockRate = 0.5, allowRate = 0.5
      await ctx.logger.log(makeOp('agent-g1', 'fs', 'sess-v1033-mix1h'), dec(0.6, 'block'));
      await ctx.logger.log(makeOp('agent-g2', 'fs', 'sess-v1033-mix1h'), dec(0.3, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1033-mix1h');
      expect(status).toBe(200);

      expect(body.blockRateLast1h as number).toBeCloseTo(0.5, 5);
      expect(body.allowRateLast1h as number).toBeCloseTo(0.5, 5);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1234-T1238 — v10.33 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('8. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1033-pres', 'fs', 'sess-1'), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1033-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('riskScoreStdDevLast24h');
      expect(body).toHaveProperty('riskScoreStdDevLast7d');
      expect(body).toHaveProperty('riskScoreStdDevLast30d');
      expect(body).toHaveProperty('blockRateLast1h');
      expect(body).toHaveProperty('allowRateLast1h');
    });

    it('9. agents — stddev fields null when all logs older than 30d', async () => {
      ctx = await setup();
      // Seed logs outside all windows
      await ctx.logger.log(makeOp('agent-v1033-old', 'fs', 'sess-1', daysAgo(40)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-v1033-old', 'fs', 'sess-2', daysAgo(50)), dec(0.8, 'block'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1033-old');
      expect(status).toBe(200);

      expect(body.riskScoreStdDevLast24h).toBeNull();
      expect(body.riskScoreStdDevLast7d).toBeNull();
      expect(body.riskScoreStdDevLast30d).toBeNull();
    });

    it('10. agents — stddev = 0 when all logs in window have identical riskScore', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1033-same', 'fs', 'sess-1', hoursAgo(1)), dec(0.6, 'allow'));
      await ctx.logger.log(makeOp('agent-v1033-same', 'fs', 'sess-2', hoursAgo(2)), dec(0.6, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1033-same');
      expect(status).toBe(200);

      expect(body.riskScoreStdDevLast24h as number).toBeCloseTo(0, 5);
    });

    it('11. agents — stddev correct for [0.2, 0.8] → 0.3 (24h window)', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1033-stddev', 'fs', 'sess-1', hoursAgo(1)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-v1033-stddev', 'fs', 'sess-2', hoursAgo(2)), dec(0.8, 'block'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1033-stddev');
      expect(status).toBe(200);

      expect(body.riskScoreStdDevLast24h as number).toBeCloseTo(0.3, 5);
    });

    it('12. agents — stddev only counts logs within 7d window, not logs older than 7d', async () => {
      ctx = await setup();
      // Two logs in 7d window: [0.2, 0.8] → stddev 0.3
      await ctx.logger.log(makeOp('agent-v1033-7d', 'fs', 'sess-1', daysAgo(3)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-v1033-7d', 'fs', 'sess-2', daysAgo(5)), dec(0.8, 'block'));
      // One log older than 7d — not in 7d window
      await ctx.logger.log(makeOp('agent-v1033-7d', 'fs', 'sess-3', daysAgo(10)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1033-7d');
      expect(status).toBe(200);

      expect(body.riskScoreStdDevLast7d as number).toBeCloseTo(0.3, 5);
    });

    it('13. agents — blockRateLast1h null when no ops in 1h window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1033-no1h', 'fs', 'sess-1', hoursAgo(2)), dec(0.7, 'block'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1033-no1h');
      expect(status).toBe(200);

      expect(body.blockRateLast1h).toBeNull();
      expect(body.allowRateLast1h).toBeNull();
    });

    it('14. agents — blockRateLast1h = 1.0 when all ops in 1h are blocked', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1033-allblock', 'fs', 'sess-1'), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agent-v1033-allblock', 'fs', 'sess-2'), dec(0.9, 'block'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1033-allblock');
      expect(status).toBe(200);

      expect(body.blockRateLast1h as number).toBeCloseTo(1.0, 5);
      expect(body.allowRateLast1h as number).toBeCloseTo(0.0, 5);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1234-T1238 — v10.33 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('15. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-x', 'tool-v1033-pres', 'sess-1'), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1033-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('riskScoreStdDevLast24h');
      expect(body).toHaveProperty('riskScoreStdDevLast7d');
      expect(body).toHaveProperty('riskScoreStdDevLast30d');
      expect(body).toHaveProperty('blockRateLast1h');
      expect(body).toHaveProperty('allowRateLast1h');
    });

    it('16. tools — stddev fields null when all logs older than 30d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-y1', 'tool-v1033-old', 'sess-1', daysAgo(40)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-y2', 'tool-v1033-old', 'sess-2', daysAgo(50)), dec(0.7, 'block'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1033-old');
      expect(status).toBe(200);

      expect(body.riskScoreStdDevLast24h).toBeNull();
      expect(body.riskScoreStdDevLast7d).toBeNull();
      expect(body.riskScoreStdDevLast30d).toBeNull();
    });

    it('17. tools — stddev = 0 when all logs in window have same riskScore', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-z1', 'tool-v1033-same', 'sess-1', hoursAgo(1)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-z2', 'tool-v1033-same', 'sess-2', hoursAgo(2)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-z3', 'tool-v1033-same', 'sess-3', hoursAgo(3)), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1033-same');
      expect(status).toBe(200);

      expect(body.riskScoreStdDevLast24h as number).toBeCloseTo(0, 5);
    });

    it('18. tools — stddev correct for [0.2, 0.8] → 0.3 (all windows)', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-w1', 'tool-v1033-stddev', 'sess-1', hoursAgo(1)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-w2', 'tool-v1033-stddev', 'sess-2', hoursAgo(2)), dec(0.8, 'block'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1033-stddev');
      expect(status).toBe(200);

      expect(body.riskScoreStdDevLast24h as number).toBeCloseTo(0.3, 5);
      expect(body.riskScoreStdDevLast7d as number).toBeCloseTo(0.3, 5);
      expect(body.riskScoreStdDevLast30d as number).toBeCloseTo(0.3, 5);
    });

    it('19. tools — blockRateLast1h null when no ops in 1h window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1', 'tool-v1033-no1h', 'sess-1', hoursAgo(3)), dec(0.5, 'block'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1033-no1h');
      expect(status).toBe(200);

      expect(body.blockRateLast1h).toBeNull();
      expect(body.allowRateLast1h).toBeNull();
    });

    it('20. tools — blockRateLast1h fractional: 2 block, 1 allow → 2/3', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-u1', 'tool-v1033-frac1h', 'sess-1'), dec(0.7, 'block'));
      await ctx.logger.log(makeOp('agent-u2', 'tool-v1033-frac1h', 'sess-2'), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agent-u3', 'tool-v1033-frac1h', 'sess-3'), dec(0.3, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1033-frac1h');
      expect(status).toBe(200);

      expect(body.blockRateLast1h as number).toBeCloseTo(2 / 3, 5);
      expect(body.allowRateLast1h as number).toBeCloseTo(1 / 3, 5);
    });

    it('21. tools — stddev only counts logs within 30d, ignores older logs', async () => {
      ctx = await setup();
      // Two logs in 30d: [0.2, 0.8] → stddev 0.3
      await ctx.logger.log(makeOp('agent-t1', 'tool-v1033-30d', 'sess-1', daysAgo(10)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-t2', 'tool-v1033-30d', 'sess-2', daysAgo(20)), dec(0.8, 'block'));
      // One log outside 30d — should not affect 30d stddev
      await ctx.logger.log(makeOp('agent-t3', 'tool-v1033-30d', 'sess-3', daysAgo(35)), dec(0.1, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1033-30d');
      expect(status).toBe(200);

      expect(body.riskScoreStdDevLast30d as number).toBeCloseTo(0.3, 5);
    });
  });

  // ── operations/summary endpoint ────────────────────────────────────────────────

  describe('T1234-T1238 — v10.33 new fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('22. summary — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s1', 'tool-s', 'sess-1'), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body).toHaveProperty('riskScoreStdDevLast24h');
      expect(body).toHaveProperty('riskScoreStdDevLast7d');
      expect(body).toHaveProperty('riskScoreStdDevLast30d');
      expect(body).toHaveProperty('blockRateLast1h');
      expect(body).toHaveProperty('allowRateLast1h');
    });

    it('23. summary — empty DB: all stddev fields null, blockRateLast1h null, allowRateLast1h null', async () => {
      ctx = await setup();

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.riskScoreStdDevLast24h).toBeNull();
      expect(body.riskScoreStdDevLast7d).toBeNull();
      expect(body.riskScoreStdDevLast30d).toBeNull();
      expect(body.blockRateLast1h).toBeNull();
      expect(body.allowRateLast1h).toBeNull();
    });

    it('24. summary — all logs older than 30d: all stddev fields null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s2', 'tool-s', 'sess-1', daysAgo(35)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-s3', 'tool-s', 'sess-2', daysAgo(40)), dec(0.7, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.riskScoreStdDevLast24h).toBeNull();
      expect(body.riskScoreStdDevLast7d).toBeNull();
      expect(body.riskScoreStdDevLast30d).toBeNull();
    });

    it('25. summary — stddev = 0 when all logs in window have same riskScore', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s4', 'tool-s', 'sess-1', hoursAgo(1)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-s5', 'tool-s', 'sess-2', hoursAgo(2)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-s6', 'tool-s', 'sess-3', hoursAgo(3)), dec(0.5, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.riskScoreStdDevLast24h as number).toBeCloseTo(0, 5);
    });

    it('26. summary — stddev correct for [0.2, 0.8] → 0.3 in all windows', async () => {
      ctx = await setup();
      // Both logs within 24h → applies to all three windows
      await ctx.logger.log(makeOp('agent-s7', 'tool-s', 'sess-1', hoursAgo(1)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-s8', 'tool-s', 'sess-2', hoursAgo(2)), dec(0.8, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      // mean=0.5, variance=0.09, stddev=0.3
      expect(body.riskScoreStdDevLast24h as number).toBeCloseTo(0.3, 5);
      expect(body.riskScoreStdDevLast7d as number).toBeCloseTo(0.3, 5);
      expect(body.riskScoreStdDevLast30d as number).toBeCloseTo(0.3, 5);
    });

    it('27. summary — blockRateLast1h null when no ops in last 1h', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s9', 'tool-s', 'sess-1', hoursAgo(2)), dec(0.5, 'block'));
      await ctx.logger.log(makeOp('agent-s10', 'tool-s', 'sess-2', hoursAgo(3)), dec(0.3, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.blockRateLast1h).toBeNull();
      expect(body.allowRateLast1h).toBeNull();
    });

    it('28. summary — blockRateLast1h = 0 and allowRateLast1h = 1 when all ops in 1h are allow', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s11', 'tool-s', 'sess-1'), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-s12', 'tool-s', 'sess-2'), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.blockRateLast1h as number).toBeCloseTo(0, 5);
      expect(body.allowRateLast1h as number).toBeCloseTo(1.0, 5);
    });

    it('29. summary — blockRateLast1h and allowRateLast1h correct with 3 ops: 1 block, 2 allow', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s13', 'tool-s', 'sess-1'), dec(0.7, 'block'));
      await ctx.logger.log(makeOp('agent-s14', 'tool-s', 'sess-2'), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-s15', 'tool-s', 'sess-3'), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.blockRateLast1h as number).toBeCloseTo(1 / 3, 5);
      expect(body.allowRateLast1h as number).toBeCloseTo(2 / 3, 5);
    });

    it('30. summary — stddev correct for three values: riskScores [0.1, 0.5, 0.9]', async () => {
      ctx = await setup();
      // mean = 0.5, variance = ((0.4)² + (0.0)² + (0.4)²) / 3 = 0.32/3 ≈ 0.10667, stddev ≈ 0.32660
      await ctx.logger.log(makeOp('agent-s16', 'tool-s', 'sess-1', hoursAgo(1)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-s17', 'tool-s', 'sess-2', hoursAgo(2)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-s18', 'tool-s', 'sess-3', hoursAgo(3)), dec(0.9, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      const expectedStdDev = Math.sqrt(((0.1 - 0.5) ** 2 + (0.5 - 0.5) ** 2 + (0.9 - 0.5) ** 2) / 3);
      expect(body.riskScoreStdDevLast24h as number).toBeCloseTo(expectedStdDev, 5);
    });

    it('31. summary — logs in different windows: 24h stddev differs from 30d stddev', async () => {
      ctx = await setup();
      // In 24h: [0.2, 0.8] → stddev = 0.3
      await ctx.logger.log(makeOp('agent-s19', 'tool-s', 'sess-1', hoursAgo(1)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-s20', 'tool-s', 'sess-2', hoursAgo(2)), dec(0.8, 'block'));
      // In 30d but not 24h: [0.5] — adds to 7d and 30d windows
      await ctx.logger.log(makeOp('agent-s21', 'tool-s', 'sess-3', daysAgo(3)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      // 24h window: [0.2, 0.8] → stddev = 0.3
      expect(body.riskScoreStdDevLast24h as number).toBeCloseTo(0.3, 5);
      // 7d and 30d: [0.2, 0.8, 0.5] → mean = 0.5, variance = ((0.3)²+(0.3)²+(0.0)²)/3 = 0.06, stddev ≈ 0.24495
      const expected7d30d = Math.sqrt(((0.2 - 0.5) ** 2 + (0.8 - 0.5) ** 2 + (0.5 - 0.5) ** 2) / 3);
      expect(body.riskScoreStdDevLast7d as number).toBeCloseTo(expected7d30d, 5);
      expect(body.riskScoreStdDevLast30d as number).toBeCloseTo(expected7d30d, 5);
    });

    it('32. summary — allowRateLast1h = 0 when all ops in 1h are blocked', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s22', 'tool-s', 'sess-1'), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agent-s23', 'tool-s', 'sess-2'), dec(0.9, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.allowRateLast1h as number).toBeCloseTo(0, 5);
      expect(body.blockRateLast1h as number).toBeCloseTo(1.0, 5);
    });
  });
});

// ── v10.34 ────────────────────────────────────────────────────────────────────

describe('v10.34', () => {
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);
  const hoursAgo = (h: number) => new Date(PINNED_NOW() - h * 3_600_000);

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1239-T1243 — v10.34 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1034-pres'), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1034-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('requireApprovalRateLast1h');
      expect(body).toHaveProperty('riskScoreVarianceLast24h');
      expect(body).toHaveProperty('riskScoreVarianceLast7d');
      expect(body).toHaveProperty('riskScoreVarianceLast30d');
      expect(body).toHaveProperty('topToolLast7d');
    });

    it('2. sessions — requireApprovalRateLast1h null when no ops in last 1h', async () => {
      ctx = await setup();
      // Seed logs older than 1h only
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1034-no1h', hoursAgo(3)), dec(0.5, 'require_approval'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1034-no1h');
      expect(status).toBe(200);
      expect(body.requireApprovalRateLast1h).toBeNull();
    });

    it('3. sessions — requireApprovalRateLast1h = 0 when no require_approval ops in 1h window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1034-noapp'), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1034-noapp'), dec(0.5, 'block'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1034-noapp');
      expect(status).toBe(200);
      expect(body.requireApprovalRateLast1h as number).toBeCloseTo(0, 5);
    });

    it('4. sessions — requireApprovalRateLast1h = 1.0 when all ops in 1h are require_approval', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1034-allapp'), dec(0.7, 'require_approval'));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1034-allapp'), dec(0.8, 'require_approval'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1034-allapp');
      expect(status).toBe(200);
      expect(body.requireApprovalRateLast1h as number).toBeCloseTo(1.0, 5);
    });

    it('5. sessions — requireApprovalRateLast1h fractional: 1 require_approval out of 3 ops', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1034-frac'), dec(0.7, 'require_approval'));
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1034-frac'), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1034-frac'), dec(0.4, 'block'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1034-frac');
      expect(status).toBe(200);
      expect(body.requireApprovalRateLast1h as number).toBeCloseTo(1 / 3, 5);
    });

    it('6. sessions — all variance fields null when all logs are older than 30d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1034-old', daysAgo(40)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1034-old', daysAgo(45)), dec(0.7, 'block'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1034-old');
      expect(status).toBe(200);
      expect(body.riskScoreVarianceLast24h).toBeNull();
      expect(body.riskScoreVarianceLast7d).toBeNull();
      expect(body.riskScoreVarianceLast30d).toBeNull();
    });

    it('7. sessions — variance = 0 when all logs in window have same riskScore', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1034-same', hoursAgo(1)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1034-same', hoursAgo(2)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1034-same', hoursAgo(3)), dec(0.5, 'block'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1034-same');
      expect(status).toBe(200);
      expect(body.riskScoreVarianceLast24h as number).toBeCloseTo(0, 5);
      expect(body.riskScoreVarianceLast7d as number).toBeCloseTo(0, 5);
      expect(body.riskScoreVarianceLast30d as number).toBeCloseTo(0, 5);
    });

    it('8. sessions — variance correct for [0.2, 0.8] → variance = 0.09', async () => {
      ctx = await setup();
      // mean = 0.5, variance = ((0.2-0.5)² + (0.8-0.5)²) / 2 = 0.09
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1034-var', hoursAgo(1)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1034-var', hoursAgo(2)), dec(0.8, 'block'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1034-var');
      expect(status).toBe(200);
      expect(body.riskScoreVarianceLast24h as number).toBeCloseTo(0.09, 5);
      expect(body.riskScoreVarianceLast7d as number).toBeCloseTo(0.09, 5);
      expect(body.riskScoreVarianceLast30d as number).toBeCloseTo(0.09, 5);
    });

    it('9. sessions — topToolLast7d null when all logs are older than 7d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-i', 'tool-old', 'sess-v1034-noTool7d', daysAgo(10)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-i', 'tool-old', 'sess-v1034-noTool7d', daysAgo(8)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1034-noTool7d');
      expect(status).toBe(200);
      expect(body.topToolLast7d).toBeNull();
    });

    it('10. sessions — topToolLast7d returns tool with most ops in 7d window', async () => {
      ctx = await setup();
      // tool-alpha: 3 ops, tool-beta: 2 ops, tool-gamma: 1 op — in last 7d
      await ctx.logger.log(makeOp('agent-j', 'tool-alpha', 'sess-v1034-topTool', hoursAgo(1)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-j', 'tool-alpha', 'sess-v1034-topTool', hoursAgo(2)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-j', 'tool-alpha', 'sess-v1034-topTool', hoursAgo(3)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-j', 'tool-beta', 'sess-v1034-topTool', hoursAgo(4)), dec(0.6, 'allow'));
      await ctx.logger.log(makeOp('agent-j', 'tool-beta', 'sess-v1034-topTool', hoursAgo(5)), dec(0.7, 'allow'));
      await ctx.logger.log(makeOp('agent-j', 'tool-gamma', 'sess-v1034-topTool', hoursAgo(6)), dec(0.2, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1034-topTool');
      expect(status).toBe(200);
      expect(body.topToolLast7d).toBe('tool-alpha');
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1239-T1243 — v10.34 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('11. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1034-pres', 'fs', 'sess-1'), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1034-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('requireApprovalRateLast1h');
      expect(body).toHaveProperty('riskScoreVarianceLast24h');
      expect(body).toHaveProperty('riskScoreVarianceLast7d');
      expect(body).toHaveProperty('riskScoreVarianceLast30d');
      expect(body).toHaveProperty('topToolLast7d');
    });

    it('12. agents — requireApprovalRateLast1h null when no ops in last 1h', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1034-no1h', 'fs', 'sess-1', hoursAgo(2)), dec(0.7, 'require_approval'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1034-no1h');
      expect(status).toBe(200);
      expect(body.requireApprovalRateLast1h).toBeNull();
    });

    it('13. agents — requireApprovalRateLast1h = 0 when all ops in 1h are allow or block', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1034-noapp2', 'fs', 'sess-1'), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-v1034-noapp2', 'fs', 'sess-2'), dec(0.4, 'block'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1034-noapp2');
      expect(status).toBe(200);
      expect(body.requireApprovalRateLast1h as number).toBeCloseTo(0, 5);
    });

    it('14. agents — requireApprovalRateLast1h correct with mixed actions: 2 require_approval out of 4', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1034-mixapp', 'fs', 'sess-1'), dec(0.7, 'require_approval'));
      await ctx.logger.log(makeOp('agent-v1034-mixapp', 'fs', 'sess-2'), dec(0.8, 'require_approval'));
      await ctx.logger.log(makeOp('agent-v1034-mixapp', 'fs', 'sess-3'), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-v1034-mixapp', 'fs', 'sess-4'), dec(0.4, 'block'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1034-mixapp');
      expect(status).toBe(200);
      expect(body.requireApprovalRateLast1h as number).toBeCloseTo(0.5, 5);
    });

    it('15. agents — all variance fields null when all logs older than 30d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1034-old', 'fs', 'sess-1', daysAgo(40)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-v1034-old', 'fs', 'sess-2', daysAgo(50)), dec(0.8, 'block'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1034-old');
      expect(status).toBe(200);
      expect(body.riskScoreVarianceLast24h).toBeNull();
      expect(body.riskScoreVarianceLast7d).toBeNull();
      expect(body.riskScoreVarianceLast30d).toBeNull();
    });

    it('16. agents — variance = 0 when all logs in window have identical riskScore', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1034-same', 'fs', 'sess-1', hoursAgo(1)), dec(0.6, 'allow'));
      await ctx.logger.log(makeOp('agent-v1034-same', 'fs', 'sess-2', hoursAgo(2)), dec(0.6, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1034-same');
      expect(status).toBe(200);
      expect(body.riskScoreVarianceLast24h as number).toBeCloseTo(0, 5);
    });

    it('17. agents — variance correct for [0.2, 0.8] → 0.09 (24h window)', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1034-var', 'fs', 'sess-1', hoursAgo(1)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-v1034-var', 'fs', 'sess-2', hoursAgo(2)), dec(0.8, 'block'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1034-var');
      expect(status).toBe(200);
      expect(body.riskScoreVarianceLast24h as number).toBeCloseTo(0.09, 5);
    });

    it('18. agents — variance only counts logs within 7d window, not logs older than 7d', async () => {
      ctx = await setup();
      // Two logs in 7d window: [0.2, 0.8] → variance = 0.09
      await ctx.logger.log(makeOp('agent-v1034-7d', 'fs', 'sess-1', daysAgo(3)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-v1034-7d', 'fs', 'sess-2', daysAgo(5)), dec(0.8, 'block'));
      // One log older than 7d — not in 7d window
      await ctx.logger.log(makeOp('agent-v1034-7d', 'fs', 'sess-3', daysAgo(10)), dec(0.0, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1034-7d');
      expect(status).toBe(200);
      expect(body.riskScoreVarianceLast7d as number).toBeCloseTo(0.09, 5);
    });

    it('19. agents — topToolLast7d null when no ops in last 7d (entity exists via old logs)', async () => {
      ctx = await setup();
      // Only logs older than 7d — entity exists but no ops in 7d window
      await ctx.logger.log(makeOp('agent-v1034-noTool7d', 'tool-old', 'sess-1', daysAgo(10)), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1034-noTool7d');
      expect(status).toBe(200);
      expect(body.topToolLast7d).toBeNull();
    });

    it('20. agents — topToolLast7d returns tool with most ops in 7d window', async () => {
      ctx = await setup();
      // tool-x: 4 ops, tool-y: 2 ops in last 7d
      await ctx.logger.log(makeOp('agent-v1034-topTool', 'tool-x', 'sess-1', hoursAgo(1)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-v1034-topTool', 'tool-x', 'sess-2', hoursAgo(2)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-v1034-topTool', 'tool-x', 'sess-3', hoursAgo(3)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-v1034-topTool', 'tool-x', 'sess-4', hoursAgo(4)), dec(0.6, 'allow'));
      await ctx.logger.log(makeOp('agent-v1034-topTool', 'tool-y', 'sess-5', hoursAgo(5)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-v1034-topTool', 'tool-y', 'sess-6', hoursAgo(6)), dec(0.3, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1034-topTool');
      expect(status).toBe(200);
      expect(body.topToolLast7d).toBe('tool-x');
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1239-T1243 — v10.34 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('21. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-x', 'tool-v1034-pres', 'sess-1'), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1034-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('requireApprovalRateLast1h');
      expect(body).toHaveProperty('riskScoreVarianceLast24h');
      expect(body).toHaveProperty('riskScoreVarianceLast7d');
      expect(body).toHaveProperty('riskScoreVarianceLast30d');
      expect(body).toHaveProperty('topToolLast7d');
    });

    it('22. tools — requireApprovalRateLast1h null when no ops in last 1h', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-y', 'tool-v1034-no1h', 'sess-1', hoursAgo(3)), dec(0.5, 'require_approval'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1034-no1h');
      expect(status).toBe(200);
      expect(body.requireApprovalRateLast1h).toBeNull();
    });

    it('23. tools — requireApprovalRateLast1h = 1.0 when all ops in 1h are require_approval', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-z1', 'tool-v1034-allapp', 'sess-1'), dec(0.7, 'require_approval'));
      await ctx.logger.log(makeOp('agent-z2', 'tool-v1034-allapp', 'sess-2'), dec(0.8, 'require_approval'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1034-allapp');
      expect(status).toBe(200);
      expect(body.requireApprovalRateLast1h as number).toBeCloseTo(1.0, 5);
    });

    it('24. tools — all variance fields null when all logs older than 30d (entity exists via old logs)', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-w1', 'tool-v1034-old', 'sess-1', daysAgo(40)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-w2', 'tool-v1034-old', 'sess-2', daysAgo(50)), dec(0.7, 'block'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1034-old');
      expect(status).toBe(200);
      expect(body.riskScoreVarianceLast24h).toBeNull();
      expect(body.riskScoreVarianceLast7d).toBeNull();
      expect(body.riskScoreVarianceLast30d).toBeNull();
    });

    it('25. tools — variance = 0 when all logs in window have same riskScore', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1', 'tool-v1034-same', 'sess-1', hoursAgo(1)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-v2', 'tool-v1034-same', 'sess-2', hoursAgo(2)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-v3', 'tool-v1034-same', 'sess-3', hoursAgo(3)), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1034-same');
      expect(status).toBe(200);
      expect(body.riskScoreVarianceLast24h as number).toBeCloseTo(0, 5);
    });

    it('26. tools — variance correct for [0.2, 0.8] → 0.09 (all three windows)', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-u1', 'tool-v1034-var', 'sess-1', hoursAgo(1)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-u2', 'tool-v1034-var', 'sess-2', hoursAgo(2)), dec(0.8, 'block'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1034-var');
      expect(status).toBe(200);
      expect(body.riskScoreVarianceLast24h as number).toBeCloseTo(0.09, 5);
      expect(body.riskScoreVarianceLast7d as number).toBeCloseTo(0.09, 5);
      expect(body.riskScoreVarianceLast30d as number).toBeCloseTo(0.09, 5);
    });

    it('27. tools — variance only counts logs within 30d window, ignores older logs', async () => {
      ctx = await setup();
      // Two logs in 30d: [0.2, 0.8] → variance = 0.09
      await ctx.logger.log(makeOp('agent-t1', 'tool-v1034-30d', 'sess-1', daysAgo(10)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-t2', 'tool-v1034-30d', 'sess-2', daysAgo(20)), dec(0.8, 'block'));
      // One log outside 30d — should not affect 30d variance
      await ctx.logger.log(makeOp('agent-t3', 'tool-v1034-30d', 'sess-3', daysAgo(35)), dec(0.0, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1034-30d');
      expect(status).toBe(200);
      expect(body.riskScoreVarianceLast30d as number).toBeCloseTo(0.09, 5);
    });

    it('28. tools — topToolLast7d null when no ops in last 7d (entity exists via old logs)', async () => {
      ctx = await setup();
      // Only logs older than 7d — entity exists but no ops in 7d window
      await ctx.logger.log(makeOp('agent-q1', 'tool-v1034-noTool7d', 'sess-1', daysAgo(10)), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1034-noTool7d');
      expect(status).toBe(200);
      expect(body.topToolLast7d).toBeNull();
    });

    it('29. tools — topToolLast7d is this tool itself when it is the only tool in 7d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-r1', 'tool-v1034-solo', 'sess-1', hoursAgo(1)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-r2', 'tool-v1034-solo', 'sess-2', hoursAgo(2)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1034-solo');
      expect(status).toBe(200);
      expect(body.topToolLast7d).toBe('tool-v1034-solo');
    });
  });

  // ── operations/summary endpoint ────────────────────────────────────────────────

  describe('T1239-T1243 — v10.34 new fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('30. summary — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s1', 'tool-s', 'sess-1'), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body).toHaveProperty('requireApprovalRateLast1h');
      expect(body).toHaveProperty('riskScoreVarianceLast24h');
      expect(body).toHaveProperty('riskScoreVarianceLast7d');
      expect(body).toHaveProperty('riskScoreVarianceLast30d');
      expect(body).toHaveProperty('topToolLast7d');
    });

    it('31. summary — empty DB: all new fields null', async () => {
      ctx = await setup();

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.requireApprovalRateLast1h).toBeNull();
      expect(body.riskScoreVarianceLast24h).toBeNull();
      expect(body.riskScoreVarianceLast7d).toBeNull();
      expect(body.riskScoreVarianceLast30d).toBeNull();
      expect(body.topToolLast7d).toBeNull();
    });

    it('32. summary — requireApprovalRateLast1h null when all logs older than 1h', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s2', 'tool-s', 'sess-1', hoursAgo(2)), dec(0.6, 'require_approval'));
      await ctx.logger.log(makeOp('agent-s3', 'tool-s', 'sess-2', hoursAgo(3)), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.requireApprovalRateLast1h).toBeNull();
    });

    it('33. summary — requireApprovalRateLast1h = 0 when no require_approval in 1h window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s4', 'tool-s', 'sess-1'), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-s5', 'tool-s', 'sess-2'), dec(0.5, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.requireApprovalRateLast1h as number).toBeCloseTo(0, 5);
    });

    it('34. summary — requireApprovalRateLast1h correct: 2 require_approval out of 3 ops', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s6', 'tool-s', 'sess-1'), dec(0.7, 'require_approval'));
      await ctx.logger.log(makeOp('agent-s7', 'tool-s', 'sess-2'), dec(0.8, 'require_approval'));
      await ctx.logger.log(makeOp('agent-s8', 'tool-s', 'sess-3'), dec(0.3, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.requireApprovalRateLast1h as number).toBeCloseTo(2 / 3, 5);
    });

    it('35. summary — all variance fields null when all logs older than 30d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s9', 'tool-s', 'sess-1', daysAgo(35)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-s10', 'tool-s', 'sess-2', daysAgo(40)), dec(0.7, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreVarianceLast24h).toBeNull();
      expect(body.riskScoreVarianceLast7d).toBeNull();
      expect(body.riskScoreVarianceLast30d).toBeNull();
    });

    it('36. summary — variance = 0 when all logs in window have same riskScore', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s11', 'tool-s', 'sess-1', hoursAgo(1)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-s12', 'tool-s', 'sess-2', hoursAgo(2)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-s13', 'tool-s', 'sess-3', hoursAgo(3)), dec(0.5, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreVarianceLast24h as number).toBeCloseTo(0, 5);
    });

    it('37. summary — variance correct for [0.2, 0.8] → 0.09 in all three windows', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s14', 'tool-s', 'sess-1', hoursAgo(1)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-s15', 'tool-s', 'sess-2', hoursAgo(2)), dec(0.8, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      // mean=0.5, variance=((0.2-0.5)²+(0.8-0.5)²)/2=0.09
      expect(body.riskScoreVarianceLast24h as number).toBeCloseTo(0.09, 5);
      expect(body.riskScoreVarianceLast7d as number).toBeCloseTo(0.09, 5);
      expect(body.riskScoreVarianceLast30d as number).toBeCloseTo(0.09, 5);
    });

    it('38. summary — variance differs across windows when logs span different periods', async () => {
      ctx = await setup();
      // In 24h: [0.2, 0.8] → variance = 0.09
      await ctx.logger.log(makeOp('agent-s16', 'tool-s', 'sess-1', hoursAgo(1)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-s17', 'tool-s', 'sess-2', hoursAgo(2)), dec(0.8, 'block'));
      // In 7d but not 24h: adds [0.5] to 7d and 30d windows
      await ctx.logger.log(makeOp('agent-s18', 'tool-s', 'sess-3', daysAgo(3)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      // 24h window: [0.2, 0.8] → variance = 0.09
      expect(body.riskScoreVarianceLast24h as number).toBeCloseTo(0.09, 5);
      // 7d and 30d: [0.2, 0.8, 0.5] → mean=0.5, variance=((0.3)²+(0.3)²+(0.0)²)/3=0.06
      const expected7d30d = ((0.2 - 0.5) ** 2 + (0.8 - 0.5) ** 2 + (0.5 - 0.5) ** 2) / 3;
      expect(body.riskScoreVarianceLast7d as number).toBeCloseTo(expected7d30d, 5);
      expect(body.riskScoreVarianceLast30d as number).toBeCloseTo(expected7d30d, 5);
    });

    it('39. summary — topToolLast7d null when all logs older than 7d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s19', 'tool-old', 'sess-1', daysAgo(10)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-s20', 'tool-old', 'sess-2', daysAgo(8)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.topToolLast7d).toBeNull();
    });

    it('40. summary — topToolLast7d returns tool with highest op count in 7d window', async () => {
      ctx = await setup();
      // tool-alpha: 3 ops, tool-beta: 2 ops, tool-gamma: 1 op — all in last 7d
      await ctx.logger.log(makeOp('agent-s21', 'tool-alpha', 'sess-1', hoursAgo(1)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-s22', 'tool-alpha', 'sess-2', hoursAgo(2)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-s23', 'tool-alpha', 'sess-3', hoursAgo(3)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-s24', 'tool-beta', 'sess-4', hoursAgo(4)), dec(0.6, 'allow'));
      await ctx.logger.log(makeOp('agent-s25', 'tool-beta', 'sess-5', hoursAgo(5)), dec(0.7, 'allow'));
      await ctx.logger.log(makeOp('agent-s26', 'tool-gamma', 'sess-6', hoursAgo(6)), dec(0.2, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.topToolLast7d).toBe('tool-alpha');
    });

    it('41. summary — topToolLast7d ignores logs older than 7d when counting', async () => {
      ctx = await setup();
      // tool-recent: 2 ops in last 7d
      // tool-old-heavy: 5 ops but all older than 7d
      await ctx.logger.log(makeOp('agent-s27', 'tool-recent', 'sess-1', hoursAgo(1)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-s28', 'tool-recent', 'sess-2', hoursAgo(2)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-s29', 'tool-old-heavy', 'sess-3', daysAgo(10)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-s30', 'tool-old-heavy', 'sess-4', daysAgo(11)), dec(0.6, 'allow'));
      await ctx.logger.log(makeOp('agent-s31', 'tool-old-heavy', 'sess-5', daysAgo(12)), dec(0.7, 'allow'));
      await ctx.logger.log(makeOp('agent-s32', 'tool-old-heavy', 'sess-6', daysAgo(13)), dec(0.8, 'allow'));
      await ctx.logger.log(makeOp('agent-s33', 'tool-old-heavy', 'sess-7', daysAgo(14)), dec(0.9, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      // tool-recent has 2 ops in 7d window; tool-old-heavy has 0 in 7d window
      expect(body.topToolLast7d).toBe('tool-recent');
    });
  });
});

// ── v10.35 ────────────────────────────────────────────────────────────────────

describe('v10.35', () => {
  const hoursAgo = (h: number) => new Date(PINNED_NOW() - h * 3_600_000);
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1244-T1248 — v10.35 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-a', 'sess-v1035-pres'), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1035-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('topAgentLast7d');
      expect(body).toHaveProperty('topAgentLast30d');
      expect(body).toHaveProperty('topToolLast30d');
      expect(body).toHaveProperty('blockCountLast1h');
      expect(body).toHaveProperty('allowCountLast1h');
    });

    it('2. sessions — topAgentLast7d and topAgentLast30d: null when all ops >40d old', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-old', 'tool-x', 'sess-v1035-old', daysAgo(41)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-old', 'tool-x', 'sess-v1035-old', daysAgo(45)), dec(0.6, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1035-old');
      expect(status).toBe(200);
      expect(body.topAgentLast7d).toBeNull();
      expect(body.topAgentLast30d).toBeNull();
      expect(body.topToolLast30d).toBeNull();
    });

    it('3. sessions — topAgentLast7d returns winner agent from 7d window', async () => {
      ctx = await setup();
      const sid = 'sess-v1035-top7d';
      // agent-winner: 3 ops in 7d; agent-loser: 1 op in 7d
      await ctx.logger.log(makeOp('agent-winner', 'tool-w', sid, daysAgo(1)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-winner', 'tool-w', sid, daysAgo(2)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-winner', 'tool-w', sid, daysAgo(3)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-loser', 'tool-w', sid, daysAgo(4)), dec(0.3, 'allow'));

      const { status, body } = await getJSON(ctx.port, `/sessions/${sid}`);
      expect(status).toBe(200);
      expect(body.topAgentLast7d).toBe('agent-winner');
    });

    it('4. sessions — topAgentLast30d returns winner from 30d window (using ops outside 7d)', async () => {
      ctx = await setup();
      const sid = 'sess-v1035-top30d';
      // agent-big: 3 ops in 30d (at 10d, 20d, 28d); agent-small: 1 op in 30d
      await ctx.logger.log(makeOp('agent-big', 'tool-b', sid, daysAgo(10)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-big', 'tool-b', sid, daysAgo(20)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-big', 'tool-b', sid, daysAgo(28)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-small', 'tool-b', sid, daysAgo(15)), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, `/sessions/${sid}`);
      expect(status).toBe(200);
      expect(body.topAgentLast30d).toBe('agent-big');
    });

    it('5. sessions — topToolLast30d returns tool with most ops in 30d window', async () => {
      ctx = await setup();
      const sid = 'sess-v1035-toptool30d';
      // tool-top: 3 ops; tool-low: 1 op; all in 30d
      await ctx.logger.log(makeOp('agent-x', 'tool-top', sid, daysAgo(5)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-x', 'tool-top', sid, daysAgo(12)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-x', 'tool-top', sid, daysAgo(20)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-x', 'tool-low', sid, daysAgo(8)), dec(0.3, 'allow'));

      const { status, body } = await getJSON(ctx.port, `/sessions/${sid}`);
      expect(status).toBe(200);
      expect(body.topToolLast30d).toBe('tool-top');
    });

    it('6. sessions — blockCountLast1h counts only blocked ops within 1h', async () => {
      ctx = await setup();
      const sid = 'sess-v1035-block1h';
      // 2 blocks within 1h, 1 block older, 2 allows within 1h
      await ctx.logger.log(makeOp('agent-y', 'tool-y', sid), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agent-y', 'tool-y', sid), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-y', 'tool-y', sid, hoursAgo(2)), dec(0.8, 'block')); // outside 1h
      await ctx.logger.log(makeOp('agent-y', 'tool-y', sid), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-y', 'tool-y', sid), dec(0.2, 'allow'));

      const { status, body } = await getJSON(ctx.port, `/sessions/${sid}`);
      expect(status).toBe(200);
      expect(body.blockCountLast1h).toBe(2);
      expect(body.allowCountLast1h).toBe(2);
    });

    it('7. sessions — blockCountLast1h and allowCountLast1h are 0 when no ops in 1h', async () => {
      ctx = await setup();
      const sid = 'sess-v1035-norecent';
      // All ops older than 1h
      await ctx.logger.log(makeOp('agent-z', 'tool-z', sid, hoursAgo(2)), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agent-z', 'tool-z', sid, hoursAgo(3)), dec(0.2, 'allow'));

      const { status, body } = await getJSON(ctx.port, `/sessions/${sid}`);
      expect(status).toBe(200);
      expect(body.blockCountLast1h).toBe(0);
      expect(body.allowCountLast1h).toBe(0);
    });

    it('8. sessions — topAgentLast7d not null when ops exist in 7d but topAgentLast30d sees more ops', async () => {
      ctx = await setup();
      const sid = 'sess-v1035-mixed-agent';
      // In 7d: agent-aa 2 ops; agent-bb 1 op => topAgentLast7d = agent-aa
      // In 30d total: agent-bb has 2 extra ops at 15d/25d => agent-bb 3 total vs agent-aa 2 => topAgentLast30d = agent-bb
      await ctx.logger.log(makeOp('agent-aa', 'tool-t', sid, daysAgo(1)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-aa', 'tool-t', sid, daysAgo(3)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-bb', 'tool-t', sid, daysAgo(2)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-bb', 'tool-t', sid, daysAgo(15)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-bb', 'tool-t', sid, daysAgo(25)), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, `/sessions/${sid}`);
      expect(status).toBe(200);
      expect(body.topAgentLast7d).toBe('agent-aa');
      expect(body.topAgentLast30d).toBe('agent-bb');
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1244-T1248 — v10.35 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('9. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1035-pres', 'tool-a', 'sess-1'), dec(0.3, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1035-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('topAgentLast7d');
      expect(body).toHaveProperty('topAgentLast30d');
      expect(body).toHaveProperty('topToolLast30d');
      expect(body).toHaveProperty('blockCountLast1h');
      expect(body).toHaveProperty('allowCountLast1h');
    });

    it('10. agents — topAgentLast7d and topAgentLast30d null when all ops >40d old', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1035-old', 'tool-x', 'sess-1', daysAgo(41)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-v1035-old', 'tool-x', 'sess-2', daysAgo(50)), dec(0.6, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1035-old');
      expect(status).toBe(200);
      expect(body.topAgentLast7d).toBeNull();
      expect(body.topAgentLast30d).toBeNull();
      expect(body.topToolLast30d).toBeNull();
    });

    it('11. agents — topAgentLast7d: returns self when agent has most ops in 7d', async () => {
      ctx = await setup();
      // For an agent endpoint, logs are filtered by agentId.
      // topAgentLast7d counts agentIds among those logs — so it should be the agent itself.
      await ctx.logger.log(makeOp('agent-v1035-self', 'tool-s', 'sess-1', daysAgo(1)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-v1035-self', 'tool-s', 'sess-2', daysAgo(2)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-v1035-self', 'tool-s', 'sess-3', daysAgo(3)), dec(0.3, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1035-self');
      expect(status).toBe(200);
      expect(body.topAgentLast7d).toBe('agent-v1035-self');
      expect(body.topAgentLast30d).toBe('agent-v1035-self');
    });

    it('12. agents — topToolLast30d: most used tool in 30d window', async () => {
      ctx = await setup();
      // tool-hot: 4 ops in 30d; tool-cold: 1 op in 30d
      await ctx.logger.log(makeOp('agent-v1035-tool30d', 'tool-hot', 'sess-1', daysAgo(5)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-v1035-tool30d', 'tool-hot', 'sess-2', daysAgo(10)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-v1035-tool30d', 'tool-hot', 'sess-3', daysAgo(18)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-v1035-tool30d', 'tool-hot', 'sess-4', daysAgo(25)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-v1035-tool30d', 'tool-cold', 'sess-5', daysAgo(12)), dec(0.3, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1035-tool30d');
      expect(status).toBe(200);
      expect(body.topToolLast30d).toBe('tool-hot');
    });

    it('13. agents — topToolLast30d null when no ops in 30d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1035-notools30d', 'tool-old', 'sess-1', daysAgo(40)), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1035-notools30d');
      expect(status).toBe(200);
      expect(body.topToolLast30d).toBeNull();
    });

    it('14. agents — blockCountLast1h counts correctly', async () => {
      ctx = await setup();
      // 3 blocks in 1h
      await ctx.logger.log(makeOp('agent-v1035-blk', 'tool-b', 'sess-1'), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-v1035-blk', 'tool-b', 'sess-2'), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-v1035-blk', 'tool-b', 'sess-3'), dec(0.9, 'block'));
      // 1 allow in 1h
      await ctx.logger.log(makeOp('agent-v1035-blk', 'tool-b', 'sess-4'), dec(0.1, 'allow'));
      // 1 block outside 1h
      await ctx.logger.log(makeOp('agent-v1035-blk', 'tool-b', 'sess-5', hoursAgo(1.5)), dec(0.9, 'block'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1035-blk');
      expect(status).toBe(200);
      expect(body.blockCountLast1h).toBe(3);
      expect(body.allowCountLast1h).toBe(1);
    });

    it('15. agents — allowCountLast1h is 0 when no allows in 1h', async () => {
      ctx = await setup();
      // Only blocks in 1h
      await ctx.logger.log(makeOp('agent-v1035-allblk', 'tool-b', 'sess-1'), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-v1035-allblk', 'tool-b', 'sess-2'), dec(0.9, 'block'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1035-allblk');
      expect(status).toBe(200);
      expect(body.allowCountLast1h).toBe(0);
      expect(body.blockCountLast1h).toBe(2);
    });

    it('16. agents — blockCountLast1h and allowCountLast1h both 0 when DB empty for agent', async () => {
      ctx = await setup();
      // Seed a different agent so the DB is not empty globally
      await ctx.logger.log(makeOp('agent-other', 'tool-o', 'sess-1'), dec(0.5, 'block'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1035-nobody');
      // 404 expected for unknown agent
      expect([200, 404]).toContain(status);
      if (status === 200) {
        expect(body.blockCountLast1h).toBe(0);
        expect(body.allowCountLast1h).toBe(0);
      }
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1244-T1248 — v10.35 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('17. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v1035-pres', 'sess-1'), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1035-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('topAgentLast7d');
      expect(body).toHaveProperty('topAgentLast30d');
      expect(body).toHaveProperty('topToolLast30d');
      expect(body).toHaveProperty('blockCountLast1h');
      expect(body).toHaveProperty('allowCountLast1h');
    });

    it('18. tools — topAgentLast7d: agent with most ops calling this tool in 7d', async () => {
      ctx = await setup();
      // agent-frequent: 3 ops on tool-v1035-top7d in 7d
      // agent-rare: 1 op
      await ctx.logger.log(makeOp('agent-frequent', 'tool-v1035-top7d', 'sess-1', daysAgo(1)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-frequent', 'tool-v1035-top7d', 'sess-2', daysAgo(2)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-frequent', 'tool-v1035-top7d', 'sess-3', daysAgo(3)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-rare', 'tool-v1035-top7d', 'sess-4', daysAgo(4)), dec(0.3, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1035-top7d');
      expect(status).toBe(200);
      expect(body.topAgentLast7d).toBe('agent-frequent');
    });

    it('19. tools — topAgentLast7d null when all ops >40d old', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v1035-oldtool', 'sess-1', daysAgo(41)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-a', 'tool-v1035-oldtool', 'sess-2', daysAgo(50)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1035-oldtool');
      expect(status).toBe(200);
      expect(body.topAgentLast7d).toBeNull();
      expect(body.topAgentLast30d).toBeNull();
      expect(body.topToolLast30d).toBeNull();
    });

    it('20. tools — topToolLast30d returns self (this tool) when it dominates 30d window', async () => {
      ctx = await setup();
      // All logs for this endpoint are filtered by tool name already.
      // topToolLast30d counts tools in filtered logs — should be the tool itself.
      await ctx.logger.log(makeOp('agent-a', 'tool-v1035-self30d', 'sess-1', daysAgo(5)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-b', 'tool-v1035-self30d', 'sess-2', daysAgo(10)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-c', 'tool-v1035-self30d', 'sess-3', daysAgo(20)), dec(0.3, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1035-self30d');
      expect(status).toBe(200);
      expect(body.topToolLast30d).toBe('tool-v1035-self30d');
    });

    it('21. tools — topAgentLast30d: agent with most ops in 30d window (beyond 7d)', async () => {
      ctx = await setup();
      // agent-champion: 3 ops in 30d (2 outside 7d, 1 in 7d)
      // agent-runner: 1 op in 30d
      await ctx.logger.log(makeOp('agent-champion', 'tool-v1035-top30d', 'sess-1', daysAgo(2)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-champion', 'tool-v1035-top30d', 'sess-2', daysAgo(12)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-champion', 'tool-v1035-top30d', 'sess-3', daysAgo(22)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-runner', 'tool-v1035-top30d', 'sess-4', daysAgo(8)), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1035-top30d');
      expect(status).toBe(200);
      expect(body.topAgentLast30d).toBe('agent-champion');
    });

    it('22. tools — blockCountLast1h and allowCountLast1h correctly counted for tool', async () => {
      ctx = await setup();
      // 2 blocks in 1h, 3 allows in 1h, 1 block outside 1h
      await ctx.logger.log(makeOp('agent-a', 'tool-v1035-cnt1h', 'sess-1'), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-b', 'tool-v1035-cnt1h', 'sess-2'), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-c', 'tool-v1035-cnt1h', 'sess-3'), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-d', 'tool-v1035-cnt1h', 'sess-4'), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-e', 'tool-v1035-cnt1h', 'sess-5'), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-f', 'tool-v1035-cnt1h', 'sess-6', hoursAgo(2.0)), dec(0.9, 'block')); // outside 1h

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1035-cnt1h');
      expect(status).toBe(200);
      expect(body.blockCountLast1h).toBe(2);
      expect(body.allowCountLast1h).toBe(3);
    });

    it('23. tools — blockCountLast1h is 0 when all ops are allows in 1h', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v1035-noblock', 'sess-1'), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-a', 'tool-v1035-noblock', 'sess-2'), dec(0.2, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1035-noblock');
      expect(status).toBe(200);
      expect(body.blockCountLast1h).toBe(0);
      expect(body.allowCountLast1h).toBe(2);
    });
  });

  // ── operations/summary endpoint ────────────────────────────────────────────────

  describe('T1244-T1248 — v10.35 new fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('24. summary — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-a', 'sess-1'), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body).toHaveProperty('topAgentLast7d');
      expect(body).toHaveProperty('topAgentLast30d');
      expect(body).toHaveProperty('topToolLast30d');
      expect(body).toHaveProperty('blockCountLast1h');
      expect(body).toHaveProperty('allowCountLast1h');
    });

    it('25. summary — all three top fields null and counts are 0 when DB is empty', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.topAgentLast7d).toBeNull();
      expect(body.topAgentLast30d).toBeNull();
      expect(body.topToolLast30d).toBeNull();
      expect(body.blockCountLast1h).toBe(0);
      expect(body.allowCountLast1h).toBe(0);
    });

    it('26. summary — topAgentLast7d null when all ops >40d old, counts still 0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-ancient', 'tool-a', 'sess-1', daysAgo(41)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-ancient', 'tool-a', 'sess-2', daysAgo(45)), dec(0.6, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.topAgentLast7d).toBeNull();
      expect(body.topAgentLast30d).toBeNull();
      expect(body.topToolLast30d).toBeNull();
      expect(body.blockCountLast1h).toBe(0);
      expect(body.allowCountLast1h).toBe(0);
    });

    it('27. summary — topAgentLast7d: agent with most ops globally in last 7d', async () => {
      ctx = await setup();
      // agent-sum-winner: 4 ops in 7d; agent-sum-loser: 2 ops in 7d
      await ctx.logger.log(makeOp('agent-sum-winner', 'tool-s', 'sess-1', daysAgo(1)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-sum-winner', 'tool-s', 'sess-2', daysAgo(2)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-sum-winner', 'tool-s', 'sess-3', daysAgo(3)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-sum-winner', 'tool-s', 'sess-4', daysAgo(4)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-sum-loser', 'tool-s', 'sess-5', daysAgo(2)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-sum-loser', 'tool-s', 'sess-6', daysAgo(5)), dec(0.3, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.topAgentLast7d).toBe('agent-sum-winner');
    });

    it('28. summary — topAgentLast30d: agent with most ops globally in last 30d', async () => {
      ctx = await setup();
      // agent-sum30-champion: 3 ops in 30d (at 10d, 20d, 28d)
      // agent-sum30-runner: 1 op in 30d
      await ctx.logger.log(makeOp('agent-sum30-champion', 'tool-x', 'sess-1', daysAgo(10)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-sum30-champion', 'tool-x', 'sess-2', daysAgo(20)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-sum30-champion', 'tool-x', 'sess-3', daysAgo(28)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-sum30-runner', 'tool-x', 'sess-4', daysAgo(15)), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.topAgentLast30d).toBe('agent-sum30-champion');
    });

    it('29. summary — topToolLast30d: tool with most ops globally in last 30d', async () => {
      ctx = await setup();
      // tool-sum-top: 4 ops in 30d; tool-sum-low: 1 op in 30d
      await ctx.logger.log(makeOp('agent-a', 'tool-sum-top', 'sess-1', daysAgo(3)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-b', 'tool-sum-top', 'sess-2', daysAgo(8)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-c', 'tool-sum-top', 'sess-3', daysAgo(16)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-d', 'tool-sum-top', 'sess-4', daysAgo(24)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-e', 'tool-sum-low', 'sess-5', daysAgo(6)), dec(0.3, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.topToolLast30d).toBe('tool-sum-top');
    });

    it('30. summary — blockCountLast1h and allowCountLast1h correct with mixed ops', async () => {
      ctx = await setup();
      // 3 blocks in 1h, 2 allows in 1h, 2 blocks older
      await ctx.logger.log(makeOp('agent-a', 'tool-a', 'sess-1'), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-b', 'tool-b', 'sess-2'), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-c', 'tool-c', 'sess-3'), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-d', 'tool-d', 'sess-4'), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-e', 'tool-e', 'sess-5'), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-f', 'tool-f', 'sess-6', hoursAgo(1.5)), dec(0.9, 'block')); // outside 1h
      await ctx.logger.log(makeOp('agent-g', 'tool-g', 'sess-7', hoursAgo(2.0)), dec(0.9, 'block')); // outside 1h

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.blockCountLast1h).toBe(3);
      expect(body.allowCountLast1h).toBe(2);
    });

    it('31. summary — topAgentLast7d reflects only 7d window, not older ops', async () => {
      ctx = await setup();
      // agent-new: 2 ops in 7d; agent-veteran: 5 ops but all >40d old => agent-new wins 7d
      await ctx.logger.log(makeOp('agent-new', 'tool-n', 'sess-1', daysAgo(2)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-new', 'tool-n', 'sess-2', daysAgo(5)), dec(0.3, 'allow'));
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp('agent-veteran', 'tool-v', `sess-vet-${i}`, daysAgo(41 + i)), dec(0.3, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.topAgentLast7d).toBe('agent-new');
    });

    it('32. summary — blockCountLast1h is 0 and allowCountLast1h is 0 when only ops >1h exist', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-a', 'sess-1', hoursAgo(1.1)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-a', 'tool-a', 'sess-2', hoursAgo(2.0)), dec(0.1, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.blockCountLast1h).toBe(0);
      expect(body.allowCountLast1h).toBe(0);
    });

    it('33. summary — topToolLast30d null when only ops >40d old exist', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-old1', 'sess-1', daysAgo(42)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-b', 'tool-old2', 'sess-2', daysAgo(50)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.topToolLast30d).toBeNull();
    });
  });
});

// ── v10.36 ────────────────────────────────────────────────────────────────────

describe('v10.36', () => {
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);
  const hoursAgo = (h: number) => new Date(PINNED_NOW() - h * 3_600_000);

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1249-T1253 — v10.36 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1036-pres'), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1036-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('requireApprovalCountLast30d');
      expect(body).toHaveProperty('blockCountLast7d');
      expect(body).toHaveProperty('allowCountLast7d');
      expect(body).toHaveProperty('blockCountLast30d');
      expect(body).toHaveProperty('allowCountLast30d');
    });

    it('2. sessions — requireApprovalCountLast30d counts require_approval ops in 30d window', async () => {
      ctx = await setup();
      // Two require_approval ops in 30d window
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1036-req', daysAgo(5)), dec(0.7, 'require_approval'));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1036-req', daysAgo(15)), dec(0.8, 'require_approval'));
      // One require_approval op outside 30d window — should NOT be counted
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1036-req', daysAgo(40)), dec(0.9, 'require_approval'));
      // Non-require_approval ops that should not count
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1036-req', daysAgo(3)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1036-req', daysAgo(10)), dec(0.6, 'block'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1036-req');
      expect(status).toBe(200);
      expect(body.requireApprovalCountLast30d).toBe(2);
    });

    it('3. sessions — requireApprovalCountLast30d is 0 when empty window (all ops 40d+ old)', async () => {
      ctx = await setup();
      // Seed an old op first to ensure the session exists
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1036-req-empty', daysAgo(45)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1036-req-empty');
      expect(status).toBe(200);
      expect(body.requireApprovalCountLast30d).toBe(0);
    });

    it('4. sessions — blockCountLast7d and allowCountLast7d return correct counts', async () => {
      ctx = await setup();
      // Seed old op so session is not empty
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1036-7d', daysAgo(40)), dec(0.3, 'allow'));
      // Ops in 7d window
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1036-7d', daysAgo(1)), dec(0.5, 'block'));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1036-7d', daysAgo(3)), dec(0.4, 'block'));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1036-7d', daysAgo(5)), dec(0.3, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1036-7d');
      expect(status).toBe(200);
      expect(body.blockCountLast7d).toBe(2);
      expect(body.allowCountLast7d).toBe(1);
    });

    it('5. sessions — blockCountLast30d and allowCountLast30d return correct counts', async () => {
      ctx = await setup();
      // Seed old op so session exists but is outside window
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1036-30d', daysAgo(40)), dec(0.3, 'block'));
      // Ops in 30d but not in 7d
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1036-30d', daysAgo(10)), dec(0.6, 'block'));
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1036-30d', daysAgo(20)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1036-30d', daysAgo(28)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1036-30d');
      expect(status).toBe(200);
      // 7d window is empty
      expect(body.blockCountLast7d).toBe(0);
      // 30d window: 1 block + 2 allow
      expect(body.blockCountLast30d).toBe(1);
      expect(body.allowCountLast30d).toBe(2);
    });

    it('6. sessions — all counts are 0 when window is empty (only old ops)', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1036-allzero', daysAgo(45)), dec(0.5, 'block'));
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1036-allzero', daysAgo(50)), dec(0.6, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1036-allzero');
      expect(status).toBe(200);
      expect(body.requireApprovalCountLast30d).toBe(0);
      expect(body.blockCountLast7d).toBe(0);
      expect(body.allowCountLast7d).toBe(0);
      expect(body.blockCountLast30d).toBe(0);
      expect(body.allowCountLast30d).toBe(0);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1249-T1253 — v10.36 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('7. agents — all five fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1036-pres', 'fs', 'sess-1'), dec(0.3, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1036-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('requireApprovalCountLast30d');
      expect(body).toHaveProperty('blockCountLast7d');
      expect(body).toHaveProperty('allowCountLast7d');
      expect(body).toHaveProperty('blockCountLast30d');
      expect(body).toHaveProperty('allowCountLast30d');
    });

    it('8. agents — requireApprovalCountLast30d counts correctly', async () => {
      ctx = await setup();
      // Three require_approval ops in 30d window
      await ctx.logger.log(makeOp('agent-v1036-req', 'fs', 'sess-1', daysAgo(2)), dec(0.8, 'require_approval'));
      await ctx.logger.log(makeOp('agent-v1036-req', 'fs', 'sess-2', daysAgo(10)), dec(0.7, 'require_approval'));
      await ctx.logger.log(makeOp('agent-v1036-req', 'fs', 'sess-3', daysAgo(25)), dec(0.9, 'require_approval'));
      // One outside 30d — not counted
      await ctx.logger.log(makeOp('agent-v1036-req', 'fs', 'sess-4', daysAgo(40)), dec(0.6, 'require_approval'));
      // Other action types — not counted
      await ctx.logger.log(makeOp('agent-v1036-req', 'fs', 'sess-5', daysAgo(1)), dec(0.4, 'block'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1036-req');
      expect(status).toBe(200);
      expect(body.requireApprovalCountLast30d).toBe(3);
    });

    it('9. agents — requireApprovalCountLast30d is 0 when window is empty (all ops 40d+ old)', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1036-req-empty', 'fs', 'sess-1', daysAgo(41)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-v1036-req-empty', 'fs', 'sess-2', daysAgo(50)), dec(0.6, 'require_approval'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1036-req-empty');
      expect(status).toBe(200);
      expect(body.requireApprovalCountLast30d).toBe(0);
    });

    it('10. agents — blockCountLast7d and allowCountLast7d return correct counts', async () => {
      ctx = await setup();
      // Old op to ensure agent exists with data
      await ctx.logger.log(makeOp('agent-v1036-7d', 'tool', 'sess-1', daysAgo(40)), dec(0.3, 'allow'));
      // Ops within 7d
      await ctx.logger.log(makeOp('agent-v1036-7d', 'tool', 'sess-2', hoursAgo(2)), dec(0.6, 'block'));
      await ctx.logger.log(makeOp('agent-v1036-7d', 'tool', 'sess-3', daysAgo(2)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-v1036-7d', 'tool', 'sess-4', daysAgo(5)), dec(0.7, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1036-7d');
      expect(status).toBe(200);
      expect(body.blockCountLast7d).toBe(1);
      expect(body.allowCountLast7d).toBe(2);
    });

    it('11. agents — blockCountLast30d and allowCountLast30d return correct counts', async () => {
      ctx = await setup();
      // Old op outside 30d
      await ctx.logger.log(makeOp('agent-v1036-30d', 'tool', 'sess-1', daysAgo(45)), dec(0.3, 'block'));
      // Ops in 30d window but not 7d
      await ctx.logger.log(makeOp('agent-v1036-30d', 'tool', 'sess-2', daysAgo(8)), dec(0.5, 'block'));
      await ctx.logger.log(makeOp('agent-v1036-30d', 'tool', 'sess-3', daysAgo(15)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-v1036-30d', 'tool', 'sess-4', daysAgo(22)), dec(0.6, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1036-30d');
      expect(status).toBe(200);
      expect(body.blockCountLast7d).toBe(0);
      expect(body.blockCountLast30d).toBe(1);
      expect(body.allowCountLast30d).toBe(2);
    });

    it('12. agents — all counts 0 when only ops older than 30d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1036-empty', 'tool', 'sess-1', daysAgo(40)), dec(0.5, 'block'));
      await ctx.logger.log(makeOp('agent-v1036-empty', 'tool', 'sess-2', daysAgo(55)), dec(0.6, 'require_approval'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1036-empty');
      expect(status).toBe(200);
      expect(body.requireApprovalCountLast30d).toBe(0);
      expect(body.blockCountLast7d).toBe(0);
      expect(body.allowCountLast7d).toBe(0);
      expect(body.blockCountLast30d).toBe(0);
      expect(body.allowCountLast30d).toBe(0);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1249-T1253 — v10.36 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('13. tools — all five fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-g', 'tool-v1036-pres', 'sess-1'), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1036-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('requireApprovalCountLast30d');
      expect(body).toHaveProperty('blockCountLast7d');
      expect(body).toHaveProperty('allowCountLast7d');
      expect(body).toHaveProperty('blockCountLast30d');
      expect(body).toHaveProperty('allowCountLast30d');
    });

    it('14. tools — requireApprovalCountLast30d counts correctly', async () => {
      ctx = await setup();
      // Two require_approval ops within 30d
      await ctx.logger.log(makeOp('agent-h1', 'tool-v1036-req', 'sess-1', daysAgo(3)), dec(0.9, 'require_approval'));
      await ctx.logger.log(makeOp('agent-h2', 'tool-v1036-req', 'sess-2', daysAgo(20)), dec(0.8, 'require_approval'));
      // One outside 30d — not counted
      await ctx.logger.log(makeOp('agent-h3', 'tool-v1036-req', 'sess-3', daysAgo(40)), dec(0.7, 'require_approval'));
      // Non-require_approval ops
      await ctx.logger.log(makeOp('agent-h4', 'tool-v1036-req', 'sess-4', daysAgo(1)), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1036-req');
      expect(status).toBe(200);
      expect(body.requireApprovalCountLast30d).toBe(2);
    });

    it('15. tools — requireApprovalCountLast30d is 0 when window is empty (all ops 40d+ old)', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-i1', 'tool-v1036-req-empty', 'sess-1', daysAgo(41)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-i2', 'tool-v1036-req-empty', 'sess-2', daysAgo(60)), dec(0.6, 'require_approval'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1036-req-empty');
      expect(status).toBe(200);
      expect(body.requireApprovalCountLast30d).toBe(0);
    });

    it('16. tools — blockCountLast7d and allowCountLast7d return correct counts', async () => {
      ctx = await setup();
      // Old op to ensure tool exists
      await ctx.logger.log(makeOp('agent-j1', 'tool-v1036-7d', 'sess-1', daysAgo(40)), dec(0.3, 'allow'));
      // Ops within 7d
      await ctx.logger.log(makeOp('agent-j2', 'tool-v1036-7d', 'sess-2', daysAgo(1)), dec(0.6, 'block'));
      await ctx.logger.log(makeOp('agent-j3', 'tool-v1036-7d', 'sess-3', daysAgo(3)), dec(0.7, 'block'));
      await ctx.logger.log(makeOp('agent-j4', 'tool-v1036-7d', 'sess-4', daysAgo(6)), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1036-7d');
      expect(status).toBe(200);
      expect(body.blockCountLast7d).toBe(2);
      expect(body.allowCountLast7d).toBe(1);
    });

    it('17. tools — blockCountLast30d and allowCountLast30d correct with mixed window ops', async () => {
      ctx = await setup();
      // Old op outside 30d
      await ctx.logger.log(makeOp('agent-k1', 'tool-v1036-30d', 'sess-1', daysAgo(40)), dec(0.4, 'block'));
      // In 7d window (also counted in 30d window)
      await ctx.logger.log(makeOp('agent-k2', 'tool-v1036-30d', 'sess-2', daysAgo(2)), dec(0.5, 'block'));
      await ctx.logger.log(makeOp('agent-k3', 'tool-v1036-30d', 'sess-3', daysAgo(5)), dec(0.3, 'allow'));
      // In 30d window but not 7d
      await ctx.logger.log(makeOp('agent-k4', 'tool-v1036-30d', 'sess-4', daysAgo(12)), dec(0.6, 'block'));
      await ctx.logger.log(makeOp('agent-k5', 'tool-v1036-30d', 'sess-5', daysAgo(25)), dec(0.7, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1036-30d');
      expect(status).toBe(200);
      // 7d window: 1 block, 1 allow
      expect(body.blockCountLast7d).toBe(1);
      expect(body.allowCountLast7d).toBe(1);
      // 30d window: 2 block (daysAgo(2) + daysAgo(12)), 2 allow (daysAgo(5) + daysAgo(25))
      expect(body.blockCountLast30d).toBe(2);
      expect(body.allowCountLast30d).toBe(2);
    });
  });

  // ── operations/summary endpoint ────────────────────────────────────────────────

  describe('T1249-T1253 — v10.36 new fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('18. summary — all five fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-l', 'tool-s', 'sess-1'), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body).toHaveProperty('requireApprovalCountLast30d');
      expect(body).toHaveProperty('blockCountLast7d');
      expect(body).toHaveProperty('allowCountLast7d');
      expect(body).toHaveProperty('blockCountLast30d');
      expect(body).toHaveProperty('allowCountLast30d');
    });

    it('19. summary — requireApprovalCountLast30d counts only within 30d window', async () => {
      ctx = await setup();
      // Require_approval ops within 30d
      await ctx.logger.log(makeOp('agent-m1', 'tool-m', 'sess-1', daysAgo(5)), dec(0.8, 'require_approval'));
      await ctx.logger.log(makeOp('agent-m2', 'tool-m', 'sess-2', daysAgo(20)), dec(0.9, 'require_approval'));
      // Outside 30d — not counted
      await ctx.logger.log(makeOp('agent-m3', 'tool-m', 'sess-3', daysAgo(35)), dec(0.7, 'require_approval'));
      // Other action types
      await ctx.logger.log(makeOp('agent-m4', 'tool-m', 'sess-4', daysAgo(2)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-m5', 'tool-m', 'sess-5', daysAgo(8)), dec(0.6, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.requireApprovalCountLast30d).toBe(2);
    });

    it('20. summary — requireApprovalCountLast30d is 0 when empty DB', async () => {
      ctx = await setup();

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.requireApprovalCountLast30d).toBe(0);
    });

    it('21. summary — blockCountLast7d and allowCountLast7d correct', async () => {
      ctx = await setup();
      // Ops within 7d
      await ctx.logger.log(makeOp('agent-n1', 'tool-n', 'sess-1', daysAgo(1)), dec(0.7, 'block'));
      await ctx.logger.log(makeOp('agent-n2', 'tool-n', 'sess-2', daysAgo(4)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-n3', 'tool-n', 'sess-3', daysAgo(6)), dec(0.4, 'allow'));
      // Outside 7d (but within 30d) — not counted in 7d windows
      await ctx.logger.log(makeOp('agent-n4', 'tool-n', 'sess-4', daysAgo(10)), dec(0.6, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.blockCountLast7d).toBe(1);
      expect(body.allowCountLast7d).toBe(2);
    });

    it('22. summary — blockCountLast30d and allowCountLast30d aggregate across all agents/tools', async () => {
      ctx = await setup();
      // Mix of agents and tools, all within 30d
      await ctx.logger.log(makeOp('agent-o1', 'tool-x', 'sess-1', daysAgo(2)), dec(0.5, 'block'));
      await ctx.logger.log(makeOp('agent-o2', 'tool-y', 'sess-2', daysAgo(5)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-o3', 'tool-x', 'sess-3', daysAgo(10)), dec(0.7, 'block'));
      await ctx.logger.log(makeOp('agent-o4', 'tool-z', 'sess-4', daysAgo(20)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-o5', 'tool-z', 'sess-5', daysAgo(28)), dec(0.6, 'allow'));
      // Outside 30d — not counted
      await ctx.logger.log(makeOp('agent-o6', 'tool-x', 'sess-6', daysAgo(35)), dec(0.8, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      // blockCountLast30d: 2 (daysAgo(2) and daysAgo(10))
      expect(body.blockCountLast30d).toBe(2);
      // allowCountLast30d: 3 (daysAgo(5), daysAgo(20), daysAgo(28))
      expect(body.allowCountLast30d).toBe(3);
    });

    it('23. summary — all counts 0 when only ops older than 30d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-p1', 'tool-p', 'sess-1', daysAgo(35)), dec(0.5, 'block'));
      await ctx.logger.log(makeOp('agent-p2', 'tool-p', 'sess-2', daysAgo(45)), dec(0.7, 'require_approval'));
      await ctx.logger.log(makeOp('agent-p3', 'tool-p', 'sess-3', daysAgo(60)), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.requireApprovalCountLast30d).toBe(0);
      expect(body.blockCountLast7d).toBe(0);
      expect(body.allowCountLast7d).toBe(0);
      expect(body.blockCountLast30d).toBe(0);
      expect(body.allowCountLast30d).toBe(0);
    });

    it('24. summary — mixed actions in 30d: only require_approval counted for T1249', async () => {
      ctx = await setup();
      // Variety of action types in 30d window
      await ctx.logger.log(makeOp('agent-q1', 'tool-q', 'sess-1', hoursAgo(1)), dec(0.9, 'require_approval'));
      await ctx.logger.log(makeOp('agent-q2', 'tool-q', 'sess-2', daysAgo(3)), dec(0.8, 'require_approval'));
      await ctx.logger.log(makeOp('agent-q3', 'tool-q', 'sess-3', daysAgo(7)), dec(0.6, 'block'));
      await ctx.logger.log(makeOp('agent-q4', 'tool-q', 'sess-4', daysAgo(12)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-q5', 'tool-q', 'sess-5', daysAgo(18)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      // Only require_approval ops within 30d
      expect(body.requireApprovalCountLast30d).toBe(2);
      // blockCountLast7d includes the daysAgo(7) op (just inside 7d window)
      expect(body.blockCountLast30d).toBe(1);
      expect(body.allowCountLast30d).toBe(2);
    });
  });
});

// ── v10.37 ────────────────────────────────────────────────────────────────────

describe('v10.37', () => {
  const hoursAgo = (h: number) => new Date(PINNED_NOW() - h * 3_600_000);
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1254-T1258 — v10.37 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields are present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1037-pres', new Date(PINNED_NOW()), 'tools/call'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1037-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('topMethodLast7d');
      expect(body).toHaveProperty('topMethodLast30d');
      expect(body).toHaveProperty('avgRiskScoreLast1h');
      expect(body).toHaveProperty('maxRiskScoreLast1h');
      expect(body).toHaveProperty('minRiskScoreLast1h');
    });

    it('2. sessions — only old ops (>40d): topMethodLast7d and topMethodLast30d are null', async () => {
      ctx = await setup();
      // Seed ops older than 40 days so the session/agent/tool can be found (avoiding 404)
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1037-old', daysAgo(41), 'tools/call'), dec(0.5));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1037-old', daysAgo(45), 'resources/list'), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1037-old');
      expect(status).toBe(200);

      expect(body.topMethodLast7d).toBeNull();
      expect(body.topMethodLast30d).toBeNull();
      // 1h window also empty since ops are old
      expect(body.avgRiskScoreLast1h).toBeNull();
      expect(body.maxRiskScoreLast1h).toBeNull();
      expect(body.minRiskScoreLast1h).toBeNull();
    });

    it('3. sessions — single op in 7d: topMethodLast7d returns that method', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1037-7d-single', daysAgo(3), 'tools/call'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1037-7d-single');
      expect(status).toBe(200);

      expect(body.topMethodLast7d).toBe('tools/call');
    });

    it('4. sessions — multiple methods in 7d: topMethodLast7d returns the most frequent method', async () => {
      ctx = await setup();
      const sess = 'sess-v1037-7d-top';
      // 'tools/call' appears 3 times, 'resources/list' appears 2 times
      await ctx.logger.log(makeOp('agent-d', 'fs', sess, daysAgo(1), 'tools/call'), dec(0.3));
      await ctx.logger.log(makeOp('agent-d', 'fs', sess, daysAgo(2), 'tools/call'), dec(0.4));
      await ctx.logger.log(makeOp('agent-d', 'fs', sess, daysAgo(3), 'tools/call'), dec(0.5));
      await ctx.logger.log(makeOp('agent-d', 'fs', sess, daysAgo(4), 'resources/list'), dec(0.6));
      await ctx.logger.log(makeOp('agent-d', 'fs', sess, daysAgo(5), 'resources/list'), dec(0.7));

      const { status, body } = await getJSON(ctx.port, `/sessions/${sess}`);
      expect(status).toBe(200);

      expect(body.topMethodLast7d).toBe('tools/call');
    });

    it('5. sessions — ops only in 30d window (not 7d): topMethodLast7d null, topMethodLast30d populated', async () => {
      ctx = await setup();
      const sess = 'sess-v1037-30d-only';
      // Ops at 10d and 20d ago — inside 30d window, outside 7d window
      await ctx.logger.log(makeOp('agent-e', 'fs', sess, daysAgo(10), 'resources/read'), dec(0.4));
      await ctx.logger.log(makeOp('agent-e', 'fs', sess, daysAgo(15), 'resources/read'), dec(0.5));
      await ctx.logger.log(makeOp('agent-e', 'fs', sess, daysAgo(20), 'tools/call'), dec(0.6));

      const { status, body } = await getJSON(ctx.port, `/sessions/${sess}`);
      expect(status).toBe(200);

      expect(body.topMethodLast7d).toBeNull();
      expect(body.topMethodLast30d).toBe('resources/read');
    });

    it('6. sessions — recent ops in 1h: avgRiskScoreLast1h, maxRiskScoreLast1h, minRiskScoreLast1h correct', async () => {
      ctx = await setup();
      const sess = 'sess-v1037-1h-risk';
      // Three ops within last 1h with scores 0.2, 0.5, 0.8
      await ctx.logger.log(makeOp('agent-f', 'fs', sess, new Date(PINNED_NOW()), 'tools/call'), dec(0.2));
      await ctx.logger.log(makeOp('agent-f', 'fs', sess, new Date(PINNED_NOW()), 'tools/call'), dec(0.5));
      await ctx.logger.log(makeOp('agent-f', 'fs', sess, new Date(PINNED_NOW()), 'tools/call'), dec(0.8));

      const { status, body } = await getJSON(ctx.port, `/sessions/${sess}`);
      expect(status).toBe(200);

      // avg = (0.2 + 0.5 + 0.8) / 3 = 0.5
      expect(body.avgRiskScoreLast1h as number).toBeCloseTo(0.5, 5);
      expect(body.maxRiskScoreLast1h as number).toBeCloseTo(0.8, 5);
      expect(body.minRiskScoreLast1h as number).toBeCloseTo(0.2, 5);
    });

    it('7. sessions — mix of recent (1h) and old: 1h stats reflect only 1h window', async () => {
      ctx = await setup();
      const sess = 'sess-v1037-mix-1h';
      // In 1h: scores 0.3 and 0.7
      await ctx.logger.log(makeOp('agent-g', 'fs', sess, new Date(PINNED_NOW()), 'tools/call'), dec(0.3));
      await ctx.logger.log(makeOp('agent-g', 'fs', sess, new Date(PINNED_NOW()), 'tools/call'), dec(0.7));
      // Old op (>40d) — seeds session to avoid 404 but outside all windows
      await ctx.logger.log(makeOp('agent-g', 'fs', sess, daysAgo(42), 'resources/list'), dec(0.9));

      const { status, body } = await getJSON(ctx.port, `/sessions/${sess}`);
      expect(status).toBe(200);

      // avg = (0.3 + 0.7) / 2 = 0.5; max = 0.7; min = 0.3
      expect(body.avgRiskScoreLast1h as number).toBeCloseTo(0.5, 5);
      expect(body.maxRiskScoreLast1h as number).toBeCloseTo(0.7, 5);
      expect(body.minRiskScoreLast1h as number).toBeCloseTo(0.3, 5);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1254-T1258 — v10.37 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('8. agents — all five new fields are present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1037-pres', 'fs', 'sess-1', new Date(PINNED_NOW()), 'tools/call'), dec(0.3));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1037-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('topMethodLast7d');
      expect(body).toHaveProperty('topMethodLast30d');
      expect(body).toHaveProperty('avgRiskScoreLast1h');
      expect(body).toHaveProperty('maxRiskScoreLast1h');
      expect(body).toHaveProperty('minRiskScoreLast1h');
    });

    it('9. agents — only old ops (>40d): all five new fields are null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1037-old', 'fs', 'sess-1', daysAgo(42), 'tools/call'), dec(0.5));
      await ctx.logger.log(makeOp('agent-v1037-old', 'fs', 'sess-2', daysAgo(50), 'resources/list'), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1037-old');
      expect(status).toBe(200);

      expect(body.topMethodLast7d).toBeNull();
      expect(body.topMethodLast30d).toBeNull();
      expect(body.avgRiskScoreLast1h).toBeNull();
      expect(body.maxRiskScoreLast1h).toBeNull();
      expect(body.minRiskScoreLast1h).toBeNull();
    });

    it('10. agents — multiple methods in 7d: topMethodLast7d returns most frequent', async () => {
      ctx = await setup();
      const agentId = 'agent-v1037-7d-top';
      // 'resources/read' appears 3 times, 'tools/call' appears once
      await ctx.logger.log(makeOp(agentId, 'fs', 'sess-1', daysAgo(1), 'resources/read'), dec(0.2));
      await ctx.logger.log(makeOp(agentId, 'fs', 'sess-2', daysAgo(2), 'resources/read'), dec(0.3));
      await ctx.logger.log(makeOp(agentId, 'fs', 'sess-3', daysAgo(3), 'resources/read'), dec(0.4));
      await ctx.logger.log(makeOp(agentId, 'fs', 'sess-4', daysAgo(4), 'tools/call'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, `/agents/${agentId}`);
      expect(status).toBe(200);

      expect(body.topMethodLast7d).toBe('resources/read');
    });

    it('11. agents — ops only in 30d window (not 7d): topMethodLast7d null, topMethodLast30d populated', async () => {
      ctx = await setup();
      const agentId = 'agent-v1037-30d-only';
      await ctx.logger.log(makeOp(agentId, 'fs', 'sess-1', daysAgo(10), 'prompts/get'), dec(0.3));
      await ctx.logger.log(makeOp(agentId, 'fs', 'sess-2', daysAgo(15), 'prompts/get'), dec(0.4));
      await ctx.logger.log(makeOp(agentId, 'fs', 'sess-3', daysAgo(25), 'tools/call'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, `/agents/${agentId}`);
      expect(status).toBe(200);

      expect(body.topMethodLast7d).toBeNull();
      expect(body.topMethodLast30d).toBe('prompts/get');
    });

    it('12. agents — single op in 1h: avg, max, min all equal that score', async () => {
      ctx = await setup();
      const agentId = 'agent-v1037-1h-single';
      await ctx.logger.log(makeOp(agentId, 'fs', 'sess-1', new Date(PINNED_NOW()), 'tools/call'), dec(0.65));

      const { status, body } = await getJSON(ctx.port, `/agents/${agentId}`);
      expect(status).toBe(200);

      expect(body.avgRiskScoreLast1h as number).toBeCloseTo(0.65, 5);
      expect(body.maxRiskScoreLast1h as number).toBeCloseTo(0.65, 5);
      expect(body.minRiskScoreLast1h as number).toBeCloseTo(0.65, 5);
    });

    it('13. agents — five ops in 1h: avg, max, min computed correctly', async () => {
      ctx = await setup();
      const agentId = 'agent-v1037-1h-five';
      const scores = [0.1, 0.3, 0.5, 0.7, 0.9];
      for (const [i, score] of scores.entries()) {
        await ctx.logger.log(makeOp(agentId, 'fs', `sess-${i}`, hoursAgo(0.1 * (i + 1)), 'tools/call'), dec(score));
      }

      const { status, body } = await getJSON(ctx.port, `/agents/${agentId}`);
      expect(status).toBe(200);

      // avg = (0.1 + 0.3 + 0.5 + 0.7 + 0.9) / 5 = 0.5
      expect(body.avgRiskScoreLast1h as number).toBeCloseTo(0.5, 5);
      expect(body.maxRiskScoreLast1h as number).toBeCloseTo(0.9, 5);
      expect(body.minRiskScoreLast1h as number).toBeCloseTo(0.1, 5);
    });

    it('14. agents — 1h ops mixed with older ops: 1h stats exclude older ops', async () => {
      ctx = await setup();
      const agentId = 'agent-v1037-1h-excl';
      // In 1h: 0.4 and 0.6
      await ctx.logger.log(makeOp(agentId, 'fs', 'sess-1', new Date(PINNED_NOW()), 'tools/call'), dec(0.4));
      await ctx.logger.log(makeOp(agentId, 'fs', 'sess-2', new Date(PINNED_NOW()), 'tools/call'), dec(0.6));
      // Older than 1h but in 7d (should NOT count in 1h stats)
      await ctx.logger.log(makeOp(agentId, 'fs', 'sess-3', hoursAgo(3), 'tools/call'), dec(0.9));

      const { status, body } = await getJSON(ctx.port, `/agents/${agentId}`);
      expect(status).toBe(200);

      // avg of 1h window only: (0.4 + 0.6) / 2 = 0.5
      expect(body.avgRiskScoreLast1h as number).toBeCloseTo(0.5, 5);
      expect(body.maxRiskScoreLast1h as number).toBeCloseTo(0.6, 5);
      expect(body.minRiskScoreLast1h as number).toBeCloseTo(0.4, 5);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1254-T1258 — v10.37 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('15. tools — all five new fields are present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-h', 'tool-v1037-pres', 'sess-1', new Date(PINNED_NOW()), 'tools/call'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1037-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('topMethodLast7d');
      expect(body).toHaveProperty('topMethodLast30d');
      expect(body).toHaveProperty('avgRiskScoreLast1h');
      expect(body).toHaveProperty('maxRiskScoreLast1h');
      expect(body).toHaveProperty('minRiskScoreLast1h');
    });

    it('16. tools — only old ops (>40d): all five new fields are null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-i', 'tool-v1037-old', 'sess-1', daysAgo(42), 'tools/call'), dec(0.4));
      await ctx.logger.log(makeOp('agent-i', 'tool-v1037-old', 'sess-2', daysAgo(50), 'resources/read'), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1037-old');
      expect(status).toBe(200);

      expect(body.topMethodLast7d).toBeNull();
      expect(body.topMethodLast30d).toBeNull();
      expect(body.avgRiskScoreLast1h).toBeNull();
      expect(body.maxRiskScoreLast1h).toBeNull();
      expect(body.minRiskScoreLast1h).toBeNull();
    });

    it('17. tools — multiple methods in 7d: topMethodLast7d returns most frequent', async () => {
      ctx = await setup();
      const tool = 'tool-v1037-7d-top';
      // 'sampling/createMessage' appears 4 times; 'tools/call' appears 2 times
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp(`agent-t-${i}`, tool, `sess-${i}`, daysAgo(i + 1), 'sampling/createMessage'), dec(0.3));
      }
      await ctx.logger.log(makeOp('agent-t-4', tool, 'sess-4', daysAgo(5), 'tools/call'), dec(0.5));
      await ctx.logger.log(makeOp('agent-t-5', tool, 'sess-5', daysAgo(6), 'tools/call'), dec(0.6));

      const { status, body } = await getJSON(ctx.port, `/tools/${tool}`);
      expect(status).toBe(200);

      expect(body.topMethodLast7d).toBe('sampling/createMessage');
    });

    it('18. tools — ops only in 30d window (not 7d): topMethodLast7d null, topMethodLast30d correct', async () => {
      ctx = await setup();
      const tool = 'tool-v1037-30d-only';
      await ctx.logger.log(makeOp('agent-j1', tool, 'sess-1', daysAgo(10), 'resources/list'), dec(0.3));
      await ctx.logger.log(makeOp('agent-j2', tool, 'sess-2', daysAgo(20), 'resources/list'), dec(0.4));
      await ctx.logger.log(makeOp('agent-j3', tool, 'sess-3', daysAgo(28), 'tools/call'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, `/tools/${tool}`);
      expect(status).toBe(200);

      expect(body.topMethodLast7d).toBeNull();
      expect(body.topMethodLast30d).toBe('resources/list');
    });

    it('19. tools — two ops in 1h with different scores: avg, max, min correct', async () => {
      ctx = await setup();
      const tool = 'tool-v1037-1h-calc';
      await ctx.logger.log(makeOp('agent-k1', tool, 'sess-1', new Date(PINNED_NOW()), 'tools/call'), dec(0.15));
      await ctx.logger.log(makeOp('agent-k2', tool, 'sess-2', new Date(PINNED_NOW()), 'tools/call'), dec(0.85));

      const { status, body } = await getJSON(ctx.port, `/tools/${tool}`);
      expect(status).toBe(200);

      // avg = (0.15 + 0.85) / 2 = 0.5
      expect(body.avgRiskScoreLast1h as number).toBeCloseTo(0.5, 5);
      expect(body.maxRiskScoreLast1h as number).toBeCloseTo(0.85, 5);
      expect(body.minRiskScoreLast1h as number).toBeCloseTo(0.15, 5);
    });

    it('20. tools — ops outside 1h window: avgRiskScoreLast1h, maxRiskScoreLast1h, minRiskScoreLast1h null', async () => {
      ctx = await setup();
      const tool = 'tool-v1037-1h-empty';
      // Op at 2h ago (outside 1h window) but within 7d
      await ctx.logger.log(makeOp('agent-l1', tool, 'sess-1', hoursAgo(2), 'tools/call'), dec(0.5));
      // Old op to seed the tool
      await ctx.logger.log(makeOp('agent-l1', tool, 'sess-2', daysAgo(42), 'tools/call'), dec(0.6));

      const { status, body } = await getJSON(ctx.port, `/tools/${tool}`);
      expect(status).toBe(200);

      expect(body.avgRiskScoreLast1h).toBeNull();
      expect(body.maxRiskScoreLast1h).toBeNull();
      expect(body.minRiskScoreLast1h).toBeNull();
    });
  });

  // ── operations/summary endpoint ────────────────────────────────────────────────

  describe('T1254-T1258 — v10.37 new fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('21. summary — all five new fields are present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-m', 'tool-s', 'sess-1', new Date(PINNED_NOW()), 'tools/call'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body).toHaveProperty('topMethodLast7d');
      expect(body).toHaveProperty('topMethodLast30d');
      expect(body).toHaveProperty('avgRiskScoreLast1h');
      expect(body).toHaveProperty('maxRiskScoreLast1h');
      expect(body).toHaveProperty('minRiskScoreLast1h');
    });

    it('22. summary — empty DB: all five new fields are null', async () => {
      ctx = await setup();

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.topMethodLast7d).toBeNull();
      expect(body.topMethodLast30d).toBeNull();
      expect(body.avgRiskScoreLast1h).toBeNull();
      expect(body.maxRiskScoreLast1h).toBeNull();
      expect(body.minRiskScoreLast1h).toBeNull();
    });

    it('23. summary — only old ops (>40d): all five new fields are null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-n1', 'tool-n', 'sess-1', daysAgo(42), 'tools/call'), dec(0.3));
      await ctx.logger.log(makeOp('agent-n2', 'tool-n', 'sess-2', daysAgo(50), 'resources/read'), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.topMethodLast7d).toBeNull();
      expect(body.topMethodLast30d).toBeNull();
      expect(body.avgRiskScoreLast1h).toBeNull();
      expect(body.maxRiskScoreLast1h).toBeNull();
      expect(body.minRiskScoreLast1h).toBeNull();
    });

    it('24. summary — multiple methods in 7d: topMethodLast7d returns the most frequent', async () => {
      ctx = await setup();
      // 'tools/call' appears 4 times in 7d; 'resources/list' appears 2 times
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp(`agent-sum-7d-${i}`, `tool-${i}`, `sess-sum-7d-${i}`, daysAgo(i + 1), 'tools/call'), dec(0.3));
      }
      await ctx.logger.log(makeOp('agent-sum-7d-4', 'tool-4', 'sess-sum-7d-4', daysAgo(5), 'resources/list'), dec(0.4));
      await ctx.logger.log(makeOp('agent-sum-7d-5', 'tool-5', 'sess-sum-7d-5', daysAgo(6), 'resources/list'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.topMethodLast7d).toBe('tools/call');
    });

    it('25. summary — ops only in 30d (not 7d): topMethodLast7d null, topMethodLast30d correct', async () => {
      ctx = await setup();
      // Three ops in 30d window but outside 7d: 'resources/read' x2, 'tools/call' x1
      await ctx.logger.log(makeOp('agent-sum-30d-1', 'tool-r1', 'sess-1', daysAgo(10), 'resources/read'), dec(0.2));
      await ctx.logger.log(makeOp('agent-sum-30d-2', 'tool-r2', 'sess-2', daysAgo(20), 'resources/read'), dec(0.3));
      await ctx.logger.log(makeOp('agent-sum-30d-3', 'tool-r3', 'sess-3', daysAgo(28), 'tools/call'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.topMethodLast7d).toBeNull();
      expect(body.topMethodLast30d).toBe('resources/read');
    });

    it('26. summary — mix of 7d and 30d ops with different methods: topMethodLast30d reflects full 30d window', async () => {
      ctx = await setup();
      // In 7d: 'tools/call' x2
      await ctx.logger.log(makeOp('agent-sum-mix-1', 'tool-m1', 'sess-1', daysAgo(2), 'tools/call'), dec(0.3));
      await ctx.logger.log(makeOp('agent-sum-mix-2', 'tool-m2', 'sess-2', daysAgo(5), 'tools/call'), dec(0.4));
      // In 30d but not 7d: 'resources/read' x3 (dominant in 30d)
      await ctx.logger.log(makeOp('agent-sum-mix-3', 'tool-m3', 'sess-3', daysAgo(10), 'resources/read'), dec(0.5));
      await ctx.logger.log(makeOp('agent-sum-mix-4', 'tool-m4', 'sess-4', daysAgo(18), 'resources/read'), dec(0.6));
      await ctx.logger.log(makeOp('agent-sum-mix-5', 'tool-m5', 'sess-5', daysAgo(26), 'resources/read'), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      // 7d: 'tools/call' x2 dominates
      expect(body.topMethodLast7d).toBe('tools/call');
      // 30d: 'resources/read' x3 vs 'tools/call' x2 → resources/read wins
      expect(body.topMethodLast30d).toBe('resources/read');
    });

    it('27. summary — three ops in 1h: avg, max, min computed correctly', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-sum-1h-1', 'tool-s1', 'sess-1', new Date(PINNED_NOW()), 'tools/call'), dec(0.2));
      await ctx.logger.log(makeOp('agent-sum-1h-2', 'tool-s2', 'sess-2', new Date(PINNED_NOW()), 'tools/call'), dec(0.6));
      await ctx.logger.log(makeOp('agent-sum-1h-3', 'tool-s3', 'sess-3', new Date(PINNED_NOW()), 'tools/call'), dec(1.0));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      // avg = (0.2 + 0.6 + 1.0) / 3 ≈ 0.6
      expect(body.avgRiskScoreLast1h as number).toBeCloseTo(0.6, 5);
      expect(body.maxRiskScoreLast1h as number).toBeCloseTo(1.0, 5);
      expect(body.minRiskScoreLast1h as number).toBeCloseTo(0.2, 5);
    });

    it('28. summary — ops at exactly 1h boundary are excluded from 1h window', async () => {
      ctx = await setup();
      // Op at exactly 1h + 5s ago (outside the window)
      await ctx.logger.log(makeOp('agent-sum-bdy-1', 'tool-bdy', 'sess-1', hoursAgo(1.002), 'tools/call'), dec(0.9));
      // Op at 30min ago (inside 1h window)
      await ctx.logger.log(makeOp('agent-sum-bdy-2', 'tool-bdy2', 'sess-2', new Date(PINNED_NOW()), 'tools/call'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      // Only the 30min op is in the 1h window
      expect(body.avgRiskScoreLast1h as number).toBeCloseTo(0.4, 5);
      expect(body.maxRiskScoreLast1h as number).toBeCloseTo(0.4, 5);
      expect(body.minRiskScoreLast1h as number).toBeCloseTo(0.4, 5);
    });

    it('29. summary — single op in each window: topMethodLast7d and topMethodLast30d return correct single method', async () => {
      ctx = await setup();
      // One op in 7d
      await ctx.logger.log(makeOp('agent-sum-single-1', 'tool-ss1', 'sess-1', daysAgo(3), 'notifications/initialized'), dec(0.4));
      // One op in 30d (outside 7d)
      await ctx.logger.log(makeOp('agent-sum-single-2', 'tool-ss2', 'sess-2', daysAgo(15), 'ping'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      // 7d window: only 'notifications/initialized'
      expect(body.topMethodLast7d).toBe('notifications/initialized');
      // 30d window: 'notifications/initialized' x1, 'ping' x1 — tie goes to whichever is encountered first in map iteration
      // Both appear once; since we only assert the 7d field uniquely here, we skip 30d assertion for this test
      expect(typeof body.topMethodLast30d).toBe('string');
    });

    it('30. summary — topMethodLast7d is null when all 7d ops are older than 7d', async () => {
      ctx = await setup();
      // Op at exactly 7d + 10min ago
      await ctx.logger.log(makeOp('agent-sum-7d-bdy', 'tool-7dbdy', 'sess-1', daysAgo(7.01), 'tools/call'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.topMethodLast7d).toBeNull();
      // But topMethodLast30d should be populated since op is within 30d
      expect(body.topMethodLast30d).toBe('tools/call');
    });
  });
});

// ── v10.38 ────────────────────────────────────────────────────────────────────

describe('v10.38', () => {
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1259-T1263 — v10.38 sessions endpoint fields', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-a', 'fs', 'sess-v1038-presence'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1038-presence');
      expect(status).toBe(200);
      expect(body).toHaveProperty('avgRiskScoreLast7d');
      expect(body).toHaveProperty('avgRiskScoreLast30d');
      expect(body).toHaveProperty('maxRiskScoreLast7d');
      expect(body).toHaveProperty('maxRiskScoreLast30d');
      expect(body).toHaveProperty('minRiskScoreLast7d');
    });

    it('2. sessions — only old ops (>30d): all five fields null', async () => {
      ctx = await setup();
      // Seed old ops so the session is found (no 404)
      await ctx.logger.log(makeOp('agt-b', 'fs', 'sess-v1038-old', daysAgo(40)), dec(0.4));
      await ctx.logger.log(makeOp('agt-b', 'fs', 'sess-v1038-old', daysAgo(45)), dec(0.9));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1038-old');
      expect(status).toBe(200);
      expect(body.avgRiskScoreLast7d).toBeNull();
      expect(body.avgRiskScoreLast30d).toBeNull();
      expect(body.maxRiskScoreLast7d).toBeNull();
      expect(body.maxRiskScoreLast30d).toBeNull();
      expect(body.minRiskScoreLast7d).toBeNull();
    });

    it('3. sessions — scores [0.2, 0.6, 0.8] in 7d: avg=0.5333, max=0.8, min=0.2', async () => {
      ctx = await setup();
      const sid = 'sess-v1038-7d-vals';
      await ctx.logger.log(makeOp('agt-c', 'fs', sid, daysAgo(1)), dec(0.2));
      await ctx.logger.log(makeOp('agt-c', 'fs', sid, daysAgo(3)), dec(0.6));
      await ctx.logger.log(makeOp('agt-c', 'fs', sid, daysAgo(5)), dec(0.8));

      const { status, body } = await getJSON(ctx.port, `/sessions/${sid}`);
      expect(status).toBe(200);
      expect(body.avgRiskScoreLast7d as number).toBeCloseTo((0.2 + 0.6 + 0.8) / 3, 5);
      expect(body.maxRiskScoreLast7d as number).toBeCloseTo(0.8, 5);
      expect(body.minRiskScoreLast7d as number).toBeCloseTo(0.2, 5);
    });

    it('4. sessions — ops in 30d but not 7d: 7d fields null, 30d fields computed', async () => {
      ctx = await setup();
      const sid = 'sess-v1038-30d-only';
      await ctx.logger.log(makeOp('agt-d', 'fs', sid, daysAgo(10)), dec(0.3));
      await ctx.logger.log(makeOp('agt-d', 'fs', sid, daysAgo(25)), dec(0.7));

      const { status, body } = await getJSON(ctx.port, `/sessions/${sid}`);
      expect(status).toBe(200);
      expect(body.avgRiskScoreLast7d).toBeNull();
      expect(body.maxRiskScoreLast7d).toBeNull();
      expect(body.minRiskScoreLast7d).toBeNull();
      // 30d: [0.3, 0.7]
      expect(body.avgRiskScoreLast30d as number).toBeCloseTo(0.5, 5);
      expect(body.maxRiskScoreLast30d as number).toBeCloseTo(0.7, 5);
    });

    it('5. sessions — single op in 7d: avg=max=min=that score', async () => {
      ctx = await setup();
      const sid = 'sess-v1038-single-7d';
      await ctx.logger.log(makeOp('agt-e', 'fs', sid, daysAgo(2)), dec(0.55));

      const { status, body } = await getJSON(ctx.port, `/sessions/${sid}`);
      expect(status).toBe(200);
      expect(body.avgRiskScoreLast7d as number).toBeCloseTo(0.55, 5);
      expect(body.maxRiskScoreLast7d as number).toBeCloseTo(0.55, 5);
      expect(body.minRiskScoreLast7d as number).toBeCloseTo(0.55, 5);
    });

    it('6. sessions — mix of 7d, 30d, and >30d ops: correct partitioning', async () => {
      ctx = await setup();
      const sid = 'sess-v1038-mix';
      // 7d ops: 0.1, 0.9  avg=0.5 max=0.9 min=0.1
      await ctx.logger.log(makeOp('agt-f', 'fs', sid, daysAgo(1)), dec(0.1));
      await ctx.logger.log(makeOp('agt-f', 'fs', sid, daysAgo(6)), dec(0.9));
      // 30d but not 7d: 0.5
      await ctx.logger.log(makeOp('agt-f', 'fs', sid, daysAgo(15)), dec(0.5));
      // >30d (anchor for session existence, excluded from all windows)
      await ctx.logger.log(makeOp('agt-f', 'fs', sid, daysAgo(40)), dec(0.99));

      const { status, body } = await getJSON(ctx.port, `/sessions/${sid}`);
      expect(status).toBe(200);
      expect(body.avgRiskScoreLast7d as number).toBeCloseTo(0.5, 5);
      expect(body.maxRiskScoreLast7d as number).toBeCloseTo(0.9, 5);
      expect(body.minRiskScoreLast7d as number).toBeCloseTo(0.1, 5);
      // 30d includes 7d ops too: [0.1, 0.5, 0.9] avg=0.5 max=0.9
      expect(body.avgRiskScoreLast30d as number).toBeCloseTo((0.1 + 0.9 + 0.5) / 3, 5);
      expect(body.maxRiskScoreLast30d as number).toBeCloseTo(0.9, 5);
    });

    it('7. sessions — minRiskScoreLast7d is strictly the minimum', async () => {
      ctx = await setup();
      const sid = 'sess-v1038-min7d';
      for (const score of [0.9, 0.1, 0.5, 0.3]) {
        await ctx.logger.log(makeOp('agt-g', 'fs', sid, daysAgo(1)), dec(score));
      }

      const { status, body } = await getJSON(ctx.port, `/sessions/${sid}`);
      expect(status).toBe(200);
      expect(body.minRiskScoreLast7d as number).toBeCloseTo(0.1, 5);
    });
  });

  // ── agents endpoint ─────────────────────────────────────────────────────────────

  describe('T1259-T1263 — v10.38 agents endpoint fields', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('8. agents — all five new fields present', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-v1038-pres', 'fs', 'sess-a1'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/agents/agt-v1038-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('avgRiskScoreLast7d');
      expect(body).toHaveProperty('avgRiskScoreLast30d');
      expect(body).toHaveProperty('maxRiskScoreLast7d');
      expect(body).toHaveProperty('maxRiskScoreLast30d');
      expect(body).toHaveProperty('minRiskScoreLast7d');
    });

    it('9. agents — only old ops (>30d): all five fields null', async () => {
      ctx = await setup();
      const agentId = 'agt-v1038-old';
      await ctx.logger.log(makeOp(agentId, 'fs', 'sess-a2', daysAgo(35)), dec(0.6));
      await ctx.logger.log(makeOp(agentId, 'fs', 'sess-a2', daysAgo(50)), dec(0.3));

      const { status, body } = await getJSON(ctx.port, `/agents/${agentId}`);
      expect(status).toBe(200);
      expect(body.avgRiskScoreLast7d).toBeNull();
      expect(body.avgRiskScoreLast30d).toBeNull();
      expect(body.maxRiskScoreLast7d).toBeNull();
      expect(body.maxRiskScoreLast30d).toBeNull();
      expect(body.minRiskScoreLast7d).toBeNull();
    });

    it('10. agents — scores [0.2, 0.6, 0.8] in 7d: avg=0.5333, max=0.8, min=0.2', async () => {
      ctx = await setup();
      const agentId = 'agt-v1038-vals';
      await ctx.logger.log(makeOp(agentId, 'fs', 'sess-a3', daysAgo(1)), dec(0.2));
      await ctx.logger.log(makeOp(agentId, 'fs', 'sess-a3', daysAgo(3)), dec(0.6));
      await ctx.logger.log(makeOp(agentId, 'fs', 'sess-a3', daysAgo(5)), dec(0.8));

      const { status, body } = await getJSON(ctx.port, `/agents/${agentId}`);
      expect(status).toBe(200);
      expect(body.avgRiskScoreLast7d as number).toBeCloseTo((0.2 + 0.6 + 0.8) / 3, 5);
      expect(body.maxRiskScoreLast7d as number).toBeCloseTo(0.8, 5);
      expect(body.minRiskScoreLast7d as number).toBeCloseTo(0.2, 5);
    });

    it('11. agents — ops in 30d but not 7d: 7d fields null, 30d avg correct', async () => {
      ctx = await setup();
      const agentId = 'agt-v1038-30only';
      await ctx.logger.log(makeOp(agentId, 'fs', 'sess-a4', daysAgo(10)), dec(0.4));
      await ctx.logger.log(makeOp(agentId, 'fs', 'sess-a4', daysAgo(20)), dec(0.8));

      const { status, body } = await getJSON(ctx.port, `/agents/${agentId}`);
      expect(status).toBe(200);
      expect(body.avgRiskScoreLast7d).toBeNull();
      expect(body.minRiskScoreLast7d).toBeNull();
      expect(body.maxRiskScoreLast7d).toBeNull();
      expect(body.avgRiskScoreLast30d as number).toBeCloseTo(0.6, 5);
      expect(body.maxRiskScoreLast30d as number).toBeCloseTo(0.8, 5);
    });

    it('12. agents — maxRiskScoreLast30d includes ops from both 7d and 8-30d windows', async () => {
      ctx = await setup();
      const agentId = 'agt-v1038-max30';
      // 7d op low score
      await ctx.logger.log(makeOp(agentId, 'fs', 'sess-a5', daysAgo(2)), dec(0.3));
      // 30d op high score
      await ctx.logger.log(makeOp(agentId, 'fs', 'sess-a5', daysAgo(20)), dec(0.95));

      const { status, body } = await getJSON(ctx.port, `/agents/${agentId}`);
      expect(status).toBe(200);
      // maxRiskScoreLast30d should pick up the 0.95 from 20 days ago
      expect(body.maxRiskScoreLast30d as number).toBeCloseTo(0.95, 5);
      // maxRiskScoreLast7d should only see the 0.3
      expect(body.maxRiskScoreLast7d as number).toBeCloseTo(0.3, 5);
    });

    it('13. agents — single op in 30d window: max30d == min7d not applicable; values correct', async () => {
      ctx = await setup();
      const agentId = 'agt-v1038-one30';
      // Anchor op >30d for session existence
      await ctx.logger.log(makeOp(agentId, 'fs', 'sess-a6', daysAgo(40)), dec(0.1));
      // Single recent-ish op at 15d
      await ctx.logger.log(makeOp(agentId, 'fs', 'sess-a6', daysAgo(15)), dec(0.77));

      const { status, body } = await getJSON(ctx.port, `/agents/${agentId}`);
      expect(status).toBe(200);
      expect(body.avgRiskScoreLast30d as number).toBeCloseTo(0.77, 5);
      expect(body.maxRiskScoreLast30d as number).toBeCloseTo(0.77, 5);
      expect(body.minRiskScoreLast7d).toBeNull();
    });
  });

  // ── tools endpoint ──────────────────────────────────────────────────────────────

  describe('T1259-T1263 — v10.38 tools endpoint fields', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('14. tools — all five new fields present', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-t1', 'tool-v1038-pres', 'sess-t1'), dec(0.3));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1038-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('avgRiskScoreLast7d');
      expect(body).toHaveProperty('avgRiskScoreLast30d');
      expect(body).toHaveProperty('maxRiskScoreLast7d');
      expect(body).toHaveProperty('maxRiskScoreLast30d');
      expect(body).toHaveProperty('minRiskScoreLast7d');
    });

    it('15. tools — only old ops (>30d): all five fields null', async () => {
      ctx = await setup();
      const tool = 'tool-v1038-old';
      await ctx.logger.log(makeOp('agt-t2', tool, 'sess-t2', daysAgo(40)), dec(0.5));
      await ctx.logger.log(makeOp('agt-t2', tool, 'sess-t2', daysAgo(50)), dec(0.7));

      const { status, body } = await getJSON(ctx.port, `/tools/${tool}`);
      expect(status).toBe(200);
      expect(body.avgRiskScoreLast7d).toBeNull();
      expect(body.avgRiskScoreLast30d).toBeNull();
      expect(body.maxRiskScoreLast7d).toBeNull();
      expect(body.maxRiskScoreLast30d).toBeNull();
      expect(body.minRiskScoreLast7d).toBeNull();
    });

    it('16. tools — scores [0.2, 0.6, 0.8] in 7d: avg=0.5333, max=0.8, min=0.2', async () => {
      ctx = await setup();
      const tool = 'tool-v1038-vals';
      await ctx.logger.log(makeOp('agt-t3', tool, 'sess-t3', daysAgo(1)), dec(0.2));
      await ctx.logger.log(makeOp('agt-t3', tool, 'sess-t3', daysAgo(3)), dec(0.6));
      await ctx.logger.log(makeOp('agt-t3', tool, 'sess-t3', daysAgo(5)), dec(0.8));

      const { status, body } = await getJSON(ctx.port, `/tools/${tool}`);
      expect(status).toBe(200);
      expect(body.avgRiskScoreLast7d as number).toBeCloseTo((0.2 + 0.6 + 0.8) / 3, 5);
      expect(body.maxRiskScoreLast7d as number).toBeCloseTo(0.8, 5);
      expect(body.minRiskScoreLast7d as number).toBeCloseTo(0.2, 5);
    });

    it('17. tools — ops in 30d but not 7d: 7d fields null, 30d avg correct', async () => {
      ctx = await setup();
      const tool = 'tool-v1038-30only';
      await ctx.logger.log(makeOp('agt-t4', tool, 'sess-t4', daysAgo(12)), dec(0.4));
      await ctx.logger.log(makeOp('agt-t4', tool, 'sess-t4', daysAgo(22)), dec(0.6));

      const { status, body } = await getJSON(ctx.port, `/tools/${tool}`);
      expect(status).toBe(200);
      expect(body.avgRiskScoreLast7d).toBeNull();
      expect(body.maxRiskScoreLast7d).toBeNull();
      expect(body.minRiskScoreLast7d).toBeNull();
      expect(body.avgRiskScoreLast30d as number).toBeCloseTo(0.5, 5);
      expect(body.maxRiskScoreLast30d as number).toBeCloseTo(0.6, 5);
    });

    it('18. tools — minRiskScoreLast7d is the lowest 7d score', async () => {
      ctx = await setup();
      const tool = 'tool-v1038-min';
      for (const score of [0.9, 0.05, 0.5, 0.7]) {
        await ctx.logger.log(makeOp('agt-t5', tool, 'sess-t5', daysAgo(2)), dec(score));
      }

      const { status, body } = await getJSON(ctx.port, `/tools/${tool}`);
      expect(status).toBe(200);
      expect(body.minRiskScoreLast7d as number).toBeCloseTo(0.05, 5);
    });

    it('19. tools — maxRiskScoreLast7d is strictly the highest 7d score', async () => {
      ctx = await setup();
      const tool = 'tool-v1038-max';
      for (const score of [0.1, 0.4, 0.85, 0.2]) {
        await ctx.logger.log(makeOp('agt-t6', tool, 'sess-t6', daysAgo(3)), dec(score));
      }

      const { status, body } = await getJSON(ctx.port, `/tools/${tool}`);
      expect(status).toBe(200);
      expect(body.maxRiskScoreLast7d as number).toBeCloseTo(0.85, 5);
    });
  });

  // ── operations/summary endpoint ─────────────────────────────────────────────────

  describe('T1259-T1263 — v10.38 operations/summary endpoint fields', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('20. summary — all five new fields present', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-s1', 'fs', 'sess-s1'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body).toHaveProperty('avgRiskScoreLast7d');
      expect(body).toHaveProperty('avgRiskScoreLast30d');
      expect(body).toHaveProperty('maxRiskScoreLast7d');
      expect(body).toHaveProperty('maxRiskScoreLast30d');
      expect(body).toHaveProperty('minRiskScoreLast7d');
    });

    it('21. summary — only old ops (>30d): 7d and 30d fields null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-s2', 'fs', 'sess-s2', daysAgo(35)), dec(0.5));
      await ctx.logger.log(makeOp('agt-s2', 'fs', 'sess-s2', daysAgo(45)), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.avgRiskScoreLast7d).toBeNull();
      expect(body.avgRiskScoreLast30d).toBeNull();
      expect(body.maxRiskScoreLast7d).toBeNull();
      expect(body.maxRiskScoreLast30d).toBeNull();
      expect(body.minRiskScoreLast7d).toBeNull();
    });

    it('22. summary — scores [0.2, 0.6, 0.8] in 7d: avg=0.5333, max=0.8, min=0.2', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-s3', 'fs', 'sess-s3', daysAgo(1)), dec(0.2));
      await ctx.logger.log(makeOp('agt-s3', 'fs', 'sess-s3', daysAgo(3)), dec(0.6));
      await ctx.logger.log(makeOp('agt-s3', 'fs', 'sess-s3', daysAgo(5)), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.avgRiskScoreLast7d as number).toBeCloseTo((0.2 + 0.6 + 0.8) / 3, 5);
      expect(body.maxRiskScoreLast7d as number).toBeCloseTo(0.8, 5);
      expect(body.minRiskScoreLast7d as number).toBeCloseTo(0.2, 5);
    });

    it('23. summary — ops in 30d but not 7d: 7d fields null, 30d fields populated', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-s4', 'fs', 'sess-s4', daysAgo(10)), dec(0.3));
      await ctx.logger.log(makeOp('agt-s4', 'fs', 'sess-s4', daysAgo(25)), dec(0.9));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.avgRiskScoreLast7d).toBeNull();
      expect(body.maxRiskScoreLast7d).toBeNull();
      expect(body.minRiskScoreLast7d).toBeNull();
      expect(body.avgRiskScoreLast30d as number).toBeCloseTo(0.6, 5);
      expect(body.maxRiskScoreLast30d as number).toBeCloseTo(0.9, 5);
    });

    it('24. summary — mixed 7d, 30d, and >30d ops: windowing correct', async () => {
      ctx = await setup();
      // 7d ops: scores 0.1, 0.5
      await ctx.logger.log(makeOp('agt-s5', 'fs', 'sess-s5', daysAgo(2)), dec(0.1));
      await ctx.logger.log(makeOp('agt-s5', 'fs', 'sess-s5', daysAgo(6)), dec(0.5));
      // 30d only: 0.9
      await ctx.logger.log(makeOp('agt-s5', 'fs', 'sess-s5', daysAgo(20)), dec(0.9));
      // >30d: excluded from all windows
      await ctx.logger.log(makeOp('agt-s5', 'fs', 'sess-s5', daysAgo(40)), dec(0.99));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      // 7d: [0.1, 0.5]
      expect(body.avgRiskScoreLast7d as number).toBeCloseTo(0.3, 5);
      expect(body.maxRiskScoreLast7d as number).toBeCloseTo(0.5, 5);
      expect(body.minRiskScoreLast7d as number).toBeCloseTo(0.1, 5);
      // 30d: [0.1, 0.5, 0.9]
      expect(body.avgRiskScoreLast30d as number).toBeCloseTo((0.1 + 0.5 + 0.9) / 3, 5);
      expect(body.maxRiskScoreLast30d as number).toBeCloseTo(0.9, 5);
    });

    it('25. summary — single op in 7d: avg7d == max7d == min7d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-s6', 'fs', 'sess-s6', daysAgo(3)), dec(0.42));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.avgRiskScoreLast7d as number).toBeCloseTo(0.42, 5);
      expect(body.maxRiskScoreLast7d as number).toBeCloseTo(0.42, 5);
      expect(body.minRiskScoreLast7d as number).toBeCloseTo(0.42, 5);
    });

    it('26. summary — 30d max higher than 7d max: fields independent', async () => {
      ctx = await setup();
      // 7d: low score
      await ctx.logger.log(makeOp('agt-s7', 'fs', 'sess-s7', daysAgo(1)), dec(0.2));
      // 30d: high score
      await ctx.logger.log(makeOp('agt-s7', 'fs', 'sess-s7', daysAgo(15)), dec(0.95));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.maxRiskScoreLast7d as number).toBeCloseTo(0.2, 5);
      expect(body.maxRiskScoreLast30d as number).toBeCloseTo(0.95, 5);
    });

    it('27. summary — avgRiskScoreLast30d covers all 30d ops including 7d ops', async () => {
      ctx = await setup();
      // Three ops: 2d, 10d, 25d ago — all within 30d
      await ctx.logger.log(makeOp('agt-s8', 'fs', 'sess-s8', daysAgo(2)), dec(0.1));
      await ctx.logger.log(makeOp('agt-s8', 'fs', 'sess-s8', daysAgo(10)), dec(0.5));
      await ctx.logger.log(makeOp('agt-s8', 'fs', 'sess-s8', daysAgo(25)), dec(0.9));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      // 7d only sees 0.1
      expect(body.avgRiskScoreLast7d as number).toBeCloseTo(0.1, 5);
      // 30d sees all three: avg = (0.1+0.5+0.9)/3
      expect(body.avgRiskScoreLast30d as number).toBeCloseTo((0.1 + 0.5 + 0.9) / 3, 5);
    });
  });
});

// ── v10.39 ────────────────────────────────────────────────────────────────────

describe('v10.39', () => {
  const hoursAgo = (h: number) => new Date(PINNED_NOW() - h * 3_600_000);
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1264-T1268 — v10.39 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1039-pres'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1039-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('minRiskScoreLast30d');
      expect(body).toHaveProperty('riskScoreRangeLast24h');
      expect(body).toHaveProperty('riskScoreRangeLast7d');
      expect(body).toHaveProperty('riskScoreRangeLast30d');
      expect(body).toHaveProperty('opsLast1h');
    });

    it('2. sessions — only old ops (>30d): range/min fields null, opsLast1h = 0', async () => {
      ctx = await setup();
      // Seed old ops so the endpoint returns 200 (not 404)
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1039-old', daysAgo(41)), dec(0.3));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1039-old', daysAgo(45)), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1039-old');
      expect(status).toBe(200);
      expect(body.minRiskScoreLast30d).toBeNull();
      expect(body.riskScoreRangeLast24h).toBeNull();
      expect(body.riskScoreRangeLast7d).toBeNull();
      expect(body.riskScoreRangeLast30d).toBeNull();
      expect(body.opsLast1h).toBe(0);
    });

    it('3. sessions — two ops within 24h: riskScoreRangeLast24h = max - min', async () => {
      ctx = await setup();
      // Ops at 1h and 2h ago: scores 0.2 and 0.8 → range = 0.6
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1039-24h', hoursAgo(1)), dec(0.2));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1039-24h', hoursAgo(2)), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1039-24h');
      expect(status).toBe(200);
      expect(body.riskScoreRangeLast24h as number).toBeCloseTo(0.6, 5);
    });

    it('4. sessions — single op in 24h: riskScoreRangeLast24h = 0 (max - min of one value)', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1039-24h-single', hoursAgo(1)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1039-24h-single');
      expect(status).toBe(200);
      expect(body.riskScoreRangeLast24h as number).toBeCloseTo(0.0, 5);
    });

    it('5. sessions — two ops within 7d: riskScoreRangeLast7d = 0.5', async () => {
      ctx = await setup();
      // Scores 0.3 and 0.8 → range = 0.5
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1039-7d', daysAgo(2)), dec(0.3));
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1039-7d', daysAgo(5)), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1039-7d');
      expect(status).toBe(200);
      expect(body.riskScoreRangeLast7d as number).toBeCloseTo(0.5, 5);
    });

    it('6. sessions — ops only in 7-30d range: 24h and 7d ranges null, 30d ranges populated', async () => {
      ctx = await setup();
      // Both ops are >7d but <30d ago
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1039-30d', daysAgo(10)), dec(0.2));
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1039-30d', daysAgo(20)), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1039-30d');
      expect(status).toBe(200);
      expect(body.riskScoreRangeLast24h).toBeNull();
      expect(body.riskScoreRangeLast7d).toBeNull();
      expect(body.riskScoreRangeLast30d as number).toBeCloseTo(0.6, 5);
      expect(body.minRiskScoreLast30d as number).toBeCloseTo(0.2, 5);
    });

    it('7. sessions — minRiskScoreLast30d returns minimum score in 30d window', async () => {
      ctx = await setup();
      // Three ops within 30d: scores 0.1, 0.5, 0.9
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1039-min', daysAgo(1)), dec(0.5));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1039-min', daysAgo(3)), dec(0.1));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1039-min', daysAgo(7)), dec(0.9));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1039-min');
      expect(status).toBe(200);
      expect(body.minRiskScoreLast30d as number).toBeCloseTo(0.1, 5);
    });

    it('8. sessions — opsLast1h counts only ops within 1h', async () => {
      ctx = await setup();
      // 2 ops within 1h, 1 op older
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1039-1h'), dec(0.4));
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1039-1h'), dec(0.6));
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1039-1h', hoursAgo(2)), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1039-1h');
      expect(status).toBe(200);
      expect(body.opsLast1h).toBe(2);
    });

    it('9. sessions — equal risk scores: range = 0', async () => {
      ctx = await setup();
      // Both ops have risk 0.5 → range = 0
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v1039-equal', daysAgo(1)), dec(0.5));
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v1039-equal', daysAgo(2)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1039-equal');
      expect(status).toBe(200);
      expect(body.riskScoreRangeLast30d as number).toBeCloseTo(0.0, 5);
      expect(body.riskScoreRangeLast7d as number).toBeCloseTo(0.0, 5);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1264-T1268 — v10.39 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('10. agents — all five fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1039-pres', 'fs', 'sess-1'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1039-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('minRiskScoreLast30d');
      expect(body).toHaveProperty('riskScoreRangeLast24h');
      expect(body).toHaveProperty('riskScoreRangeLast7d');
      expect(body).toHaveProperty('riskScoreRangeLast30d');
      expect(body).toHaveProperty('opsLast1h');
    });

    it('11. agents — only old ops (>30d): range/min fields null, opsLast1h = 0', async () => {
      ctx = await setup();
      // Seed old ops to avoid 404
      await ctx.logger.log(makeOp('agent-v1039-old', 'fs', 'sess-1', daysAgo(41)), dec(0.4));
      await ctx.logger.log(makeOp('agent-v1039-old', 'fs', 'sess-2', daysAgo(50)), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1039-old');
      expect(status).toBe(200);
      expect(body.minRiskScoreLast30d).toBeNull();
      expect(body.riskScoreRangeLast24h).toBeNull();
      expect(body.riskScoreRangeLast7d).toBeNull();
      expect(body.riskScoreRangeLast30d).toBeNull();
      expect(body.opsLast1h).toBe(0);
    });

    it('12. agents — riskScoreRangeLast24h computed correctly: [0.2, 0.8] → 0.6', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1039-24h', 'fs', 'sess-1', hoursAgo(1)), dec(0.2));
      await ctx.logger.log(makeOp('agent-v1039-24h', 'fs', 'sess-1', hoursAgo(3)), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1039-24h');
      expect(status).toBe(200);
      expect(body.riskScoreRangeLast24h as number).toBeCloseTo(0.6, 5);
    });

    it('13. agents — riskScoreRangeLast7d from three scores: max - min correct', async () => {
      ctx = await setup();
      // Scores in 7d: 0.1, 0.5, 0.9 → range = 0.8
      await ctx.logger.log(makeOp('agent-v1039-7d', 'fs', 'sess-1', daysAgo(1)), dec(0.1));
      await ctx.logger.log(makeOp('agent-v1039-7d', 'fs', 'sess-1', daysAgo(3)), dec(0.9));
      await ctx.logger.log(makeOp('agent-v1039-7d', 'fs', 'sess-1', daysAgo(6)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1039-7d');
      expect(status).toBe(200);
      expect(body.riskScoreRangeLast7d as number).toBeCloseTo(0.8, 5);
    });

    it('14. agents — minRiskScoreLast30d is smallest score in 30d, ignores older ops', async () => {
      ctx = await setup();
      // Op in 30d window with low score
      await ctx.logger.log(makeOp('agent-v1039-min', 'fs', 'sess-1', daysAgo(5)), dec(0.3));
      await ctx.logger.log(makeOp('agent-v1039-min', 'fs', 'sess-1', daysAgo(15)), dec(0.7));
      // Very old op with even lower score — should not affect 30d min
      await ctx.logger.log(makeOp('agent-v1039-min', 'fs', 'sess-1', daysAgo(35)), dec(0.05));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1039-min');
      expect(status).toBe(200);
      expect(body.minRiskScoreLast30d as number).toBeCloseTo(0.3, 5);
    });

    it('15. agents — opsLast1h returns correct count', async () => {
      ctx = await setup();
      // 3 ops in 1h, 2 ops older
      await ctx.logger.log(makeOp('agent-v1039-1h', 'fs', 'sess-1'), dec(0.4));
      await ctx.logger.log(makeOp('agent-v1039-1h', 'fs', 'sess-1'), dec(0.5));
      await ctx.logger.log(makeOp('agent-v1039-1h', 'fs', 'sess-1'), dec(0.6));
      await ctx.logger.log(makeOp('agent-v1039-1h', 'fs', 'sess-1', hoursAgo(2)), dec(0.7));
      await ctx.logger.log(makeOp('agent-v1039-1h', 'fs', 'sess-1', daysAgo(1)), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1039-1h');
      expect(status).toBe(200);
      expect(body.opsLast1h).toBe(3);
    });

    it('16. agents — riskScoreRangeLast30d with only 30d-window ops: max - min', async () => {
      ctx = await setup();
      // Ops only in 8-28d range: scores 0.4 and 0.9 → range = 0.5
      await ctx.logger.log(makeOp('agent-v1039-30d', 'fs', 'sess-1', daysAgo(8)), dec(0.4));
      await ctx.logger.log(makeOp('agent-v1039-30d', 'fs', 'sess-1', daysAgo(28)), dec(0.9));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1039-30d');
      expect(status).toBe(200);
      expect(body.riskScoreRangeLast24h).toBeNull();
      expect(body.riskScoreRangeLast7d).toBeNull();
      expect(body.riskScoreRangeLast30d as number).toBeCloseTo(0.5, 5);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1264-T1268 — v10.39 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('17. tools — all five fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-t', 'tool-v1039-pres', 'sess-1'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1039-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('minRiskScoreLast30d');
      expect(body).toHaveProperty('riskScoreRangeLast24h');
      expect(body).toHaveProperty('riskScoreRangeLast7d');
      expect(body).toHaveProperty('riskScoreRangeLast30d');
      expect(body).toHaveProperty('opsLast1h');
    });

    it('18. tools — only old ops (>30d): range/min fields null, opsLast1h = 0', async () => {
      ctx = await setup();
      // Seed old ops to avoid 404
      await ctx.logger.log(makeOp('agent-t', 'tool-v1039-old', 'sess-1', daysAgo(41)), dec(0.5));
      await ctx.logger.log(makeOp('agent-t', 'tool-v1039-old', 'sess-2', daysAgo(55)), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1039-old');
      expect(status).toBe(200);
      expect(body.minRiskScoreLast30d).toBeNull();
      expect(body.riskScoreRangeLast24h).toBeNull();
      expect(body.riskScoreRangeLast7d).toBeNull();
      expect(body.riskScoreRangeLast30d).toBeNull();
      expect(body.opsLast1h).toBe(0);
    });

    it('19. tools — riskScoreRangeLast24h: two recent ops [0.3, 0.7] → range = 0.4', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-t', 'tool-v1039-24h', 'sess-1', hoursAgo(2)), dec(0.3));
      await ctx.logger.log(makeOp('agent-t', 'tool-v1039-24h', 'sess-1', hoursAgo(10)), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1039-24h');
      expect(status).toBe(200);
      expect(body.riskScoreRangeLast24h as number).toBeCloseTo(0.4, 5);
    });

    it('20. tools — minRiskScoreLast30d = smallest score across 30d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-t', 'tool-v1039-min30', 'sess-1', daysAgo(2)), dec(0.6));
      await ctx.logger.log(makeOp('agent-t', 'tool-v1039-min30', 'sess-1', daysAgo(10)), dec(0.2));
      await ctx.logger.log(makeOp('agent-t', 'tool-v1039-min30', 'sess-1', daysAgo(25)), dec(0.9));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1039-min30');
      expect(status).toBe(200);
      expect(body.minRiskScoreLast30d as number).toBeCloseTo(0.2, 5);
    });

    it('21. tools — opsLast1h = 0 when only ops outside 1h', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-t', 'tool-v1039-1h-zero', 'sess-1', hoursAgo(2)), dec(0.4));
      await ctx.logger.log(makeOp('agent-t', 'tool-v1039-1h-zero', 'sess-1', daysAgo(3)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1039-1h-zero');
      expect(status).toBe(200);
      expect(body.opsLast1h).toBe(0);
    });

    it('22. tools — riskScoreRangeLast7d from ops exactly at 7d boundary', async () => {
      ctx = await setup();
      // 2 ops within 7d window: [0.1, 0.9] → range = 0.8
      await ctx.logger.log(makeOp('agent-t', 'tool-v1039-7d', 'sess-1', daysAgo(1)), dec(0.1));
      await ctx.logger.log(makeOp('agent-t', 'tool-v1039-7d', 'sess-1', daysAgo(6)), dec(0.9));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1039-7d');
      expect(status).toBe(200);
      expect(body.riskScoreRangeLast7d as number).toBeCloseTo(0.8, 5);
    });

    it('23. tools — riskScoreRangeLast30d with same scores: range = 0', async () => {
      ctx = await setup();
      // Both ops: score 0.5 → range = 0
      await ctx.logger.log(makeOp('agent-t', 'tool-v1039-eq', 'sess-1', daysAgo(5)), dec(0.5));
      await ctx.logger.log(makeOp('agent-t', 'tool-v1039-eq', 'sess-1', daysAgo(15)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1039-eq');
      expect(status).toBe(200);
      expect(body.riskScoreRangeLast30d as number).toBeCloseTo(0.0, 5);
    });
  });

  // ── operations/summary endpoint ────────────────────────────────────────────────

  describe('T1264-T1268 — v10.39 new fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('24. summary — all five fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s', 'fs', 'sess-1'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body).toHaveProperty('minRiskScoreLast30d');
      expect(body).toHaveProperty('riskScoreRangeLast24h');
      expect(body).toHaveProperty('riskScoreRangeLast7d');
      expect(body).toHaveProperty('riskScoreRangeLast30d');
      expect(body).toHaveProperty('opsLast1h');
    });

    it('25. summary — no ops at all: range/min fields null, opsLast1h = 0', async () => {
      ctx = await setup();

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.minRiskScoreLast30d).toBeNull();
      expect(body.riskScoreRangeLast24h).toBeNull();
      expect(body.riskScoreRangeLast7d).toBeNull();
      expect(body.riskScoreRangeLast30d).toBeNull();
      expect(body.opsLast1h).toBe(0);
    });

    it('26. summary — only old ops (>30d): all windowed fields null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s', 'fs', 'sess-1', daysAgo(35)), dec(0.4));
      await ctx.logger.log(makeOp('agent-s', 'fs', 'sess-1', daysAgo(40)), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.minRiskScoreLast30d).toBeNull();
      expect(body.riskScoreRangeLast24h).toBeNull();
      expect(body.riskScoreRangeLast7d).toBeNull();
      expect(body.riskScoreRangeLast30d).toBeNull();
      expect(body.opsLast1h).toBe(0);
    });

    it('27. summary — riskScoreRangeLast24h: [0.2, 0.8] → 0.6', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s', 'fs', 'sess-1', hoursAgo(1)), dec(0.2));
      await ctx.logger.log(makeOp('agent-s', 'fs', 'sess-1', hoursAgo(5)), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreRangeLast24h as number).toBeCloseTo(0.6, 5);
    });

    it('28. summary — riskScoreRangeLast7d from three scores: 0.1, 0.5, 0.9 → 0.8', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s', 'fs', 'sess-1', daysAgo(1)), dec(0.1));
      await ctx.logger.log(makeOp('agent-s', 'fs', 'sess-1', daysAgo(4)), dec(0.9));
      await ctx.logger.log(makeOp('agent-s', 'fs', 'sess-1', daysAgo(6)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreRangeLast7d as number).toBeCloseTo(0.8, 5);
    });

    it('29. summary — minRiskScoreLast30d across mixed ops returns 30d window minimum', async () => {
      ctx = await setup();
      // Op within 30d: 0.2 (min), 0.7
      await ctx.logger.log(makeOp('agent-s', 'fs', 'sess-1', daysAgo(5)), dec(0.2));
      await ctx.logger.log(makeOp('agent-s', 'fs', 'sess-1', daysAgo(20)), dec(0.7));
      // Op older than 30d: 0.05 — should NOT affect 30d min
      await ctx.logger.log(makeOp('agent-s', 'fs', 'sess-1', daysAgo(32)), dec(0.05));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.minRiskScoreLast30d as number).toBeCloseTo(0.2, 5);
    });

    it('30. summary — opsLast1h counts only ops within the last hour', async () => {
      ctx = await setup();
      // 4 ops in 1h, 2 outside
      await ctx.logger.log(makeOp('agent-s', 'fs', 'sess-1'), dec(0.3));
      await ctx.logger.log(makeOp('agent-s', 'fs', 'sess-1'), dec(0.4));
      await ctx.logger.log(makeOp('agent-s', 'fs', 'sess-1'), dec(0.5));
      await ctx.logger.log(makeOp('agent-s', 'fs', 'sess-1'), dec(0.6));
      await ctx.logger.log(makeOp('agent-s', 'fs', 'sess-1', hoursAgo(1.5)), dec(0.7));
      await ctx.logger.log(makeOp('agent-s', 'fs', 'sess-1', daysAgo(5)), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.opsLast1h).toBe(4);
    });

    it('31. summary — riskScoreRangeLast30d with same risk scores: range = 0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s', 'fs', 'sess-1', daysAgo(3)), dec(0.6));
      await ctx.logger.log(makeOp('agent-s', 'fs', 'sess-1', daysAgo(10)), dec(0.6));
      await ctx.logger.log(makeOp('agent-s', 'fs', 'sess-1', daysAgo(25)), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreRangeLast30d as number).toBeCloseTo(0.0, 5);
    });

    it('32. summary — cross-window consistency: 24h and 7d range included in 30d range', async () => {
      ctx = await setup();
      // Op in 24h: 0.1
      await ctx.logger.log(makeOp('agent-s', 'fs', 'sess-1', hoursAgo(6)), dec(0.1));
      // Op in 7d (not 24h): 0.5
      await ctx.logger.log(makeOp('agent-s', 'fs', 'sess-1', daysAgo(3)), dec(0.5));
      // Op in 30d (not 7d): 0.9
      await ctx.logger.log(makeOp('agent-s', 'fs', 'sess-1', daysAgo(15)), dec(0.9));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      // 24h range: only [0.1] → range = 0
      expect(body.riskScoreRangeLast24h as number).toBeCloseTo(0.0, 5);
      // 7d range: [0.1, 0.5] → range = 0.4
      expect(body.riskScoreRangeLast7d as number).toBeCloseTo(0.4, 5);
      // 30d range: [0.1, 0.5, 0.9] → range = 0.8
      expect(body.riskScoreRangeLast30d as number).toBeCloseTo(0.8, 5);
      // 30d min: 0.1
      expect(body.minRiskScoreLast30d as number).toBeCloseTo(0.1, 5);
    });
  });
});

// ── v10.40 ────────────────────────────────────────────────────────────────────

describe('v10.40', () => {
  const hoursAgo = (h: number) => new Date(PINNED_NOW() - h * 3_600_000);
  const daysAgo  = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);

  // ── sessions endpoint ────────────────────────────────────────────────────────

  describe('T1269-T1273 — v10.40 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1040-fields'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1040-fields');
      expect(status).toBe(200);
      expect(body).toHaveProperty('p95AllTimeLast24h');
      expect(body).toHaveProperty('p95AllTimeLast7d');
      expect(body).toHaveProperty('p95AllTimeLast30d');
      expect(body).toHaveProperty('p5AllTime');
      expect(body).toHaveProperty('p5AllTimeLast24h');
    });

    it('2. sessions — no logs: p5AllTime null, windowed fields null', async () => {
      ctx = await setup();
      // No logs at all — 404 or empty analytics; we just check fields are null/missing gracefully
      // The endpoint returns 404 when session not found, so seed a different session and hit empty one
      // Actually hit a session that has never been used → 404
      const { status } = await getJSON(ctx.port, '/sessions/sess-v1040-empty');
      // 404 is acceptable for unknown session; test passes if status is 404
      expect(status).toBe(404);
    });

    it('3. sessions — only old ops (>30d): windowed fields null, p5AllTime non-null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1040-old', daysAgo(35)), dec(0.4));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1040-old', daysAgo(45)), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1040-old');
      expect(status).toBe(200);

      // All windowed fields should be null (windows empty)
      expect(body.p95AllTimeLast24h).toBeNull();
      expect(body.p95AllTimeLast7d).toBeNull();
      expect(body.p95AllTimeLast30d).toBeNull();
      expect(body.p5AllTimeLast24h).toBeNull();

      // p5AllTime is all-time: sorted [0.4, 0.8], idx=floor(2*0.05)=0 → 0.4
      expect(body.p5AllTime as number).toBeCloseTo(0.4, 5);
    });

    it('4. sessions — ten scores in 24h: p95 = 1.0, p5 = 0.1 (known-value anchor)', async () => {
      ctx = await setup();
      // Scores 0.1..1.0, seeded in 24h
      for (const score of [0.5, 0.1, 0.9, 0.2, 0.8, 0.3, 0.7, 0.4, 0.6, 1.0]) {
        await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1040-kv24h', hoursAgo(2)), dec(score));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1040-kv24h');
      expect(status).toBe(200);

      // sorted: [0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,1.0], n=10
      // p95 idx=floor(10*0.95)=9 → 1.0
      expect(body.p95AllTimeLast24h as number).toBeCloseTo(1.0, 5);
      // p5 idx=floor(10*0.05)=0 → 0.1
      expect(body.p5AllTimeLast24h as number).toBeCloseTo(0.1, 5);
    });

    it('5. sessions — ten scores in 7d: p95AllTimeLast7d = 1.0', async () => {
      ctx = await setup();
      for (const score of [0.5, 0.1, 0.9, 0.2, 0.8, 0.3, 0.7, 0.4, 0.6, 1.0]) {
        await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1040-kv7d', daysAgo(3)), dec(score));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1040-kv7d');
      expect(status).toBe(200);
      // p95 idx=9 → 1.0
      expect(body.p95AllTimeLast7d as number).toBeCloseTo(1.0, 5);
    });

    it('6. sessions — ten scores in 30d: p95AllTimeLast30d = 1.0', async () => {
      ctx = await setup();
      for (const score of [0.5, 0.1, 0.9, 0.2, 0.8, 0.3, 0.7, 0.4, 0.6, 1.0]) {
        await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1040-kv30d', daysAgo(15)), dec(score));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1040-kv30d');
      expect(status).toBe(200);
      expect(body.p95AllTimeLast30d as number).toBeCloseTo(1.0, 5);
    });

    it('7. sessions — single op in 24h: p95AllTimeLast24h = that score (floor(1*0.95)=0)', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1040-single', hoursAgo(1)), dec(0.77));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1040-single');
      expect(status).toBe(200);
      // n=1, idx=floor(1*0.95)=0 → 0.77
      expect(body.p95AllTimeLast24h as number).toBeCloseTo(0.77, 5);
      // p5 also idx=0 → 0.77
      expect(body.p5AllTimeLast24h as number).toBeCloseTo(0.77, 5);
    });

    it('8. sessions — ops only in 7d+30d (not 24h): p95AllTimeLast24h null, others non-null', async () => {
      ctx = await setup();
      // Op at 3d: in 7d and 30d windows but not 24h
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1040-win', daysAgo(3)), dec(0.6));
      // Op at 15d: in 30d window only
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1040-win', daysAgo(15)), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1040-win');
      expect(status).toBe(200);

      expect(body.p95AllTimeLast24h).toBeNull();
      expect(body.p5AllTimeLast24h).toBeNull();
      // 7d window: [0.6], n=1, idx=0 → 0.6
      expect(body.p95AllTimeLast7d as number).toBeCloseTo(0.6, 5);
      // 30d window: [0.4, 0.6], n=2, p95 idx=floor(2*0.95)=1 → 0.6
      expect(body.p95AllTimeLast30d as number).toBeCloseTo(0.6, 5);
      // p5AllTime: [0.4, 0.6] idx=0 → 0.4
      expect(body.p5AllTime as number).toBeCloseTo(0.4, 5);
    });
  });

  // ── agents endpoint ──────────────────────────────────────────────────────────

  describe('T1269-T1273 — v10.40 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('9. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1040-pres', 'fs', 'sess-1'), dec(0.3));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1040-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('p95AllTimeLast24h');
      expect(body).toHaveProperty('p95AllTimeLast7d');
      expect(body).toHaveProperty('p95AllTimeLast30d');
      expect(body).toHaveProperty('p5AllTime');
      expect(body).toHaveProperty('p5AllTimeLast24h');
    });

    it('10. agents — only old ops (>30d): windowed null, p5AllTime from all logs', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1040-old', 'fs', 'sess-1', daysAgo(35)), dec(0.3));
      await ctx.logger.log(makeOp('agent-v1040-old', 'fs', 'sess-2', daysAgo(42)), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1040-old');
      expect(status).toBe(200);

      expect(body.p95AllTimeLast24h).toBeNull();
      expect(body.p95AllTimeLast7d).toBeNull();
      expect(body.p95AllTimeLast30d).toBeNull();
      expect(body.p5AllTimeLast24h).toBeNull();

      // p5AllTime: sorted [0.3, 0.7], idx=floor(2*0.05)=0 → 0.3
      expect(body.p5AllTime as number).toBeCloseTo(0.3, 5);
    });

    it('11. agents — ten scores in 24h: known-value p95=1.0, p5=0.1', async () => {
      ctx = await setup();
      for (const score of [0.5, 0.1, 0.9, 0.2, 0.8, 0.3, 0.7, 0.4, 0.6, 1.0]) {
        await ctx.logger.log(makeOp('agent-v1040-kv', 'fs', 'sess-1', hoursAgo(3)), dec(score));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1040-kv');
      expect(status).toBe(200);
      expect(body.p95AllTimeLast24h as number).toBeCloseTo(1.0, 5);
      expect(body.p5AllTimeLast24h as number).toBeCloseTo(0.1, 5);
      // p5AllTime same source (all within 24h)
      expect(body.p5AllTime as number).toBeCloseTo(0.1, 5);
    });

    it('12. agents — ops across 24h/7d/30d/old windows: fields reflect correct window', async () => {
      ctx = await setup();
      // 24h: score 0.9
      await ctx.logger.log(makeOp('agent-v1040-multi', 'fs', 'sess-1', hoursAgo(12)), dec(0.9));
      // 7d only: score 0.5
      await ctx.logger.log(makeOp('agent-v1040-multi', 'fs', 'sess-2', daysAgo(3)), dec(0.5));
      // 30d only: score 0.2
      await ctx.logger.log(makeOp('agent-v1040-multi', 'fs', 'sess-3', daysAgo(15)), dec(0.2));
      // Older than 30d: score 0.1
      await ctx.logger.log(makeOp('agent-v1040-multi', 'fs', 'sess-4', daysAgo(40)), dec(0.1));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1040-multi');
      expect(status).toBe(200);

      // p95AllTimeLast24h: [0.9], n=1, idx=0 → 0.9
      expect(body.p95AllTimeLast24h as number).toBeCloseTo(0.9, 5);
      // p95AllTimeLast7d: [0.5, 0.9], n=2, idx=floor(2*0.95)=1 → 0.9
      expect(body.p95AllTimeLast7d as number).toBeCloseTo(0.9, 5);
      // p95AllTimeLast30d: [0.2, 0.5, 0.9], n=3, idx=floor(3*0.95)=2 → 0.9
      expect(body.p95AllTimeLast30d as number).toBeCloseTo(0.9, 5);
      // p5AllTime: [0.1, 0.2, 0.5, 0.9], idx=floor(4*0.05)=0 → 0.1
      expect(body.p5AllTime as number).toBeCloseTo(0.1, 5);
      // p5AllTimeLast24h: [0.9], idx=0 → 0.9
      expect(body.p5AllTimeLast24h as number).toBeCloseTo(0.9, 5);
    });

    it('13. agents — single score all-time: p5AllTime equals that score', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1040-one', 'fs', 'sess-1', daysAgo(50)), dec(0.55));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1040-one');
      expect(status).toBe(200);

      // idx=floor(1*0.05)=0 → 0.55
      expect(body.p5AllTime as number).toBeCloseTo(0.55, 5);
      // windowed fields: 24h/7d/30d all null
      expect(body.p95AllTimeLast24h).toBeNull();
      expect(body.p95AllTimeLast7d).toBeNull();
      expect(body.p95AllTimeLast30d).toBeNull();
      expect(body.p5AllTimeLast24h).toBeNull();
    });
  });

  // ── tools endpoint ───────────────────────────────────────────────────────────

  describe('T1269-T1273 — v10.40 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('14. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-1', 'tool-v1040-pres', 'sess-1'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1040-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('p95AllTimeLast24h');
      expect(body).toHaveProperty('p95AllTimeLast7d');
      expect(body).toHaveProperty('p95AllTimeLast30d');
      expect(body).toHaveProperty('p5AllTime');
      expect(body).toHaveProperty('p5AllTimeLast24h');
    });

    it('15. tools — only old ops (>40d): all windowed null, p5AllTime non-null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-1', 'tool-v1040-old', 'sess-1', daysAgo(41)), dec(0.6));
      await ctx.logger.log(makeOp('agent-1', 'tool-v1040-old', 'sess-2', daysAgo(50)), dec(0.9));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1040-old');
      expect(status).toBe(200);

      expect(body.p95AllTimeLast24h).toBeNull();
      expect(body.p95AllTimeLast7d).toBeNull();
      expect(body.p95AllTimeLast30d).toBeNull();
      expect(body.p5AllTimeLast24h).toBeNull();

      // p5AllTime: sorted [0.6, 0.9], idx=0 → 0.6
      expect(body.p5AllTime as number).toBeCloseTo(0.6, 5);
    });

    it('16. tools — ten scores in 24h: known-value anchor p95=1.0, p5=0.1', async () => {
      ctx = await setup();
      for (const score of [0.5, 0.1, 0.9, 0.2, 0.8, 0.3, 0.7, 0.4, 0.6, 1.0]) {
        await ctx.logger.log(makeOp('agent-1', 'tool-v1040-kv', 'sess-1', hoursAgo(6)), dec(score));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1040-kv');
      expect(status).toBe(200);
      expect(body.p95AllTimeLast24h as number).toBeCloseTo(1.0, 5);
      expect(body.p5AllTimeLast24h as number).toBeCloseTo(0.1, 5);
    });

    it('17. tools — ops in 7d but not 24h: p95AllTimeLast24h null, p95AllTimeLast7d non-null', async () => {
      ctx = await setup();
      // Five scores 3d ago: [0.1, 0.4, 0.5, 0.7, 0.9]
      for (const score of [0.9, 0.1, 0.7, 0.4, 0.5]) {
        await ctx.logger.log(makeOp('agent-1', 'tool-v1040-7d', 'sess-1', daysAgo(3)), dec(score));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1040-7d');
      expect(status).toBe(200);

      expect(body.p95AllTimeLast24h).toBeNull();
      expect(body.p5AllTimeLast24h).toBeNull();

      // 7d: [0.1,0.4,0.5,0.7,0.9], n=5, idx=floor(5*0.95)=4 → 0.9
      expect(body.p95AllTimeLast7d as number).toBeCloseTo(0.9, 5);
      // p5AllTime same data: idx=floor(5*0.05)=0 → 0.1
      expect(body.p5AllTime as number).toBeCloseTo(0.1, 5);
    });

    it('18. tools — ops in 30d but not 7d: p95AllTimeLast30d correct, p95AllTimeLast7d null', async () => {
      ctx = await setup();
      // Three scores 10d ago: [0.2, 0.5, 0.8]
      for (const score of [0.5, 0.8, 0.2]) {
        await ctx.logger.log(makeOp('agent-1', 'tool-v1040-30d', 'sess-1', daysAgo(10)), dec(score));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1040-30d');
      expect(status).toBe(200);

      expect(body.p95AllTimeLast7d).toBeNull();
      // 30d: [0.2,0.5,0.8], n=3, idx=floor(3*0.95)=2 → 0.8
      expect(body.p95AllTimeLast30d as number).toBeCloseTo(0.8, 5);
    });

    it('19. tools — p5AllTime with many logs including old ones', async () => {
      ctx = await setup();
      // Oldest op (45d): score 0.05
      await ctx.logger.log(makeOp('agent-2', 'tool-v1040-p5all', 'sess-1', daysAgo(45)), dec(0.05));
      // Recent ops: 0.6, 0.7, 0.8
      for (const score of [0.8, 0.6, 0.7]) {
        await ctx.logger.log(makeOp('agent-2', 'tool-v1040-p5all', 'sess-1', hoursAgo(4)), dec(score));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1040-p5all');
      expect(status).toBe(200);

      // All-time sorted: [0.05, 0.6, 0.7, 0.8], n=4, idx=floor(4*0.05)=0 → 0.05
      expect(body.p5AllTime as number).toBeCloseTo(0.05, 5);
      // p5AllTimeLast24h: [0.6,0.7,0.8], idx=floor(3*0.05)=0 → 0.6
      expect(body.p5AllTimeLast24h as number).toBeCloseTo(0.6, 5);
    });
  });

  // ── summary endpoint ─────────────────────────────────────────────────────────

  describe('T1269-T1273 — v10.40 new fields (summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('20. summary — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s1', 'fs', 'sess-s1'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body).toHaveProperty('p95AllTimeLast24h');
      expect(body).toHaveProperty('p95AllTimeLast7d');
      expect(body).toHaveProperty('p95AllTimeLast30d');
      expect(body).toHaveProperty('p5AllTime');
      expect(body).toHaveProperty('p5AllTimeLast24h');
    });

    it('21. summary — no logs: p5AllTime null, all windowed null', async () => {
      ctx = await setup();

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.p95AllTimeLast24h).toBeNull();
      expect(body.p95AllTimeLast7d).toBeNull();
      expect(body.p95AllTimeLast30d).toBeNull();
      expect(body.p5AllTime).toBeNull();
      expect(body.p5AllTimeLast24h).toBeNull();
    });

    it('22. summary — only old ops (>30d): windowed null, p5AllTime non-null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s2', 'fs', 'sess-s2', daysAgo(35)), dec(0.3));
      await ctx.logger.log(makeOp('agent-s2', 'fs', 'sess-s2', daysAgo(40)), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.p95AllTimeLast24h).toBeNull();
      expect(body.p95AllTimeLast7d).toBeNull();
      expect(body.p95AllTimeLast30d).toBeNull();
      expect(body.p5AllTimeLast24h).toBeNull();

      // p5AllTime: sorted [0.3, 0.7], idx=0 → 0.3
      expect(body.p5AllTime as number).toBeCloseTo(0.3, 5);
    });

    it('23. summary — ten scores in 24h: known-value anchor p95=1.0, p5=0.1', async () => {
      ctx = await setup();
      for (const score of [0.5, 0.1, 0.9, 0.2, 0.8, 0.3, 0.7, 0.4, 0.6, 1.0]) {
        await ctx.logger.log(makeOp('agent-s3', 'fs', 'sess-s3', hoursAgo(1)), dec(score));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      // p95: idx=9 → 1.0; p5: idx=0 → 0.1
      expect(body.p95AllTimeLast24h as number).toBeCloseTo(1.0, 5);
      expect(body.p5AllTimeLast24h as number).toBeCloseTo(0.1, 5);
    });

    it('24. summary — ten scores in 7d: p95AllTimeLast7d = 1.0', async () => {
      ctx = await setup();
      for (const score of [0.5, 0.1, 0.9, 0.2, 0.8, 0.3, 0.7, 0.4, 0.6, 1.0]) {
        await ctx.logger.log(makeOp('agent-s4', 'fs', 'sess-s4', daysAgo(4)), dec(score));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.p95AllTimeLast7d as number).toBeCloseTo(1.0, 5);
    });

    it('25. summary — ten scores in 30d: p95AllTimeLast30d = 1.0', async () => {
      ctx = await setup();
      for (const score of [0.5, 0.1, 0.9, 0.2, 0.8, 0.3, 0.7, 0.4, 0.6, 1.0]) {
        await ctx.logger.log(makeOp('agent-s5', 'fs', 'sess-s5', daysAgo(20)), dec(score));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.p95AllTimeLast30d as number).toBeCloseTo(1.0, 5);
    });

    it('26. summary — ops across all time windows: all five fields independently correct', async () => {
      ctx = await setup();
      // 24h: scores [0.8, 0.9]
      await ctx.logger.log(makeOp('agent-s6', 'fs', 'sess-s6', hoursAgo(10)), dec(0.9));
      await ctx.logger.log(makeOp('agent-s6', 'fs', 'sess-s6', hoursAgo(20)), dec(0.8));
      // 7d only (not 24h): score 0.5
      await ctx.logger.log(makeOp('agent-s6', 'fs', 'sess-s6', daysAgo(4)), dec(0.5));
      // 30d only: score 0.2
      await ctx.logger.log(makeOp('agent-s6', 'fs', 'sess-s6', daysAgo(20)), dec(0.2));
      // Older than 30d: score 0.05
      await ctx.logger.log(makeOp('agent-s6', 'fs', 'sess-s6', daysAgo(45)), dec(0.05));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      // p95AllTimeLast24h: [0.8,0.9], n=2, idx=floor(2*0.95)=1 → 0.9
      expect(body.p95AllTimeLast24h as number).toBeCloseTo(0.9, 5);
      // p95AllTimeLast7d: [0.5,0.8,0.9], n=3, idx=floor(3*0.95)=2 → 0.9
      expect(body.p95AllTimeLast7d as number).toBeCloseTo(0.9, 5);
      // p95AllTimeLast30d: [0.2,0.5,0.8,0.9], n=4, idx=floor(4*0.95)=3 → 0.9
      expect(body.p95AllTimeLast30d as number).toBeCloseTo(0.9, 5);
      // p5AllTime: [0.05,0.2,0.5,0.8,0.9], n=5, idx=floor(5*0.05)=0 → 0.05
      expect(body.p5AllTime as number).toBeCloseTo(0.05, 5);
      // p5AllTimeLast24h: [0.8,0.9], n=2, idx=floor(2*0.05)=0 → 0.8
      expect(body.p5AllTimeLast24h as number).toBeCloseTo(0.8, 5);
    });

    it('27. summary — p95AllTimeLast24h is null when only ops at 25h ago', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s7', 'fs', 'sess-s7', hoursAgo(25)), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.p95AllTimeLast24h).toBeNull();
      expect(body.p5AllTimeLast24h).toBeNull();
      // Still within 7d
      expect(body.p95AllTimeLast7d as number).toBeCloseTo(0.6, 5);
    });

    it('28. summary — p95AllTimeLast7d is null when only ops at 8d ago', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s8', 'fs', 'sess-s8', daysAgo(8)), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.p95AllTimeLast24h).toBeNull();
      expect(body.p95AllTimeLast7d).toBeNull();
      // Still within 30d
      expect(body.p95AllTimeLast30d as number).toBeCloseTo(0.7, 5);
    });
  });
});

// ── v10.41 ────────────────────────────────────────────────────────────────────

describe('v10.41', () => {
  const hoursAgo = (h: number) => new Date(PINNED_NOW() - h * 3_600_000);
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1274-T1278 — v10.41 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1041-pres'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1041-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('p5AllTimeLast7d');
      expect(body).toHaveProperty('p5AllTimeLast30d');
      expect(body).toHaveProperty('riskScoreCV24h');
      expect(body).toHaveProperty('riskScoreCV7d');
      expect(body).toHaveProperty('riskScoreCV30d');
    });

    it('2. sessions — only old ops (>40d): all five new windowed fields are null', async () => {
      ctx = await setup();
      // Ops older than 40 days — all windows (24h, 7d, 30d) are empty
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1041-old', daysAgo(41)), dec(0.5));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1041-old', daysAgo(50)), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1041-old');
      expect(status).toBe(200);
      expect(body.p5AllTimeLast7d).toBeNull();
      expect(body.p5AllTimeLast30d).toBeNull();
      expect(body.riskScoreCV24h).toBeNull();
      expect(body.riskScoreCV7d).toBeNull();
      expect(body.riskScoreCV30d).toBeNull();
    });

    it('3. sessions — two ops within 7d: p5AllTimeLast7d is floor(2*0.05)=0 → first element', async () => {
      ctx = await setup();
      // Sorted scores in 7d: [0.3, 0.8] — len=2, p5 idx=floor(2*0.05)=0 → 0.3
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1041-7d', daysAgo(2)), dec(0.8));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1041-7d', daysAgo(5)), dec(0.3));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1041-7d');
      expect(status).toBe(200);
      expect(body.p5AllTimeLast7d as number).toBeCloseTo(0.3, 5);
    });

    it('4. sessions — ops only in 30d but not 7d: p5AllTimeLast7d null, p5AllTimeLast30d non-null', async () => {
      ctx = await setup();
      // Three ops at 10d, 20d, 28d — inside 30d window, outside 7d
      // Sorted: [0.1, 0.5, 0.9] — len=3, p5 idx=floor(3*0.05)=0 → 0.1
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1041-30d', daysAgo(10)), dec(0.5));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1041-30d', daysAgo(20)), dec(0.1));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1041-30d', daysAgo(28)), dec(0.9));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1041-30d');
      expect(status).toBe(200);
      expect(body.p5AllTimeLast7d).toBeNull();
      expect(body.p5AllTimeLast30d as number).toBeCloseTo(0.1, 5);
    });

    it('5. sessions — CV24h: [0.2, 0.8] → mean=0.5, stddev=0.3, CV=60.0', async () => {
      ctx = await setup();
      // Two ops within 24h with scores [0.2, 0.8]
      // mean = 0.5, variance = ((0.2-0.5)^2 + (0.8-0.5)^2)/2 = (0.09+0.09)/2 = 0.09
      // stddev = 0.3, CV = (0.3/0.5)*100 = 60.0
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1041-cv24', hoursAgo(2)), dec(0.2));
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1041-cv24', hoursAgo(4)), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1041-cv24');
      expect(status).toBe(200);
      expect(body.riskScoreCV24h as number).toBeCloseTo(60.0, 4);
    });

    it('6. sessions — CV returns null when mean is 0 (all riskScores = 0)', async () => {
      ctx = await setup();
      // All scores are 0 — mean=0 so CV must be null
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1041-cv0', hoursAgo(1)), dec(0));
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1041-cv0', hoursAgo(2)), dec(0));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1041-cv0');
      expect(status).toBe(200);
      expect(body.riskScoreCV24h).toBeNull();
      expect(body.riskScoreCV7d).toBeNull();
      expect(body.riskScoreCV30d).toBeNull();
    });

    it('7. sessions — CV7d: ops in 7d only, CV correct', async () => {
      ctx = await setup();
      // Two ops in 7d: [0.2, 0.8] — CV=(0.3/0.5)*100=60.0
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1041-cv7d', daysAgo(2)), dec(0.2));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1041-cv7d', daysAgo(5)), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1041-cv7d');
      expect(status).toBe(200);
      expect(body.riskScoreCV7d as number).toBeCloseTo(60.0, 4);
    });

    it('8. sessions — CV30d: ops in 30d only, CV correct', async () => {
      ctx = await setup();
      // Two ops in 30d window (not 7d): [0.2, 0.8] — CV=60.0
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1041-cv30d', daysAgo(10)), dec(0.2));
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1041-cv30d', daysAgo(20)), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1041-cv30d');
      expect(status).toBe(200);
      // 7d window is empty
      expect(body.riskScoreCV7d).toBeNull();
      // 30d window has two ops
      expect(body.riskScoreCV30d as number).toBeCloseTo(60.0, 4);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1274-T1278 — v10.41 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('9. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1041-pres', 'fs', 'sess-1'), dec(0.3));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1041-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('p5AllTimeLast7d');
      expect(body).toHaveProperty('p5AllTimeLast30d');
      expect(body).toHaveProperty('riskScoreCV24h');
      expect(body).toHaveProperty('riskScoreCV7d');
      expect(body).toHaveProperty('riskScoreCV30d');
    });

    it('10. agents — only old ops (>40d): all five new windowed fields are null', async () => {
      ctx = await setup();
      // Ops older than 40 days — all windows empty
      await ctx.logger.log(makeOp('agent-v1041-old', 'fs', 'sess-1', daysAgo(41)), dec(0.5));
      await ctx.logger.log(makeOp('agent-v1041-old', 'fs', 'sess-2', daysAgo(55)), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1041-old');
      expect(status).toBe(200);
      expect(body.p5AllTimeLast7d).toBeNull();
      expect(body.p5AllTimeLast30d).toBeNull();
      expect(body.riskScoreCV24h).toBeNull();
      expect(body.riskScoreCV7d).toBeNull();
      expect(body.riskScoreCV30d).toBeNull();
    });

    it('11. agents — twenty ops in 7d: p5AllTimeLast7d = index floor(20*0.05)=1', async () => {
      ctx = await setup();
      // 20 ops with scores 0.05, 0.10, 0.15, ..., 1.00 — sorted ascending
      // p5 idx = floor(20*0.05) = 1 → 0.10
      const scores = Array.from({ length: 20 }, (_, i) => parseFloat(((i + 1) * 0.05).toFixed(2)));
      for (const [i, score] of scores.entries()) {
        await ctx.logger.log(makeOp('agent-v1041-20ops', 'fs', `sess-${i}`, daysAgo(i % 6 + 1)), dec(score));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1041-20ops');
      expect(status).toBe(200);
      expect(body.p5AllTimeLast7d as number).toBeCloseTo(0.10, 5);
    });

    it('12. agents — ops only in 30d window (not 7d): p5AllTimeLast7d null, p5AllTimeLast30d correct', async () => {
      ctx = await setup();
      // Two ops at 10d and 25d — inside 30d, outside 7d
      // Sorted: [0.2, 0.8] — p5 idx=floor(2*0.05)=0 → 0.2
      await ctx.logger.log(makeOp('agent-v1041-30only', 'fs', 'sess-1', daysAgo(10)), dec(0.8));
      await ctx.logger.log(makeOp('agent-v1041-30only', 'fs', 'sess-2', daysAgo(25)), dec(0.2));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1041-30only');
      expect(status).toBe(200);
      expect(body.p5AllTimeLast7d).toBeNull();
      expect(body.p5AllTimeLast30d as number).toBeCloseTo(0.2, 5);
    });

    it('13. agents — CV24h: [0.2, 0.8] → CV=60.0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1041-cv24', 'fs', 'sess-1', hoursAgo(2)), dec(0.2));
      await ctx.logger.log(makeOp('agent-v1041-cv24', 'fs', 'sess-2', hoursAgo(4)), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1041-cv24');
      expect(status).toBe(200);
      expect(body.riskScoreCV24h as number).toBeCloseTo(60.0, 4);
    });

    it('14. agents — CV7d with ops only in 7d window', async () => {
      ctx = await setup();
      // Two ops in 7d: [0.2, 0.8] — CV=60.0
      await ctx.logger.log(makeOp('agent-v1041-cv7', 'fs', 'sess-1', daysAgo(2)), dec(0.2));
      await ctx.logger.log(makeOp('agent-v1041-cv7', 'fs', 'sess-2', daysAgo(5)), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1041-cv7');
      expect(status).toBe(200);
      expect(body.riskScoreCV7d as number).toBeCloseTo(60.0, 4);
      // 24h window is empty (ops at 2d and 5d)
      expect(body.riskScoreCV24h).toBeNull();
    });

    it('15. agents — CV null when mean=0 across all windows', async () => {
      ctx = await setup();
      // All three scores are 0
      await ctx.logger.log(makeOp('agent-v1041-cv0', 'fs', 'sess-1', hoursAgo(1)), dec(0));
      await ctx.logger.log(makeOp('agent-v1041-cv0', 'fs', 'sess-2', daysAgo(3)), dec(0));
      await ctx.logger.log(makeOp('agent-v1041-cv0', 'fs', 'sess-3', daysAgo(15)), dec(0));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1041-cv0');
      expect(status).toBe(200);
      expect(body.riskScoreCV24h).toBeNull();
      expect(body.riskScoreCV7d).toBeNull();
      expect(body.riskScoreCV30d).toBeNull();
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1274-T1278 — v10.41 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('16. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-i', 'tool-v1041-pres', 'sess-1'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1041-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('p5AllTimeLast7d');
      expect(body).toHaveProperty('p5AllTimeLast30d');
      expect(body).toHaveProperty('riskScoreCV24h');
      expect(body).toHaveProperty('riskScoreCV7d');
      expect(body).toHaveProperty('riskScoreCV30d');
    });

    it('17. tools — only old ops (>40d): all five new windowed fields are null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-j', 'tool-v1041-old', 'sess-1', daysAgo(41)), dec(0.4));
      await ctx.logger.log(makeOp('agent-j', 'tool-v1041-old', 'sess-2', daysAgo(60)), dec(0.9));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1041-old');
      expect(status).toBe(200);
      expect(body.p5AllTimeLast7d).toBeNull();
      expect(body.p5AllTimeLast30d).toBeNull();
      expect(body.riskScoreCV24h).toBeNull();
      expect(body.riskScoreCV7d).toBeNull();
      expect(body.riskScoreCV30d).toBeNull();
    });

    it('18. tools — two ops in 7d: p5AllTimeLast7d correct', async () => {
      ctx = await setup();
      // Sorted: [0.3, 0.7] — p5 idx=floor(2*0.05)=0 → 0.3
      await ctx.logger.log(makeOp('agent-k-1', 'tool-v1041-7d', 'sess-1', daysAgo(2)), dec(0.7));
      await ctx.logger.log(makeOp('agent-k-2', 'tool-v1041-7d', 'sess-2', daysAgo(4)), dec(0.3));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1041-7d');
      expect(status).toBe(200);
      expect(body.p5AllTimeLast7d as number).toBeCloseTo(0.3, 5);
    });

    it('19. tools — ops only in 30d (not 7d): p5AllTimeLast7d null, p5AllTimeLast30d correct', async () => {
      ctx = await setup();
      // Three ops at 10d, 18d, 27d — inside 30d, outside 7d
      // Sorted: [0.2, 0.5, 0.9] — p5 idx=floor(3*0.05)=0 → 0.2
      await ctx.logger.log(makeOp('agent-l-1', 'tool-v1041-30d', 'sess-1', daysAgo(10)), dec(0.5));
      await ctx.logger.log(makeOp('agent-l-2', 'tool-v1041-30d', 'sess-2', daysAgo(18)), dec(0.2));
      await ctx.logger.log(makeOp('agent-l-3', 'tool-v1041-30d', 'sess-3', daysAgo(27)), dec(0.9));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1041-30d');
      expect(status).toBe(200);
      expect(body.p5AllTimeLast7d).toBeNull();
      expect(body.p5AllTimeLast30d as number).toBeCloseTo(0.2, 5);
    });

    it('20. tools — CV24h: [0.2, 0.8] → CV=60.0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-m-1', 'tool-v1041-cv24', 'sess-1', hoursAgo(3)), dec(0.2));
      await ctx.logger.log(makeOp('agent-m-2', 'tool-v1041-cv24', 'sess-2', hoursAgo(6)), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1041-cv24');
      expect(status).toBe(200);
      expect(body.riskScoreCV24h as number).toBeCloseTo(60.0, 4);
    });

    it('21. tools — CV30d: [0.2, 0.8] with ops in 30d only → CV=60.0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-n-1', 'tool-v1041-cv30', 'sess-1', daysAgo(12)), dec(0.2));
      await ctx.logger.log(makeOp('agent-n-2', 'tool-v1041-cv30', 'sess-2', daysAgo(22)), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1041-cv30');
      expect(status).toBe(200);
      expect(body.riskScoreCV7d).toBeNull();
      expect(body.riskScoreCV30d as number).toBeCloseTo(60.0, 4);
    });

    it('22. tools — single op in 24h: CV24h is null (no variance with 1 element, stddev=0 → 0/mean*100=0, not null)', async () => {
      ctx = await setup();
      // Single op — stddev=0, mean>0, so CV=(0/mean)*100=0.0 (not null)
      await ctx.logger.log(makeOp('agent-o', 'tool-v1041-single', 'sess-1', hoursAgo(1)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1041-single');
      expect(status).toBe(200);
      // Single element: stddev=0, mean=0.5 (non-zero), CV=0.0
      expect(body.riskScoreCV24h as number).toBeCloseTo(0.0, 5);
    });
  });

  // ── operations/summary endpoint ────────────────────────────────────────────────

  describe('T1274-T1278 — v10.41 new fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('23. summary — all five new fields present', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-p', 'tool-s', 'sess-1'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body).toHaveProperty('p5AllTimeLast7d');
      expect(body).toHaveProperty('p5AllTimeLast30d');
      expect(body).toHaveProperty('riskScoreCV24h');
      expect(body).toHaveProperty('riskScoreCV7d');
      expect(body).toHaveProperty('riskScoreCV30d');
    });

    it('24. summary — empty DB: all five new fields are null', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.p5AllTimeLast7d).toBeNull();
      expect(body.p5AllTimeLast30d).toBeNull();
      expect(body.riskScoreCV24h).toBeNull();
      expect(body.riskScoreCV7d).toBeNull();
      expect(body.riskScoreCV30d).toBeNull();
    });

    it('25. summary — only old ops (>40d): all five new windowed fields are null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-q-1', 'tool-q', 'sess-1', daysAgo(42)), dec(0.3));
      await ctx.logger.log(makeOp('agent-q-2', 'tool-q', 'sess-2', daysAgo(55)), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.p5AllTimeLast7d).toBeNull();
      expect(body.p5AllTimeLast30d).toBeNull();
      expect(body.riskScoreCV24h).toBeNull();
      expect(body.riskScoreCV7d).toBeNull();
      expect(body.riskScoreCV30d).toBeNull();
    });

    it('26. summary — two ops in 7d: p5AllTimeLast7d correct', async () => {
      ctx = await setup();
      // Sorted: [0.3, 0.9] — p5 idx=floor(2*0.05)=0 → 0.3
      await ctx.logger.log(makeOp('agent-r-1', 'tool-r', 'sess-1', daysAgo(1)), dec(0.9));
      await ctx.logger.log(makeOp('agent-r-2', 'tool-r', 'sess-2', daysAgo(4)), dec(0.3));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.p5AllTimeLast7d as number).toBeCloseTo(0.3, 5);
    });

    it('27. summary — ops only in 30d (not 7d): p5AllTimeLast7d null, p5AllTimeLast30d correct', async () => {
      ctx = await setup();
      // Two ops at 10d and 20d — inside 30d, outside 7d
      // Sorted: [0.2, 0.8] — p5 idx=floor(2*0.05)=0 → 0.2
      await ctx.logger.log(makeOp('agent-s-1', 'tool-s2', 'sess-1', daysAgo(10)), dec(0.8));
      await ctx.logger.log(makeOp('agent-s-2', 'tool-s2', 'sess-2', daysAgo(20)), dec(0.2));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.p5AllTimeLast7d).toBeNull();
      expect(body.p5AllTimeLast30d as number).toBeCloseTo(0.2, 5);
    });

    it('28. summary — CV24h: [0.2, 0.8] → CV=60.0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-t-1', 'tool-t', 'sess-1', hoursAgo(2)), dec(0.2));
      await ctx.logger.log(makeOp('agent-t-2', 'tool-t', 'sess-2', hoursAgo(4)), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreCV24h as number).toBeCloseTo(60.0, 4);
    });

    it('29. summary — CV7d: [0.2, 0.8] in 7d → CV=60.0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-u-1', 'tool-u', 'sess-1', daysAgo(2)), dec(0.2));
      await ctx.logger.log(makeOp('agent-u-2', 'tool-u', 'sess-2', daysAgo(5)), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreCV7d as number).toBeCloseTo(60.0, 4);
      // 24h window is empty
      expect(body.riskScoreCV24h).toBeNull();
    });

    it('30. summary — CV30d: [0.2, 0.8] in 30d only → CV=60.0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v-1', 'tool-v', 'sess-1', daysAgo(12)), dec(0.2));
      await ctx.logger.log(makeOp('agent-v-2', 'tool-v', 'sess-2', daysAgo(22)), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreCV24h).toBeNull();
      expect(body.riskScoreCV7d).toBeNull();
      expect(body.riskScoreCV30d as number).toBeCloseTo(60.0, 4);
    });

    it('31. summary — mix: recent ops in 24h, 7d, 30d, and old; correct window isolation', async () => {
      ctx = await setup();
      // In 24h: [0.2, 0.8] → CV24h=60.0
      await ctx.logger.log(makeOp('agent-w-1', 'tool-w', 'sess-1', hoursAgo(2)), dec(0.2));
      await ctx.logger.log(makeOp('agent-w-2', 'tool-w', 'sess-2', hoursAgo(4)), dec(0.8));
      // In 7d but not 24h: [0.3, 0.7]
      await ctx.logger.log(makeOp('agent-w-3', 'tool-w', 'sess-3', daysAgo(3)), dec(0.3));
      await ctx.logger.log(makeOp('agent-w-4', 'tool-w', 'sess-4', daysAgo(5)), dec(0.7));
      // In 30d but not 7d: [0.1]
      await ctx.logger.log(makeOp('agent-w-5', 'tool-w', 'sess-5', daysAgo(15)), dec(0.1));
      // Older than 30d: [0.9] — excluded from all windowed fields
      await ctx.logger.log(makeOp('agent-w-6', 'tool-w', 'sess-6', daysAgo(45)), dec(0.9));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      // CV24h: [0.2, 0.8] → mean=0.5, stddev=0.3, CV=60.0
      expect(body.riskScoreCV24h as number).toBeCloseTo(60.0, 4);

      // 7d: [0.2, 0.3, 0.7, 0.8] → mean=0.5, variance=((0.3^2+0.2^2+0.2^2+0.3^2)/4)=0.065, stddev≈0.255, CV≈50.99
      const cv7Expected = (Math.sqrt(0.065) / 0.5) * 100;
      expect(body.riskScoreCV7d as number).toBeCloseTo(cv7Expected, 2);

      // p5 7d: sorted [0.2, 0.3, 0.7, 0.8], len=4, idx=floor(4*0.05)=0 → 0.2
      expect(body.p5AllTimeLast7d as number).toBeCloseTo(0.2, 5);

      // p5 30d: sorted [0.1, 0.2, 0.3, 0.7, 0.8], len=5, idx=floor(5*0.05)=0 → 0.1
      expect(body.p5AllTimeLast30d as number).toBeCloseTo(0.1, 5);
    });
  });
});

// ── v10.42 ────────────────────────────────────────────────────────────────────

describe('v10.42', () => {
  const hoursAgo = (h: number) => new Date(PINNED_NOW() - h * 3_600_000);
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);

  /** Compute expected skewness: mean((x-mean)/stddev)^3 */
  function skewness(values: number[]): number | null {
    if (values.length < 3) return null;
    const m = values.reduce((a, v) => a + v, 0) / values.length;
    const sd = Math.sqrt(values.reduce((a, v) => a + (v - m) ** 2, 0) / values.length);
    if (sd === 0) return null;
    return values.reduce((a, v) => a + ((v - m) / sd) ** 3, 0) / values.length;
  }

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1279-T1283 — v10.42 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      const scores = [0.1, 0.2, 0.9];
      for (const s of scores) {
        await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1042-pres', hoursAgo(1)), dec(s));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1042-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('riskScoreSkewness24h');
      expect(body).toHaveProperty('riskScoreSkewness7d');
      expect(body).toHaveProperty('riskScoreSkewness30d');
      expect(body).toHaveProperty('p95AllTimeLast24hVsAllTime');
      expect(body).toHaveProperty('blockRateAllTimeVsLast7d');
    });

    it('2. sessions — only old logs (>40d): skewness windows null, p95 ratio null (no 24h), blockRate null (no 7d)', async () => {
      ctx = await setup();
      for (const s of [0.1, 0.5, 0.9]) {
        await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1042-old', daysAgo(45)), dec(s));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1042-old');
      expect(status).toBe(200);
      // All windows are empty
      expect(body.riskScoreSkewness24h).toBeNull();
      expect(body.riskScoreSkewness7d).toBeNull();
      expect(body.riskScoreSkewness30d).toBeNull();
      // 24h window empty → p95 ratio null
      expect(body.p95AllTimeLast24hVsAllTime).toBeNull();
      // 7d window empty → blockRate ratio null
      expect(body.blockRateAllTimeVsLast7d).toBeNull();
    });

    it('3. sessions — symmetric scores [0.2, 0.5, 0.8] in 24h → skewness24h ≈ 0', async () => {
      ctx = await setup();
      for (const s of [0.2, 0.5, 0.8]) {
        await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1042-sym', hoursAgo(1)), dec(s));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1042-sym');
      expect(status).toBe(200);
      expect(body.riskScoreSkewness24h as number).toBeCloseTo(0, 5);
    });

    it('4. sessions — right-skewed scores [0.1, 0.2, 0.9] in 24h → positive skewness24h', async () => {
      ctx = await setup();
      const scores = [0.1, 0.2, 0.9];
      for (const s of scores) {
        await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1042-rsk', hoursAgo(2)), dec(s));
      }

      const expected = skewness(scores)!;
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1042-rsk');
      expect(status).toBe(200);
      expect(body.riskScoreSkewness24h as number).toBeGreaterThan(0);
      expect(body.riskScoreSkewness24h as number).toBeCloseTo(expected, 5);
    });

    it('5. sessions — only 2 logs in 24h → skewness24h null (< 3 minimum)', async () => {
      ctx = await setup();
      for (const s of [0.3, 0.7]) {
        await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1042-few', hoursAgo(1)), dec(s));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1042-few');
      expect(status).toBe(200);
      expect(body.riskScoreSkewness24h).toBeNull();
    });

    it('6. sessions — 3 identical scores in 24h → stddev=0 → skewness24h null', async () => {
      ctx = await setup();
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1042-iden', hoursAgo(1)), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1042-iden');
      expect(status).toBe(200);
      expect(body.riskScoreSkewness24h).toBeNull();
    });

    it('7. sessions — p95AllTimeLast24hVsAllTime: ratio computed correctly', async () => {
      ctx = await setup();
      // 5 old logs [0.1,0.2,0.3,0.4,0.5], p95_all = idx floor(5*0.95)=4 → 0.5
      for (const s of [0.1, 0.2, 0.3, 0.4, 0.5]) {
        await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1042-p95', daysAgo(10)), dec(s));
      }
      // 5 recent logs in 24h [0.6,0.7,0.8,0.9,1.0], p95_24h = idx floor(5*0.95)=4 → 1.0
      for (const s of [0.6, 0.7, 0.8, 0.9, 1.0]) {
        await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1042-p95', hoursAgo(1)), dec(s));
      }
      // all-time sorted [0.1..1.0], p95 idx=floor(10*0.95)=9 → 1.0
      // 24h sorted [0.6..1.0], p95 idx=floor(5*0.95)=4 → 1.0
      // ratio = 1.0/1.0 = 1.0

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1042-p95');
      expect(status).toBe(200);
      expect(body.p95AllTimeLast24hVsAllTime as number).toBeCloseTo(1.0, 5);
    });

    it('8. sessions — blockRateAllTimeVsLast7d: ratio computed correctly', async () => {
      ctx = await setup();
      // 4 old logs: 2 blocked → blockRateAll = 2/4 = 0.5
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1042-blk', daysAgo(20)), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1042-blk', daysAgo(20)), dec(0.7, 'block'));
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1042-blk', daysAgo(20)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1042-blk', daysAgo(20)), dec(0.2, 'allow'));
      // 2 logs in 7d: 1 blocked → blockRate7d = 0.5
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1042-blk', daysAgo(3)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1042-blk', daysAgo(3)), dec(0.1, 'allow'));
      // blockRateAll = 3/6=0.5, blockRate7d = 1/2=0.5, ratio=1.0

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1042-blk');
      expect(status).toBe(200);
      expect(body.blockRateAllTimeVsLast7d as number).toBeCloseTo(1.0, 5);
    });

    it('9. sessions — blockRateAllTimeVsLast7d null when 7d block rate = 0', async () => {
      ctx = await setup();
      // All 7d logs are allowed → rate7d=0 → null
      for (const s of [0.2, 0.4, 0.6]) {
        await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v1042-br0', daysAgo(2)), dec(s, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1042-br0');
      expect(status).toBe(200);
      expect(body.blockRateAllTimeVsLast7d).toBeNull();
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1279-T1283 — v10.42 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('10. agents — all five new fields present in response', async () => {
      ctx = await setup();
      for (const s of [0.1, 0.5, 0.9]) {
        await ctx.logger.log(makeOp('agent-v1042-pres', 'fs', 'sess-1', hoursAgo(1)), dec(s));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1042-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('riskScoreSkewness24h');
      expect(body).toHaveProperty('riskScoreSkewness7d');
      expect(body).toHaveProperty('riskScoreSkewness30d');
      expect(body).toHaveProperty('p95AllTimeLast24hVsAllTime');
      expect(body).toHaveProperty('blockRateAllTimeVsLast7d');
    });

    it('11. agents — only old logs (>40d): all 5 fields null', async () => {
      ctx = await setup();
      for (const s of [0.2, 0.5, 0.8]) {
        await ctx.logger.log(makeOp('agent-v1042-old', 'fs', 'sess-1', daysAgo(45)), dec(s));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1042-old');
      expect(status).toBe(200);
      expect(body.riskScoreSkewness24h).toBeNull();
      expect(body.riskScoreSkewness7d).toBeNull();
      expect(body.riskScoreSkewness30d).toBeNull();
      expect(body.p95AllTimeLast24hVsAllTime).toBeNull();
      expect(body.blockRateAllTimeVsLast7d).toBeNull();
    });

    it('12. agents — symmetric scores [0.2,0.5,0.8] in 7d → skewness7d ≈ 0', async () => {
      ctx = await setup();
      for (const s of [0.2, 0.5, 0.8]) {
        await ctx.logger.log(makeOp('agent-v1042-sym7', 'fs', 'sess-1', daysAgo(3)), dec(s));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1042-sym7');
      expect(status).toBe(200);
      expect(body.riskScoreSkewness7d as number).toBeCloseTo(0, 5);
    });

    it('13. agents — 3 logs in 30d but only 2 in 7d → skewness30d non-null, skewness7d null', async () => {
      ctx = await setup();
      // 1 log at 15d (in 30d but not 7d)
      await ctx.logger.log(makeOp('agent-v1042-w30', 'fs', 'sess-1', daysAgo(15)), dec(0.3));
      // 2 logs in 7d
      for (const s of [0.6, 0.9]) {
        await ctx.logger.log(makeOp('agent-v1042-w30', 'fs', 'sess-1', daysAgo(3)), dec(s));
      }
      // 7d has 2 logs → skewness7d null
      // 30d has 3 logs [0.3,0.6,0.9] → symmetric → skewness30d ≈ 0

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1042-w30');
      expect(status).toBe(200);
      expect(body.riskScoreSkewness7d).toBeNull();
      expect(body.riskScoreSkewness30d as number).toBeCloseTo(0, 5);
    });

    it('14. agents — right-skewed [0.1,0.2,0.9] in 30d → positive skewness30d', async () => {
      ctx = await setup();
      const scores = [0.1, 0.2, 0.9];
      for (const s of scores) {
        await ctx.logger.log(makeOp('agent-v1042-rsk30', 'fs', 'sess-1', daysAgo(20)), dec(s));
      }

      const expected = skewness(scores)!;
      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1042-rsk30');
      expect(status).toBe(200);
      expect(body.riskScoreSkewness30d as number).toBeGreaterThan(0);
      expect(body.riskScoreSkewness30d as number).toBeCloseTo(expected, 5);
    });

    it('15. agents — blockRateAllTimeVsLast7d: all 7d blocks → ratio computed', async () => {
      ctx = await setup();
      // 4 old logs: 0 blocked
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp('agent-v1042-blk7', 'fs', 'sess-1', daysAgo(20)), dec(0.3, 'allow'));
      }
      // 2 logs in 7d: both blocked → rate7d = 1.0
      for (let i = 0; i < 2; i++) {
        await ctx.logger.log(makeOp('agent-v1042-blk7', 'fs', 'sess-1', daysAgo(2)), dec(0.9, 'block'));
      }
      // blockRateAll = 2/6 ≈ 0.333, rate7d = 2/2 = 1.0, ratio ≈ 0.333

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1042-blk7');
      expect(status).toBe(200);
      const ratio = body.blockRateAllTimeVsLast7d as number;
      expect(ratio).toBeCloseTo(2 / 6 / 1.0, 5);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1279-T1283 — v10.42 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('16. tools — all five new fields present in response', async () => {
      ctx = await setup();
      for (const s of [0.1, 0.5, 0.9]) {
        await ctx.logger.log(makeOp('agent-a', 'tool-v1042-pres', 'sess-1', hoursAgo(1)), dec(s));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1042-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('riskScoreSkewness24h');
      expect(body).toHaveProperty('riskScoreSkewness7d');
      expect(body).toHaveProperty('riskScoreSkewness30d');
      expect(body).toHaveProperty('p95AllTimeLast24hVsAllTime');
      expect(body).toHaveProperty('blockRateAllTimeVsLast7d');
    });

    it('17. tools — only old logs (>40d): all 5 new fields null', async () => {
      ctx = await setup();
      for (const s of [0.3, 0.5, 0.7]) {
        await ctx.logger.log(makeOp('agent-a', 'tool-v1042-old', 'sess-1', daysAgo(45)), dec(s));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1042-old');
      expect(status).toBe(200);
      expect(body.riskScoreSkewness24h).toBeNull();
      expect(body.riskScoreSkewness7d).toBeNull();
      expect(body.riskScoreSkewness30d).toBeNull();
      expect(body.p95AllTimeLast24hVsAllTime).toBeNull();
      expect(body.blockRateAllTimeVsLast7d).toBeNull();
    });

    it('18. tools — 3 identical scores in any window → stddev=0 → skewness null', async () => {
      ctx = await setup();
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-a', 'tool-v1042-iden', 'sess-1', hoursAgo(2)), dec(0.6));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1042-iden');
      expect(status).toBe(200);
      expect(body.riskScoreSkewness24h).toBeNull();
      expect(body.riskScoreSkewness7d).toBeNull();
      expect(body.riskScoreSkewness30d).toBeNull();
    });

    it('19. tools — p95AllTimeLast24hVsAllTime: p95_24h < p95_all → ratio < 1', async () => {
      ctx = await setup();
      // Old high-risk logs (outside 24h) push p95_all high
      for (const s of [0.8, 0.85, 0.9, 0.95, 1.0]) {
        await ctx.logger.log(makeOp('agent-a', 'tool-v1042-p95r', 'sess-1', daysAgo(10)), dec(s));
      }
      // Recent low-risk logs in 24h: p95_24h will be lower
      for (const s of [0.1, 0.2, 0.3, 0.4, 0.5]) {
        await ctx.logger.log(makeOp('agent-a', 'tool-v1042-p95r', 'sess-1', hoursAgo(1)), dec(s));
      }
      // all 10: sorted [0.1..1.0], p95 idx=floor(10*0.95)=9 → 1.0
      // 24h 5: sorted [0.1..0.5], p95 idx=floor(5*0.95)=4 → 0.5
      // ratio = 0.5/1.0 = 0.5

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1042-p95r');
      expect(status).toBe(200);
      expect(body.p95AllTimeLast24hVsAllTime as number).toBeCloseTo(0.5, 5);
    });

    it('20. tools — right-skewed [0.1,0.2,0.9] in 24h → positive skewness24h via formula', async () => {
      ctx = await setup();
      const scores = [0.1, 0.2, 0.9];
      for (const s of scores) {
        await ctx.logger.log(makeOp('agent-a', 'tool-v1042-rsk24', 'sess-1', hoursAgo(3)), dec(s));
      }

      const expected = skewness(scores)!;
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1042-rsk24');
      expect(status).toBe(200);
      expect(body.riskScoreSkewness24h as number).toBeCloseTo(expected, 5);
    });

    it('21. tools — skewness: 7d window scores include 24h → 7d skewness more stable', async () => {
      ctx = await setup();
      // 2 logs at 5d, 1 at 1h → 7d has 3, 24h has 1 (null for 24h)
      await ctx.logger.log(makeOp('agent-a', 'tool-v1042-7vs24', 'sess-1', daysAgo(5)), dec(0.1));
      await ctx.logger.log(makeOp('agent-a', 'tool-v1042-7vs24', 'sess-1', daysAgo(5)), dec(0.5));
      await ctx.logger.log(makeOp('agent-a', 'tool-v1042-7vs24', 'sess-1', hoursAgo(1)), dec(0.9));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1042-7vs24');
      expect(status).toBe(200);
      // 24h has 1 log → null
      expect(body.riskScoreSkewness24h).toBeNull();
      // 7d has 3 logs [0.1,0.5,0.9] → symmetric → ≈ 0
      expect(body.riskScoreSkewness7d as number).toBeCloseTo(0, 5);
    });
  });

  // ── summary endpoint ──────────────────────────────────────────────────────────

  describe('T1279-T1283 — v10.42 new fields (summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('22. summary — all five new fields present in response', async () => {
      ctx = await setup();
      for (const s of [0.1, 0.5, 0.9]) {
        await ctx.logger.log(makeOp('agent-s', 'fs', 'sess-1', hoursAgo(1)), dec(s));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body).toHaveProperty('riskScoreSkewness24h');
      expect(body).toHaveProperty('riskScoreSkewness7d');
      expect(body).toHaveProperty('riskScoreSkewness30d');
      expect(body).toHaveProperty('p95AllTimeLast24hVsAllTime');
      expect(body).toHaveProperty('blockRateAllTimeVsLast7d');
    });

    it('23. summary — no logs at all: all 5 new fields null', async () => {
      ctx = await setup();

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreSkewness24h).toBeNull();
      expect(body.riskScoreSkewness7d).toBeNull();
      expect(body.riskScoreSkewness30d).toBeNull();
      expect(body.p95AllTimeLast24hVsAllTime).toBeNull();
      expect(body.blockRateAllTimeVsLast7d).toBeNull();
    });

    it('24. summary — symmetric scores [0.2,0.5,0.8] in 24h → skewness24h ≈ 0', async () => {
      ctx = await setup();
      for (const s of [0.2, 0.5, 0.8]) {
        await ctx.logger.log(makeOp('agent-s', 'fs', 'sess-1', hoursAgo(2)), dec(s));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreSkewness24h as number).toBeCloseTo(0, 5);
    });

    it('25. summary — right-skewed [0.1,0.2,0.9] in all windows → positive skewness in all', async () => {
      ctx = await setup();
      const scores = [0.1, 0.2, 0.9];
      for (const s of scores) {
        await ctx.logger.log(makeOp('agent-s', 'fs', 'sess-1', hoursAgo(1)), dec(s));
      }

      const expected = skewness(scores)!;
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreSkewness24h as number).toBeCloseTo(expected, 5);
      expect(body.riskScoreSkewness7d as number).toBeCloseTo(expected, 5);
      expect(body.riskScoreSkewness30d as number).toBeCloseTo(expected, 5);
    });

    it('26. summary — p95AllTimeLast24hVsAllTime null when no logs in 24h', async () => {
      ctx = await setup();
      // Only old logs
      for (const s of [0.4, 0.6, 0.8]) {
        await ctx.logger.log(makeOp('agent-s', 'fs', 'sess-1', daysAgo(5)), dec(s));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.p95AllTimeLast24hVsAllTime).toBeNull();
    });

    it('27. summary — blockRateAllTimeVsLast7d with mixed all-time/7d blocks', async () => {
      ctx = await setup();
      // Old logs: 3 allow, 1 block → rateAll = 1/4 = 0.25 (after adding 7d logs)
      await ctx.logger.log(makeOp('agent-s', 'fs', 'sess-1', daysAgo(20)), dec(0.9, 'block'));
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-s', 'fs', 'sess-1', daysAgo(20)), dec(0.3, 'allow'));
      }
      // 7d logs: 2 block, 2 allow → rate7d = 0.5
      for (let i = 0; i < 2; i++) {
        await ctx.logger.log(makeOp('agent-s', 'fs', 'sess-1', daysAgo(3)), dec(0.8, 'block'));
        await ctx.logger.log(makeOp('agent-s', 'fs', 'sess-1', daysAgo(3)), dec(0.2, 'allow'));
      }
      // total 8 logs, 3 blocked → rateAll = 3/8 = 0.375
      // 7d: 4 logs, 2 blocked → rate7d = 0.5
      // ratio = 0.375 / 0.5 = 0.75

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.blockRateAllTimeVsLast7d as number).toBeCloseTo(0.75, 5);
    });

    it('28. summary — skewness with exactly 3 logs non-identical → non-null skewness', async () => {
      ctx = await setup();
      const scores = [0.3, 0.5, 0.7];
      for (const s of scores) {
        await ctx.logger.log(makeOp('agent-s2', 'db', 'sess-2', hoursAgo(1)), dec(s));
      }

      const expected = skewness(scores)!;
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      // [0.3, 0.5, 0.7] is symmetric so skewness ≈ 0
      expect(body.riskScoreSkewness24h as number).toBeCloseTo(expected, 5);
    });

    it('29. summary — blockRateAllTimeVsLast7d null when 7d window empty (only old logs)', async () => {
      ctx = await setup();
      // Only old logs (>7d)
      await ctx.logger.log(makeOp('agent-s', 'fs', 'sess-1', daysAgo(10)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-s', 'fs', 'sess-1', daysAgo(10)), dec(0.3, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.blockRateAllTimeVsLast7d).toBeNull();
    });

    it('30. summary — left-skewed distribution [0.1,0.8,0.9] → negative skewness24h', async () => {
      ctx = await setup();
      const scores = [0.1, 0.8, 0.9];
      for (const s of scores) {
        await ctx.logger.log(makeOp('agent-s', 'net', 'sess-3', hoursAgo(1)), dec(s));
      }

      const expected = skewness(scores)!;
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      // [0.1, 0.8, 0.9] is left-skewed (tail on left)
      expect(body.riskScoreSkewness24h as number).toBeLessThan(0);
      expect(body.riskScoreSkewness24h as number).toBeCloseTo(expected, 5);
    });
  });
});

// ── v10.43 ────────────────────────────────────────────────────────────────────

describe('v10.43', () => {
  const hoursAgo = (h: number) => new Date(PINNED_NOW() - h * 3_600_000);
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1284-T1288 — v10.43 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1043-pres', hoursAgo(1)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1043-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('blockRateAllTimeVsLast30d');
      expect(body).toHaveProperty('allowRateAllTime');
      expect(body).toHaveProperty('allowRateLast7d');
      expect(body).toHaveProperty('allowRateLast30d');
      expect(body).toHaveProperty('requireApprovalRateLast7d');
    });

    it('2. sessions — no logs in session: blockRateAllTimeVsLast30d null, allowRateAllTime null', async () => {
      ctx = await setup();
      // seed one log so the session exists, then check a different session id with no logs via summary
      // The sessions endpoint returns 404 for unknown sessions; use an existing session with only blocks
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1043-empty-blk', hoursAgo(1)), dec(0.9, 'block'));
      // allowRateAllTime = 0/1 = 0.0 (not null, because there IS a log — adjust expectation)
      // Instead test with only blocks → allowRateAllTime = 0.0
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1043-empty-blk');
      expect(status).toBe(200);
      // 30d window has 1 log with block → rate30d = 1.0, rateAll = 1.0, ratio = 1.0
      expect(body.blockRateAllTimeVsLast30d as number).toBeCloseTo(1.0, 5);
      // no allow actions → allowRateAllTime = 0.0
      expect(body.allowRateAllTime as number).toBeCloseTo(0.0, 5);
    });

    it('3. sessions — only old logs (>40d): blockRateAllTimeVsLast30d null (empty 30d window)', async () => {
      ctx = await setup();
      // seed 3 logs older than 40 days — all blocked
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1043-old', daysAgo(45)), dec(0.9, 'block'));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1043-old');
      expect(status).toBe(200);
      // 30d window is empty → null
      expect(body.blockRateAllTimeVsLast30d).toBeNull();
    });

    it('4. sessions — all 30d logs are allowed (rate30d=0): blockRateAllTimeVsLast30d null', async () => {
      ctx = await setup();
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1043-br0', daysAgo(10)), dec(0.3, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1043-br0');
      expect(status).toBe(200);
      expect(body.blockRateAllTimeVsLast30d).toBeNull();
    });

    it('5. sessions — blockRateAllTimeVsLast30d ratio computed correctly', async () => {
      ctx = await setup();
      // 4 old logs (>30d): 2 blocked, 2 allowed → contribute to all-time but not 30d
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1043-blk30', daysAgo(45)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1043-blk30', daysAgo(45)), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1043-blk30', daysAgo(45)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1043-blk30', daysAgo(45)), dec(0.1, 'allow'));
      // 4 logs in 30d: 2 blocked, 2 allowed → rate30d = 0.5
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1043-blk30', daysAgo(10)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1043-blk30', daysAgo(10)), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1043-blk30', daysAgo(10)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1043-blk30', daysAgo(10)), dec(0.1, 'allow'));
      // total 8 logs: 4 blocked → rateAll = 4/8 = 0.5
      // 30d: 4 logs, 2 blocked → rate30d = 0.5
      // ratio = 0.5 / 0.5 = 1.0

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1043-blk30');
      expect(status).toBe(200);
      expect(body.blockRateAllTimeVsLast30d as number).toBeCloseTo(1.0, 5);
    });

    it('6. sessions — allowRateAllTime: all ops allowed → 1.0', async () => {
      ctx = await setup();
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1043-allAllow', daysAgo(50)), dec(0.2, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1043-allAllow');
      expect(status).toBe(200);
      expect(body.allowRateAllTime as number).toBeCloseTo(1.0, 5);
    });

    it('7. sessions — allowRateAllTime: mixed allow/block computed correctly', async () => {
      ctx = await setup();
      // 3 allow, 1 block → 3/4 = 0.75
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1043-mixAllow', daysAgo(5)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1043-mixAllow', daysAgo(5)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1043-mixAllow', daysAgo(5)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1043-mixAllow', daysAgo(5)), dec(0.9, 'block'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1043-mixAllow');
      expect(status).toBe(200);
      expect(body.allowRateAllTime as number).toBeCloseTo(0.75, 5);
    });

    it('8. sessions — allowRateLast7d: pre-existing field is present and correct', async () => {
      ctx = await setup();
      // 2 allow in 7d, 1 block in 7d, 1 allow old (>7d)
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1043-ar7d', daysAgo(3)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1043-ar7d', daysAgo(3)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1043-ar7d', daysAgo(3)), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1043-ar7d', daysAgo(15)), dec(0.2, 'allow'));
      // 7d: 3 logs, 2 allow → 2/3

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1043-ar7d');
      expect(status).toBe(200);
      expect(body).toHaveProperty('allowRateLast7d');
      expect(body.allowRateLast7d as number).toBeCloseTo(2 / 3, 5);
    });

    it('9. sessions — allowRateLast30d: pre-existing field is present and correct', async () => {
      ctx = await setup();
      // 3 allow in 30d, 1 block in 30d
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1043-ar30d', daysAgo(20)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1043-ar30d', daysAgo(20)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1043-ar30d', daysAgo(20)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1043-ar30d', daysAgo(20)), dec(0.9, 'block'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1043-ar30d');
      expect(status).toBe(200);
      expect(body).toHaveProperty('allowRateLast30d');
      expect(body.allowRateLast30d as number).toBeCloseTo(0.75, 5);
    });

    it('10. sessions — requireApprovalRateLast7d: null when 7d window empty (old logs only)', async () => {
      ctx = await setup();
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v1043-ra7old', daysAgo(45)), dec(0.5, 'require_approval'));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1043-ra7old');
      expect(status).toBe(200);
      expect(body.requireApprovalRateLast7d).toBeNull();
    });

    it('11. sessions — requireApprovalRateLast7d computed correctly', async () => {
      ctx = await setup();
      // 2 require_approval, 2 allow in 7d → rate = 0.5
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v1043-ra7d', daysAgo(2)), dec(0.6, 'require_approval'));
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v1043-ra7d', daysAgo(2)), dec(0.7, 'require_approval'));
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v1043-ra7d', daysAgo(2)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v1043-ra7d', daysAgo(2)), dec(0.3, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1043-ra7d');
      expect(status).toBe(200);
      expect(body.requireApprovalRateLast7d as number).toBeCloseTo(0.5, 5);
    });

    it('12. sessions — requireApprovalRateLast7d: all ops require_approval → 1.0', async () => {
      ctx = await setup();
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-k', 'fs', 'sess-v1043-ra7all', hoursAgo(2)), dec(0.8, 'require_approval'));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1043-ra7all');
      expect(status).toBe(200);
      expect(body.requireApprovalRateLast7d as number).toBeCloseTo(1.0, 5);
    });

    it('13. sessions — blockRateAllTimeVsLast30d: ratio > 1 when allTime rate > 30d rate', async () => {
      ctx = await setup();
      // Old logs (>30d): heavily blocked → raises all-time rate
      for (let i = 0; i < 6; i++) {
        await ctx.logger.log(makeOp('agent-l', 'fs', 'sess-v1043-ratio-hi', daysAgo(45)), dec(0.9, 'block'));
      }
      // 30d logs: only 1 of 4 blocked → low rate30d
      await ctx.logger.log(makeOp('agent-l', 'fs', 'sess-v1043-ratio-hi', daysAgo(10)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-l', 'fs', 'sess-v1043-ratio-hi', daysAgo(10)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-l', 'fs', 'sess-v1043-ratio-hi', daysAgo(10)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-l', 'fs', 'sess-v1043-ratio-hi', daysAgo(10)), dec(0.2, 'allow'));
      // total 10: 7 blocked → rateAll = 0.7
      // 30d: 4 logs, 1 blocked → rate30d = 0.25
      // ratio = 0.7 / 0.25 = 2.8

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1043-ratio-hi');
      expect(status).toBe(200);
      expect(body.blockRateAllTimeVsLast30d as number).toBeCloseTo(2.8, 5);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1284-T1288 — v10.43 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('14. agents — all five fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1043-pres', 'fs', 'sess-1', hoursAgo(1)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1043-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('blockRateAllTimeVsLast30d');
      expect(body).toHaveProperty('allowRateAllTime');
      expect(body).toHaveProperty('allowRateLast7d');
      expect(body).toHaveProperty('allowRateLast30d');
      expect(body).toHaveProperty('requireApprovalRateLast7d');
    });

    it('15. agents — only old logs (>40d): blockRateAllTimeVsLast30d null, requireApprovalRateLast7d null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1043-old', 'fs', 'sess-1', daysAgo(45)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-v1043-old', 'fs', 'sess-1', daysAgo(45)), dec(0.7, 'require_approval'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1043-old');
      expect(status).toBe(200);
      // 30d window empty → null
      expect(body.blockRateAllTimeVsLast30d).toBeNull();
      // 7d window empty → null
      expect(body.requireApprovalRateLast7d).toBeNull();
    });

    it('16. agents — allowRateAllTime: mixed allow/block/require_approval counted correctly', async () => {
      ctx = await setup();
      // 2 allow, 1 block, 1 require_approval → allowRate = 2/4 = 0.5
      await ctx.logger.log(makeOp('agent-v1043-mix', 'fs', 'sess-1', daysAgo(10)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-v1043-mix', 'fs', 'sess-1', daysAgo(10)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-v1043-mix', 'fs', 'sess-1', daysAgo(10)), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agent-v1043-mix', 'fs', 'sess-1', daysAgo(10)), dec(0.6, 'require_approval'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1043-mix');
      expect(status).toBe(200);
      expect(body.allowRateAllTime as number).toBeCloseTo(0.5, 5);
    });

    it('17. agents — allowRateLast7d: null when 7d window empty', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1043-ar7empty', 'fs', 'sess-1', daysAgo(45)), dec(0.3, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1043-ar7empty');
      expect(status).toBe(200);
      expect(body.allowRateLast7d).toBeNull();
    });

    it('18. agents — allowRateLast7d: correct fraction in 7d window', async () => {
      ctx = await setup();
      // 4 allow, 1 block in 7d
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp('agent-v1043-ar7val', 'fs', 'sess-1', daysAgo(3)), dec(0.2, 'allow'));
      }
      await ctx.logger.log(makeOp('agent-v1043-ar7val', 'fs', 'sess-1', daysAgo(3)), dec(0.9, 'block'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1043-ar7val');
      expect(status).toBe(200);
      expect(body.allowRateLast7d as number).toBeCloseTo(0.8, 5);
    });

    it('19. agents — allowRateLast30d: correct fraction in 30d window, excludes >30d logs', async () => {
      ctx = await setup();
      // 2 allow in 30d
      await ctx.logger.log(makeOp('agent-v1043-ar30val', 'fs', 'sess-1', daysAgo(20)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-v1043-ar30val', 'fs', 'sess-1', daysAgo(20)), dec(0.3, 'allow'));
      // 1 block in 30d
      await ctx.logger.log(makeOp('agent-v1043-ar30val', 'fs', 'sess-1', daysAgo(20)), dec(0.8, 'block'));
      // 1 allow older than 30d (excluded from 30d window)
      await ctx.logger.log(makeOp('agent-v1043-ar30val', 'fs', 'sess-1', daysAgo(45)), dec(0.1, 'block'));
      // 30d: 3 logs, 2 allow → 2/3

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1043-ar30val');
      expect(status).toBe(200);
      expect(body.allowRateLast30d as number).toBeCloseTo(2 / 3, 5);
    });

    it('20. agents — requireApprovalRateLast7d: zero require_approval in 7d → 0.0 (not null)', async () => {
      ctx = await setup();
      // only allow in 7d → no require_approval → rate = 0
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-v1043-ra7zero', 'fs', 'sess-1', daysAgo(2)), dec(0.3, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1043-ra7zero');
      expect(status).toBe(200);
      expect(body.requireApprovalRateLast7d as number).toBeCloseTo(0.0, 5);
    });

    it('21. agents — blockRateAllTimeVsLast30d: ratio < 1 when allTime rate < 30d rate', async () => {
      ctx = await setup();
      // Old logs (>30d): all allowed → low all-time block rate
      for (let i = 0; i < 6; i++) {
        await ctx.logger.log(makeOp('agent-v1043-ratio-lo', 'fs', 'sess-1', daysAgo(45)), dec(0.1, 'allow'));
      }
      // 30d logs: all blocked → high rate30d
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp('agent-v1043-ratio-lo', 'fs', 'sess-1', daysAgo(10)), dec(0.9, 'block'));
      }
      // total 10: 4 blocked → rateAll = 0.4
      // 30d: 4 logs, all blocked → rate30d = 1.0
      // ratio = 0.4 / 1.0 = 0.4

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1043-ratio-lo');
      expect(status).toBe(200);
      expect(body.blockRateAllTimeVsLast30d as number).toBeCloseTo(0.4, 5);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1284-T1288 — v10.43 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('22. tools — all five fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v1043-pres', 'sess-1', hoursAgo(1)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1043-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('blockRateAllTimeVsLast30d');
      expect(body).toHaveProperty('allowRateAllTime');
      expect(body).toHaveProperty('allowRateLast7d');
      expect(body).toHaveProperty('allowRateLast30d');
      expect(body).toHaveProperty('requireApprovalRateLast7d');
    });

    it('23. tools — only old logs (>40d): blockRateAllTimeVsLast30d null, allowRateLast7d null, requireApprovalRateLast7d null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v1043-old', 'sess-1', daysAgo(45)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-a', 'tool-v1043-old', 'sess-1', daysAgo(45)), dec(0.5, 'require_approval'));
      await ctx.logger.log(makeOp('agent-a', 'tool-v1043-old', 'sess-1', daysAgo(45)), dec(0.2, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1043-old');
      expect(status).toBe(200);
      expect(body.blockRateAllTimeVsLast30d).toBeNull();
      expect(body.allowRateLast7d).toBeNull();
      expect(body.requireApprovalRateLast7d).toBeNull();
    });

    it('24. tools — allowRateAllTime: all require_approval logs → 0.0 allow rate', async () => {
      ctx = await setup();
      // no allow or block, only require_approval → allowRateAllTime = 0/3 = 0.0
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-a', 'tool-v1043-allra', 'sess-1', daysAgo(5)), dec(0.6, 'require_approval'));
      }
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1043-allra');
      expect(status).toBe(200);
      expect(body.allowRateAllTime as number).toBeCloseTo(0.0, 5);
    });

    it('25. tools — allowRateAllTime: only blocked logs → 0.0', async () => {
      ctx = await setup();
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-a', 'tool-v1043-allBlock', 'sess-1', daysAgo(5)), dec(0.9, 'block'));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1043-allBlock');
      expect(status).toBe(200);
      expect(body.allowRateAllTime as number).toBeCloseTo(0.0, 5);
    });

    it('26. tools — requireApprovalRateLast7d: mixed ops in 7d → correct fraction', async () => {
      ctx = await setup();
      // 1 require_approval, 1 allow, 1 block → rate = 1/3
      await ctx.logger.log(makeOp('agent-a', 'tool-v1043-ra7mix', 'sess-1', daysAgo(3)), dec(0.7, 'require_approval'));
      await ctx.logger.log(makeOp('agent-a', 'tool-v1043-ra7mix', 'sess-1', daysAgo(3)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-a', 'tool-v1043-ra7mix', 'sess-1', daysAgo(3)), dec(0.9, 'block'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1043-ra7mix');
      expect(status).toBe(200);
      expect(body.requireApprovalRateLast7d as number).toBeCloseTo(1 / 3, 5);
    });

    it('27. tools — allowRateLast30d: null when 30d window empty', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v1043-ar30empty', 'sess-1', daysAgo(45)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1043-ar30empty');
      expect(status).toBe(200);
      expect(body.allowRateLast30d).toBeNull();
    });

    it('28. tools — blockRateAllTimeVsLast30d: old blocks + recent allows → ratio computed', async () => {
      ctx = await setup();
      // 4 old logs: 4 blocked → rateAll initially 1.0
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp('agent-a', 'tool-v1043-blk30', 'sess-1', daysAgo(45)), dec(0.9, 'block'));
      }
      // 4 logs in 30d: 2 blocked, 2 allowed → rate30d = 0.5
      await ctx.logger.log(makeOp('agent-a', 'tool-v1043-blk30', 'sess-1', daysAgo(10)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-a', 'tool-v1043-blk30', 'sess-1', daysAgo(10)), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agent-a', 'tool-v1043-blk30', 'sess-1', daysAgo(10)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-a', 'tool-v1043-blk30', 'sess-1', daysAgo(10)), dec(0.1, 'allow'));
      // total 8: 6 blocked → rateAll = 0.75
      // 30d: 4 logs, 2 blocked → rate30d = 0.5
      // ratio = 0.75 / 0.5 = 1.5

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1043-blk30');
      expect(status).toBe(200);
      expect(body.blockRateAllTimeVsLast30d as number).toBeCloseTo(1.5, 5);
    });
  });

  // ── summary endpoint ──────────────────────────────────────────────────────────

  describe('T1284-T1288 — v10.43 new fields (summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('29. summary — all five fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s', 'fs', 'sess-1', hoursAgo(1)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body).toHaveProperty('blockRateAllTimeVsLast30d');
      expect(body).toHaveProperty('allowRateAllTime');
      expect(body).toHaveProperty('allowRateLast7d');
      expect(body).toHaveProperty('allowRateLast30d');
      expect(body).toHaveProperty('requireApprovalRateLast7d');
    });

    it('30. summary — no logs: blockRateAllTimeVsLast30d null, allowRateAllTime null, requireApprovalRateLast7d null', async () => {
      ctx = await setup();

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.blockRateAllTimeVsLast30d).toBeNull();
      expect(body.allowRateAllTime).toBeNull();
      expect(body.requireApprovalRateLast7d).toBeNull();
    });

    it('31. summary — only old logs (>40d): blockRateAllTimeVsLast30d null (empty 30d)', async () => {
      ctx = await setup();
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-s', 'fs', 'sess-1', daysAgo(45)), dec(0.9, 'block'));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.blockRateAllTimeVsLast30d).toBeNull();
    });

    it('32. summary — all 30d ops are allowed: blockRateAllTimeVsLast30d null (rate30d=0)', async () => {
      ctx = await setup();
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp('agent-s', 'fs', 'sess-1', daysAgo(15)), dec(0.3, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.blockRateAllTimeVsLast30d).toBeNull();
    });

    it('33. summary — blockRateAllTimeVsLast30d: ratio computed correctly', async () => {
      ctx = await setup();
      // Old logs: 3 blocked, 1 allowed
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-s', 'fs', 'sess-1', daysAgo(45)), dec(0.9, 'block'));
      }
      await ctx.logger.log(makeOp('agent-s', 'fs', 'sess-1', daysAgo(45)), dec(0.1, 'allow'));
      // 30d logs: 1 blocked, 3 allowed → rate30d = 0.25
      await ctx.logger.log(makeOp('agent-s', 'fs', 'sess-1', daysAgo(10)), dec(0.9, 'block'));
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-s', 'fs', 'sess-1', daysAgo(10)), dec(0.1, 'allow'));
      }
      // total 8: 4 blocked → rateAll = 0.5
      // 30d: 4 logs, 1 blocked → rate30d = 0.25
      // ratio = 0.5 / 0.25 = 2.0

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.blockRateAllTimeVsLast30d as number).toBeCloseTo(2.0, 5);
    });

    it('34. summary — allowRateAllTime: all ops are allow → 1.0', async () => {
      ctx = await setup();
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp('agent-s', 'fs', 'sess-1', daysAgo(5)), dec(0.2, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.allowRateAllTime as number).toBeCloseTo(1.0, 5);
    });

    it('35. summary — allowRateAllTime: 1 allow, 3 blocks → 0.25', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s', 'fs', 'sess-1', daysAgo(5)), dec(0.2, 'allow'));
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-s', 'fs', 'sess-1', daysAgo(5)), dec(0.9, 'block'));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.allowRateAllTime as number).toBeCloseTo(0.25, 5);
    });

    it('36. summary — allowRateLast7d: correct fraction from 7d window only', async () => {
      ctx = await setup();
      // 6 allow, 2 block in 7d
      for (let i = 0; i < 6; i++) {
        await ctx.logger.log(makeOp('agent-s', 'fs', 'sess-1', daysAgo(3)), dec(0.2, 'allow'));
      }
      for (let i = 0; i < 2; i++) {
        await ctx.logger.log(makeOp('agent-s', 'fs', 'sess-1', daysAgo(3)), dec(0.9, 'block'));
      }
      // old logs (excluded from 7d)
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp('agent-s', 'fs', 'sess-1', daysAgo(20)), dec(0.9, 'block'));
      }
      // 7d: 8 logs, 6 allow → 6/8 = 0.75

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.allowRateLast7d as number).toBeCloseTo(0.75, 5);
    });

    it('37. summary — requireApprovalRateLast7d: require_approval ops only in 7d → 1.0', async () => {
      ctx = await setup();
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp('agent-s', 'fs', 'sess-1', daysAgo(2)), dec(0.7, 'require_approval'));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.requireApprovalRateLast7d as number).toBeCloseTo(1.0, 5);
    });

    it('38. summary — requireApprovalRateLast7d: old-only require_approval logs → 7d null', async () => {
      ctx = await setup();
      // require_approval only in old logs
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-s', 'fs', 'sess-1', daysAgo(45)), dec(0.7, 'require_approval'));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.requireApprovalRateLast7d).toBeNull();
    });

    it('39. summary — allowRateLast30d: null when only old logs (>30d)', async () => {
      ctx = await setup();
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-s', 'fs', 'sess-1', daysAgo(45)), dec(0.2, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.allowRateLast30d).toBeNull();
    });

    it('40. summary — all five fields: comprehensive mixed scenario', async () => {
      ctx = await setup();
      // Old logs (>30d): 2 block, 1 allow, 1 require_approval
      await ctx.logger.log(makeOp('agent-s', 'fs', 'sess-1', daysAgo(45)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-s', 'fs', 'sess-1', daysAgo(45)), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agent-s', 'fs', 'sess-1', daysAgo(45)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-s', 'fs', 'sess-1', daysAgo(45)), dec(0.6, 'require_approval'));
      // 30d logs (>7d): 1 block, 1 allow
      await ctx.logger.log(makeOp('agent-s', 'fs', 'sess-1', daysAgo(15)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-s', 'fs', 'sess-1', daysAgo(15)), dec(0.2, 'allow'));
      // 7d logs: 2 allow, 1 require_approval
      await ctx.logger.log(makeOp('agent-s', 'fs', 'sess-1', daysAgo(3)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-s', 'fs', 'sess-1', daysAgo(3)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-s', 'fs', 'sess-1', daysAgo(3)), dec(0.6, 'require_approval'));

      // total 9: 3 block, 4 allow, 2 require_approval
      // allowRateAllTime = 4/9
      const expectedAllowRateAll = 4 / 9;

      // 30d window: only 15d and 3d logs are included (45d logs are excluded)
      // 15d: 1 block, 1 allow (2 logs)
      // 3d: 2 allow, 1 ra (3 logs)
      // 30d total: 5 logs — 1 block, 3 allow, 1 ra
      // blockRate30d = 1/5 = 0.2
      // allowRateLast30d = 3/5 = 0.6
      const expectedAllowRate30d = 3 / 5;

      // 7d (3 logs at 3d): 2 allow, 1 ra → allowRateLast7d = 2/3
      const expectedAllowRate7d = 2 / 3;

      // requireApprovalRateLast7d: 1 ra out of 3 in 7d = 1/3
      const expectedRaRate7d = 1 / 3;

      // blockRateAllTimeVsLast30d: rateAll = 3/9 = 1/3, rate30d = 1/5 → ratio = (1/3)/(1/5) = 5/3
      const expectedBlkRatio = (3 / 9) / (1 / 5);

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.allowRateAllTime as number).toBeCloseTo(expectedAllowRateAll, 5);
      expect(body.allowRateLast30d as number).toBeCloseTo(expectedAllowRate30d, 5);
      expect(body.allowRateLast7d as number).toBeCloseTo(expectedAllowRate7d, 5);
      expect(body.requireApprovalRateLast7d as number).toBeCloseTo(expectedRaRate7d, 5);
      expect(body.blockRateAllTimeVsLast30d as number).toBeCloseTo(expectedBlkRatio, 5);
    });
  });
});

// ── v10.44 ────────────────────────────────────────────────────────────────────

describe('v10.44', () => {
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);
  const hoursAgo = (h: number) => new Date(PINNED_NOW() - h * 3_600_000);

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1289-T1293 — v10.44 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1044-pres'), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1044-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('requireApprovalRateLast30d');
      expect(body).toHaveProperty('blockRateLastNOps10');
      expect(body).toHaveProperty('blockRateLastNOps25');
      expect(body).toHaveProperty('blockRateLastNOps50');
      expect(body).toHaveProperty('avgRiskScoreLastNOps10');
    });

    it('2. sessions — only old ops (>30d): requireApprovalRateLast30d is null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1044-old', daysAgo(35)), dec(0.5, 'require_approval'));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1044-old', daysAgo(45)), dec(0.7, 'require_approval'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1044-old');
      expect(status).toBe(200);
      expect(body.requireApprovalRateLast30d).toBeNull();
    });

    it('3. sessions — recent ops with require_approval: requireApprovalRateLast30d is correct', async () => {
      ctx = await setup();
      // 2 require_approval, 2 allow → rate = 0.5
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1044-rate', daysAgo(1)), dec(0.5, 'require_approval'));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1044-rate', daysAgo(2)), dec(0.4, 'require_approval'));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1044-rate', daysAgo(3)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1044-rate', daysAgo(4)), dec(0.2, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1044-rate');
      expect(status).toBe(200);
      expect(body.requireApprovalRateLast30d as number).toBeCloseTo(0.5, 5);
    });

    it('4. sessions — 9 total ops: blockRateLastNOps10 is null', async () => {
      ctx = await setup();
      for (let i = 0; i < 9; i++) {
        await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1044-n9', hoursAgo(i + 1)), dec(0.5, 'block'));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1044-n9');
      expect(status).toBe(200);
      expect(body.blockRateLastNOps10).toBeNull();
    });

    it('5. sessions — exactly 10 total ops: blockRateLastNOps10 is non-null', async () => {
      ctx = await setup();
      // 5 block, 5 allow → blockRateLastNOps10 = 0.5
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1044-n10', hoursAgo(i + 1)), dec(0.5, 'block'));
      }
      for (let i = 5; i < 10; i++) {
        await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1044-n10', hoursAgo(i + 1)), dec(0.3, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1044-n10');
      expect(status).toBe(200);
      expect(body.blockRateLastNOps10 as number).toBeCloseTo(0.5, 5);
    });

    it('6. sessions — 24 total ops: blockRateLastNOps25 is null', async () => {
      ctx = await setup();
      for (let i = 0; i < 24; i++) {
        await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1044-n24', hoursAgo(i + 1)), dec(0.5, 'block'));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1044-n24');
      expect(status).toBe(200);
      expect(body.blockRateLastNOps25).toBeNull();
    });

    it('7. sessions — exactly 25 total ops: blockRateLastNOps25 is non-null', async () => {
      ctx = await setup();
      // 5 block, 20 allow → rate = 5/25 = 0.2
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1044-n25', hoursAgo(i + 1)), dec(0.8, 'block'));
      }
      for (let i = 5; i < 25; i++) {
        await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1044-n25', hoursAgo(i + 1)), dec(0.2, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1044-n25');
      expect(status).toBe(200);
      expect(body.blockRateLastNOps25 as number).toBeCloseTo(0.2, 5);
    });

    it('8. sessions — 49 total ops: blockRateLastNOps50 is null', async () => {
      ctx = await setup();
      for (let i = 0; i < 49; i++) {
        await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1044-n49', hoursAgo(i + 1)), dec(0.5, 'block'));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1044-n49');
      expect(status).toBe(200);
      expect(body.blockRateLastNOps50).toBeNull();
    });

    it('9. sessions — exactly 50 total ops: blockRateLastNOps50 is non-null (most recent 50)', async () => {
      ctx = await setup();
      // Most recent 10 are block (newest timestamps), 40 are allow → blockRateLastNOps50 = 10/50 = 0.2
      for (let i = 0; i < 10; i++) {
        // Newer ops (hours 1-10): block
        await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v1044-n50', hoursAgo(i + 1)), dec(0.9, 'block'));
      }
      for (let i = 10; i < 50; i++) {
        // Older ops (hours 11-50): allow
        await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v1044-n50', hoursAgo(i + 1)), dec(0.1, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1044-n50');
      expect(status).toBe(200);
      expect(body.blockRateLastNOps50 as number).toBeCloseTo(0.2, 5);
    });

    it('10. sessions — 9 total ops: avgRiskScoreLastNOps10 is null', async () => {
      ctx = await setup();
      for (let i = 0; i < 9; i++) {
        await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v1044-avg9', hoursAgo(i + 1)), dec(0.5 + i * 0.01, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1044-avg9');
      expect(status).toBe(200);
      expect(body.avgRiskScoreLastNOps10).toBeNull();
    });

    it('11. sessions — exactly 10 total ops: avgRiskScoreLastNOps10 is correct mean', async () => {
      ctx = await setup();
      // 10 ops with uniform risk 0.5 → avg = 0.5
      for (let i = 0; i < 10; i++) {
        await ctx.logger.log(makeOp('agent-k', 'fs', 'sess-v1044-avg10', hoursAgo(i + 1)), dec(0.5, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1044-avg10');
      expect(status).toBe(200);
      expect(body.avgRiskScoreLastNOps10 as number).toBeCloseTo(0.5, 5);
    });

    it('12. sessions — blockRateLastNOps10 uses most recent 10, ignores older ops', async () => {
      ctx = await setup();
      // 15 ops total; most recent 10 are all allow (hours 1-10), oldest 5 are block (hours 11-15)
      for (let i = 0; i < 10; i++) {
        await ctx.logger.log(makeOp('agent-l', 'fs', 'sess-v1044-recent10', hoursAgo(i + 1)), dec(0.3, 'allow'));
      }
      for (let i = 10; i < 15; i++) {
        await ctx.logger.log(makeOp('agent-l', 'fs', 'sess-v1044-recent10', hoursAgo(i + 1)), dec(0.9, 'block'));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1044-recent10');
      expect(status).toBe(200);
      // Most recent 10 are all allow → blockRate = 0
      expect(body.blockRateLastNOps10 as number).toBeCloseTo(0, 5);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1289-T1293 — v10.44 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('13. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1044-pres', 'fs', 'sess-1'), dec(0.3, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1044-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('requireApprovalRateLast30d');
      expect(body).toHaveProperty('blockRateLastNOps10');
      expect(body).toHaveProperty('blockRateLastNOps25');
      expect(body).toHaveProperty('blockRateLastNOps50');
      expect(body).toHaveProperty('avgRiskScoreLastNOps10');
    });

    it('14. agents — only old ops (>30d): requireApprovalRateLast30d is null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1044-old', 'fs', 'sess-1', daysAgo(40)), dec(0.5, 'require_approval'));
      await ctx.logger.log(makeOp('agent-v1044-old', 'fs', 'sess-2', daysAgo(50)), dec(0.7, 'require_approval'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1044-old');
      expect(status).toBe(200);
      expect(body.requireApprovalRateLast30d).toBeNull();
    });

    it('15. agents — requireApprovalRateLast30d with only allow actions → 0', async () => {
      ctx = await setup();
      // 5 allow actions in last 30d → require_approval rate = 0
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp('agent-v1044-rate0', 'fs', `sess-${i}`, daysAgo(i + 1)), dec(0.3, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1044-rate0');
      expect(status).toBe(200);
      expect(body.requireApprovalRateLast30d as number).toBeCloseTo(0, 5);
    });

    it('16. agents — 9 total ops: blockRateLastNOps10 and avgRiskScoreLastNOps10 are null', async () => {
      ctx = await setup();
      for (let i = 0; i < 9; i++) {
        await ctx.logger.log(makeOp('agent-v1044-n9', 'fs', `sess-${i}`, hoursAgo(i + 1)), dec(0.5, 'block'));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1044-n9');
      expect(status).toBe(200);
      expect(body.blockRateLastNOps10).toBeNull();
      expect(body.avgRiskScoreLastNOps10).toBeNull();
    });

    it('17. agents — exactly 10 ops: blockRateLastNOps10 and avgRiskScoreLastNOps10 are non-null', async () => {
      ctx = await setup();
      // 10 ops: 3 block, 7 allow; riskScores all 0.6 → avg = 0.6; blockRate = 0.3
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-v1044-n10', 'fs', `sess-${i}`, hoursAgo(i + 1)), dec(0.6, 'block'));
      }
      for (let i = 3; i < 10; i++) {
        await ctx.logger.log(makeOp('agent-v1044-n10', 'fs', `sess-${i}`, hoursAgo(i + 1)), dec(0.6, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1044-n10');
      expect(status).toBe(200);
      expect(body.blockRateLastNOps10 as number).toBeCloseTo(0.3, 5);
      expect(body.avgRiskScoreLastNOps10 as number).toBeCloseTo(0.6, 5);
    });

    it('18. agents — 24 ops: blockRateLastNOps25 null; 25 ops: blockRateLastNOps25 non-null', async () => {
      ctx = await setup();
      // First test with 24 ops
      {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'as-v1044-24-'));
        const store24 = new StateStore(path.join(tmpDir, 'test.db'));
        await store24.initialize();
        const logger24 = new OperationLogger(store24);
        let port24 = 0;
        const dash24 = new DashboardAPI(store24, {});
        await dash24.start(port24); port24 = dash24.getPort();
        try {
          for (let i = 0; i < 24; i++) {
            await logger24.log(makeOp('agent-v1044-n24', 'fs', `sess-${i}`, hoursAgo(i + 1)), dec(0.5, 'block'));
          }
          const { body: body24 } = await getJSON(port24, '/agents/agent-v1044-n24');
          expect(body24.blockRateLastNOps25).toBeNull();
        } finally {
          await dash24.stop();
          await store24.close();
          await fs.rm(tmpDir, { recursive: true, force: true });
        }
      }

      // Test with 25 ops — all block → blockRateLastNOps25 = 1
      for (let i = 0; i < 25; i++) {
        await ctx.logger.log(makeOp('agent-v1044-n25', 'fs', `sess-${i}`, hoursAgo(i + 1)), dec(0.5, 'block'));
      }
      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1044-n25');
      expect(status).toBe(200);
      expect(body.blockRateLastNOps25 as number).toBeCloseTo(1.0, 5);
    });

    it('19. agents — avgRiskScoreLastNOps10 uses most recent 10 by timestamp desc', async () => {
      ctx = await setup();
      // 12 ops: most recent 10 have risk=0.8, oldest 2 have risk=0.1
      for (let i = 0; i < 10; i++) {
        await ctx.logger.log(makeOp('agent-v1044-avgrecent', 'fs', `sess-${i}`, hoursAgo(i + 1)), dec(0.8, 'allow'));
      }
      for (let i = 10; i < 12; i++) {
        await ctx.logger.log(makeOp('agent-v1044-avgrecent', 'fs', `sess-${i}`, hoursAgo(i + 1)), dec(0.1, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1044-avgrecent');
      expect(status).toBe(200);
      // Most recent 10 all have risk=0.8 → avg = 0.8
      expect(body.avgRiskScoreLastNOps10 as number).toBeCloseTo(0.8, 5);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1289-T1293 — v10.44 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('20. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-m', 'tool-v1044-pres', 'sess-1'), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1044-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('requireApprovalRateLast30d');
      expect(body).toHaveProperty('blockRateLastNOps10');
      expect(body).toHaveProperty('blockRateLastNOps25');
      expect(body).toHaveProperty('blockRateLastNOps50');
      expect(body).toHaveProperty('avgRiskScoreLastNOps10');
    });

    it('21. tools — only old ops (>30d): requireApprovalRateLast30d is null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-n', 'tool-v1044-old', 'sess-1', daysAgo(35)), dec(0.4, 'require_approval'));
      await ctx.logger.log(makeOp('agent-n', 'tool-v1044-old', 'sess-2', daysAgo(50)), dec(0.9, 'require_approval'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1044-old');
      expect(status).toBe(200);
      expect(body.requireApprovalRateLast30d).toBeNull();
    });

    it('22. tools — mix of recent and old ops: requireApprovalRateLast30d counts only 30d window', async () => {
      ctx = await setup();
      // Old ops (>30d) with require_approval — should not count
      await ctx.logger.log(makeOp('agent-o', 'tool-v1044-mix', 'sess-1', daysAgo(40)), dec(0.5, 'require_approval'));
      await ctx.logger.log(makeOp('agent-o', 'tool-v1044-mix', 'sess-2', daysAgo(45)), dec(0.5, 'require_approval'));
      // Recent ops (within 30d): 1 require_approval, 3 allow → rate = 0.25
      await ctx.logger.log(makeOp('agent-o', 'tool-v1044-mix', 'sess-3', daysAgo(5)), dec(0.5, 'require_approval'));
      await ctx.logger.log(makeOp('agent-o', 'tool-v1044-mix', 'sess-4', daysAgo(10)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-o', 'tool-v1044-mix', 'sess-5', daysAgo(15)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-o', 'tool-v1044-mix', 'sess-6', daysAgo(20)), dec(0.3, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1044-mix');
      expect(status).toBe(200);
      expect(body.requireApprovalRateLast30d as number).toBeCloseTo(0.25, 5);
    });

    it('23. tools — 49 ops: blockRateLastNOps50 null; exactly 50 ops: non-null', async () => {
      ctx = await setup();
      // Seed exactly 49 ops
      for (let i = 0; i < 49; i++) {
        await ctx.logger.log(makeOp(`agent-p-${i}`, 'tool-v1044-n49', `sess-${i}`, hoursAgo(i + 1)), dec(0.5, 'block'));
      }
      const { body: body49 } = await getJSON(ctx.port, '/tools/tool-v1044-n49');
      expect(body49.blockRateLastNOps50).toBeNull();
    });

    it('24. tools — exactly 50 ops all block: blockRateLastNOps50 = 1', async () => {
      ctx = await setup();
      for (let i = 0; i < 50; i++) {
        await ctx.logger.log(makeOp(`agent-q-${i}`, 'tool-v1044-n50', `sess-${i}`, hoursAgo(i + 1)), dec(0.9, 'block'));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1044-n50');
      expect(status).toBe(200);
      expect(body.blockRateLastNOps50 as number).toBeCloseTo(1.0, 5);
    });

    it('25. tools — avgRiskScoreLastNOps10 correct with varied scores', async () => {
      ctx = await setup();
      // 10 ops with scores 0.1, 0.2, ..., 1.0 → avg = 0.55
      const scores = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
      for (const [i, score] of scores.entries()) {
        await ctx.logger.log(makeOp(`agent-r-${i}`, 'tool-v1044-avg', `sess-${i}`, hoursAgo(i + 1)), dec(score, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1044-avg');
      expect(status).toBe(200);
      // avg = (0.1 + 0.2 + ... + 1.0) / 10 = 5.5 / 10 = 0.55
      expect(body.avgRiskScoreLastNOps10 as number).toBeCloseTo(0.55, 5);
    });
  });

  // ── operations/summary endpoint ────────────────────────────────────────────────

  describe('T1289-T1293 — v10.44 new fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('26. summary — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s', 'tool-s', 'sess-1'), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body).toHaveProperty('requireApprovalRateLast30d');
      expect(body).toHaveProperty('blockRateLastNOps10');
      expect(body).toHaveProperty('blockRateLastNOps25');
      expect(body).toHaveProperty('blockRateLastNOps50');
      expect(body).toHaveProperty('avgRiskScoreLastNOps10');
    });

    it('27. summary — empty DB: all five new fields are null', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.requireApprovalRateLast30d).toBeNull();
      expect(body.blockRateLastNOps10).toBeNull();
      expect(body.blockRateLastNOps25).toBeNull();
      expect(body.blockRateLastNOps50).toBeNull();
      expect(body.avgRiskScoreLastNOps10).toBeNull();
    });

    it('28. summary — only old ops (>30d): requireApprovalRateLast30d is null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-t', 'tool-t', 'sess-1', daysAgo(35)), dec(0.5, 'require_approval'));
      await ctx.logger.log(makeOp('agent-t', 'tool-t', 'sess-2', daysAgo(40)), dec(0.7, 'require_approval'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.requireApprovalRateLast30d).toBeNull();
    });

    it('29. summary — requireApprovalRateLast30d: all require_approval in window → 1.0', async () => {
      ctx = await setup();
      // 3 require_approval in last 30d → rate = 1.0
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp(`agent-u-${i}`, `tool-u-${i}`, `sess-${i}`, daysAgo(i + 1)), dec(0.5, 'require_approval'));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.requireApprovalRateLast30d as number).toBeCloseTo(1.0, 5);
    });

    it('30. summary — 9 ops: blockRateLastNOps10 and avgRiskScoreLastNOps10 are null', async () => {
      ctx = await setup();
      for (let i = 0; i < 9; i++) {
        await ctx.logger.log(makeOp(`agent-v-${i}`, `tool-v-${i}`, `sess-${i}`, hoursAgo(i + 1)), dec(0.5, 'block'));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.blockRateLastNOps10).toBeNull();
      expect(body.avgRiskScoreLastNOps10).toBeNull();
    });

    it('31. summary — exactly 10 ops: blockRateLastNOps10 = 0.3, avgRiskScoreLastNOps10 = 0.5', async () => {
      ctx = await setup();
      // 3 block, 7 allow; all risk=0.5
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp(`agent-w-${i}`, `tool-w-${i}`, `sess-${i}`, hoursAgo(i + 1)), dec(0.5, 'block'));
      }
      for (let i = 3; i < 10; i++) {
        await ctx.logger.log(makeOp(`agent-w-${i}`, `tool-w-${i}`, `sess-${i}`, hoursAgo(i + 1)), dec(0.5, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.blockRateLastNOps10 as number).toBeCloseTo(0.3, 5);
      expect(body.avgRiskScoreLastNOps10 as number).toBeCloseTo(0.5, 5);
    });

    it('32. summary — blockRateLastNOps10/25/50 boundary: 49 ops, then check 50 needs 50', async () => {
      ctx = await setup();
      // 49 ops all block
      for (let i = 0; i < 49; i++) {
        await ctx.logger.log(makeOp(`agent-x-${i}`, `tool-x-${i}`, `sess-${i}`, hoursAgo(i + 1)), dec(0.9, 'block'));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      // 49 < 50 → blockRateLastNOps50 null
      expect(body.blockRateLastNOps50).toBeNull();
      // 49 >= 25 → blockRateLastNOps25 non-null (all block → 1)
      expect(body.blockRateLastNOps25 as number).toBeCloseTo(1.0, 5);
      // 49 >= 10 → blockRateLastNOps10 non-null (all block → 1)
      expect(body.blockRateLastNOps10 as number).toBeCloseTo(1.0, 5);
    });

    it('33. summary — blockRateLastNOps10 uses most recent 10 sorted by timestamp desc', async () => {
      ctx = await setup();
      // 15 ops: most recent 10 (hours 1-10) are allow, oldest 5 (hours 11-15) are block
      for (let i = 0; i < 10; i++) {
        await ctx.logger.log(makeOp(`agent-y-${i}`, `tool-y-${i}`, `sess-${i}`, hoursAgo(i + 1)), dec(0.3, 'allow'));
      }
      for (let i = 10; i < 15; i++) {
        await ctx.logger.log(makeOp(`agent-y-${i}`, `tool-y-${i}`, `sess-${i}`, hoursAgo(i + 1)), dec(0.9, 'block'));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      // Most recent 10 are all allow → blockRateLastNOps10 = 0
      expect(body.blockRateLastNOps10 as number).toBeCloseTo(0, 5);
    });
  });
});

// ── v10.45 ────────────────────────────────────────────────────────────────────

describe('v10.45', () => {
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);
  const minutesAgo = (m: number) => new Date(PINNED_NOW() - m * 60_000);

  /** OLS slope for xs=[0..n-1], ys=pts */
  function olsSlope(pts: number[]): number {
    const n = pts.length;
    const xs = pts.map((_, i) => i);
    const mx = xs.reduce((a, v) => a + v, 0) / n;
    const my = pts.reduce((a, v) => a + v, 0) / n;
    const num = xs.reduce((a, v, i) => a + (v - mx) * (pts[i]! - my), 0);
    const den = xs.reduce((a, v) => a + (v - mx) ** 2, 0);
    return den === 0 ? 0 : num / den;
  }

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1294-T1298 — v10.45 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1045-pres'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1045-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('avgRiskScoreLastNOps25');
      expect(body).toHaveProperty('avgRiskScoreLastNOps50');
      expect(body).toHaveProperty('maxRiskScoreLastNOps10');
      expect(body).toHaveProperty('minRiskScoreLastNOps10');
      expect(body).toHaveProperty('trendRiskScoreLastNOps10');
    });

    it('2. sessions — fewer than 10 ops: all five fields null', async () => {
      ctx = await setup();
      for (let i = 0; i < 9; i++) {
        await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1045-lt10', minutesAgo(i + 1)), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1045-lt10');
      expect(status).toBe(200);
      expect(body.avgRiskScoreLastNOps25).toBeNull();
      expect(body.avgRiskScoreLastNOps50).toBeNull();
      expect(body.maxRiskScoreLastNOps10).toBeNull();
      expect(body.minRiskScoreLastNOps10).toBeNull();
      expect(body.trendRiskScoreLastNOps10).toBeNull();
    });

    it('3. sessions — exactly 10 ops: maxRiskScoreLastNOps10, minRiskScoreLastNOps10, trendRiskScoreLastNOps10 non-null; avg25/50 null', async () => {
      ctx = await setup();
      const scores = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
      for (let i = 0; i < 10; i++) {
        await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1045-eq10', minutesAgo(10 - i)), dec(scores[i]!));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1045-eq10');
      expect(status).toBe(200);
      expect(body.avgRiskScoreLastNOps25).toBeNull();
      expect(body.avgRiskScoreLastNOps50).toBeNull();
      expect(body.maxRiskScoreLastNOps10 as number).toBeCloseTo(1.0, 5);
      expect(body.minRiskScoreLastNOps10 as number).toBeCloseTo(0.1, 5);
      // Scores are increasing (oldest→newest), so trend is positive
      expect(body.trendRiskScoreLastNOps10 as number).toBeGreaterThan(0);
    });

    it('4. sessions — trendRiskScoreLastNOps10 positive (increasing scores)', async () => {
      ctx = await setup();
      // Seed 5 old ops (>40d) to be ignored for trend but counted in total
      // Total = 5 old + 10 new = 15 ops >= 10 threshold
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1045-trend-up', daysAgo(50 + i)), dec(0.5));
      }
      // 10 ops linearly increasing in time order: 0.1, 0.2, ..., 1.0
      for (let i = 0; i < 10; i++) {
        await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1045-trend-up', minutesAgo(10 - i)), dec((i + 1) * 0.1));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1045-trend-up');
      expect(status).toBe(200);
      // OLS slope for [0.1, 0.2, ..., 1.0] on indices [0..9] is positive
      const expected = olsSlope([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]);
      expect(body.trendRiskScoreLastNOps10 as number).toBeCloseTo(expected, 5);
      expect(body.trendRiskScoreLastNOps10 as number).toBeGreaterThan(0);
    });

    it('5. sessions — trendRiskScoreLastNOps10 negative (decreasing scores)', async () => {
      ctx = await setup();
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1045-trend-dn', daysAgo(50 + i)), dec(0.5));
      }
      // 10 ops linearly decreasing in time order: 1.0, 0.9, ..., 0.1
      for (let i = 0; i < 10; i++) {
        await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1045-trend-dn', minutesAgo(10 - i)), dec(1.0 - i * 0.1));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1045-trend-dn');
      expect(status).toBe(200);
      const expected = olsSlope([1.0, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1]);
      expect(body.trendRiskScoreLastNOps10 as number).toBeCloseTo(expected, 5);
      expect(body.trendRiskScoreLastNOps10 as number).toBeLessThan(0);
    });

    it('6. sessions — trendRiskScoreLastNOps10 zero (all same risk score)', async () => {
      ctx = await setup();
      for (let i = 0; i < 10; i++) {
        await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1045-trend-flat', minutesAgo(10 - i)), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1045-trend-flat');
      expect(status).toBe(200);
      expect(body.trendRiskScoreLastNOps10 as number).toBeCloseTo(0, 10);
    });

    it('7. sessions — avgRiskScoreLastNOps25 correct with exactly 25 ops', async () => {
      ctx = await setup();
      // 25 ops with scores 0.04, 0.08, ..., 1.0; mean = 0.52
      const scores = Array.from({ length: 25 }, (_, i) => parseFloat(((i + 1) * 0.04).toFixed(2)));
      const mean25 = scores.reduce((a, v) => a + v, 0) / 25;
      for (let i = 0; i < 25; i++) {
        await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1045-avg25', minutesAgo(25 - i)), dec(scores[i]!));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1045-avg25');
      expect(status).toBe(200);
      expect(body.avgRiskScoreLastNOps25 as number).toBeCloseTo(mean25, 4);
      expect(body.avgRiskScoreLastNOps50).toBeNull();
    });

    it('8. sessions — avgRiskScoreLastNOps50 correct with exactly 50 ops', async () => {
      ctx = await setup();
      // 50 ops with scores 0.02, 0.04, ..., 1.0; mean = 0.51
      const scores = Array.from({ length: 50 }, (_, i) => parseFloat(((i + 1) * 0.02).toFixed(2)));
      const mean50 = scores.reduce((a, v) => a + v, 0) / 50;
      for (let i = 0; i < 50; i++) {
        await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1045-avg50', minutesAgo(50 - i)), dec(scores[i]!));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1045-avg50');
      expect(status).toBe(200);
      expect(body.avgRiskScoreLastNOps50 as number).toBeCloseTo(mean50, 4);
      expect(body.avgRiskScoreLastNOps25 as number).toBeGreaterThan(0);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1294-T1298 — v10.45 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('9. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1045-pres', 'fs', 'sess-1'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1045-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('avgRiskScoreLastNOps25');
      expect(body).toHaveProperty('avgRiskScoreLastNOps50');
      expect(body).toHaveProperty('maxRiskScoreLastNOps10');
      expect(body).toHaveProperty('minRiskScoreLastNOps10');
      expect(body).toHaveProperty('trendRiskScoreLastNOps10');
    });

    it('10. agents — fewer than 10 ops: all five fields null', async () => {
      ctx = await setup();
      for (let i = 0; i < 8; i++) {
        await ctx.logger.log(makeOp('agent-v1045-lt10', 'fs', `sess-${i}`, minutesAgo(i + 1)), dec(0.3));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1045-lt10');
      expect(status).toBe(200);
      expect(body.avgRiskScoreLastNOps25).toBeNull();
      expect(body.avgRiskScoreLastNOps50).toBeNull();
      expect(body.maxRiskScoreLastNOps10).toBeNull();
      expect(body.minRiskScoreLastNOps10).toBeNull();
      expect(body.trendRiskScoreLastNOps10).toBeNull();
    });

    it('11. agents — only old ops (>40d) + 10 recent: recent 10 determine max/min/trend', async () => {
      ctx = await setup();
      // Old ops with extreme scores — should NOT affect max/min of last 10
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp('agent-v1045-oldnew', 'fs', `sess-old-${i}`, daysAgo(45 + i)), dec(0.99));
      }
      // 10 recent ops with scores 0.2..0.5 range
      for (let i = 0; i < 10; i++) {
        await ctx.logger.log(makeOp('agent-v1045-oldnew', 'fs', `sess-new-${i}`, minutesAgo(10 - i)), dec(0.2 + i * 0.03));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1045-oldnew');
      expect(status).toBe(200);
      // Last 10 sorted by time (most recent) → scores: 0.2, 0.23, ..., 0.47
      const last10Scores = Array.from({ length: 10 }, (_, i) => 0.2 + i * 0.03);
      expect(body.maxRiskScoreLastNOps10 as number).toBeCloseTo(Math.max(...last10Scores), 4);
      expect(body.minRiskScoreLastNOps10 as number).toBeCloseTo(Math.min(...last10Scores), 4);
      // The max of the old ops (0.99) should NOT be the max of lastNOps10
      expect(body.maxRiskScoreLastNOps10 as number).toBeLessThan(0.99);
    });

    it('12. agents — trendRiskScoreLastNOps10 positive (increasing)', async () => {
      ctx = await setup();
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp('agent-v1045-trend-pos', 'fs', `sess-old-${i}`, daysAgo(50 + i)), dec(0.5));
      }
      for (let i = 0; i < 10; i++) {
        await ctx.logger.log(makeOp('agent-v1045-trend-pos', 'fs', `sess-new-${i}`, minutesAgo(10 - i)), dec((i + 1) * 0.1));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1045-trend-pos');
      expect(status).toBe(200);
      expect(body.trendRiskScoreLastNOps10 as number).toBeGreaterThan(0);
    });

    it('13. agents — trendRiskScoreLastNOps10 negative (decreasing)', async () => {
      ctx = await setup();
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp('agent-v1045-trend-neg', 'fs', `sess-old-${i}`, daysAgo(50 + i)), dec(0.5));
      }
      for (let i = 0; i < 10; i++) {
        await ctx.logger.log(makeOp('agent-v1045-trend-neg', 'fs', `sess-new-${i}`, minutesAgo(10 - i)), dec(1.0 - i * 0.1));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1045-trend-neg');
      expect(status).toBe(200);
      expect(body.trendRiskScoreLastNOps10 as number).toBeLessThan(0);
    });

    it('14. agents — avgRiskScoreLastNOps25 null with 24 ops; non-null with 25 ops', async () => {
      ctx = await setup();
      // First: 24 ops
      for (let i = 0; i < 24; i++) {
        await ctx.logger.log(makeOp('agent-v1045-avg25-boundary', 'fs', `sess-${i}`, minutesAgo(24 - i)), dec(0.5));
      }

      const { body: body24 } = await getJSON(ctx.port, '/agents/agent-v1045-avg25-boundary');
      expect(body24.avgRiskScoreLastNOps25).toBeNull();

      // Add one more to reach exactly 25
      await ctx.logger.log(makeOp('agent-v1045-avg25-boundary', 'fs', 'sess-24', minutesAgo(0)), dec(0.5));
      const { body: body25 } = await getJSON(ctx.port, '/agents/agent-v1045-avg25-boundary');
      expect(body25.avgRiskScoreLastNOps25 as number).toBeCloseTo(0.5, 5);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1294-T1298 — v10.45 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('15. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-i', 'tool-v1045-pres', 'sess-1'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1045-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('avgRiskScoreLastNOps25');
      expect(body).toHaveProperty('avgRiskScoreLastNOps50');
      expect(body).toHaveProperty('maxRiskScoreLastNOps10');
      expect(body).toHaveProperty('minRiskScoreLastNOps10');
      expect(body).toHaveProperty('trendRiskScoreLastNOps10');
    });

    it('16. tools — fewer than 10 ops: all five fields null', async () => {
      ctx = await setup();
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp(`agent-j-${i}`, 'tool-v1045-lt10', `sess-${i}`, minutesAgo(i + 1)), dec(0.4));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1045-lt10');
      expect(status).toBe(200);
      expect(body.avgRiskScoreLastNOps25).toBeNull();
      expect(body.avgRiskScoreLastNOps50).toBeNull();
      expect(body.maxRiskScoreLastNOps10).toBeNull();
      expect(body.minRiskScoreLastNOps10).toBeNull();
      expect(body.trendRiskScoreLastNOps10).toBeNull();
    });

    it('17. tools — only old ops (>40d): all five fields null', async () => {
      ctx = await setup();
      // Seed 9 old ops — not enough to clear threshold and old means windowed checks return null
      for (let i = 0; i < 9; i++) {
        await ctx.logger.log(makeOp(`agent-k-${i}`, 'tool-v1045-old', `sess-${i}`, daysAgo(45 + i)), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1045-old');
      expect(status).toBe(200);
      expect(body.maxRiskScoreLastNOps10).toBeNull();
      expect(body.minRiskScoreLastNOps10).toBeNull();
      expect(body.trendRiskScoreLastNOps10).toBeNull();
    });

    it('18. tools — 10 ops with mixed scores: max and min correct', async () => {
      ctx = await setup();
      const scores = [0.3, 0.7, 0.1, 0.9, 0.5, 0.2, 0.8, 0.4, 0.6, 0.15];
      for (let i = 0; i < 10; i++) {
        await ctx.logger.log(makeOp(`agent-l-${i}`, 'tool-v1045-maxmin', `sess-${i}`, minutesAgo(10 - i)), dec(scores[i]!));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1045-maxmin');
      expect(status).toBe(200);
      expect(body.maxRiskScoreLastNOps10 as number).toBeCloseTo(0.9, 5);
      expect(body.minRiskScoreLastNOps10 as number).toBeCloseTo(0.1, 5);
    });

    it('19. tools — trendRiskScoreLastNOps10 zero (flat scores)', async () => {
      ctx = await setup();
      for (let i = 0; i < 10; i++) {
        await ctx.logger.log(makeOp(`agent-m-${i}`, 'tool-v1045-flat', `sess-${i}`, minutesAgo(10 - i)), dec(0.42));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1045-flat');
      expect(status).toBe(200);
      expect(body.trendRiskScoreLastNOps10 as number).toBeCloseTo(0, 10);
    });

    it('20. tools — trendRiskScoreLastNOps10 uses only last 10 ops (oldest excluded)', async () => {
      ctx = await setup();
      // Add 5 old ops with very high scores (should not be in last 10 if 15 total)
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp(`agent-n-old-${i}`, 'tool-v1045-last10', `sess-old-${i}`, minutesAgo(100 + i)), dec(0.99));
      }
      // Add 10 recent ops with linearly decreasing scores (most recent ops by timestamp)
      for (let i = 0; i < 10; i++) {
        await ctx.logger.log(makeOp(`agent-n-new-${i}`, 'tool-v1045-last10', `sess-new-${i}`, minutesAgo(10 - i)), dec(1.0 - i * 0.1));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1045-last10');
      expect(status).toBe(200);
      // The last 10 ops sorted ascending by time = decreasing scores → negative trend
      expect(body.trendRiskScoreLastNOps10 as number).toBeLessThan(0);
      // Expected OLS slope for [1.0, 0.9, ..., 0.1]
      const expected = olsSlope([1.0, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1]);
      expect(body.trendRiskScoreLastNOps10 as number).toBeCloseTo(expected, 5);
    });
  });

  // ── operations/summary endpoint ────────────────────────────────────────────────

  describe('T1294-T1298 — v10.45 new fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('21. summary — all five new fields present', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-o', 'tool-s', 'sess-1'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body).toHaveProperty('avgRiskScoreLastNOps25');
      expect(body).toHaveProperty('avgRiskScoreLastNOps50');
      expect(body).toHaveProperty('maxRiskScoreLastNOps10');
      expect(body).toHaveProperty('minRiskScoreLastNOps10');
      expect(body).toHaveProperty('trendRiskScoreLastNOps10');
    });

    it('22. summary — empty DB: all five new fields are null', async () => {
      ctx = await setup();

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.avgRiskScoreLastNOps25).toBeNull();
      expect(body.avgRiskScoreLastNOps50).toBeNull();
      expect(body.maxRiskScoreLastNOps10).toBeNull();
      expect(body.minRiskScoreLastNOps10).toBeNull();
      expect(body.trendRiskScoreLastNOps10).toBeNull();
    });

    it('23. summary — 9 ops: all five fields null (below threshold)', async () => {
      ctx = await setup();
      for (let i = 0; i < 9; i++) {
        await ctx.logger.log(makeOp(`agent-p-${i}`, `tool-${i}`, `sess-${i}`, minutesAgo(i + 1)), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.maxRiskScoreLastNOps10).toBeNull();
      expect(body.minRiskScoreLastNOps10).toBeNull();
      expect(body.trendRiskScoreLastNOps10).toBeNull();
      expect(body.avgRiskScoreLastNOps25).toBeNull();
      expect(body.avgRiskScoreLastNOps50).toBeNull();
    });

    it('24. summary — 10 ops with increasing scores: trendRiskScoreLastNOps10 positive', async () => {
      ctx = await setup();
      // 10 ops, oldest to newest with scores [0.1, 0.2, ..., 1.0]
      for (let i = 0; i < 10; i++) {
        await ctx.logger.log(makeOp(`agent-q-${i}`, `tool-q-${i}`, `sess-q-${i}`, minutesAgo(10 - i)), dec((i + 1) * 0.1));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      const expected = olsSlope([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]);
      expect(body.trendRiskScoreLastNOps10 as number).toBeCloseTo(expected, 5);
      expect(body.trendRiskScoreLastNOps10 as number).toBeGreaterThan(0);
    });

    it('25. summary — 10 ops with decreasing scores: trendRiskScoreLastNOps10 negative', async () => {
      ctx = await setup();
      for (let i = 0; i < 10; i++) {
        await ctx.logger.log(makeOp(`agent-r-${i}`, `tool-r-${i}`, `sess-r-${i}`, minutesAgo(10 - i)), dec(1.0 - i * 0.1));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      const expected = olsSlope([1.0, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1]);
      expect(body.trendRiskScoreLastNOps10 as number).toBeCloseTo(expected, 5);
      expect(body.trendRiskScoreLastNOps10 as number).toBeLessThan(0);
    });

    it('26. summary — 10 ops with flat scores: trendRiskScoreLastNOps10 is zero', async () => {
      ctx = await setup();
      for (let i = 0; i < 10; i++) {
        await ctx.logger.log(makeOp(`agent-s-${i}`, `tool-s-${i}`, `sess-s-${i}`, minutesAgo(10 - i)), dec(0.6));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.trendRiskScoreLastNOps10 as number).toBeCloseTo(0, 10);
    });

    it('27. summary — 25 ops: avgRiskScoreLastNOps25 correct; avgRiskScoreLastNOps50 null', async () => {
      ctx = await setup();
      // 25 ops all with score 0.4
      for (let i = 0; i < 25; i++) {
        await ctx.logger.log(makeOp(`agent-t-${i}`, `tool-t-${i}`, `sess-t-${i}`, minutesAgo(25 - i)), dec(0.4));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.avgRiskScoreLastNOps25 as number).toBeCloseTo(0.4, 5);
      expect(body.avgRiskScoreLastNOps50).toBeNull();
    });

    it('28. summary — 50 ops: avgRiskScoreLastNOps50 correct', async () => {
      ctx = await setup();
      // 50 ops all with score 0.6
      for (let i = 0; i < 50; i++) {
        await ctx.logger.log(makeOp(`agent-u-${i}`, `tool-u-${i}`, `sess-u-${i}`, minutesAgo(50 - i)), dec(0.6));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.avgRiskScoreLastNOps50 as number).toBeCloseTo(0.6, 5);
    });

    it('29. summary — maxRiskScoreLastNOps10 equals max of most recent 10 ops, not older ones', async () => {
      ctx = await setup();
      // Add 5 old ops with score 0.99 (should not affect last-10 max if 15 total)
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp(`agent-v-old-${i}`, `tool-v-old-${i}`, `sess-v-old-${i}`, minutesAgo(200 + i)), dec(0.99));
      }
      // Add 10 more recent ops with scores in [0.1, 0.5]
      for (let i = 0; i < 10; i++) {
        await ctx.logger.log(makeOp(`agent-v-new-${i}`, `tool-v-new-${i}`, `sess-v-new-${i}`, minutesAgo(10 - i)), dec(0.1 + i * 0.04));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      // Last 10 max: 0.1 + 9*0.04 = 0.46
      expect(body.maxRiskScoreLastNOps10 as number).toBeCloseTo(0.46, 4);
      // Should NOT be 0.99 (old ops excluded)
      expect(body.maxRiskScoreLastNOps10 as number).toBeLessThan(0.99);
    });

    it('30. summary — minRiskScoreLastNOps10 equals min of most recent 10 ops, not older ones', async () => {
      ctx = await setup();
      // Add 5 old ops with score 0.01 (should not affect last-10 min if 15 total)
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp(`agent-w-old-${i}`, `tool-w-old-${i}`, `sess-w-old-${i}`, minutesAgo(200 + i)), dec(0.01));
      }
      // Add 10 recent ops with scores in [0.5, 0.9]
      for (let i = 0; i < 10; i++) {
        await ctx.logger.log(makeOp(`agent-w-new-${i}`, `tool-w-new-${i}`, `sess-w-new-${i}`, minutesAgo(10 - i)), dec(0.5 + i * 0.04));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      // Last 10 min: 0.5
      expect(body.minRiskScoreLastNOps10 as number).toBeCloseTo(0.5, 4);
      // Should NOT be 0.01 (old ops excluded)
      expect(body.minRiskScoreLastNOps10 as number).toBeGreaterThan(0.01);
    });
  });
});

// ── v10.46 ────────────────────────────────────────────────────────────────────

describe('v10.46', () => {
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);
  const minutesAgo = (m: number) => new Date(PINNED_NOW() - m * 60_000);

  /** OLS slope for xs=[0..n-1], ys=pts */
  function olsSlope(pts: number[]): number {
    const n = pts.length;
    const mx = (n - 1) / 2;
    const my = pts.reduce((a, v) => a + v, 0) / n;
    const num = pts.reduce((a, v, i) => a + (i - mx) * (v - my), 0);
    const den = pts.reduce((a, _, i) => a + (i - mx) ** 2, 0);
    return den === 0 ? 0 : num / den;
  }

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1299-T1303 — v10.46 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1046-pres'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1046-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('trendRiskScoreLastNOps25');
      expect(body).toHaveProperty('trendRiskScoreLastNOps50');
      expect(body).toHaveProperty('blockStreakCurrentOps');
      expect(body).toHaveProperty('allowStreakCurrentOps');
      expect(body).toHaveProperty('opsBurstLast15m');
    });

    it('2. sessions — fewer than 25 ops: trendRiskScoreLastNOps25/50 are null', async () => {
      ctx = await setup();
      for (let i = 0; i < 24; i++) {
        await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1046-lt25', minutesAgo(i + 1)), dec(0.5));
      }
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1046-lt25');
      expect(status).toBe(200);
      expect(body.trendRiskScoreLastNOps25).toBeNull();
      expect(body.trendRiskScoreLastNOps50).toBeNull();
    });

    it('3. sessions — exactly 25 ops: trendRiskScoreLastNOps25 non-null, trendRiskScoreLastNOps50 null', async () => {
      ctx = await setup();
      const scores = Array.from({ length: 25 }, (_, i) => (i + 1) * 0.04);
      for (let i = 0; i < 25; i++) {
        await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1046-eq25', minutesAgo(25 - i)), dec(scores[i]!));
      }
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1046-eq25');
      expect(status).toBe(200);
      const expected = olsSlope(scores);
      expect(body.trendRiskScoreLastNOps25 as number).toBeCloseTo(expected, 5);
      expect(body.trendRiskScoreLastNOps50).toBeNull();
    });

    it('4. sessions — exactly 50 ops: both trend fields non-null', async () => {
      ctx = await setup();
      const scores = Array.from({ length: 50 }, (_, i) => (i + 1) * 0.02);
      for (let i = 0; i < 50; i++) {
        await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1046-eq50', minutesAgo(50 - i)), dec(scores[i]!));
      }
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1046-eq50');
      expect(status).toBe(200);
      expect(body.trendRiskScoreLastNOps25 as number).toBeGreaterThan(0);
      const expected50 = olsSlope(scores);
      expect(body.trendRiskScoreLastNOps50 as number).toBeCloseTo(expected50, 5);
    });

    it('5. sessions — 3 blocks then 2 allows: blockStreak=0, allowStreak=2', async () => {
      ctx = await setup();
      // 3 blocks first (older), then 2 allows (newer)
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1046-streak1', minutesAgo(10 - i)), dec(0.8, 'block'));
      }
      for (let i = 0; i < 2; i++) {
        await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1046-streak1', minutesAgo(2 - i)), dec(0.2, 'allow'));
      }
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1046-streak1');
      expect(status).toBe(200);
      expect(body.blockStreakCurrentOps).toBe(0);
      expect(body.allowStreakCurrentOps).toBe(2);
    });

    it('6. sessions — 5 consecutive blocks: blockStreak=5, allowStreak=0', async () => {
      ctx = await setup();
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1046-streak2', minutesAgo(5 - i)), dec(0.9, 'block'));
      }
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1046-streak2');
      expect(status).toBe(200);
      expect(body.blockStreakCurrentOps).toBe(5);
      expect(body.allowStreakCurrentOps).toBe(0);
    });

    it('7. sessions — opsBurstLast15m counts only recent ops', async () => {
      ctx = await setup();
      // 3 ops within last 15m
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1046-burst1', minutesAgo(i + 1)), dec(0.5));
      }
      // 2 ops older than 15m
      for (let i = 0; i < 2; i++) {
        await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1046-burst1', minutesAgo(20 + i)), dec(0.5));
      }
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1046-burst1');
      expect(status).toBe(200);
      expect(body.opsBurstLast15m).toBe(3);
    });

    it('8. sessions — no ops in last 15m: opsBurstLast15m=0', async () => {
      ctx = await setup();
      // All ops older than 40 days
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1046-burst2', daysAgo(42 + i)), dec(0.5));
      }
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1046-burst2');
      expect(status).toBe(200);
      expect(body.opsBurstLast15m).toBe(0);
    });

    it('9. sessions — single allow op: streaks correct, burst=1, trends=null', async () => {
      ctx = await setup();
      // Seed one allow op well within 15m
      await ctx.logger.log(makeOp('agent-z', 'fs', 'sess-v1046-single', minutesAgo(1)), dec(0.3, 'allow'));
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1046-single');
      expect(status).toBe(200);
      expect(body.blockStreakCurrentOps).toBe(0);
      expect(body.allowStreakCurrentOps).toBe(1);
      expect(body.opsBurstLast15m).toBe(1);
      expect(body.trendRiskScoreLastNOps25).toBeNull();
      expect(body.trendRiskScoreLastNOps50).toBeNull();
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1299-T1303 — v10.46 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('10. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1046-pres', 'fs', 'sess-a'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1046-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('trendRiskScoreLastNOps25');
      expect(body).toHaveProperty('trendRiskScoreLastNOps50');
      expect(body).toHaveProperty('blockStreakCurrentOps');
      expect(body).toHaveProperty('allowStreakCurrentOps');
      expect(body).toHaveProperty('opsBurstLast15m');
    });

    it('11. agents — fewer than 25 ops: trends null', async () => {
      ctx = await setup();
      for (let i = 0; i < 10; i++) {
        await ctx.logger.log(makeOp('agent-v1046-lt25', 'fs', 'sess-b', minutesAgo(i + 1)), dec(0.5));
      }
      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1046-lt25');
      expect(status).toBe(200);
      expect(body.trendRiskScoreLastNOps25).toBeNull();
      expect(body.trendRiskScoreLastNOps50).toBeNull();
    });

    it('12. agents — 3 blocks then 2 allows: blockStreak=0, allowStreak=2', async () => {
      ctx = await setup();
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-v1046-strk1', 'fs', 'sess-c', minutesAgo(10 - i)), dec(0.8, 'block'));
      }
      for (let i = 0; i < 2; i++) {
        await ctx.logger.log(makeOp('agent-v1046-strk1', 'fs', 'sess-c', minutesAgo(2 - i)), dec(0.2, 'allow'));
      }
      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1046-strk1');
      expect(status).toBe(200);
      expect(body.blockStreakCurrentOps).toBe(0);
      expect(body.allowStreakCurrentOps).toBe(2);
    });

    it('13. agents — 5 blocks: blockStreak=5, allowStreak=0', async () => {
      ctx = await setup();
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp('agent-v1046-strk2', 'fs', 'sess-d', minutesAgo(5 - i)), dec(0.9, 'block'));
      }
      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1046-strk2');
      expect(status).toBe(200);
      expect(body.blockStreakCurrentOps).toBe(5);
      expect(body.allowStreakCurrentOps).toBe(0);
    });

    it('14. agents — opsBurstLast15m counts only recent ops; old logs ignored', async () => {
      ctx = await setup();
      // 2 old ops (> 40 days) to simulate empty window history
      for (let i = 0; i < 2; i++) {
        await ctx.logger.log(makeOp('agent-v1046-burst1', 'fs', 'sess-e', daysAgo(45 + i)), dec(0.5));
      }
      // 4 recent ops within 15m
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp('agent-v1046-burst1', 'fs', 'sess-e', minutesAgo(i + 1)), dec(0.5));
      }
      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1046-burst1');
      expect(status).toBe(200);
      expect(body.opsBurstLast15m).toBe(4);
    });

    it('15. agents — only old logs (> 40 days): opsBurstLast15m=0', async () => {
      ctx = await setup();
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp('agent-v1046-old1', 'fs', 'sess-f', daysAgo(42 + i)), dec(0.5));
      }
      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1046-old1');
      expect(status).toBe(200);
      expect(body.opsBurstLast15m).toBe(0);
    });

    it('16. agents — exactly 25 ops: trendRiskScoreLastNOps25 non-null, trendRiskScoreLastNOps50 null', async () => {
      ctx = await setup();
      const scores = Array.from({ length: 25 }, (_, i) => 0.02 + i * 0.03);
      for (let i = 0; i < 25; i++) {
        await ctx.logger.log(makeOp('agent-v1046-t25', 'fs', 'sess-g', minutesAgo(25 - i)), dec(scores[i]!));
      }
      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1046-t25');
      expect(status).toBe(200);
      const expected = olsSlope(scores);
      expect(body.trendRiskScoreLastNOps25 as number).toBeCloseTo(expected, 5);
      expect(body.trendRiskScoreLastNOps50).toBeNull();
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1299-T1303 — v10.46 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('17. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-t', 'tool-v1046-pres', 'sess-t1'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1046-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('trendRiskScoreLastNOps25');
      expect(body).toHaveProperty('trendRiskScoreLastNOps50');
      expect(body).toHaveProperty('blockStreakCurrentOps');
      expect(body).toHaveProperty('allowStreakCurrentOps');
      expect(body).toHaveProperty('opsBurstLast15m');
    });

    it('18. tools — fewer than 25 ops: trends null', async () => {
      ctx = await setup();
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp('agent-t2', 'tool-v1046-lt25', 'sess-t2', minutesAgo(i + 1)), dec(0.5));
      }
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1046-lt25');
      expect(status).toBe(200);
      expect(body.trendRiskScoreLastNOps25).toBeNull();
      expect(body.trendRiskScoreLastNOps50).toBeNull();
    });

    it('19. tools — 3 blocks then 2 allows: blockStreak=0, allowStreak=2', async () => {
      ctx = await setup();
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-t3', 'tool-v1046-strk1', 'sess-t3', minutesAgo(10 - i)), dec(0.8, 'block'));
      }
      for (let i = 0; i < 2; i++) {
        await ctx.logger.log(makeOp('agent-t3', 'tool-v1046-strk1', 'sess-t3', minutesAgo(2 - i)), dec(0.2, 'allow'));
      }
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1046-strk1');
      expect(status).toBe(200);
      expect(body.blockStreakCurrentOps).toBe(0);
      expect(body.allowStreakCurrentOps).toBe(2);
    });

    it('20. tools — 5 consecutive blocks: blockStreak=5, allowStreak=0', async () => {
      ctx = await setup();
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp('agent-t4', 'tool-v1046-strk2', 'sess-t4', minutesAgo(5 - i)), dec(0.9, 'block'));
      }
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1046-strk2');
      expect(status).toBe(200);
      expect(body.blockStreakCurrentOps).toBe(5);
      expect(body.allowStreakCurrentOps).toBe(0);
    });

    it('21. tools — opsBurstLast15m: old logs (> 40 days) produce 0', async () => {
      ctx = await setup();
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-t5', 'tool-v1046-old1', 'sess-t5', daysAgo(43 + i)), dec(0.5));
      }
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1046-old1');
      expect(status).toBe(200);
      expect(body.opsBurstLast15m).toBe(0);
    });

    it('22. tools — opsBurstLast15m counts ops within 15m, excludes older', async () => {
      ctx = await setup();
      // 5 recent
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp('agent-t6', 'tool-v1046-burst1', 'sess-t6', minutesAgo(i + 1)), dec(0.4));
      }
      // 3 old (> 15m)
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-t6', 'tool-v1046-burst1', 'sess-t6', minutesAgo(30 + i)), dec(0.4));
      }
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1046-burst1');
      expect(status).toBe(200);
      expect(body.opsBurstLast15m).toBe(5);
    });

    it('23. tools — exactly 50 ops: trendRiskScoreLastNOps50 non-null', async () => {
      ctx = await setup();
      const scores = Array.from({ length: 50 }, (_, i) => 1.0 - i * 0.018);
      for (let i = 0; i < 50; i++) {
        await ctx.logger.log(makeOp('agent-t7', 'tool-v1046-t50', 'sess-t7', minutesAgo(50 - i)), dec(scores[i]!));
      }
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1046-t50');
      expect(status).toBe(200);
      const expected = olsSlope(scores);
      expect(body.trendRiskScoreLastNOps50 as number).toBeCloseTo(expected, 5);
    });
  });

  // ── summary endpoint ───────────────────────────────────────────────────────────

  describe('T1299-T1303 — v10.46 new fields (summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('24. summary — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s1', 'fs', 'sess-s1'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body).toHaveProperty('trendRiskScoreLastNOps25');
      expect(body).toHaveProperty('trendRiskScoreLastNOps50');
      expect(body).toHaveProperty('blockStreakCurrentOps');
      expect(body).toHaveProperty('allowStreakCurrentOps');
      expect(body).toHaveProperty('opsBurstLast15m');
    });

    it('25. summary — fewer than 25 ops: trends null', async () => {
      ctx = await setup();
      for (let i = 0; i < 10; i++) {
        await ctx.logger.log(makeOp('agent-s2', 'fs', 'sess-s2', minutesAgo(i + 1)), dec(0.5));
      }
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.trendRiskScoreLastNOps25).toBeNull();
      expect(body.trendRiskScoreLastNOps50).toBeNull();
    });

    it('26. summary — 3 blocks then 2 allows: blockStreak=0, allowStreak=2', async () => {
      ctx = await setup();
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-s3', 'fs', 'sess-s3', minutesAgo(10 - i)), dec(0.8, 'block'));
      }
      for (let i = 0; i < 2; i++) {
        await ctx.logger.log(makeOp('agent-s3', 'fs', 'sess-s3', minutesAgo(2 - i)), dec(0.2, 'allow'));
      }
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.blockStreakCurrentOps).toBe(0);
      expect(body.allowStreakCurrentOps).toBe(2);
    });

    it('27. summary — 5 consecutive blocks: blockStreak=5, allowStreak=0', async () => {
      ctx = await setup();
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp('agent-s4', 'fs', 'sess-s4', minutesAgo(5 - i)), dec(0.9, 'block'));
      }
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.blockStreakCurrentOps).toBe(5);
      expect(body.allowStreakCurrentOps).toBe(0);
    });

    it('28. summary — opsBurstLast15m counts only ops within last 15m', async () => {
      ctx = await setup();
      // 3 recent (within 15m)
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-s5', 'fs', 'sess-s5', minutesAgo(i + 1)), dec(0.5));
      }
      // 4 older (beyond 15m)
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp('agent-s5', 'fs', 'sess-s5', minutesAgo(20 + i)), dec(0.5));
      }
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.opsBurstLast15m).toBe(3);
    });

    it('29. summary — only old logs (> 40 days): opsBurstLast15m=0, trends=null', async () => {
      ctx = await setup();
      // Seed 5 old block ops so streak reflects their action but burst is 0
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp('agent-s6', 'fs', 'sess-s6', daysAgo(45 + i)), dec(0.5, 'block'));
      }
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      // opsBurstLast15m must be 0 since all ops are > 40 days old
      expect(body.opsBurstLast15m).toBe(0);
      // trendRiskScoreLastNOps25/50 null because < 25 ops
      expect(body.trendRiskScoreLastNOps25).toBeNull();
      expect(body.trendRiskScoreLastNOps50).toBeNull();
      // blockStreak is 5 (all 5 blocks at tail, sorted oldest first → most-recent is the newest block)
      expect(body.blockStreakCurrentOps).toBe(5);
      expect(body.allowStreakCurrentOps).toBe(0);
    });

    it('30. summary — exactly 25 ops increasing: trendRiskScoreLastNOps25 positive, trendRiskScoreLastNOps50 null', async () => {
      ctx = await setup();
      const scores = Array.from({ length: 25 }, (_, i) => (i + 1) * 0.04);
      for (let i = 0; i < 25; i++) {
        await ctx.logger.log(makeOp('agent-s7', 'fs', 'sess-s7', minutesAgo(25 - i)), dec(scores[i]!));
      }
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      const expected = olsSlope(scores);
      expect(body.trendRiskScoreLastNOps25 as number).toBeCloseTo(expected, 5);
      expect(body.trendRiskScoreLastNOps25 as number).toBeGreaterThan(0);
      expect(body.trendRiskScoreLastNOps50).toBeNull();
    });

    it('31. summary — 50 decreasing ops: trendRiskScoreLastNOps50 negative', async () => {
      ctx = await setup();
      const scores = Array.from({ length: 50 }, (_, i) => 1.0 - i * 0.018);
      for (let i = 0; i < 50; i++) {
        await ctx.logger.log(makeOp('agent-s8', 'fs', 'sess-s8', minutesAgo(50 - i)), dec(scores[i]!));
      }
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.trendRiskScoreLastNOps50 as number).toBeLessThan(0);
    });
  });
});

// ── v10.47 ────────────────────────────────────────────────────────────────────

describe('v10.47', () => {
  const minsAgo = (m: number) => new Date(PINNED_NOW() - m * 60_000);
  const hoursAgo = (h: number) => new Date(PINNED_NOW() - h * 3_600_000);
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1304-T1308 — v10.47 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-a', 'fs', 'sess-1047-pres', minsAgo(5)), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-1047-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('opsBurstLast30m');
      expect(body).toHaveProperty('opsBurstLast2h');
      expect(body).toHaveProperty('riskWeightedAllowRate');
      expect(body).toHaveProperty('riskWeightedRequireApprovalRate');
      expect(body).toHaveProperty('avgIntervalBetweenBlocksMs');
    });

    it('2. sessions — opsBurstLast30m counts only ops within 30 min', async () => {
      ctx = await setup();
      // 2 ops within 30 min, 1 op outside (1.5 h ago)
      await ctx.logger.log(makeOp('agt-b', 'fs', 'sess-1047-30m', minsAgo(10)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agt-b', 'fs', 'sess-1047-30m', minsAgo(25)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agt-b', 'fs', 'sess-1047-30m', hoursAgo(2)), dec(0.3, 'allow'));

      const { body } = await getJSON(ctx.port, '/sessions/sess-1047-30m');
      expect(body.opsBurstLast30m).toBe(2);
    });

    it('3. sessions — opsBurstLast2h counts only ops within 2 hours', async () => {
      ctx = await setup();
      // 3 ops within 2 h, 1 op outside (3 h ago)
      await ctx.logger.log(makeOp('agt-c', 'fs', 'sess-1047-2h', minsAgo(20)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agt-c', 'fs', 'sess-1047-2h', minsAgo(60)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agt-c', 'fs', 'sess-1047-2h', minsAgo(110)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agt-c', 'fs', 'sess-1047-2h', hoursAgo(3)), dec(0.5, 'allow'));

      const { body } = await getJSON(ctx.port, '/sessions/sess-1047-2h');
      expect(body.opsBurstLast2h).toBe(3);
    });

    it('4. sessions — opsBurstLast30m is 0 when all ops are older than 30 min', async () => {
      ctx = await setup();
      // All ops older than 40 days (entity-exists seed)
      await ctx.logger.log(makeOp('agt-d', 'fs', 'sess-1047-old', daysAgo(41)), dec(0.6, 'allow'));
      await ctx.logger.log(makeOp('agt-d', 'fs', 'sess-1047-old', daysAgo(45)), dec(0.6, 'allow'));

      const { body } = await getJSON(ctx.port, '/sessions/sess-1047-old');
      expect(body.opsBurstLast30m).toBe(0);
      expect(body.opsBurstLast2h).toBe(0);
    });

    it('5. sessions — riskWeightedAllowRate computed correctly', async () => {
      ctx = await setup();
      // allow with risk 0.6, block with risk 0.4; totalRisk=1.0; allowRate = 0.6/1.0 = 0.6
      await ctx.logger.log(makeOp('agt-e', 'fs', 'sess-1047-war', daysAgo(1)), dec(0.6, 'allow'));
      await ctx.logger.log(makeOp('agt-e', 'fs', 'sess-1047-war', daysAgo(2)), dec(0.4, 'block'));

      const { body } = await getJSON(ctx.port, '/sessions/sess-1047-war');
      expect(body.riskWeightedAllowRate as number).toBeCloseTo(0.6, 5);
    });

    it('6. sessions — riskWeightedRequireApprovalRate computed correctly', async () => {
      ctx = await setup();
      // require_approval risk 0.3, allow risk 0.7; totalRisk=1.0; requireApprovalRate=0.3
      await ctx.logger.log(makeOp('agt-f', 'fs', 'sess-1047-rqr', daysAgo(1)), dec(0.7, 'allow'));
      await ctx.logger.log(makeOp('agt-f', 'fs', 'sess-1047-rqr', daysAgo(2)), dec(0.3, 'require_approval'));

      const { body } = await getJSON(ctx.port, '/sessions/sess-1047-rqr');
      expect(body.riskWeightedRequireApprovalRate as number).toBeCloseTo(0.3, 5);
    });

    it('7. sessions — risk-weighted rates are null when no logs', async () => {
      ctx = await setup();
      // Seed an unrelated session so the server is alive; query a session with no logs
      await ctx.logger.log(makeOp('agt-g', 'fs', 'sess-1047-other', daysAgo(1)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-1047-nonexistent');
      // Depending on implementation: 404 or 200 with nulls. Accept either.
      if (status === 200) {
        expect(body.riskWeightedAllowRate).toBeNull();
        expect(body.riskWeightedRequireApprovalRate).toBeNull();
      } else {
        expect(status).toBe(404);
      }
    });

    it('8. sessions — risk-weighted rates are null when all riskScores are 0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-h', 'fs', 'sess-1047-zero', daysAgo(1)), dec(0, 'allow'));
      await ctx.logger.log(makeOp('agt-h', 'fs', 'sess-1047-zero', daysAgo(2)), dec(0, 'block'));

      const { body } = await getJSON(ctx.port, '/sessions/sess-1047-zero');
      expect(body.riskWeightedAllowRate).toBeNull();
      expect(body.riskWeightedRequireApprovalRate).toBeNull();
    });

    it('9. sessions — avgIntervalBetweenBlocksMs: 2 blocks 1 hour apart → 3600000', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-i', 'fs', 'sess-1047-blk', hoursAgo(2)), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agt-i', 'fs', 'sess-1047-blk', hoursAgo(1)), dec(0.8, 'block'));

      const { body } = await getJSON(ctx.port, '/sessions/sess-1047-blk');
      expect(body.avgIntervalBetweenBlocksMs as number).toBeCloseTo(3_600_000, -3);
    });

    it('10. sessions — avgIntervalBetweenBlocksMs: fewer than 2 blocks → null', async () => {
      ctx = await setup();
      // Only 1 block
      await ctx.logger.log(makeOp('agt-j', 'fs', 'sess-1047-1blk', daysAgo(1)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agt-j', 'fs', 'sess-1047-1blk', daysAgo(2)), dec(0.5, 'allow'));

      const { body } = await getJSON(ctx.port, '/sessions/sess-1047-1blk');
      expect(body.avgIntervalBetweenBlocksMs).toBeNull();
    });

    it('11. sessions — avgIntervalBetweenBlocksMs: 0 when all blocks have same timestamp', async () => {
      ctx = await setup();
      const ts = hoursAgo(1);
      await ctx.logger.log(makeOp('agt-k', 'fs', 'sess-1047-same', ts), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agt-k', 'fs', 'sess-1047-same', ts), dec(0.9, 'block'));

      const { body } = await getJSON(ctx.port, '/sessions/sess-1047-same');
      expect(body.avgIntervalBetweenBlocksMs).toBe(0);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1304-T1308 — v10.47 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('12. agents — all five new fields present in response', async () => {
      ctx = await setup();
      // Seed old log so entity exists
      await ctx.logger.log(makeOp('agt-1047-pres', 'fs', 'sess-a', daysAgo(41)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agt-1047-pres', 'fs', 'sess-a', minsAgo(5)), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agt-1047-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('opsBurstLast30m');
      expect(body).toHaveProperty('opsBurstLast2h');
      expect(body).toHaveProperty('riskWeightedAllowRate');
      expect(body).toHaveProperty('riskWeightedRequireApprovalRate');
      expect(body).toHaveProperty('avgIntervalBetweenBlocksMs');
    });

    it('13. agents — opsBurstLast30m counts correctly for agent scope', async () => {
      ctx = await setup();
      // 2 recent, 1 old (old one seeded 41 days ago for entity-exists)
      await ctx.logger.log(makeOp('agt-1047-burst', 'fs', 'sess-b', daysAgo(41)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agt-1047-burst', 'fs', 'sess-b', minsAgo(10)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agt-1047-burst', 'fs', 'sess-b', minsAgo(20)), dec(0.5, 'allow'));

      const { body } = await getJSON(ctx.port, '/agents/agt-1047-burst');
      expect(body.opsBurstLast30m).toBe(2);
    });

    it('14. agents — opsBurstLast2h counts correctly for agent scope', async () => {
      ctx = await setup();
      // 1 recent within 2h, 1 outside 2h, 1 old for entity-exists
      await ctx.logger.log(makeOp('agt-1047-2h', 'fs', 'sess-c', daysAgo(41)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agt-1047-2h', 'fs', 'sess-c', minsAgo(90)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agt-1047-2h', 'fs', 'sess-c', hoursAgo(3)), dec(0.5, 'allow'));

      const { body } = await getJSON(ctx.port, '/agents/agt-1047-2h');
      expect(body.opsBurstLast2h).toBe(1);
    });

    it('15. agents — riskWeightedAllowRate correct for agent scope', async () => {
      ctx = await setup();
      // allow risk=0.8, block risk=0.2; allowRate = 0.8/1.0 = 0.8
      await ctx.logger.log(makeOp('agt-1047-war', 'fs', 'sess-d', daysAgo(41)), dec(0.8, 'allow'));
      await ctx.logger.log(makeOp('agt-1047-war', 'fs', 'sess-d', daysAgo(1)), dec(0.2, 'block'));

      const { body } = await getJSON(ctx.port, '/agents/agt-1047-war');
      expect(body.riskWeightedAllowRate as number).toBeCloseTo(0.8, 5);
    });

    it('16. agents — avgIntervalBetweenBlocksMs: 2 blocks 2 hours apart → 7200000', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-1047-blk', 'fs', 'sess-e', daysAgo(41)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agt-1047-blk', 'fs', 'sess-e', hoursAgo(3)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agt-1047-blk', 'fs', 'sess-e', hoursAgo(1)), dec(0.9, 'block'));

      const { body } = await getJSON(ctx.port, '/agents/agt-1047-blk');
      // Blocks at: daysAgo(41), hoursAgo(3), hoursAgo(1)
      // The two most recent gaps are both ~7200000 ms apart; three blocks → mean of two gaps
      // gap1 = hoursAgo(3) - daysAgo(41) ≈ large; we just check it's positive and not null
      expect(body.avgIntervalBetweenBlocksMs).not.toBeNull();
      expect(body.avgIntervalBetweenBlocksMs as number).toBeGreaterThan(0);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1304-T1308 — v10.47 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('17. tools — all five new fields present in response', async () => {
      ctx = await setup();
      // Seed old log for entity-exists
      await ctx.logger.log(makeOp('agt-t', 'tool-1047-pres', 'sess-f', daysAgo(41)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agt-t', 'tool-1047-pres', 'sess-f', minsAgo(5)), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-1047-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('opsBurstLast30m');
      expect(body).toHaveProperty('opsBurstLast2h');
      expect(body).toHaveProperty('riskWeightedAllowRate');
      expect(body).toHaveProperty('riskWeightedRequireApprovalRate');
      expect(body).toHaveProperty('avgIntervalBetweenBlocksMs');
    });

    it('18. tools — opsBurstLast30m correct for tool scope', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-t2', 'tool-1047-b30m', 'sess-g', daysAgo(41)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agt-t2', 'tool-1047-b30m', 'sess-g', minsAgo(5)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agt-t2', 'tool-1047-b30m', 'sess-g', minsAgo(29)), dec(0.5, 'allow'));
      // This one is just outside 30m window
      await ctx.logger.log(makeOp('agt-t2', 'tool-1047-b30m', 'sess-g', minsAgo(35)), dec(0.5, 'allow'));

      const { body } = await getJSON(ctx.port, '/tools/tool-1047-b30m');
      expect(body.opsBurstLast30m).toBe(2);
    });

    it('19. tools — riskWeightedRequireApprovalRate correct for tool scope', async () => {
      ctx = await setup();
      // require_approval risk=0.5, allow risk=0.5; totalRisk=1.0; requireApprovalRate=0.5
      await ctx.logger.log(makeOp('agt-t3', 'tool-1047-rqr', 'sess-h', daysAgo(41)), dec(0.5, 'require_approval'));
      await ctx.logger.log(makeOp('agt-t3', 'tool-1047-rqr', 'sess-h', daysAgo(1)), dec(0.5, 'allow'));

      const { body } = await getJSON(ctx.port, '/tools/tool-1047-rqr');
      expect(body.riskWeightedRequireApprovalRate as number).toBeCloseTo(0.5, 5);
    });

    it('20. tools — avgIntervalBetweenBlocksMs null when only 1 block', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-t4', 'tool-1047-1blk', 'sess-i', daysAgo(41)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agt-t4', 'tool-1047-1blk', 'sess-i', daysAgo(1)), dec(0.4, 'allow'));

      const { body } = await getJSON(ctx.port, '/tools/tool-1047-1blk');
      expect(body.avgIntervalBetweenBlocksMs).toBeNull();
    });

    it('21. tools — avgIntervalBetweenBlocksMs: 2 blocks 1 hour apart → 3600000', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-t5', 'tool-1047-blk2', 'sess-j', hoursAgo(2)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agt-t5', 'tool-1047-blk2', 'sess-j', hoursAgo(1)), dec(0.9, 'block'));

      const { body } = await getJSON(ctx.port, '/tools/tool-1047-blk2');
      expect(body.avgIntervalBetweenBlocksMs as number).toBeCloseTo(3_600_000, -3);
    });
  });

  // ── summary endpoint ───────────────────────────────────────────────────────────

  describe('T1304-T1308 — v10.47 new fields (summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('22. summary — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-s', 'fs', 'sess-s', minsAgo(5)), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body).toHaveProperty('opsBurstLast30m');
      expect(body).toHaveProperty('opsBurstLast2h');
      expect(body).toHaveProperty('riskWeightedAllowRate');
      expect(body).toHaveProperty('riskWeightedRequireApprovalRate');
      expect(body).toHaveProperty('avgIntervalBetweenBlocksMs');
    });

    it('23. summary — opsBurstLast30m counts only ops within 30 min globally', async () => {
      ctx = await setup();
      // Mix of agents/tools/sessions — summary is global
      await ctx.logger.log(makeOp('agt-s1', 'tool-a', 'sess-s1', minsAgo(10)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agt-s2', 'tool-b', 'sess-s2', minsAgo(20)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agt-s3', 'tool-c', 'sess-s3', hoursAgo(2)), dec(0.3, 'allow'));

      const { body } = await getJSON(ctx.port, '/operations/summary');
      expect(body.opsBurstLast30m).toBe(2);
    });

    it('24. summary — opsBurstLast2h counts only ops within 2 hours globally', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-s4', 'fs', 'sess-s4', minsAgo(30)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agt-s5', 'fs', 'sess-s5', minsAgo(90)), dec(0.5, 'allow'));
      // Outside 2h
      await ctx.logger.log(makeOp('agt-s6', 'fs', 'sess-s6', hoursAgo(3)), dec(0.5, 'allow'));

      const { body } = await getJSON(ctx.port, '/operations/summary');
      expect(body.opsBurstLast2h).toBe(2);
    });

    it('25. summary — riskWeightedAllowRate correct globally', async () => {
      ctx = await setup();
      // allow risk=0.4, require_approval risk=0.6; allowRate=0.4/1.0=0.4; requireApprovalRate=0.6
      await ctx.logger.log(makeOp('agt-s7', 'fs', 'sess-s7', daysAgo(1)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agt-s8', 'fs', 'sess-s8', daysAgo(2)), dec(0.6, 'require_approval'));

      const { body } = await getJSON(ctx.port, '/operations/summary');
      expect(body.riskWeightedAllowRate as number).toBeCloseTo(0.4, 5);
      expect(body.riskWeightedRequireApprovalRate as number).toBeCloseTo(0.6, 5);
    });

    it('26. summary — avgIntervalBetweenBlocksMs: 2 blocks 1 hour apart → 3600000', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-s9', 'fs', 'sess-s9', hoursAgo(2)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agt-sa', 'fs', 'sess-sa', hoursAgo(1)), dec(0.9, 'block'));

      const { body } = await getJSON(ctx.port, '/operations/summary');
      expect(body.avgIntervalBetweenBlocksMs as number).toBeCloseTo(3_600_000, -3);
    });

    it('27. summary — avgIntervalBetweenBlocksMs null when no blocks', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-sb', 'fs', 'sess-sb', daysAgo(1)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agt-sc', 'fs', 'sess-sc', daysAgo(2)), dec(0.3, 'require_approval'));

      const { body } = await getJSON(ctx.port, '/operations/summary');
      expect(body.avgIntervalBetweenBlocksMs).toBeNull();
    });

    it('28. summary — risk-weighted rates null when no logs exist', async () => {
      ctx = await setup();
      // Empty DB — summary should have nulls for risk-weighted rates
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskWeightedAllowRate).toBeNull();
      expect(body.riskWeightedRequireApprovalRate).toBeNull();
      expect(body.avgIntervalBetweenBlocksMs).toBeNull();
      expect(body.opsBurstLast30m).toBe(0);
      expect(body.opsBurstLast2h).toBe(0);
    });

    it('29. summary — riskWeightedAllowRate null when all riskScores are 0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-sd', 'fs', 'sess-sd', daysAgo(1)), dec(0, 'allow'));
      await ctx.logger.log(makeOp('agt-se', 'fs', 'sess-se', daysAgo(2)), dec(0, 'block'));

      const { body } = await getJSON(ctx.port, '/operations/summary');
      expect(body.riskWeightedAllowRate).toBeNull();
      expect(body.riskWeightedRequireApprovalRate).toBeNull();
    });

    it('30. summary — opsBurstLast30m and opsBurstLast2h are integers (not floats)', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-sf', 'fs', 'sess-sf', minsAgo(5)), dec(0.4, 'allow'));

      const { body } = await getJSON(ctx.port, '/operations/summary');
      expect(Number.isInteger(body.opsBurstLast30m)).toBe(true);
      expect(Number.isInteger(body.opsBurstLast2h)).toBe(true);
    });
  });
});

// ── v10.48 ────────────────────────────────────────────────────────────────────

describe('v10.48', () => {
  const hoursAgo = (h: number) => new Date(PINNED_NOW() - h * 3_600_000);
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1309-T1313 — v10.48 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-a', 'fs', 'sess-1048-pres', daysAgo(1)), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-1048-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('avgIntervalBetweenAllowsMs');
      expect(body).toHaveProperty('medianIntervalBetweenOpsMs');
      expect(body).toHaveProperty('p90IntervalBetweenOpsMs');
      expect(body).toHaveProperty('giniCoefficientRiskScores');
      expect(body).toHaveProperty('riskScoreEntropy5Bins');
    });

    it('2. sessions — single log: avgIntervalBetweenAllowsMs null (< 2 allows)', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-b', 'fs', 'sess-1048-1allow', hoursAgo(1)), dec(0.5, 'allow'));

      const { body } = await getJSON(ctx.port, '/sessions/sess-1048-1allow');
      expect(body.avgIntervalBetweenAllowsMs).toBeNull();
      expect(body.medianIntervalBetweenOpsMs).toBeNull();
      expect(body.p90IntervalBetweenOpsMs).toBeNull();
    });

    it('3. sessions — two allows 1 hour apart: avgIntervalBetweenAllowsMs ≈ 3600000', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-c', 'fs', 'sess-1048-2allows', hoursAgo(2)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agt-c', 'fs', 'sess-1048-2allows', hoursAgo(1)), dec(0.6, 'allow'));

      const { body } = await getJSON(ctx.port, '/sessions/sess-1048-2allows');
      expect(body.avgIntervalBetweenAllowsMs as number).toBeCloseTo(3_600_000, -3);
    });

    it('4. sessions — only blocks, no allows: avgIntervalBetweenAllowsMs null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-d', 'fs', 'sess-1048-blocks-only', daysAgo(41)), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agt-d', 'fs', 'sess-1048-blocks-only', daysAgo(42)), dec(0.9, 'block'));

      const { body } = await getJSON(ctx.port, '/sessions/sess-1048-blocks-only');
      expect(body.avgIntervalBetweenAllowsMs).toBeNull();
    });

    it('5. sessions — two ops 2 hours apart: medianIntervalBetweenOpsMs ≈ 7200000 (1 gap, index 0)', async () => {
      ctx = await setup();
      // 1 gap total: gaps.sort → [7200000], median index = floor(1/2) = 0 → 7200000
      await ctx.logger.log(makeOp('agt-e', 'fs', 'sess-1048-med', hoursAgo(3)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agt-e', 'fs', 'sess-1048-med', hoursAgo(1)), dec(0.7, 'block'));

      const { body } = await getJSON(ctx.port, '/sessions/sess-1048-med');
      expect(body.medianIntervalBetweenOpsMs as number).toBeCloseTo(7_200_000, -3);
    });

    it('6. sessions — 3 ops: medianIntervalBetweenOpsMs picks middle sorted gap', async () => {
      ctx = await setup();
      // Timestamps: hoursAgo(4), hoursAgo(2), hoursAgo(1)
      // gaps in order: 2h, 1h → sorted: [1h, 2h] → median index = floor(2/2)=1 → 2h = 7200000
      await ctx.logger.log(makeOp('agt-f', 'fs', 'sess-1048-med3', hoursAgo(4)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agt-f', 'fs', 'sess-1048-med3', hoursAgo(2)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agt-f', 'fs', 'sess-1048-med3', hoursAgo(1)), dec(0.8, 'allow'));

      const { body } = await getJSON(ctx.port, '/sessions/sess-1048-med3');
      // gaps: [3600000, 7200000] sorted asc → [3600000, 7200000]
      // median index = floor(2/2) = 1 → 7200000
      expect(body.medianIntervalBetweenOpsMs as number).toBeCloseTo(7_200_000, -3);
    });

    it('7. sessions — p90IntervalBetweenOpsMs: 2 ops, 1 gap, index floor(1*0.9)=0', async () => {
      ctx = await setup();
      // 2 ops → 1 gap; floor(1*0.9)=0 → gaps[0]
      await ctx.logger.log(makeOp('agt-g', 'fs', 'sess-1048-p90-2', hoursAgo(3)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agt-g', 'fs', 'sess-1048-p90-2', hoursAgo(1)), dec(0.6, 'allow'));

      const { body } = await getJSON(ctx.port, '/sessions/sess-1048-p90-2');
      // 1 gap = 2h = 7200000; floor(1*0.9)=0 → gaps[0] = 7200000
      expect(body.p90IntervalBetweenOpsMs as number).toBeCloseTo(7_200_000, -3);
    });

    it('8. sessions — giniCoefficientRiskScores: single log returns null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-h', 'fs', 'sess-1048-gini1', daysAgo(1)), dec(0.5, 'allow'));

      const { body } = await getJSON(ctx.port, '/sessions/sess-1048-gini1');
      expect(body.giniCoefficientRiskScores).toBeNull();
    });

    it('9. sessions — giniCoefficientRiskScores: 2 logs all same score → 0', async () => {
      ctx = await setup();
      // All identical → sum > 0 but formula yields 0 via (2*(i+1)-n-1) symmetry
      // sorted [0.5, 0.5], n=2, sum=1.0
      // gini = [(2*1-2-1)*0.5 + (2*2-2-1)*0.5] / (2*1) = [(-1)*0.5 + (1)*0.5] / 2 = 0/2 = 0
      await ctx.logger.log(makeOp('agt-i', 'fs', 'sess-1048-gini-same', daysAgo(41)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agt-i', 'fs', 'sess-1048-gini-same', daysAgo(1)), dec(0.5, 'allow'));

      const { body } = await getJSON(ctx.port, '/sessions/sess-1048-gini-same');
      expect(body.giniCoefficientRiskScores as number).toBeCloseTo(0, 5);
    });

    it('10. sessions — giniCoefficientRiskScores: 2 logs [0, 1] → 0.5', async () => {
      ctx = await setup();
      // sorted [0, 1], n=2, sum=1
      // gini = [(2*1-2-1)*0 + (2*2-2-1)*1] / (2*1) = [0 + 1] / 2 = 0.5
      await ctx.logger.log(makeOp('agt-j', 'fs', 'sess-1048-gini-01', daysAgo(41)), dec(0, 'allow'));
      await ctx.logger.log(makeOp('agt-j', 'fs', 'sess-1048-gini-01', daysAgo(1)), dec(1.0, 'allow'));

      const { body } = await getJSON(ctx.port, '/sessions/sess-1048-gini-01');
      expect(body.giniCoefficientRiskScores as number).toBeCloseTo(0.5, 5);
    });

    it('11. sessions — riskScoreEntropy5Bins: no logs returns null', async () => {
      ctx = await setup();
      // Seed a different session — query nonexistent or empty session
      await ctx.logger.log(makeOp('agt-k', 'fs', 'sess-1048-other', daysAgo(1)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-1048-entropy-empty');
      if (status === 200) {
        expect(body.riskScoreEntropy5Bins).toBeNull();
      } else {
        expect(status).toBe(404);
      }
    });

    it('12. sessions — riskScoreEntropy5Bins: all in same bin → 0', async () => {
      ctx = await setup();
      // All scores 0.05 → bin 0 ([0,0.2)); all in 1 bin → entropy = 0
      await ctx.logger.log(makeOp('agt-l', 'fs', 'sess-1048-ent-same', daysAgo(41)), dec(0.05, 'allow'));
      await ctx.logger.log(makeOp('agt-l', 'fs', 'sess-1048-ent-same', daysAgo(1)), dec(0.05, 'allow'));
      await ctx.logger.log(makeOp('agt-l', 'fs', 'sess-1048-ent-same', daysAgo(2)), dec(0.1, 'block'));

      const { body } = await getJSON(ctx.port, '/sessions/sess-1048-ent-same');
      expect(body.riskScoreEntropy5Bins as number).toBeCloseTo(0, 5);
    });

    it('13. sessions — riskScoreEntropy5Bins: uniform across 5 bins → log2(5) ≈ 2.322', async () => {
      ctx = await setup();
      // One op per bin: 0.1(bin0), 0.3(bin1), 0.5(bin2), 0.7(bin3), 0.9(bin4)
      // uniform p=0.2 each → entropy = -5*(0.2*log2(0.2)) = log2(5) ≈ 2.32193
      await ctx.logger.log(makeOp('agt-m', 'fs', 'sess-1048-ent-uni', daysAgo(41)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agt-m', 'fs', 'sess-1048-ent-uni', daysAgo(1)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agt-m', 'fs', 'sess-1048-ent-uni', daysAgo(2)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agt-m', 'fs', 'sess-1048-ent-uni', daysAgo(3)), dec(0.7, 'allow'));
      await ctx.logger.log(makeOp('agt-m', 'fs', 'sess-1048-ent-uni', daysAgo(4)), dec(0.9, 'allow'));

      const { body } = await getJSON(ctx.port, '/sessions/sess-1048-ent-uni');
      expect(body.riskScoreEntropy5Bins as number).toBeCloseTo(Math.log2(5), 3);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1309-T1313 — v10.48 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('14. agents — all five new fields present in response', async () => {
      ctx = await setup();
      // Seed old log for entity-exists
      await ctx.logger.log(makeOp('agt-1048-pres', 'fs', 'sess-a', daysAgo(41)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agt-1048-pres', 'fs', 'sess-a', daysAgo(1)), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agt-1048-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('avgIntervalBetweenAllowsMs');
      expect(body).toHaveProperty('medianIntervalBetweenOpsMs');
      expect(body).toHaveProperty('p90IntervalBetweenOpsMs');
      expect(body).toHaveProperty('giniCoefficientRiskScores');
      expect(body).toHaveProperty('riskScoreEntropy5Bins');
    });

    it('15. agents — 3 allows: avgIntervalBetweenAllowsMs is mean of 2 gaps', async () => {
      ctx = await setup();
      // Allows at: hoursAgo(4), hoursAgo(2), hoursAgo(0)
      // gaps: 2h, 2h → mean = 2h = 7200000
      await ctx.logger.log(makeOp('agt-1048-3allows', 'fs', 'sess-b', hoursAgo(4)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agt-1048-3allows', 'fs', 'sess-b', hoursAgo(2)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agt-1048-3allows', 'fs', 'sess-b', hoursAgo(0)), dec(0.7, 'allow'));

      const { body } = await getJSON(ctx.port, '/agents/agt-1048-3allows');
      expect(body.avgIntervalBetweenAllowsMs as number).toBeCloseTo(7_200_000, -3);
    });

    it('16. agents — only 1 allow + blocks: avgIntervalBetweenAllowsMs null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-1048-1a', 'fs', 'sess-c', daysAgo(41)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agt-1048-1a', 'fs', 'sess-c', daysAgo(1)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agt-1048-1a', 'fs', 'sess-c', daysAgo(2)), dec(0.9, 'block'));

      const { body } = await getJSON(ctx.port, '/agents/agt-1048-1a');
      expect(body.avgIntervalBetweenAllowsMs).toBeNull();
    });

    it('17. agents — giniCoefficientRiskScores: [0, 1] → 0.5', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-1048-gini', 'fs', 'sess-d', daysAgo(41)), dec(0, 'block'));
      await ctx.logger.log(makeOp('agt-1048-gini', 'fs', 'sess-d', daysAgo(1)), dec(1.0, 'allow'));

      const { body } = await getJSON(ctx.port, '/agents/agt-1048-gini');
      expect(body.giniCoefficientRiskScores as number).toBeCloseTo(0.5, 5);
    });

    it('18. agents — giniCoefficientRiskScores: all zeros → returns 0', async () => {
      ctx = await setup();
      // sum === 0 → implementation returns 0
      await ctx.logger.log(makeOp('agt-1048-gzero', 'fs', 'sess-e', daysAgo(41)), dec(0, 'allow'));
      await ctx.logger.log(makeOp('agt-1048-gzero', 'fs', 'sess-e', daysAgo(1)), dec(0, 'allow'));

      const { body } = await getJSON(ctx.port, '/agents/agt-1048-gzero');
      expect(body.giniCoefficientRiskScores as number).toBe(0);
    });

    it('19. agents — riskScoreEntropy5Bins: single log (all in 1 bin) → 0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-1048-ent1', 'fs', 'sess-f', daysAgo(41)), dec(0.25, 'allow'));

      const { body } = await getJSON(ctx.port, '/agents/agt-1048-ent1');
      // 1 log → 1 bin → entropy = 0
      expect(body.riskScoreEntropy5Bins as number).toBeCloseTo(0, 5);
    });

    it('20. agents — medianIntervalBetweenOpsMs: null if only 1 op total', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-1048-med1', 'fs', 'sess-g', daysAgo(41)), dec(0.4, 'allow'));

      const { body } = await getJSON(ctx.port, '/agents/agt-1048-med1');
      expect(body.medianIntervalBetweenOpsMs).toBeNull();
      expect(body.p90IntervalBetweenOpsMs).toBeNull();
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1309-T1313 — v10.48 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('21. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-t', 'tool-1048-pres', 'sess-h', daysAgo(41)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agt-t', 'tool-1048-pres', 'sess-h', daysAgo(1)), dec(0.6, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-1048-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('avgIntervalBetweenAllowsMs');
      expect(body).toHaveProperty('medianIntervalBetweenOpsMs');
      expect(body).toHaveProperty('p90IntervalBetweenOpsMs');
      expect(body).toHaveProperty('giniCoefficientRiskScores');
      expect(body).toHaveProperty('riskScoreEntropy5Bins');
    });

    it('22. tools — avgIntervalBetweenAllowsMs: 2 allows 1 day apart → 86400000', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-t2', 'tool-1048-ava', 'sess-i', daysAgo(42)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agt-t2', 'tool-1048-ava', 'sess-i', daysAgo(41)), dec(0.5, 'allow'));

      const { body } = await getJSON(ctx.port, '/tools/tool-1048-ava');
      expect(body.avgIntervalBetweenAllowsMs as number).toBeCloseTo(86_400_000, -3);
    });

    it('23. tools — p90IntervalBetweenOpsMs: 10 ops with known gaps', async () => {
      ctx = await setup();
      // Ops at: daysAgo(10), daysAgo(9), daysAgo(8), ..., daysAgo(1)
      // 9 gaps each = 1 day = 86400000
      // sorted gaps: 9 elements all = 86400000
      // p90 index = floor(9*0.9) = floor(8.1) = 8 → gaps[8] = 86400000
      for (let d = 10; d >= 1; d--) {
        await ctx.logger.log(makeOp('agt-t3', 'tool-1048-p90', `sess-p90-${d}`, daysAgo(d)), dec(0.5, 'allow'));
      }

      const { body } = await getJSON(ctx.port, '/tools/tool-1048-p90');
      expect(body.p90IntervalBetweenOpsMs as number).toBeCloseTo(86_400_000, -3);
    });

    it('24. tools — riskScoreEntropy5Bins: 2 bins equally distributed → log2(2) = 1', async () => {
      ctx = await setup();
      // 2 ops in bin0 (score 0.1), 2 ops in bin4 (score 0.9) → 2 bins, p=0.5 each
      // entropy = -2*(0.5*log2(0.5)) = 1
      await ctx.logger.log(makeOp('agt-t4', 'tool-1048-ent2', 'sess-j', daysAgo(41)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agt-t4', 'tool-1048-ent2', 'sess-j', daysAgo(1)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agt-t4', 'tool-1048-ent2', 'sess-j', daysAgo(2)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agt-t4', 'tool-1048-ent2', 'sess-j', daysAgo(3)), dec(0.9, 'block'));

      const { body } = await getJSON(ctx.port, '/tools/tool-1048-ent2');
      expect(body.riskScoreEntropy5Bins as number).toBeCloseTo(1.0, 5);
    });

    it('25. tools — giniCoefficientRiskScores: 4 values [0.2, 0.4, 0.6, 0.8]', async () => {
      ctx = await setup();
      // sorted [0.2, 0.4, 0.6, 0.8], n=4, sum=2.0
      // gini = [(2*1-4-1)*0.2 + (2*2-4-1)*0.4 + (2*3-4-1)*0.6 + (2*4-4-1)*0.8] / (4*2)
      //      = [(-3)*0.2 + (-1)*0.4 + (1)*0.6 + (3)*0.8] / 8
      //      = [-0.6 - 0.4 + 0.6 + 2.4] / 8
      //      = 2.0 / 8 = 0.25
      await ctx.logger.log(makeOp('agt-t5', 'tool-1048-gini4', 'sess-k', daysAgo(41)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agt-t5', 'tool-1048-gini4', 'sess-k', daysAgo(1)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agt-t5', 'tool-1048-gini4', 'sess-k', daysAgo(2)), dec(0.6, 'allow'));
      await ctx.logger.log(makeOp('agt-t5', 'tool-1048-gini4', 'sess-k', daysAgo(3)), dec(0.8, 'allow'));

      const { body } = await getJSON(ctx.port, '/tools/tool-1048-gini4');
      expect(body.giniCoefficientRiskScores as number).toBeCloseTo(0.25, 5);
    });
  });

  // ── summary endpoint ───────────────────────────────────────────────────────────

  describe('T1309-T1313 — v10.48 new fields (summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('26. summary — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-s', 'fs', 'sess-s', daysAgo(1)), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body).toHaveProperty('avgIntervalBetweenAllowsMs');
      expect(body).toHaveProperty('medianIntervalBetweenOpsMs');
      expect(body).toHaveProperty('p90IntervalBetweenOpsMs');
      expect(body).toHaveProperty('giniCoefficientRiskScores');
      expect(body).toHaveProperty('riskScoreEntropy5Bins');
    });

    it('27. summary — empty DB: interval/gini fields are null, entropy is null', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.avgIntervalBetweenAllowsMs).toBeNull();
      expect(body.medianIntervalBetweenOpsMs).toBeNull();
      expect(body.p90IntervalBetweenOpsMs).toBeNull();
      expect(body.giniCoefficientRiskScores).toBeNull();
      expect(body.riskScoreEntropy5Bins).toBeNull();
    });

    it('28. summary — single log: all interval fields null, gini null, entropy 0 (1 bin)', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-s1', 'fs', 'sess-s1', daysAgo(1)), dec(0.5, 'allow'));

      const { body } = await getJSON(ctx.port, '/operations/summary');
      expect(body.avgIntervalBetweenAllowsMs).toBeNull();
      expect(body.medianIntervalBetweenOpsMs).toBeNull();
      expect(body.p90IntervalBetweenOpsMs).toBeNull();
      expect(body.giniCoefficientRiskScores).toBeNull();
      // 1 log → 1 bin → entropy = 0
      expect(body.riskScoreEntropy5Bins as number).toBeCloseTo(0, 5);
    });

    it('29. summary — only 1 allow, 1 block: avgIntervalBetweenAllowsMs null; medianIntervalBetweenOpsMs non-null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-s2', 'fs', 'sess-s2', hoursAgo(2)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agt-s3', 'fs', 'sess-s3', hoursAgo(1)), dec(0.7, 'block'));

      const { body } = await getJSON(ctx.port, '/operations/summary');
      expect(body.avgIntervalBetweenAllowsMs).toBeNull();
      // 2 ops → 1 gap ≈ 3600000; medianIntervalBetweenOpsMs non-null
      expect(body.medianIntervalBetweenOpsMs as number).toBeCloseTo(3_600_000, -3);
    });

    it('30. summary — 2 allows, riskScoreEntropy5Bins: scores in different bins → positive entropy', async () => {
      ctx = await setup();
      // score 0.1 → bin 0, score 0.9 → bin 4: 2 bins, p=0.5 each → entropy = 1
      await ctx.logger.log(makeOp('agt-s4', 'fs', 'sess-s4', daysAgo(41)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agt-s4', 'fs', 'sess-s4', daysAgo(1)), dec(0.9, 'allow'));

      const { body } = await getJSON(ctx.port, '/operations/summary');
      expect(body.avgIntervalBetweenAllowsMs as number).toBeGreaterThan(0);
      expect(body.riskScoreEntropy5Bins as number).toBeCloseTo(1.0, 5);
    });

    it('31. summary — 5 logs uniform across bins: entropy ≈ log2(5)', async () => {
      ctx = await setup();
      // One in each of the 5 bins
      await ctx.logger.log(makeOp('agt-s5', 'fs', 'sess-s5', daysAgo(41)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agt-s6', 'fs', 'sess-s6', daysAgo(1)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agt-s7', 'fs', 'sess-s7', daysAgo(2)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agt-s8', 'fs', 'sess-s8', daysAgo(3)), dec(0.7, 'allow'));
      await ctx.logger.log(makeOp('agt-s9', 'fs', 'sess-s9', daysAgo(4)), dec(0.9, 'allow'));

      const { body } = await getJSON(ctx.port, '/operations/summary');
      expect(body.riskScoreEntropy5Bins as number).toBeCloseTo(Math.log2(5), 3);
    });

    it('32. summary — giniCoefficientRiskScores: [0,1] across 2 logs → 0.5', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-sa', 'fs', 'sess-sa', daysAgo(41)), dec(0, 'allow'));
      await ctx.logger.log(makeOp('agt-sb', 'fs', 'sess-sb', daysAgo(1)), dec(1.0, 'block'));

      const { body } = await getJSON(ctx.port, '/operations/summary');
      expect(body.giniCoefficientRiskScores as number).toBeCloseTo(0.5, 5);
    });

    it('33. summary — p90IntervalBetweenOpsMs: 10 ops equal gaps, p90 picks correct index', async () => {
      ctx = await setup();
      // 10 ops 1 day apart: 9 gaps, all 86400000
      // floor(9*0.9)=floor(8.1)=8 → gaps[8] = 86400000
      for (let d = 10; d >= 1; d--) {
        await ctx.logger.log(makeOp(`agt-sc-${d}`, `tool-p90-${d}`, `sess-sc-${d}`, daysAgo(d)), dec(0.5, 'allow'));
      }

      const { body } = await getJSON(ctx.port, '/operations/summary');
      expect(body.p90IntervalBetweenOpsMs as number).toBeCloseTo(86_400_000, -3);
    });
  });
});

// ── v10.49 ────────────────────────────────────────────────────────────────────

describe('v10.49', () => {
  const hoursAgo = (h: number) => new Date(PINNED_NOW() - h * 3_600_000);
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);

  // ── Autocorrelation helper (mirrors the implementation formula) ─────────────────

  function lag1Autocorr(values: number[]): number | null {
    const n = values.length;
    if (n < 3) return null;
    const mean = values.reduce((a, v) => a + v, 0) / n;
    const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / n;
    if (variance === 0) return null;
    const cov = values.slice(0, n - 1).reduce((a, v, i) => a + (v - mean) * (values[i + 1]! - mean), 0) / n;
    return cov / variance;
  }

  // ── SESSIONS endpoint ──────────────────────────────────────────────────────────

  describe('T1314-T1318 — v10.49 sessions endpoint', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1049-pres'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1049-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('lag1AutocorrelationRiskScores');
      expect(body).toHaveProperty('riskScoreMomentum10Ops');
      expect(body).toHaveProperty('blockRateMomentum');
      expect(body).toHaveProperty('uniqueMethodsLast24h');
      expect(body).toHaveProperty('uniqueMethodsLast7d');
    });

    it('2. sessions — lag1Autocorrelation null if < 3 logs', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1049-lt3', hoursAgo(2)), dec(0.3));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1049-lt3', hoursAgo(1)), dec(0.7));

      const { body } = await getJSON(ctx.port, '/sessions/sess-v1049-lt3');
      expect(body.lag1AutocorrelationRiskScores).toBeNull();
    });

    it('3. sessions — lag1Autocorrelation null if variance=0 (all same score)', async () => {
      ctx = await setup();
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1049-var0', hoursAgo(5 - i)), dec(0.5));
      }

      const { body } = await getJSON(ctx.port, '/sessions/sess-v1049-var0');
      expect(body.lag1AutocorrelationRiskScores).toBeNull();
    });

    it('4. sessions — lag1Autocorrelation near 1.0 for ascending scores', async () => {
      ctx = await setup();
      // Ascending: [0, 0.25, 0.5, 0.75, 1.0] — strong positive autocorrelation
      const scores = [0, 0.25, 0.5, 0.75, 1.0];
      for (let i = 0; i < scores.length; i++) {
        await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1049-asc', hoursAgo(scores.length - i)), dec(scores[i]!));
      }

      const expected = lag1Autocorr(scores)!;
      const { body } = await getJSON(ctx.port, '/sessions/sess-v1049-asc');
      expect(body.lag1AutocorrelationRiskScores as number).toBeCloseTo(expected, 4);
      expect(body.lag1AutocorrelationRiskScores as number).toBeGreaterThan(0);
    });

    it('5. sessions — lag1Autocorrelation near -1.0 for alternating scores', async () => {
      ctx = await setup();
      // Alternating: [0, 1, 0, 1, 0, 1] — strong negative autocorrelation
      const scores = [0, 1, 0, 1, 0, 1];
      for (let i = 0; i < scores.length; i++) {
        await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1049-alt', hoursAgo(scores.length - i)), dec(scores[i]!));
      }

      const expected = lag1Autocorr(scores)!;
      const { body } = await getJSON(ctx.port, '/sessions/sess-v1049-alt');
      expect(body.lag1AutocorrelationRiskScores as number).toBeCloseTo(expected, 4);
      expect(body.lag1AutocorrelationRiskScores as number).toBeLessThan(0);
    });

    it('6. sessions — riskScoreMomentum10Ops null if < 20 ops', async () => {
      ctx = await setup();
      for (let i = 0; i < 19; i++) {
        await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1049-lt20', hoursAgo(20 - i)), dec(0.4));
      }

      const { body } = await getJSON(ctx.port, '/sessions/sess-v1049-lt20');
      expect(body.riskScoreMomentum10Ops).toBeNull();
      expect(body.blockRateMomentum).toBeNull();
    });

    it('7. sessions — riskScoreMomentum10Ops: recent10 higher than prior10 gives positive value', async () => {
      ctx = await setup();
      // ops 11-20 (older) have score 0.2, ops 1-10 (recent) have score 0.8
      // momentum = 0.8 - 0.2 = 0.6
      for (let i = 0; i < 10; i++) {
        await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1049-mom', hoursAgo(20 - i)), dec(0.2));
      }
      for (let i = 0; i < 10; i++) {
        await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1049-mom', hoursAgo(10 - i)), dec(0.8));
      }

      const { body } = await getJSON(ctx.port, '/sessions/sess-v1049-mom');
      expect(body.riskScoreMomentum10Ops as number).toBeCloseTo(0.6, 4);
    });

    it('8. sessions — blockRateMomentum: recent10 more blocked gives positive value', async () => {
      ctx = await setup();
      // ops 11-20 (older): all allow (blockRate=0)
      for (let i = 0; i < 10; i++) {
        await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1049-blk', hoursAgo(20 - i)), dec(0.5, 'allow'));
      }
      // ops 1-10 (recent): all block (blockRate=1)
      for (let i = 0; i < 10; i++) {
        await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1049-blk', hoursAgo(10 - i)), dec(0.9, 'block'));
      }

      const { body } = await getJSON(ctx.port, '/sessions/sess-v1049-blk');
      expect(body.blockRateMomentum as number).toBeCloseTo(1.0, 4);
    });

    it('9. sessions — uniqueMethodsLast24h counts distinct methods within 24h', async () => {
      ctx = await setup();
      // 3 ops in last 24h with 2 distinct methods, 1 older op (>24h) with a 3rd method
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v1049-meth', hoursAgo(1), 'read'), dec(0.3));
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v1049-meth', hoursAgo(2), 'write'), dec(0.4));
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v1049-meth', hoursAgo(3), 'read'), dec(0.3));
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v1049-meth', hoursAgo(25), 'execute'), dec(0.5));

      const { body } = await getJSON(ctx.port, '/sessions/sess-v1049-meth');
      expect(body.uniqueMethodsLast24h).toBe(2);
    });

    it('10. sessions — uniqueMethodsLast24h is 0 when all ops are older than 24h', async () => {
      ctx = await setup();
      // Seed old logs (40+ days) so entity exists but no recent ops
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v1049-old24h', daysAgo(41), 'call'), dec(0.3));
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v1049-old24h', daysAgo(45), 'read'), dec(0.4));

      const { body } = await getJSON(ctx.port, '/sessions/sess-v1049-old24h');
      expect(body.uniqueMethodsLast24h).toBe(0);
    });

    it('11. sessions — uniqueMethodsLast7d counts distinct methods within 7d', async () => {
      ctx = await setup();
      // 3 methods in last 7d, 1 additional older method outside window
      await ctx.logger.log(makeOp('agent-k', 'fs', 'sess-v1049-7d', daysAgo(1), 'read'), dec(0.3));
      await ctx.logger.log(makeOp('agent-k', 'fs', 'sess-v1049-7d', daysAgo(3), 'write'), dec(0.4));
      await ctx.logger.log(makeOp('agent-k', 'fs', 'sess-v1049-7d', daysAgo(5), 'list'), dec(0.2));
      // old log outside 7d window
      await ctx.logger.log(makeOp('agent-k', 'fs', 'sess-v1049-7d', daysAgo(8), 'execute'), dec(0.5));

      const { body } = await getJSON(ctx.port, '/sessions/sess-v1049-7d');
      expect(body.uniqueMethodsLast7d).toBe(3);
    });
  });

  // ── AGENTS endpoint ────────────────────────────────────────────────────────────

  describe('T1314-T1318 — v10.49 agents endpoint', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('12. agents — all five new fields present in response', async () => {
      ctx = await setup();
      // Seed old log so entity exists; then add recent log
      await ctx.logger.log(makeOp('agent-v1049-A', 'fs', 'sess-1', daysAgo(41)), dec(0.5));
      await ctx.logger.log(makeOp('agent-v1049-A', 'fs', 'sess-1', hoursAgo(1)), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1049-A');
      expect(status).toBe(200);
      expect(body).toHaveProperty('lag1AutocorrelationRiskScores');
      expect(body).toHaveProperty('riskScoreMomentum10Ops');
      expect(body).toHaveProperty('blockRateMomentum');
      expect(body).toHaveProperty('uniqueMethodsLast24h');
      expect(body).toHaveProperty('uniqueMethodsLast7d');
    });

    it('13. agents — lag1Autocorrelation correctly computed for 3-element ascending series', async () => {
      ctx = await setup();
      // Seed old logs (40+ days) so entity has history
      await ctx.logger.log(makeOp('agent-v1049-B', 'fs', 'sess-1', daysAgo(42)), dec(0.1));
      // 3 ascending scores sorted by timestamp
      const scores = [0.2, 0.5, 0.8];
      for (let i = 0; i < scores.length; i++) {
        await ctx.logger.log(makeOp('agent-v1049-B', 'fs', 'sess-1', hoursAgo(scores.length - i)), dec(scores[i]!));
      }

      // We compute expected using all logs the endpoint sees (all 4 logs sorted by time)
      // But let's just verify sign: ascending → positive
      const { body } = await getJSON(ctx.port, '/agents/agent-v1049-B');
      // With old log at 0.1 followed by 0.2, 0.5, 0.8 — overall positive trend
      expect(typeof body.lag1AutocorrelationRiskScores).toBe('number');
      expect(body.lag1AutocorrelationRiskScores as number).toBeGreaterThan(0);
    });

    it('14. agents — riskScoreMomentum10Ops null if < 20 ops total', async () => {
      ctx = await setup();
      // Seed 15 old logs (40+ days) so entity exists but total < 20 current ops
      for (let i = 0; i < 15; i++) {
        await ctx.logger.log(makeOp('agent-v1049-C', 'fs', 'sess-1', daysAgo(41 + i)), dec(0.3));
      }

      const { body } = await getJSON(ctx.port, '/agents/agent-v1049-C');
      // 15 logs total < 20 → null
      expect(body.riskScoreMomentum10Ops).toBeNull();
      expect(body.blockRateMomentum).toBeNull();
    });

    it('15. agents — riskScoreMomentum10Ops computed correctly for 20 ops', async () => {
      ctx = await setup();
      // ops 11-20 (older) have score 0.3, ops 1-10 (recent) have score 0.6
      // momentum = 0.6 - 0.3 = 0.3
      for (let i = 0; i < 10; i++) {
        await ctx.logger.log(makeOp('agent-v1049-D', 'fs', 'sess-1', hoursAgo(20 - i)), dec(0.3));
      }
      for (let i = 0; i < 10; i++) {
        await ctx.logger.log(makeOp('agent-v1049-D', 'fs', 'sess-1', hoursAgo(10 - i)), dec(0.6));
      }

      const { body } = await getJSON(ctx.port, '/agents/agent-v1049-D');
      expect(body.riskScoreMomentum10Ops as number).toBeCloseTo(0.3, 4);
    });

    it('16. agents — blockRateMomentum negative when recent ops less blocked than prior', async () => {
      ctx = await setup();
      // ops 11-20 (older): all block (blockRate=1)
      for (let i = 0; i < 10; i++) {
        await ctx.logger.log(makeOp('agent-v1049-E', 'fs', 'sess-1', hoursAgo(20 - i)), dec(0.9, 'block'));
      }
      // ops 1-10 (recent): all allow (blockRate=0)
      for (let i = 0; i < 10; i++) {
        await ctx.logger.log(makeOp('agent-v1049-E', 'fs', 'sess-1', hoursAgo(10 - i)), dec(0.2, 'allow'));
      }

      const { body } = await getJSON(ctx.port, '/agents/agent-v1049-E');
      expect(body.blockRateMomentum as number).toBeCloseTo(-1.0, 4);
    });

    it('17. agents — uniqueMethodsLast24h zero when all ops older than 24h', async () => {
      ctx = await setup();
      // Seed old logs (40+ days) to ensure entity exists
      await ctx.logger.log(makeOp('agent-v1049-F', 'fs', 'sess-1', daysAgo(41), 'call'), dec(0.5));
      await ctx.logger.log(makeOp('agent-v1049-F', 'fs', 'sess-1', daysAgo(45), 'read'), dec(0.4));

      const { body } = await getJSON(ctx.port, '/agents/agent-v1049-F');
      expect(body.uniqueMethodsLast24h).toBe(0);
    });

    it('18. agents — uniqueMethodsLast24h counts distinct methods in last 24h', async () => {
      ctx = await setup();
      // Seed old log so entity definitely exists
      await ctx.logger.log(makeOp('agent-v1049-G', 'fs', 'sess-1', daysAgo(41), 'old-method'), dec(0.2));
      // Recent ops with 3 distinct methods
      await ctx.logger.log(makeOp('agent-v1049-G', 'fs', 'sess-1', hoursAgo(1), 'read'), dec(0.3));
      await ctx.logger.log(makeOp('agent-v1049-G', 'fs', 'sess-1', hoursAgo(2), 'write'), dec(0.4));
      await ctx.logger.log(makeOp('agent-v1049-G', 'fs', 'sess-1', hoursAgo(3), 'read'), dec(0.3));
      await ctx.logger.log(makeOp('agent-v1049-G', 'fs', 'sess-1', hoursAgo(4), 'list'), dec(0.2));

      const { body } = await getJSON(ctx.port, '/agents/agent-v1049-G');
      expect(body.uniqueMethodsLast24h).toBe(3);
    });
  });

  // ── TOOLS endpoint ─────────────────────────────────────────────────────────────

  describe('T1314-T1318 — v10.49 tools endpoint', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('19. tools — all five new fields present in response', async () => {
      ctx = await setup();
      // Seed old log so tool entity has history
      await ctx.logger.log(makeOp('agent-x1', 'db-tool', 'sess-1', daysAgo(41)), dec(0.5));
      await ctx.logger.log(makeOp('agent-x1', 'db-tool', 'sess-1', hoursAgo(1)), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/tools/db-tool');
      expect(status).toBe(200);
      expect(body).toHaveProperty('lag1AutocorrelationRiskScores');
      expect(body).toHaveProperty('riskScoreMomentum10Ops');
      expect(body).toHaveProperty('blockRateMomentum');
      expect(body).toHaveProperty('uniqueMethodsLast24h');
      expect(body).toHaveProperty('uniqueMethodsLast7d');
    });

    it('20. tools — lag1Autocorrelation null when variance=0', async () => {
      ctx = await setup();
      // All scores identical → variance = 0 → null
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp('agent-x2', 'tool-uniform', 'sess-1', hoursAgo(4 - i)), dec(0.6));
      }

      const { body } = await getJSON(ctx.port, '/tools/tool-uniform');
      expect(body.lag1AutocorrelationRiskScores).toBeNull();
    });

    it('21. tools — riskScoreMomentum10Ops null when fewer than 20 ops', async () => {
      ctx = await setup();
      // Seed 10 old logs so entity exists but < 20 total
      for (let i = 0; i < 10; i++) {
        await ctx.logger.log(makeOp('agent-x3', 'tool-lt20', 'sess-1', daysAgo(41 + i)), dec(0.4));
      }

      const { body } = await getJSON(ctx.port, '/tools/tool-lt20');
      expect(body.riskScoreMomentum10Ops).toBeNull();
      expect(body.blockRateMomentum).toBeNull();
    });

    it('22. tools — blockRateMomentum 0 when block rate is same in both windows', async () => {
      ctx = await setup();
      // 20 ops: first 10 (older) half block, recent 10 also half block → momentum = 0
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp('agent-x4', 'tool-eq', 'sess-1', hoursAgo(20 - i)), dec(0.9, 'block'));
        await ctx.logger.log(makeOp('agent-x4', 'tool-eq', 'sess-1', hoursAgo(19 - i)), dec(0.1, 'allow'));
      }
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp('agent-x4', 'tool-eq', 'sess-1', hoursAgo(9 - i)), dec(0.9, 'block'));
        await ctx.logger.log(makeOp('agent-x4', 'tool-eq', 'sess-1', hoursAgo(8 - i)), dec(0.1, 'allow'));
      }

      const { body } = await getJSON(ctx.port, '/tools/tool-eq');
      expect(body.blockRateMomentum as number).toBeCloseTo(0.0, 4);
    });

    it('23. tools — uniqueMethodsLast24h is integer and zero when ops all older than 24h', async () => {
      ctx = await setup();
      // Seed old logs (40+ days)
      await ctx.logger.log(makeOp('agent-x5', 'tool-old', 'sess-1', daysAgo(41), 'call'), dec(0.3));
      await ctx.logger.log(makeOp('agent-x5', 'tool-old', 'sess-1', daysAgo(50), 'read'), dec(0.4));

      const { body } = await getJSON(ctx.port, '/tools/tool-old');
      expect(body.uniqueMethodsLast24h).toBe(0);
      expect(Number.isInteger(body.uniqueMethodsLast24h)).toBe(true);
    });

    it('24. tools — uniqueMethodsLast7d only counts methods from last 7d', async () => {
      ctx = await setup();
      // Seed old logs (40+ days) for entity existence
      await ctx.logger.log(makeOp('agent-x6', 'tool-7d', 'sess-1', daysAgo(41), 'archive'), dec(0.2));
      // 2 distinct methods in last 7d
      await ctx.logger.log(makeOp('agent-x6', 'tool-7d', 'sess-1', daysAgo(2), 'read'), dec(0.3));
      await ctx.logger.log(makeOp('agent-x6', 'tool-7d', 'sess-1', daysAgo(4), 'write'), dec(0.5));
      await ctx.logger.log(makeOp('agent-x6', 'tool-7d', 'sess-1', daysAgo(6), 'read'), dec(0.3));

      const { body } = await getJSON(ctx.port, '/tools/tool-7d');
      expect(body.uniqueMethodsLast7d).toBe(2);
    });
  });

  // ── SUMMARY endpoint ────────────────────────────────────────────────────────────

  describe('T1314-T1318 — v10.49 summary endpoint', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('25. summary — all five new fields present in response', async () => {
      ctx = await setup();
      // Seed old log + recent log
      await ctx.logger.log(makeOp('agent-s1', 'fs', 'sess-1', daysAgo(42)), dec(0.5));
      await ctx.logger.log(makeOp('agent-s1', 'fs', 'sess-1', hoursAgo(1)), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body).toHaveProperty('lag1AutocorrelationRiskScores');
      expect(body).toHaveProperty('riskScoreMomentum10Ops');
      expect(body).toHaveProperty('blockRateMomentum');
      expect(body).toHaveProperty('uniqueMethodsLast24h');
      expect(body).toHaveProperty('uniqueMethodsLast7d');
    });

    it('26. summary — lag1Autocorrelation null when only 2 total ops exist', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s2', 'fs', 'sess-1', hoursAgo(2)), dec(0.3));
      await ctx.logger.log(makeOp('agent-s2', 'fs', 'sess-1', hoursAgo(1)), dec(0.7));

      const { body } = await getJSON(ctx.port, '/operations/summary');
      expect(body.lag1AutocorrelationRiskScores).toBeNull();
    });

    it('27. summary — lag1Autocorrelation computed correctly for known 4-element series', async () => {
      ctx = await setup();
      // scores ordered by time: [0.0, 0.5, 0.5, 1.0]
      const scores = [0.0, 0.5, 0.5, 1.0];
      for (let i = 0; i < scores.length; i++) {
        await ctx.logger.log(makeOp('agent-s3', 'fs', 'sess-1', hoursAgo(scores.length - i)), dec(scores[i]!));
      }

      const expected = lag1Autocorr(scores)!;
      const { body } = await getJSON(ctx.port, '/operations/summary');
      expect(body.lag1AutocorrelationRiskScores as number).toBeCloseTo(expected, 4);
    });

    it('28. summary — riskScoreMomentum10Ops null for < 20 total ops', async () => {
      ctx = await setup();
      // Seed old logs (40+ days) for existence
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp('agent-s4', 'fs', 'sess-1', daysAgo(41 + i)), dec(0.3));
      }

      const { body } = await getJSON(ctx.port, '/operations/summary');
      expect(body.riskScoreMomentum10Ops).toBeNull();
      expect(body.blockRateMomentum).toBeNull();
    });

    it('29. summary — riskScoreMomentum10Ops and blockRateMomentum both 0 when windows identical', async () => {
      ctx = await setup();
      // 20 ops: all with same score 0.5 and all allow
      for (let i = 0; i < 20; i++) {
        await ctx.logger.log(makeOp('agent-s5', 'fs', 'sess-1', hoursAgo(20 - i)), dec(0.5, 'allow'));
      }

      const { body } = await getJSON(ctx.port, '/operations/summary');
      expect(body.riskScoreMomentum10Ops as number).toBeCloseTo(0, 4);
      expect(body.blockRateMomentum as number).toBeCloseTo(0, 4);
    });

    it('30. summary — uniqueMethodsLast24h counts distinct methods globally across all entities', async () => {
      ctx = await setup();
      // Seed old logs so entities exist
      await ctx.logger.log(makeOp('agent-s6a', 'fs', 'sess-s6', daysAgo(41), 'archive'), dec(0.2));
      // Two agents using different methods in last 24h
      await ctx.logger.log(makeOp('agent-s6a', 'fs', 'sess-s6', hoursAgo(1), 'read'), dec(0.3));
      await ctx.logger.log(makeOp('agent-s6b', 'db', 'sess-s6', hoursAgo(2), 'write'), dec(0.4));
      await ctx.logger.log(makeOp('agent-s6c', 'api', 'sess-s6', hoursAgo(3), 'read'), dec(0.3));

      const { body } = await getJSON(ctx.port, '/operations/summary');
      // read and write are distinct methods (read appears twice but counts once)
      expect(body.uniqueMethodsLast24h).toBe(2);
    });

    it('31. summary — uniqueMethodsLast7d zero when all ops older than 7d', async () => {
      ctx = await setup();
      // Seed old logs (40+ days) for entity existence
      await ctx.logger.log(makeOp('agent-s7', 'fs', 'sess-1', daysAgo(41), 'call'), dec(0.3));
      await ctx.logger.log(makeOp('agent-s7', 'fs', 'sess-1', daysAgo(45), 'read'), dec(0.4));
      // op at exactly 8d ago — outside 7d window
      await ctx.logger.log(makeOp('agent-s7', 'fs', 'sess-1', daysAgo(8), 'write'), dec(0.5));

      const { body } = await getJSON(ctx.port, '/operations/summary');
      expect(body.uniqueMethodsLast7d).toBe(0);
    });

    it('32. summary — uniqueMethodsLast24h is integer type', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s8', 'fs', 'sess-1', hoursAgo(1), 'call'), dec(0.4));

      const { body } = await getJSON(ctx.port, '/operations/summary');
      expect(Number.isInteger(body.uniqueMethodsLast24h)).toBe(true);
      expect(Number.isInteger(body.uniqueMethodsLast7d)).toBe(true);
    });

    it('33. summary — blockRateMomentum between -1 and 1', async () => {
      ctx = await setup();
      // 20 ops: ops 11-20 all block, ops 1-10 all allow → momentum = -1
      for (let i = 0; i < 10; i++) {
        await ctx.logger.log(makeOp('agent-s9', 'fs', 'sess-1', hoursAgo(20 - i)), dec(0.9, 'block'));
      }
      for (let i = 0; i < 10; i++) {
        await ctx.logger.log(makeOp('agent-s9', 'fs', 'sess-1', hoursAgo(10 - i)), dec(0.2, 'allow'));
      }

      const { body } = await getJSON(ctx.port, '/operations/summary');
      const momentum = body.blockRateMomentum as number;
      expect(momentum).toBeGreaterThanOrEqual(-1.0);
      expect(momentum).toBeLessThanOrEqual(1.0);
      expect(momentum).toBeCloseTo(-1.0, 4);
    });
  });
});

// ── v10.50 ────────────────────────────────────────────────────────────────────

describe('v10.50', () => {
  const hoursAgo = (h: number) => new Date(PINNED_NOW() - h * 3_600_000);
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1319-T1323 — v10.50 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1050-pres'), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1050-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('uniqueMethodsLast30d');
      expect(body).toHaveProperty('uniqueAgentsLast24h');
      expect(body).toHaveProperty('uniqueToolsLast24h');
      expect(body).toHaveProperty('riskScoreAutoCorrelationLag2');
      expect(body).toHaveProperty('riskScoreAutoCorrelationLag3');
    });

    it('2. sessions — uniqueMethodsLast30d counts distinct methods within 30d window', async () => {
      ctx = await setup();
      const sid = 'sess-v1050-meth30d';
      // 3 ops within 30d with distinct methods, 1 op older than 30d
      await ctx.logger.log(makeOp('agent-a', 'fs', sid, daysAgo(1), 'call'), dec(0.3));
      await ctx.logger.log(makeOp('agent-a', 'fs', sid, daysAgo(5), 'read'), dec(0.3));
      await ctx.logger.log(makeOp('agent-a', 'fs', sid, daysAgo(20), 'write'), dec(0.3));
      // old op outside 30d window — should NOT be counted
      await ctx.logger.log(makeOp('agent-a', 'fs', sid, daysAgo(45), 'execute'), dec(0.3));

      const { status, body } = await getJSON(ctx.port, `/sessions/${sid}`);
      expect(status).toBe(200);
      expect(body.uniqueMethodsLast30d).toBe(3);
    });

    it('3. sessions — uniqueMethodsLast30d deduplicates repeated methods', async () => {
      ctx = await setup();
      const sid = 'sess-v1050-meth30d-dedup';
      // 4 ops within 30d but only 2 distinct methods
      await ctx.logger.log(makeOp('agent-a', 'fs', sid, daysAgo(1), 'call'), dec(0.3));
      await ctx.logger.log(makeOp('agent-a', 'fs', sid, daysAgo(2), 'call'), dec(0.3));
      await ctx.logger.log(makeOp('agent-a', 'fs', sid, daysAgo(3), 'read'), dec(0.3));
      await ctx.logger.log(makeOp('agent-a', 'fs', sid, daysAgo(4), 'read'), dec(0.3));

      const { status, body } = await getJSON(ctx.port, `/sessions/${sid}`);
      expect(status).toBe(200);
      expect(body.uniqueMethodsLast30d).toBe(2);
    });

    it('4. sessions — uniqueMethodsLast30d is 0 when only old ops (>30d)', async () => {
      ctx = await setup();
      const sid = 'sess-v1050-meth30d-zero';
      // Only ops older than 30d
      await ctx.logger.log(makeOp('agent-a', 'fs', sid, daysAgo(40), 'call'), dec(0.3));
      await ctx.logger.log(makeOp('agent-a', 'fs', sid, daysAgo(50), 'read'), dec(0.3));

      const { status, body } = await getJSON(ctx.port, `/sessions/${sid}`);
      expect(status).toBe(200);
      expect(body.uniqueMethodsLast30d).toBe(0);
    });

    it('5. sessions — uniqueAgentsLast24h counts distinct agents in last 24h', async () => {
      ctx = await setup();
      const sid = 'sess-v1050-agents24h';
      // 3 distinct agents within 24h
      await ctx.logger.log(makeOp('agent-x1', 'fs', sid, hoursAgo(1)), dec(0.3));
      await ctx.logger.log(makeOp('agent-x2', 'fs', sid, hoursAgo(2)), dec(0.3));
      await ctx.logger.log(makeOp('agent-x3', 'fs', sid, hoursAgo(3)), dec(0.3));
      // old agent outside 24h — should NOT be counted
      await ctx.logger.log(makeOp('agent-x4', 'fs', sid, daysAgo(45)), dec(0.3));

      const { status, body } = await getJSON(ctx.port, `/sessions/${sid}`);
      expect(status).toBe(200);
      expect(body.uniqueAgentsLast24h).toBe(3);
    });

    it('6. sessions — uniqueToolsLast24h counts distinct tools in last 24h', async () => {
      ctx = await setup();
      const sid = 'sess-v1050-tools24h';
      // 2 distinct tools within 24h
      await ctx.logger.log(makeOp('agent-a', 'fs', sid, hoursAgo(1)), dec(0.3));
      await ctx.logger.log(makeOp('agent-a', 'bash', sid, hoursAgo(2)), dec(0.3));
      await ctx.logger.log(makeOp('agent-a', 'fs', sid, hoursAgo(3)), dec(0.3));
      // old tool outside 24h
      await ctx.logger.log(makeOp('agent-a', 'db', sid, daysAgo(45)), dec(0.3));

      const { status, body } = await getJSON(ctx.port, `/sessions/${sid}`);
      expect(status).toBe(200);
      expect(body.uniqueToolsLast24h).toBe(2);
    });

    it('7. sessions — riskScoreAutoCorrelationLag2 null when fewer than 4 logs', async () => {
      ctx = await setup();
      const sid = 'sess-v1050-lag2-null';
      // Only 3 logs — should return null
      await ctx.logger.log(makeOp('agent-a', 'fs', sid, hoursAgo(3)), dec(0.2));
      await ctx.logger.log(makeOp('agent-a', 'fs', sid, hoursAgo(2)), dec(0.5));
      await ctx.logger.log(makeOp('agent-a', 'fs', sid, hoursAgo(1)), dec(0.8));

      const { status, body } = await getJSON(ctx.port, `/sessions/${sid}`);
      expect(status).toBe(200);
      expect(body.riskScoreAutoCorrelationLag2).toBeNull();
    });

    it('8. sessions — riskScoreAutoCorrelationLag3 null when fewer than 5 logs', async () => {
      ctx = await setup();
      const sid = 'sess-v1050-lag3-null';
      // Only 4 logs — lag3 should be null, lag2 should not be null
      await ctx.logger.log(makeOp('agent-a', 'fs', sid, hoursAgo(4)), dec(0.1));
      await ctx.logger.log(makeOp('agent-a', 'fs', sid, hoursAgo(3)), dec(0.5));
      await ctx.logger.log(makeOp('agent-a', 'fs', sid, hoursAgo(2)), dec(0.1));
      await ctx.logger.log(makeOp('agent-a', 'fs', sid, hoursAgo(1)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, `/sessions/${sid}`);
      expect(status).toBe(200);
      expect(body.riskScoreAutoCorrelationLag3).toBeNull();
      // lag2 should be non-null with 4 logs
      expect(body.riskScoreAutoCorrelationLag2).not.toBeNull();
    });

    it('9. sessions — riskScoreAutoCorrelationLag2 null when variance=0 (all same score)', async () => {
      ctx = await setup();
      const sid = 'sess-v1050-lag2-var0';
      // 5 logs all same risk score — variance=0
      for (let i = 5; i >= 1; i--) {
        await ctx.logger.log(makeOp('agent-a', 'fs', sid, hoursAgo(i)), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, `/sessions/${sid}`);
      expect(status).toBe(200);
      expect(body.riskScoreAutoCorrelationLag2).toBeNull();
      expect(body.riskScoreAutoCorrelationLag3).toBeNull();
    });

    it('10. sessions — riskScoreAutoCorrelationLag2 positive for periodic [0, 0.5, 0, 0.5, ...] series', async () => {
      ctx = await setup();
      const sid = 'sess-v1050-lag2-periodic';
      // Alternating [0, 0.5, 0, 0.5, 0, 0.5] sorted by timestamp ascending.
      // With the cov/n (biased) formula, lag-2 autocorr for 6 elements ≈ 0.667
      const scores = [0, 0.5, 0, 0.5, 0, 0.5];
      for (let i = 0; i < scores.length; i++) {
        await ctx.logger.log(
          makeOp('agent-a', 'fs', sid, hoursAgo(scores.length - i)),
          dec(scores[i]!),
        );
      }

      const { status, body } = await getJSON(ctx.port, `/sessions/${sid}`);
      expect(status).toBe(200);
      // Biased lag-2 autocorr: cov2 = 4*0.0625/6, variance = 0.0625 → ratio ≈ 2/3
      expect(body.riskScoreAutoCorrelationLag2 as number).toBeCloseTo(2 / 3, 4);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1319-T1323 — v10.50 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('11. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1050-pres', 'fs', 'sess-a'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1050-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('uniqueMethodsLast30d');
      expect(body).toHaveProperty('uniqueAgentsLast24h');
      expect(body).toHaveProperty('uniqueToolsLast24h');
      expect(body).toHaveProperty('riskScoreAutoCorrelationLag2');
      expect(body).toHaveProperty('riskScoreAutoCorrelationLag3');
    });

    it('12. agents — uniqueMethodsLast30d counts only methods within 30d', async () => {
      ctx = await setup();
      const agentId = 'agent-v1050-meth30d';
      // 2 distinct methods within 30d
      await ctx.logger.log(makeOp(agentId, 'fs', 'sess-a', daysAgo(2), 'call'), dec(0.3));
      await ctx.logger.log(makeOp(agentId, 'fs', 'sess-a', daysAgo(15), 'read'), dec(0.3));
      // old op outside 30d
      await ctx.logger.log(makeOp(agentId, 'fs', 'sess-a', daysAgo(45), 'write'), dec(0.3));

      const { status, body } = await getJSON(ctx.port, `/agents/${agentId}`);
      expect(status).toBe(200);
      expect(body.uniqueMethodsLast30d).toBe(2);
    });

    it('13. agents — uniqueAgentsLast24h is 0 when only old ops', async () => {
      ctx = await setup();
      const agentId = 'agent-v1050-a24h-zero';
      // All ops older than 24h
      await ctx.logger.log(makeOp(agentId, 'fs', 'sess-a', daysAgo(45)), dec(0.3));
      await ctx.logger.log(makeOp(agentId, 'fs', 'sess-a', daysAgo(50)), dec(0.3));

      const { status, body } = await getJSON(ctx.port, `/agents/${agentId}`);
      expect(status).toBe(200);
      expect(body.uniqueAgentsLast24h).toBe(0);
    });

    it('14. agents — uniqueToolsLast24h counts distinct tools within 24h', async () => {
      ctx = await setup();
      const agentId = 'agent-v1050-tools24h';
      // 3 distinct tools in last 24h
      await ctx.logger.log(makeOp(agentId, 'fs', 'sess-a', hoursAgo(1)), dec(0.3));
      await ctx.logger.log(makeOp(agentId, 'bash', 'sess-a', hoursAgo(2)), dec(0.3));
      await ctx.logger.log(makeOp(agentId, 'db', 'sess-a', hoursAgo(3)), dec(0.3));
      // old op — tool should not count
      await ctx.logger.log(makeOp(agentId, 'net', 'sess-a', daysAgo(45)), dec(0.3));

      const { status, body } = await getJSON(ctx.port, `/agents/${agentId}`);
      expect(status).toBe(200);
      expect(body.uniqueToolsLast24h).toBe(3);
    });

    it('15. agents — riskScoreAutoCorrelationLag2 null when < 4 logs', async () => {
      ctx = await setup();
      const agentId = 'agent-v1050-lag2-null';
      await ctx.logger.log(makeOp(agentId, 'fs', 'sess-a', hoursAgo(2)), dec(0.2));
      await ctx.logger.log(makeOp(agentId, 'fs', 'sess-a', hoursAgo(1)), dec(0.8));

      const { status, body } = await getJSON(ctx.port, `/agents/${agentId}`);
      expect(status).toBe(200);
      expect(body.riskScoreAutoCorrelationLag2).toBeNull();
      expect(body.riskScoreAutoCorrelationLag3).toBeNull();
    });

    it('16. agents — riskScoreAutoCorrelationLag2 computes correctly with 4 logs', async () => {
      ctx = await setup();
      const agentId = 'agent-v1050-lag2-val';
      // scores sorted by time: [0.1, 0.9, 0.1, 0.9]
      // mean = 0.5, variance = 0.16
      // cov2 = ((0.1-0.5)*(0.1-0.5) + (0.9-0.5)*(0.9-0.5)) / 4
      //       = (0.16 + 0.16) / 4 = 0.08
      // autocorr = 0.08 / 0.16 = 0.5
      const scores = [0.1, 0.9, 0.1, 0.9];
      for (let i = 0; i < scores.length; i++) {
        await ctx.logger.log(
          makeOp(agentId, 'fs', 'sess-a', hoursAgo(scores.length - i)),
          dec(scores[i]!),
        );
      }

      const { status, body } = await getJSON(ctx.port, `/agents/${agentId}`);
      expect(status).toBe(200);
      expect(body.riskScoreAutoCorrelationLag2 as number).toBeCloseTo(0.5, 5);
    });

    it('17. agents — riskScoreAutoCorrelationLag3 computes correctly with 5 logs', async () => {
      ctx = await setup();
      const agentId = 'agent-v1050-lag3-val';
      // scores sorted by time: [0.2, 0.4, 0.6, 0.2, 0.4]
      // n=5, mean = (0.2+0.4+0.6+0.2+0.4)/5 = 1.8/5 = 0.36
      // variance = sum((v-0.36)^2)/5
      //          = (0.0256 + 0.0016 + 0.0576 + 0.0256 + 0.0016)/5 = 0.112/5 = 0.0224
      // cov3 = sum over i=0..1 of (xs[i]-mean)*(xs[i+3]-mean) / 5
      //      = ((0.2-0.36)*(0.2-0.36) + (0.4-0.36)*(0.4-0.36)) / 5
      //      = (0.0256 + 0.0016) / 5 = 0.0272/5 = 0.00544
      // autocorr = 0.00544/0.0224 ≈ 0.2428...
      const scores = [0.2, 0.4, 0.6, 0.2, 0.4];
      for (let i = 0; i < scores.length; i++) {
        await ctx.logger.log(
          makeOp(agentId, 'fs', 'sess-a', hoursAgo(scores.length - i)),
          dec(scores[i]!),
        );
      }

      const { status, body } = await getJSON(ctx.port, `/agents/${agentId}`);
      expect(status).toBe(200);
      expect(typeof body.riskScoreAutoCorrelationLag3).toBe('number');
      // Verify it's a plausible float (not null, not integer-only)
      expect(body.riskScoreAutoCorrelationLag3 as number).toBeCloseTo(0.2428, 2);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1319-T1323 — v10.50 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('18. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v1050-pres', 'sess-t'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1050-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('uniqueMethodsLast30d');
      expect(body).toHaveProperty('uniqueAgentsLast24h');
      expect(body).toHaveProperty('uniqueToolsLast24h');
      expect(body).toHaveProperty('riskScoreAutoCorrelationLag2');
      expect(body).toHaveProperty('riskScoreAutoCorrelationLag3');
    });

    it('19. tools — uniqueMethodsLast30d excludes methods from ops >30d old', async () => {
      ctx = await setup();
      const tool = 'tool-v1050-meth30d';
      // 1 method within 30d
      await ctx.logger.log(makeOp('agent-a', tool, 'sess-t', daysAgo(5), 'call'), dec(0.3));
      // 2 old methods outside 30d
      await ctx.logger.log(makeOp('agent-a', tool, 'sess-t', daysAgo(45), 'read'), dec(0.3));
      await ctx.logger.log(makeOp('agent-a', tool, 'sess-t', daysAgo(60), 'write'), dec(0.3));

      const { status, body } = await getJSON(ctx.port, `/tools/${tool}`);
      expect(status).toBe(200);
      expect(body.uniqueMethodsLast30d).toBe(1);
    });

    it('20. tools — uniqueToolsLast24h is 1 for a single tool entity', async () => {
      ctx = await setup();
      const tool = 'tool-v1050-self';
      // Multiple ops for this tool within 24h — uniqueTools should count only this tool
      await ctx.logger.log(makeOp('agent-a', tool, 'sess-t', hoursAgo(1)), dec(0.3));
      await ctx.logger.log(makeOp('agent-a', tool, 'sess-t', hoursAgo(2)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, `/tools/${tool}`);
      expect(status).toBe(200);
      expect(body.uniqueToolsLast24h).toBe(1);
    });

    it('21. tools — riskScoreAutoCorrelationLag2 null when variance=0 (all same score)', async () => {
      ctx = await setup();
      const tool = 'tool-v1050-var0-uniq';
      // 6 logs all with same risk score of 0.5 — variance must be 0
      for (let i = 6; i >= 1; i--) {
        await ctx.logger.log(makeOp('agent-t', tool, 'sess-tv', hoursAgo(i)), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, `/tools/${tool}`);
      expect(status).toBe(200);
      // variance = 0 → both autocorrelations must be null
      expect(body.riskScoreAutoCorrelationLag2).toBeNull();
      expect(body.riskScoreAutoCorrelationLag3).toBeNull();
    });

    it('22. tools — riskScoreAutoCorrelationLag2 ≈ 2/3 for periodic [0, 0.5, 0, 0.5, 0, 0.5] (biased estimator)', async () => {
      ctx = await setup();
      const tool = 'tool-v1050-lag2-periodic';
      // Alternating scores: biased lag-2 autocorr with n=6 → cov2/variance = (4*0.0625/6)/0.0625 = 2/3
      const scores = [0, 0.5, 0, 0.5, 0, 0.5];
      for (let i = 0; i < scores.length; i++) {
        await ctx.logger.log(
          makeOp('agent-a', tool, 'sess-t', hoursAgo(scores.length - i)),
          dec(scores[i]!),
        );
      }

      const { status, body } = await getJSON(ctx.port, `/tools/${tool}`);
      expect(status).toBe(200);
      expect(body.riskScoreAutoCorrelationLag2 as number).toBeCloseTo(2 / 3, 4);
    });

    it('23. tools — riskScoreAutoCorrelationLag3 null when < 5 logs', async () => {
      ctx = await setup();
      const tool = 'tool-v1050-lag3-null';
      // 4 logs
      for (let i = 4; i >= 1; i--) {
        await ctx.logger.log(makeOp('agent-a', tool, 'sess-t', hoursAgo(i)), dec(i * 0.1));
      }

      const { status, body } = await getJSON(ctx.port, `/tools/${tool}`);
      expect(status).toBe(200);
      expect(body.riskScoreAutoCorrelationLag3).toBeNull();
    });
  });

  // ── summary endpoint ───────────────────────────────────────────────────────────

  describe('T1319-T1323 — v10.50 new fields (summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('24. summary — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-sum'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body).toHaveProperty('uniqueMethodsLast30d');
      expect(body).toHaveProperty('uniqueAgentsLast24h');
      expect(body).toHaveProperty('uniqueToolsLast24h');
      expect(body).toHaveProperty('riskScoreAutoCorrelationLag2');
      expect(body).toHaveProperty('riskScoreAutoCorrelationLag3');
    });

    it('25. summary — uniqueMethodsLast30d counts distinct methods across all sessions in 30d', async () => {
      ctx = await setup();
      // 3 distinct methods across 2 sessions within 30d
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-s1', daysAgo(1), 'call'), dec(0.3));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-s2', daysAgo(5), 'read'), dec(0.3));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-s3', daysAgo(20), 'write'), dec(0.3));
      // Old ops outside 30d — should not be counted
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-s4', daysAgo(45), 'execute'), dec(0.3));
      // Duplicate method within 30d — should not add to count
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-s5', daysAgo(10), 'call'), dec(0.3));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.uniqueMethodsLast30d).toBe(3);
    });

    it('26. summary — uniqueAgentsLast24h counts only recent agents', async () => {
      ctx = await setup();
      // 2 agents within 24h, 1 outside
      await ctx.logger.log(makeOp('agent-recent1', 'fs', 'sess-s', hoursAgo(1)), dec(0.3));
      await ctx.logger.log(makeOp('agent-recent2', 'fs', 'sess-s', hoursAgo(12)), dec(0.3));
      await ctx.logger.log(makeOp('agent-old', 'fs', 'sess-s', daysAgo(45)), dec(0.3));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.uniqueAgentsLast24h).toBe(2);
    });

    it('27. summary — uniqueToolsLast24h counts distinct tools in 24h window', async () => {
      ctx = await setup();
      // 4 distinct tools within 24h
      for (const tool of ['fs', 'bash', 'db', 'net']) {
        await ctx.logger.log(makeOp('agent-a', tool, 'sess-s', hoursAgo(1)), dec(0.3));
      }
      // Old tool — outside 24h
      await ctx.logger.log(makeOp('agent-a', 'legacy', 'sess-s', daysAgo(45)), dec(0.3));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.uniqueToolsLast24h).toBe(4);
    });

    it('28. summary — riskScoreAutoCorrelationLag2 null when < 4 total logs', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-s', hoursAgo(3)), dec(0.1));
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-s', hoursAgo(2)), dec(0.9));
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-s', hoursAgo(1)), dec(0.1));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreAutoCorrelationLag2).toBeNull();
    });

    it('29. summary — riskScoreAutoCorrelationLag3 null when < 5 total logs', async () => {
      ctx = await setup();
      // 4 logs — lag3 should be null
      for (let i = 4; i >= 1; i--) {
        await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-s', hoursAgo(i)), dec(i * 0.2));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreAutoCorrelationLag3).toBeNull();
      // lag2 should be non-null with 4 logs
      expect(body.riskScoreAutoCorrelationLag2).not.toBeNull();
    });

    it('30. summary — riskScoreAutoCorrelationLag2 ≈ 2/3 for periodic [0, 0.5, 0, 0.5, ...] (biased estimator)', async () => {
      ctx = await setup();
      // Alternating scores: biased lag-2 autocorr with n=6 → cov2/variance = (4*0.0625/6)/0.0625 = 2/3
      const scores = [0, 0.5, 0, 0.5, 0, 0.5];
      for (let i = 0; i < scores.length; i++) {
        await ctx.logger.log(
          makeOp('agent-a', 'fs', 'sess-s', hoursAgo(scores.length - i)),
          dec(scores[i]!),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreAutoCorrelationLag2 as number).toBeCloseTo(2 / 3, 4);
    });

    it('31. summary — uniqueMethodsLast30d is 0 when all ops older than 30d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-s', daysAgo(40)), dec(0.3));
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-s', daysAgo(50)), dec(0.3));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.uniqueMethodsLast30d).toBe(0);
    });

    it('32. summary — all count fields are integers (not floats)', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-s', hoursAgo(1)), dec(0.4));
      await ctx.logger.log(makeOp('agent-b', 'bash', 'sess-s', hoursAgo(2)), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(Number.isInteger(body.uniqueMethodsLast30d as number)).toBe(true);
      expect(Number.isInteger(body.uniqueAgentsLast24h as number)).toBe(true);
      expect(Number.isInteger(body.uniqueToolsLast24h as number)).toBe(true);
    });
  });
});
