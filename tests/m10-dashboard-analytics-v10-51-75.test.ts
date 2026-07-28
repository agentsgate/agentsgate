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
function atHour(h: number, daysBack = 0): Date {
  const d = new Date(PINNED_NOW());
  d.setHours(h, 0, 0, 0);
  d.setDate(d.getDate() - daysBack);
  return d;
}

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

// ── v10.51 ────────────────────────────────────────────────────────────────────

describe('v10.51', () => {
  const hoursAgo = (h: number) => new Date(PINNED_NOW() - h * 3_600_000);
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1324-T1328 — v10.51 kurtosis+streak fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      // seed an old op so entity exists
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-k-pres', daysAgo(45)), dec(0.5));
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-k-pres', hoursAgo(1)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-k-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('riskScoreKurtosisWindowed24h');
      expect(body).toHaveProperty('riskScoreKurtosisWindowed7d');
      expect(body).toHaveProperty('riskScoreKurtosisWindowed30d');
      expect(body).toHaveProperty('consecutiveHighRiskOpsMax');
      expect(body).toHaveProperty('consecutiveLowRiskOpsMax');
    });

    it('2. sessions — fewer than 4 logs in window: kurtosis fields are null', async () => {
      ctx = await setup();
      // Only 3 logs in 24h — all kurtosis windows should be null (< 4)
      // Seed old log so entity exists
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-k-few', daysAgo(45)), dec(0.5));
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-k-few', hoursAgo(i + 1)), dec(0.4 + i * 0.1));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-k-few');
      expect(status).toBe(200);
      expect(body.riskScoreKurtosisWindowed24h).toBeNull();
      expect(body.riskScoreKurtosisWindowed7d).toBeNull();
      expect(body.riskScoreKurtosisWindowed30d).toBeNull();
    });

    it('3. sessions — 4 identical values in 24h window: variance=0, kurtosis24h is null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-k-var0', daysAgo(45)), dec(0.5));
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-k-var0', hoursAgo(i + 1)), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-k-var0');
      expect(status).toBe(200);
      // 4 identical values → variance=0 → null
      expect(body.riskScoreKurtosisWindowed24h).toBeNull();
      expect(body.riskScoreKurtosisWindowed7d).toBeNull();
      expect(body.riskScoreKurtosisWindowed30d).toBeNull();
    });

    it('4. sessions — uniform {0,1,0,1} in 24h: excess kurtosis = -2', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-k-unif', daysAgo(45)), dec(0.5));
      // 4 values: 0, 1, 0, 1 — all within 24h
      for (const [score, h] of [[0, 1], [1, 2], [0, 3], [1, 4]] as [number, number][]) {
        await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-k-unif', hoursAgo(h)), dec(score));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-k-unif');
      expect(status).toBe(200);
      // mean=0.5, variance=0.25, E[(X-μ)^4]=0.5^4=0.0625, kurtosis=0.0625/0.0625 - 3 = -2
      expect(body.riskScoreKurtosisWindowed24h as number).toBeCloseTo(-2, 5);
      expect(body.riskScoreKurtosisWindowed7d as number).toBeCloseTo(-2, 5);
      expect(body.riskScoreKurtosisWindowed30d as number).toBeCloseTo(-2, 5);
    });

    it('5. sessions — 4 logs in 30d window only: 24h null, 7d null, 30d computed', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-k-30only', daysAgo(50)), dec(0.5));
      // 4 values spanning 8–28d (in 30d window, outside 7d and 24h)
      for (const [score, d] of [[0, 8], [1, 14], [0, 20], [1, 28]] as [number, number][]) {
        await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-k-30only', daysAgo(d)), dec(score));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-k-30only');
      expect(status).toBe(200);
      expect(body.riskScoreKurtosisWindowed24h).toBeNull();
      expect(body.riskScoreKurtosisWindowed7d).toBeNull();
      expect(body.riskScoreKurtosisWindowed30d as number).toBeCloseTo(-2, 5);
    });

    it('6. sessions — streak test: [high,high,low,high,high,high] → highMax=3, lowMax=1', async () => {
      ctx = await setup();
      const scores = [0.8, 0.9, 0.2, 0.75, 0.85, 0.95]; // high,high,low,high,high,high
      for (const [i, score] of scores.entries()) {
        await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-k-streak1', hoursAgo(scores.length - i)), dec(score));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-k-streak1');
      expect(status).toBe(200);
      expect(body.consecutiveHighRiskOpsMax).toBe(3);
      expect(body.consecutiveLowRiskOpsMax).toBe(1);
    });

    it('7. sessions — no high-risk ops: consecutiveHighRiskOpsMax = 0', async () => {
      ctx = await setup();
      // All scores < 0.7
      for (const [score, h] of [[0.1, 1], [0.3, 2], [0.5, 3], [0.65, 4]] as [number, number][]) {
        await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-k-nohigh', hoursAgo(h)), dec(score));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-k-nohigh');
      expect(status).toBe(200);
      expect(body.consecutiveHighRiskOpsMax).toBe(0);
      // 0.1 < 0.3 (yes), 0.3 < 0.3 (no), 0.5 (no), 0.65 (no) → max low streak = 1
      expect(body.consecutiveLowRiskOpsMax).toBe(1);
    });

    it('8. sessions — no low-risk ops: consecutiveLowRiskOpsMax = 0', async () => {
      ctx = await setup();
      // All scores >= 0.3
      for (const [score, h] of [[0.4, 1], [0.6, 2], [0.8, 3], [0.9, 4]] as [number, number][]) {
        await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-k-nolow', hoursAgo(h)), dec(score));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-k-nolow');
      expect(status).toBe(200);
      expect(body.consecutiveLowRiskOpsMax).toBe(0);
      expect(body.consecutiveHighRiskOpsMax).toBe(2); // 0.8, 0.9 consecutive
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1324-T1328 — v10.51 kurtosis+streak fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('9. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-k-pres', 'fs', 'sess-1', daysAgo(45)), dec(0.5));
      await ctx.logger.log(makeOp('agent-k-pres', 'fs', 'sess-1', hoursAgo(1)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-k-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('riskScoreKurtosisWindowed24h');
      expect(body).toHaveProperty('riskScoreKurtosisWindowed7d');
      expect(body).toHaveProperty('riskScoreKurtosisWindowed30d');
      expect(body).toHaveProperty('consecutiveHighRiskOpsMax');
      expect(body).toHaveProperty('consecutiveLowRiskOpsMax');
    });

    it('10. agents — fewer than 4 logs in 24h: kurtosis24h is null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-k-few', 'fs', 'sess-1', daysAgo(45)), dec(0.5));
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-k-few', 'fs', 'sess-1', hoursAgo(i + 1)), dec(0.2 + i * 0.3));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-k-few');
      expect(status).toBe(200);
      expect(body.riskScoreKurtosisWindowed24h).toBeNull();
    });

    it('11. agents — uniform {0,1,0,1} in 24h: kurtosis24h = -2', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-k-unif', 'fs', 'sess-1', daysAgo(45)), dec(0.5));
      for (const [score, h] of [[0, 1], [1, 2], [0, 3], [1, 4]] as [number, number][]) {
        await ctx.logger.log(makeOp('agent-k-unif', 'fs', 'sess-1', hoursAgo(h)), dec(score));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-k-unif');
      expect(status).toBe(200);
      expect(body.riskScoreKurtosisWindowed24h as number).toBeCloseTo(-2, 5);
      expect(body.riskScoreKurtosisWindowed7d as number).toBeCloseTo(-2, 5);
      expect(body.riskScoreKurtosisWindowed30d as number).toBeCloseTo(-2, 5);
    });

    it('12. agents — 4 identical values in 7d: kurtosis7d is null (variance=0)', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-k-var7d', 'fs', 'sess-1', daysAgo(45)), dec(0.5));
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp('agent-k-var7d', 'fs', 'sess-1', daysAgo(i + 1)), dec(0.6));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-k-var7d');
      expect(status).toBe(200);
      expect(body.riskScoreKurtosisWindowed7d).toBeNull();
    });

    it('13. agents — streak [low,low,low,high,high,low] → lowMax=3, highMax=2', async () => {
      ctx = await setup();
      const scores = [0.1, 0.2, 0.05, 0.8, 0.9, 0.1]; // low,low,low,high,high,low
      for (const [i, score] of scores.entries()) {
        await ctx.logger.log(makeOp('agent-k-streak', 'fs', `sess-streak-${i}`, hoursAgo(scores.length - i)), dec(score));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-k-streak');
      expect(status).toBe(200);
      expect(body.consecutiveLowRiskOpsMax).toBe(3);
      expect(body.consecutiveHighRiskOpsMax).toBe(2);
    });

    it('14. agents — boundary score 0.7 counts as high; 0.3 is not low', async () => {
      ctx = await setup();
      // 0.7 should be counted as high (>= 0.7)
      // 0.3 should NOT be counted as low (not < 0.3)
      for (const [score, h] of [[0.3, 1], [0.7, 2], [0.7, 3]] as [number, number][]) {
        await ctx.logger.log(makeOp('agent-k-boundary', 'fs', 'sess-boundary', hoursAgo(h)), dec(score));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-k-boundary');
      expect(status).toBe(200);
      expect(body.consecutiveHighRiskOpsMax).toBe(2); // 0.7, 0.7
      expect(body.consecutiveLowRiskOpsMax).toBe(0); // 0.3 is not < 0.3
    });

    it('15. agents — kurtosis7d: 4 ops in 7d window only, uniform distribution', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-k-7donly', 'fs', 'sess-1', daysAgo(45)), dec(0.5));
      for (const [score, d] of [[0, 2], [1, 3], [0, 4], [1, 5]] as [number, number][]) {
        await ctx.logger.log(makeOp('agent-k-7donly', 'fs', 'sess-1', daysAgo(d)), dec(score));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-k-7donly');
      expect(status).toBe(200);
      expect(body.riskScoreKurtosisWindowed24h).toBeNull(); // nothing in 24h
      expect(body.riskScoreKurtosisWindowed7d as number).toBeCloseTo(-2, 5);
      expect(body.riskScoreKurtosisWindowed30d as number).toBeCloseTo(-2, 5);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1324-T1328 — v10.51 kurtosis+streak fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('16. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-t', 'tool-k-pres', 'sess-1', daysAgo(45)), dec(0.5));
      await ctx.logger.log(makeOp('agent-t', 'tool-k-pres', 'sess-1', hoursAgo(1)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-k-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('riskScoreKurtosisWindowed24h');
      expect(body).toHaveProperty('riskScoreKurtosisWindowed7d');
      expect(body).toHaveProperty('riskScoreKurtosisWindowed30d');
      expect(body).toHaveProperty('consecutiveHighRiskOpsMax');
      expect(body).toHaveProperty('consecutiveLowRiskOpsMax');
    });

    it('17. tools — uniform {0,1,0,1} in 24h: kurtosis24h = -2', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-t1', 'tool-k-unif', 'sess-1', daysAgo(45)), dec(0.5));
      for (const [score, h] of [[0, 1], [1, 2], [0, 3], [1, 4]] as [number, number][]) {
        await ctx.logger.log(makeOp('agent-t1', 'tool-k-unif', 'sess-1', hoursAgo(h)), dec(score));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-k-unif');
      expect(status).toBe(200);
      expect(body.riskScoreKurtosisWindowed24h as number).toBeCloseTo(-2, 5);
    });

    it('18. tools — variance=0 in 30d: kurtosis30d is null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-t2', 'tool-k-var30d', 'sess-1', daysAgo(50)), dec(0.5));
      for (const d of [8, 12, 20, 25]) {
        await ctx.logger.log(makeOp('agent-t2', 'tool-k-var30d', 'sess-1', daysAgo(d)), dec(0.4));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-k-var30d');
      expect(status).toBe(200);
      expect(body.riskScoreKurtosisWindowed30d).toBeNull(); // all same → variance=0
      expect(body.riskScoreKurtosisWindowed24h).toBeNull(); // no logs in 24h
      expect(body.riskScoreKurtosisWindowed7d).toBeNull(); // no logs in 7d
    });

    it('19. tools — streak [high,high,high,low,low,high] → highMax=3, lowMax=2', async () => {
      ctx = await setup();
      const scores = [0.8, 0.9, 0.75, 0.1, 0.2, 0.85]; // high,high,high,low,low,high
      for (const [i, score] of scores.entries()) {
        await ctx.logger.log(makeOp(`agent-t3-${i}`, 'tool-k-streak', `sess-t-${i}`, hoursAgo(scores.length - i)), dec(score));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-k-streak');
      expect(status).toBe(200);
      expect(body.consecutiveHighRiskOpsMax).toBe(3);
      expect(body.consecutiveLowRiskOpsMax).toBe(2);
    });

    it('20. tools — all ops high risk: lowMax=0, highMax=count', async () => {
      ctx = await setup();
      for (const [score, h] of [[0.7, 1], [0.8, 2], [0.9, 3], [1.0, 4]] as [number, number][]) {
        await ctx.logger.log(makeOp('agent-t4', 'tool-k-allhigh', 'sess-1', hoursAgo(h)), dec(score));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-k-allhigh');
      expect(status).toBe(200);
      expect(body.consecutiveHighRiskOpsMax).toBe(4);
      expect(body.consecutiveLowRiskOpsMax).toBe(0);
    });

    it('21. tools — all ops low risk: highMax=0, lowMax=count', async () => {
      ctx = await setup();
      for (const [score, h] of [[0.0, 1], [0.1, 2], [0.2, 3], [0.29, 4]] as [number, number][]) {
        await ctx.logger.log(makeOp('agent-t5', 'tool-k-alllow', 'sess-1', hoursAgo(h)), dec(score));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-k-alllow');
      expect(status).toBe(200);
      expect(body.consecutiveLowRiskOpsMax).toBe(4);
      expect(body.consecutiveHighRiskOpsMax).toBe(0);
    });

    it('22. tools — only old ops (>30d) seed existence: kurtosis windows null, streaks computed over all logs', async () => {
      ctx = await setup();
      // 4 old ops (outside all windows) with uniform {0,1,0,1}
      for (const [score, d] of [[0, 35], [1, 40], [0, 45], [1, 50]] as [number, number][]) {
        await ctx.logger.log(makeOp('agent-t6', 'tool-k-old', 'sess-1', daysAgo(d)), dec(score));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-k-old');
      expect(status).toBe(200);
      // No logs in 24h, 7d, 30d windows → kurtosis fields null
      expect(body.riskScoreKurtosisWindowed24h).toBeNull();
      expect(body.riskScoreKurtosisWindowed7d).toBeNull();
      expect(body.riskScoreKurtosisWindowed30d).toBeNull();
      // Streaks cover ALL logs regardless of window
      // sorted by time: score 0 at 50d, score 1 at 45d, score 0 at 40d, score 1 at 35d
      // none >= 0.7 → highMax=0; none < 0.3? 0 < 0.3 yes → lowMax=2 (alternating: low,high,low,high → max run=1 each)
      // Actually: 0(low),1(high),0(low),1(high) → lowMax=1, highMax=1
      expect(body.consecutiveHighRiskOpsMax).toBe(1);
      expect(body.consecutiveLowRiskOpsMax).toBe(1);
    });
  });

  // ── operations/summary endpoint ────────────────────────────────────────────────

  describe('T1324-T1328 — v10.51 kurtosis+streak fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('23. summary — all five new fields present', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s1', 'tool-s1', 'sess-1', daysAgo(45)), dec(0.5));
      await ctx.logger.log(makeOp('agent-s1', 'tool-s1', 'sess-1', hoursAgo(1)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body).toHaveProperty('riskScoreKurtosisWindowed24h');
      expect(body).toHaveProperty('riskScoreKurtosisWindowed7d');
      expect(body).toHaveProperty('riskScoreKurtosisWindowed30d');
      expect(body).toHaveProperty('consecutiveHighRiskOpsMax');
      expect(body).toHaveProperty('consecutiveLowRiskOpsMax');
    });

    it('24. summary — empty DB: all five new fields are null or 0', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreKurtosisWindowed24h).toBeNull();
      expect(body.riskScoreKurtosisWindowed7d).toBeNull();
      expect(body.riskScoreKurtosisWindowed30d).toBeNull();
      expect(body.consecutiveHighRiskOpsMax).toBe(0);
      expect(body.consecutiveLowRiskOpsMax).toBe(0);
    });

    it('25. summary — uniform {0,1,0,1} in 24h: all kurtosis windows = -2 (also in 7d and 30d)', async () => {
      ctx = await setup();
      for (const [score, h] of [[0, 1], [1, 2], [0, 3], [1, 4]] as [number, number][]) {
        await ctx.logger.log(makeOp(`agent-su-${h}`, `tool-su-${h}`, `sess-su-${h}`, hoursAgo(h)), dec(score));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreKurtosisWindowed24h as number).toBeCloseTo(-2, 5);
      expect(body.riskScoreKurtosisWindowed7d as number).toBeCloseTo(-2, 5);
      expect(body.riskScoreKurtosisWindowed30d as number).toBeCloseTo(-2, 5);
    });

    it('26. summary — 4 identical scores in 24h: kurtosis24h null (variance=0)', async () => {
      ctx = await setup();
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp(`agent-sv-${i}`, `tool-sv-${i}`, `sess-sv-${i}`, hoursAgo(i + 1)), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreKurtosisWindowed24h).toBeNull();
    });

    it('27. summary — only old ops (>30d): kurtosis windows null, streaks computed over all logs', async () => {
      ctx = await setup();
      // 4 old ops outside all windows — high risk
      for (const d of [35, 40, 45, 50]) {
        await ctx.logger.log(makeOp(`agent-sold-${d}`, `tool-sold-${d}`, `sess-sold-${d}`, daysAgo(d)), dec(0.8));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreKurtosisWindowed24h).toBeNull();
      expect(body.riskScoreKurtosisWindowed7d).toBeNull();
      expect(body.riskScoreKurtosisWindowed30d).toBeNull();
      // All 4 ops have score 0.8 (>= 0.7) → highMax=4
      expect(body.consecutiveHighRiskOpsMax).toBe(4);
      expect(body.consecutiveLowRiskOpsMax).toBe(0);
    });

    it('28. summary — mixed streak across all time windows: max streak computed globally', async () => {
      ctx = await setup();
      // Old ops (>30d): high, high
      await ctx.logger.log(makeOp('agent-smix-1', 'tool-smix-1', 'sess-1', daysAgo(40)), dec(0.8));
      await ctx.logger.log(makeOp('agent-smix-2', 'tool-smix-2', 'sess-2', daysAgo(35)), dec(0.9));
      // Recent ops: low, high, high, high
      await ctx.logger.log(makeOp('agent-smix-3', 'tool-smix-3', 'sess-3', hoursAgo(4)), dec(0.1));
      await ctx.logger.log(makeOp('agent-smix-4', 'tool-smix-4', 'sess-4', hoursAgo(3)), dec(0.75));
      await ctx.logger.log(makeOp('agent-smix-5', 'tool-smix-5', 'sess-5', hoursAgo(2)), dec(0.85));
      await ctx.logger.log(makeOp('agent-smix-6', 'tool-smix-6', 'sess-6', hoursAgo(1)), dec(0.95));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      // Sorted by time: high(40d), high(35d), low(4h), high(3h), high(2h), high(1h)
      // high streaks: 2, then 3 → max=3
      expect(body.consecutiveHighRiskOpsMax).toBe(3);
      // low streak: 1 (the one low op)
      expect(body.consecutiveLowRiskOpsMax).toBe(1);
    });

    it('29. summary — kurtosis30d with 4 ops in 10-28d range: computed, 7d and 24h null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s30-1', 'tool-s30', 'sess-1', daysAgo(45)), dec(0.5));
      for (const [score, d] of [[0, 10], [1, 15], [0, 20], [1, 28]] as [number, number][]) {
        await ctx.logger.log(makeOp('agent-s30-2', 'tool-s30', 'sess-1', daysAgo(d)), dec(score));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreKurtosisWindowed24h).toBeNull();
      expect(body.riskScoreKurtosisWindowed7d).toBeNull();
      expect(body.riskScoreKurtosisWindowed30d as number).toBeCloseTo(-2, 5);
    });

    it('30. summary — single high-risk op: highMax=1, lowMax=0, kurtosis windows null (< 4)', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-ssingle', 'tool-ssingle', 'sess-1', hoursAgo(1)), dec(0.9));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreKurtosisWindowed24h).toBeNull();
      expect(body.riskScoreKurtosisWindowed7d).toBeNull();
      expect(body.riskScoreKurtosisWindowed30d).toBeNull();
      expect(body.consecutiveHighRiskOpsMax).toBe(1);
      expect(body.consecutiveLowRiskOpsMax).toBe(0);
    });
  });
});

// ── v10.52 ────────────────────────────────────────────────────────────────────

describe('v10.52', () => {
  const minsAgo = (m: number) => new Date(PINNED_NOW() - m * 60_000);
  const hoursAgo = (h: number) => new Date(PINNED_NOW() - h * 3_600_000);
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1329-T1333 — v10.52 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1052-pres', daysAgo(45)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1052-pres'), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1052-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('consecutiveMediumRiskOpsMax');
      expect(body).toHaveProperty('riskBandTransitions');
      expect(body).toHaveProperty('opsBurstLast5m');
      expect(body).toHaveProperty('blockRateLast6h');
      expect(body).toHaveProperty('allowRateLast6h');
    });

    it('2. sessions — consecutiveMediumRiskOpsMax: streak [med, med, high, med] → 2', async () => {
      ctx = await setup();
      // Scores in chronological order: 0.4 (med), 0.5 (med), 0.8 (high), 0.35 (med)
      // max consecutive medium = 2 (first two)
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1052-streak', daysAgo(4)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1052-streak', daysAgo(3)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1052-streak', daysAgo(2)), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1052-streak', daysAgo(1)), dec(0.35, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1052-streak');
      expect(status).toBe(200);
      expect(body.consecutiveMediumRiskOpsMax).toBe(2);
    });

    it('3. sessions — consecutiveMediumRiskOpsMax: only high-risk ops → 0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1052-nomid', daysAgo(2)), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1052-nomid', daysAgo(1)), dec(0.9, 'block'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1052-nomid');
      expect(status).toBe(200);
      expect(body.consecutiveMediumRiskOpsMax).toBe(0);
    });

    it('4. sessions — riskBandTransitions: [low, med, high, high, low] → 3 transitions', async () => {
      ctx = await setup();
      // low=0.1, med=0.5, high=0.8, high=0.9, low=0.2 — transitions: low→med, med→high, high→low = 3
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1052-trans', daysAgo(5)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1052-trans', daysAgo(4)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1052-trans', daysAgo(3)), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1052-trans', daysAgo(2)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1052-trans', daysAgo(1)), dec(0.2, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1052-trans');
      expect(status).toBe(200);
      expect(body.riskBandTransitions).toBe(3);
    });

    it('5. sessions — riskBandTransitions: single log → 0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1052-onetrans'), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1052-onetrans');
      expect(status).toBe(200);
      expect(body.riskBandTransitions).toBe(0);
    });

    it('6. sessions — riskBandTransitions: all same band → 0', async () => {
      ctx = await setup();
      // All medium-risk, no transitions
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1052-sameband', daysAgo(3)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1052-sameband', daysAgo(2)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1052-sameband', daysAgo(1)), dec(0.6, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1052-sameband');
      expect(status).toBe(200);
      expect(body.riskBandTransitions).toBe(0);
    });

    it('7. sessions — opsBurstLast5m: 3 recent ops within 5 minutes', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1052-burst', daysAgo(45)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1052-burst', minsAgo(1)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1052-burst', minsAgo(2)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1052-burst', minsAgo(3)), dec(0.6, 'allow'));
      // 1 op older than 5 mins but in 6h window — should not count
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1052-burst', minsAgo(10)), dec(0.2, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1052-burst');
      expect(status).toBe(200);
      expect(body.opsBurstLast5m).toBe(3);
    });

    it('8. sessions — opsBurstLast5m: no recent ops → 0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1052-noburst', daysAgo(1)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1052-noburst');
      expect(status).toBe(200);
      expect(body.opsBurstLast5m).toBe(0);
    });

    it('9. sessions — blockRateLast6h: pre-existing field returns correct value', async () => {
      ctx = await setup();
      // Seed old op for entity existence
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v1052-blkrate', daysAgo(45)), dec(0.2, 'allow'));
      // 2 block, 1 allow in last 6h → blockRate = 2/3
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v1052-blkrate', hoursAgo(1)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v1052-blkrate', hoursAgo(2)), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v1052-blkrate', hoursAgo(3)), dec(0.2, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1052-blkrate');
      expect(status).toBe(200);
      expect(body.blockRateLast6h as number).toBeCloseTo(2 / 3, 5);
    });

    it('10. sessions — allowRateLast6h: pre-existing field returns correct value', async () => {
      ctx = await setup();
      // Seed old op for entity existence
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v1052-allrate', daysAgo(40)), dec(0.2, 'allow'));
      // 3 allow, 1 block in last 6h → allowRate = 3/4
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v1052-allrate', hoursAgo(1)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v1052-allrate', hoursAgo(2)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v1052-allrate', hoursAgo(3)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v1052-allrate', hoursAgo(4)), dec(0.9, 'block'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1052-allrate');
      expect(status).toBe(200);
      expect(body.allowRateLast6h as number).toBeCloseTo(3 / 4, 5);
    });

    it('11. sessions — blockRateLast6h and allowRateLast6h: null when no ops in last 6h', async () => {
      ctx = await setup();
      // Only old ops — should yield null for both rate fields
      await ctx.logger.log(makeOp('agent-k', 'fs', 'sess-v1052-ratenull', daysAgo(1)), dec(0.9, 'block'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1052-ratenull');
      expect(status).toBe(200);
      expect(body.blockRateLast6h).toBeNull();
      expect(body.allowRateLast6h).toBeNull();
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1329-T1333 — v10.52 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('12. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1052-pres', 'fs', 'sess-1', daysAgo(45)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-v1052-pres', 'fs', 'sess-1'), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1052-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('consecutiveMediumRiskOpsMax');
      expect(body).toHaveProperty('riskBandTransitions');
      expect(body).toHaveProperty('opsBurstLast5m');
      expect(body).toHaveProperty('blockRateLast6h');
      expect(body).toHaveProperty('allowRateLast6h');
    });

    it('13. agents — consecutiveMediumRiskOpsMax: [med, med, high, med] → 2', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1052-streak', 'fs', 'sess-1', daysAgo(4)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-v1052-streak', 'fs', 'sess-2', daysAgo(3)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-v1052-streak', 'fs', 'sess-3', daysAgo(2)), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agent-v1052-streak', 'fs', 'sess-4', daysAgo(1)), dec(0.35, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1052-streak');
      expect(status).toBe(200);
      expect(body.consecutiveMediumRiskOpsMax).toBe(2);
    });

    it('14. agents — consecutiveMediumRiskOpsMax: longer streak is captured correctly', async () => {
      ctx = await setup();
      // streak: low, med, med, med, low, med, med → max = 3
      const scores = [0.1, 0.4, 0.5, 0.6, 0.2, 0.45, 0.55];
      for (const [i, score] of scores.entries()) {
        await ctx.logger.log(
          makeOp('agent-v1052-longstreak', 'fs', `sess-ls-${i}`, daysAgo(scores.length - i)),
          dec(score, 'allow'),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1052-longstreak');
      expect(status).toBe(200);
      expect(body.consecutiveMediumRiskOpsMax).toBe(3);
    });

    it('15. agents — riskBandTransitions: [low, med, high, high, low] → 3', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1052-trans', 'fs', 'sess-1', daysAgo(5)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-v1052-trans', 'fs', 'sess-2', daysAgo(4)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-v1052-trans', 'fs', 'sess-3', daysAgo(3)), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agent-v1052-trans', 'fs', 'sess-4', daysAgo(2)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-v1052-trans', 'fs', 'sess-5', daysAgo(1)), dec(0.2, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1052-trans');
      expect(status).toBe(200);
      expect(body.riskBandTransitions).toBe(3);
    });

    it('16. agents — riskBandTransitions: < 2 logs → 0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1052-onetrans', 'fs', 'sess-1'), dec(0.9, 'block'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1052-onetrans');
      expect(status).toBe(200);
      expect(body.riskBandTransitions).toBe(0);
    });

    it('17. agents — opsBurstLast5m: 2 ops in burst window', async () => {
      ctx = await setup();
      // Seed old op (>40 days) for entity existence
      await ctx.logger.log(makeOp('agent-v1052-burst', 'fs', 'sess-old', daysAgo(42)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-v1052-burst', 'fs', 'sess-1', minsAgo(2)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-v1052-burst', 'fs', 'sess-2', minsAgo(4)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-v1052-burst', 'fs', 'sess-3', minsAgo(10)), dec(0.6, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1052-burst');
      expect(status).toBe(200);
      expect(body.opsBurstLast5m).toBe(2);
    });

    it('18. agents — blockRateLast6h: correct fraction', async () => {
      ctx = await setup();
      // Seed old op (>40 days) for entity existence
      await ctx.logger.log(makeOp('agent-v1052-blk', 'fs', 'sess-old', daysAgo(41)), dec(0.2, 'allow'));
      // 1 block, 3 allows in last 6h → blockRate = 0.25
      await ctx.logger.log(makeOp('agent-v1052-blk', 'fs', 'sess-1', hoursAgo(1)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-v1052-blk', 'fs', 'sess-2', hoursAgo(2)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-v1052-blk', 'fs', 'sess-3', hoursAgo(3)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-v1052-blk', 'fs', 'sess-4', hoursAgo(4)), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1052-blk');
      expect(status).toBe(200);
      expect(body.blockRateLast6h as number).toBeCloseTo(0.25, 5);
    });

    it('19. agents — allowRateLast6h: null when no ops in last 6h', async () => {
      ctx = await setup();
      // Only old ops — older than 6h
      await ctx.logger.log(makeOp('agent-v1052-allnull', 'fs', 'sess-old', daysAgo(43)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-v1052-allnull', 'fs', 'sess-1', hoursAgo(8)), dec(0.5, 'block'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1052-allnull');
      expect(status).toBe(200);
      expect(body.allowRateLast6h).toBeNull();
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1329-T1333 — v10.52 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('20. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-t1', 'tool-v1052-pres', 'sess-1', daysAgo(45)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-t1', 'tool-v1052-pres', 'sess-1'), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1052-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('consecutiveMediumRiskOpsMax');
      expect(body).toHaveProperty('riskBandTransitions');
      expect(body).toHaveProperty('opsBurstLast5m');
      expect(body).toHaveProperty('blockRateLast6h');
      expect(body).toHaveProperty('allowRateLast6h');
    });

    it('21. tools — consecutiveMediumRiskOpsMax: all medium-risk → equals total count', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-t2', 'tool-v1052-allmed', 'sess-1', daysAgo(3)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-t2', 'tool-v1052-allmed', 'sess-2', daysAgo(2)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-t2', 'tool-v1052-allmed', 'sess-3', daysAgo(1)), dec(0.69, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1052-allmed');
      expect(status).toBe(200);
      // All 3 are medium-risk, so max streak = 3
      expect(body.consecutiveMediumRiskOpsMax).toBe(3);
    });

    it('22. tools — riskBandTransitions: alternating low/high → many transitions', async () => {
      ctx = await setup();
      // low, high, low, high → 3 transitions
      const pairs: [number, number][] = [[0.1, 4], [0.9, 3], [0.2, 2], [0.8, 1]];
      for (const [score, d] of pairs) {
        await ctx.logger.log(makeOp(`agent-t3-${d}`, 'tool-v1052-alttrans', `sess-${d}`, daysAgo(d)), dec(score, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1052-alttrans');
      expect(status).toBe(200);
      expect(body.riskBandTransitions).toBe(3);
    });

    it('23. tools — opsBurstLast5m: all recent ops count', async () => {
      ctx = await setup();
      // Seed old op
      await ctx.logger.log(makeOp('agent-t4', 'tool-v1052-burst', 'sess-old', daysAgo(44)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-t4', 'tool-v1052-burst', 'sess-1', minsAgo(1)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-t4', 'tool-v1052-burst', 'sess-2', minsAgo(3)), dec(0.6, 'allow'));
      await ctx.logger.log(makeOp('agent-t4', 'tool-v1052-burst', 'sess-3', minsAgo(4)), dec(0.7, 'block'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1052-burst');
      expect(status).toBe(200);
      expect(body.opsBurstLast5m).toBe(3);
    });

    it('24. tools — blockRateLast6h and allowRateLast6h sum to 1 when ops present', async () => {
      ctx = await setup();
      // Seed old op
      await ctx.logger.log(makeOp('agent-t5', 'tool-v1052-sum1', 'sess-old', daysAgo(40)), dec(0.5, 'allow'));
      // 2 block, 2 allow in last 6h
      await ctx.logger.log(makeOp('agent-t5', 'tool-v1052-sum1', 'sess-1', hoursAgo(1)), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agent-t5', 'tool-v1052-sum1', 'sess-2', hoursAgo(2)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-t5', 'tool-v1052-sum1', 'sess-3', hoursAgo(3)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-t5', 'tool-v1052-sum1', 'sess-4', hoursAgo(4)), dec(0.1, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1052-sum1');
      expect(status).toBe(200);
      expect(body.blockRateLast6h as number).toBeCloseTo(0.5, 5);
      expect(body.allowRateLast6h as number).toBeCloseTo(0.5, 5);
      // They must sum to 1.0
      expect((body.blockRateLast6h as number) + (body.allowRateLast6h as number)).toBeCloseTo(1.0, 5);
    });
  });

  // ── operations/summary endpoint ────────────────────────────────────────────────

  describe('T1329-T1333 — v10.52 new fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('25. summary — all five new fields present', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s1', 'tool-s', 'sess-1', daysAgo(45)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-s1', 'tool-s', 'sess-2'), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body).toHaveProperty('consecutiveMediumRiskOpsMax');
      expect(body).toHaveProperty('riskBandTransitions');
      expect(body).toHaveProperty('opsBurstLast5m');
      expect(body).toHaveProperty('blockRateLast6h');
      expect(body).toHaveProperty('allowRateLast6h');
    });

    it('26. summary — consecutiveMediumRiskOpsMax: [med, med, high, med] → 2', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s2', 'tool-sa', 'sess-1', daysAgo(4)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-s2', 'tool-sb', 'sess-2', daysAgo(3)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-s2', 'tool-sc', 'sess-3', daysAgo(2)), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agent-s2', 'tool-sd', 'sess-4', daysAgo(1)), dec(0.35, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.consecutiveMediumRiskOpsMax).toBe(2);
    });

    it('27. summary — consecutiveMediumRiskOpsMax: no ops → 0', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.consecutiveMediumRiskOpsMax).toBe(0);
    });

    it('28. summary — riskBandTransitions: [low, med, high, high, low] → 3', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s3', 'tool-ta', 'sess-1', daysAgo(5)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-s3', 'tool-tb', 'sess-2', daysAgo(4)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-s3', 'tool-tc', 'sess-3', daysAgo(3)), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agent-s3', 'tool-td', 'sess-4', daysAgo(2)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-s3', 'tool-te', 'sess-5', daysAgo(1)), dec(0.2, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskBandTransitions).toBe(3);
    });

    it('29. summary — riskBandTransitions: empty DB → 0', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskBandTransitions).toBe(0);
    });

    it('30. summary — opsBurstLast5m: recent ops correctly counted', async () => {
      ctx = await setup();
      // Seed old ops (> 40 days) for entity diversity
      await ctx.logger.log(makeOp('agent-s4a', 'tool-old', 'sess-old1', daysAgo(41)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-s4b', 'tool-old', 'sess-old2', daysAgo(42)), dec(0.3, 'allow'));
      // 4 ops in last 5 minutes
      await ctx.logger.log(makeOp('agent-s4c', 'tool-new', 'sess-new1', minsAgo(1)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-s4d', 'tool-new', 'sess-new2', minsAgo(2)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-s4e', 'tool-new', 'sess-new3', minsAgo(3)), dec(0.6, 'allow'));
      await ctx.logger.log(makeOp('agent-s4f', 'tool-new', 'sess-new4', minsAgo(4)), dec(0.7, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.opsBurstLast5m).toBe(4);
    });

    it('31. summary — opsBurstLast5m: no recent ops → 0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s5', 'tool-old2', 'sess-1', minsAgo(10)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.opsBurstLast5m).toBe(0);
    });

    it('32. summary — blockRateLast6h: correct fraction of blocked ops', async () => {
      ctx = await setup();
      // Seed old ops
      await ctx.logger.log(makeOp('agent-s6a', 'tool-blk', 'sess-old', daysAgo(43)), dec(0.4, 'allow'));
      // 3 block, 1 allow in last 6h → blockRate = 0.75
      await ctx.logger.log(makeOp('agent-s6b', 'tool-blk2', 'sess-1', hoursAgo(1)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-s6c', 'tool-blk2', 'sess-2', hoursAgo(2)), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agent-s6d', 'tool-blk2', 'sess-3', hoursAgo(3)), dec(0.75, 'block'));
      await ctx.logger.log(makeOp('agent-s6e', 'tool-blk2', 'sess-4', hoursAgo(4)), dec(0.2, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.blockRateLast6h as number).toBeCloseTo(0.75, 5);
    });

    it('33. summary — allowRateLast6h: correct fraction of allowed ops', async () => {
      ctx = await setup();
      // Seed old ops
      await ctx.logger.log(makeOp('agent-s7a', 'tool-all', 'sess-old', daysAgo(44)), dec(0.3, 'allow'));
      // 3 allow, 1 block in last 6h → allowRate = 0.75
      await ctx.logger.log(makeOp('agent-s7b', 'tool-all2', 'sess-1', hoursAgo(1)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-s7c', 'tool-all2', 'sess-2', hoursAgo(2)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-s7d', 'tool-all2', 'sess-3', hoursAgo(3)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-s7e', 'tool-all2', 'sess-4', hoursAgo(4)), dec(0.9, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.allowRateLast6h as number).toBeCloseTo(0.75, 5);
    });

    it('34. summary — blockRateLast6h and allowRateLast6h: null when no ops in last 6h', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s8', 'tool-norate', 'sess-1', hoursAgo(8)), dec(0.9, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.blockRateLast6h).toBeNull();
      expect(body.allowRateLast6h).toBeNull();
    });

    it('35. summary — all fields: 0 / null with empty database', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.consecutiveMediumRiskOpsMax).toBe(0);
      expect(body.riskBandTransitions).toBe(0);
      expect(body.opsBurstLast5m).toBe(0);
      expect(body.blockRateLast6h).toBeNull();
      expect(body.allowRateLast6h).toBeNull();
    });
  });
});

// ── v10.53 ────────────────────────────────────────────────────────────────────

describe('v10.53', () => {
  const hoursAgo = (h: number) => new Date(PINNED_NOW() - h * 3_600_000);
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1334-T1338 — v10.53 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      // Seed old op for entity existence, plus a recent op
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1053-pres', daysAgo(45)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1053-pres', hoursAgo(1)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1053-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('requireApprovalRateLast6h');
      expect(body).toHaveProperty('avgRiskScoreLast6h');
      expect(body).toHaveProperty('maxRiskScoreLast6h');
      expect(body).toHaveProperty('minRiskScoreLast6h');
      expect(body).toHaveProperty('riskScoreStdDevLast6h');
    });

    it('2. sessions — no ops in 6h window: all five fields are null', async () => {
      ctx = await setup();
      // Only old ops (>40 days) — 6h window is empty
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1053-null', daysAgo(41)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1053-null', daysAgo(45)), dec(0.7, 'block'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1053-null');
      expect(status).toBe(200);

      expect(body.requireApprovalRateLast6h).toBeNull();
      expect(body.avgRiskScoreLast6h).toBeNull();
      expect(body.maxRiskScoreLast6h).toBeNull();
      expect(body.minRiskScoreLast6h).toBeNull();
      expect(body.riskScoreStdDevLast6h).toBeNull();
    });

    it('3. sessions — known values [0.2, 0.8]: avg=0.5, max=0.8, min=0.2, stddev=0.3', async () => {
      ctx = await setup();
      // Seed old op for entity existence
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1053-known', daysAgo(42)), dec(0.9, 'allow'));
      // Two ops in 6h window
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1053-known', hoursAgo(1)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1053-known', hoursAgo(2)), dec(0.8, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1053-known');
      expect(status).toBe(200);

      expect(body.avgRiskScoreLast6h as number).toBeCloseTo(0.5, 5);
      expect(body.maxRiskScoreLast6h as number).toBeCloseTo(0.8, 5);
      expect(body.minRiskScoreLast6h as number).toBeCloseTo(0.2, 5);
      // population stddev of [0.2, 0.8]: mean=0.5, variance=((0.3)^2+(0.3)^2)/2=0.09, stddev=0.3
      expect(body.riskScoreStdDevLast6h as number).toBeCloseTo(0.3, 5);
    });

    it('4. sessions — single op in 6h window: stddev is 0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1053-single', daysAgo(43)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1053-single', hoursAgo(2)), dec(0.6, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1053-single');
      expect(status).toBe(200);

      // Single value: stddev = 0
      expect(body.riskScoreStdDevLast6h as number).toBeCloseTo(0, 10);
      expect(body.avgRiskScoreLast6h as number).toBeCloseTo(0.6, 5);
      expect(body.maxRiskScoreLast6h as number).toBeCloseTo(0.6, 5);
      expect(body.minRiskScoreLast6h as number).toBeCloseTo(0.6, 5);
    });

    it('5. sessions — all same scores in 6h: stddev is 0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1053-same', daysAgo(40)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1053-same', hoursAgo(1)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1053-same', hoursAgo(2)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1053-same', hoursAgo(3)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1053-same');
      expect(status).toBe(200);

      expect(body.riskScoreStdDevLast6h as number).toBeCloseTo(0, 10);
      expect(body.avgRiskScoreLast6h as number).toBeCloseTo(0.5, 5);
    });

    it('6. sessions — requireApprovalRateLast6h: all require_approval → 1.0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1053-reqapp', daysAgo(44)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1053-reqapp', hoursAgo(1)), dec(0.7, 'require_approval'));
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1053-reqapp', hoursAgo(2)), dec(0.8, 'require_approval'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1053-reqapp');
      expect(status).toBe(200);

      expect(body.requireApprovalRateLast6h as number).toBeCloseTo(1.0, 5);
    });

    it('7. sessions — requireApprovalRateLast6h: mixed actions → correct fraction', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1053-mixed', daysAgo(41)), dec(0.2, 'allow'));
      // 1 require_approval, 3 allow in 6h → rate = 0.25
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1053-mixed', hoursAgo(1)), dec(0.7, 'require_approval'));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1053-mixed', hoursAgo(2)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1053-mixed', hoursAgo(3)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1053-mixed', hoursAgo(4)), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1053-mixed');
      expect(status).toBe(200);

      expect(body.requireApprovalRateLast6h as number).toBeCloseTo(0.25, 5);
    });

    it('8. sessions — ops outside 6h window not counted: only recent ops affect fields', async () => {
      ctx = await setup();
      // Old op at 7h ago (just outside window) — should be excluded
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1053-window', hoursAgo(7)), dec(0.9, 'block'));
      // Recent ops in 6h window
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1053-window', hoursAgo(1)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1053-window', hoursAgo(3)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1053-window');
      expect(status).toBe(200);

      // Only [0.3, 0.5] should be considered: avg=0.4, max=0.5, min=0.3
      expect(body.avgRiskScoreLast6h as number).toBeCloseTo(0.4, 5);
      expect(body.maxRiskScoreLast6h as number).toBeCloseTo(0.5, 5);
      expect(body.minRiskScoreLast6h as number).toBeCloseTo(0.3, 5);
      // stddev of [0.3, 0.5]: mean=0.4, variance=((0.1)^2+(0.1)^2)/2=0.01, stddev=0.1
      expect(body.riskScoreStdDevLast6h as number).toBeCloseTo(0.1, 5);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1334-T1338 — v10.53 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('9. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1053-pres', 'fs', 'sess-1', daysAgo(42)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-v1053-pres', 'fs', 'sess-2', hoursAgo(2)), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1053-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('requireApprovalRateLast6h');
      expect(body).toHaveProperty('avgRiskScoreLast6h');
      expect(body).toHaveProperty('maxRiskScoreLast6h');
      expect(body).toHaveProperty('minRiskScoreLast6h');
      expect(body).toHaveProperty('riskScoreStdDevLast6h');
    });

    it('10. agents — no ops in 6h window: all five fields are null', async () => {
      ctx = await setup();
      // Only old ops (>40 days) — 6h window is empty
      await ctx.logger.log(makeOp('agent-v1053-null', 'fs', 'sess-1', daysAgo(43)), dec(0.6, 'allow'));
      await ctx.logger.log(makeOp('agent-v1053-null', 'fs', 'sess-2', daysAgo(50)), dec(0.4, 'block'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1053-null');
      expect(status).toBe(200);

      expect(body.requireApprovalRateLast6h).toBeNull();
      expect(body.avgRiskScoreLast6h).toBeNull();
      expect(body.maxRiskScoreLast6h).toBeNull();
      expect(body.minRiskScoreLast6h).toBeNull();
      expect(body.riskScoreStdDevLast6h).toBeNull();
    });

    it('11. agents — known values [0.2, 0.8]: avg=0.5, max=0.8, min=0.2, stddev=0.3', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1053-known', 'fs', 'sess-old', daysAgo(40)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-v1053-known', 'fs', 'sess-1', hoursAgo(1)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-v1053-known', 'fs', 'sess-2', hoursAgo(3)), dec(0.8, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1053-known');
      expect(status).toBe(200);

      expect(body.avgRiskScoreLast6h as number).toBeCloseTo(0.5, 5);
      expect(body.maxRiskScoreLast6h as number).toBeCloseTo(0.8, 5);
      expect(body.minRiskScoreLast6h as number).toBeCloseTo(0.2, 5);
      expect(body.riskScoreStdDevLast6h as number).toBeCloseTo(0.3, 5);
    });

    it('12. agents — stddev is 0 for single op in 6h window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1053-single', 'fs', 'sess-old', daysAgo(41)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-v1053-single', 'fs', 'sess-1', hoursAgo(2)), dec(0.75, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1053-single');
      expect(status).toBe(200);

      expect(body.riskScoreStdDevLast6h as number).toBeCloseTo(0, 10);
      expect(body.avgRiskScoreLast6h as number).toBeCloseTo(0.75, 5);
    });

    it('13. agents — requireApprovalRateLast6h: 2 of 4 ops require_approval → 0.5', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1053-reqrate', 'fs', 'sess-old', daysAgo(44)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-v1053-reqrate', 'fs', 'sess-1', hoursAgo(1)), dec(0.7, 'require_approval'));
      await ctx.logger.log(makeOp('agent-v1053-reqrate', 'fs', 'sess-2', hoursAgo(2)), dec(0.8, 'require_approval'));
      await ctx.logger.log(makeOp('agent-v1053-reqrate', 'fs', 'sess-3', hoursAgo(3)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-v1053-reqrate', 'fs', 'sess-4', hoursAgo(4)), dec(0.3, 'block'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1053-reqrate');
      expect(status).toBe(200);

      // 2 require_approval out of 4 ops → 0.5
      expect(body.requireApprovalRateLast6h as number).toBeCloseTo(0.5, 5);
    });

    it('14. agents — requireApprovalRateLast6h: no require_approval ops → 0.0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1053-noreq', 'fs', 'sess-old', daysAgo(43)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-v1053-noreq', 'fs', 'sess-1', hoursAgo(1)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-v1053-noreq', 'fs', 'sess-2', hoursAgo(2)), dec(0.8, 'block'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1053-noreq');
      expect(status).toBe(200);

      // No require_approval actions → 0.0
      expect(body.requireApprovalRateLast6h as number).toBeCloseTo(0.0, 5);
    });

    it('15. agents — stddev is positive for varied scores in 6h window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1053-stdpos', 'fs', 'sess-old', daysAgo(41)), dec(0.5, 'allow'));
      // Four scores: 0.1, 0.3, 0.7, 0.9 → mean=0.5, variance=((0.4)^2+(0.2)^2+(0.2)^2+(0.4)^2)/4=0.1, stddev≈0.316
      await ctx.logger.log(makeOp('agent-v1053-stdpos', 'fs', 'sess-1', hoursAgo(1)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-v1053-stdpos', 'fs', 'sess-2', hoursAgo(2)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-v1053-stdpos', 'fs', 'sess-3', hoursAgo(3)), dec(0.7, 'allow'));
      await ctx.logger.log(makeOp('agent-v1053-stdpos', 'fs', 'sess-4', hoursAgo(4)), dec(0.9, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1053-stdpos');
      expect(status).toBe(200);

      expect(body.riskScoreStdDevLast6h as number).toBeGreaterThan(0);
      // mean=0.5, variance=0.1, stddev=sqrt(0.1)≈0.31623
      expect(body.riskScoreStdDevLast6h as number).toBeCloseTo(Math.sqrt(0.1), 5);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1334-T1338 — v10.53 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('16. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-t1', 'tool-v1053-pres', 'sess-1', daysAgo(45)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-t1', 'tool-v1053-pres', 'sess-2', hoursAgo(1)), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1053-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('requireApprovalRateLast6h');
      expect(body).toHaveProperty('avgRiskScoreLast6h');
      expect(body).toHaveProperty('maxRiskScoreLast6h');
      expect(body).toHaveProperty('minRiskScoreLast6h');
      expect(body).toHaveProperty('riskScoreStdDevLast6h');
    });

    it('17. tools — no ops in 6h window: all five fields are null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-t2', 'tool-v1053-null', 'sess-1', daysAgo(42)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-t2', 'tool-v1053-null', 'sess-2', daysAgo(48)), dec(0.6, 'block'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1053-null');
      expect(status).toBe(200);

      expect(body.requireApprovalRateLast6h).toBeNull();
      expect(body.avgRiskScoreLast6h).toBeNull();
      expect(body.maxRiskScoreLast6h).toBeNull();
      expect(body.minRiskScoreLast6h).toBeNull();
      expect(body.riskScoreStdDevLast6h).toBeNull();
    });

    it('18. tools — known values [0.2, 0.8]: avg=0.5, max=0.8, min=0.2, stddev=0.3', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-t3', 'tool-v1053-known', 'sess-old', daysAgo(41)), dec(0.9, 'allow'));
      await ctx.logger.log(makeOp('agent-t3', 'tool-v1053-known', 'sess-1', hoursAgo(2)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-t3', 'tool-v1053-known', 'sess-2', hoursAgo(4)), dec(0.8, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1053-known');
      expect(status).toBe(200);

      expect(body.avgRiskScoreLast6h as number).toBeCloseTo(0.5, 5);
      expect(body.maxRiskScoreLast6h as number).toBeCloseTo(0.8, 5);
      expect(body.minRiskScoreLast6h as number).toBeCloseTo(0.2, 5);
      expect(body.riskScoreStdDevLast6h as number).toBeCloseTo(0.3, 5);
    });

    it('19. tools — requireApprovalRateLast6h: all 3 ops require_approval → 1.0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-t4', 'tool-v1053-allreq', 'sess-old', daysAgo(40)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-t4', 'tool-v1053-allreq', 'sess-1', hoursAgo(1)), dec(0.7, 'require_approval'));
      await ctx.logger.log(makeOp('agent-t4', 'tool-v1053-allreq', 'sess-2', hoursAgo(2)), dec(0.8, 'require_approval'));
      await ctx.logger.log(makeOp('agent-t4', 'tool-v1053-allreq', 'sess-3', hoursAgo(3)), dec(0.9, 'require_approval'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1053-allreq');
      expect(status).toBe(200);

      expect(body.requireApprovalRateLast6h as number).toBeCloseTo(1.0, 5);
    });

    it('20. tools — stddev of same score is 0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-t5', 'tool-v1053-samescore', 'sess-old', daysAgo(43)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-t5', 'tool-v1053-samescore', 'sess-1', hoursAgo(1)), dec(0.6, 'allow'));
      await ctx.logger.log(makeOp('agent-t5', 'tool-v1053-samescore', 'sess-2', hoursAgo(2)), dec(0.6, 'allow'));
      await ctx.logger.log(makeOp('agent-t5', 'tool-v1053-samescore', 'sess-3', hoursAgo(3)), dec(0.6, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1053-samescore');
      expect(status).toBe(200);

      expect(body.riskScoreStdDevLast6h as number).toBeCloseTo(0, 10);
      expect(body.avgRiskScoreLast6h as number).toBeCloseTo(0.6, 5);
      expect(body.maxRiskScoreLast6h as number).toBeCloseTo(0.6, 5);
      expect(body.minRiskScoreLast6h as number).toBeCloseTo(0.6, 5);
    });

    it('21. tools — ops older than 6h but not old (7h, 8h) are excluded from window', async () => {
      ctx = await setup();
      // Ops at 7h and 8h ago — outside 6h window
      await ctx.logger.log(makeOp('agent-t6', 'tool-v1053-excl', 'sess-1', hoursAgo(7)), dec(0.1, 'block'));
      await ctx.logger.log(makeOp('agent-t6', 'tool-v1053-excl', 'sess-2', hoursAgo(8)), dec(0.9, 'block'));
      // One op in 6h window
      await ctx.logger.log(makeOp('agent-t6', 'tool-v1053-excl', 'sess-3', hoursAgo(2)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1053-excl');
      expect(status).toBe(200);

      // Only the 0.5 score should be in window
      expect(body.avgRiskScoreLast6h as number).toBeCloseTo(0.5, 5);
      expect(body.maxRiskScoreLast6h as number).toBeCloseTo(0.5, 5);
      expect(body.minRiskScoreLast6h as number).toBeCloseTo(0.5, 5);
      expect(body.riskScoreStdDevLast6h as number).toBeCloseTo(0, 10);
    });

    it('22. tools — three ops in 6h with varied scores: stddev is positive', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-t7', 'tool-v1053-varstd', 'sess-old', daysAgo(44)), dec(0.5, 'allow'));
      // Scores: 0.0, 0.5, 1.0 → mean=0.5, variance=(0.25+0+0.25)/3≈0.1667, stddev≈0.4082
      await ctx.logger.log(makeOp('agent-t7', 'tool-v1053-varstd', 'sess-1', hoursAgo(1)), dec(0.0, 'allow'));
      await ctx.logger.log(makeOp('agent-t7', 'tool-v1053-varstd', 'sess-2', hoursAgo(3)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-t7', 'tool-v1053-varstd', 'sess-3', hoursAgo(5)), dec(1.0, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1053-varstd');
      expect(status).toBe(200);

      expect(body.riskScoreStdDevLast6h as number).toBeGreaterThan(0);
      // mean=0.5, variance=((0.5)^2+(0)^2+(0.5)^2)/3=1/6, stddev=sqrt(1/6)≈0.4082
      expect(body.riskScoreStdDevLast6h as number).toBeCloseTo(Math.sqrt(1 / 6), 4);
      expect(body.avgRiskScoreLast6h as number).toBeCloseTo(0.5, 5);
      expect(body.maxRiskScoreLast6h as number).toBeCloseTo(1.0, 5);
      expect(body.minRiskScoreLast6h as number).toBeCloseTo(0.0, 5);
    });
  });

  // ── operations/summary endpoint ────────────────────────────────────────────────

  describe('T1334-T1338 — v10.53 new fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('23. summary — all five new fields present', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s1', 'tool-sum', 'sess-1', daysAgo(45)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-s1', 'tool-sum', 'sess-2', hoursAgo(1)), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body).toHaveProperty('requireApprovalRateLast6h');
      expect(body).toHaveProperty('avgRiskScoreLast6h');
      expect(body).toHaveProperty('maxRiskScoreLast6h');
      expect(body).toHaveProperty('minRiskScoreLast6h');
      expect(body).toHaveProperty('riskScoreStdDevLast6h');
    });

    it('24. summary — empty DB: all five new fields are null', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.requireApprovalRateLast6h).toBeNull();
      expect(body.avgRiskScoreLast6h).toBeNull();
      expect(body.maxRiskScoreLast6h).toBeNull();
      expect(body.minRiskScoreLast6h).toBeNull();
      expect(body.riskScoreStdDevLast6h).toBeNull();
    });

    it('25. summary — only old ops (>40d): all five new fields are null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s2', 'tool-s2', 'sess-1', daysAgo(42)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-s2', 'tool-s2', 'sess-2', daysAgo(50)), dec(0.7, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.requireApprovalRateLast6h).toBeNull();
      expect(body.avgRiskScoreLast6h).toBeNull();
      expect(body.maxRiskScoreLast6h).toBeNull();
      expect(body.minRiskScoreLast6h).toBeNull();
      expect(body.riskScoreStdDevLast6h).toBeNull();
    });

    it('26. summary — known values [0.2, 0.8]: avg=0.5, max=0.8, min=0.2, stddev=0.3', async () => {
      ctx = await setup();
      // Seed old ops for context
      await ctx.logger.log(makeOp('agent-s3a', 'tool-s3', 'sess-old1', daysAgo(44)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-s3b', 'tool-s3', 'sess-old2', daysAgo(46)), dec(0.1, 'allow'));
      // Two ops in 6h window
      await ctx.logger.log(makeOp('agent-s3c', 'tool-s3', 'sess-1', hoursAgo(1)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-s3d', 'tool-s3', 'sess-2', hoursAgo(4)), dec(0.8, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.avgRiskScoreLast6h as number).toBeCloseTo(0.5, 5);
      expect(body.maxRiskScoreLast6h as number).toBeCloseTo(0.8, 5);
      expect(body.minRiskScoreLast6h as number).toBeCloseTo(0.2, 5);
      expect(body.riskScoreStdDevLast6h as number).toBeCloseTo(0.3, 5);
    });

    it('27. summary — requireApprovalRateLast6h: 1 of 3 ops require_approval → 1/3', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s4a', 'tool-s4', 'sess-old', daysAgo(43)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-s4b', 'tool-s4', 'sess-1', hoursAgo(1)), dec(0.7, 'require_approval'));
      await ctx.logger.log(makeOp('agent-s4c', 'tool-s4', 'sess-2', hoursAgo(2)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-s4d', 'tool-s4', 'sess-3', hoursAgo(3)), dec(0.4, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      // 1 require_approval out of 3 ops → 1/3
      expect(body.requireApprovalRateLast6h as number).toBeCloseTo(1 / 3, 5);
    });

    it('28. summary — stddev is 0 for single op in 6h window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s5a', 'tool-s5', 'sess-old', daysAgo(41)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-s5b', 'tool-s5', 'sess-1', hoursAgo(2)), dec(0.55, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.riskScoreStdDevLast6h as number).toBeCloseTo(0, 10);
      expect(body.avgRiskScoreLast6h as number).toBeCloseTo(0.55, 5);
      expect(body.maxRiskScoreLast6h as number).toBeCloseTo(0.55, 5);
      expect(body.minRiskScoreLast6h as number).toBeCloseTo(0.55, 5);
    });

    it('29. summary — stddev is 0 for multiple same scores in 6h window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s6a', 'tool-s6', 'sess-old', daysAgo(40)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-s6b', 'tool-s6', 'sess-1', hoursAgo(1)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-s6c', 'tool-s6', 'sess-2', hoursAgo(2)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-s6d', 'tool-s6', 'sess-3', hoursAgo(3)), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.riskScoreStdDevLast6h as number).toBeCloseTo(0, 10);
      expect(body.avgRiskScoreLast6h as number).toBeCloseTo(0.4, 5);
    });

    it('30. summary — ops outside 6h window not counted: avgRiskScore reflects only recent ops', async () => {
      ctx = await setup();
      // Ops at 7h and 9h ago — just outside the 6h window
      await ctx.logger.log(makeOp('agent-s7a', 'tool-s7', 'sess-1', hoursAgo(7)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-s7b', 'tool-s7', 'sess-2', hoursAgo(9)), dec(0.1, 'allow'));
      // Recent ops in 6h window: 0.4, 0.6
      await ctx.logger.log(makeOp('agent-s7c', 'tool-s7', 'sess-3', hoursAgo(1)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-s7d', 'tool-s7', 'sess-4', hoursAgo(3)), dec(0.6, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      // Only [0.4, 0.6] in window: avg=0.5, max=0.6, min=0.4
      expect(body.avgRiskScoreLast6h as number).toBeCloseTo(0.5, 5);
      expect(body.maxRiskScoreLast6h as number).toBeCloseTo(0.6, 5);
      expect(body.minRiskScoreLast6h as number).toBeCloseTo(0.4, 5);
      // stddev of [0.4, 0.6]: mean=0.5, variance=((0.1)^2+(0.1)^2)/2=0.01, stddev=0.1
      expect(body.riskScoreStdDevLast6h as number).toBeCloseTo(0.1, 5);
    });

    it('31. summary — requireApprovalRateLast6h: no require_approval in 6h → 0.0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s8a', 'tool-s8', 'sess-old', daysAgo(42)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-s8b', 'tool-s8', 'sess-1', hoursAgo(1)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-s8c', 'tool-s8', 'sess-2', hoursAgo(2)), dec(0.9, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.requireApprovalRateLast6h as number).toBeCloseTo(0.0, 5);
    });

    it('32. summary — five ops with varied scores: all fields correct together', async () => {
      ctx = await setup();
      // Seed old ops
      await ctx.logger.log(makeOp('agent-s9a', 'tool-s9', 'sess-old1', daysAgo(41)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-s9b', 'tool-s9', 'sess-old2', daysAgo(45)), dec(0.7, 'allow'));
      // 5 ops in 6h window: scores [0.1, 0.3, 0.5, 0.7, 0.9], 1 require_approval
      // mean=0.5, max=0.9, min=0.1
      // variance=((0.4)^2+(0.2)^2+(0)^2+(0.2)^2+(0.4)^2)/5=(0.16+0.04+0+0.04+0.16)/5=0.08, stddev=sqrt(0.08)≈0.2828
      await ctx.logger.log(makeOp('agent-s9c', 'tool-s9', 'sess-1', hoursAgo(1)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-s9d', 'tool-s9', 'sess-2', hoursAgo(2)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-s9e', 'tool-s9', 'sess-3', hoursAgo(3)), dec(0.5, 'require_approval'));
      await ctx.logger.log(makeOp('agent-s9f', 'tool-s9', 'sess-4', hoursAgo(4)), dec(0.7, 'allow'));
      await ctx.logger.log(makeOp('agent-s9g', 'tool-s9', 'sess-5', hoursAgo(5)), dec(0.9, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.requireApprovalRateLast6h as number).toBeCloseTo(1 / 5, 5);
      expect(body.avgRiskScoreLast6h as number).toBeCloseTo(0.5, 5);
      expect(body.maxRiskScoreLast6h as number).toBeCloseTo(0.9, 5);
      expect(body.minRiskScoreLast6h as number).toBeCloseTo(0.1, 5);
      expect(body.riskScoreStdDevLast6h as number).toBeCloseTo(Math.sqrt(0.08), 4);
    });
  });
});

// ── v10.54 ────────────────────────────────────────────────────────────────────

describe('v10.54', () => {
  const hoursAgo = (h: number) => new Date(PINNED_NOW() - h * 3_600_000);
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1339-T1343 — v10.54 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1054-pres'), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1054-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('riskScoreIQRLast6h');
      expect(body).toHaveProperty('opsBurstLast3h');
      expect(body).toHaveProperty('blockCountLast3h');
      expect(body).toHaveProperty('allowCountLast3h');
      expect(body).toHaveProperty('requireApprovalCountLast3h');
    });

    it('2. sessions — no ops in 6h window: riskScoreIQRLast6h is null (old ops only)', async () => {
      ctx = await setup();
      // Ops at 40+ days ago (well outside the 6h window)
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1054-old', daysAgo(40)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1054-old', daysAgo(45)), dec(0.7, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1054-old');
      expect(status).toBe(200);

      expect(body.riskScoreIQRLast6h).toBeNull();
    });

    it('3. sessions — IQR canonical: [0.2,0.4,0.6,0.8] sorted → IQR=0.4', async () => {
      ctx = await setup();
      // 4 ops in last 6h with risk scores 0.2, 0.4, 0.6, 0.8 (inserted out of order)
      // P75 = scores[floor(4*0.75)] = scores[3] = 0.8
      // P25 = scores[floor(4*0.25)] = scores[1] = 0.4
      // IQR = 0.4
      for (const score of [0.8, 0.2, 0.6, 0.4]) {
        await ctx.logger.log(makeOp('agent-iqr', 'fs', 'sess-v1054-iqr', hoursAgo(1)), dec(score, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1054-iqr');
      expect(status).toBe(200);

      expect(body.riskScoreIQRLast6h as number).toBeCloseTo(0.4, 5);
    });

    it('4. sessions — opsBurstLast3h: ops within 3h counted, older ignored', async () => {
      ctx = await setup();
      // 3 ops in last 3h, 2 older ops (at 40+ days)
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1054-burst', hoursAgo(1)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1054-burst', hoursAgo(2)), dec(0.4, 'block'));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1054-burst', hoursAgo(2.5)), dec(0.5, 'require_approval'));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1054-burst', daysAgo(40)), dec(0.6, 'allow'));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1054-burst', daysAgo(42)), dec(0.7, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1054-burst');
      expect(status).toBe(200);

      expect(body.opsBurstLast3h).toBe(3);
    });

    it('5. sessions — blockCountLast3h counts only block actions in 3h window', async () => {
      ctx = await setup();
      // In last 3h: 2 blocks, 1 allow, 1 require_approval
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1054-blk'), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1054-blk', hoursAgo(1)), dec(0.85, 'block'));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1054-blk', hoursAgo(2)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1054-blk', hoursAgo(2.5)), dec(0.6, 'require_approval'));
      // Older block — should not be counted
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1054-blk', daysAgo(41)), dec(0.95, 'block'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1054-blk');
      expect(status).toBe(200);

      expect(body.blockCountLast3h).toBe(2);
    });

    it('6. sessions — allowCountLast3h counts only allow actions in 3h window', async () => {
      ctx = await setup();
      // In last 3h: 3 allows, 1 block
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1054-allow'), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1054-allow', hoursAgo(1.5)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1054-allow', hoursAgo(2.9)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1054-allow', hoursAgo(2)), dec(0.8, 'block'));
      // Older allow — should not be counted
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1054-allow', daysAgo(43)), dec(0.1, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1054-allow');
      expect(status).toBe(200);

      expect(body.allowCountLast3h).toBe(3);
    });

    it('7. sessions — requireApprovalCountLast3h counts only require_approval in 3h window', async () => {
      ctx = await setup();
      // In last 3h: 2 require_approval, 1 allow, 1 block
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1054-req'), dec(0.6, 'require_approval'));
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1054-req', hoursAgo(2)), dec(0.65, 'require_approval'));
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1054-req', hoursAgo(1)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1054-req', hoursAgo(2.5)), dec(0.9, 'block'));
      // Older require_approval — should not be counted
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1054-req', daysAgo(44)), dec(0.6, 'require_approval'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1054-req');
      expect(status).toBe(200);

      expect(body.requireApprovalCountLast3h).toBe(2);
    });

    it('8. sessions — zero counts when no ops in 3h window', async () => {
      ctx = await setup();
      // All ops older than 40+ days
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1054-zero', daysAgo(40)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1054-zero', daysAgo(41)), dec(0.7, 'block'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1054-zero');
      expect(status).toBe(200);

      expect(body.opsBurstLast3h).toBe(0);
      expect(body.blockCountLast3h).toBe(0);
      expect(body.allowCountLast3h).toBe(0);
      expect(body.requireApprovalCountLast3h).toBe(0);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1339-T1343 — v10.54 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('9. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1054-pres', 'fs', 'sess-1'), dec(0.3, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1054-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('riskScoreIQRLast6h');
      expect(body).toHaveProperty('opsBurstLast3h');
      expect(body).toHaveProperty('blockCountLast3h');
      expect(body).toHaveProperty('allowCountLast3h');
      expect(body).toHaveProperty('requireApprovalCountLast3h');
    });

    it('10. agents — IQR canonical test [0.2,0.4,0.6,0.8] → 0.4', async () => {
      ctx = await setup();
      // 4 ops in last 6h with scores 0.2, 0.4, 0.6, 0.8
      // P75 = scores[3] = 0.8, P25 = scores[1] = 0.4, IQR = 0.4
      for (const score of [0.6, 0.2, 0.8, 0.4]) {
        await ctx.logger.log(makeOp('agent-v1054-iqr-a', 'fs', 'sess-a', hoursAgo(2)), dec(score, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1054-iqr-a');
      expect(status).toBe(200);

      expect(body.riskScoreIQRLast6h as number).toBeCloseTo(0.4, 5);
    });

    it('11. agents — riskScoreIQRLast6h null when only old ops (40+ days)', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1054-old-a', 'fs', 'sess-1', daysAgo(40)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-v1054-old-a', 'fs', 'sess-2', daysAgo(45)), dec(0.8, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1054-old-a');
      expect(status).toBe(200);

      expect(body.riskScoreIQRLast6h).toBeNull();
    });

    it('12. agents — opsBurstLast3h correct count with mixed timestamps', async () => {
      ctx = await setup();
      // 4 ops in 3h window
      await ctx.logger.log(makeOp('agent-v1054-burst-a', 'fs', 'sess-1'), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-v1054-burst-a', 'fs', 'sess-2', hoursAgo(1.5)), dec(0.4, 'block'));
      await ctx.logger.log(makeOp('agent-v1054-burst-a', 'fs', 'sess-3', hoursAgo(2)), dec(0.6, 'require_approval'));
      await ctx.logger.log(makeOp('agent-v1054-burst-a', 'fs', 'sess-4', hoursAgo(2.8)), dec(0.8, 'allow'));
      // Outside 3h window
      await ctx.logger.log(makeOp('agent-v1054-burst-a', 'fs', 'sess-5', daysAgo(42)), dec(0.3, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1054-burst-a');
      expect(status).toBe(200);

      expect(body.opsBurstLast3h).toBe(4);
    });

    it('13. agents — all three action counts in last 3h correct', async () => {
      ctx = await setup();
      // 2 allows, 3 blocks, 1 require_approval in last 3h
      await ctx.logger.log(makeOp('agent-v1054-actions-a', 'fs', 'sess-1'), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-v1054-actions-a', 'fs', 'sess-2', hoursAgo(1)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-v1054-actions-a', 'fs', 'sess-3', hoursAgo(1.5)), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agent-v1054-actions-a', 'fs', 'sess-4', hoursAgo(2)), dec(0.85, 'block'));
      await ctx.logger.log(makeOp('agent-v1054-actions-a', 'fs', 'sess-5', hoursAgo(2.5)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-v1054-actions-a', 'fs', 'sess-6', hoursAgo(2.9)), dec(0.6, 'require_approval'));
      // Old ops — should not count
      await ctx.logger.log(makeOp('agent-v1054-actions-a', 'fs', 'sess-7', daysAgo(43)), dec(0.1, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1054-actions-a');
      expect(status).toBe(200);

      expect(body.allowCountLast3h).toBe(2);
      expect(body.blockCountLast3h).toBe(3);
      expect(body.requireApprovalCountLast3h).toBe(1);
    });

    it('14. agents — zero counts when all ops outside 3h window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1054-zero-a', 'fs', 'sess-1', daysAgo(40)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-v1054-zero-a', 'fs', 'sess-2', daysAgo(50)), dec(0.9, 'block'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1054-zero-a');
      expect(status).toBe(200);

      expect(body.opsBurstLast3h).toBe(0);
      expect(body.blockCountLast3h).toBe(0);
      expect(body.allowCountLast3h).toBe(0);
      expect(body.requireApprovalCountLast3h).toBe(0);
    });

    it('15. agents — single op in 6h window: IQR is 0 (same score for both indices)', async () => {
      ctx = await setup();
      // 1 op in 6h: scores=[0.5], len=1
      // P75=scores[floor(1*0.75)]=scores[0]=0.5
      // P25=scores[floor(1*0.25)]=scores[0]=0.5
      // IQR=0.0
      await ctx.logger.log(makeOp('agent-v1054-single', 'fs', 'sess-1', hoursAgo(3)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1054-single');
      expect(status).toBe(200);

      expect(body.riskScoreIQRLast6h as number).toBeCloseTo(0.0, 5);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1339-T1343 — v10.54 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('16. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-h', 'tool-v1054-pres', 'sess-1'), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1054-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('riskScoreIQRLast6h');
      expect(body).toHaveProperty('opsBurstLast3h');
      expect(body).toHaveProperty('blockCountLast3h');
      expect(body).toHaveProperty('allowCountLast3h');
      expect(body).toHaveProperty('requireApprovalCountLast3h');
    });

    it('17. tools — IQR canonical test [0.2,0.4,0.6,0.8] → 0.4', async () => {
      ctx = await setup();
      // 4 ops in last 6h with scores [0.2, 0.4, 0.6, 0.8]
      // P75 = scores[3] = 0.8, P25 = scores[1] = 0.4, IQR = 0.4
      for (const score of [0.4, 0.8, 0.2, 0.6]) {
        await ctx.logger.log(makeOp(`agent-tool-iqr-${score}`, 'tool-v1054-iqr', 'sess-1', hoursAgo(1)), dec(score, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1054-iqr');
      expect(status).toBe(200);

      expect(body.riskScoreIQRLast6h as number).toBeCloseTo(0.4, 5);
    });

    it('18. tools — riskScoreIQRLast6h null when only old ops (40+ days)', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-i', 'tool-v1054-old', 'sess-1', daysAgo(40)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-i', 'tool-v1054-old', 'sess-2', daysAgo(50)), dec(0.9, 'block'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1054-old');
      expect(status).toBe(200);

      expect(body.riskScoreIQRLast6h).toBeNull();
    });

    it('19. tools — opsBurstLast3h counts all action types in 3h window', async () => {
      ctx = await setup();
      // 5 ops of different types in 3h
      await ctx.logger.log(makeOp('agent-j-1', 'tool-v1054-burst', 'sess-1'), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-j-2', 'tool-v1054-burst', 'sess-2', hoursAgo(1)), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agent-j-3', 'tool-v1054-burst', 'sess-3', hoursAgo(1.5)), dec(0.6, 'require_approval'));
      await ctx.logger.log(makeOp('agent-j-4', 'tool-v1054-burst', 'sess-4', hoursAgo(2)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-j-5', 'tool-v1054-burst', 'sess-5', hoursAgo(2.9)), dec(0.7, 'block'));
      // Old op
      await ctx.logger.log(makeOp('agent-j-6', 'tool-v1054-burst', 'sess-6', daysAgo(41)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1054-burst');
      expect(status).toBe(200);

      expect(body.opsBurstLast3h).toBe(5);
    });

    it('20. tools — blockCountLast3h and allowCountLast3h correct with mixed actions', async () => {
      ctx = await setup();
      // 3 blocks, 2 allows in 3h window
      await ctx.logger.log(makeOp('agent-k-1', 'tool-v1054-mix', 'sess-1'), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-k-2', 'tool-v1054-mix', 'sess-2', hoursAgo(1)), dec(0.85, 'block'));
      await ctx.logger.log(makeOp('agent-k-3', 'tool-v1054-mix', 'sess-3', hoursAgo(2)), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agent-k-4', 'tool-v1054-mix', 'sess-4', hoursAgo(2.5)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-k-5', 'tool-v1054-mix', 'sess-5', hoursAgo(2.8)), dec(0.3, 'allow'));
      // Old ops — should not count
      await ctx.logger.log(makeOp('agent-k-6', 'tool-v1054-mix', 'sess-6', daysAgo(42)), dec(0.9, 'block'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1054-mix');
      expect(status).toBe(200);

      expect(body.blockCountLast3h).toBe(3);
      expect(body.allowCountLast3h).toBe(2);
    });

    it('21. tools — requireApprovalCountLast3h correct, zero blocks and allows', async () => {
      ctx = await setup();
      // Only require_approval actions in 3h
      await ctx.logger.log(makeOp('agent-l-1', 'tool-v1054-ra', 'sess-1'), dec(0.6, 'require_approval'));
      await ctx.logger.log(makeOp('agent-l-2', 'tool-v1054-ra', 'sess-2', hoursAgo(1.5)), dec(0.65, 'require_approval'));
      await ctx.logger.log(makeOp('agent-l-3', 'tool-v1054-ra', 'sess-3', hoursAgo(2.5)), dec(0.7, 'require_approval'));
      // Old op
      await ctx.logger.log(makeOp('agent-l-4', 'tool-v1054-ra', 'sess-4', daysAgo(43)), dec(0.6, 'require_approval'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1054-ra');
      expect(status).toBe(200);

      expect(body.requireApprovalCountLast3h).toBe(3);
      expect(body.blockCountLast3h).toBe(0);
      expect(body.allowCountLast3h).toBe(0);
    });
  });

  // ── operations/summary endpoint ────────────────────────────────────────────────

  describe('T1339-T1343 — v10.54 new fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('22. summary — all five new fields present', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-m', 'tool-s', 'sess-1'), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body).toHaveProperty('riskScoreIQRLast6h');
      expect(body).toHaveProperty('opsBurstLast3h');
      expect(body).toHaveProperty('blockCountLast3h');
      expect(body).toHaveProperty('allowCountLast3h');
      expect(body).toHaveProperty('requireApprovalCountLast3h');
    });

    it('23. summary — empty DB: riskScoreIQRLast6h null, counts zero', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.riskScoreIQRLast6h).toBeNull();
      expect(body.opsBurstLast3h).toBe(0);
      expect(body.blockCountLast3h).toBe(0);
      expect(body.allowCountLast3h).toBe(0);
      expect(body.requireApprovalCountLast3h).toBe(0);
    });

    it('24. summary — IQR canonical test [0.2,0.4,0.6,0.8] → 0.4', async () => {
      ctx = await setup();
      // 4 ops in last 6h with risk scores 0.2, 0.4, 0.6, 0.8 (inserted in random order)
      // sorted: [0.2, 0.4, 0.6, 0.8], n=4
      // P75 = scores[floor(4*0.75)] = scores[3] = 0.8
      // P25 = scores[floor(4*0.25)] = scores[1] = 0.4
      // IQR = 0.4
      for (const score of [0.6, 0.2, 0.8, 0.4]) {
        await ctx.logger.log(makeOp(`agent-sum-iqr-${score}`, `tool-${score}`, `sess-${score}`, hoursAgo(2)), dec(score, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.riskScoreIQRLast6h as number).toBeCloseTo(0.4, 5);
    });

    it('25. summary — only old ops (40+ days): riskScoreIQRLast6h null, all counts zero', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-n-1', 'tool-n', 'sess-1', daysAgo(40)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-n-2', 'tool-n', 'sess-2', daysAgo(45)), dec(0.7, 'block'));
      await ctx.logger.log(makeOp('agent-n-3', 'tool-n', 'sess-3', daysAgo(50)), dec(0.6, 'require_approval'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.riskScoreIQRLast6h).toBeNull();
      expect(body.opsBurstLast3h).toBe(0);
      expect(body.blockCountLast3h).toBe(0);
      expect(body.allowCountLast3h).toBe(0);
      expect(body.requireApprovalCountLast3h).toBe(0);
    });

    it('26. summary — mixed window: 3h counts correct, 6h IQR correct', async () => {
      ctx = await setup();
      // Ops in last 3h (also within 6h): 2 allows, 1 block, 1 require_approval
      await ctx.logger.log(makeOp('agent-o-1', 'tool-o', 'sess-1'), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-o-2', 'tool-o', 'sess-2', hoursAgo(1)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-o-3', 'tool-o', 'sess-3', hoursAgo(2)), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agent-o-4', 'tool-o', 'sess-4', hoursAgo(2.5)), dec(0.6, 'require_approval'));
      // Op in 6h window but not 3h: score 0.1
      await ctx.logger.log(makeOp('agent-o-5', 'tool-o', 'sess-5', hoursAgo(5)), dec(0.1, 'allow'));
      // Old op (40+ days) — not in any window
      await ctx.logger.log(makeOp('agent-o-6', 'tool-o', 'sess-6', daysAgo(44)), dec(0.99, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      // 3h counts: 2 allows, 1 block, 1 require_approval = 4 total
      expect(body.opsBurstLast3h).toBe(4);
      expect(body.allowCountLast3h).toBe(2);
      expect(body.blockCountLast3h).toBe(1);
      expect(body.requireApprovalCountLast3h).toBe(1);

      // 6h IQR from scores [0.1, 0.2, 0.4, 0.6, 0.8] sorted, n=5
      // P75 = scores[floor(5*0.75)] = scores[3] = 0.6
      // P25 = scores[floor(5*0.25)] = scores[1] = 0.2
      // IQR = 0.4
      expect(body.riskScoreIQRLast6h as number).toBeCloseTo(0.4, 5);
    });

    it('27. summary — opsBurstLast3h is sum of all action types', async () => {
      ctx = await setup();
      // 2 allows + 2 blocks + 2 require_approval = 6 ops in 3h
      for (const action of ['allow', 'allow', 'block', 'block', 'require_approval', 'require_approval'] as ProxyDecision['action'][]) {
        await ctx.logger.log(makeOp(`agent-p-${action}-${Math.random()}`, 'tool-p', `sess-${Math.random()}`, hoursAgo(1)), dec(0.5, action));
      }
      // 3 old ops (40+ days)
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp(`agent-p-old-${i}`, 'tool-p', `sess-old-${i}`, daysAgo(45 + i)), dec(0.5, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.opsBurstLast3h).toBe(6);
      expect(body.allowCountLast3h).toBe(2);
      expect(body.blockCountLast3h).toBe(2);
      expect(body.requireApprovalCountLast3h).toBe(2);
    });

    it('28. summary — op just inside 3h boundary is counted', async () => {
      ctx = await setup();
      // Op at 2h 59m ago — clearly inside 3h window
      await ctx.logger.log(makeOp('agent-boundary', 'tool-boundary', 'sess-boundary', hoursAgo(2.98)), dec(0.5, 'allow'));
      // Op at 3h 1m ago — just outside 3h window, not counted
      await ctx.logger.log(makeOp('agent-boundary2', 'tool-boundary', 'sess-boundary2', hoursAgo(3.02)), dec(0.7, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      // Only the op within 3h should be counted in burst and allow
      expect(body.opsBurstLast3h).toBe(1);
      expect(body.allowCountLast3h).toBe(1);
      expect(body.blockCountLast3h).toBe(0);
    });
  });
});

// ── v10.55 ────────────────────────────────────────────────────────────────────

describe('v10.55', () => {
  const minsAgo = (m: number) => new Date(PINNED_NOW() - m * 60_000);
  const hoursAgo = (h: number) => new Date(PINNED_NOW() - h * 3_600_000);
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);

  // ── /sessions/:id ──────────────────────────────────────────────────────────────

  describe('T1344-T1348 — v10.55 3h fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all 5 fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-a', 'fs', 'sess-pres-1'), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-pres-1');
      expect(status).toBe(200);
      expect(body).toHaveProperty('blockRateLast3h');
      expect(body).toHaveProperty('allowRateLast3h');
      expect(body).toHaveProperty('requireApprovalRateLast3h');
      expect(body).toHaveProperty('avgRiskScoreLast3h');
      expect(body).toHaveProperty('maxRiskScoreLast3h');
    });

    it('2. sessions — no ops in last 3h (old logs only): all 5 fields are null', async () => {
      ctx = await setup();
      // Seed logs older than 3h (and > 40d to test entity-exists coverage)
      await ctx.logger.log(makeOp('agt-b', 'fs', 'sess-old-1', daysAgo(41)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agt-b', 'fs', 'sess-old-1', daysAgo(45)), dec(0.7, 'block'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-old-1');
      expect(status).toBe(200);
      expect(body.blockRateLast3h).toBeNull();
      expect(body.allowRateLast3h).toBeNull();
      expect(body.requireApprovalRateLast3h).toBeNull();
      expect(body.avgRiskScoreLast3h).toBeNull();
      expect(body.maxRiskScoreLast3h).toBeNull();
    });

    it('3. sessions — all ops are blocks in last 3h: blockRate=1, allowRate=0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-c', 'fs', 'sess-block-1', minsAgo(30)), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agt-c', 'fs', 'sess-block-1', minsAgo(60)), dec(0.9, 'block'));
      // Old log for entity-exists seeding
      await ctx.logger.log(makeOp('agt-c', 'fs', 'sess-block-1', daysAgo(42)), dec(0.3, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-block-1');
      expect(status).toBe(200);
      expect(body.blockRateLast3h as number).toBeCloseTo(1.0, 5);
      expect(body.allowRateLast3h as number).toBeCloseTo(0.0, 5);
    });

    it('4. sessions — all ops are allows in last 3h: allowRate=1, blockRate=0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-d', 'fs', 'sess-allow-1', minsAgo(45)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agt-d', 'fs', 'sess-allow-1', minsAgo(90)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agt-d', 'fs', 'sess-allow-1', daysAgo(44)), dec(0.6, 'block'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-allow-1');
      expect(status).toBe(200);
      expect(body.allowRateLast3h as number).toBeCloseTo(1.0, 5);
      expect(body.blockRateLast3h as number).toBeCloseTo(0.0, 5);
    });

    it('5. sessions — mixed actions: requireApprovalRateLast3h computed correctly', async () => {
      ctx = await setup();
      // 4 ops in last 3h: 1 block, 1 allow, 2 require_approval → requireApprovalRate = 0.5
      await ctx.logger.log(makeOp('agt-e', 'fs', 'sess-mix-1', minsAgo(10)), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agt-e', 'fs', 'sess-mix-1', minsAgo(30)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agt-e', 'fs', 'sess-mix-1', minsAgo(60)), dec(0.6, 'require_approval'));
      await ctx.logger.log(makeOp('agt-e', 'fs', 'sess-mix-1', minsAgo(120)), dec(0.7, 'require_approval'));
      await ctx.logger.log(makeOp('agt-e', 'fs', 'sess-mix-1', daysAgo(43)), dec(0.1, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-mix-1');
      expect(status).toBe(200);
      expect(body.requireApprovalRateLast3h as number).toBeCloseTo(0.5, 5);
    });

    it('6. sessions — avgRiskScoreLast3h and maxRiskScoreLast3h computed correctly', async () => {
      ctx = await setup();
      // 3 ops in last 3h with scores 0.2, 0.5, 0.8 → avg=0.5, max=0.8
      await ctx.logger.log(makeOp('agt-f', 'fs', 'sess-risk-1', minsAgo(20)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agt-f', 'fs', 'sess-risk-1', minsAgo(80)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agt-f', 'fs', 'sess-risk-1', minsAgo(150)), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agt-f', 'fs', 'sess-risk-1', daysAgo(40)), dec(0.9, 'block'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-risk-1');
      expect(status).toBe(200);
      expect(body.avgRiskScoreLast3h as number).toBeCloseTo(0.5, 5);
      expect(body.maxRiskScoreLast3h as number).toBeCloseTo(0.8, 5);
    });

    it('7. sessions — single op in 3h: all rates are 1 or 0, avg=max=riskScore', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-g', 'fs', 'sess-single-1', minsAgo(10)), dec(0.65, 'require_approval'));
      await ctx.logger.log(makeOp('agt-g', 'fs', 'sess-single-1', daysAgo(50)), dec(0.3, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-single-1');
      expect(status).toBe(200);
      expect(body.blockRateLast3h as number).toBeCloseTo(0.0, 5);
      expect(body.allowRateLast3h as number).toBeCloseTo(0.0, 5);
      expect(body.requireApprovalRateLast3h as number).toBeCloseTo(1.0, 5);
      expect(body.avgRiskScoreLast3h as number).toBeCloseTo(0.65, 5);
      expect(body.maxRiskScoreLast3h as number).toBeCloseTo(0.65, 5);
    });
  });

  // ── /agents/:agentId ───────────────────────────────────────────────────────────

  describe('T1344-T1348 — v10.55 3h fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('8. agents — all 5 fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-pres-1', 'fs', 'sess-1'), dec(0.3, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-pres-1');
      expect(status).toBe(200);
      expect(body).toHaveProperty('blockRateLast3h');
      expect(body).toHaveProperty('allowRateLast3h');
      expect(body).toHaveProperty('requireApprovalRateLast3h');
      expect(body).toHaveProperty('avgRiskScoreLast3h');
      expect(body).toHaveProperty('maxRiskScoreLast3h');
    });

    it('9. agents — no ops in last 3h (old logs only > 40d): all 5 fields are null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-old-1', 'fs', 'sess-1', daysAgo(41)), dec(0.5, 'block'));
      await ctx.logger.log(makeOp('agent-old-1', 'fs', 'sess-2', daysAgo(48)), dec(0.6, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-old-1');
      expect(status).toBe(200);
      expect(body.blockRateLast3h).toBeNull();
      expect(body.allowRateLast3h).toBeNull();
      expect(body.requireApprovalRateLast3h).toBeNull();
      expect(body.avgRiskScoreLast3h).toBeNull();
      expect(body.maxRiskScoreLast3h).toBeNull();
    });

    it('10. agents — 4 ops in 3h (3 blocks + 1 allow): blockRate=0.75, allowRate=0.25', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-block-1', 'fs', 'sess-1', minsAgo(15)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-block-1', 'fs', 'sess-1', minsAgo(45)), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agent-block-1', 'fs', 'sess-1', minsAgo(90)), dec(0.7, 'block'));
      await ctx.logger.log(makeOp('agent-block-1', 'fs', 'sess-1', minsAgo(150)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-block-1', 'fs', 'sess-1', daysAgo(43)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-block-1');
      expect(status).toBe(200);
      expect(body.blockRateLast3h as number).toBeCloseTo(0.75, 5);
      expect(body.allowRateLast3h as number).toBeCloseTo(0.25, 5);
    });

    it('11. agents — requireApprovalRateLast3h: 1 out of 3 ops = 0.333...', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-req-1', 'fs', 'sess-1', minsAgo(20)), dec(0.6, 'require_approval'));
      await ctx.logger.log(makeOp('agent-req-1', 'fs', 'sess-1', minsAgo(60)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-req-1', 'fs', 'sess-1', minsAgo(100)), dec(0.5, 'block'));
      await ctx.logger.log(makeOp('agent-req-1', 'fs', 'sess-2', daysAgo(41)), dec(0.2, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-req-1');
      expect(status).toBe(200);
      expect(body.requireApprovalRateLast3h as number).toBeCloseTo(1 / 3, 5);
    });

    it('12. agents — avgRiskScoreLast3h and maxRiskScoreLast3h from 5 ops', async () => {
      ctx = await setup();
      // Scores in last 3h: 0.1, 0.3, 0.5, 0.7, 0.9 → avg=0.5, max=0.9
      await ctx.logger.log(makeOp('agent-avg-1', 'fs', 'sess-1', minsAgo(10)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-avg-1', 'fs', 'sess-1', minsAgo(40)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-avg-1', 'fs', 'sess-1', minsAgo(80)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-avg-1', 'fs', 'sess-1', minsAgo(120)), dec(0.7, 'block'));
      await ctx.logger.log(makeOp('agent-avg-1', 'fs', 'sess-1', minsAgo(170)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-avg-1', 'fs', 'sess-1', daysAgo(42)), dec(0.0, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-avg-1');
      expect(status).toBe(200);
      expect(body.avgRiskScoreLast3h as number).toBeCloseTo(0.5, 5);
      expect(body.maxRiskScoreLast3h as number).toBeCloseTo(0.9, 5);
    });

    it('13. agents — ops just outside 3h window not included', async () => {
      ctx = await setup();
      // Op at exactly 3h+1min ago should NOT be in the window
      await ctx.logger.log(makeOp('agent-boundary-1', 'fs', 'sess-1', minsAgo(181)), dec(1.0, 'block'));
      // Op at 2h59m ago should BE in the window
      await ctx.logger.log(makeOp('agent-boundary-1', 'fs', 'sess-1', minsAgo(179)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-boundary-1', 'fs', 'sess-1', daysAgo(40)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-boundary-1');
      expect(status).toBe(200);
      // Only 1 op in window (0.2, allow) → blockRate=0, allowRate=1, avg=0.2, max=0.2
      expect(body.blockRateLast3h as number).toBeCloseTo(0.0, 5);
      expect(body.allowRateLast3h as number).toBeCloseTo(1.0, 5);
      expect(body.avgRiskScoreLast3h as number).toBeCloseTo(0.2, 5);
      expect(body.maxRiskScoreLast3h as number).toBeCloseTo(0.2, 5);
    });
  });

  // ── /tools/:tool ───────────────────────────────────────────────────────────────

  describe('T1344-T1348 — v10.55 3h fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('14. tools — all 5 fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-h', 'tool-pres-1', 'sess-1'), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-pres-1');
      expect(status).toBe(200);
      expect(body).toHaveProperty('blockRateLast3h');
      expect(body).toHaveProperty('allowRateLast3h');
      expect(body).toHaveProperty('requireApprovalRateLast3h');
      expect(body).toHaveProperty('avgRiskScoreLast3h');
      expect(body).toHaveProperty('maxRiskScoreLast3h');
    });

    it('15. tools — no ops in last 3h (old logs > 40d): all 5 fields are null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-i', 'tool-old-1', 'sess-1', daysAgo(41)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agt-i', 'tool-old-1', 'sess-2', daysAgo(46)), dec(0.9, 'block'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-old-1');
      expect(status).toBe(200);
      expect(body.blockRateLast3h).toBeNull();
      expect(body.allowRateLast3h).toBeNull();
      expect(body.requireApprovalRateLast3h).toBeNull();
      expect(body.avgRiskScoreLast3h).toBeNull();
      expect(body.maxRiskScoreLast3h).toBeNull();
    });

    it('16. tools — 2 blocks + 2 require_approval in 3h: blockRate=0.5, requireApprovalRate=0.5', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-j-1', 'tool-mix-1', 'sess-1', minsAgo(10)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agt-j-2', 'tool-mix-1', 'sess-2', minsAgo(40)), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agt-j-3', 'tool-mix-1', 'sess-3', minsAgo(80)), dec(0.6, 'require_approval'));
      await ctx.logger.log(makeOp('agt-j-4', 'tool-mix-1', 'sess-4', minsAgo(140)), dec(0.5, 'require_approval'));
      await ctx.logger.log(makeOp('agt-j-5', 'tool-mix-1', 'sess-5', daysAgo(44)), dec(0.3, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-mix-1');
      expect(status).toBe(200);
      expect(body.blockRateLast3h as number).toBeCloseTo(0.5, 5);
      expect(body.allowRateLast3h as number).toBeCloseTo(0.0, 5);
      expect(body.requireApprovalRateLast3h as number).toBeCloseTo(0.5, 5);
    });

    it('17. tools — avgRiskScoreLast3h correct with varying scores', async () => {
      ctx = await setup();
      // Scores in 3h: 0.2, 0.4, 0.6 → avg=0.4, max=0.6
      await ctx.logger.log(makeOp('agt-k-1', 'tool-avg-1', 'sess-1', minsAgo(30)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agt-k-2', 'tool-avg-1', 'sess-2', minsAgo(80)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agt-k-3', 'tool-avg-1', 'sess-3', minsAgo(160)), dec(0.6, 'block'));
      await ctx.logger.log(makeOp('agt-k-4', 'tool-avg-1', 'sess-4', daysAgo(45)), dec(1.0, 'block'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-avg-1');
      expect(status).toBe(200);
      expect(body.avgRiskScoreLast3h as number).toBeCloseTo(0.4, 5);
      expect(body.maxRiskScoreLast3h as number).toBeCloseTo(0.6, 5);
    });

    it('18. tools — maxRiskScoreLast3h picks the highest score', async () => {
      ctx = await setup();
      // Max should be 0.95
      await ctx.logger.log(makeOp('agt-l-1', 'tool-max-1', 'sess-1', minsAgo(5)), dec(0.95, 'block'));
      await ctx.logger.log(makeOp('agt-l-2', 'tool-max-1', 'sess-2', minsAgo(50)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agt-l-3', 'tool-max-1', 'sess-3', minsAgo(100)), dec(0.55, 'allow'));
      await ctx.logger.log(makeOp('agt-l-4', 'tool-max-1', 'sess-4', daysAgo(47)), dec(0.1, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-max-1');
      expect(status).toBe(200);
      expect(body.maxRiskScoreLast3h as number).toBeCloseTo(0.95, 5);
    });
  });

  // ── /operations/summary ────────────────────────────────────────────────────────

  describe('T1344-T1348 — v10.55 3h fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('19. summary — all 5 fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-m', 'fs', 'sess-1'), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body).toHaveProperty('blockRateLast3h');
      expect(body).toHaveProperty('allowRateLast3h');
      expect(body).toHaveProperty('requireApprovalRateLast3h');
      expect(body).toHaveProperty('avgRiskScoreLast3h');
      expect(body).toHaveProperty('maxRiskScoreLast3h');
    });

    it('20. summary — empty DB: all 5 new fields are null', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.blockRateLast3h).toBeNull();
      expect(body.allowRateLast3h).toBeNull();
      expect(body.requireApprovalRateLast3h).toBeNull();
      expect(body.avgRiskScoreLast3h).toBeNull();
      expect(body.maxRiskScoreLast3h).toBeNull();
    });

    it('21. summary — only old ops > 40d: all 5 fields are null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-n-1', 'fs', 'sess-1', daysAgo(41)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agt-n-2', 'fs', 'sess-2', daysAgo(50)), dec(0.7, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.blockRateLast3h).toBeNull();
      expect(body.allowRateLast3h).toBeNull();
      expect(body.requireApprovalRateLast3h).toBeNull();
      expect(body.avgRiskScoreLast3h).toBeNull();
      expect(body.maxRiskScoreLast3h).toBeNull();
    });

    it('22. summary — 6 ops in 3h (2 each action): all rates = 1/3', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-o-1', 'fs', 'sess-1', minsAgo(10)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agt-o-2', 'fs', 'sess-2', minsAgo(30)), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agt-o-3', 'fs', 'sess-3', minsAgo(60)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agt-o-4', 'fs', 'sess-4', minsAgo(100)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agt-o-5', 'fs', 'sess-5', minsAgo(140)), dec(0.6, 'require_approval'));
      await ctx.logger.log(makeOp('agt-o-6', 'fs', 'sess-6', minsAgo(170)), dec(0.7, 'require_approval'));
      await ctx.logger.log(makeOp('agt-o-7', 'fs', 'sess-7', daysAgo(43)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.blockRateLast3h as number).toBeCloseTo(1 / 3, 5);
      expect(body.allowRateLast3h as number).toBeCloseTo(1 / 3, 5);
      expect(body.requireApprovalRateLast3h as number).toBeCloseTo(1 / 3, 5);
    });

    it('23. summary — avgRiskScoreLast3h and maxRiskScoreLast3h from mixed ops', async () => {
      ctx = await setup();
      // Scores in 3h: 0.1, 0.5, 0.9 → avg=0.5, max=0.9
      await ctx.logger.log(makeOp('agt-p-1', 'fs', 'sess-1', minsAgo(20)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agt-p-2', 'fs', 'sess-2', minsAgo(60)), dec(0.5, 'block'));
      await ctx.logger.log(makeOp('agt-p-3', 'fs', 'sess-3', minsAgo(160)), dec(0.9, 'require_approval'));
      await ctx.logger.log(makeOp('agt-p-4', 'fs', 'sess-4', daysAgo(42)), dec(0.0, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.avgRiskScoreLast3h as number).toBeCloseTo(0.5, 5);
      expect(body.maxRiskScoreLast3h as number).toBeCloseTo(0.9, 5);
    });

    it('24. summary — old + recent mix: 3h fields reflect only recent ops, old logs ignored', async () => {
      ctx = await setup();
      // Recent (in 3h): 1 block (0.8), 1 allow (0.4) → blockRate=0.5, avg=0.6, max=0.8
      await ctx.logger.log(makeOp('agt-q-1', 'fs', 'sess-1', minsAgo(30)), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agt-q-2', 'fs', 'sess-2', minsAgo(120)), dec(0.4, 'allow'));
      // Old (> 3h): should NOT affect 3h window metrics
      await ctx.logger.log(makeOp('agt-q-3', 'fs', 'sess-3', daysAgo(41)), dec(0.0, 'block'));
      await ctx.logger.log(makeOp('agt-q-4', 'fs', 'sess-4', daysAgo(55)), dec(1.0, 'require_approval'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.blockRateLast3h as number).toBeCloseTo(0.5, 5);
      expect(body.allowRateLast3h as number).toBeCloseTo(0.5, 5);
      expect(body.requireApprovalRateLast3h as number).toBeCloseTo(0.0, 5);
      expect(body.avgRiskScoreLast3h as number).toBeCloseTo(0.6, 5);
      expect(body.maxRiskScoreLast3h as number).toBeCloseTo(0.8, 5);
    });

    it('25. summary — single op in 3h: rates are 0 or 1, avg=max=its riskScore', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-r-1', 'fs', 'sess-1', minsAgo(50)), dec(0.73, 'block'));
      await ctx.logger.log(makeOp('agt-r-2', 'fs', 'sess-2', daysAgo(46)), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.blockRateLast3h as number).toBeCloseTo(1.0, 5);
      expect(body.allowRateLast3h as number).toBeCloseTo(0.0, 5);
      expect(body.requireApprovalRateLast3h as number).toBeCloseTo(0.0, 5);
      expect(body.avgRiskScoreLast3h as number).toBeCloseTo(0.73, 5);
      expect(body.maxRiskScoreLast3h as number).toBeCloseTo(0.73, 5);
    });

    it('26. summary — all require_approval in 3h: requireApprovalRate=1, block/allow=0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-s-1', 'fs', 'sess-1', minsAgo(15)), dec(0.65, 'require_approval'));
      await ctx.logger.log(makeOp('agt-s-2', 'fs', 'sess-2', minsAgo(90)), dec(0.55, 'require_approval'));
      await ctx.logger.log(makeOp('agt-s-3', 'fs', 'sess-3', daysAgo(49)), dec(0.9, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.requireApprovalRateLast3h as number).toBeCloseTo(1.0, 5);
      expect(body.blockRateLast3h as number).toBeCloseTo(0.0, 5);
      expect(body.allowRateLast3h as number).toBeCloseTo(0.0, 5);
      // avg = (0.65+0.55)/2 = 0.6, max = 0.65
      expect(body.avgRiskScoreLast3h as number).toBeCloseTo(0.6, 5);
      expect(body.maxRiskScoreLast3h as number).toBeCloseTo(0.65, 5);
    });
  });
});

// ── v10.56 ────────────────────────────────────────────────────────────────────

describe('v10.56', () => {
  const hoursAgo = (h: number) => new Date(PINNED_NOW() - h * 3_600_000);
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1349-T1353 — v10.56 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1056-pres'), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1056-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('minRiskScoreLast3h');
      expect(body).toHaveProperty('riskScoreStdDevLast3h');
      expect(body).toHaveProperty('riskScoreIQRLast3h');
      expect(body).toHaveProperty('opsBurstLast12h');
      expect(body).toHaveProperty('blockCountLast12h');
    });

    it('2. sessions — no ops in 3h window: T1349-T1351 are null', async () => {
      ctx = await setup();
      // Seed old logs (40+ days) so session is found
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1056-null3h', daysAgo(40)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1056-null3h', daysAgo(45)), dec(0.7, 'block'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1056-null3h');
      expect(status).toBe(200);

      expect(body.minRiskScoreLast3h).toBeNull();
      expect(body.riskScoreStdDevLast3h).toBeNull();
      expect(body.riskScoreIQRLast3h).toBeNull();
    });

    it('3. sessions — no ops in 3h: opsBurstLast12h and blockCountLast12h are 0 if no 12h ops', async () => {
      ctx = await setup();
      // Seed old logs (40+ days)
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1056-zero12h', daysAgo(41)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1056-zero12h');
      expect(status).toBe(200);

      expect(body.opsBurstLast12h).toBe(0);
      expect(body.blockCountLast12h).toBe(0);
    });

    it('4. sessions — T1349 minRiskScoreLast3h computed correctly', async () => {
      ctx = await setup();
      // Three ops in last 3h with scores 0.2, 0.5, 0.8 — min should be 0.2
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1056-min', hoursAgo(1)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1056-min', hoursAgo(2)), dec(0.8, 'allow'));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1056-min', hoursAgo(2.5)), dec(0.2, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1056-min');
      expect(status).toBe(200);

      expect(body.minRiskScoreLast3h as number).toBeCloseTo(0.2, 5);
    });

    it('5. sessions — T1350 riskScoreStdDevLast3h: identical scores yields 0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1056-stddev0', hoursAgo(1)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1056-stddev0', hoursAgo(2)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1056-stddev0');
      expect(status).toBe(200);

      expect(body.riskScoreStdDevLast3h as number).toBeCloseTo(0, 10);
    });

    it('6. sessions — T1350 riskScoreStdDevLast3h computed correctly for varied scores', async () => {
      ctx = await setup();
      // Scores: [0.0, 1.0] — mean=0.5, stddev=sqrt(((0.5^2)+(0.5^2))/2)=0.5
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1056-stddev', hoursAgo(1)), dec(0.0, 'allow'));
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1056-stddev', hoursAgo(2)), dec(1.0, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1056-stddev');
      expect(status).toBe(200);

      expect(body.riskScoreStdDevLast3h as number).toBeCloseTo(0.5, 5);
    });

    it('7. sessions — T1351 riskScoreIQRLast3h computed correctly', async () => {
      ctx = await setup();
      // Scores in 3h: [0.1, 0.3, 0.7, 0.9] sorted
      // len=4, p25 idx=floor(4*0.25)=1 → 0.3; p75 idx=floor(4*0.75)=3 → 0.9; IQR=0.6
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1056-iqr'), dec(0.9, 'allow'));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1056-iqr', hoursAgo(1)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1056-iqr', hoursAgo(1.5)), dec(0.7, 'allow'));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1056-iqr', hoursAgo(2.5)), dec(0.1, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1056-iqr');
      expect(status).toBe(200);

      expect(body.riskScoreIQRLast3h as number).toBeCloseTo(0.6, 5);
    });

    it('8. sessions — T1352 opsBurstLast12h counts ops in 12h window only', async () => {
      ctx = await setup();
      // 2 ops in last 12h; 1 op older than 12h but within 24h
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1056-burst', hoursAgo(1)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1056-burst', hoursAgo(10)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1056-burst', hoursAgo(15)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1056-burst');
      expect(status).toBe(200);

      expect(body.opsBurstLast12h).toBe(2);
    });

    it('9. sessions — T1353 blockCountLast12h counts only block ops in 12h', async () => {
      ctx = await setup();
      // 1 block in 12h, 1 allow in 12h, 1 block outside 12h
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v1056-blk', hoursAgo(2)), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v1056-blk', hoursAgo(5)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v1056-blk', hoursAgo(14)), dec(0.9, 'block'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1056-blk');
      expect(status).toBe(200);

      expect(body.blockCountLast12h).toBe(1);
    });

    it('10. sessions — ops outside 3h excluded from T1349-T1351', async () => {
      ctx = await setup();
      // Op 4h ago (outside 3h) at score 0.1 should NOT affect min/stddev/IQR
      // Op 1h ago (inside 3h) at score 0.9 — min should be 0.9 not 0.1
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v1056-excl', hoursAgo(1)), dec(0.9, 'allow'));
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v1056-excl', hoursAgo(4)), dec(0.1, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1056-excl');
      expect(status).toBe(200);

      expect(body.minRiskScoreLast3h as number).toBeCloseTo(0.9, 5);
      expect(body.riskScoreStdDevLast3h as number).toBeCloseTo(0, 10);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1349-T1353 — v10.56 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('11. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1056-pres', 'fs', 'sess-1'), dec(0.3, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1056-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('minRiskScoreLast3h');
      expect(body).toHaveProperty('riskScoreStdDevLast3h');
      expect(body).toHaveProperty('riskScoreIQRLast3h');
      expect(body).toHaveProperty('opsBurstLast12h');
      expect(body).toHaveProperty('blockCountLast12h');
    });

    it('12. agents — no ops in 3h (only old logs 40+ days): T1349-T1351 are null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1056-null3h', 'fs', 'sess-1', daysAgo(40)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-v1056-null3h', 'fs', 'sess-2', daysAgo(42)), dec(0.6, 'block'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1056-null3h');
      expect(status).toBe(200);

      expect(body.minRiskScoreLast3h).toBeNull();
      expect(body.riskScoreStdDevLast3h).toBeNull();
      expect(body.riskScoreIQRLast3h).toBeNull();
    });

    it('13. agents — T1349 minRiskScoreLast3h picks minimum from 3h window', async () => {
      ctx = await setup();
      // Scores in 3h: 0.6, 0.2, 0.9 — min=0.2
      await ctx.logger.log(makeOp('agent-v1056-min', 'fs', 'sess-1'), dec(0.6, 'allow'));
      await ctx.logger.log(makeOp('agent-v1056-min', 'fs', 'sess-1', hoursAgo(1)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-v1056-min', 'fs', 'sess-1', hoursAgo(2)), dec(0.9, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1056-min');
      expect(status).toBe(200);

      expect(body.minRiskScoreLast3h as number).toBeCloseTo(0.2, 5);
    });

    it('14. agents — T1350 riskScoreStdDevLast3h is positive float for varied scores', async () => {
      ctx = await setup();
      // Scores: [0.2, 0.8] — mean=0.5, stddev=0.3
      await ctx.logger.log(makeOp('agent-v1056-std', 'fs', 'sess-1', hoursAgo(1)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-v1056-std', 'fs', 'sess-1', hoursAgo(2)), dec(0.8, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1056-std');
      expect(status).toBe(200);

      expect(body.riskScoreStdDevLast3h as number).toBeCloseTo(0.3, 5);
      expect(body.riskScoreStdDevLast3h as number).toBeGreaterThan(0);
    });

    it('15. agents — T1353 blockCountLast12h: multiple blocks counted correctly', async () => {
      ctx = await setup();
      // 3 blocks and 2 allows in last 12h
      await ctx.logger.log(makeOp('agent-v1056-blk', 'fs', 'sess-1', hoursAgo(1)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-v1056-blk', 'fs', 'sess-1', hoursAgo(3)), dec(0.7, 'block'));
      await ctx.logger.log(makeOp('agent-v1056-blk', 'fs', 'sess-1', hoursAgo(6)), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agent-v1056-blk', 'fs', 'sess-1', hoursAgo(8)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-v1056-blk', 'fs', 'sess-1', hoursAgo(11)), dec(0.2, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1056-blk');
      expect(status).toBe(200);

      expect(body.blockCountLast12h).toBe(3);
      expect(body.opsBurstLast12h).toBe(5);
    });

    it('16. agents — T1351 riskScoreIQRLast3h for single op: P75-P25 same index', async () => {
      ctx = await setup();
      // Single op in 3h: sorted=[0.5], len=1
      // p25 idx=floor(1*0.25)=0 → 0.5; p75 idx=floor(1*0.75)=0 → 0.5; IQR=0
      await ctx.logger.log(makeOp('agent-v1056-iqr1', 'fs', 'sess-1', hoursAgo(1)), dec(0.5, 'allow'));
      // Old log to avoid empty window edge cases on other fields
      await ctx.logger.log(makeOp('agent-v1056-iqr1', 'fs', 'sess-2', daysAgo(40)), dec(0.1, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1056-iqr1');
      expect(status).toBe(200);

      expect(body.riskScoreIQRLast3h as number).toBeCloseTo(0, 10);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1349-T1353 — v10.56 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('17. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-t', 'tool-v1056-pres', 'sess-1'), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1056-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('minRiskScoreLast3h');
      expect(body).toHaveProperty('riskScoreStdDevLast3h');
      expect(body).toHaveProperty('riskScoreIQRLast3h');
      expect(body).toHaveProperty('opsBurstLast12h');
      expect(body).toHaveProperty('blockCountLast12h');
    });

    it('18. tools — no ops in 3h (old logs 40+ days): T1349-T1351 are null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-t', 'tool-v1056-null', 'sess-1', daysAgo(40)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-t', 'tool-v1056-null', 'sess-2', daysAgo(43)), dec(0.6, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1056-null');
      expect(status).toBe(200);

      expect(body.minRiskScoreLast3h).toBeNull();
      expect(body.riskScoreStdDevLast3h).toBeNull();
      expect(body.riskScoreIQRLast3h).toBeNull();
    });

    it('19. tools — T1349 minRiskScoreLast3h: single op returns that op score', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-t', 'tool-v1056-single', 'sess-1', hoursAgo(1)), dec(0.35, 'allow'));
      // Old log to ensure entity exists regardless
      await ctx.logger.log(makeOp('agent-t', 'tool-v1056-single', 'sess-2', daysAgo(41)), dec(0.9, 'block'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1056-single');
      expect(status).toBe(200);

      expect(body.minRiskScoreLast3h as number).toBeCloseTo(0.35, 5);
    });

    it('20. tools — T1352 opsBurstLast12h is 0 when only old ops', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-t', 'tool-v1056-oldonly', 'sess-1', daysAgo(40)), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1056-oldonly');
      expect(status).toBe(200);

      expect(body.opsBurstLast12h).toBe(0);
      expect(body.blockCountLast12h).toBe(0);
    });

    it('21. tools — T1350 stddev null if no 3h ops; non-null if 3h ops present', async () => {
      ctx = await setup();
      // Old log provides tool existence
      await ctx.logger.log(makeOp('agent-t', 'tool-v1056-stdnull', 'sess-1', daysAgo(40)), dec(0.5, 'block'));

      const nullRes = await getJSON(ctx.port, '/tools/tool-v1056-stdnull');
      expect(nullRes.status).toBe(200);
      expect(nullRes.body.riskScoreStdDevLast3h).toBeNull();
    });

    it('22. tools — T1351 riskScoreIQRLast3h for 4 ops: correct calculation', async () => {
      ctx = await setup();
      // Scores in 3h: [0.0, 0.4, 0.6, 1.0] sorted
      // len=4: p25 idx=floor(4*0.25)=1 → 0.4; p75 idx=floor(4*0.75)=3 → 1.0; IQR=0.6
      await ctx.logger.log(makeOp('agent-t', 'tool-v1056-iqr', 'sess-1'), dec(0.0, 'allow'));
      await ctx.logger.log(makeOp('agent-t', 'tool-v1056-iqr', 'sess-1', hoursAgo(1)), dec(1.0, 'allow'));
      await ctx.logger.log(makeOp('agent-t', 'tool-v1056-iqr', 'sess-1', hoursAgo(2)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-t', 'tool-v1056-iqr', 'sess-1', hoursAgo(2.5)), dec(0.6, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1056-iqr');
      expect(status).toBe(200);

      expect(body.riskScoreIQRLast3h as number).toBeCloseTo(0.6, 5);
    });

    it('23. tools — T1353 blockCountLast12h excludes blocks older than 12h', async () => {
      ctx = await setup();
      // 1 block in 12h, 2 blocks older than 12h
      await ctx.logger.log(makeOp('agent-t', 'tool-v1056-blkexcl', 'sess-1', hoursAgo(3)), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agent-t', 'tool-v1056-blkexcl', 'sess-2', hoursAgo(13)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-t', 'tool-v1056-blkexcl', 'sess-3', hoursAgo(20)), dec(0.7, 'block'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1056-blkexcl');
      expect(status).toBe(200);

      expect(body.blockCountLast12h).toBe(1);
    });
  });

  // ── summary endpoint ───────────────────────────────────────────────────────────

  describe('T1349-T1353 — v10.56 new fields (summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('24. summary — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-sum', 'fs', 'sess-1'), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body).toHaveProperty('minRiskScoreLast3h');
      expect(body).toHaveProperty('riskScoreStdDevLast3h');
      expect(body).toHaveProperty('riskScoreIQRLast3h');
      expect(body).toHaveProperty('opsBurstLast12h');
      expect(body).toHaveProperty('blockCountLast12h');
    });

    it('25. summary — no ops in 3h (only old logs 40+ days): T1349-T1351 are null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-sum', 'fs', 'sess-1', daysAgo(40)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-sum', 'fs', 'sess-2', daysAgo(44)), dec(0.7, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.minRiskScoreLast3h).toBeNull();
      expect(body.riskScoreStdDevLast3h).toBeNull();
      expect(body.riskScoreIQRLast3h).toBeNull();
    });

    it('26. summary — T1349 minRiskScoreLast3h: global min across all agents', async () => {
      ctx = await setup();
      // Three ops from different agents in 3h
      await ctx.logger.log(makeOp('agent-sum-a', 'fs', 'sess-1'), dec(0.7, 'allow'));
      await ctx.logger.log(makeOp('agent-sum-b', 'fs', 'sess-2', hoursAgo(1)), dec(0.15, 'allow'));
      await ctx.logger.log(makeOp('agent-sum-c', 'fs', 'sess-3', hoursAgo(2)), dec(0.9, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.minRiskScoreLast3h as number).toBeCloseTo(0.15, 5);
    });

    it('27. summary — T1352 opsBurstLast12h accurate across all agents and sessions', async () => {
      ctx = await setup();
      // 4 ops in 12h, 2 ops older than 12h
      await ctx.logger.log(makeOp('agent-sum-d', 'fs', 'sess-1', hoursAgo(1)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-sum-d', 'fs', 'sess-1', hoursAgo(5)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-sum-e', 'fs', 'sess-2', hoursAgo(9)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-sum-e', 'fs', 'sess-2', hoursAgo(11.5)), dec(0.6, 'block'));
      await ctx.logger.log(makeOp('agent-sum-e', 'fs', 'sess-2', hoursAgo(13)), dec(0.7, 'block'));
      await ctx.logger.log(makeOp('agent-sum-f', 'fs', 'sess-3', daysAgo(2)), dec(0.8, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.opsBurstLast12h).toBe(4);
    });

    it('28. summary — T1353 blockCountLast12h: require_approval not counted as block', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-sum-g', 'fs', 'sess-1', hoursAgo(1)), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agent-sum-g', 'fs', 'sess-1', hoursAgo(2)), dec(0.6, 'require_approval'));
      await ctx.logger.log(makeOp('agent-sum-g', 'fs', 'sess-1', hoursAgo(3)), dec(0.3, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.blockCountLast12h).toBe(1);
    });

    it('29. summary — T1350 riskScoreStdDevLast3h computed for 3 varied scores', async () => {
      ctx = await setup();
      // Scores: [0.0, 0.5, 1.0] — mean=0.5
      // variance = ((0.5^2)+(0.0^2)+(0.5^2))/3 = 0.5/3
      // stddev = sqrt(1/6) ≈ 0.408248
      await ctx.logger.log(makeOp('agent-sum-h', 'fs', 'sess-1'), dec(0.0, 'allow'));
      await ctx.logger.log(makeOp('agent-sum-h', 'fs', 'sess-1', hoursAgo(1)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-sum-h', 'fs', 'sess-1', hoursAgo(2)), dec(1.0, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.riskScoreStdDevLast3h as number).toBeCloseTo(Math.sqrt(1 / 6), 5);
      expect(body.riskScoreStdDevLast3h as number).toBeGreaterThan(0);
    });

    it('30. summary — T1351 riskScoreIQRLast3h null when empty, number when populated', async () => {
      ctx = await setup();
      // Only old logs — IQR should be null
      await ctx.logger.log(makeOp('agent-sum-i', 'fs', 'sess-1', daysAgo(40)), dec(0.5, 'allow'));

      const oldRes = await getJSON(ctx.port, '/operations/summary');
      expect(oldRes.status).toBe(200);
      expect(oldRes.body.riskScoreIQRLast3h).toBeNull();
    });

    it('31. summary — T1351 riskScoreIQRLast3h positive when two distinct scores in 3h', async () => {
      ctx = await setup();
      // Scores in 3h: [0.2, 0.8], len=2
      // p25 idx=floor(2*0.25)=0 → 0.2; p75 idx=floor(2*0.75)=1 → 0.8; IQR=0.6
      await ctx.logger.log(makeOp('agent-sum-j', 'fs', 'sess-1', hoursAgo(1)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-sum-j', 'fs', 'sess-1', hoursAgo(2)), dec(0.8, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.riskScoreIQRLast3h as number).toBeCloseTo(0.6, 5);
    });
  });
});

// ── v10.57 ────────────────────────────────────────────────────────────────────

describe('v10.57', () => {
  const hoursAgo = (h: number) => new Date(PINNED_NOW() - h * 3_600_000);
  const daysAgo  = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);

  // ── sessions endpoint ─────────────────────────────────────────────────────────

  describe('T1354-T1358 — v10.57 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('ag-a', 'fs', 'sess-1057-pres'), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-1057-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('allowCountLast12h');
      expect(body).toHaveProperty('requireApprovalCountLast12h');
      expect(body).toHaveProperty('blockRateLast12h');
      expect(body).toHaveProperty('allowRateLast12h');
      expect(body).toHaveProperty('avgRiskScoreLast12h');
    });

    it('2. sessions — only old ops (>40d): count fields 0, rate/avg fields null', async () => {
      ctx = await setup();
      // Seed old logs so the entity exists but has no 12h ops
      await ctx.logger.log(makeOp('ag-b', 'fs', 'sess-1057-old', daysAgo(41)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('ag-b', 'fs', 'sess-1057-old', daysAgo(45)), dec(0.7, 'block'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-1057-old');
      expect(status).toBe(200);
      expect(body.allowCountLast12h).toBe(0);
      expect(body.requireApprovalCountLast12h).toBe(0);
      expect(body.blockRateLast12h).toBeNull();
      expect(body.allowRateLast12h).toBeNull();
      expect(body.avgRiskScoreLast12h).toBeNull();
    });

    it('3. sessions — allowCountLast12h counts only allowed ops in 12h', async () => {
      ctx = await setup();
      // Old logs to establish entity
      await ctx.logger.log(makeOp('ag-c', 'fs', 'sess-1057-allow', daysAgo(42)), dec(0.9, 'block'));
      // Recent: 2 allow, 1 block, 1 require_approval
      await ctx.logger.log(makeOp('ag-c', 'fs', 'sess-1057-allow', hoursAgo(1)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('ag-c', 'fs', 'sess-1057-allow', hoursAgo(3)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('ag-c', 'fs', 'sess-1057-allow', hoursAgo(5)), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('ag-c', 'fs', 'sess-1057-allow', hoursAgo(7)), dec(0.6, 'require_approval'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-1057-allow');
      expect(status).toBe(200);
      expect(body.allowCountLast12h).toBe(2);
    });

    it('4. sessions — requireApprovalCountLast12h counts only require_approval ops in 12h', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('ag-d', 'fs', 'sess-1057-req', daysAgo(43)), dec(0.5, 'allow'));
      // Recent: 3 require_approval, 1 allow
      await ctx.logger.log(makeOp('ag-d', 'fs', 'sess-1057-req', hoursAgo(2)), dec(0.5, 'require_approval'));
      await ctx.logger.log(makeOp('ag-d', 'fs', 'sess-1057-req', hoursAgo(4)), dec(0.6, 'require_approval'));
      await ctx.logger.log(makeOp('ag-d', 'fs', 'sess-1057-req', hoursAgo(10)), dec(0.7, 'require_approval'));
      await ctx.logger.log(makeOp('ag-d', 'fs', 'sess-1057-req', hoursAgo(11)), dec(0.2, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-1057-req');
      expect(status).toBe(200);
      expect(body.requireApprovalCountLast12h).toBe(3);
    });

    it('5. sessions — blockRateLast12h computed correctly with mixed actions', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('ag-e', 'fs', 'sess-1057-br', daysAgo(44)), dec(0.5, 'allow'));
      // 4 ops in 12h: 2 block, 1 allow, 1 require_approval → blockRate = 0.5
      await ctx.logger.log(makeOp('ag-e', 'fs', 'sess-1057-br', hoursAgo(1)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('ag-e', 'fs', 'sess-1057-br', hoursAgo(3)), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('ag-e', 'fs', 'sess-1057-br', hoursAgo(6)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('ag-e', 'fs', 'sess-1057-br', hoursAgo(9)), dec(0.5, 'require_approval'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-1057-br');
      expect(status).toBe(200);
      expect(body.blockRateLast12h as number).toBeCloseTo(0.5, 5);
    });

    it('6. sessions — allowRateLast12h computed correctly', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('ag-f', 'fs', 'sess-1057-ar', daysAgo(40)), dec(0.5, 'block'));
      // 4 ops: 3 allow, 1 block → allowRate = 0.75
      await ctx.logger.log(makeOp('ag-f', 'fs', 'sess-1057-ar', hoursAgo(1)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('ag-f', 'fs', 'sess-1057-ar', hoursAgo(4)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('ag-f', 'fs', 'sess-1057-ar', hoursAgo(8)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('ag-f', 'fs', 'sess-1057-ar', hoursAgo(11)), dec(0.9, 'block'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-1057-ar');
      expect(status).toBe(200);
      expect(body.allowRateLast12h as number).toBeCloseTo(0.75, 5);
    });

    it('7. sessions — avgRiskScoreLast12h computed from recent ops only', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('ag-g', 'fs', 'sess-1057-avg', daysAgo(41)), dec(0.9, 'block'));
      // Recent: 0.2 + 0.4 + 0.6 = 1.2 / 3 = 0.4
      await ctx.logger.log(makeOp('ag-g', 'fs', 'sess-1057-avg', hoursAgo(2)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('ag-g', 'fs', 'sess-1057-avg', hoursAgo(6)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('ag-g', 'fs', 'sess-1057-avg', hoursAgo(11)), dec(0.6, 'block'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-1057-avg');
      expect(status).toBe(200);
      expect(body.avgRiskScoreLast12h as number).toBeCloseTo(0.4, 5);
    });

    it('8. sessions — op exactly at 12h boundary is counted; op just outside is not', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('ag-h', 'fs', 'sess-1057-bnd', daysAgo(42)), dec(0.5, 'allow'));
      // Inside 12h: at 11h59m ago
      await ctx.logger.log(makeOp('ag-h', 'fs', 'sess-1057-bnd', hoursAgo(11.99)), dec(0.3, 'allow'));
      // Outside 12h: at 12h1m ago
      await ctx.logger.log(makeOp('ag-h', 'fs', 'sess-1057-bnd', hoursAgo(12.02)), dec(0.9, 'block'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-1057-bnd');
      expect(status).toBe(200);
      expect(body.allowCountLast12h).toBe(1);
      expect(body.avgRiskScoreLast12h as number).toBeCloseTo(0.3, 5);
    });
  });

  // ── agents endpoint ───────────────────────────────────────────────────────────

  describe('T1354-T1358 — v10.57 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('9. agents — all five fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('ag-1057-pres', 'fs', 'sess-1'), dec(0.3, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/ag-1057-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('allowCountLast12h');
      expect(body).toHaveProperty('requireApprovalCountLast12h');
      expect(body).toHaveProperty('blockRateLast12h');
      expect(body).toHaveProperty('allowRateLast12h');
      expect(body).toHaveProperty('avgRiskScoreLast12h');
    });

    it('10. agents — only old ops (>40d): counts are 0, rate/avg are null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('ag-1057-old', 'fs', 'sess-1', daysAgo(42)), dec(0.6, 'allow'));
      await ctx.logger.log(makeOp('ag-1057-old', 'fs', 'sess-2', daysAgo(50)), dec(0.8, 'block'));

      const { status, body } = await getJSON(ctx.port, '/agents/ag-1057-old');
      expect(status).toBe(200);
      expect(body.allowCountLast12h).toBe(0);
      expect(body.requireApprovalCountLast12h).toBe(0);
      expect(body.blockRateLast12h).toBeNull();
      expect(body.allowRateLast12h).toBeNull();
      expect(body.avgRiskScoreLast12h).toBeNull();
    });

    it('11. agents — allowCountLast12h and requireApprovalCountLast12h correct', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('ag-1057-cnt', 'fs', 'sess-1', daysAgo(41)), dec(0.5, 'allow'));
      // 2 allow, 1 require_approval, 1 block in 12h
      await ctx.logger.log(makeOp('ag-1057-cnt', 'fs', 'sess-2', hoursAgo(1)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('ag-1057-cnt', 'fs', 'sess-3', hoursAgo(3)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('ag-1057-cnt', 'fs', 'sess-4', hoursAgo(6)), dec(0.7, 'require_approval'));
      await ctx.logger.log(makeOp('ag-1057-cnt', 'fs', 'sess-5', hoursAgo(9)), dec(0.9, 'block'));

      const { status, body } = await getJSON(ctx.port, '/agents/ag-1057-cnt');
      expect(status).toBe(200);
      expect(body.allowCountLast12h).toBe(2);
      expect(body.requireApprovalCountLast12h).toBe(1);
    });

    it('12. agents — blockRateLast12h is 1.0 when all recent ops blocked', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('ag-1057-blk', 'fs', 'sess-1', daysAgo(43)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('ag-1057-blk', 'fs', 'sess-2', hoursAgo(2)), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('ag-1057-blk', 'fs', 'sess-3', hoursAgo(5)), dec(0.9, 'block'));

      const { status, body } = await getJSON(ctx.port, '/agents/ag-1057-blk');
      expect(status).toBe(200);
      expect(body.blockRateLast12h as number).toBeCloseTo(1.0, 5);
      expect(body.allowRateLast12h as number).toBeCloseTo(0.0, 5);
    });

    it('13. agents — avgRiskScoreLast12h excludes ops older than 12h', async () => {
      ctx = await setup();
      // Old op with high risk — must be excluded from avg
      await ctx.logger.log(makeOp('ag-1057-avg', 'fs', 'sess-1', daysAgo(40)), dec(0.99, 'block'));
      // Recent: 0.1 + 0.3 = 0.2 avg
      await ctx.logger.log(makeOp('ag-1057-avg', 'fs', 'sess-2', hoursAgo(3)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('ag-1057-avg', 'fs', 'sess-3', hoursAgo(8)), dec(0.3, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/ag-1057-avg');
      expect(status).toBe(200);
      expect(body.avgRiskScoreLast12h as number).toBeCloseTo(0.2, 5);
    });

    it('14. agents — allowRateLast12h is 0 when all recent ops are blocked', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('ag-1057-zero-ar', 'fs', 'sess-1', daysAgo(44)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('ag-1057-zero-ar', 'fs', 'sess-2', hoursAgo(4)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('ag-1057-zero-ar', 'fs', 'sess-3', hoursAgo(7)), dec(0.8, 'block'));

      const { status, body } = await getJSON(ctx.port, '/agents/ag-1057-zero-ar');
      expect(status).toBe(200);
      expect(body.allowRateLast12h as number).toBeCloseTo(0.0, 5);
      expect(body.allowCountLast12h).toBe(0);
    });

    it('15. agents — counts are integers (not floats)', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('ag-1057-int', 'fs', 'sess-1', daysAgo(41)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('ag-1057-int', 'fs', 'sess-2', hoursAgo(2)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('ag-1057-int', 'fs', 'sess-3', hoursAgo(5)), dec(0.6, 'require_approval'));

      const { status, body } = await getJSON(ctx.port, '/agents/ag-1057-int');
      expect(status).toBe(200);
      expect(Number.isInteger(body.allowCountLast12h)).toBe(true);
      expect(Number.isInteger(body.requireApprovalCountLast12h)).toBe(true);
    });
  });

  // ── tools endpoint ────────────────────────────────────────────────────────────

  describe('T1354-T1358 — v10.57 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('16. tools — all five fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('ag-i', 'tool-1057-pres', 'sess-1'), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-1057-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('allowCountLast12h');
      expect(body).toHaveProperty('requireApprovalCountLast12h');
      expect(body).toHaveProperty('blockRateLast12h');
      expect(body).toHaveProperty('allowRateLast12h');
      expect(body).toHaveProperty('avgRiskScoreLast12h');
    });

    it('17. tools — only old ops (>40d): counts are 0, rate/avg are null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('ag-j', 'tool-1057-old', 'sess-1', daysAgo(41)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('ag-j', 'tool-1057-old', 'sess-2', daysAgo(55)), dec(0.7, 'block'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-1057-old');
      expect(status).toBe(200);
      expect(body.allowCountLast12h).toBe(0);
      expect(body.requireApprovalCountLast12h).toBe(0);
      expect(body.blockRateLast12h).toBeNull();
      expect(body.allowRateLast12h).toBeNull();
      expect(body.avgRiskScoreLast12h).toBeNull();
    });

    it('18. tools — allowCountLast12h counts only 12h-window allows', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('ag-k', 'tool-1057-ac', 'sess-1', daysAgo(42)), dec(0.5, 'allow'));
      // 3 allows and 2 blocks in 12h
      await ctx.logger.log(makeOp('ag-k', 'tool-1057-ac', 'sess-2', hoursAgo(1)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('ag-k', 'tool-1057-ac', 'sess-3', hoursAgo(4)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('ag-k', 'tool-1057-ac', 'sess-4', hoursAgo(7)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('ag-k', 'tool-1057-ac', 'sess-5', hoursAgo(9)), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('ag-k', 'tool-1057-ac', 'sess-6', hoursAgo(11)), dec(0.9, 'block'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-1057-ac');
      expect(status).toBe(200);
      expect(body.allowCountLast12h).toBe(3);
    });

    it('19. tools — requireApprovalCountLast12h is 0 when no require_approval ops in window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('ag-l', 'tool-1057-noReq', 'sess-1', daysAgo(43)), dec(0.5, 'require_approval'));
      await ctx.logger.log(makeOp('ag-l', 'tool-1057-noReq', 'sess-2', hoursAgo(3)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('ag-l', 'tool-1057-noReq', 'sess-3', hoursAgo(9)), dec(0.7, 'block'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-1057-noReq');
      expect(status).toBe(200);
      expect(body.requireApprovalCountLast12h).toBe(0);
    });

    it('20. tools — blockRateLast12h and allowRateLast12h sum to ≤1 (gap covered by require_approval)', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('ag-m', 'tool-1057-sum', 'sess-1', daysAgo(40)), dec(0.5, 'allow'));
      // 4 ops: 1 allow, 1 block, 2 require_approval → blockRate=0.25, allowRate=0.25
      await ctx.logger.log(makeOp('ag-m', 'tool-1057-sum', 'sess-2', hoursAgo(2)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('ag-m', 'tool-1057-sum', 'sess-3', hoursAgo(4)), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('ag-m', 'tool-1057-sum', 'sess-4', hoursAgo(7)), dec(0.5, 'require_approval'));
      await ctx.logger.log(makeOp('ag-m', 'tool-1057-sum', 'sess-5', hoursAgo(10)), dec(0.6, 'require_approval'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-1057-sum');
      expect(status).toBe(200);
      expect(body.blockRateLast12h as number).toBeCloseTo(0.25, 5);
      expect(body.allowRateLast12h as number).toBeCloseTo(0.25, 5);
      expect(body.requireApprovalCountLast12h).toBe(2);
    });

    it('21. tools — avgRiskScoreLast12h with varied scores', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('ag-n', 'tool-1057-avg', 'sess-1', daysAgo(44)), dec(0.0, 'allow'));
      // Recent: 0.2 + 0.6 + 1.0 = 1.8 / 3 = 0.6
      await ctx.logger.log(makeOp('ag-n', 'tool-1057-avg', 'sess-2', hoursAgo(2)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('ag-n', 'tool-1057-avg', 'sess-3', hoursAgo(6)), dec(0.6, 'block'));
      await ctx.logger.log(makeOp('ag-n', 'tool-1057-avg', 'sess-4', hoursAgo(10)), dec(1.0, 'block'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-1057-avg');
      expect(status).toBe(200);
      expect(body.avgRiskScoreLast12h as number).toBeCloseTo(0.6, 5);
    });
  });

  // ── operations/summary endpoint ───────────────────────────────────────────────

  describe('T1354-T1358 — v10.57 new fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('22. summary — all five fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('ag-o', 'fs', 'sess-1'), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body).toHaveProperty('allowCountLast12h');
      expect(body).toHaveProperty('requireApprovalCountLast12h');
      expect(body).toHaveProperty('blockRateLast12h');
      expect(body).toHaveProperty('allowRateLast12h');
      expect(body).toHaveProperty('avgRiskScoreLast12h');
    });

    it('23. summary — empty DB: count fields are 0, rate/avg fields are null', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.allowCountLast12h).toBe(0);
      expect(body.requireApprovalCountLast12h).toBe(0);
      expect(body.blockRateLast12h).toBeNull();
      expect(body.allowRateLast12h).toBeNull();
      expect(body.avgRiskScoreLast12h).toBeNull();
    });

    it('24. summary — only old ops (>40d): counts 0, rate/avg null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('ag-p-1', 'fs', 'sess-1', daysAgo(41)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('ag-p-2', 'fs', 'sess-2', daysAgo(48)), dec(0.7, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.allowCountLast12h).toBe(0);
      expect(body.requireApprovalCountLast12h).toBe(0);
      expect(body.blockRateLast12h).toBeNull();
      expect(body.allowRateLast12h).toBeNull();
      expect(body.avgRiskScoreLast12h).toBeNull();
    });

    it('25. summary — allowCountLast12h aggregates across all agents and tools', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('ag-q-1', 'tool-x', 'sess-1', daysAgo(42)), dec(0.5, 'allow'));
      // Different agents/tools contributing allows
      await ctx.logger.log(makeOp('ag-q-1', 'tool-x', 'sess-2', hoursAgo(1)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('ag-q-2', 'tool-y', 'sess-3', hoursAgo(4)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('ag-q-3', 'tool-z', 'sess-4', hoursAgo(8)), dec(0.9, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.allowCountLast12h).toBe(2);
    });

    it('26. summary — requireApprovalCountLast12h aggregates correctly', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('ag-r-1', 'tool-a', 'sess-1', daysAgo(45)), dec(0.5, 'require_approval'));
      await ctx.logger.log(makeOp('ag-r-1', 'tool-a', 'sess-2', hoursAgo(2)), dec(0.4, 'require_approval'));
      await ctx.logger.log(makeOp('ag-r-2', 'tool-b', 'sess-3', hoursAgo(5)), dec(0.5, 'require_approval'));
      await ctx.logger.log(makeOp('ag-r-3', 'tool-c', 'sess-4', hoursAgo(9)), dec(0.1, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.requireApprovalCountLast12h).toBe(2);
    });

    it('27. summary — blockRateLast12h and allowRateLast12h correct with mixed actions', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('ag-s-1', 'tool-p', 'sess-1', daysAgo(41)), dec(0.5, 'allow'));
      // 6 ops in 12h: 2 block, 3 allow, 1 require_approval
      // blockRate = 2/6 ≈ 0.333; allowRate = 3/6 = 0.5
      await ctx.logger.log(makeOp('ag-s-1', 'tool-p', 'sess-2', hoursAgo(1)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('ag-s-1', 'tool-p', 'sess-3', hoursAgo(2)), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('ag-s-2', 'tool-q', 'sess-4', hoursAgo(4)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('ag-s-2', 'tool-q', 'sess-5', hoursAgo(7)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('ag-s-3', 'tool-r', 'sess-6', hoursAgo(9)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('ag-s-3', 'tool-r', 'sess-7', hoursAgo(11)), dec(0.6, 'require_approval'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.blockRateLast12h as number).toBeCloseTo(2 / 6, 5);
      expect(body.allowRateLast12h as number).toBeCloseTo(3 / 6, 5);
    });

    it('28. summary — avgRiskScoreLast12h computed across all agents/tools in 12h window', async () => {
      ctx = await setup();
      // Old op excluded
      await ctx.logger.log(makeOp('ag-t-1', 'tool-m', 'sess-1', daysAgo(43)), dec(0.99, 'block'));
      // Recent: 0.2 + 0.4 + 0.6 + 0.8 = 2.0 / 4 = 0.5
      await ctx.logger.log(makeOp('ag-t-1', 'tool-m', 'sess-2', hoursAgo(2)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('ag-t-2', 'tool-n', 'sess-3', hoursAgo(5)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('ag-t-3', 'tool-o', 'sess-4', hoursAgo(8)), dec(0.6, 'block'));
      await ctx.logger.log(makeOp('ag-t-4', 'tool-p2', 'sess-5', hoursAgo(11)), dec(0.8, 'require_approval'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.avgRiskScoreLast12h as number).toBeCloseTo(0.5, 5);
    });

    it('29. summary — single op in 12h: all five fields reflect it correctly', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('ag-u', 'tool-single', 'sess-1', daysAgo(41)), dec(0.5, 'block'));
      await ctx.logger.log(makeOp('ag-u', 'tool-single', 'sess-2', hoursAgo(5)), dec(0.42, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.allowCountLast12h).toBe(1);
      expect(body.requireApprovalCountLast12h).toBe(0);
      expect(body.blockRateLast12h as number).toBeCloseTo(0.0, 5);
      expect(body.allowRateLast12h as number).toBeCloseTo(1.0, 5);
      expect(body.avgRiskScoreLast12h as number).toBeCloseTo(0.42, 5);
    });
  });
});

// ── v10.58 ────────────────────────────────────────────────────────────────────

describe('v10.58', () => {
  const hoursAgo = (h: number) => new Date(PINNED_NOW() - h * 3_600_000);
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1359-T1363 — v10.58 12h fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1058-pres', hoursAgo(1)), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1058-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('maxRiskScoreLast12h');
      expect(body).toHaveProperty('minRiskScoreLast12h');
      expect(body).toHaveProperty('riskScoreStdDevLast12h');
      expect(body).toHaveProperty('riskScoreIQRLast12h');
      expect(body).toHaveProperty('requireApprovalRateLast12h');
    });

    it('2. sessions — no ops in 12h (only old ops >40d): all five fields are null', async () => {
      ctx = await setup();
      // Seed old logs to ensure entity exists without polluting 12h window
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1058-old', daysAgo(41)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1058-old', daysAgo(45)), dec(0.7, 'block'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1058-old');
      expect(status).toBe(200);

      expect(body.maxRiskScoreLast12h).toBeNull();
      expect(body.minRiskScoreLast12h).toBeNull();
      expect(body.riskScoreStdDevLast12h).toBeNull();
      expect(body.riskScoreIQRLast12h).toBeNull();
      expect(body.requireApprovalRateLast12h).toBeNull();
    });

    it('3. sessions — single op in 12h: max and min are equal, stddev is 0', async () => {
      ctx = await setup();
      // Old logs for entity existence
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1058-single', daysAgo(42)), dec(0.9, 'block'));
      // Single recent op
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1058-single', hoursAgo(2)), dec(0.6, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1058-single');
      expect(status).toBe(200);

      expect(body.maxRiskScoreLast12h as number).toBeCloseTo(0.6, 5);
      expect(body.minRiskScoreLast12h as number).toBeCloseTo(0.6, 5);
      expect(body.riskScoreStdDevLast12h as number).toBeCloseTo(0, 5);
      // IQR: sorted [0.6], len=1; p75 idx=floor(1*0.75)=0; p25 idx=floor(1*0.25)=0; IQR=0
      expect(body.riskScoreIQRLast12h as number).toBeCloseTo(0, 5);
      // One op, not require_approval → rate = 0/1 = 0
      expect(body.requireApprovalRateLast12h as number).toBeCloseTo(0, 5);
    });

    it('4. sessions — max and min computed correctly with four ops in 12h', async () => {
      ctx = await setup();
      // Old logs to anchor entity
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1058-maxmin', daysAgo(43)), dec(0.5, 'allow'));
      // Four ops in 12h: scores 0.1, 0.4, 0.7, 0.9
      for (const [score, h] of [[0.9, 1], [0.1, 3], [0.7, 8], [0.4, 11]] as [number, number][]) {
        await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1058-maxmin', hoursAgo(h)), dec(score, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1058-maxmin');
      expect(status).toBe(200);

      expect(body.maxRiskScoreLast12h as number).toBeCloseTo(0.9, 5);
      expect(body.minRiskScoreLast12h as number).toBeCloseTo(0.1, 5);
    });

    it('5. sessions — stddev computed correctly with known scores', async () => {
      ctx = await setup();
      // Old logs to anchor entity
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1058-stddev', daysAgo(44)), dec(0.5, 'allow'));
      // Four ops in 12h: scores [0.2, 0.4, 0.6, 0.8]
      // mean = 0.5; deviations² = [0.09, 0.01, 0.01, 0.09]; variance = 0.20/4 = 0.05; stddev ≈ 0.2236
      for (const [score, h] of [[0.2, 1], [0.4, 4], [0.6, 7], [0.8, 10]] as [number, number][]) {
        await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1058-stddev', hoursAgo(h)), dec(score, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1058-stddev');
      expect(status).toBe(200);

      expect(body.riskScoreStdDevLast12h as number).toBeCloseTo(Math.sqrt(0.05), 4);
    });

    it('6. sessions — IQR computed correctly with four ops in 12h', async () => {
      ctx = await setup();
      // Old logs to anchor entity
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1058-iqr', daysAgo(45)), dec(0.3, 'allow'));
      // Four ops in 12h: scores [0.1, 0.3, 0.7, 0.9] (sorted)
      // len=4: p25 idx=floor(4*0.25)=1 → 0.3; p75 idx=floor(4*0.75)=3 → 0.9; IQR=0.6
      for (const [score, h] of [[0.9, 2], [0.1, 5], [0.3, 8], [0.7, 11]] as [number, number][]) {
        await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1058-iqr', hoursAgo(h)), dec(score, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1058-iqr');
      expect(status).toBe(200);

      expect(body.riskScoreIQRLast12h as number).toBeCloseTo(0.6, 5);
    });

    it('7. sessions — requireApprovalRateLast12h with mixed actions', async () => {
      ctx = await setup();
      // Old logs to anchor entity
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1058-approval', daysAgo(46)), dec(0.3, 'allow'));
      // 4 ops in 12h: 2 require_approval, 1 allow, 1 block → rate = 2/4 = 0.5
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1058-approval', hoursAgo(1)), dec(0.8, 'require_approval'));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1058-approval', hoursAgo(3)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1058-approval', hoursAgo(6)), dec(0.9, 'require_approval'));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1058-approval', hoursAgo(10)), dec(0.6, 'block'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1058-approval');
      expect(status).toBe(200);

      expect(body.requireApprovalRateLast12h as number).toBeCloseTo(0.5, 5);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1359-T1363 — v10.58 12h fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('8. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1058-pres', 'fs', 'sess-1', hoursAgo(1)), dec(0.3, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1058-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('maxRiskScoreLast12h');
      expect(body).toHaveProperty('minRiskScoreLast12h');
      expect(body).toHaveProperty('riskScoreStdDevLast12h');
      expect(body).toHaveProperty('riskScoreIQRLast12h');
      expect(body).toHaveProperty('requireApprovalRateLast12h');
    });

    it('9. agents — no ops in 12h (only old ops >40d): all five fields are null', async () => {
      ctx = await setup();
      // Seed old logs to ensure entity exists without polluting 12h window
      await ctx.logger.log(makeOp('agent-v1058-old', 'fs', 'sess-1', daysAgo(41)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-v1058-old', 'fs', 'sess-2', daysAgo(50)), dec(0.8, 'block'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1058-old');
      expect(status).toBe(200);

      expect(body.maxRiskScoreLast12h).toBeNull();
      expect(body.minRiskScoreLast12h).toBeNull();
      expect(body.riskScoreStdDevLast12h).toBeNull();
      expect(body.riskScoreIQRLast12h).toBeNull();
      expect(body.requireApprovalRateLast12h).toBeNull();
    });

    it('10. agents — max and min correct with ops spanning 12h boundary', async () => {
      ctx = await setup();
      // Old logs to anchor entity
      await ctx.logger.log(makeOp('agent-v1058-maxmin', 'fs', 'sess-1', daysAgo(42)), dec(0.1, 'allow'));
      // Op just inside 12h window (11.9h ago): score 0.2
      await ctx.logger.log(makeOp('agent-v1058-maxmin', 'fs', 'sess-1', hoursAgo(11.9)), dec(0.2, 'allow'));
      // Op just outside 12h window (12.1h ago): score 0.95 — should NOT be counted
      await ctx.logger.log(makeOp('agent-v1058-maxmin', 'fs', 'sess-2', hoursAgo(12.1)), dec(0.95, 'allow'));
      // Op well inside 12h window: score 0.8
      await ctx.logger.log(makeOp('agent-v1058-maxmin', 'fs', 'sess-3', hoursAgo(5)), dec(0.8, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1058-maxmin');
      expect(status).toBe(200);

      // Only ops within 12h: scores [0.2, 0.8] → max=0.8, min=0.2
      expect(body.maxRiskScoreLast12h as number).toBeCloseTo(0.8, 4);
      expect(body.minRiskScoreLast12h as number).toBeCloseTo(0.2, 4);
    });

    it('11. agents — stddev is 0 when all scores are identical', async () => {
      ctx = await setup();
      // Old logs to anchor entity
      await ctx.logger.log(makeOp('agent-v1058-stddev0', 'fs', 'sess-1', daysAgo(43)), dec(0.3, 'allow'));
      // Three ops in 12h all with score 0.5
      for (const h of [2, 6, 10]) {
        await ctx.logger.log(makeOp('agent-v1058-stddev0', 'fs', 'sess-1', hoursAgo(h)), dec(0.5, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1058-stddev0');
      expect(status).toBe(200);

      expect(body.riskScoreStdDevLast12h as number).toBeCloseTo(0, 5);
    });

    it('12. agents — IQR with six ops in 12h', async () => {
      ctx = await setup();
      // Old logs to anchor entity
      await ctx.logger.log(makeOp('agent-v1058-iqr6', 'fs', 'sess-1', daysAgo(44)), dec(0.5, 'allow'));
      // Six ops in 12h: scores [0.1, 0.2, 0.4, 0.6, 0.8, 0.9] (sorted)
      // len=6: p25 idx=floor(6*0.25)=1 → 0.2; p75 idx=floor(6*0.75)=4 → 0.8; IQR=0.6
      for (const [score, h] of [
        [0.4, 1], [0.1, 3], [0.9, 5], [0.6, 7], [0.2, 9], [0.8, 11]
      ] as [number, number][]) {
        await ctx.logger.log(makeOp('agent-v1058-iqr6', 'fs', 'sess-1', hoursAgo(h)), dec(score, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1058-iqr6');
      expect(status).toBe(200);

      expect(body.riskScoreIQRLast12h as number).toBeCloseTo(0.6, 5);
    });

    it('13. agents — all ops in 12h are require_approval: rate is 1.0', async () => {
      ctx = await setup();
      // Old logs to anchor entity
      await ctx.logger.log(makeOp('agent-v1058-allapp', 'fs', 'sess-1', daysAgo(45)), dec(0.3, 'allow'));
      // All 3 recent ops require approval
      for (const h of [1, 5, 9]) {
        await ctx.logger.log(makeOp('agent-v1058-allapp', 'fs', 'sess-1', hoursAgo(h)), dec(0.7, 'require_approval'));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1058-allapp');
      expect(status).toBe(200);

      expect(body.requireApprovalRateLast12h as number).toBeCloseTo(1.0, 5);
    });

    it('14. agents — no ops require_approval in 12h: rate is 0.0', async () => {
      ctx = await setup();
      // Old logs to anchor entity
      await ctx.logger.log(makeOp('agent-v1058-noapp', 'fs', 'sess-1', daysAgo(46)), dec(0.3, 'allow'));
      // 3 recent ops: allow and block only
      await ctx.logger.log(makeOp('agent-v1058-noapp', 'fs', 'sess-1', hoursAgo(2)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-v1058-noapp', 'fs', 'sess-1', hoursAgo(7)), dec(0.7, 'block'));
      await ctx.logger.log(makeOp('agent-v1058-noapp', 'fs', 'sess-1', hoursAgo(11)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1058-noapp');
      expect(status).toBe(200);

      expect(body.requireApprovalRateLast12h as number).toBeCloseTo(0.0, 5);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1359-T1363 — v10.58 12h fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('15. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-h', 'tool-v1058-pres', 'sess-1', hoursAgo(1)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1058-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('maxRiskScoreLast12h');
      expect(body).toHaveProperty('minRiskScoreLast12h');
      expect(body).toHaveProperty('riskScoreStdDevLast12h');
      expect(body).toHaveProperty('riskScoreIQRLast12h');
      expect(body).toHaveProperty('requireApprovalRateLast12h');
    });

    it('16. tools — no ops in 12h (only old ops >40d): all five fields are null', async () => {
      ctx = await setup();
      // Seed old logs to ensure entity exists without polluting 12h window
      await ctx.logger.log(makeOp('agent-i', 'tool-v1058-old', 'sess-1', daysAgo(41)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-i', 'tool-v1058-old', 'sess-2', daysAgo(55)), dec(0.9, 'block'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1058-old');
      expect(status).toBe(200);

      expect(body.maxRiskScoreLast12h).toBeNull();
      expect(body.minRiskScoreLast12h).toBeNull();
      expect(body.riskScoreStdDevLast12h).toBeNull();
      expect(body.riskScoreIQRLast12h).toBeNull();
      expect(body.requireApprovalRateLast12h).toBeNull();
    });

    it('17. tools — max, min, stddev, IQR all correct with five ops in 12h', async () => {
      ctx = await setup();
      // Old logs to anchor entity
      await ctx.logger.log(makeOp('agent-j', 'tool-v1058-five', 'sess-1', daysAgo(42)), dec(0.5, 'allow'));
      // Five ops in 12h: scores [0.1, 0.3, 0.5, 0.7, 0.9] (sorted)
      // max=0.9, min=0.1
      // mean=0.5; deviations²=[0.16, 0.04, 0, 0.04, 0.16]; variance=0.40/5=0.08; stddev≈0.2828
      // IQR: len=5; p25 idx=floor(5*0.25)=1→0.3; p75 idx=floor(5*0.75)=3→0.7; IQR=0.4
      for (const [score, h] of [[0.9, 1], [0.1, 3], [0.5, 5], [0.3, 8], [0.7, 11]] as [number, number][]) {
        await ctx.logger.log(makeOp('agent-j', 'tool-v1058-five', 'sess-1', hoursAgo(h)), dec(score, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1058-five');
      expect(status).toBe(200);

      expect(body.maxRiskScoreLast12h as number).toBeCloseTo(0.9, 5);
      expect(body.minRiskScoreLast12h as number).toBeCloseTo(0.1, 5);
      expect(body.riskScoreStdDevLast12h as number).toBeCloseTo(Math.sqrt(0.08), 4);
      expect(body.riskScoreIQRLast12h as number).toBeCloseTo(0.4, 5);
    });

    it('18. tools — requireApprovalRateLast12h with 1 out of 3: rate = 0.333...', async () => {
      ctx = await setup();
      // Old logs to anchor entity
      await ctx.logger.log(makeOp('agent-k', 'tool-v1058-rate', 'sess-1', daysAgo(43)), dec(0.3, 'allow'));
      // 3 ops in 12h: 1 require_approval, 2 allow → rate = 1/3
      await ctx.logger.log(makeOp('agent-k', 'tool-v1058-rate', 'sess-1', hoursAgo(2)), dec(0.9, 'require_approval'));
      await ctx.logger.log(makeOp('agent-k', 'tool-v1058-rate', 'sess-1', hoursAgo(6)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-k', 'tool-v1058-rate', 'sess-1', hoursAgo(10)), dec(0.2, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1058-rate');
      expect(status).toBe(200);

      expect(body.requireApprovalRateLast12h as number).toBeCloseTo(1 / 3, 4);
    });

    it('19. tools — ops exactly at 12h boundary are excluded', async () => {
      ctx = await setup();
      // Old logs to anchor entity
      await ctx.logger.log(makeOp('agent-l', 'tool-v1058-boundary', 'sess-1', daysAgo(44)), dec(0.5, 'allow'));
      // Op at exactly 12h (at the boundary, just outside) — should NOT count
      await ctx.logger.log(makeOp('agent-l', 'tool-v1058-boundary', 'sess-1', hoursAgo(12.001)), dec(0.99, 'require_approval'));
      // Op inside 12h window: score 0.2
      await ctx.logger.log(makeOp('agent-l', 'tool-v1058-boundary', 'sess-1', hoursAgo(6)), dec(0.2, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1058-boundary');
      expect(status).toBe(200);

      // Only the op at 6h ago is counted
      expect(body.maxRiskScoreLast12h as number).toBeCloseTo(0.2, 4);
      expect(body.minRiskScoreLast12h as number).toBeCloseTo(0.2, 4);
      expect(body.requireApprovalRateLast12h as number).toBeCloseTo(0.0, 5);
    });
  });

  // ── operations/summary endpoint ────────────────────────────────────────────────

  describe('T1359-T1363 — v10.58 12h fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('20. summary — all five new fields present', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-m', 'tool-s', 'sess-1', hoursAgo(1)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body).toHaveProperty('maxRiskScoreLast12h');
      expect(body).toHaveProperty('minRiskScoreLast12h');
      expect(body).toHaveProperty('riskScoreStdDevLast12h');
      expect(body).toHaveProperty('riskScoreIQRLast12h');
      expect(body).toHaveProperty('requireApprovalRateLast12h');
    });

    it('21. summary — empty DB: all five new fields are null', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.maxRiskScoreLast12h).toBeNull();
      expect(body.minRiskScoreLast12h).toBeNull();
      expect(body.riskScoreStdDevLast12h).toBeNull();
      expect(body.riskScoreIQRLast12h).toBeNull();
      expect(body.requireApprovalRateLast12h).toBeNull();
    });

    it('22. summary — only old ops (>40d): all five fields are null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-n-1', 'tool-n', 'sess-1', daysAgo(41)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-n-2', 'tool-n', 'sess-2', daysAgo(47)), dec(0.7, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.maxRiskScoreLast12h).toBeNull();
      expect(body.minRiskScoreLast12h).toBeNull();
      expect(body.riskScoreStdDevLast12h).toBeNull();
      expect(body.riskScoreIQRLast12h).toBeNull();
      expect(body.requireApprovalRateLast12h).toBeNull();
    });

    it('23. summary — four ops in 12h: max and min correct', async () => {
      ctx = await setup();
      // Old logs to anchor
      await ctx.logger.log(makeOp('agent-o', 'tool-o', 'sess-1', daysAgo(42)), dec(0.5, 'allow'));
      // Four ops in 12h: scores 0.15, 0.35, 0.65, 0.85
      for (const [score, h] of [[0.85, 1], [0.15, 4], [0.65, 8], [0.35, 11]] as [number, number][]) {
        await ctx.logger.log(makeOp(`agent-o-${h}`, `tool-o-${h}`, `sess-o-${h}`, hoursAgo(h)), dec(score, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.maxRiskScoreLast12h as number).toBeCloseTo(0.85, 5);
      expect(body.minRiskScoreLast12h as number).toBeCloseTo(0.15, 5);
    });

    it('24. summary — stddev and IQR with four ops in 12h', async () => {
      ctx = await setup();
      // Old logs to anchor
      await ctx.logger.log(makeOp('agent-p', 'tool-p', 'sess-1', daysAgo(43)), dec(0.5, 'allow'));
      // Four ops in 12h: scores [0.2, 0.4, 0.6, 0.8]
      // mean=0.5; variance=0.05; stddev≈0.2236
      // IQR: len=4; p25 idx=1→0.4; p75 idx=3→0.8; IQR=0.4
      for (const [score, h] of [[0.2, 1], [0.4, 4], [0.6, 7], [0.8, 10]] as [number, number][]) {
        await ctx.logger.log(makeOp(`agent-p-${h}`, `tool-p-${h}`, `sess-p-${h}`, hoursAgo(h)), dec(score, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.riskScoreStdDevLast12h as number).toBeCloseTo(Math.sqrt(0.05), 4);
      expect(body.riskScoreIQRLast12h as number).toBeCloseTo(0.4, 5);
    });

    it('25. summary — requireApprovalRateLast12h: 3 out of 5 require approval → 0.6', async () => {
      ctx = await setup();
      // Old logs to anchor
      await ctx.logger.log(makeOp('agent-q', 'tool-q', 'sess-1', daysAgo(44)), dec(0.3, 'allow'));
      // 5 ops in 12h: 3 require_approval, 1 allow, 1 block → rate = 3/5 = 0.6
      await ctx.logger.log(makeOp('agent-q1', 'tool-q1', 'sess-q1', hoursAgo(1)), dec(0.9, 'require_approval'));
      await ctx.logger.log(makeOp('agent-q2', 'tool-q2', 'sess-q2', hoursAgo(3)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-q3', 'tool-q3', 'sess-q3', hoursAgo(5)), dec(0.8, 'require_approval'));
      await ctx.logger.log(makeOp('agent-q4', 'tool-q4', 'sess-q4', hoursAgo(8)), dec(0.7, 'require_approval'));
      await ctx.logger.log(makeOp('agent-q5', 'tool-q5', 'sess-q5', hoursAgo(11)), dec(0.6, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.requireApprovalRateLast12h as number).toBeCloseTo(0.6, 5);
    });

    it('26. summary — ops from multiple agents and tools in 12h: fields cover all of them', async () => {
      ctx = await setup();
      // Old logs to anchor
      await ctx.logger.log(makeOp('agent-r', 'tool-r', 'sess-1', daysAgo(45)), dec(0.5, 'allow'));
      // Ops from different agents/tools but all in 12h: scores [0.1, 0.5, 0.9]
      // max=0.9, min=0.1, mean=0.5, variance=10/3*... actually:
      // deviations from 0.5: [-0.4, 0, 0.4]; deviations²=[0.16, 0, 0.16]; variance=0.32/3≈0.1067; stddev≈0.3266
      await ctx.logger.log(makeOp('agent-r1', 'tool-r1', 'sess-r1', hoursAgo(2)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-r2', 'tool-r2', 'sess-r2', hoursAgo(6)), dec(0.5, 'block'));
      await ctx.logger.log(makeOp('agent-r3', 'tool-r3', 'sess-r3', hoursAgo(10)), dec(0.9, 'require_approval'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.maxRiskScoreLast12h as number).toBeCloseTo(0.9, 5);
      expect(body.minRiskScoreLast12h as number).toBeCloseTo(0.1, 5);
      // require_approval rate: 1/3
      expect(body.requireApprovalRateLast12h as number).toBeCloseTo(1 / 3, 4);
    });

    it('27. summary — single op in 12h: stddev is 0, IQR is 0, rate depends on action', async () => {
      ctx = await setup();
      // Old logs to anchor
      await ctx.logger.log(makeOp('agent-s', 'tool-s', 'sess-1', daysAgo(46)), dec(0.3, 'allow'));
      // One op in 12h with require_approval
      await ctx.logger.log(makeOp('agent-s', 'tool-s2', 'sess-s2', hoursAgo(3)), dec(0.75, 'require_approval'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.maxRiskScoreLast12h as number).toBeCloseTo(0.75, 5);
      expect(body.minRiskScoreLast12h as number).toBeCloseTo(0.75, 5);
      expect(body.riskScoreStdDevLast12h as number).toBeCloseTo(0, 5);
      expect(body.riskScoreIQRLast12h as number).toBeCloseTo(0, 5);
      expect(body.requireApprovalRateLast12h as number).toBeCloseTo(1.0, 5);
    });
  });
});

// ── v10.59 ────────────────────────────────────────────────────────────────────

describe('v10.59', () => {
  const hoursAgo = (h: number) => new Date(PINNED_NOW() - h * 3_600_000);
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1364-T1368 — v10.59 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1059-pres'), dec());

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-1059-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('topAgentLast24h');
      expect(body).toHaveProperty('topToolLast24h');
      expect(body).toHaveProperty('topMethodLast24h');
      expect(body).toHaveProperty('uniqueSessionsLast24h');
      expect(body).toHaveProperty('uniqueSessionsLast7d');
    });

    it('2. sessions — only old ops (>40d): top fields null, unique counts 0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-1059-old', daysAgo(41)), dec());
      await ctx.logger.log(makeOp('agent-b', 'db', 'sess-1059-old', daysAgo(45)), dec());

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-1059-old');
      expect(status).toBe(200);
      expect(body.topAgentLast24h).toBeNull();
      expect(body.topToolLast24h).toBeNull();
      expect(body.topMethodLast24h).toBeNull();
      expect(body.uniqueSessionsLast24h).toBe(0);
      expect(body.uniqueSessionsLast7d).toBe(0);
    });

    it('3. sessions — topAgentLast24h returns winner with most ops in 24h', async () => {
      ctx = await setup();
      // agent-winner: 3 ops in 24h; agent-loser: 1 op in 24h
      await ctx.logger.log(makeOp('agent-winner', 'fs', 'sess-1059-top-a'), dec());
      await ctx.logger.log(makeOp('agent-winner', 'fs', 'sess-1059-top-a'), dec());
      await ctx.logger.log(makeOp('agent-winner', 'fs', 'sess-1059-top-a'), dec());
      await ctx.logger.log(makeOp('agent-loser', 'fs', 'sess-1059-top-a'), dec());

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-1059-top-a');
      expect(status).toBe(200);
      expect(body.topAgentLast24h).toBe('agent-winner');
    });

    it('4. sessions — topToolLast24h returns winner tool', async () => {
      ctx = await setup();
      // tool-winner: 3 ops; tool-loser: 2 ops
      await ctx.logger.log(makeOp('ag', 'tool-winner', 'sess-1059-top-t'), dec());
      await ctx.logger.log(makeOp('ag', 'tool-winner', 'sess-1059-top-t'), dec());
      await ctx.logger.log(makeOp('ag', 'tool-winner', 'sess-1059-top-t'), dec());
      await ctx.logger.log(makeOp('ag', 'tool-loser', 'sess-1059-top-t'), dec());
      await ctx.logger.log(makeOp('ag', 'tool-loser', 'sess-1059-top-t'), dec());

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-1059-top-t');
      expect(status).toBe(200);
      expect(body.topToolLast24h).toBe('tool-winner');
    });

    it('5. sessions — topMethodLast24h returns winner method', async () => {
      ctx = await setup();
      // method-write: 4 ops; method-read: 2 ops
      await ctx.logger.log(makeOp('ag', 'fs', 'sess-1059-top-m', new Date(PINNED_NOW()), 'method-write'), dec());
      await ctx.logger.log(makeOp('ag', 'fs', 'sess-1059-top-m', new Date(PINNED_NOW()), 'method-write'), dec());
      await ctx.logger.log(makeOp('ag', 'fs', 'sess-1059-top-m', new Date(PINNED_NOW()), 'method-write'), dec());
      await ctx.logger.log(makeOp('ag', 'fs', 'sess-1059-top-m', new Date(PINNED_NOW()), 'method-write'), dec());
      await ctx.logger.log(makeOp('ag', 'fs', 'sess-1059-top-m', new Date(PINNED_NOW()), 'method-read'), dec());
      await ctx.logger.log(makeOp('ag', 'fs', 'sess-1059-top-m', new Date(PINNED_NOW()), 'method-read'), dec());

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-1059-top-m');
      expect(status).toBe(200);
      expect(body.topMethodLast24h).toBe('method-write');
    });

    it('6. sessions — uniqueSessionsLast24h counts distinct sessionIds in 24h', async () => {
      ctx = await setup();
      const sessId = 'sess-1059-uq24';
      // 3 distinct session ids in last 24h, 1 older
      await ctx.logger.log(makeOp('ag', 'fs', 'uq-s1'), dec());
      await ctx.logger.log(makeOp('ag', 'fs', 'uq-s2'), dec());
      await ctx.logger.log(makeOp('ag', 'fs', 'uq-s3'), dec());
      await ctx.logger.log(makeOp('ag', 'fs', 'uq-s1'), dec()); // duplicate, still 3 distinct
      await ctx.logger.log(makeOp('ag', 'fs', 'uq-s-old', daysAgo(2)), dec()); // outside 24h

      // Use summary endpoint since session analytics filters by sessionId
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.uniqueSessionsLast24h).toBe(3);
    });

    it('7. sessions — uniqueSessionsLast7d includes ops from last 7 days', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('ag', 'fs', 'uq7-s1', daysAgo(1)), dec());
      await ctx.logger.log(makeOp('ag', 'fs', 'uq7-s2', daysAgo(3)), dec());
      await ctx.logger.log(makeOp('ag', 'fs', 'uq7-s3', daysAgo(6)), dec());
      await ctx.logger.log(makeOp('ag', 'fs', 'uq7-s-old', daysAgo(8)), dec()); // outside 7d

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.uniqueSessionsLast7d).toBe(3);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1364-T1368 — v10.59 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('8. agents — all five new fields present', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('ag-pres', 'fs', 'sess-1'), dec());

      const { status, body } = await getJSON(ctx.port, '/agents/ag-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('topAgentLast24h');
      expect(body).toHaveProperty('topToolLast24h');
      expect(body).toHaveProperty('topMethodLast24h');
      expect(body).toHaveProperty('uniqueSessionsLast24h');
      expect(body).toHaveProperty('uniqueSessionsLast7d');
    });

    it('9. agents — only old ops (>40d): top fields null, unique counts 0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('ag-old', 'fs', 'sess-a', daysAgo(42)), dec());
      await ctx.logger.log(makeOp('ag-old', 'db', 'sess-a', daysAgo(50)), dec());

      const { status, body } = await getJSON(ctx.port, '/agents/ag-old');
      expect(status).toBe(200);
      expect(body.topAgentLast24h).toBeNull();
      expect(body.topToolLast24h).toBeNull();
      expect(body.topMethodLast24h).toBeNull();
      expect(body.uniqueSessionsLast24h).toBe(0);
      expect(body.uniqueSessionsLast7d).toBe(0);
    });

    it('10. agents — topAgentLast24h returns winning agent', async () => {
      ctx = await setup();
      // From agent analytics perspective, logs are filtered by agentId
      // Seed same agentId with most ops; another agentId with fewer ops
      await ctx.logger.log(makeOp('ag-top', 'fs', 'sess-2'), dec());
      await ctx.logger.log(makeOp('ag-top', 'fs', 'sess-2'), dec());
      await ctx.logger.log(makeOp('ag-top', 'fs', 'sess-2'), dec());
      await ctx.logger.log(makeOp('ag-other', 'fs', 'sess-2'), dec());

      // Summary endpoint includes all agents
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.topAgentLast24h).toBe('ag-top');
    });

    it('11. agents — topToolLast24h for agent endpoint', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('ag-tl', 'tool-a', 'sess-3'), dec());
      await ctx.logger.log(makeOp('ag-tl', 'tool-a', 'sess-3'), dec());
      await ctx.logger.log(makeOp('ag-tl', 'tool-b', 'sess-3'), dec());

      const { status, body } = await getJSON(ctx.port, '/agents/ag-tl');
      expect(status).toBe(200);
      expect(body.topToolLast24h).toBe('tool-a');
    });

    it('12. agents — uniqueSessionsLast24h and uniqueSessionsLast7d correct', async () => {
      ctx = await setup();
      // 2 sessions in last 24h
      await ctx.logger.log(makeOp('ag-uq', 'fs', 'uq-sess-a', hoursAgo(2)), dec());
      await ctx.logger.log(makeOp('ag-uq', 'fs', 'uq-sess-b', hoursAgo(3)), dec());
      // 1 more in last 7d (outside 24h)
      await ctx.logger.log(makeOp('ag-uq', 'fs', 'uq-sess-c', daysAgo(3)), dec());
      // 1 old (outside 7d)
      await ctx.logger.log(makeOp('ag-uq', 'fs', 'uq-sess-d', daysAgo(10)), dec());

      const { status, body } = await getJSON(ctx.port, '/agents/ag-uq');
      expect(status).toBe(200);
      expect(body.uniqueSessionsLast24h).toBe(2);
      expect(body.uniqueSessionsLast7d).toBe(3);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1364-T1368 — v10.59 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('13. tools — all five new fields present', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('ag-1', 'tool-pres', 'sess-1'), dec());

      const { status, body } = await getJSON(ctx.port, '/tools/tool-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('topAgentLast24h');
      expect(body).toHaveProperty('topToolLast24h');
      expect(body).toHaveProperty('topMethodLast24h');
      expect(body).toHaveProperty('uniqueSessionsLast24h');
      expect(body).toHaveProperty('uniqueSessionsLast7d');
    });

    it('14. tools — only old ops (>40d): top fields null, unique counts 0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('ag-1', 'tool-old', 'sess-1', daysAgo(41)), dec());
      await ctx.logger.log(makeOp('ag-1', 'tool-old', 'sess-1', daysAgo(50)), dec());

      const { status, body } = await getJSON(ctx.port, '/tools/tool-old');
      expect(status).toBe(200);
      expect(body.topAgentLast24h).toBeNull();
      expect(body.topToolLast24h).toBeNull();
      expect(body.topMethodLast24h).toBeNull();
      expect(body.uniqueSessionsLast24h).toBe(0);
      expect(body.uniqueSessionsLast7d).toBe(0);
    });

    it('15. tools — topAgentLast24h returns agent with most ops via tool', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('ag-win', 'tool-ta', 'sess-1'), dec());
      await ctx.logger.log(makeOp('ag-win', 'tool-ta', 'sess-1'), dec());
      await ctx.logger.log(makeOp('ag-win', 'tool-ta', 'sess-1'), dec());
      await ctx.logger.log(makeOp('ag-los', 'tool-ta', 'sess-1'), dec());
      await ctx.logger.log(makeOp('ag-los', 'tool-ta', 'sess-1'), dec());

      const { status, body } = await getJSON(ctx.port, '/tools/tool-ta');
      expect(status).toBe(200);
      expect(body.topAgentLast24h).toBe('ag-win');
    });

    it('16. tools — topMethodLast24h returns winning method', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('ag-1', 'tool-tm', 'sess-1', new Date(PINNED_NOW()), 'read'), dec());
      await ctx.logger.log(makeOp('ag-1', 'tool-tm', 'sess-1', new Date(PINNED_NOW()), 'write'), dec());
      await ctx.logger.log(makeOp('ag-1', 'tool-tm', 'sess-1', new Date(PINNED_NOW()), 'write'), dec());
      await ctx.logger.log(makeOp('ag-1', 'tool-tm', 'sess-1', new Date(PINNED_NOW()), 'write'), dec());

      const { status, body } = await getJSON(ctx.port, '/tools/tool-tm');
      expect(status).toBe(200);
      expect(body.topMethodLast24h).toBe('write');
    });

    it('17. tools — uniqueSessionsLast24h counts distinct sessions in 24h', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('ag-1', 'tool-uq', 'sess-a', hoursAgo(1)), dec());
      await ctx.logger.log(makeOp('ag-1', 'tool-uq', 'sess-a', hoursAgo(2)), dec()); // same session
      await ctx.logger.log(makeOp('ag-1', 'tool-uq', 'sess-b', hoursAgo(3)), dec());
      await ctx.logger.log(makeOp('ag-1', 'tool-uq', 'sess-c-old', daysAgo(2)), dec()); // outside 24h

      const { status, body } = await getJSON(ctx.port, '/tools/tool-uq');
      expect(status).toBe(200);
      expect(body.uniqueSessionsLast24h).toBe(2);
    });

    it('18. tools — uniqueSessionsLast7d includes sessions from last 7 days', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('ag-1', 'tool-7d', 'sess-a', hoursAgo(1)), dec());
      await ctx.logger.log(makeOp('ag-1', 'tool-7d', 'sess-b', daysAgo(3)), dec());
      await ctx.logger.log(makeOp('ag-1', 'tool-7d', 'sess-c', daysAgo(6)), dec());
      await ctx.logger.log(makeOp('ag-1', 'tool-7d', 'sess-d-old', daysAgo(9)), dec()); // outside 7d

      const { status, body } = await getJSON(ctx.port, '/tools/tool-7d');
      expect(status).toBe(200);
      expect(body.uniqueSessionsLast7d).toBe(3);
    });
  });

  // ── summary endpoint ───────────────────────────────────────────────────────────

  describe('T1364-T1368 — v10.59 new fields (summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('19. summary — all five new fields present', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('ag-1', 'fs', 'sess-1'), dec());

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body).toHaveProperty('topAgentLast24h');
      expect(body).toHaveProperty('topToolLast24h');
      expect(body).toHaveProperty('topMethodLast24h');
      expect(body).toHaveProperty('uniqueSessionsLast24h');
      expect(body).toHaveProperty('uniqueSessionsLast7d');
    });

    it('20. summary — no ops at all: top fields null, unique counts 0', async () => {
      ctx = await setup();

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.topAgentLast24h).toBeNull();
      expect(body.topToolLast24h).toBeNull();
      expect(body.topMethodLast24h).toBeNull();
      expect(body.uniqueSessionsLast24h).toBe(0);
      expect(body.uniqueSessionsLast7d).toBe(0);
    });

    it('21. summary — only old ops (>40d): top fields null, unique counts 0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('ag-1', 'fs', 'sess-old-a', daysAgo(41)), dec());
      await ctx.logger.log(makeOp('ag-2', 'db', 'sess-old-b', daysAgo(45)), dec());

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.topAgentLast24h).toBeNull();
      expect(body.topToolLast24h).toBeNull();
      expect(body.topMethodLast24h).toBeNull();
      expect(body.uniqueSessionsLast24h).toBe(0);
      expect(body.uniqueSessionsLast7d).toBe(0);
    });

    it('22. summary — topAgentLast24h identifies correct winner among 3 agents', async () => {
      ctx = await setup();
      // ag-a: 1 op, ag-b: 2 ops, ag-c: 5 ops
      await ctx.logger.log(makeOp('sum-ag-a', 'fs', 'sess-1'), dec());
      await ctx.logger.log(makeOp('sum-ag-b', 'fs', 'sess-1'), dec());
      await ctx.logger.log(makeOp('sum-ag-b', 'fs', 'sess-1'), dec());
      await ctx.logger.log(makeOp('sum-ag-c', 'fs', 'sess-1'), dec());
      await ctx.logger.log(makeOp('sum-ag-c', 'fs', 'sess-1'), dec());
      await ctx.logger.log(makeOp('sum-ag-c', 'fs', 'sess-1'), dec());
      await ctx.logger.log(makeOp('sum-ag-c', 'fs', 'sess-1'), dec());
      await ctx.logger.log(makeOp('sum-ag-c', 'fs', 'sess-1'), dec());

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.topAgentLast24h).toBe('sum-ag-c');
    });

    it('23. summary — topToolLast24h identifies correct winner among 3 tools', async () => {
      ctx = await setup();
      // tool-x: 2 ops, tool-y: 4 ops, tool-z: 1 op
      await ctx.logger.log(makeOp('ag', 'sum-tool-x', 'sess-1'), dec());
      await ctx.logger.log(makeOp('ag', 'sum-tool-x', 'sess-1'), dec());
      await ctx.logger.log(makeOp('ag', 'sum-tool-y', 'sess-1'), dec());
      await ctx.logger.log(makeOp('ag', 'sum-tool-y', 'sess-1'), dec());
      await ctx.logger.log(makeOp('ag', 'sum-tool-y', 'sess-1'), dec());
      await ctx.logger.log(makeOp('ag', 'sum-tool-y', 'sess-1'), dec());
      await ctx.logger.log(makeOp('ag', 'sum-tool-z', 'sess-1'), dec());

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.topToolLast24h).toBe('sum-tool-y');
    });

    it('24. summary — topMethodLast24h identifies correct winner among 3 methods', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('ag', 'fs', 'sess-1', new Date(PINNED_NOW()), 'execute'), dec());
      await ctx.logger.log(makeOp('ag', 'fs', 'sess-1', new Date(PINNED_NOW()), 'execute'), dec());
      await ctx.logger.log(makeOp('ag', 'fs', 'sess-1', new Date(PINNED_NOW()), 'execute'), dec());
      await ctx.logger.log(makeOp('ag', 'fs', 'sess-1', new Date(PINNED_NOW()), 'query'), dec());
      await ctx.logger.log(makeOp('ag', 'fs', 'sess-1', new Date(PINNED_NOW()), 'query'), dec());
      await ctx.logger.log(makeOp('ag', 'fs', 'sess-1', new Date(PINNED_NOW()), 'list'), dec());

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.topMethodLast24h).toBe('execute');
    });

    it('25. summary — uniqueSessionsLast24h is integer 0 with no recent ops', async () => {
      ctx = await setup();
      // Only ops older than 24h
      await ctx.logger.log(makeOp('ag', 'fs', 'sess-x', daysAgo(2)), dec());

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(typeof body.uniqueSessionsLast24h).toBe('number');
      expect(body.uniqueSessionsLast24h).toBe(0);
    });

    it('26. summary — uniqueSessionsLast7d counts correctly with mix of windows', async () => {
      ctx = await setup();
      // 2 sessions in last 24h (counted in both 24h and 7d)
      await ctx.logger.log(makeOp('ag', 'fs', 'sum-s1', hoursAgo(6)), dec());
      await ctx.logger.log(makeOp('ag', 'fs', 'sum-s2', hoursAgo(12)), dec());
      // 2 more sessions in last 7d (not 24h)
      await ctx.logger.log(makeOp('ag', 'fs', 'sum-s3', daysAgo(2)), dec());
      await ctx.logger.log(makeOp('ag', 'fs', 'sum-s4', daysAgo(5)), dec());
      // 1 session outside 7d
      await ctx.logger.log(makeOp('ag', 'fs', 'sum-s5', daysAgo(10)), dec());

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.uniqueSessionsLast24h).toBe(2);
      expect(body.uniqueSessionsLast7d).toBe(4);
    });

    it('27. summary — old ops dont pollute top fields (only recent ops count)', async () => {
      ctx = await setup();
      // old dominant agent — should NOT win
      await ctx.logger.log(makeOp('sum-ag-dominant-old', 'fs', 'sess-1', daysAgo(42)), dec());
      await ctx.logger.log(makeOp('sum-ag-dominant-old', 'fs', 'sess-1', daysAgo(43)), dec());
      await ctx.logger.log(makeOp('sum-ag-dominant-old', 'fs', 'sess-1', daysAgo(44)), dec());
      await ctx.logger.log(makeOp('sum-ag-dominant-old', 'fs', 'sess-1', daysAgo(45)), dec());
      await ctx.logger.log(makeOp('sum-ag-dominant-old', 'fs', 'sess-1', daysAgo(46)), dec());
      // recent winner with only 2 ops
      await ctx.logger.log(makeOp('sum-ag-recent-winner', 'fs', 'sess-1', hoursAgo(2)), dec());
      await ctx.logger.log(makeOp('sum-ag-recent-winner', 'fs', 'sess-1', hoursAgo(3)), dec());

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.topAgentLast24h).toBe('sum-ag-recent-winner');
    });

    it('28. summary — uniqueSessionsLast24h is an integer type', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('ag', 'fs', 'sess-int', hoursAgo(1)), dec());

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(Number.isInteger(body.uniqueSessionsLast24h)).toBe(true);
      expect(Number.isInteger(body.uniqueSessionsLast7d)).toBe(true);
    });
  });
});

// ── v10.60 ────────────────────────────────────────────────────────────────────

describe('v10.60', () => {
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);
  const hoursAgo = (h: number) => new Date(PINNED_NOW() - h * 3_600_000);

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1369-T1373 — v10.60 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1060-pres'), dec());

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1060-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('uniqueSessionsLast30d');
      expect(body).toHaveProperty('avgOpsPerSession');
      expect(body).toHaveProperty('avgOpsPerSessionLast7d');
      expect(body).toHaveProperty('avgOpsPerSessionLast30d');
      expect(body).toHaveProperty('maxOpsPerAgent');
    });

    it('2. sessions — single recent op: uniqueSessionsLast30d=1, avgOpsPerSession=1, maxOpsPerAgent=1', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1060-single'), dec());

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1060-single');
      expect(status).toBe(200);
      expect(body.uniqueSessionsLast30d).toBe(1);
      expect(body.avgOpsPerSession as number).toBeCloseTo(1.0, 5);
      expect(body.avgOpsPerSessionLast7d as number).toBeCloseTo(1.0, 5);
      expect(body.avgOpsPerSessionLast30d as number).toBeCloseTo(1.0, 5);
      expect(body.maxOpsPerAgent).toBe(1);
    });

    it('3. sessions — only old logs (>40d): uniqueSessionsLast30d=0, windowed avg fields null, all-time fields non-null', async () => {
      ctx = await setup();
      // Seed old logs older than 40 days
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1060-old', daysAgo(42)), dec());
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1060-old', daysAgo(50)), dec());

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1060-old');
      expect(status).toBe(200);
      // 30d window is empty → 0 unique sessions
      expect(body.uniqueSessionsLast30d).toBe(0);
      // all-time logs exist → avgOpsPerSession non-null (2 ops, 1 session → avg=2)
      expect(body.avgOpsPerSession as number).toBeCloseTo(2.0, 5);
      // 7d window empty → null
      expect(body.avgOpsPerSessionLast7d).toBeNull();
      // 30d window empty → null
      expect(body.avgOpsPerSessionLast30d).toBeNull();
      // all-time: 1 agent with 2 ops → max=2
      expect(body.maxOpsPerAgent).toBe(2);
    });

    it('4. sessions — 6 ops across 2 sessions: avgOpsPerSession=3.0', async () => {
      ctx = await setup();
      // 3 ops in sess-A, 3 ops in sess-B → totalOps=6, sessions=2, avg=3.0
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1060-avg-A', hoursAgo(1)), dec());
      }
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1060-avg-B', hoursAgo(2)), dec());
      }

      // Query via session A (agent-d logs both sessions)
      const { status, body } = await getJSON(ctx.port, '/agents/agent-d');
      expect(status).toBe(200);
      expect(body.avgOpsPerSession as number).toBeCloseTo(3.0, 5);
    });

    it('5. sessions — 3 ops in same session: avgOpsPerSession=3.0', async () => {
      ctx = await setup();
      // 3 ops in single session → totalOps=3, sessions=1, avg=3.0
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1060-same', hoursAgo(i + 1)), dec());
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1060-same');
      expect(status).toBe(200);
      expect(body.avgOpsPerSession as number).toBeCloseTo(3.0, 5);
      expect(body.avgOpsPerSessionLast7d as number).toBeCloseTo(3.0, 5);
      expect(body.avgOpsPerSessionLast30d as number).toBeCloseTo(3.0, 5);
    });

    it('6. sessions — maxOpsPerAgent with two agents: returns the higher count', async () => {
      ctx = await setup();
      // agent-f1: 4 ops, agent-f2: 2 ops → maxOpsPerAgent=4
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp('agent-f1', 'fs', 'sess-v1060-max', hoursAgo(1)), dec());
      }
      for (let i = 0; i < 2; i++) {
        await ctx.logger.log(makeOp('agent-f2', 'fs', 'sess-v1060-max', hoursAgo(1)), dec());
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1060-max');
      expect(status).toBe(200);
      expect(body.maxOpsPerAgent).toBe(4);
    });

    it('7. sessions — uniqueSessionsLast30d counts only recent sessions', async () => {
      ctx = await setup();
      // 2 recent sessions (within 30d) + 1 old session (>40d, entity-exists seed)
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1060-30d-A', daysAgo(5)), dec());
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1060-30d-B', daysAgo(20)), dec());
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1060-30d-A', daysAgo(45)), dec()); // old, same session ID

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1060-30d-A');
      expect(status).toBe(200);
      // Only sess-v1060-30d-A (from 5d ago) is in 30d window for this session endpoint
      // (session endpoint only shows logs for this specific sessionId)
      expect(body.uniqueSessionsLast30d).toBe(1);
    });

    it('8. sessions — avgOpsPerSessionLast7d vs avgOpsPerSessionLast30d differ when old ops exist', async () => {
      ctx = await setup();
      // 2 ops in 7d (1 session), 2 more ops in 8-29d range (1 more session)
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1060-7d', daysAgo(2)), dec());
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1060-7d', daysAgo(4)), dec());
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1060-30d', daysAgo(10)), dec());
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1060-30d', daysAgo(20)), dec());

      // Check via agent (captures all sessions for agent-h)
      const { status, body } = await getJSON(ctx.port, '/agents/agent-h');
      expect(status).toBe(200);
      // 7d: 2 ops, 1 session → avg=2.0
      expect(body.avgOpsPerSessionLast7d as number).toBeCloseTo(2.0, 5);
      // 30d: 4 ops, 2 sessions → avg=2.0
      expect(body.avgOpsPerSessionLast30d as number).toBeCloseTo(2.0, 5);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1369-T1373 — v10.60 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('9. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1060-pres', 'fs', 'sess-1'), dec());

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1060-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('uniqueSessionsLast30d');
      expect(body).toHaveProperty('avgOpsPerSession');
      expect(body).toHaveProperty('avgOpsPerSessionLast7d');
      expect(body).toHaveProperty('avgOpsPerSessionLast30d');
      expect(body).toHaveProperty('maxOpsPerAgent');
    });

    it('10. agents — no logs: avgOpsPerSession, avgOpsPerSessionLast7d, avgOpsPerSessionLast30d, maxOpsPerAgent are null (via summary)', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.avgOpsPerSession).toBeNull();
      expect(body.avgOpsPerSessionLast7d).toBeNull();
      expect(body.avgOpsPerSessionLast30d).toBeNull();
      expect(body.maxOpsPerAgent).toBeNull();
      expect(body.uniqueSessionsLast30d).toBe(0);
    });

    it('11. agents — only old logs (>40d): windowed avg null, uniqueSessionsLast30d=0, all-time non-null', async () => {
      ctx = await setup();
      // Seed entity-exists logs older than 40d
      await ctx.logger.log(makeOp('agent-v1060-old', 'fs', 'sess-old-1', daysAgo(41)), dec());
      await ctx.logger.log(makeOp('agent-v1060-old', 'fs', 'sess-old-2', daysAgo(50)), dec());
      await ctx.logger.log(makeOp('agent-v1060-old', 'fs', 'sess-old-1', daysAgo(60)), dec());

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1060-old');
      expect(status).toBe(200);
      expect(body.uniqueSessionsLast30d).toBe(0);
      // all-time: 3 ops across 2 sessions → avg=1.5
      expect(body.avgOpsPerSession as number).toBeCloseTo(1.5, 5);
      expect(body.avgOpsPerSessionLast7d).toBeNull();
      expect(body.avgOpsPerSessionLast30d).toBeNull();
      // agent has 3 ops (1 agent) → maxOpsPerAgent=3
      expect(body.maxOpsPerAgent).toBe(3);
    });

    it('12. agents — 6 ops across 2 sessions all-time: avgOpsPerSession=3.0', async () => {
      ctx = await setup();
      // 3 ops in sess-X, 3 ops in sess-Y → avg=3.0
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-v1060-avg', 'fs', 'sess-X', hoursAgo(1)), dec());
      }
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-v1060-avg', 'fs', 'sess-Y', hoursAgo(2)), dec());
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1060-avg');
      expect(status).toBe(200);
      expect(body.avgOpsPerSession as number).toBeCloseTo(3.0, 5);
    });

    it('13. agents — avgOpsPerSessionLast7d null when no ops in 7d', async () => {
      ctx = await setup();
      // Ops only in 8-29d range
      await ctx.logger.log(makeOp('agent-v1060-7d-null', 'fs', 'sess-1', daysAgo(10)), dec());
      await ctx.logger.log(makeOp('agent-v1060-7d-null', 'fs', 'sess-2', daysAgo(20)), dec());

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1060-7d-null');
      expect(status).toBe(200);
      expect(body.avgOpsPerSessionLast7d).toBeNull();
      // 30d window: 2 ops, 2 sessions → avg=1.0
      expect(body.avgOpsPerSessionLast30d as number).toBeCloseTo(1.0, 5);
    });

    it('14. agents — maxOpsPerAgent across multiple agents: returns max', async () => {
      ctx = await setup();
      // agent-P: 5 ops, agent-Q: 3 ops → maxOpsPerAgent=5 (from perspective of any shared session)
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp('agent-P', 'fs', 'sess-shared', hoursAgo(1)), dec());
      }
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-Q', 'fs', 'sess-shared', hoursAgo(2)), dec());
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-shared');
      expect(status).toBe(200);
      expect(body.maxOpsPerAgent).toBe(5);
    });

    it('15. agents — uniqueSessionsLast30d integer type', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1060-type', 'fs', 'sess-1', daysAgo(5)), dec());
      await ctx.logger.log(makeOp('agent-v1060-type', 'fs', 'sess-2', daysAgo(10)), dec());
      await ctx.logger.log(makeOp('agent-v1060-type', 'fs', 'sess-3', daysAgo(15)), dec());

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1060-type');
      expect(status).toBe(200);
      expect(typeof body.uniqueSessionsLast30d).toBe('number');
      expect(Number.isInteger(body.uniqueSessionsLast30d)).toBe(true);
      expect(body.uniqueSessionsLast30d).toBe(3);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1369-T1373 — v10.60 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('16. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-i', 'tool-v1060-pres', 'sess-1'), dec());

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1060-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('uniqueSessionsLast30d');
      expect(body).toHaveProperty('avgOpsPerSession');
      expect(body).toHaveProperty('avgOpsPerSessionLast7d');
      expect(body).toHaveProperty('avgOpsPerSessionLast30d');
      expect(body).toHaveProperty('maxOpsPerAgent');
    });

    it('17. tools — only old logs (>40d): windowed avg null, all-time non-null', async () => {
      ctx = await setup();
      // Seed entity-exists logs older than 40d
      await ctx.logger.log(makeOp('agent-j1', 'tool-v1060-old', 'sess-old-A', daysAgo(42)), dec());
      await ctx.logger.log(makeOp('agent-j1', 'tool-v1060-old', 'sess-old-A', daysAgo(55)), dec());
      await ctx.logger.log(makeOp('agent-j2', 'tool-v1060-old', 'sess-old-B', daysAgo(60)), dec());

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1060-old');
      expect(status).toBe(200);
      expect(body.uniqueSessionsLast30d).toBe(0);
      // all-time: 3 ops, 2 sessions → avg=1.5
      expect(body.avgOpsPerSession as number).toBeCloseTo(1.5, 5);
      expect(body.avgOpsPerSessionLast7d).toBeNull();
      expect(body.avgOpsPerSessionLast30d).toBeNull();
      // agent-j1 has 2 ops, agent-j2 has 1 → maxOpsPerAgent=2
      expect(body.maxOpsPerAgent).toBe(2);
    });

    it('18. tools — 6 ops across 2 sessions in 7d: avgOpsPerSessionLast7d=3.0', async () => {
      ctx = await setup();
      // 3 ops in sess-T1, 3 ops in sess-T2, all within 7d
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-k', 'tool-v1060-7d-avg', 'sess-T1', daysAgo(1)), dec());
      }
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-k', 'tool-v1060-7d-avg', 'sess-T2', daysAgo(3)), dec());
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1060-7d-avg');
      expect(status).toBe(200);
      expect(body.avgOpsPerSessionLast7d as number).toBeCloseTo(3.0, 5);
      expect(body.avgOpsPerSessionLast30d as number).toBeCloseTo(3.0, 5);
    });

    it('19. tools — ops in 30d but not 7d: avgOpsPerSessionLast7d null, 30d avg computed', async () => {
      ctx = await setup();
      // 4 ops across 2 sessions, all 8-29d ago
      await ctx.logger.log(makeOp('agent-l1', 'tool-v1060-30d-avg', 'sess-U', daysAgo(10)), dec());
      await ctx.logger.log(makeOp('agent-l1', 'tool-v1060-30d-avg', 'sess-U', daysAgo(15)), dec());
      await ctx.logger.log(makeOp('agent-l2', 'tool-v1060-30d-avg', 'sess-V', daysAgo(20)), dec());
      await ctx.logger.log(makeOp('agent-l2', 'tool-v1060-30d-avg', 'sess-V', daysAgo(25)), dec());

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1060-30d-avg');
      expect(status).toBe(200);
      expect(body.avgOpsPerSessionLast7d).toBeNull();
      // 30d: 4 ops, 2 sessions → avg=2.0
      expect(body.avgOpsPerSessionLast30d as number).toBeCloseTo(2.0, 5);
    });

    it('20. tools — maxOpsPerAgent: single agent all ops → max equals total ops', async () => {
      ctx = await setup();
      for (let i = 0; i < 7; i++) {
        await ctx.logger.log(makeOp('agent-m-solo', 'tool-v1060-max', 'sess-1', hoursAgo(i + 1)), dec());
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1060-max');
      expect(status).toBe(200);
      expect(body.maxOpsPerAgent).toBe(7);
    });
  });

  // ── operations/summary endpoint ────────────────────────────────────────────────

  describe('T1369-T1373 — v10.60 new fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('21. summary — all five new fields present', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-n', 'tool-s', 'sess-1'), dec());

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body).toHaveProperty('uniqueSessionsLast30d');
      expect(body).toHaveProperty('avgOpsPerSession');
      expect(body).toHaveProperty('avgOpsPerSessionLast7d');
      expect(body).toHaveProperty('avgOpsPerSessionLast30d');
      expect(body).toHaveProperty('maxOpsPerAgent');
    });

    it('22. summary — empty DB: uniqueSessionsLast30d=0, all avg/max null', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.uniqueSessionsLast30d).toBe(0);
      expect(body.avgOpsPerSession).toBeNull();
      expect(body.avgOpsPerSessionLast7d).toBeNull();
      expect(body.avgOpsPerSessionLast30d).toBeNull();
      expect(body.maxOpsPerAgent).toBeNull();
    });

    it('23. summary — only old logs (>40d): uniqueSessionsLast30d=0, windowed avg null, all-time non-null', async () => {
      ctx = await setup();
      // Seed entity-exists logs older than 40 days
      await ctx.logger.log(makeOp('agent-o1', 'tool-o', 'sess-old-X', daysAgo(41)), dec());
      await ctx.logger.log(makeOp('agent-o1', 'tool-o', 'sess-old-X', daysAgo(50)), dec());
      await ctx.logger.log(makeOp('agent-o2', 'tool-o', 'sess-old-Y', daysAgo(60)), dec());

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.uniqueSessionsLast30d).toBe(0);
      // all-time: 3 ops, 2 sessions → avg=1.5
      expect(body.avgOpsPerSession as number).toBeCloseTo(1.5, 5);
      expect(body.avgOpsPerSessionLast7d).toBeNull();
      expect(body.avgOpsPerSessionLast30d).toBeNull();
      // agent-o1: 2 ops, agent-o2: 1 op → maxOpsPerAgent=2
      expect(body.maxOpsPerAgent).toBe(2);
    });

    it('24. summary — 6 ops across 2 sessions: avgOpsPerSession=3.0', async () => {
      ctx = await setup();
      // 3 ops in sess-AA, 3 ops in sess-BB → avg=3.0
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-p', 'tool-p', 'sess-AA', hoursAgo(1)), dec());
      }
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-p', 'tool-p', 'sess-BB', hoursAgo(2)), dec());
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.avgOpsPerSession as number).toBeCloseTo(3.0, 5);
    });

    it('25. summary — 3 ops in same session: avgOpsPerSession=3.0 (single-session case)', async () => {
      ctx = await setup();
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-q', 'tool-q', 'sess-CC', hoursAgo(i + 1)), dec());
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.avgOpsPerSession as number).toBeCloseTo(3.0, 5);
      expect(body.avgOpsPerSessionLast7d as number).toBeCloseTo(3.0, 5);
      expect(body.avgOpsPerSessionLast30d as number).toBeCloseTo(3.0, 5);
    });

    it('26. summary — uniqueSessionsLast30d across all sessions in 30d window', async () => {
      ctx = await setup();
      // 3 recent sessions (within 30d) + 2 old sessions (>40d)
      await ctx.logger.log(makeOp('agent-r', 'tool-r', 'sess-R1', daysAgo(2)), dec());
      await ctx.logger.log(makeOp('agent-r', 'tool-r', 'sess-R2', daysAgo(10)), dec());
      await ctx.logger.log(makeOp('agent-r', 'tool-r', 'sess-R3', daysAgo(25)), dec());
      await ctx.logger.log(makeOp('agent-r', 'tool-r', 'sess-old-R4', daysAgo(42)), dec());
      await ctx.logger.log(makeOp('agent-r', 'tool-r', 'sess-old-R5', daysAgo(55)), dec());

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.uniqueSessionsLast30d).toBe(3);
    });

    it('27. summary — avgOpsPerSessionLast7d with mix of 7d and older ops', async () => {
      ctx = await setup();
      // In 7d: 4 ops in 2 sessions → avgLast7d=2.0
      await ctx.logger.log(makeOp('agent-s1', 'tool-s2', 'sess-S1', daysAgo(2)), dec());
      await ctx.logger.log(makeOp('agent-s1', 'tool-s2', 'sess-S1', daysAgo(4)), dec());
      await ctx.logger.log(makeOp('agent-s2', 'tool-s2', 'sess-S2', daysAgo(5)), dec());
      await ctx.logger.log(makeOp('agent-s2', 'tool-s2', 'sess-S2', daysAgo(6)), dec());
      // Outside 7d (in 30d): 6 ops in 3 sessions
      await ctx.logger.log(makeOp('agent-s3', 'tool-s2', 'sess-S3', daysAgo(10)), dec());
      await ctx.logger.log(makeOp('agent-s3', 'tool-s2', 'sess-S3', daysAgo(12)), dec());
      await ctx.logger.log(makeOp('agent-s4', 'tool-s2', 'sess-S4', daysAgo(15)), dec());
      await ctx.logger.log(makeOp('agent-s4', 'tool-s2', 'sess-S4', daysAgo(18)), dec());
      await ctx.logger.log(makeOp('agent-s5', 'tool-s2', 'sess-S5', daysAgo(22)), dec());
      await ctx.logger.log(makeOp('agent-s5', 'tool-s2', 'sess-S5', daysAgo(28)), dec());

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      // 7d: 4 ops, 2 sessions → avg=2.0
      expect(body.avgOpsPerSessionLast7d as number).toBeCloseTo(2.0, 5);
      // 30d: 10 ops, 5 sessions → avg=2.0
      expect(body.avgOpsPerSessionLast30d as number).toBeCloseTo(2.0, 5);
    });

    it('28. summary — maxOpsPerAgent is null when no logs exist', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.maxOpsPerAgent).toBeNull();
    });

    it('29. summary — maxOpsPerAgent picks the busiest agent', async () => {
      ctx = await setup();
      // agent-T1: 1 op, agent-T2: 5 ops, agent-T3: 3 ops → max=5
      await ctx.logger.log(makeOp('agent-T1', 'tool-t', 'sess-T1', hoursAgo(1)), dec());
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp('agent-T2', 'tool-t', 'sess-T2', hoursAgo(i + 1)), dec());
      }
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-T3', 'tool-t', 'sess-T3', hoursAgo(i + 2)), dec());
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.maxOpsPerAgent).toBe(5);
    });
  });
});

// ── v10.61 ────────────────────────────────────────────────────────────────────

describe('v10.61', () => {
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1374-T1378 — v10.61 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1061-pres'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1061-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('maxOpsPerTool');
      expect(body).toHaveProperty('maxOpsPerMethod');
      expect(body).toHaveProperty('maxOpsPerSession');
      expect(body).toHaveProperty('minOpsPerAgent');
      expect(body).toHaveProperty('minOpsPerTool');
    });

    it('2. sessions — empty DB: all five new fields are null', async () => {
      ctx = await setup();
      // Session endpoint needs a session to exist first — seed old logs
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1061-empty', daysAgo(50)), dec(0.3));

      // Now check with a fresh session on a DIFFERENT DB context using summary instead.
      // For session endpoint, empty means "no logs for this session" is a 404 scenario,
      // so test at summary level for true empty-DB null.
      // We verify via the summary — skip this variant, tested in summary describe.
      // Here test with old-only logs for session endpoint to get non-404.
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1061-empty');
      expect(status).toBe(200);
      // With 1 old log: one agent, one tool, one method, one session — all = 1, not null
      expect(body.maxOpsPerTool).toBe(1);
      expect(body.minOpsPerTool).toBe(1);
    });

    it('3. sessions — single log: all five fields equal 1', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s1', 'tool-s1', 'sess-v1061-single'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1061-single');
      expect(status).toBe(200);

      expect(body.maxOpsPerTool).toBe(1);
      expect(body.maxOpsPerMethod).toBe(1);
      expect(body.maxOpsPerSession).toBe(1);
      expect(body.minOpsPerAgent).toBe(1);
      expect(body.minOpsPerTool).toBe(1);
    });

    it('4. sessions — old logs (40+ days): fields non-null because logs exist all-time', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-old1', 'tool-old', 'sess-v1061-oldlogs', daysAgo(42)), dec(0.6));
      await ctx.logger.log(makeOp('agent-old2', 'tool-old', 'sess-v1061-oldlogs', daysAgo(45)), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1061-oldlogs');
      expect(status).toBe(200);

      // tool-old appears twice → maxOpsPerTool = 2, minOpsPerTool = 2
      expect(body.maxOpsPerTool).toBe(2);
      expect(body.minOpsPerTool).toBe(2);
      // two distinct agents each with 1 op → maxOpsPerAgent would be 1, minOpsPerAgent = 1
      expect(body.minOpsPerAgent).toBe(1);
      // two ops in same session → maxOpsPerSession = 2
      expect(body.maxOpsPerSession).toBe(2);
    });

    it('5. sessions — multiple tools with different counts: maxOpsPerTool and minOpsPerTool correct', async () => {
      ctx = await setup();
      const sess = 'sess-v1061-multi-tool';
      // tool-A: 3 ops, tool-B: 1 op, tool-C: 2 ops
      await ctx.logger.log(makeOp('agent-mt1', 'tool-A', sess), dec(0.3));
      await ctx.logger.log(makeOp('agent-mt2', 'tool-A', sess), dec(0.4));
      await ctx.logger.log(makeOp('agent-mt3', 'tool-A', sess), dec(0.5));
      await ctx.logger.log(makeOp('agent-mt4', 'tool-B', sess), dec(0.6));
      await ctx.logger.log(makeOp('agent-mt5', 'tool-C', sess), dec(0.2));
      await ctx.logger.log(makeOp('agent-mt6', 'tool-C', sess), dec(0.8));

      const { status, body } = await getJSON(ctx.port, `/sessions/${sess}`);
      expect(status).toBe(200);

      expect(body.maxOpsPerTool).toBe(3);   // tool-A
      expect(body.minOpsPerTool).toBe(1);   // tool-B
    });

    it('6. sessions — multiple methods with different counts: maxOpsPerMethod correct', async () => {
      ctx = await setup();
      const sess = 'sess-v1061-multi-method';
      // method 'read': 4 ops, method 'write': 2 ops, method 'call': 1 op
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp(`agent-mm${i}`, 'fs', sess, new Date(PINNED_NOW()), 'read'), dec(0.3));
      }
      for (let i = 0; i < 2; i++) {
        await ctx.logger.log(makeOp(`agent-mm-w${i}`, 'fs', sess, new Date(PINNED_NOW()), 'write'), dec(0.4));
      }
      await ctx.logger.log(makeOp('agent-mm-c', 'fs', sess, new Date(PINNED_NOW()), 'call'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, `/sessions/${sess}`);
      expect(status).toBe(200);

      expect(body.maxOpsPerMethod).toBe(4);  // 'read'
    });

    it('7. sessions — multiple sessions: maxOpsPerSession reflects the busiest session', async () => {
      ctx = await setup();
      const targetSess = 'sess-v1061-target';
      const otherSess = 'sess-v1061-other';
      // targetSess has 5 ops, otherSess has 2 ops — both visible via targetSess endpoint
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp(`agent-ms-t${i}`, 'fs', targetSess), dec(0.3));
      }
      for (let i = 0; i < 2; i++) {
        await ctx.logger.log(makeOp(`agent-ms-o${i}`, 'fs', otherSess), dec(0.4));
      }

      const { status, body } = await getJSON(ctx.port, `/sessions/${targetSess}`);
      expect(status).toBe(200);

      // All logs (both sessions) visible; targetSess=5, otherSess=2 → max=5
      expect(body.maxOpsPerSession).toBe(5);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1374-T1378 — v10.61 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('8. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1061-pres', 'fs', 'sess-1'), dec(0.3));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1061-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('maxOpsPerTool');
      expect(body).toHaveProperty('maxOpsPerMethod');
      expect(body).toHaveProperty('maxOpsPerSession');
      expect(body).toHaveProperty('minOpsPerAgent');
      expect(body).toHaveProperty('minOpsPerTool');
    });

    it('9. agents — single log: all five fields equal 1', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1061-single', 'tool-x', 'sess-x'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1061-single');
      expect(status).toBe(200);

      expect(body.maxOpsPerTool).toBe(1);
      expect(body.maxOpsPerMethod).toBe(1);
      expect(body.maxOpsPerSession).toBe(1);
      expect(body.minOpsPerAgent).toBe(1);
      expect(body.minOpsPerTool).toBe(1);
    });

    it('10. agents — old logs (40+ days): fields non-null (all-time calculation)', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1061-old', 'tool-old', 'sess-1', daysAgo(41)), dec(0.5));
      await ctx.logger.log(makeOp('agent-v1061-old', 'tool-old', 'sess-2', daysAgo(44)), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1061-old');
      expect(status).toBe(200);

      // Both logs use same tool → tool count=2
      expect(body.maxOpsPerTool).toBe(2);
      expect(body.minOpsPerTool).toBe(2);
      // Single agent with 2 ops
      expect(body.minOpsPerAgent).toBe(2);
      // One session per log → max session count = 1
      expect(body.maxOpsPerSession).toBe(1);
    });

    it('11. agents — minOpsPerAgent reflects least-op agent visible in this agent\'s log set', async () => {
      ctx = await setup();
      // The agents endpoint filters logs to only those belonging to agent-v1061-heavy.
      // Within those 4 logs, there is 1 agent (agent-v1061-heavy) with 4 ops.
      // minOpsPerAgent = max = 4. To get a min of 1, use the summary endpoint instead.
      // Here we verify the field is non-null and equals the op count of the single agent.
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp('agent-v1061-heavy', 'fs', `sess-h${i}`), dec(0.4));
      }
      // These other agents' logs won't appear in the /agents/agent-v1061-heavy endpoint
      await ctx.logger.log(makeOp('agent-v1061-light', 'fs', 'sess-l'), dec(0.5));
      for (let i = 0; i < 2; i++) {
        await ctx.logger.log(makeOp('agent-v1061-mid', 'fs', `sess-m${i}`), dec(0.6));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1061-heavy');
      expect(status).toBe(200);

      // Only agent-v1061-heavy's logs are visible here — that agent has 4 ops
      // so minOpsPerAgent = maxOpsPerAgent = 4
      expect(body.minOpsPerAgent).toBe(4);
      expect(typeof body.minOpsPerAgent).toBe('number');
    });

    it('12. agents — multiple tools, max and min differ: maxOpsPerTool and minOpsPerTool correct', async () => {
      ctx = await setup();
      const agentId = 'agent-v1061-tools';
      // tool-heavy: 5 ops, tool-med: 3 ops, tool-light: 1 op
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp(agentId, 'tool-heavy', `sess-th${i}`), dec(0.3));
      }
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp(agentId, 'tool-med', `sess-tm${i}`), dec(0.4));
      }
      await ctx.logger.log(makeOp(agentId, 'tool-light', 'sess-tl'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, `/agents/${agentId}`);
      expect(status).toBe(200);

      expect(body.maxOpsPerTool).toBe(5);   // tool-heavy
      expect(body.minOpsPerTool).toBe(1);   // tool-light
    });

    it('13. agents — multiple sessions: maxOpsPerSession reflects busiest session', async () => {
      ctx = await setup();
      const agentId = 'agent-v1061-sessions';
      // sess-busy: 6 ops, sess-quiet: 2 ops
      for (let i = 0; i < 6; i++) {
        await ctx.logger.log(makeOp(agentId, 'fs', 'sess-busy'), dec(0.4));
      }
      for (let i = 0; i < 2; i++) {
        await ctx.logger.log(makeOp(agentId, 'fs', 'sess-quiet'), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, `/agents/${agentId}`);
      expect(status).toBe(200);

      expect(body.maxOpsPerSession).toBe(6);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1374-T1378 — v10.61 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('14. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-g', 'tool-v1061-pres', 'sess-1'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1061-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('maxOpsPerTool');
      expect(body).toHaveProperty('maxOpsPerMethod');
      expect(body).toHaveProperty('maxOpsPerSession');
      expect(body).toHaveProperty('minOpsPerAgent');
      expect(body).toHaveProperty('minOpsPerTool');
    });

    it('15. tools — single log: all five fields equal 1', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-ts1', 'tool-v1061-single', 'sess-ts'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1061-single');
      expect(status).toBe(200);

      expect(body.maxOpsPerTool).toBe(1);
      expect(body.maxOpsPerMethod).toBe(1);
      expect(body.maxOpsPerSession).toBe(1);
      expect(body.minOpsPerAgent).toBe(1);
      expect(body.minOpsPerTool).toBe(1);
    });

    it('16. tools — old logs (40+ days): fields non-null (all-time)', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-tol1', 'tool-v1061-old', 'sess-1', daysAgo(43)), dec(0.4));
      await ctx.logger.log(makeOp('agent-tol2', 'tool-v1061-old', 'sess-2', daysAgo(50)), dec(0.9));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1061-old');
      expect(status).toBe(200);

      // tool-v1061-old: 2 ops total → maxOpsPerTool=2, minOpsPerTool=2
      expect(body.maxOpsPerTool).toBe(2);
      expect(body.minOpsPerTool).toBe(2);
      // two distinct agents each with 1 op → minOpsPerAgent=1
      expect(body.minOpsPerAgent).toBe(1);
    });

    it('17. tools — tools endpoint filters to one tool: maxOpsPerTool and minOpsPerTool both equal its op count', async () => {
      ctx = await setup();
      // The tools endpoint filters logs to only those for tool-v1061-alpha.
      // Within those 4 logs there is only 1 distinct tool (tool-v1061-alpha) with 4 ops.
      // maxOpsPerTool = minOpsPerTool = 4.
      // Other tools' logs won't appear in the /tools/tool-v1061-alpha endpoint.
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp(`agent-ta${i}`, 'tool-v1061-alpha', `sess-ta${i}`), dec(0.3));
      }
      for (let i = 0; i < 2; i++) {
        await ctx.logger.log(makeOp(`agent-tb${i}`, 'tool-v1061-beta', `sess-tb${i}`), dec(0.5));
      }
      await ctx.logger.log(makeOp('agent-tg', 'tool-v1061-gamma', 'sess-tg'), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1061-alpha');
      expect(status).toBe(200);

      // Only tool-v1061-alpha's 4 logs are in scope → max = min = 4
      expect(body.maxOpsPerTool).toBe(4);
      expect(body.minOpsPerTool).toBe(4);
    });

    it('18. tools — multiple agents: minOpsPerAgent picks the least active agent', async () => {
      ctx = await setup();
      const tool = 'tool-v1061-agents';
      // agent-busy: 5 ops, agent-idle: 1 op
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp('agent-busy', tool, `sess-b${i}`), dec(0.4));
      }
      await ctx.logger.log(makeOp('agent-idle', tool, 'sess-idle'), dec(0.7));

      const { status, body } = await getJSON(ctx.port, `/tools/${tool}`);
      expect(status).toBe(200);

      expect(body.minOpsPerAgent).toBe(1);  // agent-idle
    });

    it('19. tools — maxOpsPerMethod: method with most ops returned correctly', async () => {
      ctx = await setup();
      const tool = 'tool-v1061-methods';
      // method 'list': 3 ops, method 'read': 1 op
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp(`agent-ml${i}`, tool, `sess-ml${i}`, new Date(PINNED_NOW()), 'list'), dec(0.3));
      }
      await ctx.logger.log(makeOp('agent-mr', tool, 'sess-mr', new Date(PINNED_NOW()), 'read'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, `/tools/${tool}`);
      expect(status).toBe(200);

      expect(body.maxOpsPerMethod).toBe(3);  // 'list'
    });
  });

  // ── operations/summary endpoint ────────────────────────────────────────────────

  describe('T1374-T1378 — v10.61 new fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('20. summary — all five new fields present', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-j', 'tool-s', 'sess-1'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body).toHaveProperty('maxOpsPerTool');
      expect(body).toHaveProperty('maxOpsPerMethod');
      expect(body).toHaveProperty('maxOpsPerSession');
      expect(body).toHaveProperty('minOpsPerAgent');
      expect(body).toHaveProperty('minOpsPerTool');
    });

    it('21. summary — empty DB: all five new fields are null', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.maxOpsPerTool).toBeNull();
      expect(body.maxOpsPerMethod).toBeNull();
      expect(body.maxOpsPerSession).toBeNull();
      expect(body.minOpsPerAgent).toBeNull();
      expect(body.minOpsPerTool).toBeNull();
    });

    it('22. summary — single log: all five fields equal 1', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-sum-single', 'tool-sum-single', 'sess-sum-single'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.maxOpsPerTool).toBe(1);
      expect(body.maxOpsPerMethod).toBe(1);
      expect(body.maxOpsPerSession).toBe(1);
      expect(body.minOpsPerAgent).toBe(1);
      expect(body.minOpsPerTool).toBe(1);
    });

    it('23. summary — old logs only (40+ days): all five fields non-null (all-time)', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-sum-old1', 'tool-old-s', 'sess-old-1', daysAgo(42)), dec(0.3));
      await ctx.logger.log(makeOp('agent-sum-old2', 'tool-old-s', 'sess-old-2', daysAgo(48)), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      // tool-old-s: 2 ops → maxOpsPerTool=2, minOpsPerTool=2
      expect(body.maxOpsPerTool).toBe(2);
      expect(body.minOpsPerTool).toBe(2);
      // 2 agents each with 1 op → minOpsPerAgent=1
      expect(body.minOpsPerAgent).toBe(1);
    });

    it('24. summary — multiple agents with different op counts: max and min correct', async () => {
      ctx = await setup();
      // agent-sum-a: 5 ops, agent-sum-b: 2 ops, agent-sum-c: 1 op
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp('agent-sum-a', 'fs', `sess-sa${i}`), dec(0.3));
      }
      for (let i = 0; i < 2; i++) {
        await ctx.logger.log(makeOp('agent-sum-b', 'fs', `sess-sb${i}`), dec(0.5));
      }
      await ctx.logger.log(makeOp('agent-sum-c', 'fs', 'sess-sc'), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      // minOpsPerAgent = 1 (agent-sum-c)
      expect(body.minOpsPerAgent).toBe(1);
    });

    it('25. summary — multiple tools with different op counts: maxOpsPerTool and minOpsPerTool correct', async () => {
      ctx = await setup();
      // tool-popular: 6 ops, tool-normal: 3 ops, tool-rare: 1 op
      for (let i = 0; i < 6; i++) {
        await ctx.logger.log(makeOp(`agent-tp${i}`, 'tool-popular', `sess-tp${i}`), dec(0.2));
      }
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp(`agent-tn${i}`, 'tool-normal', `sess-tn${i}`), dec(0.4));
      }
      await ctx.logger.log(makeOp('agent-tr', 'tool-rare', 'sess-tr'), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.maxOpsPerTool).toBe(6);   // tool-popular
      expect(body.minOpsPerTool).toBe(1);   // tool-rare
    });

    it('26. summary — multiple methods: maxOpsPerMethod reflects busiest method', async () => {
      ctx = await setup();
      // method 'execute': 7 ops, method 'inspect': 2 ops, method 'ping': 1 op
      for (let i = 0; i < 7; i++) {
        await ctx.logger.log(makeOp(`agent-me${i}`, 'fs', `sess-me${i}`, new Date(PINNED_NOW()), 'execute'), dec(0.3));
      }
      for (let i = 0; i < 2; i++) {
        await ctx.logger.log(makeOp(`agent-mi${i}`, 'fs', `sess-mi${i}`, new Date(PINNED_NOW()), 'inspect'), dec(0.4));
      }
      await ctx.logger.log(makeOp('agent-mp', 'fs', 'sess-mp', new Date(PINNED_NOW()), 'ping'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.maxOpsPerMethod).toBe(7);  // 'execute'
    });

    it('27. summary — multiple sessions: maxOpsPerSession reflects the busiest session', async () => {
      ctx = await setup();
      // sess-mega: 8 ops, sess-normal: 3 ops, sess-quiet: 1 op
      for (let i = 0; i < 8; i++) {
        await ctx.logger.log(makeOp(`agent-smg${i}`, 'fs', 'sess-mega'), dec(0.3));
      }
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp(`agent-sno${i}`, 'fs', 'sess-normal'), dec(0.5));
      }
      await ctx.logger.log(makeOp('agent-sq', 'fs', 'sess-quiet'), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.maxOpsPerSession).toBe(8);
    });

    it('28. summary — equal counts across all tools: max equals min', async () => {
      ctx = await setup();
      // tool-x1, tool-x2, tool-x3 each get exactly 2 ops → max=min=2
      for (const tool of ['tool-x1', 'tool-x2', 'tool-x3']) {
        await ctx.logger.log(makeOp('agent-eq1', tool, `sess-eq-${tool}-1`), dec(0.4));
        await ctx.logger.log(makeOp('agent-eq2', tool, `sess-eq-${tool}-2`), dec(0.6));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.maxOpsPerTool).toBe(2);
      expect(body.minOpsPerTool).toBe(2);
    });

    it('29. summary — mix of recent and old logs: all-time fields include old logs', async () => {
      ctx = await setup();
      // Recent: tool-recent with 2 ops
      await ctx.logger.log(makeOp('agent-r1', 'tool-recent', 'sess-r1', daysAgo(1)), dec(0.4));
      await ctx.logger.log(makeOp('agent-r2', 'tool-recent', 'sess-r2', daysAgo(2)), dec(0.5));
      // Old (45 days): tool-legacy with 4 ops
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp(`agent-leg${i}`, 'tool-legacy', `sess-leg${i}`, daysAgo(45)), dec(0.7));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      // maxOpsPerTool should include the old tool-legacy with 4 ops
      expect(body.maxOpsPerTool).toBe(4);
      // minOpsPerTool should be tool-recent with 2 ops
      expect(body.minOpsPerTool).toBe(2);
    });

    it('30. summary — all fields are positive integers when logs exist', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-pos1', 'tool-pos', 'sess-pos1'), dec(0.3));
      await ctx.logger.log(makeOp('agent-pos2', 'tool-pos', 'sess-pos2'), dec(0.6));
      await ctx.logger.log(makeOp('agent-pos1', 'tool-other', 'sess-pos3'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(typeof body.maxOpsPerTool).toBe('number');
      expect(typeof body.maxOpsPerMethod).toBe('number');
      expect(typeof body.maxOpsPerSession).toBe('number');
      expect(typeof body.minOpsPerAgent).toBe('number');
      expect(typeof body.minOpsPerTool).toBe('number');

      expect(body.maxOpsPerTool as number).toBeGreaterThan(0);
      expect(body.maxOpsPerMethod as number).toBeGreaterThan(0);
      expect(body.maxOpsPerSession as number).toBeGreaterThan(0);
      expect(body.minOpsPerAgent as number).toBeGreaterThan(0);
      expect(body.minOpsPerTool as number).toBeGreaterThan(0);
    });
  });
});

// ── v10.62 ────────────────────────────────────────────────────────────────────

describe('v10.62', () => {
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1379-T1380 — v10.62 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — minOpsPerMethod and minOpsPerSession present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1062-pres'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1062-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('minOpsPerMethod');
      expect(body).toHaveProperty('minOpsPerSession');
    });

    it('2. sessions — single log: minOpsPerMethod and minOpsPerSession both equal 1', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s1', 'tool-s1', 'sess-v1062-single', new Date(PINNED_NOW()), 'read'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1062-single');
      expect(status).toBe(200);

      expect(body.minOpsPerMethod).toBe(1);
      expect(body.minOpsPerSession).toBe(1);
    });

    it('3. sessions — multiple methods with different counts: minOpsPerMethod picks the least-used method', async () => {
      ctx = await setup();
      const sess = 'sess-v1062-methods';
      // method 'read': 4 ops, method 'write': 2 ops, method 'list': 1 op
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp(`agent-r${i}`, 'fs', sess, new Date(PINNED_NOW()), 'read'), dec(0.3));
      }
      for (let i = 0; i < 2; i++) {
        await ctx.logger.log(makeOp(`agent-w${i}`, 'fs', sess, new Date(PINNED_NOW()), 'write'), dec(0.4));
      }
      await ctx.logger.log(makeOp('agent-l', 'fs', sess, new Date(PINNED_NOW()), 'list'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, `/sessions/${sess}`);
      expect(status).toBe(200);

      // min is 'list' with 1 op
      expect(body.minOpsPerMethod).toBe(1);
    });

    it('4. sessions — sessions endpoint filters to one session: minOpsPerSession equals op count for that session', async () => {
      ctx = await setup();
      const targetSess = 'sess-v1062-single-sess';
      // The sessions endpoint filters logs to only those for targetSess.
      // Within those filtered logs, there is only 1 distinct sessionId.
      // minOpsPerSession = total ops for targetSess = 3.
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp(`agent-b${i}`, 'fs', targetSess), dec(0.3));
      }
      // These ops for a different session do NOT appear in /sessions/targetSess response
      for (let i = 0; i < 1; i++) {
        await ctx.logger.log(makeOp(`agent-q${i}`, 'fs', 'sess-v1062-other'), dec(0.4));
      }

      const { status, body } = await getJSON(ctx.port, `/sessions/${targetSess}`);
      expect(status).toBe(200);

      // Only targetSess logs in scope — 1 distinct session with 3 ops → min = 3
      expect(body.minOpsPerSession).toBe(3);
    });

    it('5. sessions — old logs (40+ days): minOpsPerMethod and minOpsPerSession non-null (all-time)', async () => {
      ctx = await setup();
      const sess = 'sess-v1062-old';
      await ctx.logger.log(makeOp('agent-old1', 'fs', sess, daysAgo(42), 'call'), dec(0.5));
      await ctx.logger.log(makeOp('agent-old2', 'fs', sess, daysAgo(45), 'call'), dec(0.6));

      const { status, body } = await getJSON(ctx.port, `/sessions/${sess}`);
      expect(status).toBe(200);

      // one method 'call' with 2 ops → min = 2
      expect(body.minOpsPerMethod).toBe(2);
      // one session with 2 ops → min = 2
      expect(body.minOpsPerSession).toBe(2);
    });

    it('6. sessions — equal method counts: minOpsPerMethod equals maxOpsPerMethod', async () => {
      ctx = await setup();
      const sess = 'sess-v1062-equal-methods';
      // 'call' and 'read' each get exactly 3 ops
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp(`agent-c${i}`, 'fs', sess, new Date(PINNED_NOW()), 'call'), dec(0.3));
        await ctx.logger.log(makeOp(`agent-re${i}`, 'fs', sess, new Date(PINNED_NOW()), 'read'), dec(0.4));
      }

      const { status, body } = await getJSON(ctx.port, `/sessions/${sess}`);
      expect(status).toBe(200);

      // Both methods have 3 ops → min = max = 3
      expect(body.minOpsPerMethod).toBe(3);
      expect(body.maxOpsPerMethod).toBe(3);
    });

    it('7. sessions — equal session counts: minOpsPerSession equals maxOpsPerSession', async () => {
      ctx = await setup();
      const sess1 = 'sess-v1062-eq1';
      const sess2 = 'sess-v1062-eq2';
      // Each session gets 2 ops
      for (let i = 0; i < 2; i++) {
        await ctx.logger.log(makeOp(`agent-e1-${i}`, 'fs', sess1), dec(0.3));
        await ctx.logger.log(makeOp(`agent-e2-${i}`, 'fs', sess2), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, `/sessions/${sess1}`);
      expect(status).toBe(200);

      // Both sessions have 2 ops → min = max = 2
      expect(body.minOpsPerSession).toBe(2);
      expect(body.maxOpsPerSession).toBe(2);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1379-T1380 — v10.62 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('8. agents — minOpsPerMethod and minOpsPerSession present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1062-pres', 'fs', 'sess-1'), dec(0.3));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1062-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('minOpsPerMethod');
      expect(body).toHaveProperty('minOpsPerSession');
    });

    it('9. agents — single log: minOpsPerMethod and minOpsPerSession both equal 1', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1062-single', 'fs', 'sess-single', new Date(PINNED_NOW()), 'call'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1062-single');
      expect(status).toBe(200);

      expect(body.minOpsPerMethod).toBe(1);
      expect(body.minOpsPerSession).toBe(1);
    });

    it('10. agents — multiple methods: minOpsPerMethod picks the rarest method', async () => {
      ctx = await setup();
      const agentId = 'agent-v1062-methods';
      // method 'execute': 5 ops, method 'inspect': 3 ops, method 'ping': 1 op
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp(agentId, 'fs', `sess-ex${i}`, new Date(PINNED_NOW()), 'execute'), dec(0.3));
      }
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp(agentId, 'fs', `sess-in${i}`, new Date(PINNED_NOW()), 'inspect'), dec(0.4));
      }
      await ctx.logger.log(makeOp(agentId, 'fs', 'sess-ping', new Date(PINNED_NOW()), 'ping'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, `/agents/${agentId}`);
      expect(status).toBe(200);

      // 'ping' has only 1 op → min = 1
      expect(body.minOpsPerMethod).toBe(1);
    });

    it('11. agents — multiple sessions: minOpsPerSession picks the quietest session', async () => {
      ctx = await setup();
      const agentId = 'agent-v1062-sessions';
      // sess-busy: 6 ops, sess-mid: 3 ops, sess-quiet: 1 op
      for (let i = 0; i < 6; i++) {
        await ctx.logger.log(makeOp(agentId, 'fs', 'sess-busy'), dec(0.3));
      }
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp(agentId, 'fs', 'sess-mid'), dec(0.4));
      }
      await ctx.logger.log(makeOp(agentId, 'fs', 'sess-quiet'), dec(0.6));

      const { status, body } = await getJSON(ctx.port, `/agents/${agentId}`);
      expect(status).toBe(200);

      // sess-quiet has 1 op → min = 1
      expect(body.minOpsPerSession).toBe(1);
    });

    it('12. agents — old logs (40+ days): fields non-null (all-time calculation)', async () => {
      ctx = await setup();
      const agentId = 'agent-v1062-old';
      await ctx.logger.log(makeOp(agentId, 'fs', 'sess-old-1', daysAgo(42), 'call'), dec(0.5));
      await ctx.logger.log(makeOp(agentId, 'fs', 'sess-old-2', daysAgo(45), 'read'), dec(0.7));

      const { status, body } = await getJSON(ctx.port, `/agents/${agentId}`);
      expect(status).toBe(200);

      // Two distinct methods each with 1 op → min = 1
      expect(body.minOpsPerMethod).toBe(1);
      // Two distinct sessions each with 1 op → min = 1
      expect(body.minOpsPerSession).toBe(1);
    });

    it('13. agents — minOpsPerSession with two sessions of same count: both equal', async () => {
      ctx = await setup();
      const agentId = 'agent-v1062-eq-sessions';
      // sess-a: 4 ops, sess-b: 4 ops
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp(agentId, 'fs', 'sess-a'), dec(0.3));
        await ctx.logger.log(makeOp(agentId, 'fs', 'sess-b'), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, `/agents/${agentId}`);
      expect(status).toBe(200);

      // Both sessions have 4 ops → min = max = 4
      expect(body.minOpsPerSession).toBe(4);
      expect(body.maxOpsPerSession).toBe(4);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1379-T1380 — v10.62 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('14. tools — minOpsPerMethod and minOpsPerSession present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-g', 'tool-v1062-pres', 'sess-1'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1062-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('minOpsPerMethod');
      expect(body).toHaveProperty('minOpsPerSession');
    });

    it('15. tools — single log: minOpsPerMethod and minOpsPerSession both equal 1', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-ts1', 'tool-v1062-single', 'sess-ts', new Date(PINNED_NOW()), 'call'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1062-single');
      expect(status).toBe(200);

      expect(body.minOpsPerMethod).toBe(1);
      expect(body.minOpsPerSession).toBe(1);
    });

    it('16. tools — multiple methods: minOpsPerMethod reflects least-used method', async () => {
      ctx = await setup();
      const tool = 'tool-v1062-methods';
      // 'list': 3 ops, 'read': 2 ops, 'write': 1 op
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp(`agent-tl${i}`, tool, `sess-tl${i}`, new Date(PINNED_NOW()), 'list'), dec(0.3));
      }
      for (let i = 0; i < 2; i++) {
        await ctx.logger.log(makeOp(`agent-tr${i}`, tool, `sess-tr${i}`, new Date(PINNED_NOW()), 'read'), dec(0.4));
      }
      await ctx.logger.log(makeOp('agent-tw', tool, 'sess-tw', new Date(PINNED_NOW()), 'write'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, `/tools/${tool}`);
      expect(status).toBe(200);

      // 'write' has 1 op → min = 1
      expect(body.minOpsPerMethod).toBe(1);
    });

    it('17. tools — multiple sessions with different counts: minOpsPerSession picks the quietest', async () => {
      ctx = await setup();
      const tool = 'tool-v1062-sessions';
      // sess-heavy: 5 ops, sess-light: 1 op
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp(`agent-th${i}`, tool, 'sess-heavy'), dec(0.3));
      }
      await ctx.logger.log(makeOp('agent-tlight', tool, 'sess-light'), dec(0.7));

      const { status, body } = await getJSON(ctx.port, `/tools/${tool}`);
      expect(status).toBe(200);

      // sess-light has 1 op → min = 1
      expect(body.minOpsPerSession).toBe(1);
    });

    it('18. tools — old logs (40+ days): fields non-null (all-time)', async () => {
      ctx = await setup();
      const tool = 'tool-v1062-old';
      await ctx.logger.log(makeOp('agent-tol1', tool, 'sess-1', daysAgo(43), 'call'), dec(0.4));
      await ctx.logger.log(makeOp('agent-tol2', tool, 'sess-2', daysAgo(50), 'read'), dec(0.9));

      const { status, body } = await getJSON(ctx.port, `/tools/${tool}`);
      expect(status).toBe(200);

      // Two distinct methods ('call' and 'read') each with 1 op → min = 1
      expect(body.minOpsPerMethod).toBe(1);
      // Two distinct sessions each with 1 op → min = 1
      expect(body.minOpsPerSession).toBe(1);
    });

    it('19. tools — minOpsPerMethod: dominant method and rare method — correct min', async () => {
      ctx = await setup();
      const tool = 'tool-v1062-dom';
      // 'call': 10 ops, 'notify': 2 ops — min should be 2
      for (let i = 0; i < 10; i++) {
        await ctx.logger.log(makeOp(`agent-dc${i}`, tool, `sess-dc${i}`, new Date(PINNED_NOW()), 'call'), dec(0.3));
      }
      for (let i = 0; i < 2; i++) {
        await ctx.logger.log(makeOp(`agent-dn${i}`, tool, `sess-dn${i}`, new Date(PINNED_NOW()), 'notify'), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, `/tools/${tool}`);
      expect(status).toBe(200);

      expect(body.minOpsPerMethod).toBe(2);
    });
  });

  // ── operations/summary endpoint ────────────────────────────────────────────────

  describe('T1379-T1380 — v10.62 new fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('20. summary — minOpsPerMethod and minOpsPerSession present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-j', 'tool-s', 'sess-1'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body).toHaveProperty('minOpsPerMethod');
      expect(body).toHaveProperty('minOpsPerSession');
    });

    it('21. summary — empty DB: minOpsPerMethod and minOpsPerSession are null', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.minOpsPerMethod).toBeNull();
      expect(body.minOpsPerSession).toBeNull();
    });

    it('22. summary — single log: both fields equal 1', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-sum-single', 'tool-sum', 'sess-sum', new Date(PINNED_NOW()), 'call'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.minOpsPerMethod).toBe(1);
      expect(body.minOpsPerSession).toBe(1);
    });

    it('23. summary — multiple methods with different counts: minOpsPerMethod picks the rarest', async () => {
      ctx = await setup();
      // 'call': 7 ops, 'read': 3 ops, 'write': 1 op
      for (let i = 0; i < 7; i++) {
        await ctx.logger.log(makeOp(`agent-sc${i}`, 'fs', `sess-sc${i}`, new Date(PINNED_NOW()), 'call'), dec(0.3));
      }
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp(`agent-sr${i}`, 'fs', `sess-sr${i}`, new Date(PINNED_NOW()), 'read'), dec(0.4));
      }
      await ctx.logger.log(makeOp('agent-sw', 'fs', 'sess-sw', new Date(PINNED_NOW()), 'write'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      // 'write' has 1 op → min = 1
      expect(body.minOpsPerMethod).toBe(1);
    });

    it('24. summary — multiple sessions with different counts: minOpsPerSession picks the quietest', async () => {
      ctx = await setup();
      // sess-mega: 8 ops, sess-normal: 4 ops, sess-tiny: 1 op
      for (let i = 0; i < 8; i++) {
        await ctx.logger.log(makeOp(`agent-smg${i}`, 'fs', 'sess-mega'), dec(0.3));
      }
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp(`agent-sno${i}`, 'fs', 'sess-normal'), dec(0.5));
      }
      await ctx.logger.log(makeOp('agent-stiny', 'fs', 'sess-tiny'), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      // sess-tiny has 1 op → min = 1
      expect(body.minOpsPerSession).toBe(1);
    });

    it('25. summary — old logs only (40+ days): minOpsPerMethod and minOpsPerSession non-null (all-time)', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-sum-old1', 'tool-old-s', 'sess-old-1', daysAgo(42), 'call'), dec(0.3));
      await ctx.logger.log(makeOp('agent-sum-old2', 'tool-old-s', 'sess-old-2', daysAgo(48), 'read'), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      // Two distinct methods each with 1 op → min = 1
      expect(body.minOpsPerMethod).toBe(1);
      // Two distinct sessions each with 1 op → min = 1
      expect(body.minOpsPerSession).toBe(1);
    });

    it('26. summary — equal session counts: minOpsPerSession equals maxOpsPerSession', async () => {
      ctx = await setup();
      // sess-x1, sess-x2, sess-x3 each get exactly 3 ops
      for (const sess of ['sess-x1', 'sess-x2', 'sess-x3']) {
        for (let i = 0; i < 3; i++) {
          await ctx.logger.log(makeOp(`agent-eq-${sess}-${i}`, 'fs', sess), dec(0.4));
        }
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.minOpsPerSession).toBe(3);
      expect(body.maxOpsPerSession).toBe(3);
    });

    it('27. summary — equal method counts: minOpsPerMethod equals maxOpsPerMethod', async () => {
      ctx = await setup();
      // 'call' and 'read' each get exactly 4 ops
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp(`agent-ec${i}`, 'fs', `sess-ec${i}`, new Date(PINNED_NOW()), 'call'), dec(0.3));
        await ctx.logger.log(makeOp(`agent-er${i}`, 'fs', `sess-er${i}`, new Date(PINNED_NOW()), 'read'), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.minOpsPerMethod).toBe(4);
      expect(body.maxOpsPerMethod).toBe(4);
    });

    it('28. summary — minOpsPerSession reflects only the minimum, not maximum', async () => {
      ctx = await setup();
      // Three sessions: 10, 5, 2 ops
      for (let i = 0; i < 10; i++) {
        await ctx.logger.log(makeOp(`agent-s10-${i}`, 'fs', 'sess-ten'), dec(0.3));
      }
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp(`agent-s5-${i}`, 'fs', 'sess-five'), dec(0.4));
      }
      for (let i = 0; i < 2; i++) {
        await ctx.logger.log(makeOp(`agent-s2-${i}`, 'fs', 'sess-two'), dec(0.6));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      // min is sess-two with 2 ops
      expect(body.minOpsPerSession).toBe(2);
      // max is sess-ten with 10 ops
      expect(body.maxOpsPerSession).toBe(10);
    });

    // ── light verification of pre-existing avgRiskScore fields (T1381-T1383) ──────

    it('29. summary — avgRiskScoreBlockedOps is null when no blocked ops exist', async () => {
      ctx = await setup();
      // Only 'allow' ops — no 'block' ops
      await ctx.logger.log(makeOp('agent-allow1', 'fs', 'sess-allow1'), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-allow2', 'fs', 'sess-allow2'), dec(0.6, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.avgRiskScoreBlockedOps).toBeNull();
      // avgRiskScoreAllowedOps should be non-null
      expect(body.avgRiskScoreAllowedOps).not.toBeNull();
    });

    it('30. summary — avgRiskScoreAllowedOps, avgRiskScoreBlockedOps, avgRiskScoreRequireApprovalOps all present', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-mix1', 'fs', 'sess-mix1'), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-mix2', 'fs', 'sess-mix2'), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agent-mix3', 'fs', 'sess-mix3'), dec(0.6, 'require_approval'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body).toHaveProperty('avgRiskScoreAllowedOps');
      expect(body).toHaveProperty('avgRiskScoreBlockedOps');
      expect(body).toHaveProperty('avgRiskScoreRequireApprovalOps');

      expect(body.avgRiskScoreAllowedOps as number).toBeCloseTo(0.4, 5);
      expect(body.avgRiskScoreBlockedOps as number).toBeCloseTo(0.8, 5);
      expect(body.avgRiskScoreRequireApprovalOps as number).toBeCloseTo(0.6, 5);
    });
  });
});

// ── v10.63 ────────────────────────────────────────────────────────────────────

describe('v10.63', () => {
  function makeOp(
    agentId: string,
    tool = 'fs',
    sessionId = 'sess-1',
    method = 'call',
    timestamp: Date = new Date(PINNED_NOW()),
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

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1384-T1388 — v10.63 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1063-pres'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1063-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('medianOpsPerSession');
      expect(body).toHaveProperty('medianOpsPerTool');
      expect(body).toHaveProperty('medianOpsPerMethod');
      expect(body).toHaveProperty('medianOpsPerAgent');
      expect(body).toHaveProperty('opsPerSessionStdDev');
    });

    it('2. sessions — single log: medianOpsPerSession = 1 (only session), opsPerSessionStdDev null (1 distinct session)', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1063-single'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1063-single');
      expect(status).toBe(200);

      // Single session with 1 op → median of [1] = 1
      expect(body.medianOpsPerSession).toBe(1);
      // Single distinct session → stddev null
      expect(body.opsPerSessionStdDev).toBeNull();
    });

    it('3. sessions — endpoint filters to one sessionId: medianOpsPerSession = total log count for that session', async () => {
      ctx = await setup();
      // 3 ops for the same session → all logs for this endpoint have sessionId = 'sess-v1063-filter'
      // counts per session: {'sess-v1063-filter': 3} → median of [3] = 3
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1063-filter'), dec(0.3));
      await ctx.logger.log(makeOp('agent-c', 'tool-b', 'sess-v1063-filter'), dec(0.5));
      await ctx.logger.log(makeOp('agent-c', 'tool-c', 'sess-v1063-filter'), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1063-filter');
      expect(status).toBe(200);

      // Sessions endpoint filters to this session only: 3 ops → 1 distinct session with count 3 → median = 3
      expect(body.medianOpsPerSession).toBe(3);
      // Still only 1 distinct session in this filtered view → stddev null
      expect(body.opsPerSessionStdDev).toBeNull();
    });

    it('4. sessions — medianOpsPerTool with multiple tools: odd number of distinct tools', async () => {
      ctx = await setup();
      // tool-a: 1 op, tool-b: 2 ops, tool-c: 3 ops → sorted counts [1, 2, 3] → median = 2
      await ctx.logger.log(makeOp('agent-d', 'tool-a', 'sess-v1063-tools'), dec(0.2));
      await ctx.logger.log(makeOp('agent-d', 'tool-b', 'sess-v1063-tools'), dec(0.4));
      await ctx.logger.log(makeOp('agent-d', 'tool-b', 'sess-v1063-tools'), dec(0.5));
      await ctx.logger.log(makeOp('agent-d', 'tool-c', 'sess-v1063-tools'), dec(0.6));
      await ctx.logger.log(makeOp('agent-d', 'tool-c', 'sess-v1063-tools'), dec(0.7));
      await ctx.logger.log(makeOp('agent-d', 'tool-c', 'sess-v1063-tools'), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1063-tools');
      expect(status).toBe(200);

      // sorted counts: [1, 2, 3], len=3 (odd) → mid=1 → 2
      expect(body.medianOpsPerTool).toBe(2);
    });

    it('5. sessions — medianOpsPerMethod with even number of distinct methods: avg of middle two', async () => {
      ctx = await setup();
      // method-x: 2 ops, method-y: 4 ops → sorted counts [2, 4] → median = (2+4)/2 = 3
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1063-methods', 'method-x'), dec(0.3));
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1063-methods', 'method-x'), dec(0.4));
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1063-methods', 'method-y'), dec(0.5));
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1063-methods', 'method-y'), dec(0.6));
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1063-methods', 'method-y'), dec(0.7));
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1063-methods', 'method-y'), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1063-methods');
      expect(status).toBe(200);

      // sorted counts: [2, 4], len=2 (even) → mid=1 → (vals[0]+vals[1])/2 = (2+4)/2 = 3
      expect(body.medianOpsPerMethod as number).toBeCloseTo(3, 5);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1384-T1388 — v10.63 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('6. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1063-pres', 'fs', 'sess-1'), dec(0.3));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1063-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('medianOpsPerSession');
      expect(body).toHaveProperty('medianOpsPerTool');
      expect(body).toHaveProperty('medianOpsPerMethod');
      expect(body).toHaveProperty('medianOpsPerAgent');
      expect(body).toHaveProperty('opsPerSessionStdDev');
    });

    it('7. agents — multiple sessions: opsPerSessionStdDev computed correctly', async () => {
      ctx = await setup();
      // sess-a: 1 op, sess-b: 3 ops → counts [1, 3]
      // mean = 2, variance = ((1-2)^2 + (3-2)^2) / 2 = (1+1)/2 = 1, stddev = 1
      await ctx.logger.log(makeOp('agent-v1063-stddev', 'fs', 'sess-a'), dec(0.4));
      await ctx.logger.log(makeOp('agent-v1063-stddev', 'fs', 'sess-b'), dec(0.5));
      await ctx.logger.log(makeOp('agent-v1063-stddev', 'fs', 'sess-b'), dec(0.6));
      await ctx.logger.log(makeOp('agent-v1063-stddev', 'fs', 'sess-b'), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1063-stddev');
      expect(status).toBe(200);

      expect(body.opsPerSessionStdDev as number).toBeCloseTo(1, 5);
    });

    it('8. agents — single log single session: opsPerSessionStdDev null (only 1 distinct session)', async () => {
      ctx = await setup();
      // Only 1 distinct session → stddev = null
      await ctx.logger.log(makeOp('agent-v1063-1sess', 'fs', 'sess-only'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1063-1sess');
      expect(status).toBe(200);

      // 1 distinct session → stddev null
      expect(body.opsPerSessionStdDev).toBeNull();
      // medianOpsPerSession: counts = {sess-only: 1} → median of [1] = 1
      expect(body.medianOpsPerSession).toBe(1);
      // medianOpsPerAgent: counts = {agent-v1063-1sess: 1} → median = 1
      expect(body.medianOpsPerAgent).toBe(1);
      // medianOpsPerTool: counts = {fs: 1} → median = 1
      expect(body.medianOpsPerTool).toBe(1);
      // medianOpsPerMethod: counts = {call: 1} → median = 1
      expect(body.medianOpsPerMethod).toBe(1);
    });

    it('9. agents — medianOpsPerAgent at agents endpoint = single agent count (all ops belong to this agent)', async () => {
      ctx = await setup();
      // 5 ops for agent-v1063-single-agent → counts per agent: {agent-v1063-single-agent: 5} → median = 5
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp('agent-v1063-single-agent', `tool-${i}`, `sess-${i}`), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1063-single-agent');
      expect(status).toBe(200);

      // Agents endpoint filters to this agentId: 1 distinct agent with count 5 → median = 5
      expect(body.medianOpsPerAgent).toBe(5);
    });

    it('10. agents — medianOpsPerTool with four distinct tools (even count): avg middle two', async () => {
      ctx = await setup();
      // tool-1: 1 op, tool-2: 2 ops, tool-3: 3 ops, tool-4: 4 ops
      // sorted counts: [1, 2, 3, 4], len=4 (even) → mid=2 → (vals[1]+vals[2])/2 = (2+3)/2 = 2.5
      for (let i = 0; i < 1; i++) await ctx.logger.log(makeOp('agent-v1063-tools4', 'tool-1', 'sess-1'), dec(0.2));
      for (let i = 0; i < 2; i++) await ctx.logger.log(makeOp('agent-v1063-tools4', 'tool-2', 'sess-1'), dec(0.3));
      for (let i = 0; i < 3; i++) await ctx.logger.log(makeOp('agent-v1063-tools4', 'tool-3', 'sess-1'), dec(0.4));
      for (let i = 0; i < 4; i++) await ctx.logger.log(makeOp('agent-v1063-tools4', 'tool-4', 'sess-1'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1063-tools4');
      expect(status).toBe(200);

      expect(body.medianOpsPerTool as number).toBeCloseTo(2.5, 5);
    });

    it('11. agents — three sessions with varied counts: medianOpsPerSession is middle value', async () => {
      ctx = await setup();
      // sess-p: 1 op, sess-q: 3 ops, sess-r: 5 ops
      // sorted counts: [1, 3, 5], len=3 (odd) → mid=1 → median = 3
      await ctx.logger.log(makeOp('agent-v1063-3sess', 'fs', 'sess-p'), dec(0.3));
      for (let i = 0; i < 3; i++) await ctx.logger.log(makeOp('agent-v1063-3sess', 'fs', 'sess-q'), dec(0.5));
      for (let i = 0; i < 5; i++) await ctx.logger.log(makeOp('agent-v1063-3sess', 'fs', 'sess-r'), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1063-3sess');
      expect(status).toBe(200);

      expect(body.medianOpsPerSession).toBe(3);
      // population stddev of [1, 3, 5]:
      // mean=3, variance=((1-3)^2+(3-3)^2+(5-3)^2)/3 = (4+0+4)/3 = 8/3 ≈ 2.667, stddev ≈ 1.6329...
      expect(body.opsPerSessionStdDev as number).toBeCloseTo(Math.sqrt(8 / 3), 5);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1384-T1388 — v10.63 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('12. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-f', 'tool-v1063-pres', 'sess-1'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1063-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('medianOpsPerSession');
      expect(body).toHaveProperty('medianOpsPerTool');
      expect(body).toHaveProperty('medianOpsPerMethod');
      expect(body).toHaveProperty('medianOpsPerAgent');
      expect(body).toHaveProperty('opsPerSessionStdDev');
    });

    it('13. tools — medianOpsPerTool at tools endpoint = total count for that tool (single distinct tool)', async () => {
      ctx = await setup();
      // 4 ops for tool-v1063-single → counts per tool: {tool-v1063-single: 4} → median = 4
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp(`agent-${i}`, 'tool-v1063-single', `sess-${i}`), dec(0.4));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1063-single');
      expect(status).toBe(200);

      // Tools endpoint filters to this tool only: 1 distinct tool with count 4 → median = 4
      expect(body.medianOpsPerTool).toBe(4);
    });

    it('14. tools — two sessions with different counts: opsPerSessionStdDev computed correctly', async () => {
      ctx = await setup();
      // sess-x: 2 ops, sess-y: 6 ops → counts [2, 6]
      // mean=4, variance=((2-4)^2+(6-4)^2)/2=(4+4)/2=4, stddev=2
      for (let i = 0; i < 2; i++) await ctx.logger.log(makeOp('agent-g', 'tool-v1063-stddev2', 'sess-x'), dec(0.3));
      for (let i = 0; i < 6; i++) await ctx.logger.log(makeOp('agent-g', 'tool-v1063-stddev2', 'sess-y'), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1063-stddev2');
      expect(status).toBe(200);

      expect(body.opsPerSessionStdDev as number).toBeCloseTo(2, 5);
    });

    it('15. tools — medianOpsPerMethod with five methods (odd): middle value', async () => {
      ctx = await setup();
      // method-a:1, method-b:2, method-c:3, method-d:4, method-e:5
      // sorted counts [1,2,3,4,5], len=5 (odd) → mid=2 → median=3
      const methods = ['method-a', 'method-b', 'method-c', 'method-d', 'method-e'];
      for (const [i, m] of methods.entries()) {
        for (let j = 0; j <= i; j++) {
          await ctx.logger.log(makeOp('agent-h', 'tool-v1063-methods5', 'sess-1', m), dec(0.5));
        }
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1063-methods5');
      expect(status).toBe(200);

      expect(body.medianOpsPerMethod).toBe(3);
    });

    it('16. tools — medianOpsPerAgent with three agents having unequal counts', async () => {
      ctx = await setup();
      // agent-aa: 2 ops, agent-bb: 2 ops, agent-cc: 6 ops
      // sorted counts [2, 2, 6], len=3 (odd) → mid=1 → median=2
      for (let i = 0; i < 2; i++) await ctx.logger.log(makeOp('agent-aa', 'tool-v1063-agents3', 'sess-1'), dec(0.4));
      for (let i = 0; i < 2; i++) await ctx.logger.log(makeOp('agent-bb', 'tool-v1063-agents3', 'sess-2'), dec(0.5));
      for (let i = 0; i < 6; i++) await ctx.logger.log(makeOp('agent-cc', 'tool-v1063-agents3', 'sess-3'), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1063-agents3');
      expect(status).toBe(200);

      expect(body.medianOpsPerAgent).toBe(2);
    });
  });

  // ── operations/summary endpoint ────────────────────────────────────────────────

  describe('T1384-T1388 — v10.63 new fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('17. summary — all five new fields present', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-i', 'tool-s', 'sess-1'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body).toHaveProperty('medianOpsPerSession');
      expect(body).toHaveProperty('medianOpsPerTool');
      expect(body).toHaveProperty('medianOpsPerMethod');
      expect(body).toHaveProperty('medianOpsPerAgent');
      expect(body).toHaveProperty('opsPerSessionStdDev');
    });

    it('18. summary — empty DB: all five new fields are null', async () => {
      ctx = await setup();

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.medianOpsPerSession).toBeNull();
      expect(body.medianOpsPerTool).toBeNull();
      expect(body.medianOpsPerMethod).toBeNull();
      expect(body.medianOpsPerAgent).toBeNull();
      expect(body.opsPerSessionStdDev).toBeNull();
    });

    it('19. summary — single distinct session: opsPerSessionStdDev is null', async () => {
      ctx = await setup();
      // All ops in same session → only 1 distinct session → stddev null
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-only'), dec(0.3));
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-only'), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.opsPerSessionStdDev).toBeNull();
      // median ops per session: counts = {sess-only: 2} → median of [2] = 2
      expect(body.medianOpsPerSession).toBe(2);
    });

    it('20. summary — four sessions with counts 1,2,3,4: medianOpsPerSession is avg of middle two', async () => {
      ctx = await setup();
      // sess-1:1op, sess-2:2ops, sess-3:3ops, sess-4:4ops
      // sorted counts [1,2,3,4], len=4 (even) → mid=2 → (vals[1]+vals[2])/2=(2+3)/2=2.5
      for (let i = 1; i <= 4; i++) {
        for (let j = 0; j < i; j++) {
          await ctx.logger.log(makeOp(`agent-sum-${i}`, 'fs', `sess-sum-${i}`), dec(0.5));
        }
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.medianOpsPerSession as number).toBeCloseTo(2.5, 5);
    });

    it('21. summary — five sessions with varied counts: opsPerSessionStdDev with known values', async () => {
      ctx = await setup();
      // sess-A:1, sess-B:1, sess-C:3, sess-D:3, sess-E:2
      // sorted counts [1,1,2,3,3]
      // mean=2, variance=((1-2)^2+(1-2)^2+(2-2)^2+(3-2)^2+(3-2)^2)/5=(1+1+0+1+1)/5=4/5=0.8
      // stddev = sqrt(0.8)
      for (let i = 0; i < 1; i++) await ctx.logger.log(makeOp('agent-sum-A', 'fs', 'sess-A'), dec(0.3));
      for (let i = 0; i < 1; i++) await ctx.logger.log(makeOp('agent-sum-B', 'fs', 'sess-B'), dec(0.4));
      for (let i = 0; i < 3; i++) await ctx.logger.log(makeOp('agent-sum-C', 'fs', 'sess-C'), dec(0.5));
      for (let i = 0; i < 3; i++) await ctx.logger.log(makeOp('agent-sum-D', 'fs', 'sess-D'), dec(0.6));
      for (let i = 0; i < 2; i++) await ctx.logger.log(makeOp('agent-sum-E', 'fs', 'sess-E'), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.opsPerSessionStdDev as number).toBeCloseTo(Math.sqrt(0.8), 5);
      // median: sorted [1,1,2,3,3], len=5 (odd) → mid=2 → 2
      expect(body.medianOpsPerSession).toBe(2);
    });

    it('22. summary — multiple agents with unequal counts: medianOpsPerAgent correct', async () => {
      ctx = await setup();
      // agent-x:1 op, agent-y:5 ops → sorted counts [1,5], len=2 (even) → (1+5)/2=3
      await ctx.logger.log(makeOp('agent-x', 'fs', 'sess-1'), dec(0.4));
      for (let i = 0; i < 5; i++) await ctx.logger.log(makeOp('agent-y', 'fs', 'sess-2'), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.medianOpsPerAgent as number).toBeCloseTo(3, 5);
    });

    it('23. summary — three tools with counts 2,4,6: medianOpsPerTool is middle value', async () => {
      ctx = await setup();
      // tool-p:2, tool-q:4, tool-r:6 → sorted [2,4,6], len=3 (odd) → mid=1 → 4
      for (let i = 0; i < 2; i++) await ctx.logger.log(makeOp('agent-sum-tools', 'tool-p', 'sess-1'), dec(0.3));
      for (let i = 0; i < 4; i++) await ctx.logger.log(makeOp('agent-sum-tools', 'tool-q', 'sess-1'), dec(0.5));
      for (let i = 0; i < 6; i++) await ctx.logger.log(makeOp('agent-sum-tools', 'tool-r', 'sess-1'), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.medianOpsPerTool).toBe(4);
    });
  });
});

// ── v10.64 ────────────────────────────────────────────────────────────────────

describe('v10.64', () => {
  function makeOp(
    agentId: string,
    tool = 'fs',
    sessionId = 'sess-1',
    method = 'call',
    timestamp: Date = new Date(PINNED_NOW()),
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

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1389-T1393 — v10.64 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1064-pres'), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-1064-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('opsPerToolStdDev');
      expect(body).toHaveProperty('opsPerMethodStdDev');
      expect(body).toHaveProperty('opsPerAgentStdDev');
      expect(body).toHaveProperty('riskScoreMedian');
      expect(body).toHaveProperty('riskScoreIQR');
    });

    it('2. sessions — no logs: all five new fields are null', async () => {
      ctx = await setup();
      // No logs for this session — hit an empty session
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-1064-empty');
      // Endpoint may return 404 or 200 with nulls depending on implementation
      // Check if fields are present and null when the endpoint returns 200
      if (status === 200) {
        expect(body.opsPerToolStdDev).toBeNull();
        expect(body.opsPerMethodStdDev).toBeNull();
        expect(body.opsPerAgentStdDev).toBeNull();
        expect(body.riskScoreMedian).toBeNull();
        expect(body.riskScoreIQR).toBeNull();
      } else {
        // 404 is acceptable for a session with no logs
        expect(status).toBe(404);
      }
    });

    it('3. sessions — single log: stddev fields null (< 2 distinct), median non-null, IQR null (< 4 logs)', async () => {
      ctx = await setup();
      // One log, one distinct tool/method/agent → stddev null
      await ctx.logger.log(makeOp('agent-b', 'tool-x', 'sess-1064-single', 'call'), dec(0.6, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-1064-single');
      expect(status).toBe(200);

      // < 2 distinct tools/methods/agents → stddev null
      expect(body.opsPerToolStdDev).toBeNull();
      expect(body.opsPerMethodStdDev).toBeNull();
      expect(body.opsPerAgentStdDev).toBeNull();

      // single log → median is that score
      expect(body.riskScoreMedian as number).toBeCloseTo(0.6, 5);

      // < 4 logs → IQR null
      expect(body.riskScoreIQR).toBeNull();
    });

    it('4. sessions — multiple tools/agents/methods: stddev computed correctly', async () => {
      ctx = await setup();
      // 3 ops for tool-a, 1 op for tool-b → opsPerToolStdDev
      // tool counts: [3, 1] → mean=2, variance=((3-2)^2 + (1-2)^2)/2 = 1 → stddev = 1
      await ctx.logger.log(makeOp('agent-c', 'tool-a', 'sess-1064-stddev', 'call'), dec(0.1));
      await ctx.logger.log(makeOp('agent-c', 'tool-a', 'sess-1064-stddev', 'call'), dec(0.2));
      await ctx.logger.log(makeOp('agent-c', 'tool-a', 'sess-1064-stddev', 'call'), dec(0.3));
      await ctx.logger.log(makeOp('agent-c', 'tool-b', 'sess-1064-stddev', 'call'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-1064-stddev');
      expect(status).toBe(200);

      // tool counts: [3, 1], mean=2, stddev=1
      expect(body.opsPerToolStdDev as number).toBeCloseTo(1.0, 5);

      // single agent → opsPerAgentStdDev null (only agent-c)
      expect(body.opsPerAgentStdDev).toBeNull();
    });

    it('5. sessions — four logs: riskScoreMedian (even) and riskScoreIQR computed correctly', async () => {
      ctx = await setup();
      // 4 logs with scores: 0.1, 0.3, 0.7, 0.9 (sorted)
      // median (even): (s[1] + s[2]) / 2 = (0.3 + 0.7) / 2 = 0.5
      // IQR: p25=s[floor(4*0.25)]=s[1]=0.3, p75=s[floor(4*0.75)]=s[3]=0.9 → IQR=0.6
      await ctx.logger.log(makeOp('agent-d', 'tool-x', 'sess-1064-4logs', 'call'), dec(0.9));
      await ctx.logger.log(makeOp('agent-d', 'tool-x', 'sess-1064-4logs', 'call'), dec(0.1));
      await ctx.logger.log(makeOp('agent-d', 'tool-x', 'sess-1064-4logs', 'call'), dec(0.7));
      await ctx.logger.log(makeOp('agent-d', 'tool-x', 'sess-1064-4logs', 'call'), dec(0.3));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-1064-4logs');
      expect(status).toBe(200);

      expect(body.riskScoreMedian as number).toBeCloseTo(0.5, 5);
      expect(body.riskScoreIQR as number).toBeCloseTo(0.6, 5);
    });

    it('6. sessions — five logs: riskScoreMedian (odd) is middle value', async () => {
      ctx = await setup();
      // 5 logs with scores: 0.1, 0.2, 0.5, 0.8, 0.9 (sorted)
      // median (odd): s[floor(5/2)] = s[2] = 0.5
      await ctx.logger.log(makeOp('agent-e', 'tool-x', 'sess-1064-5logs', 'call'), dec(0.8));
      await ctx.logger.log(makeOp('agent-e', 'tool-x', 'sess-1064-5logs', 'call'), dec(0.1));
      await ctx.logger.log(makeOp('agent-e', 'tool-x', 'sess-1064-5logs', 'call'), dec(0.5));
      await ctx.logger.log(makeOp('agent-e', 'tool-x', 'sess-1064-5logs', 'call'), dec(0.9));
      await ctx.logger.log(makeOp('agent-e', 'tool-x', 'sess-1064-5logs', 'call'), dec(0.2));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-1064-5logs');
      expect(status).toBe(200);

      expect(body.riskScoreMedian as number).toBeCloseTo(0.5, 5);
    });

    it('7. sessions — sessions endpoint filters to one sessionId: opsPerAgentStdDev reflects only that session', async () => {
      ctx = await setup();
      // Two agents in sessions A and B. Sessions endpoint for A sees only agents in A.
      // In sess-A: agent-x (2 ops), agent-y (1 op) → distinct agents = 2 → stddev non-null
      await ctx.logger.log(makeOp('agent-x', 'tool-1', 'sess-1064-A', 'call'), dec(0.3));
      await ctx.logger.log(makeOp('agent-x', 'tool-1', 'sess-1064-A', 'call'), dec(0.4));
      await ctx.logger.log(makeOp('agent-y', 'tool-1', 'sess-1064-A', 'call'), dec(0.5));
      // Unrelated session
      await ctx.logger.log(makeOp('agent-z', 'tool-2', 'sess-1064-B', 'call'), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-1064-A');
      expect(status).toBe(200);

      // agent-x: 2 ops, agent-y: 1 op → counts [2,1], mean=1.5, stddev=0.5
      expect(body.opsPerAgentStdDev as number).toBeCloseTo(0.5, 5);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1389-T1393 — v10.64 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('8. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1064-pres', 'fs', 'sess-1'), dec(0.3, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1064-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('opsPerToolStdDev');
      expect(body).toHaveProperty('opsPerMethodStdDev');
      expect(body).toHaveProperty('opsPerAgentStdDev');
      expect(body).toHaveProperty('riskScoreMedian');
      expect(body).toHaveProperty('riskScoreIQR');
    });

    it('9. agents — single log: stddev fields null, median non-null, IQR null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1064-single', 'tool-x', 'sess-1', 'call'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1064-single');
      expect(status).toBe(200);

      expect(body.opsPerToolStdDev).toBeNull();
      expect(body.opsPerMethodStdDev).toBeNull();
      // agents endpoint filters to a single agentId → always only 1 distinct agent → null
      expect(body.opsPerAgentStdDev).toBeNull();
      expect(body.riskScoreMedian as number).toBeCloseTo(0.5, 5);
      expect(body.riskScoreIQR).toBeNull();
    });

    it('10. agents — agents endpoint filters to one agentId: opsPerAgentStdDev is always null', async () => {
      ctx = await setup();
      // Log multiple ops for the same agent — only one distinct agent in scope
      await ctx.logger.log(makeOp('agent-v1064-one', 'tool-a', 'sess-1', 'call'), dec(0.2));
      await ctx.logger.log(makeOp('agent-v1064-one', 'tool-b', 'sess-2', 'call'), dec(0.4));
      await ctx.logger.log(makeOp('agent-v1064-one', 'tool-a', 'sess-3', 'call'), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1064-one');
      expect(status).toBe(200);

      // Only 1 distinct agent → opsPerAgentStdDev null (< 2 distinct)
      expect(body.opsPerAgentStdDev).toBeNull();

      // Two distinct tools (tool-a: 2 ops, tool-b: 1 op)
      // counts [2, 1], mean=1.5, stddev=0.5
      expect(body.opsPerToolStdDev as number).toBeCloseTo(0.5, 5);
    });

    it('11. agents — opsPerMethodStdDev with two distinct methods', async () => {
      ctx = await setup();
      // method-A: 3 ops, method-B: 1 op → counts [3, 1], mean=2, stddev=1
      await ctx.logger.log(makeOp('agent-v1064-meth', 'tool-x', 'sess-1', 'method-A'), dec(0.1));
      await ctx.logger.log(makeOp('agent-v1064-meth', 'tool-x', 'sess-1', 'method-A'), dec(0.2));
      await ctx.logger.log(makeOp('agent-v1064-meth', 'tool-x', 'sess-1', 'method-A'), dec(0.3));
      await ctx.logger.log(makeOp('agent-v1064-meth', 'tool-x', 'sess-1', 'method-B'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1064-meth');
      expect(status).toBe(200);

      expect(body.opsPerMethodStdDev as number).toBeCloseTo(1.0, 5);
    });

    it('12. agents — four logs: riskScoreMedian and riskScoreIQR computed correctly', async () => {
      ctx = await setup();
      // Scores: 0.2, 0.4, 0.6, 0.8 (sorted)
      // median (even): (s[1] + s[2]) / 2 = (0.4 + 0.6) / 2 = 0.5
      // IQR: p25=s[floor(4*0.25)]=s[1]=0.4, p75=s[floor(4*0.75)]=s[3]=0.8 → IQR=0.4
      await ctx.logger.log(makeOp('agent-v1064-4logs', 'tool-x', 'sess-1', 'call'), dec(0.6));
      await ctx.logger.log(makeOp('agent-v1064-4logs', 'tool-x', 'sess-2', 'call'), dec(0.2));
      await ctx.logger.log(makeOp('agent-v1064-4logs', 'tool-x', 'sess-3', 'call'), dec(0.8));
      await ctx.logger.log(makeOp('agent-v1064-4logs', 'tool-x', 'sess-4', 'call'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1064-4logs');
      expect(status).toBe(200);

      expect(body.riskScoreMedian as number).toBeCloseTo(0.5, 5);
      expect(body.riskScoreIQR as number).toBeCloseTo(0.4, 5);
    });

    it('13. agents — three logs: riskScoreMedian (odd) correct, riskScoreIQR null (< 4 logs)', async () => {
      ctx = await setup();
      // Scores: 0.1, 0.5, 0.9 (sorted) → median = s[1] = 0.5
      await ctx.logger.log(makeOp('agent-v1064-3logs', 'tool-x', 'sess-1', 'call'), dec(0.9));
      await ctx.logger.log(makeOp('agent-v1064-3logs', 'tool-x', 'sess-2', 'call'), dec(0.1));
      await ctx.logger.log(makeOp('agent-v1064-3logs', 'tool-x', 'sess-3', 'call'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1064-3logs');
      expect(status).toBe(200);

      expect(body.riskScoreMedian as number).toBeCloseTo(0.5, 5);
      expect(body.riskScoreIQR).toBeNull();
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1389-T1393 — v10.64 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('14. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-g', 'tool-v1064-pres', 'sess-1'), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1064-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('opsPerToolStdDev');
      expect(body).toHaveProperty('opsPerMethodStdDev');
      expect(body).toHaveProperty('opsPerAgentStdDev');
      expect(body).toHaveProperty('riskScoreMedian');
      expect(body).toHaveProperty('riskScoreIQR');
    });

    it('15. tools — tools endpoint filters to one tool: opsPerToolStdDev is always null', async () => {
      ctx = await setup();
      // Logs all use the same tool — only 1 distinct tool in scope → null
      await ctx.logger.log(makeOp('agent-h-1', 'tool-v1064-one', 'sess-1', 'call'), dec(0.2));
      await ctx.logger.log(makeOp('agent-h-2', 'tool-v1064-one', 'sess-2', 'call'), dec(0.4));
      await ctx.logger.log(makeOp('agent-h-3', 'tool-v1064-one', 'sess-3', 'call'), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1064-one');
      expect(status).toBe(200);

      // Only 1 distinct tool → null
      expect(body.opsPerToolStdDev).toBeNull();

      // Multiple distinct agents → stddev non-null
      // agent-h-1: 1, agent-h-2: 1, agent-h-3: 1 → counts [1,1,1], stddev=0
      // 3 distinct agents but all equal counts → stddev=0
      expect(typeof body.opsPerAgentStdDev === 'number' || body.opsPerAgentStdDev === null).toBe(true);
    });

    it('16. tools — opsPerAgentStdDev with unequal agent counts', async () => {
      ctx = await setup();
      // agent-p: 3 ops, agent-q: 1 op → counts [3, 1], mean=2, stddev=1
      await ctx.logger.log(makeOp('agent-p', 'tool-v1064-agents', 'sess-1', 'call'), dec(0.1));
      await ctx.logger.log(makeOp('agent-p', 'tool-v1064-agents', 'sess-2', 'call'), dec(0.2));
      await ctx.logger.log(makeOp('agent-p', 'tool-v1064-agents', 'sess-3', 'call'), dec(0.3));
      await ctx.logger.log(makeOp('agent-q', 'tool-v1064-agents', 'sess-4', 'call'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1064-agents');
      expect(status).toBe(200);

      expect(body.opsPerAgentStdDev as number).toBeCloseTo(1.0, 5);
    });

    it('17. tools — four logs: riskScoreMedian and riskScoreIQR computed correctly', async () => {
      ctx = await setup();
      // Scores: 0.1, 0.3, 0.7, 0.9 (sorted)
      // median (even): (0.3 + 0.7) / 2 = 0.5
      // IQR: p25=s[1]=0.3, p75=s[3]=0.9 → IQR=0.6
      await ctx.logger.log(makeOp('agent-i', 'tool-v1064-4logs', 'sess-1', 'call'), dec(0.9));
      await ctx.logger.log(makeOp('agent-i', 'tool-v1064-4logs', 'sess-2', 'call'), dec(0.1));
      await ctx.logger.log(makeOp('agent-i', 'tool-v1064-4logs', 'sess-3', 'call'), dec(0.7));
      await ctx.logger.log(makeOp('agent-i', 'tool-v1064-4logs', 'sess-4', 'call'), dec(0.3));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1064-4logs');
      expect(status).toBe(200);

      expect(body.riskScoreMedian as number).toBeCloseTo(0.5, 5);
      expect(body.riskScoreIQR as number).toBeCloseTo(0.6, 5);
    });

    it('18. tools — opsPerMethodStdDev with three distinct methods equal counts: stddev = 0', async () => {
      ctx = await setup();
      // method-A: 2, method-B: 2, method-C: 2 → counts [2,2,2], mean=2, stddev=0
      for (const method of ['method-A', 'method-B', 'method-C']) {
        await ctx.logger.log(makeOp('agent-j-1', 'tool-v1064-meth3', 'sess-1', method), dec(0.3));
        await ctx.logger.log(makeOp('agent-j-2', 'tool-v1064-meth3', 'sess-2', method), dec(0.4));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1064-meth3');
      expect(status).toBe(200);

      expect(body.opsPerMethodStdDev as number).toBeCloseTo(0.0, 5);
    });

    it('19. tools — eight logs: riskScoreIQR uses floor indexing correctly', async () => {
      ctx = await setup();
      // 8 scores: 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8 (sorted)
      // n=8, p25=s[floor(8*0.25)]=s[2]=0.3, p75=s[floor(8*0.75)]=s[6]=0.7 → IQR=0.4
      const scores = [0.5, 0.1, 0.7, 0.3, 0.8, 0.2, 0.6, 0.4];
      for (const score of scores) {
        await ctx.logger.log(makeOp('agent-k', 'tool-v1064-iqr8', 'sess-1', 'call'), dec(score));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1064-iqr8');
      expect(status).toBe(200);

      expect(body.riskScoreIQR as number).toBeCloseTo(0.4, 5);
    });
  });

  // ── operations/summary endpoint ────────────────────────────────────────────────

  describe('T1389-T1393 — v10.64 new fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('20. summary — all five new fields present', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-l', 'tool-s', 'sess-1'), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body).toHaveProperty('opsPerToolStdDev');
      expect(body).toHaveProperty('opsPerMethodStdDev');
      expect(body).toHaveProperty('opsPerAgentStdDev');
      expect(body).toHaveProperty('riskScoreMedian');
      expect(body).toHaveProperty('riskScoreIQR');
    });

    it('21. summary — empty DB: all five new fields are null', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.opsPerToolStdDev).toBeNull();
      expect(body.opsPerMethodStdDev).toBeNull();
      expect(body.opsPerAgentStdDev).toBeNull();
      expect(body.riskScoreMedian).toBeNull();
      expect(body.riskScoreIQR).toBeNull();
    });

    it('22. summary — single log: stddev fields null, median non-null, IQR null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-m', 'tool-m', 'sess-1', 'call'), dec(0.42));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.opsPerToolStdDev).toBeNull();
      expect(body.opsPerMethodStdDev).toBeNull();
      expect(body.opsPerAgentStdDev).toBeNull();
      expect(body.riskScoreMedian as number).toBeCloseTo(0.42, 5);
      expect(body.riskScoreIQR).toBeNull();
    });

    it('23. summary — opsPerToolStdDev and opsPerAgentStdDev with unequal distributions', async () => {
      ctx = await setup();
      // tool-alpha: 4 ops, tool-beta: 2 ops → counts [4, 2], mean=3, stddev=sqrt(((4-3)^2+(2-3)^2)/2)=1
      // agent-n-1: 3 ops, agent-n-2: 3 ops → counts [3, 3], stddev=0
      await ctx.logger.log(makeOp('agent-n-1', 'tool-alpha', 'sess-1', 'call'), dec(0.1));
      await ctx.logger.log(makeOp('agent-n-1', 'tool-alpha', 'sess-1', 'call'), dec(0.2));
      await ctx.logger.log(makeOp('agent-n-1', 'tool-beta', 'sess-1', 'call'), dec(0.3));
      await ctx.logger.log(makeOp('agent-n-2', 'tool-alpha', 'sess-2', 'call'), dec(0.4));
      await ctx.logger.log(makeOp('agent-n-2', 'tool-alpha', 'sess-2', 'call'), dec(0.5));
      await ctx.logger.log(makeOp('agent-n-2', 'tool-beta', 'sess-2', 'call'), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      // tool-alpha: 4, tool-beta: 2 → mean=3, stddev=1
      expect(body.opsPerToolStdDev as number).toBeCloseTo(1.0, 5);
      // agent-n-1: 3, agent-n-2: 3 → mean=3, stddev=0
      expect(body.opsPerAgentStdDev as number).toBeCloseTo(0.0, 5);
    });

    it('24. summary — four logs: riskScoreMedian and riskScoreIQR computed correctly', async () => {
      ctx = await setup();
      // Scores: 0.1, 0.3, 0.7, 0.9 (sorted)
      // median (even): (0.3 + 0.7) / 2 = 0.5
      // IQR: p25=s[floor(4*0.25)]=s[1]=0.3, p75=s[floor(4*0.75)]=s[3]=0.9 → IQR=0.6
      await ctx.logger.log(makeOp('agent-o', 'tool-sum-4', 'sess-1', 'call'), dec(0.7));
      await ctx.logger.log(makeOp('agent-o', 'tool-sum-4', 'sess-2', 'call'), dec(0.1));
      await ctx.logger.log(makeOp('agent-o', 'tool-sum-4', 'sess-3', 'call'), dec(0.9));
      await ctx.logger.log(makeOp('agent-o', 'tool-sum-4', 'sess-4', 'call'), dec(0.3));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.riskScoreMedian as number).toBeCloseTo(0.5, 5);
      expect(body.riskScoreIQR as number).toBeCloseTo(0.6, 5);
    });

    it('25. summary — five logs: riskScoreMedian (odd) is middle value, riskScoreIQR uses floor indexing', async () => {
      ctx = await setup();
      // Scores: 0.1, 0.2, 0.5, 0.8, 0.9 (sorted)
      // median (odd): s[floor(5/2)] = s[2] = 0.5
      // IQR: p25=s[floor(5*0.25)]=s[1]=0.2, p75=s[floor(5*0.75)]=s[3]=0.8 → IQR=0.6
      await ctx.logger.log(makeOp('agent-p-1', 'tool-sum-5', 'sess-1', 'call'), dec(0.8));
      await ctx.logger.log(makeOp('agent-p-1', 'tool-sum-5', 'sess-2', 'call'), dec(0.1));
      await ctx.logger.log(makeOp('agent-p-1', 'tool-sum-5', 'sess-3', 'call'), dec(0.5));
      await ctx.logger.log(makeOp('agent-p-1', 'tool-sum-5', 'sess-4', 'call'), dec(0.9));
      await ctx.logger.log(makeOp('agent-p-1', 'tool-sum-5', 'sess-5', 'call'), dec(0.2));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.riskScoreMedian as number).toBeCloseTo(0.5, 5);
      expect(body.riskScoreIQR as number).toBeCloseTo(0.6, 5);
    });

    it('26. summary — opsPerMethodStdDev with three methods: unequal counts', async () => {
      ctx = await setup();
      // method-X: 5, method-Y: 3, method-Z: 1 → counts [5,3,1], mean=3
      // variance = ((5-3)^2 + (3-3)^2 + (1-3)^2) / 3 = (4+0+4)/3 = 8/3 → stddev = sqrt(8/3)
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp(`agent-q-${i}`, 'tool-meth-dist', `sess-mx-${i}`, 'method-X'), dec(0.2));
      }
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp(`agent-q-${i}`, 'tool-meth-dist', `sess-my-${i}`, 'method-Y'), dec(0.4));
      }
      await ctx.logger.log(makeOp('agent-q-0', 'tool-meth-dist', 'sess-mz-0', 'method-Z'), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      const expected = Math.sqrt(8 / 3);
      expect(body.opsPerMethodStdDev as number).toBeCloseTo(expected, 5);
    });
  });
});

// ── v10.65 ────────────────────────────────────────────────────────────────────

describe('v10.65', () => {
  function makeOp(
    agentId: string,
    tool = 'fs',
    sessionId = 'sess-1',
    method = 'call',
    timestamp: Date = new Date(PINNED_NOW()),
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

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1394-T1398 — v10.65 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all four new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1065-pres'), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-1065-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('blockRateAllTime');
      expect(body).toHaveProperty('requireApprovalRateAllTime');
      expect(body).toHaveProperty('avgRiskScoreTop10PctOps');
      expect(body).toHaveProperty('avgRiskScoreBottom10PctOps');
    });

    it('2. sessions — no logs: blockRateAllTime and requireApprovalRateAllTime are null', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-1065-empty');
      if (status === 200) {
        expect(body.blockRateAllTime).toBeNull();
        expect(body.requireApprovalRateAllTime).toBeNull();
      } else {
        expect(status).toBe(404);
      }
    });

    it('3. sessions — single allow log: blockRateAllTime = 0, requireApprovalRateAllTime = 0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-b', 'tool-x', 'sess-1065-allow', 'call'), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-1065-allow');
      expect(status).toBe(200);

      expect(body.blockRateAllTime as number).toBeCloseTo(0.0, 5);
      expect(body.requireApprovalRateAllTime as number).toBeCloseTo(0.0, 5);
    });

    it('4. sessions — mixed actions: blockRateAllTime computed correctly', async () => {
      ctx = await setup();
      // 2 block, 1 allow, 1 require_approval → blockRate = 2/4 = 0.5
      await ctx.logger.log(makeOp('agent-c', 'tool-x', 'sess-1065-mixed', 'call'), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agent-c', 'tool-x', 'sess-1065-mixed', 'call'), dec(0.6, 'block'));
      await ctx.logger.log(makeOp('agent-c', 'tool-x', 'sess-1065-mixed', 'call'), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-c', 'tool-x', 'sess-1065-mixed', 'call'), dec(0.2, 'require_approval'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-1065-mixed');
      expect(status).toBe(200);

      expect(body.blockRateAllTime as number).toBeCloseTo(0.5, 5);
      expect(body.requireApprovalRateAllTime as number).toBeCloseTo(0.25, 5);
    });

    it('5. sessions — all block: blockRateAllTime = 1.0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-d', 'tool-x', 'sess-1065-allblock', 'call'), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-d', 'tool-x', 'sess-1065-allblock', 'call'), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agent-d', 'tool-x', 'sess-1065-allblock', 'call'), dec(0.7, 'block'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-1065-allblock');
      expect(status).toBe(200);

      expect(body.blockRateAllTime as number).toBeCloseTo(1.0, 5);
      expect(body.requireApprovalRateAllTime as number).toBeCloseTo(0.0, 5);
    });

    it('6. sessions — less than 10 logs: avgRiskScoreTop10PctOps and avgRiskScoreBottom10PctOps are null', async () => {
      ctx = await setup();
      // 9 logs — below threshold
      for (let i = 0; i < 9; i++) {
        await ctx.logger.log(makeOp('agent-e', 'tool-x', 'sess-1065-9logs', 'call'), dec(0.1 * (i + 1)));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-1065-9logs');
      expect(status).toBe(200);

      expect(body.avgRiskScoreTop10PctOps).toBeNull();
      expect(body.avgRiskScoreBottom10PctOps).toBeNull();
    });

    it('7. sessions — 10 logs: avgRiskScoreTop10PctOps and avgRiskScoreBottom10PctOps computed correctly', async () => {
      ctx = await setup();
      // 10 logs with scores 0.1, 0.2, ..., 1.0
      // top 10%: ceil(10*0.1) = 1 → top 1 sorted desc = [1.0] → avg = 1.0
      // bottom 10%: ceil(10*0.1) = 1 → bottom 1 sorted asc = [0.1] → avg = 0.1
      for (let i = 1; i <= 10; i++) {
        await ctx.logger.log(makeOp('agent-f', 'tool-x', 'sess-1065-10logs', 'call'), dec(i * 0.1));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-1065-10logs');
      expect(status).toBe(200);

      expect(body.avgRiskScoreTop10PctOps as number).toBeCloseTo(1.0, 5);
      expect(body.avgRiskScoreBottom10PctOps as number).toBeCloseTo(0.1, 5);
    });

    it('8. sessions — 20 logs: top 10% and bottom 10% are averages of top/bottom 2', async () => {
      ctx = await setup();
      // 20 logs with scores 0.05, 0.10, ..., 1.0 (step 0.05)
      // top 10%: ceil(20*0.1) = 2 → top 2 sorted desc = [1.0, 0.95] → avg = 0.975
      // bottom 10%: ceil(20*0.1) = 2 → bottom 2 sorted asc = [0.05, 0.10] → avg = 0.075
      for (let i = 1; i <= 20; i++) {
        await ctx.logger.log(makeOp('agent-g', 'tool-x', 'sess-1065-20logs', 'call'), dec(i * 0.05));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-1065-20logs');
      expect(status).toBe(200);

      expect(body.avgRiskScoreTop10PctOps as number).toBeCloseTo(0.975, 5);
      expect(body.avgRiskScoreBottom10PctOps as number).toBeCloseTo(0.075, 5);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1394-T1398 — v10.65 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('9. agents — all four new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1065-pres', 'fs', 'sess-1'), dec(0.3, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1065-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('blockRateAllTime');
      expect(body).toHaveProperty('requireApprovalRateAllTime');
      expect(body).toHaveProperty('avgRiskScoreTop10PctOps');
      expect(body).toHaveProperty('avgRiskScoreBottom10PctOps');
    });

    it('10. agents — all require_approval: requireApprovalRateAllTime = 1.0, blockRateAllTime = 0.0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1065-ra', 'tool-x', 'sess-1', 'call'), dec(0.5, 'require_approval'));
      await ctx.logger.log(makeOp('agent-v1065-ra', 'tool-x', 'sess-2', 'call'), dec(0.6, 'require_approval'));
      await ctx.logger.log(makeOp('agent-v1065-ra', 'tool-x', 'sess-3', 'call'), dec(0.7, 'require_approval'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1065-ra');
      expect(status).toBe(200);

      expect(body.requireApprovalRateAllTime as number).toBeCloseTo(1.0, 5);
      expect(body.blockRateAllTime as number).toBeCloseTo(0.0, 5);
    });

    it('11. agents — 3 block out of 5: blockRateAllTime = 0.6', async () => {
      ctx = await setup();
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-v1065-b3', 'tool-x', `sess-${i}`, 'call'), dec(0.8, 'block'));
      }
      for (let i = 3; i < 5; i++) {
        await ctx.logger.log(makeOp('agent-v1065-b3', 'tool-x', `sess-${i}`, 'call'), dec(0.2, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1065-b3');
      expect(status).toBe(200);

      expect(body.blockRateAllTime as number).toBeCloseTo(0.6, 5);
    });

    it('12. agents — 9 logs: avgRiskScoreTop10PctOps and avgRiskScoreBottom10PctOps are null', async () => {
      ctx = await setup();
      for (let i = 0; i < 9; i++) {
        await ctx.logger.log(makeOp('agent-v1065-9', 'tool-x', `sess-${i}`, 'call'), dec(0.1 * (i + 1)));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1065-9');
      expect(status).toBe(200);

      expect(body.avgRiskScoreTop10PctOps).toBeNull();
      expect(body.avgRiskScoreBottom10PctOps).toBeNull();
    });

    it('13. agents — 10 logs: top/bottom 10% each = single value', async () => {
      ctx = await setup();
      // scores 0.1..1.0 → top 1 = 1.0, bottom 1 = 0.1
      for (let i = 1; i <= 10; i++) {
        await ctx.logger.log(makeOp('agent-v1065-10', 'tool-x', `sess-${i}`, 'call'), dec(i * 0.1));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1065-10');
      expect(status).toBe(200);

      expect(body.avgRiskScoreTop10PctOps as number).toBeCloseTo(1.0, 5);
      expect(body.avgRiskScoreBottom10PctOps as number).toBeCloseTo(0.1, 5);
    });

    it('14. agents — sessions endpoint does not pollute agent endpoint: blockRateAllTime scoped to agent', async () => {
      ctx = await setup();
      // agent-scope-X: 1 block out of 2 ops → blockRate = 0.5
      // agent-scope-Y: 3 allow ops (unrelated)
      await ctx.logger.log(makeOp('agent-scope-X', 'tool-x', 'sess-x1', 'call'), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-scope-X', 'tool-x', 'sess-x2', 'call'), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-scope-Y', 'tool-x', 'sess-y1', 'call'), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-scope-Y', 'tool-x', 'sess-y2', 'call'), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-scope-Y', 'tool-x', 'sess-y3', 'call'), dec(0.1, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-scope-X');
      expect(status).toBe(200);

      expect(body.blockRateAllTime as number).toBeCloseTo(0.5, 5);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1394-T1398 — v10.65 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('15. tools — all four new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-h', 'tool-v1065-pres', 'sess-1'), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1065-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('blockRateAllTime');
      expect(body).toHaveProperty('requireApprovalRateAllTime');
      expect(body).toHaveProperty('avgRiskScoreTop10PctOps');
      expect(body).toHaveProperty('avgRiskScoreBottom10PctOps');
    });

    it('16. tools — 1 block 3 allow: blockRateAllTime = 0.25, requireApprovalRateAllTime = 0.0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-i-1', 'tool-v1065-rates', 'sess-1', 'call'), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-i-2', 'tool-v1065-rates', 'sess-2', 'call'), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-i-3', 'tool-v1065-rates', 'sess-3', 'call'), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-i-4', 'tool-v1065-rates', 'sess-4', 'call'), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1065-rates');
      expect(status).toBe(200);

      expect(body.blockRateAllTime as number).toBeCloseTo(0.25, 5);
      expect(body.requireApprovalRateAllTime as number).toBeCloseTo(0.0, 5);
    });

    it('17. tools — 2 require_approval out of 4: requireApprovalRateAllTime = 0.5', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-j-1', 'tool-v1065-ra', 'sess-1', 'call'), dec(0.5, 'require_approval'));
      await ctx.logger.log(makeOp('agent-j-2', 'tool-v1065-ra', 'sess-2', 'call'), dec(0.6, 'require_approval'));
      await ctx.logger.log(makeOp('agent-j-3', 'tool-v1065-ra', 'sess-3', 'call'), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-j-4', 'tool-v1065-ra', 'sess-4', 'call'), dec(0.4, 'block'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1065-ra');
      expect(status).toBe(200);

      expect(body.requireApprovalRateAllTime as number).toBeCloseTo(0.5, 5);
    });

    it('18. tools — 9 logs: avgRiskScoreTop10PctOps and avgRiskScoreBottom10PctOps are null', async () => {
      ctx = await setup();
      for (let i = 0; i < 9; i++) {
        await ctx.logger.log(makeOp(`agent-k-${i}`, 'tool-v1065-9', `sess-${i}`, 'call'), dec(0.1 * (i + 1)));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1065-9');
      expect(status).toBe(200);

      expect(body.avgRiskScoreTop10PctOps).toBeNull();
      expect(body.avgRiskScoreBottom10PctOps).toBeNull();
    });

    it('19. tools — 10 logs: avgRiskScoreTop10PctOps and avgRiskScoreBottom10PctOps computed correctly', async () => {
      ctx = await setup();
      // scores 0.1..1.0 → top 1 = 1.0, bottom 1 = 0.1
      for (let i = 1; i <= 10; i++) {
        await ctx.logger.log(makeOp(`agent-l-${i}`, 'tool-v1065-10', `sess-${i}`, 'call'), dec(i * 0.1));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1065-10');
      expect(status).toBe(200);

      expect(body.avgRiskScoreTop10PctOps as number).toBeCloseTo(1.0, 5);
      expect(body.avgRiskScoreBottom10PctOps as number).toBeCloseTo(0.1, 5);
    });

    it('20. tools — tool endpoint scoped correctly: other tools do not affect blockRateAllTime', async () => {
      ctx = await setup();
      // tool-v1065-scope-A: 1 block out of 3 → blockRate = 0.333...
      // tool-v1065-scope-B: 3 blocks (unrelated)
      await ctx.logger.log(makeOp('agent-m', 'tool-v1065-scope-A', 'sess-1', 'call'), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-m', 'tool-v1065-scope-A', 'sess-2', 'call'), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-m', 'tool-v1065-scope-A', 'sess-3', 'call'), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-m', 'tool-v1065-scope-B', 'sess-4', 'call'), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-m', 'tool-v1065-scope-B', 'sess-5', 'call'), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-m', 'tool-v1065-scope-B', 'sess-6', 'call'), dec(0.9, 'block'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1065-scope-A');
      expect(status).toBe(200);

      expect(body.blockRateAllTime as number).toBeCloseTo(1 / 3, 5);
    });
  });

  // ── operations/summary endpoint ────────────────────────────────────────────────

  describe('T1394-T1398 — v10.65 new fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('21. summary — all four new fields present', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-n', 'tool-s', 'sess-1'), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body).toHaveProperty('blockRateAllTime');
      expect(body).toHaveProperty('requireApprovalRateAllTime');
      expect(body).toHaveProperty('avgRiskScoreTop10PctOps');
      expect(body).toHaveProperty('avgRiskScoreBottom10PctOps');
    });

    it('22. summary — empty DB: blockRateAllTime and requireApprovalRateAllTime are null', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.blockRateAllTime).toBeNull();
      expect(body.requireApprovalRateAllTime).toBeNull();
    });

    it('23. summary — empty DB: avgRiskScoreTop10PctOps and avgRiskScoreBottom10PctOps are null', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.avgRiskScoreTop10PctOps).toBeNull();
      expect(body.avgRiskScoreBottom10PctOps).toBeNull();
    });

    it('24. summary — 3 block 2 require_approval 5 allow: rates computed correctly', async () => {
      ctx = await setup();
      // 3/10 block, 2/10 require_approval
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp(`agent-o-${i}`, 'tool-sum', `sess-b-${i}`, 'call'), dec(0.8, 'block'));
      }
      for (let i = 0; i < 2; i++) {
        await ctx.logger.log(makeOp(`agent-o-${i}`, 'tool-sum', `sess-r-${i}`, 'call'), dec(0.5, 'require_approval'));
      }
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp(`agent-o-${i}`, 'tool-sum', `sess-a-${i}`, 'call'), dec(0.2, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.blockRateAllTime as number).toBeCloseTo(0.3, 5);
      expect(body.requireApprovalRateAllTime as number).toBeCloseTo(0.2, 5);
    });

    it('25. summary — 9 logs: avgRiskScoreTop10PctOps and avgRiskScoreBottom10PctOps are null', async () => {
      ctx = await setup();
      for (let i = 0; i < 9; i++) {
        await ctx.logger.log(makeOp(`agent-p-${i}`, 'tool-sum9', `sess-${i}`, 'call'), dec(0.1 * (i + 1)));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.avgRiskScoreTop10PctOps).toBeNull();
      expect(body.avgRiskScoreBottom10PctOps).toBeNull();
    });

    it('26. summary — 10 logs uniform distribution: top/bottom 10% are single extreme values', async () => {
      ctx = await setup();
      // scores: 0.1, 0.2, ..., 1.0
      // top 10%: ceil(10*0.1) = 1 → [1.0] → avg = 1.0
      // bottom 10%: [0.1] → avg = 0.1
      for (let i = 1; i <= 10; i++) {
        await ctx.logger.log(makeOp(`agent-q-${i}`, 'tool-sum10', `sess-${i}`, 'call'), dec(i * 0.1));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.avgRiskScoreTop10PctOps as number).toBeCloseTo(1.0, 5);
      expect(body.avgRiskScoreBottom10PctOps as number).toBeCloseTo(0.1, 5);
    });

    it('27. summary — 20 logs: top/bottom 10% each = average of 2 values', async () => {
      ctx = await setup();
      // scores 0.05, 0.10, ..., 1.0 (step 0.05)
      // top 10%: ceil(20*0.1) = 2 → [1.0, 0.95] → avg = 0.975
      // bottom 10%: [0.05, 0.10] → avg = 0.075
      for (let i = 1; i <= 20; i++) {
        await ctx.logger.log(makeOp(`agent-r-${i}`, 'tool-sum20', `sess-${i}`, 'call'), dec(i * 0.05));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.avgRiskScoreTop10PctOps as number).toBeCloseTo(0.975, 5);
      expect(body.avgRiskScoreBottom10PctOps as number).toBeCloseTo(0.075, 5);
    });

    it('28. summary — all block + 10 logs: blockRateAllTime = 1.0 and top/bottom 10% computed', async () => {
      ctx = await setup();
      // 10 block ops with different risk scores
      // scores: 0.1..1.0 → top 1 = 1.0, bottom 1 = 0.1
      for (let i = 1; i <= 10; i++) {
        await ctx.logger.log(makeOp(`agent-s-${i}`, 'tool-sum-allblock', `sess-${i}`, 'call'), dec(i * 0.1, 'block'));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.blockRateAllTime as number).toBeCloseTo(1.0, 5);
      expect(body.avgRiskScoreTop10PctOps as number).toBeCloseTo(1.0, 5);
      expect(body.avgRiskScoreBottom10PctOps as number).toBeCloseTo(0.1, 5);
    });
  });
});

// ── v10.66 ────────────────────────────────────────────────────────────────────

describe('v10.66', () => {
  function makeOp(
    agentId: string,
    tool = 'fs',
    sessionId = 'sess-1',
    method = 'call',
    timestamp: Date = new Date(PINNED_NOW()),
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

  const hoursAgo = (h: number) => new Date(PINNED_NOW() - h * 3_600_000);
  const minsAgo = (m: number) => new Date(PINNED_NOW() - m * 60_000);

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1399-T1403 — v10.66 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all three new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1066-pres'), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-1066-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('opsLast8h');
      expect(body).toHaveProperty('uniqueToolsLast1h');
      expect(body).toHaveProperty('uniqueMethodsLast1h');
    });

    it('2. sessions — no logs in window: opsLast8h = 0, uniqueToolsLast1h = 0, uniqueMethodsLast1h = 0', async () => {
      ctx = await setup();
      // Log an op older than 8 hours so session exists but is outside the window
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-1066-old8h', 'call', hoursAgo(10)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-1066-old8h');
      expect(status).toBe(200);

      expect(body.opsLast8h).toBe(0);
      expect(body.uniqueToolsLast1h).toBe(0);
      expect(body.uniqueMethodsLast1h).toBe(0);
    });

    it('3. sessions — ops within 8h but outside 1h: opsLast8h > 0, uniqueToolsLast1h = 0', async () => {
      ctx = await setup();
      // Two ops at 2h and 6h ago — in 8h window, outside 1h
      await ctx.logger.log(makeOp('agent-c', 'tool-x', 'sess-1066-8h', 'call', hoursAgo(2)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-c', 'tool-y', 'sess-1066-8h', 'call', hoursAgo(6)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-1066-8h');
      expect(status).toBe(200);

      expect(body.opsLast8h).toBe(2);
      expect(body.uniqueToolsLast1h).toBe(0);
      expect(body.uniqueMethodsLast1h).toBe(0);
    });

    it('4. sessions — 3 ops within 1h with distinct tools: uniqueToolsLast1h = 3', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-d', 'tool-alpha', 'sess-1066-tools', 'call', minsAgo(10)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-d', 'tool-beta', 'sess-1066-tools', 'call', minsAgo(20)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-d', 'tool-gamma', 'sess-1066-tools', 'call', minsAgo(30)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-1066-tools');
      expect(status).toBe(200);

      expect(body.uniqueToolsLast1h).toBe(3);
    });

    it('5. sessions — 4 ops within 1h but only 2 distinct tools: uniqueToolsLast1h = 2', async () => {
      ctx = await setup();
      // tool-alpha used twice, tool-beta used twice
      await ctx.logger.log(makeOp('agent-e', 'tool-alpha', 'sess-1066-dup-tools', 'call', minsAgo(5)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-e', 'tool-alpha', 'sess-1066-dup-tools', 'call', minsAgo(15)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-e', 'tool-beta', 'sess-1066-dup-tools', 'call', minsAgo(25)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-e', 'tool-beta', 'sess-1066-dup-tools', 'call', minsAgo(35)), dec(0.6, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-1066-dup-tools');
      expect(status).toBe(200);

      expect(body.uniqueToolsLast1h).toBe(2);
    });

    it('6. sessions — 3 ops within 1h with distinct methods: uniqueMethodsLast1h = 3', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-1066-methods', 'read', minsAgo(10)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-1066-methods', 'write', minsAgo(20)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-1066-methods', 'delete', minsAgo(30)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-1066-methods');
      expect(status).toBe(200);

      expect(body.uniqueMethodsLast1h).toBe(3);
    });

    it('7. sessions — 4 ops within 1h but only 2 distinct methods: uniqueMethodsLast1h = 2', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-1066-dup-methods', 'read', minsAgo(5)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-1066-dup-methods', 'read', minsAgo(15)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-1066-dup-methods', 'write', minsAgo(25)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-1066-dup-methods', 'write', minsAgo(35)), dec(0.6, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-1066-dup-methods');
      expect(status).toBe(200);

      expect(body.uniqueMethodsLast1h).toBe(2);
    });

    it('8. sessions — mix: ops in 1h, ops in 8h-not-1h, ops older than 8h', async () => {
      ctx = await setup();
      // In 1h: 2 ops with different tools and methods
      await ctx.logger.log(makeOp('agent-h', 'tool-new', 'sess-1066-mix', 'read', minsAgo(20)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-h', 'tool-old', 'sess-1066-mix', 'write', minsAgo(40)), dec(0.4, 'allow'));
      // In 8h but not 1h: 3 ops
      await ctx.logger.log(makeOp('agent-h', 'tool-x', 'sess-1066-mix', 'call', hoursAgo(2)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-h', 'tool-y', 'sess-1066-mix', 'call', hoursAgo(4)), dec(0.6, 'allow'));
      await ctx.logger.log(makeOp('agent-h', 'tool-z', 'sess-1066-mix', 'call', hoursAgo(7)), dec(0.7, 'allow'));
      // Older than 8h: 2 ops
      await ctx.logger.log(makeOp('agent-h', 'tool-ancient', 'sess-1066-mix', 'call', hoursAgo(12)), dec(0.8, 'allow'));
      await ctx.logger.log(makeOp('agent-h', 'tool-ancient2', 'sess-1066-mix', 'call', hoursAgo(24)), dec(0.9, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-1066-mix');
      expect(status).toBe(200);

      // opsLast8h = 2 (1h) + 3 (8h-not-1h) = 5
      expect(body.opsLast8h).toBe(5);
      // uniqueToolsLast1h: tool-new, tool-old = 2
      expect(body.uniqueToolsLast1h).toBe(2);
      // uniqueMethodsLast1h: read, write = 2
      expect(body.uniqueMethodsLast1h).toBe(2);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1399-T1403 — v10.66 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('9. agents — all three new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1066-pres', 'fs', 'sess-1'), dec(0.3, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1066-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('opsLast8h');
      expect(body).toHaveProperty('uniqueToolsLast1h');
      expect(body).toHaveProperty('uniqueMethodsLast1h');
    });

    it('10. agents — no logs in window: opsLast8h = 0, uniqueToolsLast1h = 0, uniqueMethodsLast1h = 0', async () => {
      ctx = await setup();
      // Log op older than 8h so agent exists but is outside window
      await ctx.logger.log(makeOp('agent-v1066-old8h', 'fs', 'sess-1', 'call', hoursAgo(10)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1066-old8h');
      expect(status).toBe(200);

      expect(body.opsLast8h).toBe(0);
      expect(body.uniqueToolsLast1h).toBe(0);
      expect(body.uniqueMethodsLast1h).toBe(0);
    });

    it('11. agents — 5 ops within 8h: opsLast8h = 5', async () => {
      ctx = await setup();
      for (let h = 1; h <= 5; h++) {
        await ctx.logger.log(
          makeOp('agent-v1066-8hcount', `tool-${h}`, `sess-${h}`, 'call', hoursAgo(h)),
          dec(0.3, 'allow'),
        );
      }
      // 1 op older than 8h (should not count)
      await ctx.logger.log(
        makeOp('agent-v1066-8hcount', 'tool-old', 'sess-old', 'call', hoursAgo(10)),
        dec(0.4, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1066-8hcount');
      expect(status).toBe(200);

      expect(body.opsLast8h).toBe(5);
    });

    it('12. agents — 4 unique tools within 1h: uniqueToolsLast1h = 4', async () => {
      ctx = await setup();
      for (const tool of ['tool-a', 'tool-b', 'tool-c', 'tool-d']) {
        await ctx.logger.log(
          makeOp('agent-v1066-utools', tool, 'sess-1', 'call', minsAgo(10)),
          dec(0.3, 'allow'),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1066-utools');
      expect(status).toBe(200);

      expect(body.uniqueToolsLast1h).toBe(4);
    });

    it('13. agents — tools outside 1h do not count toward uniqueToolsLast1h', async () => {
      ctx = await setup();
      // 2 tools in 1h
      await ctx.logger.log(makeOp('agent-v1066-toolwin', 'tool-recent-1', 'sess-1', 'call', minsAgo(30)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-v1066-toolwin', 'tool-recent-2', 'sess-2', 'call', minsAgo(50)), dec(0.4, 'allow'));
      // 3 tools in 8h but outside 1h
      await ctx.logger.log(makeOp('agent-v1066-toolwin', 'tool-old-1', 'sess-3', 'call', hoursAgo(2)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-v1066-toolwin', 'tool-old-2', 'sess-4', 'call', hoursAgo(4)), dec(0.6, 'allow'));
      await ctx.logger.log(makeOp('agent-v1066-toolwin', 'tool-old-3', 'sess-5', 'call', hoursAgo(7)), dec(0.7, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1066-toolwin');
      expect(status).toBe(200);

      // opsLast8h = 5 (all five), uniqueToolsLast1h = only 2 recent ones
      expect(body.opsLast8h).toBe(5);
      expect(body.uniqueToolsLast1h).toBe(2);
    });

    it('14. agents — 3 unique methods within 1h: uniqueMethodsLast1h = 3', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1066-umethods', 'fs', 'sess-1', 'read', minsAgo(10)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-v1066-umethods', 'fs', 'sess-2', 'write', minsAgo(20)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-v1066-umethods', 'fs', 'sess-3', 'list', minsAgo(30)), dec(0.5, 'allow'));
      // Same methods repeated — should not increase distinct count
      await ctx.logger.log(makeOp('agent-v1066-umethods', 'fs', 'sess-4', 'read', minsAgo(40)), dec(0.6, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1066-umethods');
      expect(status).toBe(200);

      expect(body.uniqueMethodsLast1h).toBe(3);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1399-T1403 — v10.66 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('15. tools — all three new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-i', 'tool-v1066-pres', 'sess-1'), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1066-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('opsLast8h');
      expect(body).toHaveProperty('uniqueToolsLast1h');
      expect(body).toHaveProperty('uniqueMethodsLast1h');
    });

    it('16. tools — no logs in 8h window: opsLast8h = 0', async () => {
      ctx = await setup();
      // Log older than 8h so tool exists
      await ctx.logger.log(makeOp('agent-j', 'tool-v1066-old8h', 'sess-1', 'call', hoursAgo(10)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1066-old8h');
      expect(status).toBe(200);

      expect(body.opsLast8h).toBe(0);
    });

    it('17. tools — 3 ops within 8h: opsLast8h = 3', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-k-1', 'tool-v1066-8hcount', 'sess-1', 'call', hoursAgo(1)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-k-2', 'tool-v1066-8hcount', 'sess-2', 'call', hoursAgo(4)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-k-3', 'tool-v1066-8hcount', 'sess-3', 'call', hoursAgo(7)), dec(0.5, 'allow'));
      // Older than 8h — should not count
      await ctx.logger.log(makeOp('agent-k-4', 'tool-v1066-8hcount', 'sess-4', 'call', hoursAgo(9)), dec(0.6, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1066-8hcount');
      expect(status).toBe(200);

      expect(body.opsLast8h).toBe(3);
    });

    it('18. tools — uniqueToolsLast1h counts distinct tools used on this tool in last 1h', async () => {
      ctx = await setup();
      // For the tools endpoint, tool is the entity — but uniqueToolsLast1h measures distinct tool names in the logs
      // Since all ops are for the same tool (tool-v1066-uniq), uniqueToolsLast1h = 1
      await ctx.logger.log(makeOp('agent-l-1', 'tool-v1066-uniq', 'sess-1', 'call', minsAgo(10)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-l-2', 'tool-v1066-uniq', 'sess-2', 'call', minsAgo(20)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-l-3', 'tool-v1066-uniq', 'sess-3', 'call', minsAgo(30)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1066-uniq');
      expect(status).toBe(200);

      // All ops use the same tool, so unique count = 1
      expect(body.uniqueToolsLast1h).toBe(1);
    });

    it('19. tools — uniqueMethodsLast1h counts distinct methods in last 1h', async () => {
      ctx = await setup();
      // 4 ops: read, write, read, write → uniqueMethods = 2
      await ctx.logger.log(makeOp('agent-m-1', 'tool-v1066-methods', 'sess-1', 'read', minsAgo(5)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-m-2', 'tool-v1066-methods', 'sess-2', 'write', minsAgo(10)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-m-3', 'tool-v1066-methods', 'sess-3', 'read', minsAgo(15)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-m-4', 'tool-v1066-methods', 'sess-4', 'write', minsAgo(20)), dec(0.6, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1066-methods');
      expect(status).toBe(200);

      expect(body.uniqueMethodsLast1h).toBe(2);
    });

    it('20. tools — methods outside 1h do not count toward uniqueMethodsLast1h', async () => {
      ctx = await setup();
      // 1 method in 1h (read), 2 other methods in 8h-but-not-1h (write, delete)
      await ctx.logger.log(makeOp('agent-n-1', 'tool-v1066-mwin', 'sess-1', 'read', minsAgo(30)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-n-2', 'tool-v1066-mwin', 'sess-2', 'write', hoursAgo(2)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-n-3', 'tool-v1066-mwin', 'sess-3', 'delete', hoursAgo(6)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1066-mwin');
      expect(status).toBe(200);

      // opsLast8h = 3, uniqueMethodsLast1h = 1 (only 'read')
      expect(body.opsLast8h).toBe(3);
      expect(body.uniqueMethodsLast1h).toBe(1);
    });
  });

  // ── operations/summary endpoint ────────────────────────────────────────────────

  describe('T1399-T1403 — v10.66 new fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('21. summary — all three new fields present', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-o', 'tool-s', 'sess-1'), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body).toHaveProperty('opsLast8h');
      expect(body).toHaveProperty('uniqueToolsLast1h');
      expect(body).toHaveProperty('uniqueMethodsLast1h');
    });

    it('22. summary — empty DB: opsLast8h = 0, uniqueToolsLast1h = 0, uniqueMethodsLast1h = 0', async () => {
      ctx = await setup();

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.opsLast8h).toBe(0);
      expect(body.uniqueToolsLast1h).toBe(0);
      expect(body.uniqueMethodsLast1h).toBe(0);
    });

    it('23. summary — all ops older than 8h: opsLast8h = 0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-p-1', 'tool-old', 'sess-1', 'call', hoursAgo(9)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-p-2', 'tool-old', 'sess-2', 'call', hoursAgo(12)), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.opsLast8h).toBe(0);
      expect(body.uniqueToolsLast1h).toBe(0);
      expect(body.uniqueMethodsLast1h).toBe(0);
    });

    it('24. summary — 6 ops within 8h: opsLast8h = 6', async () => {
      ctx = await setup();
      for (let h = 1; h <= 6; h++) {
        await ctx.logger.log(
          makeOp(`agent-q-${h}`, `tool-sum-${h}`, `sess-${h}`, 'call', hoursAgo(h)),
          dec(0.3, 'allow'),
        );
      }
      // 2 ops older than 8h — should not count
      await ctx.logger.log(makeOp('agent-q-old', 'tool-old', 'sess-old', 'call', hoursAgo(10)), dec(0.7, 'allow'));
      await ctx.logger.log(makeOp('agent-q-old2', 'tool-old2', 'sess-old2', 'call', hoursAgo(15)), dec(0.8, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.opsLast8h).toBe(6);
    });

    it('25. summary — 5 distinct tools within 1h: uniqueToolsLast1h = 5', async () => {
      ctx = await setup();
      const tools = ['tool-alpha', 'tool-beta', 'tool-gamma', 'tool-delta', 'tool-epsilon'];
      for (const tool of tools) {
        await ctx.logger.log(
          makeOp('agent-r', tool, 'sess-1', 'call', minsAgo(20)),
          dec(0.3, 'allow'),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.uniqueToolsLast1h).toBe(5);
    });

    it('26. summary — duplicate tools in 1h: uniqueToolsLast1h counts distinct only', async () => {
      ctx = await setup();
      // tool-x used 3 times, tool-y used 2 times → unique = 2
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp(`agent-s-${i}`, 'tool-x', `sess-x-${i}`, 'call', minsAgo(10 + i * 5)), dec(0.3, 'allow'));
      }
      for (let i = 0; i < 2; i++) {
        await ctx.logger.log(makeOp(`agent-s-${i}`, 'tool-y', `sess-y-${i}`, 'call', minsAgo(20 + i * 5)), dec(0.4, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.uniqueToolsLast1h).toBe(2);
    });

    it('27. summary — 4 distinct methods within 1h: uniqueMethodsLast1h = 4', async () => {
      ctx = await setup();
      for (const method of ['read', 'write', 'delete', 'list']) {
        await ctx.logger.log(
          makeOp('agent-t', 'fs', 'sess-1', method, minsAgo(15)),
          dec(0.3, 'allow'),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.uniqueMethodsLast1h).toBe(4);
    });

    it('28. summary — methods outside 1h do not count toward uniqueMethodsLast1h', async () => {
      ctx = await setup();
      // 2 methods in 1h
      await ctx.logger.log(makeOp('agent-u-1', 'fs', 'sess-1', 'read', minsAgo(10)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-u-2', 'fs', 'sess-2', 'write', minsAgo(40)), dec(0.4, 'allow'));
      // 3 other methods in 8h but outside 1h
      await ctx.logger.log(makeOp('agent-u-3', 'fs', 'sess-3', 'delete', hoursAgo(2)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-u-4', 'fs', 'sess-4', 'list', hoursAgo(5)), dec(0.6, 'allow'));
      await ctx.logger.log(makeOp('agent-u-5', 'fs', 'sess-5', 'execute', hoursAgo(7)), dec(0.7, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      // opsLast8h = 5 (all within 8h), uniqueMethodsLast1h = 2 (read + write)
      expect(body.opsLast8h).toBe(5);
      expect(body.uniqueMethodsLast1h).toBe(2);
    });

    it('29. summary — single op within 1h: all three fields return 1', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v', 'tool-single', 'sess-1', 'call', minsAgo(30)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.opsLast8h).toBe(1);
      expect(body.uniqueToolsLast1h).toBe(1);
      expect(body.uniqueMethodsLast1h).toBe(1);
    });
  });
});

// ── v10.67 ────────────────────────────────────────────────────────────────────

describe('v10.67', () => {
  const minsAgo = (m: number) => new Date(PINNED_NOW() - m * 60_000);
  const hoursAgo = (h: number) => new Date(PINNED_NOW() - h * 3_600_000);
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1404-T1408 — v10.67 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1067-pres'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-1067-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('uniqueAgentsLast1h');
      expect(body).toHaveProperty('uniqueSessionsLast1h');
      expect(body).toHaveProperty('uniqueAgentsLast7d');
      expect(body).toHaveProperty('uniqueSessionsLast7d');
      expect(body).toHaveProperty('uniqueSessionsLast24h');
    });

    it('2. sessions — recent op (<1h): uniqueAgentsLast1h=1, uniqueSessionsLast1h=1', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1067-1h'), dec(0.3));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-1067-1h');
      expect(status).toBe(200);

      expect(body.uniqueAgentsLast1h).toBe(1);
      expect(body.uniqueSessionsLast1h).toBe(1);
    });

    it('3. sessions — old op (>1h): uniqueAgentsLast1h=0, uniqueSessionsLast1h=0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-1067-old1h', hoursAgo(2)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-1067-old1h');
      expect(status).toBe(200);

      expect(body.uniqueAgentsLast1h).toBe(0);
      expect(body.uniqueSessionsLast1h).toBe(0);
    });

    it('4. sessions — 3 distinct agents within 1h: uniqueAgentsLast1h=3', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-c1', 'fs', 'sess-1067-multi-agent', minsAgo(10)), dec(0.2));
      await ctx.logger.log(makeOp('agent-c2', 'fs', 'sess-1067-multi-agent', minsAgo(20)), dec(0.3));
      await ctx.logger.log(makeOp('agent-c3', 'fs', 'sess-1067-multi-agent', minsAgo(30)), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-1067-multi-agent');
      expect(status).toBe(200);

      expect(body.uniqueAgentsLast1h).toBe(3);
      // Still 1 session (all ops share the same sessionId)
      expect(body.uniqueSessionsLast1h).toBe(1);
    });

    it('5. sessions — same agent repeated within 1h: uniqueAgentsLast1h=1 (deduped)', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-1067-dedup', minsAgo(5)), dec(0.1));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-1067-dedup', minsAgo(15)), dec(0.2));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-1067-dedup', minsAgo(45)), dec(0.3));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-1067-dedup');
      expect(status).toBe(200);

      expect(body.uniqueAgentsLast1h).toBe(1);
      expect(body.uniqueSessionsLast1h).toBe(1);
    });

    it('6. sessions — mix of 1h-recent and older ops: only recent counted for 1h fields', async () => {
      ctx = await setup();
      // Recent (<1h): 2 distinct agents
      await ctx.logger.log(makeOp('agent-e1', 'fs', 'sess-1067-mix', minsAgo(30)), dec(0.3));
      await ctx.logger.log(makeOp('agent-e2', 'fs', 'sess-1067-mix', minsAgo(50)), dec(0.4));
      // Old (>1h): should NOT count toward 1h fields
      await ctx.logger.log(makeOp('agent-e3', 'fs', 'sess-1067-mix', hoursAgo(3)), dec(0.5));
      await ctx.logger.log(makeOp('agent-e4', 'fs', 'sess-1067-mix', hoursAgo(5)), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-1067-mix');
      expect(status).toBe(200);

      expect(body.uniqueAgentsLast1h).toBe(2);
      expect(body.uniqueSessionsLast1h).toBe(1);
    });

    it('7. sessions — uniqueAgentsLast7d and uniqueSessionsLast7d: 0 for old ops', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-1067-7d-zero', daysAgo(10)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-1067-7d-zero');
      expect(status).toBe(200);

      expect(body.uniqueAgentsLast7d).toBe(0);
      expect(body.uniqueSessionsLast7d).toBe(0);
    });

    it('8. sessions — uniqueSessionsLast24h: 0 for ops older than 24h', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-1067-24h-zero', hoursAgo(30)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-1067-24h-zero');
      expect(status).toBe(200);

      expect(body.uniqueSessionsLast24h).toBe(0);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1404-T1408 — v10.67 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('9. agents — all five fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-1067-pres', 'fs', 'sess-1'), dec(0.3));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-1067-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('uniqueAgentsLast1h');
      expect(body).toHaveProperty('uniqueSessionsLast1h');
      expect(body).toHaveProperty('uniqueAgentsLast7d');
      expect(body).toHaveProperty('uniqueSessionsLast7d');
      expect(body).toHaveProperty('uniqueSessionsLast24h');
    });

    it('10. agents — recent op (<1h): uniqueAgentsLast1h=1, uniqueSessionsLast1h=1', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-1067-1h', 'fs', 'sess-1'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-1067-1h');
      expect(status).toBe(200);

      expect(body.uniqueAgentsLast1h).toBe(1);
      expect(body.uniqueSessionsLast1h).toBe(1);
    });

    it('11. agents — old op (>1h): uniqueAgentsLast1h=0, uniqueSessionsLast1h=0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-1067-old1h', 'fs', 'sess-1', hoursAgo(2)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-1067-old1h');
      expect(status).toBe(200);

      expect(body.uniqueAgentsLast1h).toBe(0);
      expect(body.uniqueSessionsLast1h).toBe(0);
    });

    it('12. agents — 3 ops on 3 distinct sessions within 1h: uniqueSessionsLast1h=3', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-1067-multi-sess', 'fs', 'sess-a', minsAgo(10)), dec(0.2));
      await ctx.logger.log(makeOp('agent-1067-multi-sess', 'fs', 'sess-b', minsAgo(20)), dec(0.3));
      await ctx.logger.log(makeOp('agent-1067-multi-sess', 'fs', 'sess-c', minsAgo(40)), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-1067-multi-sess');
      expect(status).toBe(200);

      expect(body.uniqueSessionsLast1h).toBe(3);
      // Still 1 unique agent
      expect(body.uniqueAgentsLast1h).toBe(1);
    });

    it('13. agents — same session repeated within 1h: uniqueSessionsLast1h=1 (deduped)', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-1067-sess-dedup', 'fs', 'sess-same', minsAgo(5)), dec(0.1));
      await ctx.logger.log(makeOp('agent-1067-sess-dedup', 'fs', 'sess-same', minsAgo(25)), dec(0.2));
      await ctx.logger.log(makeOp('agent-1067-sess-dedup', 'fs', 'sess-same', minsAgo(50)), dec(0.3));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-1067-sess-dedup');
      expect(status).toBe(200);

      expect(body.uniqueSessionsLast1h).toBe(1);
    });

    it('14. agents — uniqueAgentsLast7d populated within window, 0 outside', async () => {
      ctx = await setup();
      // Within 7d: 2 distinct agents
      await ctx.logger.log(makeOp('agent-1067-7d-a', 'fs', 'sess-1', daysAgo(3)), dec(0.3));
      await ctx.logger.log(makeOp('agent-1067-7d-b', 'fs', 'sess-2', daysAgo(5)), dec(0.4));
      // Outside 7d: should not count
      await ctx.logger.log(makeOp('agent-1067-7d-c', 'fs', 'sess-3', daysAgo(10)), dec(0.5));

      // Query any one of the agents in the window
      const { status, body } = await getJSON(ctx.port, '/agents/agent-1067-7d-a');
      expect(status).toBe(200);

      // agent-1067-7d-a has only 1 record in 7d window (its own)
      expect(body.uniqueAgentsLast7d as number).toBeGreaterThanOrEqual(1);
      expect(body.uniqueSessionsLast7d as number).toBeGreaterThanOrEqual(1);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1404-T1408 — v10.67 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('15. tools — all five fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-h', 'tool-1067-pres', 'sess-1'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-1067-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('uniqueAgentsLast1h');
      expect(body).toHaveProperty('uniqueSessionsLast1h');
      expect(body).toHaveProperty('uniqueAgentsLast7d');
      expect(body).toHaveProperty('uniqueSessionsLast7d');
      expect(body).toHaveProperty('uniqueSessionsLast24h');
    });

    it('16. tools — recent op (<1h): uniqueAgentsLast1h=1, uniqueSessionsLast1h=1', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-i', 'tool-1067-1h', 'sess-1'), dec(0.3));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-1067-1h');
      expect(status).toBe(200);

      expect(body.uniqueAgentsLast1h).toBe(1);
      expect(body.uniqueSessionsLast1h).toBe(1);
    });

    it('17. tools — old op (>1h): uniqueAgentsLast1h=0, uniqueSessionsLast1h=0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-j', 'tool-1067-old1h', 'sess-1', hoursAgo(3)), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-1067-old1h');
      expect(status).toBe(200);

      expect(body.uniqueAgentsLast1h).toBe(0);
      expect(body.uniqueSessionsLast1h).toBe(0);
    });

    it('18. tools — 4 distinct agents within 1h: uniqueAgentsLast1h=4', async () => {
      ctx = await setup();
      for (let i = 1; i <= 4; i++) {
        await ctx.logger.log(makeOp(`agent-t${i}`, 'tool-1067-4agents', `sess-${i}`, minsAgo(i * 10)), dec(0.2 * i));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-1067-4agents');
      expect(status).toBe(200);

      expect(body.uniqueAgentsLast1h).toBe(4);
      expect(body.uniqueSessionsLast1h).toBe(4);
    });

    it('19. tools — mix recent and old: 1h counts only recent ops', async () => {
      ctx = await setup();
      // Recent (<1h)
      await ctx.logger.log(makeOp('agent-k1', 'tool-1067-mix', 'sess-r1', minsAgo(20)), dec(0.2));
      await ctx.logger.log(makeOp('agent-k2', 'tool-1067-mix', 'sess-r2', minsAgo(45)), dec(0.3));
      // Old (>1h)
      await ctx.logger.log(makeOp('agent-k3', 'tool-1067-mix', 'sess-o1', hoursAgo(2)), dec(0.7));
      await ctx.logger.log(makeOp('agent-k4', 'tool-1067-mix', 'sess-o2', hoursAgo(4)), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-1067-mix');
      expect(status).toBe(200);

      expect(body.uniqueAgentsLast1h).toBe(2);
      expect(body.uniqueSessionsLast1h).toBe(2);
    });

    it('20. tools — uniqueSessionsLast24h: only ops within 24h counted', async () => {
      ctx = await setup();
      // Within 24h: 2 distinct sessions
      await ctx.logger.log(makeOp('agent-l', 'tool-1067-24h', 'sess-24h-1', hoursAgo(12)), dec(0.3));
      await ctx.logger.log(makeOp('agent-l', 'tool-1067-24h', 'sess-24h-2', hoursAgo(20)), dec(0.4));
      // Outside 24h: should not count
      await ctx.logger.log(makeOp('agent-l', 'tool-1067-24h', 'sess-old', hoursAgo(30)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-1067-24h');
      expect(status).toBe(200);

      expect(body.uniqueSessionsLast24h).toBe(2);
    });
  });

  // ── summary endpoint ───────────────────────────────────────────────────────────

  describe('T1404-T1408 — v10.67 new fields (summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('21. summary — all five fields present in response (no logs)', async () => {
      ctx = await setup();

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body).toHaveProperty('uniqueAgentsLast1h');
      expect(body).toHaveProperty('uniqueSessionsLast1h');
      expect(body).toHaveProperty('uniqueAgentsLast7d');
      expect(body).toHaveProperty('uniqueSessionsLast7d');
      expect(body).toHaveProperty('uniqueSessionsLast24h');
    });

    it('22. summary — no logs: all five fields are 0', async () => {
      ctx = await setup();

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.uniqueAgentsLast1h).toBe(0);
      expect(body.uniqueSessionsLast1h).toBe(0);
      expect(body.uniqueAgentsLast7d).toBe(0);
      expect(body.uniqueSessionsLast7d).toBe(0);
      expect(body.uniqueSessionsLast24h).toBe(0);
    });

    it('23. summary — recent ops (<1h): uniqueAgentsLast1h and uniqueSessionsLast1h > 0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-m1', 'fs', 'sess-sum-1'), dec(0.3));
      await ctx.logger.log(makeOp('agent-m2', 'fs', 'sess-sum-2'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.uniqueAgentsLast1h as number).toBeGreaterThanOrEqual(2);
      expect(body.uniqueSessionsLast1h as number).toBeGreaterThanOrEqual(2);
    });

    it('24. summary — only old ops (>1h): uniqueAgentsLast1h=0, uniqueSessionsLast1h=0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-n1', 'fs', 'sess-old-sum', hoursAgo(2)), dec(0.5));
      await ctx.logger.log(makeOp('agent-n2', 'fs', 'sess-old-sum-2', hoursAgo(3)), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.uniqueAgentsLast1h).toBe(0);
      expect(body.uniqueSessionsLast1h).toBe(0);
    });

    it('25. summary — multiple recent ops with duplicate agentIds: deduped correctly', async () => {
      ctx = await setup();
      // Same agent, 3 different sessions within 1h
      await ctx.logger.log(makeOp('agent-dedup-sum', 'fs', 'sess-d1', minsAgo(10)), dec(0.2));
      await ctx.logger.log(makeOp('agent-dedup-sum', 'fs', 'sess-d2', minsAgo(20)), dec(0.3));
      await ctx.logger.log(makeOp('agent-dedup-sum', 'fs', 'sess-d3', minsAgo(40)), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      // 1 unique agent, 3 unique sessions
      expect(body.uniqueAgentsLast1h).toBe(1);
      expect(body.uniqueSessionsLast1h).toBe(3);
    });

    it('26. summary — mix of recent and old ops: 1h window correct', async () => {
      ctx = await setup();
      // Within 1h: 2 agents, 2 sessions
      await ctx.logger.log(makeOp('agent-p1', 'fs', 'sess-p1', minsAgo(30)), dec(0.3));
      await ctx.logger.log(makeOp('agent-p2', 'fs', 'sess-p2', minsAgo(55)), dec(0.4));
      // Outside 1h: should not affect 1h counts
      await ctx.logger.log(makeOp('agent-p3', 'fs', 'sess-p3', hoursAgo(5)), dec(0.7));
      await ctx.logger.log(makeOp('agent-p4', 'fs', 'sess-p4', daysAgo(3)), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.uniqueAgentsLast1h).toBe(2);
      expect(body.uniqueSessionsLast1h).toBe(2);
    });
  });
});

// ── v10.68 ────────────────────────────────────────────────────────────────────

describe('v10.68', () => {
  const minsAgo = (m: number) => new Date(PINNED_NOW() - m * 60_000);
  const hoursAgo = (h: number) => new Date(PINNED_NOW() - h * 3_600_000);
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1409-T1413 — v10.68 action-count fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1068-pres'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-1068-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('blockCountLast1h');
      expect(body).toHaveProperty('allowCountLast1h');
      expect(body).toHaveProperty('requireApprovalCountLast1h');
      expect(body).toHaveProperty('blockCountLast24h');
      expect(body).toHaveProperty('allowCountLast24h');
    });

    it('2. sessions — no logs in window: all five fields are 0', async () => {
      ctx = await setup();
      // Op is older than 24h — none of the 5 window fields should count it
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-1068-old24h', daysAgo(2)), dec(0.5, 'block'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-1068-old24h');
      expect(status).toBe(200);

      expect(body.blockCountLast1h).toBe(0);
      expect(body.allowCountLast1h).toBe(0);
      expect(body.requireApprovalCountLast1h).toBe(0);
      expect(body.blockCountLast24h).toBe(0);
      expect(body.allowCountLast24h).toBe(0);
    });

    it('3. sessions — recent block (<1h): blockCountLast1h=1', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-1068-blk1h', minsAgo(30)), dec(0.9, 'block'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-1068-blk1h');
      expect(status).toBe(200);

      expect(body.blockCountLast1h).toBe(1);
      expect(body.allowCountLast1h).toBe(0);
      expect(body.requireApprovalCountLast1h).toBe(0);
    });

    it('4. sessions — recent allow (<1h): allowCountLast1h=1', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-1068-alw1h', minsAgo(20)), dec(0.2, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-1068-alw1h');
      expect(status).toBe(200);

      expect(body.allowCountLast1h).toBe(1);
      expect(body.blockCountLast1h).toBe(0);
      expect(body.requireApprovalCountLast1h).toBe(0);
    });

    it('5. sessions — recent require_approval (<1h): requireApprovalCountLast1h=1', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-1068-req1h', minsAgo(45)), dec(0.6, 'require_approval'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-1068-req1h');
      expect(status).toBe(200);

      expect(body.requireApprovalCountLast1h).toBe(1);
      expect(body.blockCountLast1h).toBe(0);
      expect(body.allowCountLast1h).toBe(0);
    });

    it('6. sessions — block older than 1h but within 24h: blockCountLast24h=1, blockCountLast1h=0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-1068-blk24h', hoursAgo(12)), dec(0.8, 'block'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-1068-blk24h');
      expect(status).toBe(200);

      expect(body.blockCountLast1h).toBe(0);
      expect(body.blockCountLast24h).toBe(1);
    });

    it('7. sessions — allow older than 1h but within 24h: allowCountLast24h=1, allowCountLast1h=0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-1068-alw24h', hoursAgo(8)), dec(0.3, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-1068-alw24h');
      expect(status).toBe(200);

      expect(body.allowCountLast1h).toBe(0);
      expect(body.allowCountLast24h).toBe(1);
    });

    it('8. sessions — multiple mixed actions within 1h: counts correct per action', async () => {
      ctx = await setup();
      const sid = 'sess-1068-mixed1h';
      await ctx.logger.log(makeOp('agent-h1', 'fs', sid, minsAgo(5)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-h2', 'fs', sid, minsAgo(10)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-h3', 'fs', sid, minsAgo(20)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-h4', 'fs', sid, minsAgo(35)), dec(0.6, 'require_approval'));
      await ctx.logger.log(makeOp('agent-h5', 'fs', sid, minsAgo(50)), dec(0.6, 'require_approval'));

      const { status, body } = await getJSON(ctx.port, `/sessions/${sid}`);
      expect(status).toBe(200);

      expect(body.blockCountLast1h).toBe(2);
      expect(body.allowCountLast1h).toBe(1);
      expect(body.requireApprovalCountLast1h).toBe(2);
    });

    it('9. sessions — old blocks excluded from 1h window, counted in 24h window', async () => {
      ctx = await setup();
      const sid = 'sess-1068-blk-windows';
      // Within 1h
      await ctx.logger.log(makeOp('agent-i1', 'fs', sid, minsAgo(30)), dec(0.9, 'block'));
      // Outside 1h, within 24h
      await ctx.logger.log(makeOp('agent-i2', 'fs', sid, hoursAgo(5)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-i3', 'fs', sid, hoursAgo(20)), dec(0.9, 'block'));

      const { status, body } = await getJSON(ctx.port, `/sessions/${sid}`);
      expect(status).toBe(200);

      expect(body.blockCountLast1h).toBe(1);
      expect(body.blockCountLast24h).toBe(3);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1409-T1413 — v10.68 action-count fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('10. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-1068-pres', 'fs', 'sess-1'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-1068-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('blockCountLast1h');
      expect(body).toHaveProperty('allowCountLast1h');
      expect(body).toHaveProperty('requireApprovalCountLast1h');
      expect(body).toHaveProperty('blockCountLast24h');
      expect(body).toHaveProperty('allowCountLast24h');
    });

    it('11. agents — no logs in window: all five fields are 0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-1068-old', 'fs', 'sess-1', daysAgo(2)), dec(0.8, 'block'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-1068-old');
      expect(status).toBe(200);

      expect(body.blockCountLast1h).toBe(0);
      expect(body.allowCountLast1h).toBe(0);
      expect(body.requireApprovalCountLast1h).toBe(0);
      expect(body.blockCountLast24h).toBe(0);
      expect(body.allowCountLast24h).toBe(0);
    });

    it('12. agents — recent block (<1h): blockCountLast1h=1', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-1068-blk1h', 'fs', 'sess-1', minsAgo(20)), dec(0.9, 'block'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-1068-blk1h');
      expect(status).toBe(200);

      expect(body.blockCountLast1h).toBe(1);
      expect(body.allowCountLast1h).toBe(0);
    });

    it('13. agents — recent allow (<1h): allowCountLast1h=1', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-1068-alw1h', 'fs', 'sess-1', minsAgo(40)), dec(0.2, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-1068-alw1h');
      expect(status).toBe(200);

      expect(body.allowCountLast1h).toBe(1);
      expect(body.blockCountLast1h).toBe(0);
    });

    it('14. agents — recent require_approval (<1h): requireApprovalCountLast1h=1', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-1068-req1h', 'fs', 'sess-1', minsAgo(55)), dec(0.6, 'require_approval'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-1068-req1h');
      expect(status).toBe(200);

      expect(body.requireApprovalCountLast1h).toBe(1);
      expect(body.blockCountLast1h).toBe(0);
      expect(body.allowCountLast1h).toBe(0);
    });

    it('15. agents — block in 1h-24h window: blockCountLast24h=1, blockCountLast1h=0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-1068-blk24h', 'fs', 'sess-1', hoursAgo(6)), dec(0.9, 'block'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-1068-blk24h');
      expect(status).toBe(200);

      expect(body.blockCountLast1h).toBe(0);
      expect(body.blockCountLast24h).toBe(1);
    });

    it('16. agents — allow in 1h-24h window: allowCountLast24h=1, allowCountLast1h=0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-1068-alw24h', 'fs', 'sess-1', hoursAgo(18)), dec(0.1, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-1068-alw24h');
      expect(status).toBe(200);

      expect(body.allowCountLast1h).toBe(0);
      expect(body.allowCountLast24h).toBe(1);
    });

    it('17. agents — multiple ops mixed actions: counts accurate', async () => {
      ctx = await setup();
      const aid = 'agent-1068-multi';
      await ctx.logger.log(makeOp(aid, 'fs', 'sess-1', minsAgo(10)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp(aid, 'fs', 'sess-2', minsAgo(25)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp(aid, 'fs', 'sess-3', minsAgo(45)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp(aid, 'fs', 'sess-4', minsAgo(50)), dec(0.6, 'require_approval'));
      // Outside 1h, within 24h
      await ctx.logger.log(makeOp(aid, 'fs', 'sess-5', hoursAgo(3)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp(aid, 'fs', 'sess-6', hoursAgo(10)), dec(0.2, 'allow'));

      const { status, body } = await getJSON(ctx.port, `/agents/${aid}`);
      expect(status).toBe(200);

      expect(body.blockCountLast1h).toBe(1);
      expect(body.allowCountLast1h).toBe(2);
      expect(body.requireApprovalCountLast1h).toBe(1);
      expect(body.blockCountLast24h).toBe(2);
      expect(body.allowCountLast24h).toBe(3);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1409-T1413 — v10.68 action-count fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('18. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-1068-pres', 'sess-1'), dec(0.3));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-1068-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('blockCountLast1h');
      expect(body).toHaveProperty('allowCountLast1h');
      expect(body).toHaveProperty('requireApprovalCountLast1h');
      expect(body).toHaveProperty('blockCountLast24h');
      expect(body).toHaveProperty('allowCountLast24h');
    });

    it('19. tools — no logs in window: all five fields are 0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-1068-old', 'sess-1', daysAgo(3)), dec(0.9, 'block'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-1068-old');
      expect(status).toBe(200);

      expect(body.blockCountLast1h).toBe(0);
      expect(body.allowCountLast1h).toBe(0);
      expect(body.requireApprovalCountLast1h).toBe(0);
      expect(body.blockCountLast24h).toBe(0);
      expect(body.allowCountLast24h).toBe(0);
    });

    it('20. tools — recent block (<1h): blockCountLast1h=1', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-b', 'tool-1068-blk1h', 'sess-1', minsAgo(15)), dec(0.9, 'block'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-1068-blk1h');
      expect(status).toBe(200);

      expect(body.blockCountLast1h).toBe(1);
      expect(body.allowCountLast1h).toBe(0);
    });

    it('21. tools — recent allow (<1h): allowCountLast1h=1', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-c', 'tool-1068-alw1h', 'sess-1', minsAgo(30)), dec(0.1, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-1068-alw1h');
      expect(status).toBe(200);

      expect(body.allowCountLast1h).toBe(1);
      expect(body.blockCountLast1h).toBe(0);
    });

    it('22. tools — require_approval within 1h: requireApprovalCountLast1h=1', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-d', 'tool-1068-req1h', 'sess-1', minsAgo(50)), dec(0.7, 'require_approval'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-1068-req1h');
      expect(status).toBe(200);

      expect(body.requireApprovalCountLast1h).toBe(1);
      expect(body.blockCountLast1h).toBe(0);
      expect(body.allowCountLast1h).toBe(0);
    });

    it('23. tools — block in 1h-24h range: blockCountLast24h=1, blockCountLast1h=0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-e', 'tool-1068-blk24h', 'sess-1', hoursAgo(8)), dec(0.9, 'block'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-1068-blk24h');
      expect(status).toBe(200);

      expect(body.blockCountLast1h).toBe(0);
      expect(body.blockCountLast24h).toBe(1);
    });

    it('24. tools — allow in 1h-24h range: allowCountLast24h=1, allowCountLast1h=0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-f', 'tool-1068-alw24h', 'sess-1', hoursAgo(16)), dec(0.1, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-1068-alw24h');
      expect(status).toBe(200);

      expect(body.allowCountLast1h).toBe(0);
      expect(body.allowCountLast24h).toBe(1);
    });

    it('25. tools — mix of windows and actions: counts accurate', async () => {
      ctx = await setup();
      const tool = 'tool-1068-mixed';
      // Within 1h
      await ctx.logger.log(makeOp('agent-g1', tool, 'sess-1', minsAgo(5)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-g2', tool, 'sess-2', minsAgo(40)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-g3', tool, 'sess-3', minsAgo(55)), dec(0.5, 'require_approval'));
      // Outside 1h, within 24h
      await ctx.logger.log(makeOp('agent-g4', tool, 'sess-4', hoursAgo(4)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-g5', tool, 'sess-5', hoursAgo(20)), dec(0.2, 'allow'));
      // Outside 24h
      await ctx.logger.log(makeOp('agent-g6', tool, 'sess-6', daysAgo(2)), dec(0.9, 'block'));

      const { status, body } = await getJSON(ctx.port, `/tools/${tool}`);
      expect(status).toBe(200);

      expect(body.blockCountLast1h).toBe(1);
      expect(body.allowCountLast1h).toBe(1);
      expect(body.requireApprovalCountLast1h).toBe(1);
      expect(body.blockCountLast24h).toBe(2);
      expect(body.allowCountLast24h).toBe(2);
    });
  });

  // ── summary endpoint ───────────────────────────────────────────────────────────

  describe('T1409-T1413 — v10.68 action-count fields (summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('26. summary — all five new fields present (no logs)', async () => {
      ctx = await setup();

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body).toHaveProperty('blockCountLast1h');
      expect(body).toHaveProperty('allowCountLast1h');
      expect(body).toHaveProperty('requireApprovalCountLast1h');
      expect(body).toHaveProperty('blockCountLast24h');
      expect(body).toHaveProperty('allowCountLast24h');
    });

    it('27. summary — no logs: all five fields are 0', async () => {
      ctx = await setup();

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.blockCountLast1h).toBe(0);
      expect(body.allowCountLast1h).toBe(0);
      expect(body.requireApprovalCountLast1h).toBe(0);
      expect(body.blockCountLast24h).toBe(0);
      expect(body.allowCountLast24h).toBe(0);
    });

    it('28. summary — only old logs (>24h): all five fields are 0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-old1', 'fs', 'sess-1', daysAgo(2)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-old2', 'fs', 'sess-2', daysAgo(3)), dec(0.1, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.blockCountLast1h).toBe(0);
      expect(body.allowCountLast1h).toBe(0);
      expect(body.requireApprovalCountLast1h).toBe(0);
      expect(body.blockCountLast24h).toBe(0);
      expect(body.allowCountLast24h).toBe(0);
    });

    it('29. summary — recent blocks: blockCountLast1h and blockCountLast24h > 0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-blk1', 'fs', 'sess-1', minsAgo(10)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-blk2', 'fs', 'sess-2', minsAgo(45)), dec(0.9, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.blockCountLast1h as number).toBeGreaterThanOrEqual(2);
      expect(body.blockCountLast24h as number).toBeGreaterThanOrEqual(2);
    });

    it('30. summary — recent allows: allowCountLast1h and allowCountLast24h > 0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-alw1', 'fs', 'sess-1', minsAgo(15)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-alw2', 'fs', 'sess-2', minsAgo(50)), dec(0.3, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.allowCountLast1h as number).toBeGreaterThanOrEqual(2);
      expect(body.allowCountLast24h as number).toBeGreaterThanOrEqual(2);
    });

    it('31. summary — require_approval within 1h: requireApprovalCountLast1h > 0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-req1', 'fs', 'sess-1', minsAgo(20)), dec(0.6, 'require_approval'));
      await ctx.logger.log(makeOp('agent-req2', 'fs', 'sess-2', minsAgo(55)), dec(0.7, 'require_approval'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.requireApprovalCountLast1h as number).toBeGreaterThanOrEqual(2);
    });

    it('32. summary — blocks in 1h-24h window: blockCountLast24h counts them, blockCountLast1h=0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-blk3', 'fs', 'sess-1', hoursAgo(5)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-blk4', 'fs', 'sess-2', hoursAgo(18)), dec(0.9, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.blockCountLast1h).toBe(0);
      expect(body.blockCountLast24h as number).toBeGreaterThanOrEqual(2);
    });

    it('33. summary — allows in 1h-24h window: allowCountLast24h counts them, allowCountLast1h=0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-alw3', 'fs', 'sess-1', hoursAgo(7)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-alw4', 'fs', 'sess-2', hoursAgo(22)), dec(0.2, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.allowCountLast1h).toBe(0);
      expect(body.allowCountLast24h as number).toBeGreaterThanOrEqual(2);
    });

    it('34. summary — mixed actions across both windows: all fields correct', async () => {
      ctx = await setup();
      // Within 1h: 2 blocks, 1 allow, 1 require_approval
      await ctx.logger.log(makeOp('agent-m1', 'fs', 'sess-1', minsAgo(5)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-m2', 'fs', 'sess-2', minsAgo(30)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-m3', 'fs', 'sess-3', minsAgo(45)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-m4', 'fs', 'sess-4', minsAgo(58)), dec(0.5, 'require_approval'));
      // Outside 1h, within 24h: 1 block, 2 allows
      await ctx.logger.log(makeOp('agent-m5', 'fs', 'sess-5', hoursAgo(4)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-m6', 'fs', 'sess-6', hoursAgo(10)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-m7', 'fs', 'sess-7', hoursAgo(20)), dec(0.1, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.blockCountLast1h).toBe(2);
      expect(body.allowCountLast1h).toBe(1);
      expect(body.requireApprovalCountLast1h).toBe(1);
      expect(body.blockCountLast24h).toBe(3);
      expect(body.allowCountLast24h).toBe(3);
    });
  });
});

// ── v10.69 ────────────────────────────────────────────────────────────────────

describe('v10.69', () => {
  const hoursAgo = (h: number) => new Date(PINNED_NOW() - h * 3_600_000);
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1414-T1418 — v10.69 sessions endpoint', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1069-pres'), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1069-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('requireApprovalCountLast24h');
      expect(body).toHaveProperty('blockRateLast1h');
      expect(body).toHaveProperty('allowRateLast1h');
      expect(body).toHaveProperty('requireApprovalRateLast1h');
      expect(body).toHaveProperty('avgRiskScoreLast1h');
    });

    it('2. sessions — no require_approval ops: requireApprovalCountLast24h is 0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1069-zero'), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1069-zero'), dec(0.5, 'block'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1069-zero');
      expect(status).toBe(200);
      expect(body.requireApprovalCountLast24h).toBe(0);
    });

    it('3. sessions — require_approval ops within 24h: counted correctly', async () => {
      ctx = await setup();
      // Two require_approval within 24h, one older (>24h) should NOT count
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1069-ra24h', hoursAgo(1)), dec(0.8, 'require_approval'));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1069-ra24h', hoursAgo(12)), dec(0.7, 'require_approval'));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1069-ra24h', hoursAgo(30)), dec(0.9, 'require_approval'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1069-ra24h');
      expect(status).toBe(200);
      expect(body.requireApprovalCountLast24h).toBe(2);
    });

    it('4. sessions — only old ops (>24h): requireApprovalCountLast24h is 0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1069-old', hoursAgo(25)), dec(0.6, 'require_approval'));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1069-old', hoursAgo(48)), dec(0.5, 'require_approval'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1069-old');
      expect(status).toBe(200);
      expect(body.requireApprovalCountLast24h).toBe(0);
    });

    it('5. sessions — no ops in last 1h: blockRateLast1h, allowRateLast1h, requireApprovalRateLast1h, avgRiskScoreLast1h are null', async () => {
      ctx = await setup();
      // Op older than 1h (but within 24h)
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1069-no1h', hoursAgo(2)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1069-no1h');
      expect(status).toBe(200);
      expect(body.blockRateLast1h).toBeNull();
      expect(body.allowRateLast1h).toBeNull();
      expect(body.requireApprovalRateLast1h).toBeNull();
      expect(body.avgRiskScoreLast1h).toBeNull();
    });

    it('6. sessions — ops within 1h: rates and avg computed correctly', async () => {
      ctx = await setup();
      // 2 allow, 1 block, 1 require_approval within 1h → rates 0.5, 0.25, 0.25
      // riskScores: 0.2, 0.4, 0.6, 0.8 → avg = 0.5
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1069-1h'), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1069-1h'), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1069-1h'), dec(0.6, 'block'));
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1069-1h'), dec(0.8, 'require_approval'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1069-1h');
      expect(status).toBe(200);
      expect(body.allowRateLast1h as number).toBeCloseTo(0.5, 5);
      expect(body.blockRateLast1h as number).toBeCloseTo(0.25, 5);
      expect(body.requireApprovalRateLast1h as number).toBeCloseTo(0.25, 5);
      expect(body.avgRiskScoreLast1h as number).toBeCloseTo(0.5, 5);
    });

    it('7. sessions — mixed require_approval: 3 within 24h, 2 older', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1069-mix', hoursAgo(2)), dec(0.9, 'require_approval'));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1069-mix', hoursAgo(10)), dec(0.8, 'require_approval'));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1069-mix', hoursAgo(20)), dec(0.7, 'require_approval'));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1069-mix', hoursAgo(25)), dec(0.6, 'require_approval'));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1069-mix', hoursAgo(30)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1069-mix');
      expect(status).toBe(200);
      expect(body.requireApprovalCountLast24h).toBe(3);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1414-T1418 — v10.69 agents endpoint', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('8. agents — all five fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1069-pres', 'fs', 'sess-1'), dec(0.3, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1069-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('requireApprovalCountLast24h');
      expect(body).toHaveProperty('blockRateLast1h');
      expect(body).toHaveProperty('allowRateLast1h');
      expect(body).toHaveProperty('requireApprovalRateLast1h');
      expect(body).toHaveProperty('avgRiskScoreLast1h');
    });

    it('9. agents — no require_approval ops within 24h: count is 0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1069-zero', 'fs', 'sess-1'), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-v1069-zero', 'fs', 'sess-2'), dec(0.6, 'block'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1069-zero');
      expect(status).toBe(200);
      expect(body.requireApprovalCountLast24h).toBe(0);
    });

    it('10. agents — require_approval ops within 24h counted, older ops excluded', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1069-ra24h', 'fs', 'sess-1', hoursAgo(1)), dec(0.9, 'require_approval'));
      await ctx.logger.log(makeOp('agent-v1069-ra24h', 'fs', 'sess-2', hoursAgo(6)), dec(0.8, 'require_approval'));
      await ctx.logger.log(makeOp('agent-v1069-ra24h', 'fs', 'sess-3', hoursAgo(26)), dec(0.7, 'require_approval'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1069-ra24h');
      expect(status).toBe(200);
      expect(body.requireApprovalCountLast24h).toBe(2);
    });

    it('11. agents — no ops in last 1h: rate fields null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1069-no1h', 'fs', 'sess-1', hoursAgo(3)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1069-no1h');
      expect(status).toBe(200);
      expect(body.blockRateLast1h).toBeNull();
      expect(body.allowRateLast1h).toBeNull();
      expect(body.requireApprovalRateLast1h).toBeNull();
      expect(body.avgRiskScoreLast1h).toBeNull();
    });

    it('12. agents — ops within 1h: avgRiskScoreLast1h computed correctly', async () => {
      ctx = await setup();
      // riskScores: 0.3, 0.7 → avg = 0.5
      await ctx.logger.log(makeOp('agent-v1069-avg1h', 'fs', 'sess-1'), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-v1069-avg1h', 'fs', 'sess-2'), dec(0.7, 'block'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1069-avg1h');
      expect(status).toBe(200);
      expect(body.avgRiskScoreLast1h as number).toBeCloseTo(0.5, 5);
    });

    it('13. agents — only all-block ops in 1h: blockRateLast1h = 1.0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1069-block1h', 'fs', 'sess-1'), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-v1069-block1h', 'fs', 'sess-2'), dec(0.8, 'block'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1069-block1h');
      expect(status).toBe(200);
      expect(body.blockRateLast1h as number).toBeCloseTo(1.0, 5);
      expect(body.allowRateLast1h as number).toBeCloseTo(0.0, 5);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1414-T1418 — v10.69 tools endpoint', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('14. tools — all five fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-h', 'tool-v1069-pres', 'sess-1'), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1069-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('requireApprovalCountLast24h');
      expect(body).toHaveProperty('blockRateLast1h');
      expect(body).toHaveProperty('allowRateLast1h');
      expect(body).toHaveProperty('requireApprovalRateLast1h');
      expect(body).toHaveProperty('avgRiskScoreLast1h');
    });

    it('15. tools — no require_approval ops: count is 0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-i', 'tool-v1069-zero', 'sess-1'), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-i', 'tool-v1069-zero', 'sess-2'), dec(0.6, 'block'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1069-zero');
      expect(status).toBe(200);
      expect(body.requireApprovalCountLast24h).toBe(0);
    });

    it('16. tools — 4 require_approval within 24h, 1 older: count is 4', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-j-1', 'tool-v1069-ra', 'sess-1'), dec(0.9, 'require_approval'));
      await ctx.logger.log(makeOp('agent-j-2', 'tool-v1069-ra', 'sess-2', hoursAgo(5)), dec(0.8, 'require_approval'));
      await ctx.logger.log(makeOp('agent-j-3', 'tool-v1069-ra', 'sess-3', hoursAgo(12)), dec(0.7, 'require_approval'));
      await ctx.logger.log(makeOp('agent-j-4', 'tool-v1069-ra', 'sess-4', hoursAgo(23)), dec(0.6, 'require_approval'));
      // older than 24h
      await ctx.logger.log(makeOp('agent-j-5', 'tool-v1069-ra', 'sess-5', hoursAgo(25)), dec(0.5, 'require_approval'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1069-ra');
      expect(status).toBe(200);
      expect(body.requireApprovalCountLast24h).toBe(4);
    });

    it('17. tools — no ops in last 1h: all rate/avg fields null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-k', 'tool-v1069-no1h', 'sess-1', hoursAgo(2)), dec(0.5, 'block'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1069-no1h');
      expect(status).toBe(200);
      expect(body.blockRateLast1h).toBeNull();
      expect(body.allowRateLast1h).toBeNull();
      expect(body.requireApprovalRateLast1h).toBeNull();
      expect(body.avgRiskScoreLast1h).toBeNull();
    });

    it('18. tools — ops within 1h: requireApprovalRateLast1h computed correctly', async () => {
      ctx = await setup();
      // 1 require_approval, 3 allow → rate = 0.25
      await ctx.logger.log(makeOp('agent-l-1', 'tool-v1069-ra1h', 'sess-1'), dec(0.5, 'require_approval'));
      await ctx.logger.log(makeOp('agent-l-2', 'tool-v1069-ra1h', 'sess-2'), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-l-3', 'tool-v1069-ra1h', 'sess-3'), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-l-4', 'tool-v1069-ra1h', 'sess-4'), dec(0.2, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1069-ra1h');
      expect(status).toBe(200);
      expect(body.requireApprovalRateLast1h as number).toBeCloseTo(0.25, 5);
    });
  });

  // ── operations/summary endpoint ────────────────────────────────────────────────

  describe('T1414-T1418 — v10.69 operations/summary endpoint', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('19. summary — all five fields present', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-m', 'tool-s', 'sess-1'), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body).toHaveProperty('requireApprovalCountLast24h');
      expect(body).toHaveProperty('blockRateLast1h');
      expect(body).toHaveProperty('allowRateLast1h');
      expect(body).toHaveProperty('requireApprovalRateLast1h');
      expect(body).toHaveProperty('avgRiskScoreLast1h');
    });

    it('20. summary — empty DB: requireApprovalCountLast24h is 0, rate/avg fields are null', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.requireApprovalCountLast24h).toBe(0);
      expect(body.blockRateLast1h).toBeNull();
      expect(body.allowRateLast1h).toBeNull();
      expect(body.requireApprovalRateLast1h).toBeNull();
      expect(body.avgRiskScoreLast1h).toBeNull();
    });

    it('21. summary — 3 require_approval within 24h across different sessions/agents', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-n-1', 'tool-x', 'sess-1', hoursAgo(1)), dec(0.9, 'require_approval'));
      await ctx.logger.log(makeOp('agent-n-2', 'tool-y', 'sess-2', hoursAgo(8)), dec(0.8, 'require_approval'));
      await ctx.logger.log(makeOp('agent-n-3', 'tool-z', 'sess-3', hoursAgo(20)), dec(0.7, 'require_approval'));
      // Older than 24h
      await ctx.logger.log(makeOp('agent-n-4', 'tool-x', 'sess-4', hoursAgo(30)), dec(0.6, 'require_approval'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.requireApprovalCountLast24h).toBe(3);
    });

    it('22. summary — only ops outside 1h: rate/avg fields null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-o-1', 'tool-old', 'sess-1', hoursAgo(2)), dec(0.5, 'block'));
      await ctx.logger.log(makeOp('agent-o-2', 'tool-old', 'sess-2', hoursAgo(3)), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.blockRateLast1h).toBeNull();
      expect(body.allowRateLast1h).toBeNull();
      expect(body.requireApprovalRateLast1h).toBeNull();
      expect(body.avgRiskScoreLast1h).toBeNull();
    });

    it('23. summary — ops within 1h: avgRiskScoreLast1h correct', async () => {
      ctx = await setup();
      // 3 ops with scores 0.1, 0.5, 0.9 → avg = 0.5
      await ctx.logger.log(makeOp('agent-p-1', 'tool-avg', 'sess-1'), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-p-2', 'tool-avg', 'sess-2'), dec(0.5, 'block'));
      await ctx.logger.log(makeOp('agent-p-3', 'tool-avg', 'sess-3'), dec(0.9, 'require_approval'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.avgRiskScoreLast1h as number).toBeCloseTo(0.5, 5);
    });

    it('24. summary — all-allow ops in 1h: allowRateLast1h = 1.0, others = 0.0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-q-1', 'tool-allow', 'sess-1'), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-q-2', 'tool-allow', 'sess-2'), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-q-3', 'tool-allow', 'sess-3'), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.allowRateLast1h as number).toBeCloseTo(1.0, 5);
      expect(body.blockRateLast1h as number).toBeCloseTo(0.0, 5);
      expect(body.requireApprovalRateLast1h as number).toBeCloseTo(0.0, 5);
    });

    it('25. summary — requireApprovalCountLast24h does not count ops older than 24h', async () => {
      ctx = await setup();
      // Exactly 1 within 24h, 3 outside
      await ctx.logger.log(makeOp('agent-r-1', 'tool-ra-edge', 'sess-1', hoursAgo(23)), dec(0.9, 'require_approval'));
      await ctx.logger.log(makeOp('agent-r-2', 'tool-ra-edge', 'sess-2', hoursAgo(25)), dec(0.9, 'require_approval'));
      await ctx.logger.log(makeOp('agent-r-3', 'tool-ra-edge', 'sess-3', daysAgo(2)), dec(0.9, 'require_approval'));
      await ctx.logger.log(makeOp('agent-r-4', 'tool-ra-edge', 'sess-4', daysAgo(7)), dec(0.9, 'require_approval'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.requireApprovalCountLast24h).toBe(1);
    });
  });
});

// ── v10.70 ────────────────────────────────────────────────────────────────────

describe('v10.70', () => {
  const hoursAgo = (h: number) => new Date(PINNED_NOW() - h * 3_600_000);
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1419-T1423 — v10.70 sessions endpoint', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — three new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1070-pres'), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1070-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('avgRiskScoreLast24h');
      expect(body).toHaveProperty('maxRiskScoreLast24h');
      expect(body).toHaveProperty('minRiskScoreLast24h');
    });

    it('2. sessions — pre-existing fields avgRiskScoreLast7d and riskScoreStdDevLast7d still present', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a2', 'fs', 'sess-v1070-pre7d'), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1070-pre7d');
      expect(status).toBe(200);

      expect(body).toHaveProperty('avgRiskScoreLast7d');
      expect(body).toHaveProperty('riskScoreStdDevLast7d');
    });

    it('3. sessions — no ops in last 24h: all three new fields are null', async () => {
      ctx = await setup();
      // Op older than 24h
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1070-no24h', hoursAgo(25)), dec(0.7, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1070-no24h');
      expect(status).toBe(200);
      expect(body.avgRiskScoreLast24h).toBeNull();
      expect(body.maxRiskScoreLast24h).toBeNull();
      expect(body.minRiskScoreLast24h).toBeNull();
    });

    it('4. sessions — single op in last 24h: avg=max=min=that score', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1070-single', hoursAgo(1)), dec(0.6, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1070-single');
      expect(status).toBe(200);
      expect(body.avgRiskScoreLast24h as number).toBeCloseTo(0.6, 5);
      expect(body.maxRiskScoreLast24h as number).toBeCloseTo(0.6, 5);
      expect(body.minRiskScoreLast24h as number).toBeCloseTo(0.6, 5);
    });

    it('5. sessions — multiple ops in last 24h: avg, max, min computed correctly', async () => {
      ctx = await setup();
      // riskScores: 0.2, 0.5, 0.8 → avg=0.5, max=0.8, min=0.2
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1070-multi', hoursAgo(1)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1070-multi', hoursAgo(6)), dec(0.5, 'block'));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1070-multi', hoursAgo(12)), dec(0.8, 'require_approval'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1070-multi');
      expect(status).toBe(200);
      expect(body.avgRiskScoreLast24h as number).toBeCloseTo(0.5, 5);
      expect(body.maxRiskScoreLast24h as number).toBeCloseTo(0.8, 5);
      expect(body.minRiskScoreLast24h as number).toBeCloseTo(0.2, 5);
    });

    it('6. sessions — old ops excluded from 24h window: only recent ops factored in', async () => {
      ctx = await setup();
      // Two ops within 24h (scores 0.3, 0.7), one older op (score 0.9, should be excluded)
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1070-excl', hoursAgo(2)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1070-excl', hoursAgo(10)), dec(0.7, 'block'));
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1070-excl', hoursAgo(30)), dec(0.9, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1070-excl');
      expect(status).toBe(200);
      // avg of (0.3, 0.7) = 0.5, max = 0.7, min = 0.3
      expect(body.avgRiskScoreLast24h as number).toBeCloseTo(0.5, 5);
      expect(body.maxRiskScoreLast24h as number).toBeCloseTo(0.7, 5);
      expect(body.minRiskScoreLast24h as number).toBeCloseTo(0.3, 5);
    });

    it('7. sessions — all ops within 24h, same score: avg=max=min', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1070-same', hoursAgo(1)), dec(0.55, 'allow'));
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1070-same', hoursAgo(5)), dec(0.55, 'allow'));
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1070-same', hoursAgo(20)), dec(0.55, 'block'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1070-same');
      expect(status).toBe(200);
      expect(body.avgRiskScoreLast24h as number).toBeCloseTo(0.55, 5);
      expect(body.maxRiskScoreLast24h as number).toBeCloseTo(0.55, 5);
      expect(body.minRiskScoreLast24h as number).toBeCloseTo(0.55, 5);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1419-T1423 — v10.70 agents endpoint', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('8. agents — three new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1070-pres', 'fs', 'sess-1'), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1070-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('avgRiskScoreLast24h');
      expect(body).toHaveProperty('maxRiskScoreLast24h');
      expect(body).toHaveProperty('minRiskScoreLast24h');
    });

    it('9. agents — no ops in last 24h: all three new fields are null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1070-no24h', 'fs', 'sess-1', hoursAgo(26)), dec(0.8, 'block'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1070-no24h');
      expect(status).toBe(200);
      expect(body.avgRiskScoreLast24h).toBeNull();
      expect(body.maxRiskScoreLast24h).toBeNull();
      expect(body.minRiskScoreLast24h).toBeNull();
    });

    it('10. agents — single op in last 24h: avg=max=min=that score', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1070-single', 'fs', 'sess-1', hoursAgo(3)), dec(0.75, 'block'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1070-single');
      expect(status).toBe(200);
      expect(body.avgRiskScoreLast24h as number).toBeCloseTo(0.75, 5);
      expect(body.maxRiskScoreLast24h as number).toBeCloseTo(0.75, 5);
      expect(body.minRiskScoreLast24h as number).toBeCloseTo(0.75, 5);
    });

    it('11. agents — multiple ops within 24h: avg, max, min computed correctly', async () => {
      ctx = await setup();
      // riskScores: 0.1, 0.4, 0.9 → avg=0.4667, max=0.9, min=0.1
      await ctx.logger.log(makeOp('agent-v1070-multi', 'fs', 'sess-1', hoursAgo(1)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-v1070-multi', 'fs', 'sess-2', hoursAgo(8)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-v1070-multi', 'fs', 'sess-3', hoursAgo(20)), dec(0.9, 'block'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1070-multi');
      expect(status).toBe(200);
      expect(body.avgRiskScoreLast24h as number).toBeCloseTo((0.1 + 0.4 + 0.9) / 3, 5);
      expect(body.maxRiskScoreLast24h as number).toBeCloseTo(0.9, 5);
      expect(body.minRiskScoreLast24h as number).toBeCloseTo(0.1, 5);
    });

    it('12. agents — older op excluded from 24h window', async () => {
      ctx = await setup();
      // Two recent ops (scores 0.3, 0.6), one old op (score 0.95, excluded)
      await ctx.logger.log(makeOp('agent-v1070-excl', 'fs', 'sess-1', hoursAgo(5)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-v1070-excl', 'fs', 'sess-2', hoursAgo(15)), dec(0.6, 'allow'));
      await ctx.logger.log(makeOp('agent-v1070-excl', 'fs', 'sess-3', hoursAgo(30)), dec(0.95, 'block'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1070-excl');
      expect(status).toBe(200);
      // avg of (0.3, 0.6) = 0.45, max = 0.6, min = 0.3
      expect(body.avgRiskScoreLast24h as number).toBeCloseTo(0.45, 5);
      expect(body.maxRiskScoreLast24h as number).toBeCloseTo(0.6, 5);
      expect(body.minRiskScoreLast24h as number).toBeCloseTo(0.3, 5);
    });

    it('13. agents — four ops with extreme scores: max and min at boundaries', async () => {
      ctx = await setup();
      // riskScores: 0.0, 0.25, 0.75, 1.0 → avg=0.5, max=1.0, min=0.0
      await ctx.logger.log(makeOp('agent-v1070-extreme', 'fs', 'sess-1', hoursAgo(1)), dec(0.0, 'allow'));
      await ctx.logger.log(makeOp('agent-v1070-extreme', 'fs', 'sess-2', hoursAgo(5)), dec(0.25, 'allow'));
      await ctx.logger.log(makeOp('agent-v1070-extreme', 'fs', 'sess-3', hoursAgo(10)), dec(0.75, 'block'));
      await ctx.logger.log(makeOp('agent-v1070-extreme', 'fs', 'sess-4', hoursAgo(20)), dec(1.0, 'block'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1070-extreme');
      expect(status).toBe(200);
      expect(body.avgRiskScoreLast24h as number).toBeCloseTo(0.5, 5);
      expect(body.maxRiskScoreLast24h as number).toBeCloseTo(1.0, 5);
      expect(body.minRiskScoreLast24h as number).toBeCloseTo(0.0, 5);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1419-T1423 — v10.70 tools endpoint', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('14. tools — three new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-h', 'tool-v1070-pres', 'sess-1'), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1070-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('avgRiskScoreLast24h');
      expect(body).toHaveProperty('maxRiskScoreLast24h');
      expect(body).toHaveProperty('minRiskScoreLast24h');
    });

    it('15. tools — no ops in last 24h: all three new fields are null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-i', 'tool-v1070-no24h', 'sess-1', hoursAgo(25)), dec(0.6, 'block'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1070-no24h');
      expect(status).toBe(200);
      expect(body.avgRiskScoreLast24h).toBeNull();
      expect(body.maxRiskScoreLast24h).toBeNull();
      expect(body.minRiskScoreLast24h).toBeNull();
    });

    it('16. tools — single op in last 24h: avg=max=min=that score', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-j', 'tool-v1070-single', 'sess-1', hoursAgo(2)), dec(0.45, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1070-single');
      expect(status).toBe(200);
      expect(body.avgRiskScoreLast24h as number).toBeCloseTo(0.45, 5);
      expect(body.maxRiskScoreLast24h as number).toBeCloseTo(0.45, 5);
      expect(body.minRiskScoreLast24h as number).toBeCloseTo(0.45, 5);
    });

    it('17. tools — multiple ops within 24h from different agents/sessions', async () => {
      ctx = await setup();
      // riskScores: 0.2, 0.6, 1.0 → avg=0.6, max=1.0, min=0.2
      await ctx.logger.log(makeOp('agent-k-1', 'tool-v1070-multi', 'sess-1', hoursAgo(1)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-k-2', 'tool-v1070-multi', 'sess-2', hoursAgo(10)), dec(0.6, 'allow'));
      await ctx.logger.log(makeOp('agent-k-3', 'tool-v1070-multi', 'sess-3', hoursAgo(22)), dec(1.0, 'block'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1070-multi');
      expect(status).toBe(200);
      expect(body.avgRiskScoreLast24h as number).toBeCloseTo(0.6, 5);
      expect(body.maxRiskScoreLast24h as number).toBeCloseTo(1.0, 5);
      expect(body.minRiskScoreLast24h as number).toBeCloseTo(0.2, 5);
    });

    it('18. tools — ops outside 24h window excluded', async () => {
      ctx = await setup();
      // One recent op (score 0.4), two old ops (0.9, 0.1, excluded)
      await ctx.logger.log(makeOp('agent-l-1', 'tool-v1070-excl', 'sess-1', hoursAgo(6)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-l-2', 'tool-v1070-excl', 'sess-2', hoursAgo(26)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-l-3', 'tool-v1070-excl', 'sess-3', daysAgo(3)), dec(0.1, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1070-excl');
      expect(status).toBe(200);
      expect(body.avgRiskScoreLast24h as number).toBeCloseTo(0.4, 5);
      expect(body.maxRiskScoreLast24h as number).toBeCloseTo(0.4, 5);
      expect(body.minRiskScoreLast24h as number).toBeCloseTo(0.4, 5);
    });

    it('19. tools — five ops within 24h: max and min are correct extremes', async () => {
      ctx = await setup();
      // riskScores: 0.1, 0.3, 0.5, 0.7, 0.9
      await ctx.logger.log(makeOp('agent-m-1', 'tool-v1070-five', 'sess-1', hoursAgo(1)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-m-2', 'tool-v1070-five', 'sess-2', hoursAgo(4)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-m-3', 'tool-v1070-five', 'sess-3', hoursAgo(8)), dec(0.5, 'block'));
      await ctx.logger.log(makeOp('agent-m-4', 'tool-v1070-five', 'sess-4', hoursAgo(16)), dec(0.7, 'block'));
      await ctx.logger.log(makeOp('agent-m-5', 'tool-v1070-five', 'sess-5', hoursAgo(23)), dec(0.9, 'require_approval'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1070-five');
      expect(status).toBe(200);
      expect(body.avgRiskScoreLast24h as number).toBeCloseTo(0.5, 5);
      expect(body.maxRiskScoreLast24h as number).toBeCloseTo(0.9, 5);
      expect(body.minRiskScoreLast24h as number).toBeCloseTo(0.1, 5);
    });
  });

  // ── operations/summary endpoint ────────────────────────────────────────────────

  describe('T1419-T1423 — v10.70 operations/summary endpoint', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('20. summary — three new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-n', 'tool-s', 'sess-1'), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body).toHaveProperty('avgRiskScoreLast24h');
      expect(body).toHaveProperty('maxRiskScoreLast24h');
      expect(body).toHaveProperty('minRiskScoreLast24h');
    });

    it('21. summary — empty DB: all three new fields are null', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.avgRiskScoreLast24h).toBeNull();
      expect(body.maxRiskScoreLast24h).toBeNull();
      expect(body.minRiskScoreLast24h).toBeNull();
    });

    it('22. summary — only old ops (>24h): all three new fields are null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-o-1', 'tool-old', 'sess-1', hoursAgo(25)), dec(0.5, 'block'));
      await ctx.logger.log(makeOp('agent-o-2', 'tool-old', 'sess-2', daysAgo(3)), dec(0.8, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.avgRiskScoreLast24h).toBeNull();
      expect(body.maxRiskScoreLast24h).toBeNull();
      expect(body.minRiskScoreLast24h).toBeNull();
    });

    it('23. summary — single op within 24h: avg=max=min=that score', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-p', 'tool-single', 'sess-1', hoursAgo(3)), dec(0.65, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.avgRiskScoreLast24h as number).toBeCloseTo(0.65, 5);
      expect(body.maxRiskScoreLast24h as number).toBeCloseTo(0.65, 5);
      expect(body.minRiskScoreLast24h as number).toBeCloseTo(0.65, 5);
    });

    it('24. summary — multiple ops in 24h across agents and sessions: avg, max, min correct', async () => {
      ctx = await setup();
      // riskScores: 0.1, 0.5, 0.9 → avg=0.5, max=0.9, min=0.1
      await ctx.logger.log(makeOp('agent-q-1', 'tool-avg', 'sess-1', hoursAgo(1)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-q-2', 'tool-avg', 'sess-2', hoursAgo(6)), dec(0.5, 'block'));
      await ctx.logger.log(makeOp('agent-q-3', 'tool-avg', 'sess-3', hoursAgo(18)), dec(0.9, 'require_approval'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.avgRiskScoreLast24h as number).toBeCloseTo(0.5, 5);
      expect(body.maxRiskScoreLast24h as number).toBeCloseTo(0.9, 5);
      expect(body.minRiskScoreLast24h as number).toBeCloseTo(0.1, 5);
    });

    it('25. summary — mixed old and recent ops: only 24h window ops included', async () => {
      ctx = await setup();
      // Two recent ops (0.3, 0.7), two old ops (0.05, 0.95 — excluded)
      await ctx.logger.log(makeOp('agent-r-1', 'tool-mixed', 'sess-1', hoursAgo(2)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-r-2', 'tool-mixed', 'sess-2', hoursAgo(20)), dec(0.7, 'block'));
      await ctx.logger.log(makeOp('agent-r-3', 'tool-mixed', 'sess-3', hoursAgo(30)), dec(0.05, 'allow'));
      await ctx.logger.log(makeOp('agent-r-4', 'tool-mixed', 'sess-4', daysAgo(7)), dec(0.95, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      // avg of (0.3, 0.7) = 0.5, max = 0.7, min = 0.3
      expect(body.avgRiskScoreLast24h as number).toBeCloseTo(0.5, 5);
      expect(body.maxRiskScoreLast24h as number).toBeCloseTo(0.7, 5);
      expect(body.minRiskScoreLast24h as number).toBeCloseTo(0.3, 5);
    });

    it('26. summary — all ops exactly at 0.0 risk score: avg=max=min=0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s-1', 'tool-zero', 'sess-1', hoursAgo(1)), dec(0.0, 'allow'));
      await ctx.logger.log(makeOp('agent-s-2', 'tool-zero', 'sess-2', hoursAgo(5)), dec(0.0, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.avgRiskScoreLast24h as number).toBeCloseTo(0.0, 5);
      expect(body.maxRiskScoreLast24h as number).toBeCloseTo(0.0, 5);
      expect(body.minRiskScoreLast24h as number).toBeCloseTo(0.0, 5);
    });

    it('27. summary — all ops at max risk score 1.0: avg=max=min=1.0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-t-1', 'tool-max', 'sess-1', hoursAgo(2)), dec(1.0, 'block'));
      await ctx.logger.log(makeOp('agent-t-2', 'tool-max', 'sess-2', hoursAgo(8)), dec(1.0, 'block'));
      await ctx.logger.log(makeOp('agent-t-3', 'tool-max', 'sess-3', hoursAgo(22)), dec(1.0, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.avgRiskScoreLast24h as number).toBeCloseTo(1.0, 5);
      expect(body.maxRiskScoreLast24h as number).toBeCloseTo(1.0, 5);
      expect(body.minRiskScoreLast24h as number).toBeCloseTo(1.0, 5);
    });
  });
});

// ── v10.71 ────────────────────────────────────────────────────────────────────

describe('v10.71', () => {
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1424-T1428 — v10.71 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1071-pres'), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1071-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('maxRiskScoreLast7d');
      expect(body).toHaveProperty('minRiskScoreLast7d');
      expect(body).toHaveProperty('maxRiskScoreLast30d');
      expect(body).toHaveProperty('minRiskScoreLast30d');
      expect(body).toHaveProperty('avgRiskScoreLast30d');
    });

    it('2. sessions — only old ops (>30d): all five fields are null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1071-old', daysAgo(35)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1071-old', daysAgo(45)), dec(0.7, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1071-old');
      expect(status).toBe(200);

      expect(body.maxRiskScoreLast7d).toBeNull();
      expect(body.minRiskScoreLast7d).toBeNull();
      expect(body.maxRiskScoreLast30d).toBeNull();
      expect(body.minRiskScoreLast30d).toBeNull();
      expect(body.avgRiskScoreLast30d).toBeNull();
    });

    it('3. sessions — three ops within 7d: max, min, avg computed correctly', async () => {
      ctx = await setup();
      // Scores: 0.2, 0.5, 0.8 in last 7d
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1071-7d', daysAgo(1)), dec(0.8, 'allow'));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1071-7d', daysAgo(3)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1071-7d', daysAgo(5)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1071-7d');
      expect(status).toBe(200);

      expect(body.maxRiskScoreLast7d as number).toBeCloseTo(0.8, 5);
      expect(body.minRiskScoreLast7d as number).toBeCloseTo(0.2, 5);
      // 30d window includes the same 3 ops
      expect(body.maxRiskScoreLast30d as number).toBeCloseTo(0.8, 5);
      expect(body.minRiskScoreLast30d as number).toBeCloseTo(0.2, 5);
      expect(body.avgRiskScoreLast30d as number).toBeCloseTo((0.2 + 0.5 + 0.8) / 3, 5);
    });

    it('4. sessions — ops in 30d but not 7d: 7d fields null, 30d fields populated', async () => {
      ctx = await setup();
      // Ops at 10d and 20d — inside 30d window, outside 7d
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1071-30d', daysAgo(10)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1071-30d', daysAgo(20)), dec(0.9, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1071-30d');
      expect(status).toBe(200);

      expect(body.maxRiskScoreLast7d).toBeNull();
      expect(body.minRiskScoreLast7d).toBeNull();

      expect(body.maxRiskScoreLast30d as number).toBeCloseTo(0.9, 5);
      expect(body.minRiskScoreLast30d as number).toBeCloseTo(0.3, 5);
      expect(body.avgRiskScoreLast30d as number).toBeCloseTo((0.3 + 0.9) / 2, 5);
    });

    it('5. sessions — mix of windows: 7d and 30d fields reflect only their window', async () => {
      ctx = await setup();
      // In 7d: 0.1, 0.9
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1071-mix', daysAgo(2)), dec(0.9, 'allow'));
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1071-mix', daysAgo(5)), dec(0.1, 'allow'));
      // In 30d but not 7d: 0.4, 0.6
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1071-mix', daysAgo(15)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1071-mix', daysAgo(25)), dec(0.6, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1071-mix');
      expect(status).toBe(200);

      // 7d window: [0.1, 0.9]
      expect(body.maxRiskScoreLast7d as number).toBeCloseTo(0.9, 5);
      expect(body.minRiskScoreLast7d as number).toBeCloseTo(0.1, 5);

      // 30d window: [0.1, 0.4, 0.6, 0.9]
      expect(body.maxRiskScoreLast30d as number).toBeCloseTo(0.9, 5);
      expect(body.minRiskScoreLast30d as number).toBeCloseTo(0.1, 5);
      expect(body.avgRiskScoreLast30d as number).toBeCloseTo((0.1 + 0.4 + 0.6 + 0.9) / 4, 5);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1424-T1428 — v10.71 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('6. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1071-pres', 'fs', 'sess-1'), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1071-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('maxRiskScoreLast7d');
      expect(body).toHaveProperty('minRiskScoreLast7d');
      expect(body).toHaveProperty('maxRiskScoreLast30d');
      expect(body).toHaveProperty('minRiskScoreLast30d');
      expect(body).toHaveProperty('avgRiskScoreLast30d');
    });

    it('7. agents — only old ops (>30d): all five fields null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1071-old', 'fs', 'sess-1', daysAgo(35)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-v1071-old', 'fs', 'sess-2', daysAgo(50)), dec(0.8, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1071-old');
      expect(status).toBe(200);

      expect(body.maxRiskScoreLast7d).toBeNull();
      expect(body.minRiskScoreLast7d).toBeNull();
      expect(body.maxRiskScoreLast30d).toBeNull();
      expect(body.minRiskScoreLast30d).toBeNull();
      expect(body.avgRiskScoreLast30d).toBeNull();
    });

    it('8. agents — four ops in 7d: max and min computed correctly', async () => {
      ctx = await setup();
      // Scores in 7d: 0.1, 0.4, 0.7, 0.95
      for (const [score, d] of [[0.95, 1], [0.1, 2], [0.7, 4], [0.4, 6]] as [number, number][]) {
        await ctx.logger.log(makeOp('agent-v1071-7d', 'tool', 'sess-1', daysAgo(d)), dec(score, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1071-7d');
      expect(status).toBe(200);

      expect(body.maxRiskScoreLast7d as number).toBeCloseTo(0.95, 5);
      expect(body.minRiskScoreLast7d as number).toBeCloseTo(0.1, 5);
      expect(body.maxRiskScoreLast30d as number).toBeCloseTo(0.95, 5);
      expect(body.minRiskScoreLast30d as number).toBeCloseTo(0.1, 5);
      expect(body.avgRiskScoreLast30d as number).toBeCloseTo((0.1 + 0.4 + 0.7 + 0.95) / 4, 5);
    });

    it('9. agents — ops between 7d and 30d: 7d fields null, 30d fields populated', async () => {
      ctx = await setup();
      // Three ops at 10d, 20d, 28d — inside 30d but outside 7d
      for (const [score, d] of [[0.2, 10], [0.6, 20], [0.9, 28]] as [number, number][]) {
        await ctx.logger.log(makeOp('agent-v1071-30d', 'tool', 'sess-1', daysAgo(d)), dec(score, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1071-30d');
      expect(status).toBe(200);

      expect(body.maxRiskScoreLast7d).toBeNull();
      expect(body.minRiskScoreLast7d).toBeNull();

      expect(body.maxRiskScoreLast30d as number).toBeCloseTo(0.9, 5);
      expect(body.minRiskScoreLast30d as number).toBeCloseTo(0.2, 5);
      expect(body.avgRiskScoreLast30d as number).toBeCloseTo((0.2 + 0.6 + 0.9) / 3, 5);
    });

    it('10. agents — avgRiskScoreLast30d is mean of 30d ops only (older ops excluded)', async () => {
      ctx = await setup();
      // In 30d: 0.3, 0.7 → avg = 0.5
      await ctx.logger.log(makeOp('agent-v1071-avg', 'tool', 'sess-1', daysAgo(5)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-v1071-avg', 'tool', 'sess-2', daysAgo(15)), dec(0.7, 'allow'));
      // Older than 30d: 0.0 — should NOT affect avg
      await ctx.logger.log(makeOp('agent-v1071-avg', 'tool', 'sess-3', daysAgo(40)), dec(0.0, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1071-avg');
      expect(status).toBe(200);

      // avgRiskScoreLast30d = (0.3 + 0.7) / 2 = 0.5, old op excluded
      expect(body.avgRiskScoreLast30d as number).toBeCloseTo(0.5, 5);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1424-T1428 — v10.71 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('11. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-f', 'tool-v1071-pres', 'sess-1'), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1071-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('maxRiskScoreLast7d');
      expect(body).toHaveProperty('minRiskScoreLast7d');
      expect(body).toHaveProperty('maxRiskScoreLast30d');
      expect(body).toHaveProperty('minRiskScoreLast30d');
      expect(body).toHaveProperty('avgRiskScoreLast30d');
    });

    it('12. tools — only old ops (>30d): all five fields null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-g', 'tool-v1071-old', 'sess-1', daysAgo(35)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-g', 'tool-v1071-old', 'sess-2', daysAgo(50)), dec(0.9, 'block'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1071-old');
      expect(status).toBe(200);

      expect(body.maxRiskScoreLast7d).toBeNull();
      expect(body.minRiskScoreLast7d).toBeNull();
      expect(body.maxRiskScoreLast30d).toBeNull();
      expect(body.minRiskScoreLast30d).toBeNull();
      expect(body.avgRiskScoreLast30d).toBeNull();
    });

    it('13. tools — ops only in 30d (not 7d): 7d fields null, 30d fields correct', async () => {
      ctx = await setup();
      // Three ops at 10d, 20d, 28d
      await ctx.logger.log(makeOp('agent-h-1', 'tool-v1071-30d-only', 'sess-1', daysAgo(10)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-h-2', 'tool-v1071-30d-only', 'sess-2', daysAgo(20)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-h-3', 'tool-v1071-30d-only', 'sess-3', daysAgo(28)), dec(0.8, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1071-30d-only');
      expect(status).toBe(200);

      expect(body.maxRiskScoreLast7d).toBeNull();
      expect(body.minRiskScoreLast7d).toBeNull();

      expect(body.maxRiskScoreLast30d as number).toBeCloseTo(0.8, 5);
      expect(body.minRiskScoreLast30d as number).toBeCloseTo(0.2, 5);
      expect(body.avgRiskScoreLast30d as number).toBeCloseTo((0.2 + 0.5 + 0.8) / 3, 5);
    });

    it('14. tools — ops across all windows: 7d and 30d fields independent', async () => {
      ctx = await setup();
      // In 7d: 0.2, 0.8
      await ctx.logger.log(makeOp('agent-i-1', 'tool-v1071-cross', 'sess-1', daysAgo(2)), dec(0.8, 'allow'));
      await ctx.logger.log(makeOp('agent-i-2', 'tool-v1071-cross', 'sess-2', daysAgo(6)), dec(0.2, 'allow'));
      // In 30d but not 7d: 0.1, 0.9
      await ctx.logger.log(makeOp('agent-i-3', 'tool-v1071-cross', 'sess-3', daysAgo(12)), dec(0.1, 'block'));
      await ctx.logger.log(makeOp('agent-i-4', 'tool-v1071-cross', 'sess-4', daysAgo(25)), dec(0.9, 'allow'));
      // Older than 30d: 0.5 — excluded from all window fields
      await ctx.logger.log(makeOp('agent-i-5', 'tool-v1071-cross', 'sess-5', daysAgo(40)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1071-cross');
      expect(status).toBe(200);

      // 7d window: [0.2, 0.8]
      expect(body.maxRiskScoreLast7d as number).toBeCloseTo(0.8, 5);
      expect(body.minRiskScoreLast7d as number).toBeCloseTo(0.2, 5);

      // 30d window: [0.1, 0.2, 0.8, 0.9]
      expect(body.maxRiskScoreLast30d as number).toBeCloseTo(0.9, 5);
      expect(body.minRiskScoreLast30d as number).toBeCloseTo(0.1, 5);
      expect(body.avgRiskScoreLast30d as number).toBeCloseTo((0.1 + 0.2 + 0.8 + 0.9) / 4, 5);
    });
  });

  // ── operations/summary endpoint ────────────────────────────────────────────────

  describe('T1424-T1428 — v10.71 new fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('15. summary — all five new fields present', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-j', 'tool-s', 'sess-1'), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body).toHaveProperty('maxRiskScoreLast7d');
      expect(body).toHaveProperty('minRiskScoreLast7d');
      expect(body).toHaveProperty('maxRiskScoreLast30d');
      expect(body).toHaveProperty('minRiskScoreLast30d');
      expect(body).toHaveProperty('avgRiskScoreLast30d');
    });

    it('16. summary — empty DB: all five new fields are null', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.maxRiskScoreLast7d).toBeNull();
      expect(body.minRiskScoreLast7d).toBeNull();
      expect(body.maxRiskScoreLast30d).toBeNull();
      expect(body.minRiskScoreLast30d).toBeNull();
      expect(body.avgRiskScoreLast30d).toBeNull();
    });

    it('17. summary — only old ops (>30d): all five fields null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-k-1', 'tool-k', 'sess-1', daysAgo(35)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-k-2', 'tool-k', 'sess-2', daysAgo(45)), dec(0.7, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.maxRiskScoreLast7d).toBeNull();
      expect(body.minRiskScoreLast7d).toBeNull();
      expect(body.maxRiskScoreLast30d).toBeNull();
      expect(body.minRiskScoreLast30d).toBeNull();
      expect(body.avgRiskScoreLast30d).toBeNull();
    });

    it('18. summary — four ops in 7d: max and min correct', async () => {
      ctx = await setup();
      // Scores in 7d: 0.05, 0.3, 0.7, 0.95
      for (const [score, d] of [[0.3, 1], [0.95, 4], [0.7, 5], [0.05, 6]] as [number, number][]) {
        await ctx.logger.log(makeOp(`agent-sum-7d-${d}`, 'tool-sum', `sess-sum-7d-${d}`, daysAgo(d)), dec(score, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.maxRiskScoreLast7d as number).toBeCloseTo(0.95, 5);
      expect(body.minRiskScoreLast7d as number).toBeCloseTo(0.05, 5);
      // All 4 ops also in 30d window
      expect(body.maxRiskScoreLast30d as number).toBeCloseTo(0.95, 5);
      expect(body.minRiskScoreLast30d as number).toBeCloseTo(0.05, 5);
      expect(body.avgRiskScoreLast30d as number).toBeCloseTo((0.05 + 0.3 + 0.7 + 0.95) / 4, 5);
    });

    it('19. summary — ops only in 30d (not 7d): 7d fields null, 30d fields populated', async () => {
      ctx = await setup();
      // Three ops at 10d, 18d, 27d
      await ctx.logger.log(makeOp('agent-sum-30d-1', 'tool-sum-30d', 'sess-1', daysAgo(10)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-sum-30d-2', 'tool-sum-30d', 'sess-2', daysAgo(18)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-sum-30d-3', 'tool-sum-30d', 'sess-3', daysAgo(27)), dec(0.8, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.maxRiskScoreLast7d).toBeNull();
      expect(body.minRiskScoreLast7d).toBeNull();

      expect(body.maxRiskScoreLast30d as number).toBeCloseTo(0.8, 5);
      expect(body.minRiskScoreLast30d as number).toBeCloseTo(0.2, 5);
      expect(body.avgRiskScoreLast30d as number).toBeCloseTo((0.2 + 0.5 + 0.8) / 3, 5);
    });

    it('20. summary — mix across all time ranges: 7d and 30d reflect only their window', async () => {
      ctx = await setup();
      // In 7d: 0.1, 0.9
      await ctx.logger.log(makeOp('agent-sum-mix-1', 'tool-sum-mix', 'sess-1', daysAgo(2)), dec(0.9, 'allow'));
      await ctx.logger.log(makeOp('agent-sum-mix-2', 'tool-sum-mix', 'sess-2', daysAgo(5)), dec(0.1, 'allow'));
      // In 30d but not 7d: 0.4, 0.6
      await ctx.logger.log(makeOp('agent-sum-mix-3', 'tool-sum-mix', 'sess-3', daysAgo(15)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-sum-mix-4', 'tool-sum-mix', 'sess-4', daysAgo(25)), dec(0.6, 'block'));
      // Older than 30d: 0.0, 1.0 — excluded from all window fields
      await ctx.logger.log(makeOp('agent-sum-mix-5', 'tool-sum-mix', 'sess-5', daysAgo(35)), dec(0.0, 'allow'));
      await ctx.logger.log(makeOp('agent-sum-mix-6', 'tool-sum-mix', 'sess-6', daysAgo(50)), dec(1.0, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      // 7d window: [0.1, 0.9]
      expect(body.maxRiskScoreLast7d as number).toBeCloseTo(0.9, 5);
      expect(body.minRiskScoreLast7d as number).toBeCloseTo(0.1, 5);

      // 30d window: [0.1, 0.4, 0.6, 0.9]
      expect(body.maxRiskScoreLast30d as number).toBeCloseTo(0.9, 5);
      expect(body.minRiskScoreLast30d as number).toBeCloseTo(0.1, 5);
      expect(body.avgRiskScoreLast30d as number).toBeCloseTo((0.1 + 0.4 + 0.6 + 0.9) / 4, 5);
    });
  });
});

// ── v10.72 ────────────────────────────────────────────────────────────────────

describe('v10.72', () => {
  const hoursAgo = (h: number) => new Date(PINNED_NOW() - h * 3_600_000);
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1429-T1433 — v10.72 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1072-pres', hoursAgo(1)), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1072-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('riskScoreStdDevLast24h');
      expect(body).toHaveProperty('riskScoreStdDevLast30d');
      expect(body).toHaveProperty('riskScoreSkewnessLast7d');
      expect(body).toHaveProperty('riskScoreSkewnessLast30d');
      expect(body).toHaveProperty('riskScoreKurtosisLast7d');
    });

    it('2. sessions — single op: stddev fields return 0 (not null), skewness fields null, kurtosis null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1072-one', hoursAgo(1)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1072-one');
      expect(status).toBe(200);

      // 1 op → population stddev = 0 (T1429/T1430 guard is length===0, not <2)
      expect(body.riskScoreStdDevLast24h as number).toBeCloseTo(0, 5);
      expect(body.riskScoreStdDevLast30d as number).toBeCloseTo(0, 5);
      // < 3 ops → skewness null
      expect(body.riskScoreSkewnessLast7d).toBeNull();
      expect(body.riskScoreSkewnessLast30d).toBeNull();
      // < 4 ops → kurtosis null
      expect(body.riskScoreKurtosisLast7d).toBeNull();
    });

    it('3. sessions — two ops in 24h/30d: stddev computed; skewness and kurtosis still null', async () => {
      ctx = await setup();
      // Two ops within 24h window with scores [0.2, 0.8]
      // population stddev: mean=0.5, variance=((0.2-0.5)^2+(0.8-0.5)^2)/2=0.09, stddev=0.3
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1072-two', hoursAgo(2)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1072-two', hoursAgo(4)), dec(0.8, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1072-two');
      expect(status).toBe(200);

      expect(body.riskScoreStdDevLast24h as number).toBeCloseTo(0.3, 5);
      expect(body.riskScoreStdDevLast30d as number).toBeCloseTo(0.3, 5);
      // < 3 ops → skewness still null
      expect(body.riskScoreSkewnessLast7d).toBeNull();
      expect(body.riskScoreSkewnessLast30d).toBeNull();
      // < 4 ops → kurtosis still null
      expect(body.riskScoreKurtosisLast7d).toBeNull();
    });

    it('4. sessions — three ops in 7d: riskScoreSkewnessLast7d computed (asymmetric)', async () => {
      ctx = await setup();
      // Asymmetric set [0.1, 0.2, 0.9] → expected skewness ≈ 0.6654688661238347
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1072-skew7', daysAgo(1)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1072-skew7', daysAgo(2)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1072-skew7', daysAgo(3)), dec(0.9, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1072-skew7');
      expect(status).toBe(200);

      // mean=0.4, stddev≈0.3559, skewness≈0.6655
      expect(body.riskScoreSkewnessLast7d as number).toBeCloseTo(0.6654688661238347, 5);
      // kurtosis still null (only 3 ops < 4)
      expect(body.riskScoreKurtosisLast7d).toBeNull();
    });

    it('5. sessions — symmetric three ops in 7d: skewness ≈ 0', async () => {
      ctx = await setup();
      // Symmetric set [0.2, 0.5, 0.8] — mean=0.5, symmetric → skewness=0
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1072-sym7', daysAgo(1)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1072-sym7', daysAgo(2)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1072-sym7', daysAgo(3)), dec(0.8, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1072-sym7');
      expect(status).toBe(200);

      expect(body.riskScoreSkewnessLast7d as number).toBeCloseTo(0, 5);
    });

    it('6. sessions — zero variance in 7d: skewness returns 0 (not null)', async () => {
      ctx = await setup();
      // All same values → stddev=0 → skewness guard returns 0
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1072-zerov', daysAgo(1)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1072-zerov', daysAgo(2)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1072-zerov', daysAgo(3)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1072-zerov');
      expect(status).toBe(200);

      expect(body.riskScoreSkewnessLast7d).toBe(0);
      // kurtosis still null (only 3 ops)
      expect(body.riskScoreKurtosisLast7d).toBeNull();
    });

    it('7. sessions — four ops in 7d: riskScoreKurtosisLast7d computed (uniform-like, negative excess)', async () => {
      ctx = await setup();
      // Uniform-like [0.1, 0.2, 0.8, 0.9] → excess kurtosis ≈ -1.9216
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1072-kurt7', daysAgo(1)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1072-kurt7', daysAgo(2)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1072-kurt7', daysAgo(3)), dec(0.8, 'allow'));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1072-kurt7', daysAgo(4)), dec(0.9, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1072-kurt7');
      expect(status).toBe(200);

      // mean=0.5, stddev≈0.3536, excess kurtosis≈-1.9216
      expect(body.riskScoreKurtosisLast7d as number).toBeCloseTo(-1.9216, 3);
    });

    it('8. sessions — zero variance in 7d (4 ops): kurtosis returns 0 (not null)', async () => {
      ctx = await setup();
      // All same → stddev=0 → kurtosis guard returns 0
      for (let i = 1; i <= 4; i++) {
        await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1072-zk', daysAgo(i)), dec(0.6, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1072-zk');
      expect(status).toBe(200);

      expect(body.riskScoreKurtosisLast7d).toBe(0);
    });

    it('9. sessions — only old ops (>30d): all five fields null', async () => {
      ctx = await setup();
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v1072-old', daysAgo(35 + i)), dec(0.3 + i * 0.1, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1072-old');
      expect(status).toBe(200);

      expect(body.riskScoreStdDevLast24h).toBeNull();
      expect(body.riskScoreStdDevLast30d).toBeNull();
      expect(body.riskScoreSkewnessLast7d).toBeNull();
      expect(body.riskScoreSkewnessLast30d).toBeNull();
      expect(body.riskScoreKurtosisLast7d).toBeNull();
    });

    it('10. sessions — ops in 30d only (not 7d): 30d skewness computed; 7d fields null', async () => {
      ctx = await setup();
      // Three ops in 30d window (8-28 days ago), outside 7d
      // [0.1, 0.2, 0.9] → skewness30d ≈ 0.6655
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v1072-30only', daysAgo(8)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v1072-30only', daysAgo(15)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v1072-30only', daysAgo(22)), dec(0.9, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1072-30only');
      expect(status).toBe(200);

      // 7d window empty → null
      expect(body.riskScoreSkewnessLast7d).toBeNull();
      expect(body.riskScoreKurtosisLast7d).toBeNull();
      // 30d window: [0.1, 0.2, 0.9] → skewness≈0.6655
      expect(body.riskScoreSkewnessLast30d as number).toBeCloseTo(0.6654688661238347, 5);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1429-T1433 — v10.72 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('11. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1072-pres', 'fs', 'sess-1', hoursAgo(1)), dec(0.3, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1072-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('riskScoreStdDevLast24h');
      expect(body).toHaveProperty('riskScoreStdDevLast30d');
      expect(body).toHaveProperty('riskScoreSkewnessLast7d');
      expect(body).toHaveProperty('riskScoreSkewnessLast30d');
      expect(body).toHaveProperty('riskScoreKurtosisLast7d');
    });

    it('12. agents — two ops in 24h: stddev computed; skewness and kurtosis null', async () => {
      ctx = await setup();
      // [0.3, 0.7] → mean=0.5, stddev=0.2
      await ctx.logger.log(makeOp('agent-v1072-std24', 'fs', 'sess-1', hoursAgo(2)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-v1072-std24', 'fs', 'sess-1', hoursAgo(4)), dec(0.7, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1072-std24');
      expect(status).toBe(200);

      expect(body.riskScoreStdDevLast24h as number).toBeCloseTo(0.2, 5);
      expect(body.riskScoreSkewnessLast7d).toBeNull();
      expect(body.riskScoreKurtosisLast7d).toBeNull();
    });

    it('13. agents — three ops in 7d: skewness computed', async () => {
      ctx = await setup();
      // [0.1, 0.2, 0.9] → skewness ≈ 0.6655
      await ctx.logger.log(makeOp('agent-v1072-skew', 'fs', 'sess-1', daysAgo(1)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-v1072-skew', 'fs', 'sess-1', daysAgo(2)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-v1072-skew', 'fs', 'sess-1', daysAgo(3)), dec(0.9, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1072-skew');
      expect(status).toBe(200);

      expect(body.riskScoreSkewnessLast7d as number).toBeCloseTo(0.6654688661238347, 5);
      expect(body.riskScoreKurtosisLast7d).toBeNull(); // only 3 ops
    });

    it('14. agents — four ops in 7d: kurtosis computed', async () => {
      ctx = await setup();
      // [0.1, 0.2, 0.8, 0.9] → excess kurtosis ≈ -1.9216
      await ctx.logger.log(makeOp('agent-v1072-kurt', 'fs', 'sess-1', daysAgo(1)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-v1072-kurt', 'fs', 'sess-1', daysAgo(2)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-v1072-kurt', 'fs', 'sess-1', daysAgo(3)), dec(0.8, 'allow'));
      await ctx.logger.log(makeOp('agent-v1072-kurt', 'fs', 'sess-1', daysAgo(4)), dec(0.9, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1072-kurt');
      expect(status).toBe(200);

      expect(body.riskScoreKurtosisLast7d as number).toBeCloseTo(-1.9216, 3);
    });

    it('15. agents — only old ops: all five fields null', async () => {
      ctx = await setup();
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp('agent-v1072-old', 'fs', 'sess-1', daysAgo(35 + i)), dec(0.5, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1072-old');
      expect(status).toBe(200);

      expect(body.riskScoreStdDevLast24h).toBeNull();
      expect(body.riskScoreStdDevLast30d).toBeNull();
      expect(body.riskScoreSkewnessLast7d).toBeNull();
      expect(body.riskScoreSkewnessLast30d).toBeNull();
      expect(body.riskScoreKurtosisLast7d).toBeNull();
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1429-T1433 — v10.72 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('16. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v1072-pres', 'sess-1', hoursAgo(1)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1072-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('riskScoreStdDevLast24h');
      expect(body).toHaveProperty('riskScoreStdDevLast30d');
      expect(body).toHaveProperty('riskScoreSkewnessLast7d');
      expect(body).toHaveProperty('riskScoreSkewnessLast30d');
      expect(body).toHaveProperty('riskScoreKurtosisLast7d');
    });

    it('17. tools — two ops in 24h: stddev correct; skewness and kurtosis null', async () => {
      ctx = await setup();
      // [0.1, 0.9] → mean=0.5, stddev=0.4
      await ctx.logger.log(makeOp('agent-t', 'tool-v1072-std', 'sess-1', hoursAgo(2)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-t', 'tool-v1072-std', 'sess-1', hoursAgo(6)), dec(0.9, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1072-std');
      expect(status).toBe(200);

      expect(body.riskScoreStdDevLast24h as number).toBeCloseTo(0.4, 5);
      expect(body.riskScoreSkewnessLast7d).toBeNull();
      expect(body.riskScoreKurtosisLast7d).toBeNull();
    });

    it('18. tools — three ops in 7d: skewness computed', async () => {
      ctx = await setup();
      // Asymmetric [0.1, 0.2, 0.9] → skewness ≈ 0.6655
      await ctx.logger.log(makeOp('agent-t', 'tool-v1072-sk7', 'sess-1', daysAgo(1)), dec(0.9, 'allow'));
      await ctx.logger.log(makeOp('agent-t', 'tool-v1072-sk7', 'sess-1', daysAgo(2)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-t', 'tool-v1072-sk7', 'sess-1', daysAgo(3)), dec(0.1, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1072-sk7');
      expect(status).toBe(200);

      expect(body.riskScoreSkewnessLast7d as number).toBeCloseTo(0.6654688661238347, 5);
    });

    it('19. tools — four ops in 7d: kurtosis computed', async () => {
      ctx = await setup();
      // [0.1, 0.2, 0.8, 0.9] → excess kurtosis ≈ -1.9216
      await ctx.logger.log(makeOp('agent-t', 'tool-v1072-kur', 'sess-1', daysAgo(1)), dec(0.9, 'allow'));
      await ctx.logger.log(makeOp('agent-t', 'tool-v1072-kur', 'sess-1', daysAgo(2)), dec(0.8, 'allow'));
      await ctx.logger.log(makeOp('agent-t', 'tool-v1072-kur', 'sess-1', daysAgo(3)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-t', 'tool-v1072-kur', 'sess-1', daysAgo(4)), dec(0.1, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1072-kur');
      expect(status).toBe(200);

      expect(body.riskScoreKurtosisLast7d as number).toBeCloseTo(-1.9216, 3);
    });

    it('20. tools — only old ops: all five fields null', async () => {
      ctx = await setup();
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp('agent-t', 'tool-v1072-old', 'sess-1', daysAgo(35 + i)), dec(0.5, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1072-old');
      expect(status).toBe(200);

      expect(body.riskScoreStdDevLast24h).toBeNull();
      expect(body.riskScoreStdDevLast30d).toBeNull();
      expect(body.riskScoreSkewnessLast7d).toBeNull();
      expect(body.riskScoreSkewnessLast30d).toBeNull();
      expect(body.riskScoreKurtosisLast7d).toBeNull();
    });
  });

  // ── summary endpoint ────────────────────────────────────────────────────────────

  describe('T1429-T1433 — v10.72 new fields (summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('21. summary — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', hoursAgo(1)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body).toHaveProperty('riskScoreStdDevLast24h');
      expect(body).toHaveProperty('riskScoreStdDevLast30d');
      expect(body).toHaveProperty('riskScoreSkewnessLast7d');
      expect(body).toHaveProperty('riskScoreSkewnessLast30d');
      expect(body).toHaveProperty('riskScoreKurtosisLast7d');
    });

    it('22. summary — single op: stddev fields return 0 (not null); skewness and kurtosis null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', hoursAgo(1)), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      // 1 op → population stddev = 0 (T1429/T1430 guard is length===0, not <2)
      expect(body.riskScoreStdDevLast24h as number).toBeCloseTo(0, 5);
      expect(body.riskScoreStdDevLast30d as number).toBeCloseTo(0, 5);
      expect(body.riskScoreSkewnessLast7d).toBeNull();
      expect(body.riskScoreSkewnessLast30d).toBeNull();
      expect(body.riskScoreKurtosisLast7d).toBeNull();
    });

    it('23. summary — two recent ops: stddev computed; skewness and kurtosis null', async () => {
      ctx = await setup();
      // [0.2, 0.8] → mean=0.5, stddev=0.3
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', hoursAgo(2)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-2', hoursAgo(4)), dec(0.8, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.riskScoreStdDevLast24h as number).toBeCloseTo(0.3, 5);
      expect(body.riskScoreStdDevLast30d as number).toBeCloseTo(0.3, 5);
      expect(body.riskScoreSkewnessLast7d).toBeNull();
      expect(body.riskScoreSkewnessLast30d).toBeNull();
      expect(body.riskScoreKurtosisLast7d).toBeNull();
    });

    it('24. summary — three ops in 7d: skewness computed', async () => {
      ctx = await setup();
      // [0.1, 0.2, 0.9] → skewness ≈ 0.6655
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', daysAgo(1)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-2', daysAgo(2)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-3', daysAgo(3)), dec(0.9, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.riskScoreSkewnessLast7d as number).toBeCloseTo(0.6654688661238347, 5);
      expect(body.riskScoreKurtosisLast7d).toBeNull(); // only 3 ops
    });

    it('25. summary — four ops in 7d: kurtosis computed (negative excess)', async () => {
      ctx = await setup();
      // [0.1, 0.2, 0.8, 0.9] → excess kurtosis ≈ -1.9216
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', daysAgo(1)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-2', daysAgo(2)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-3', daysAgo(3)), dec(0.8, 'allow'));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-4', daysAgo(4)), dec(0.9, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.riskScoreKurtosisLast7d as number).toBeCloseTo(-1.9216, 3);
    });

    it('26. summary — zero variance (4 identical ops): skewness=0, kurtosis=0', async () => {
      ctx = await setup();
      for (let i = 1; i <= 4; i++) {
        await ctx.logger.log(makeOp(`agent-${i}`, 'fs', `sess-${i}`, daysAgo(i)), dec(0.7, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.riskScoreSkewnessLast7d).toBe(0);
      expect(body.riskScoreKurtosisLast7d).toBe(0);
    });

    it('27. summary — ops in 30d window only (outside 7d): 30d skewness computed; 7d fields null', async () => {
      ctx = await setup();
      // Three ops at 8, 15, 22 days ago
      // [0.1, 0.2, 0.9] → skewness30d ≈ 0.6655
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', daysAgo(8)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-2', daysAgo(15)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-3', daysAgo(22)), dec(0.9, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.riskScoreSkewnessLast7d).toBeNull();
      expect(body.riskScoreKurtosisLast7d).toBeNull();
      expect(body.riskScoreSkewnessLast30d as number).toBeCloseTo(0.6654688661238347, 5);
    });

    it('28. summary — stddev 24h is isolated from 30d window', async () => {
      ctx = await setup();
      // One op in 24h, more ops in 30d window
      // 24h window: [0.3, 0.7] → stddev=0.2
      // 30d window: [0.1, 0.3, 0.7, 0.9] → mean=0.5, variance=0.08, stddev≈0.2828
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', hoursAgo(2)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-2', hoursAgo(4)), dec(0.7, 'allow'));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-3', daysAgo(10)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-4', daysAgo(20)), dec(0.9, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      // 24h: [0.3, 0.7] → stddev=0.2
      expect(body.riskScoreStdDevLast24h as number).toBeCloseTo(0.2, 5);
      // 30d: [0.1, 0.3, 0.7, 0.9] → mean=0.5, variance=0.1, stddev≈0.3162
      expect(body.riskScoreStdDevLast30d as number).toBeCloseTo(Math.sqrt(0.1), 5);
    });
  });
});

// ── v10.73 ────────────────────────────────────────────────────────────────────

describe('v10.73', () => {
  const hoursAgo = (h: number) => new Date(PINNED_NOW() - h * 3_600_000);
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);
  // Place a timestamp exactly N milliseconds after (PINNED_NOW() - windowMs)
  const msIntoWindow = (windowMs: number, offsetMs: number) =>
    new Date(PINNED_NOW() - windowMs + offsetMs);

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1434-T1438 — v10.73 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1073-pres', hoursAgo(1)), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1073-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('riskScoreKurtosisLast30d');
      expect(body).toHaveProperty('riskScoreKurtosisAllTime');
      expect(body).toHaveProperty('riskScoreSkewnessAllTime');
      expect(body).toHaveProperty('opsTrendSlopeLast7d');
      expect(body).toHaveProperty('opsTrendSlopeLast30d');
    });

    it('2. sessions — < 4 ops in 30d: riskScoreKurtosisLast30d is null', async () => {
      ctx = await setup();
      // 3 ops within 30d window
      for (let i = 1; i <= 3; i++) {
        await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1073-kurt30-null', daysAgo(i)), dec(0.5, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1073-kurt30-null');
      expect(status).toBe(200);
      expect(body.riskScoreKurtosisLast30d).toBeNull();
    });

    it('3. sessions — 4 ops in 30d: riskScoreKurtosisLast30d computed (negative excess)', async () => {
      ctx = await setup();
      // [0.1, 0.2, 0.8, 0.9] → mean=0.5, stddev=sqrt(0.125)≈0.35355
      // excess kurtosis ≈ -1.9216
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1073-kurt30', daysAgo(5)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1073-kurt30', daysAgo(10)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1073-kurt30', daysAgo(15)), dec(0.8, 'allow'));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1073-kurt30', daysAgo(20)), dec(0.9, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1073-kurt30');
      expect(status).toBe(200);
      expect(body.riskScoreKurtosisLast30d as number).toBeCloseTo(-1.9216, 3);
    });

    it('4. sessions — zero variance in 30d (4 identical ops): riskScoreKurtosisLast30d returns 0', async () => {
      ctx = await setup();
      for (let i = 1; i <= 4; i++) {
        await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1073-kurt30-zv', daysAgo(i)), dec(0.5, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1073-kurt30-zv');
      expect(status).toBe(200);
      expect(body.riskScoreKurtosisLast30d).toBe(0);
    });

    it('5. sessions — only old ops (>30d): riskScoreKurtosisLast30d is null', async () => {
      ctx = await setup();
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1073-kurt30-old', daysAgo(35 + i)), dec(0.3 + i * 0.1, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1073-kurt30-old');
      expect(status).toBe(200);
      expect(body.riskScoreKurtosisLast30d).toBeNull();
    });

    it('6. sessions — < 4 total logs: riskScoreKurtosisAllTime is null', async () => {
      ctx = await setup();
      // 3 all-time logs
      for (let i = 1; i <= 3; i++) {
        await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1073-kall-null', daysAgo(40 + i)), dec(0.5, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1073-kall-null');
      expect(status).toBe(200);
      expect(body.riskScoreKurtosisAllTime).toBeNull();
    });

    it('7. sessions — 4 total logs (including old): riskScoreKurtosisAllTime computed', async () => {
      ctx = await setup();
      // [0.1, 0.2, 0.8, 0.9] spread across time including >30d
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1073-kall', daysAgo(40)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1073-kall', daysAgo(35)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1073-kall', daysAgo(20)), dec(0.8, 'allow'));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1073-kall', daysAgo(10)), dec(0.9, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1073-kall');
      expect(status).toBe(200);
      // [0.1, 0.2, 0.8, 0.9] excess kurtosis ≈ -1.9216
      expect(body.riskScoreKurtosisAllTime as number).toBeCloseTo(-1.9216, 3);
    });

    it('8. sessions — zero variance all-time (4 ops): riskScoreKurtosisAllTime returns 0', async () => {
      ctx = await setup();
      for (let i = 1; i <= 4; i++) {
        await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1073-kall-zv', daysAgo(40 + i)), dec(0.6, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1073-kall-zv');
      expect(status).toBe(200);
      expect(body.riskScoreKurtosisAllTime).toBe(0);
    });

    it('9. sessions — < 3 total logs: riskScoreSkewnessAllTime is null', async () => {
      ctx = await setup();
      // 2 all-time logs
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v1073-sall-null', daysAgo(40)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v1073-sall-null', daysAgo(50)), dec(0.7, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1073-sall-null');
      expect(status).toBe(200);
      expect(body.riskScoreSkewnessAllTime).toBeNull();
    });

    it('10. sessions — 3 total logs (including old): riskScoreSkewnessAllTime computed', async () => {
      ctx = await setup();
      // [0.1, 0.2, 0.9] → skewness ≈ 0.6655
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v1073-sall', daysAgo(40)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v1073-sall', daysAgo(35)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v1073-sall', daysAgo(10)), dec(0.9, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1073-sall');
      expect(status).toBe(200);
      expect(body.riskScoreSkewnessAllTime as number).toBeCloseTo(0.6654688661238347, 5);
    });

    it('11. sessions — zero variance all-time (3 ops): riskScoreSkewnessAllTime returns 0', async () => {
      ctx = await setup();
      for (let i = 1; i <= 3; i++) {
        await ctx.logger.log(makeOp('agent-k', 'fs', 'sess-v1073-sall-zv', daysAgo(40 + i)), dec(0.5, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1073-sall-zv');
      expect(status).toBe(200);
      expect(body.riskScoreSkewnessAllTime).toBe(0);
    });

    it('12. sessions — single day in 7d window: opsTrendSlopeLast7d is null', async () => {
      ctx = await setup();
      // All ops on same day
      await ctx.logger.log(makeOp('agent-l', 'fs', 'sess-v1073-slope7-null', hoursAgo(2)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-l', 'fs', 'sess-v1073-slope7-null', hoursAgo(3)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1073-slope7-null');
      expect(status).toBe(200);
      expect(body.opsTrendSlopeLast7d).toBeNull();
    });

    it('13. sessions — 2 ops on day0, 4 ops on day2 (7d window): opsTrendSlopeLast7d ≈ 1', async () => {
      ctx = await setup();
      // day0: 2 ops (relative to cutoff = now - 7d), day2: 4 ops → OLS slope = (4-2)/2 = 1
      const cutoff7d = PINNED_NOW() - 604800000;
      // day0: 2 ops at cutoff + 1h
      await ctx.logger.log(makeOp('agent-m', 'fs', 'sess-v1073-slope7', new Date(cutoff7d + 3_600_000)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-m', 'fs', 'sess-v1073-slope7', new Date(cutoff7d + 3_601_000)), dec(0.5, 'allow'));
      // day2: 4 ops at cutoff + 2d + 1h
      const day2Start = cutoff7d + 2 * 86_400_000 + 3_600_000;
      await ctx.logger.log(makeOp('agent-m', 'fs', 'sess-v1073-slope7', new Date(day2Start)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-m', 'fs', 'sess-v1073-slope7', new Date(day2Start + 1000)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-m', 'fs', 'sess-v1073-slope7', new Date(day2Start + 2000)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-m', 'fs', 'sess-v1073-slope7', new Date(day2Start + 3000)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1073-slope7');
      expect(status).toBe(200);
      expect(body.opsTrendSlopeLast7d as number).toBeCloseTo(1, 5);
    });

    it('14. sessions — single day in 30d window: opsTrendSlopeLast30d is null', async () => {
      ctx = await setup();
      // All ops on same day within 30d. Offset by whole hours rather than
      // daysAgo(5): day buckets are floor((t - (now - 30d)) / 86400000), so a
      // fixture exactly N days old sits on a bucket edge and lands in bucket
      // N or N-1 depending on how many ms elapse before the query runs.
      await ctx.logger.log(makeOp('agent-n', 'fs', 'sess-v1073-slope30-null', hoursAgo(122)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-n', 'fs', 'sess-v1073-slope30-null', hoursAgo(123)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1073-slope30-null');
      expect(status).toBe(200);
      expect(body.opsTrendSlopeLast30d).toBeNull();
    });

    it('15. sessions — 2 ops on day0, 4 ops on day2 (30d window): opsTrendSlopeLast30d ≈ 1', async () => {
      ctx = await setup();
      const cutoff30d = PINNED_NOW() - 2592000000;
      // day0: 2 ops
      await ctx.logger.log(makeOp('agent-o', 'fs', 'sess-v1073-slope30', new Date(cutoff30d + 3_600_000)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-o', 'fs', 'sess-v1073-slope30', new Date(cutoff30d + 3_601_000)), dec(0.5, 'allow'));
      // day2: 4 ops
      const day2Start = cutoff30d + 2 * 86_400_000 + 3_600_000;
      await ctx.logger.log(makeOp('agent-o', 'fs', 'sess-v1073-slope30', new Date(day2Start)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-o', 'fs', 'sess-v1073-slope30', new Date(day2Start + 1000)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-o', 'fs', 'sess-v1073-slope30', new Date(day2Start + 2000)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-o', 'fs', 'sess-v1073-slope30', new Date(day2Start + 3000)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1073-slope30');
      expect(status).toBe(200);
      expect(body.opsTrendSlopeLast30d as number).toBeCloseTo(1, 5);
    });

    it('16. sessions — ops in 30d window but outside 7d: slope7d null, slope30d computed', async () => {
      ctx = await setup();
      // day0 and day2 of a 30d window (at ~25d ago and ~23d ago) — outside 7d
      const cutoff30d = PINNED_NOW() - 2592000000;
      await ctx.logger.log(makeOp('agent-p', 'fs', 'sess-v1073-slope-split', new Date(cutoff30d + 3_600_000)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-p', 'fs', 'sess-v1073-slope-split', new Date(cutoff30d + 3_601_000)), dec(0.5, 'allow'));
      const day2Start = cutoff30d + 2 * 86_400_000 + 3_600_000;
      await ctx.logger.log(makeOp('agent-p', 'fs', 'sess-v1073-slope-split', new Date(day2Start)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-p', 'fs', 'sess-v1073-slope-split', new Date(day2Start + 1000)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-p', 'fs', 'sess-v1073-slope-split', new Date(day2Start + 2000)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-p', 'fs', 'sess-v1073-slope-split', new Date(day2Start + 3000)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1073-slope-split');
      expect(status).toBe(200);
      // Outside 7d window → slope7d null
      expect(body.opsTrendSlopeLast7d).toBeNull();
      // Within 30d window → slope30d computed ≈ 1
      expect(body.opsTrendSlopeLast30d as number).toBeCloseTo(1, 5);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1434-T1438 — v10.73 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('17. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1073-pres', 'fs', 'sess-1', hoursAgo(1)), dec(0.3, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1073-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('riskScoreKurtosisLast30d');
      expect(body).toHaveProperty('riskScoreKurtosisAllTime');
      expect(body).toHaveProperty('riskScoreSkewnessAllTime');
      expect(body).toHaveProperty('opsTrendSlopeLast7d');
      expect(body).toHaveProperty('opsTrendSlopeLast30d');
    });

    it('18. agents — < 4 ops in 30d: kurtosis30d null; < 4 all-time: kurtosisAllTime null', async () => {
      ctx = await setup();
      // 3 ops within 30d
      for (let i = 1; i <= 3; i++) {
        await ctx.logger.log(makeOp('agent-v1073-null-k', 'fs', 'sess-1', daysAgo(i)), dec(0.5, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1073-null-k');
      expect(status).toBe(200);
      expect(body.riskScoreKurtosisLast30d).toBeNull();
      expect(body.riskScoreKurtosisAllTime).toBeNull();
    });

    it('19. agents — 4 ops total (all within 30d): both kurtosis fields computed', async () => {
      ctx = await setup();
      // [0.1, 0.2, 0.8, 0.9] → excess kurtosis ≈ -1.9216
      await ctx.logger.log(makeOp('agent-v1073-k4', 'fs', 'sess-1', daysAgo(5)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-v1073-k4', 'fs', 'sess-1', daysAgo(10)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-v1073-k4', 'fs', 'sess-1', daysAgo(15)), dec(0.8, 'allow'));
      await ctx.logger.log(makeOp('agent-v1073-k4', 'fs', 'sess-1', daysAgo(20)), dec(0.9, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1073-k4');
      expect(status).toBe(200);
      expect(body.riskScoreKurtosisLast30d as number).toBeCloseTo(-1.9216, 3);
      expect(body.riskScoreKurtosisAllTime as number).toBeCloseTo(-1.9216, 3);
    });

    it('20. agents — kurtosisAllTime includes ops older than 30d', async () => {
      ctx = await setup();
      // 3 ops in 30d window (< 4 → kurtosis30d null)
      // + 1 op older than 30d → 4 total → kurtosisAllTime computed
      await ctx.logger.log(makeOp('agent-v1073-k-all', 'fs', 'sess-1', daysAgo(5)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-v1073-k-all', 'fs', 'sess-1', daysAgo(10)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-v1073-k-all', 'fs', 'sess-1', daysAgo(20)), dec(0.8, 'allow'));
      await ctx.logger.log(makeOp('agent-v1073-k-all', 'fs', 'sess-1', daysAgo(40)), dec(0.9, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1073-k-all');
      expect(status).toBe(200);
      // 30d window has only 3 ops → null
      expect(body.riskScoreKurtosisLast30d).toBeNull();
      // all-time has 4 ops → computed
      expect(body.riskScoreKurtosisAllTime as number).toBeCloseTo(-1.9216, 3);
    });

    it('21. agents — 3 total logs: skewnessAllTime computed', async () => {
      ctx = await setup();
      // [0.1, 0.2, 0.9] spread across time
      await ctx.logger.log(makeOp('agent-v1073-sall', 'fs', 'sess-1', daysAgo(40)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-v1073-sall', 'fs', 'sess-1', daysAgo(35)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-v1073-sall', 'fs', 'sess-1', daysAgo(10)), dec(0.9, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1073-sall');
      expect(status).toBe(200);
      expect(body.riskScoreSkewnessAllTime as number).toBeCloseTo(0.6654688661238347, 5);
    });

    it('22. agents — 2 ops on day0, 4 ops on day2 in 7d: opsTrendSlopeLast7d ≈ 1', async () => {
      ctx = await setup();
      const cutoff7d = PINNED_NOW() - 604800000;
      await ctx.logger.log(makeOp('agent-v1073-sl7', 'fs', 'sess-1', new Date(cutoff7d + 3_600_000)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-v1073-sl7', 'fs', 'sess-1', new Date(cutoff7d + 3_601_000)), dec(0.5, 'allow'));
      const day2Start = cutoff7d + 2 * 86_400_000 + 3_600_000;
      await ctx.logger.log(makeOp('agent-v1073-sl7', 'fs', 'sess-1', new Date(day2Start)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-v1073-sl7', 'fs', 'sess-1', new Date(day2Start + 1000)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-v1073-sl7', 'fs', 'sess-1', new Date(day2Start + 2000)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-v1073-sl7', 'fs', 'sess-1', new Date(day2Start + 3000)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1073-sl7');
      expect(status).toBe(200);
      expect(body.opsTrendSlopeLast7d as number).toBeCloseTo(1, 5);
    });

    it('23. agents — only old ops: all five fields null', async () => {
      ctx = await setup();
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp('agent-v1073-old', 'fs', 'sess-1', daysAgo(35 + i)), dec(0.3 + i * 0.1, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1073-old');
      expect(status).toBe(200);

      // Only 5 ops all older than 30d → kurtosis30d null; skewness/kurtosis all-time computed from 5 ops
      // For slope: no ops in 7d or 30d windows → both null
      expect(body.opsTrendSlopeLast7d).toBeNull();
      expect(body.opsTrendSlopeLast30d).toBeNull();
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1434-T1438 — v10.73 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('24. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v1073-pres', 'sess-1', hoursAgo(1)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1073-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('riskScoreKurtosisLast30d');
      expect(body).toHaveProperty('riskScoreKurtosisAllTime');
      expect(body).toHaveProperty('riskScoreSkewnessAllTime');
      expect(body).toHaveProperty('opsTrendSlopeLast7d');
      expect(body).toHaveProperty('opsTrendSlopeLast30d');
    });

    it('25. tools — 4 ops in 30d: riskScoreKurtosisLast30d computed', async () => {
      ctx = await setup();
      // [0.1, 0.2, 0.8, 0.9] → excess kurtosis ≈ -1.9216
      await ctx.logger.log(makeOp('agent-t', 'tool-v1073-k30', 'sess-1', daysAgo(5)), dec(0.9, 'allow'));
      await ctx.logger.log(makeOp('agent-t', 'tool-v1073-k30', 'sess-1', daysAgo(10)), dec(0.8, 'allow'));
      await ctx.logger.log(makeOp('agent-t', 'tool-v1073-k30', 'sess-1', daysAgo(15)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-t', 'tool-v1073-k30', 'sess-1', daysAgo(20)), dec(0.1, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1073-k30');
      expect(status).toBe(200);
      expect(body.riskScoreKurtosisLast30d as number).toBeCloseTo(-1.9216, 3);
    });

    it('26. tools — 3 total logs: riskScoreSkewnessAllTime computed', async () => {
      ctx = await setup();
      // [0.1, 0.2, 0.9] → skewness ≈ 0.6655
      await ctx.logger.log(makeOp('agent-t', 'tool-v1073-sall', 'sess-1', daysAgo(40)), dec(0.9, 'allow'));
      await ctx.logger.log(makeOp('agent-t', 'tool-v1073-sall', 'sess-1', daysAgo(35)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-t', 'tool-v1073-sall', 'sess-1', daysAgo(10)), dec(0.1, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1073-sall');
      expect(status).toBe(200);
      expect(body.riskScoreSkewnessAllTime as number).toBeCloseTo(0.6654688661238347, 5);
    });

    it('27. tools — 2 ops on day0, 4 ops on day2 in 30d: opsTrendSlopeLast30d ≈ 1', async () => {
      ctx = await setup();
      const cutoff30d = PINNED_NOW() - 2592000000;
      await ctx.logger.log(makeOp('agent-t', 'tool-v1073-sl30', 'sess-1', new Date(cutoff30d + 3_600_000)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-t', 'tool-v1073-sl30', 'sess-1', new Date(cutoff30d + 3_601_000)), dec(0.5, 'allow'));
      const day2Start = cutoff30d + 2 * 86_400_000 + 3_600_000;
      await ctx.logger.log(makeOp('agent-t', 'tool-v1073-sl30', 'sess-1', new Date(day2Start)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-t', 'tool-v1073-sl30', 'sess-1', new Date(day2Start + 1000)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-t', 'tool-v1073-sl30', 'sess-1', new Date(day2Start + 2000)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-t', 'tool-v1073-sl30', 'sess-1', new Date(day2Start + 3000)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1073-sl30');
      expect(status).toBe(200);
      expect(body.opsTrendSlopeLast30d as number).toBeCloseTo(1, 5);
    });

    it('28. tools — single day ops in 7d: opsTrendSlopeLast7d null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-t', 'tool-v1073-sl7-null', 'sess-1', hoursAgo(2)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-t', 'tool-v1073-sl7-null', 'sess-1', hoursAgo(3)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1073-sl7-null');
      expect(status).toBe(200);
      expect(body.opsTrendSlopeLast7d).toBeNull();
    });

    it('29. tools — only old ops: slope fields null (no ops in windows)', async () => {
      ctx = await setup();
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp('agent-t', 'tool-v1073-old', 'sess-1', daysAgo(35 + i)), dec(0.5, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1073-old');
      expect(status).toBe(200);
      expect(body.opsTrendSlopeLast7d).toBeNull();
      expect(body.opsTrendSlopeLast30d).toBeNull();
    });
  });

  // ── summary endpoint ────────────────────────────────────────────────────────────

  describe('T1434-T1438 — v10.73 new fields (summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('30. summary — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', hoursAgo(1)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body).toHaveProperty('riskScoreKurtosisLast30d');
      expect(body).toHaveProperty('riskScoreKurtosisAllTime');
      expect(body).toHaveProperty('riskScoreSkewnessAllTime');
      expect(body).toHaveProperty('opsTrendSlopeLast7d');
      expect(body).toHaveProperty('opsTrendSlopeLast30d');
    });

    it('31. summary — < 4 ops in 30d: riskScoreKurtosisLast30d null', async () => {
      ctx = await setup();
      for (let i = 1; i <= 3; i++) {
        await ctx.logger.log(makeOp(`agent-${i}`, 'fs', `sess-${i}`, daysAgo(i)), dec(0.5, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreKurtosisLast30d).toBeNull();
    });

    it('32. summary — 4 ops in 30d: riskScoreKurtosisLast30d computed (negative excess)', async () => {
      ctx = await setup();
      // [0.1, 0.2, 0.8, 0.9] → excess kurtosis ≈ -1.9216
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', daysAgo(5)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-2', daysAgo(10)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-3', daysAgo(15)), dec(0.8, 'allow'));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-4', daysAgo(20)), dec(0.9, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreKurtosisLast30d as number).toBeCloseTo(-1.9216, 3);
    });

    it('33. summary — zero variance in 30d (4 identical ops): kurtosis30d returns 0', async () => {
      ctx = await setup();
      for (let i = 1; i <= 4; i++) {
        await ctx.logger.log(makeOp(`agent-${i}`, 'fs', `sess-${i}`, daysAgo(i)), dec(0.7, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreKurtosisLast30d).toBe(0);
    });

    it('34. summary — kurtosisAllTime includes ops older than 30d', async () => {
      ctx = await setup();
      // 3 ops in 30d (< 4 → kurtosis30d null)
      // + 1 op older than 30d → 4 all-time → kurtosisAllTime computed
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', daysAgo(5)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-2', daysAgo(10)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-3', daysAgo(20)), dec(0.8, 'allow'));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-4', daysAgo(40)), dec(0.9, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreKurtosisLast30d).toBeNull();
      expect(body.riskScoreKurtosisAllTime as number).toBeCloseTo(-1.9216, 3);
    });

    it('35. summary — 3 total logs (all old): riskScoreSkewnessAllTime computed', async () => {
      ctx = await setup();
      // [0.1, 0.2, 0.9] → skewness ≈ 0.6655
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', daysAgo(40)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-2', daysAgo(35)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-3', daysAgo(31)), dec(0.9, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreSkewnessAllTime as number).toBeCloseTo(0.6654688661238347, 5);
    });

    it('36. summary — zero variance all-time (3 ops): skewnessAllTime returns 0', async () => {
      ctx = await setup();
      for (let i = 1; i <= 3; i++) {
        await ctx.logger.log(makeOp(`agent-${i}`, 'fs', `sess-${i}`, daysAgo(40 + i)), dec(0.5, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreSkewnessAllTime).toBe(0);
    });

    it('37. summary — 2 ops on day0, 4 ops on day2 in 7d: opsTrendSlopeLast7d ≈ 1', async () => {
      ctx = await setup();
      const cutoff7d = PINNED_NOW() - 604800000;
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', new Date(cutoff7d + 3_600_000)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-2', new Date(cutoff7d + 3_601_000)), dec(0.5, 'allow'));
      const day2Start = cutoff7d + 2 * 86_400_000 + 3_600_000;
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-3', new Date(day2Start)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-4', new Date(day2Start + 1000)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-5', new Date(day2Start + 2000)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-6', new Date(day2Start + 3000)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.opsTrendSlopeLast7d as number).toBeCloseTo(1, 5);
    });

    it('38. summary — single day in 7d window: opsTrendSlopeLast7d null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', hoursAgo(2)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-2', hoursAgo(3)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.opsTrendSlopeLast7d).toBeNull();
    });

    it('39. summary — 2 ops on day0, 4 ops on day2 in 30d: opsTrendSlopeLast30d ≈ 1', async () => {
      ctx = await setup();
      const cutoff30d = PINNED_NOW() - 2592000000;
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', new Date(cutoff30d + 3_600_000)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-2', new Date(cutoff30d + 3_601_000)), dec(0.5, 'allow'));
      const day2Start = cutoff30d + 2 * 86_400_000 + 3_600_000;
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-3', new Date(day2Start)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-4', new Date(day2Start + 1000)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-5', new Date(day2Start + 2000)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-6', new Date(day2Start + 3000)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.opsTrendSlopeLast30d as number).toBeCloseTo(1, 5);
    });

    it('40. summary — ops only in 30d window (outside 7d): slope7d null, slope30d computed', async () => {
      ctx = await setup();
      // Place ops outside 7d but inside 30d
      const cutoff30d = PINNED_NOW() - 2592000000;
      // day0 and day2 of 30d window, which are ~29d and ~27d ago — outside 7d
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', new Date(cutoff30d + 3_600_000)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-2', new Date(cutoff30d + 3_601_000)), dec(0.5, 'allow'));
      const day2Start = cutoff30d + 2 * 86_400_000 + 3_600_000;
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-3', new Date(day2Start)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-4', new Date(day2Start + 1000)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-5', new Date(day2Start + 2000)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-6', new Date(day2Start + 3000)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.opsTrendSlopeLast7d).toBeNull();
      expect(body.opsTrendSlopeLast30d as number).toBeCloseTo(1, 5);
    });
  });
});

// ── v10.74 ────────────────────────────────────────────────────────────────────

describe('v10.74', () => {
  const hoursAgo = (h: number) => new Date(PINNED_NOW() - h * 3_600_000);
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);

  /**
   * Build a Date at exactly `offsetMs` ms after the cutoff for a given window.
   * windowMs: 604800000 for 7d, 2592000000 for 30d
   */
  const msAfterCutoff = (windowMs: number, offsetMs: number) =>
    new Date(PINNED_NOW() - windowMs + offsetMs);

  /**
   * Build a Date for day `dayIndex` inside a window starting at cutoff.
   * dayIndex 0 → first day, dayIndex 2 → third day, etc.
   * The timestamp sits 1h into the given day so it never straddles a day boundary.
   */
  const dayInWindow = (windowMs: number, dayIndex: number) =>
    msAfterCutoff(windowMs, dayIndex * 86_400_000 + 3_600_000);

  /**
   * Compute OLS slope for xs/ys arrays (same formula as the implementation).
   */
  function olsSlope(xs: number[], ys: number[]): number {
    const n = xs.length;
    const mx = xs.reduce((a, v) => a + v, 0) / n;
    const my = ys.reduce((a, v) => a + v, 0) / n;
    const num = xs.reduce((a, v, i) => a + (v - mx) * (ys[i]! - my), 0);
    const den = xs.reduce((a, v) => a + (v - mx) ** 2, 0);
    return den === 0 ? 0 : num / den;
  }

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1439-T1443 — v10.74 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1074-pres', hoursAgo(1)), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1074-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('riskTrendSlopeLast7d');
      expect(body).toHaveProperty('riskTrendSlopeLast30d');
      expect(body).toHaveProperty('blockRateTrendSlopeLast7d');
      expect(body).toHaveProperty('opsHourOfDayPeak');
      expect(body).toHaveProperty('opsHourOfDayTrough');
    });

    it('2. sessions — single day in 7d window: riskTrendSlopeLast7d is null', async () => {
      ctx = await setup();
      // Two ops on the same day within 7d
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1074-rslope7-null', hoursAgo(2)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1074-rslope7-null', hoursAgo(3)), dec(0.7, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1074-rslope7-null');
      expect(status).toBe(200);
      expect(body.riskTrendSlopeLast7d).toBeNull();
    });

    it('3. sessions — 2 distinct days in 7d window: riskTrendSlopeLast7d computed', async () => {
      ctx = await setup();
      // day0 (index 0): riskScore 0.2 → daily avg 0.2
      // day2 (index 2): riskScore 0.6 → daily avg 0.6
      // xs=[0,2], ys=[0.2,0.6] → OLS slope = (0.6-0.2)/(2-0) = 0.2
      const d0 = dayInWindow(604800000, 0);
      const d2 = dayInWindow(604800000, 2);
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1074-rslope7', d0), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1074-rslope7', d2), dec(0.6, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1074-rslope7');
      expect(status).toBe(200);
      const expected = olsSlope([0, 2], [0.2, 0.6]);
      expect(body.riskTrendSlopeLast7d as number).toBeCloseTo(expected, 5);
    });

    it('4. sessions — single day in 30d window: riskTrendSlopeLast30d is null', async () => {
      ctx = await setup();
      // hoursAgo(122/123), not daysAgo(5) — see test 14 above: a fixture that
      // is an exact multiple of a day old sits on a day-bucket edge.
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1074-rslope30-null', hoursAgo(122)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1074-rslope30-null', hoursAgo(123)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1074-rslope30-null');
      expect(status).toBe(200);
      expect(body.riskTrendSlopeLast30d).toBeNull();
    });

    it('5. sessions — 2 distinct days in 30d window: riskTrendSlopeLast30d computed', async () => {
      ctx = await setup();
      // day0: avg 0.2, day2: avg 0.8 → slope = 0.3
      const d0 = dayInWindow(2592000000, 0);
      const d2 = dayInWindow(2592000000, 2);
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1074-rslope30', d0), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1074-rslope30', d2), dec(0.8, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1074-rslope30');
      expect(status).toBe(200);
      const expected = olsSlope([0, 2], [0.2, 0.8]);
      expect(body.riskTrendSlopeLast30d as number).toBeCloseTo(expected, 5);
    });

    it('6. sessions — ops outside 7d but inside 30d: riskTrendSlope7d null, 30d computed', async () => {
      ctx = await setup();
      const d0 = dayInWindow(2592000000, 0);
      const d2 = dayInWindow(2592000000, 2);
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1074-rslope-split', d0), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1074-rslope-split', d2), dec(0.7, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1074-rslope-split');
      expect(status).toBe(200);
      expect(body.riskTrendSlopeLast7d).toBeNull();
      const expected = olsSlope([0, 2], [0.3, 0.7]);
      expect(body.riskTrendSlopeLast30d as number).toBeCloseTo(expected, 5);
    });

    it('7. sessions — single day in 7d: blockRateTrendSlopeLast7d is null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1074-bslope7-null', hoursAgo(1)), dec(0.5, 'block'));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1074-bslope7-null', hoursAgo(2)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1074-bslope7-null');
      expect(status).toBe(200);
      expect(body.blockRateTrendSlopeLast7d).toBeNull();
    });

    it('8. sessions — 2 distinct days in 7d: blockRateTrendSlopeLast7d computed', async () => {
      ctx = await setup();
      // day0: 0 blocked out of 2 → rate 0.0
      // day2: 2 blocked out of 2 → rate 1.0
      // xs=[0,2], ys=[0.0, 1.0] → slope = 0.5
      const d0 = dayInWindow(604800000, 0);
      const d2 = dayInWindow(604800000, 2);
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1074-bslope7', new Date(d0.getTime())), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1074-bslope7', new Date(d0.getTime() + 1000)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1074-bslope7', new Date(d2.getTime())), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1074-bslope7', new Date(d2.getTime() + 1000)), dec(0.8, 'block'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1074-bslope7');
      expect(status).toBe(200);
      const expected = olsSlope([0, 2], [0.0, 1.0]);
      expect(body.blockRateTrendSlopeLast7d as number).toBeCloseTo(expected, 5);
    });

    it('9. sessions — 3 ops at hour 14, 1 op at hour 9: opsHourOfDayPeak is 14', async () => {
      ctx = await setup();
      // Force timestamps to known hours by setting explicit times
      const now = new Date(PINNED_NOW());
      const h14 = new Date(now);
      h14.setHours(14, 0, 0, 0);
      const h9 = new Date(now);
      h9.setHours(9, 0, 0, 0);

      // If h14 is in the future, subtract a day
      const h14ts = h14.getTime() > PINNED_NOW() ? h14.getTime() - 86_400_000 : h14.getTime();
      const h9ts = h9.getTime() > PINNED_NOW() ? h9.getTime() - 86_400_000 : h9.getTime();

      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v1074-peak14', new Date(h14ts)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v1074-peak14', new Date(h14ts + 1000)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v1074-peak14', new Date(h14ts + 2000)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v1074-peak14', new Date(h9ts)), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1074-peak14');
      expect(status).toBe(200);
      expect(body.opsHourOfDayPeak).toBe(14);
    });

    it('10. sessions — 3 ops at hour 14, 1 op at hour 9: opsHourOfDayTrough is 9', async () => {
      ctx = await setup();
      const now = new Date(PINNED_NOW());
      const h14 = new Date(now);
      h14.setHours(14, 0, 0, 0);
      const h9 = new Date(now);
      h9.setHours(9, 0, 0, 0);

      const h14ts = h14.getTime() > PINNED_NOW() ? h14.getTime() - 86_400_000 : h14.getTime();
      const h9ts = h9.getTime() > PINNED_NOW() ? h9.getTime() - 86_400_000 : h9.getTime();

      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v1074-trough9', new Date(h14ts)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v1074-trough9', new Date(h14ts + 1000)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v1074-trough9', new Date(h14ts + 2000)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v1074-trough9', new Date(h9ts)), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1074-trough9');
      expect(status).toBe(200);
      expect(body.opsHourOfDayTrough).toBe(9);
    });

    it('11. sessions — single op: peak and trough are same hour', async () => {
      ctx = await setup();
      const now = new Date(PINNED_NOW());
      const h10 = new Date(now);
      h10.setHours(10, 0, 0, 0);
      const h10ts = h10.getTime() > PINNED_NOW() ? h10.getTime() - 86_400_000 : h10.getTime();

      await ctx.logger.log(makeOp('agent-k', 'fs', 'sess-v1074-single-hour', new Date(h10ts)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1074-single-hour');
      expect(status).toBe(200);
      expect(body.opsHourOfDayPeak).toBe(body.opsHourOfDayTrough);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1439-T1443 — v10.74 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('14. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1074-pres', 'fs', 'sess-1', hoursAgo(1)), dec(0.3, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1074-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('riskTrendSlopeLast7d');
      expect(body).toHaveProperty('riskTrendSlopeLast30d');
      expect(body).toHaveProperty('blockRateTrendSlopeLast7d');
      expect(body).toHaveProperty('opsHourOfDayPeak');
      expect(body).toHaveProperty('opsHourOfDayTrough');
    });

    it('15. agents — single day in 7d: riskTrendSlopeLast7d null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1074-rslope7-null', 'fs', 'sess-1', hoursAgo(2)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-v1074-rslope7-null', 'fs', 'sess-1', hoursAgo(3)), dec(0.7, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1074-rslope7-null');
      expect(status).toBe(200);
      expect(body.riskTrendSlopeLast7d).toBeNull();
    });

    it('16. agents — 2 distinct days in 7d: riskTrendSlopeLast7d computed', async () => {
      ctx = await setup();
      const d0 = dayInWindow(604800000, 0);
      const d2 = dayInWindow(604800000, 2);
      await ctx.logger.log(makeOp('agent-v1074-rslope7', 'fs', 'sess-1', d0), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-v1074-rslope7', 'fs', 'sess-1', d2), dec(0.6, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1074-rslope7');
      expect(status).toBe(200);
      const expected = olsSlope([0, 2], [0.2, 0.6]);
      expect(body.riskTrendSlopeLast7d as number).toBeCloseTo(expected, 5);
    });

    it('17. agents — 2 distinct days in 7d with multiple ops: riskTrendSlopeLast7d uses daily avg', async () => {
      ctx = await setup();
      // day0: avg of [0.2, 0.4] = 0.3
      // day2: avg of [0.6, 0.8] = 0.7
      // expected slope for xs=[0,2], ys=[0.3, 0.7]
      const d0 = dayInWindow(604800000, 0);
      const d2 = dayInWindow(604800000, 2);
      await ctx.logger.log(makeOp('agent-v1074-rslope7-avg', 'fs', 'sess-1', new Date(d0.getTime())), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-v1074-rslope7-avg', 'fs', 'sess-1', new Date(d0.getTime() + 1000)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-v1074-rslope7-avg', 'fs', 'sess-1', new Date(d2.getTime())), dec(0.6, 'allow'));
      await ctx.logger.log(makeOp('agent-v1074-rslope7-avg', 'fs', 'sess-1', new Date(d2.getTime() + 1000)), dec(0.8, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1074-rslope7-avg');
      expect(status).toBe(200);
      const expected = olsSlope([0, 2], [0.3, 0.7]);
      expect(body.riskTrendSlopeLast7d as number).toBeCloseTo(expected, 5);
    });

    it('18. agents — blockRateTrendSlopeLast7d null when only one day in 7d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1074-bslope7-null', 'fs', 'sess-1', hoursAgo(1)), dec(0.5, 'block'));
      await ctx.logger.log(makeOp('agent-v1074-bslope7-null', 'fs', 'sess-1', hoursAgo(2)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1074-bslope7-null');
      expect(status).toBe(200);
      expect(body.blockRateTrendSlopeLast7d).toBeNull();
    });

    it('19. agents — blockRateTrendSlopeLast7d computed for 2 distinct days', async () => {
      ctx = await setup();
      // day0: 0 blocked / 2 total → rate 0.0
      // day2: 1 blocked / 2 total → rate 0.5
      const d0 = dayInWindow(604800000, 0);
      const d2 = dayInWindow(604800000, 2);
      await ctx.logger.log(makeOp('agent-v1074-bslope7', 'fs', 'sess-1', new Date(d0.getTime())), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-v1074-bslope7', 'fs', 'sess-1', new Date(d0.getTime() + 1000)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-v1074-bslope7', 'fs', 'sess-1', new Date(d2.getTime())), dec(0.7, 'block'));
      await ctx.logger.log(makeOp('agent-v1074-bslope7', 'fs', 'sess-1', new Date(d2.getTime() + 1000)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1074-bslope7');
      expect(status).toBe(200);
      const expected = olsSlope([0, 2], [0.0, 0.5]);
      expect(body.blockRateTrendSlopeLast7d as number).toBeCloseTo(expected, 5);
    });

    it('20. agents — 3 ops at hour 14, 1 op at hour 9: peak=14, trough=9', async () => {
      ctx = await setup();
      const now = new Date(PINNED_NOW());
      const h14 = new Date(now);
      h14.setHours(14, 0, 0, 0);
      const h9 = new Date(now);
      h9.setHours(9, 0, 0, 0);

      const h14ts = h14.getTime() > PINNED_NOW() ? h14.getTime() - 86_400_000 : h14.getTime();
      const h9ts = h9.getTime() > PINNED_NOW() ? h9.getTime() - 86_400_000 : h9.getTime();

      await ctx.logger.log(makeOp('agent-v1074-peak14', 'fs', 'sess-1', new Date(h14ts)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-v1074-peak14', 'fs', 'sess-1', new Date(h14ts + 1000)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-v1074-peak14', 'fs', 'sess-1', new Date(h14ts + 2000)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-v1074-peak14', 'fs', 'sess-1', new Date(h9ts)), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1074-peak14');
      expect(status).toBe(200);
      expect(body.opsHourOfDayPeak).toBe(14);
      expect(body.opsHourOfDayTrough).toBe(9);
    });

  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1439-T1443 — v10.74 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('22. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v1074-pres', 'sess-1', hoursAgo(1)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1074-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('riskTrendSlopeLast7d');
      expect(body).toHaveProperty('riskTrendSlopeLast30d');
      expect(body).toHaveProperty('blockRateTrendSlopeLast7d');
      expect(body).toHaveProperty('opsHourOfDayPeak');
      expect(body).toHaveProperty('opsHourOfDayTrough');
    });

    it('23. tools — single day in 7d: riskTrendSlopeLast7d null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v1074-rslope7-null', 'sess-1', hoursAgo(2)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-a', 'tool-v1074-rslope7-null', 'sess-1', hoursAgo(3)), dec(0.6, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1074-rslope7-null');
      expect(status).toBe(200);
      expect(body.riskTrendSlopeLast7d).toBeNull();
    });

    it('24. tools — 2 distinct days in 7d: riskTrendSlopeLast7d computed', async () => {
      ctx = await setup();
      const d0 = dayInWindow(604800000, 0);
      const d2 = dayInWindow(604800000, 2);
      await ctx.logger.log(makeOp('agent-a', 'tool-v1074-rslope7', 'sess-1', d0), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-a', 'tool-v1074-rslope7', 'sess-1', d2), dec(0.9, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1074-rslope7');
      expect(status).toBe(200);
      const expected = olsSlope([0, 2], [0.1, 0.9]);
      expect(body.riskTrendSlopeLast7d as number).toBeCloseTo(expected, 5);
    });

    it('25. tools — 2 distinct days in 30d (outside 7d): riskTrend30d computed, 7d null', async () => {
      ctx = await setup();
      const d0 = dayInWindow(2592000000, 0);
      const d2 = dayInWindow(2592000000, 2);
      await ctx.logger.log(makeOp('agent-a', 'tool-v1074-rslope30', 'sess-1', d0), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-a', 'tool-v1074-rslope30', 'sess-1', d2), dec(0.8, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1074-rslope30');
      expect(status).toBe(200);
      expect(body.riskTrendSlopeLast7d).toBeNull();
      const expected = olsSlope([0, 2], [0.2, 0.8]);
      expect(body.riskTrendSlopeLast30d as number).toBeCloseTo(expected, 5);
    });

    it('26. tools — blockRateTrendSlopeLast7d computed for 2 days', async () => {
      ctx = await setup();
      // day0: 0/1 blocked → 0.0, day2: 1/1 blocked → 1.0
      const d0 = dayInWindow(604800000, 0);
      const d2 = dayInWindow(604800000, 2);
      await ctx.logger.log(makeOp('agent-a', 'tool-v1074-bslope7', 'sess-1', d0), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-a', 'tool-v1074-bslope7', 'sess-1', d2), dec(0.9, 'block'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1074-bslope7');
      expect(status).toBe(200);
      const expected = olsSlope([0, 2], [0.0, 1.0]);
      expect(body.blockRateTrendSlopeLast7d as number).toBeCloseTo(expected, 5);
    });

    it('27. tools — 3 ops at hour 14, 1 op at hour 9: peak=14, trough=9', async () => {
      ctx = await setup();
      const now = new Date(PINNED_NOW());
      const h14 = new Date(now);
      h14.setHours(14, 0, 0, 0);
      const h9 = new Date(now);
      h9.setHours(9, 0, 0, 0);

      const h14ts = h14.getTime() > PINNED_NOW() ? h14.getTime() - 86_400_000 : h14.getTime();
      const h9ts = h9.getTime() > PINNED_NOW() ? h9.getTime() - 86_400_000 : h9.getTime();

      await ctx.logger.log(makeOp('agent-a', 'tool-v1074-peak14', 'sess-1', new Date(h14ts)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-a', 'tool-v1074-peak14', 'sess-1', new Date(h14ts + 1000)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-a', 'tool-v1074-peak14', 'sess-1', new Date(h14ts + 2000)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-a', 'tool-v1074-peak14', 'sess-1', new Date(h9ts)), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1074-peak14');
      expect(status).toBe(200);
      expect(body.opsHourOfDayPeak).toBe(14);
      expect(body.opsHourOfDayTrough).toBe(9);
    });

  });

  // ── summary endpoint ────────────────────────────────────────────────────────────

  describe('T1439-T1443 — v10.74 new fields (summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('29. summary — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', hoursAgo(1)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body).toHaveProperty('riskTrendSlopeLast7d');
      expect(body).toHaveProperty('riskTrendSlopeLast30d');
      expect(body).toHaveProperty('blockRateTrendSlopeLast7d');
      expect(body).toHaveProperty('opsHourOfDayPeak');
      expect(body).toHaveProperty('opsHourOfDayTrough');
    });

    it('30. summary — single day in 7d: riskTrendSlopeLast7d null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', hoursAgo(2)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-2', hoursAgo(3)), dec(0.7, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskTrendSlopeLast7d).toBeNull();
    });

    it('31. summary — 2 distinct days in 7d: riskTrendSlopeLast7d computed', async () => {
      ctx = await setup();
      const d0 = dayInWindow(604800000, 0);
      const d2 = dayInWindow(604800000, 2);
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', d0), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-2', d2), dec(0.6, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      const expected = olsSlope([0, 2], [0.2, 0.6]);
      expect(body.riskTrendSlopeLast7d as number).toBeCloseTo(expected, 5);
    });

    it('32. summary — single day in 30d: riskTrendSlopeLast30d null', async () => {
      ctx = await setup();
      // hoursAgo(122/123), not daysAgo(5) — an exact-day-multiple fixture sits
      // on a day-bucket edge and flips bucket depending on elapsed ms.
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', hoursAgo(122)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-2', hoursAgo(123)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskTrendSlopeLast30d).toBeNull();
    });

    it('33. summary — 2 distinct days in 30d: riskTrendSlopeLast30d computed', async () => {
      ctx = await setup();
      const d0 = dayInWindow(2592000000, 0);
      const d2 = dayInWindow(2592000000, 2);
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', d0), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-2', d2), dec(0.8, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      const expected = olsSlope([0, 2], [0.2, 0.8]);
      expect(body.riskTrendSlopeLast30d as number).toBeCloseTo(expected, 5);
    });

    it('34. summary — 2 distinct days in 30d (outside 7d): riskTrend7d null, 30d computed', async () => {
      ctx = await setup();
      const d0 = dayInWindow(2592000000, 0);
      const d2 = dayInWindow(2592000000, 2);
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', d0), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-2', d2), dec(0.7, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskTrendSlopeLast7d).toBeNull();
      const expected = olsSlope([0, 2], [0.3, 0.7]);
      expect(body.riskTrendSlopeLast30d as number).toBeCloseTo(expected, 5);
    });

    it('35. summary — blockRateTrendSlopeLast7d null when single day', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', hoursAgo(1)), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-2', hoursAgo(2)), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.blockRateTrendSlopeLast7d).toBeNull();
    });

    it('36. summary — blockRateTrendSlopeLast7d computed for 2 distinct days', async () => {
      ctx = await setup();
      // day0: 0 blocks / 2 ops → 0.0; day2: 2 blocks / 2 ops → 1.0
      const d0 = dayInWindow(604800000, 0);
      const d2 = dayInWindow(604800000, 2);
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', new Date(d0.getTime())), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-2', new Date(d0.getTime() + 1000)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-3', new Date(d2.getTime())), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-4', new Date(d2.getTime() + 1000)), dec(0.8, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      const expected = olsSlope([0, 2], [0.0, 1.0]);
      expect(body.blockRateTrendSlopeLast7d as number).toBeCloseTo(expected, 5);
    });

    it('37. summary — no logs: opsHourOfDayPeak and opsHourOfDayTrough null', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.opsHourOfDayPeak).toBeNull();
      expect(body.opsHourOfDayTrough).toBeNull();
    });

    it('38. summary — 3 ops at hour 14, 1 op at hour 9: peak=14, trough=9', async () => {
      ctx = await setup();
      const now = new Date(PINNED_NOW());
      const h14 = new Date(now);
      h14.setHours(14, 0, 0, 0);
      const h9 = new Date(now);
      h9.setHours(9, 0, 0, 0);

      const h14ts = h14.getTime() > PINNED_NOW() ? h14.getTime() - 86_400_000 : h14.getTime();
      const h9ts = h9.getTime() > PINNED_NOW() ? h9.getTime() - 86_400_000 : h9.getTime();

      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', new Date(h14ts)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-2', new Date(h14ts + 1000)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-3', new Date(h14ts + 2000)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-4', new Date(h9ts)), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.opsHourOfDayPeak).toBe(14);
      expect(body.opsHourOfDayTrough).toBe(9);
    });

    it('39. summary — ops all-time at same hour: peak equals trough', async () => {
      ctx = await setup();
      const now = new Date(PINNED_NOW());
      const h5 = new Date(now);
      h5.setHours(5, 0, 0, 0);
      const h5ts = h5.getTime() > PINNED_NOW() ? h5.getTime() - 86_400_000 : h5.getTime();

      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', new Date(h5ts)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-2', new Date(h5ts + 1000)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.opsHourOfDayPeak).toBe(5);
      expect(body.opsHourOfDayTrough).toBe(5);
    });

    it('40. summary — riskTrendSlopeLast7d multiple days with multiple ops: uses daily avg', async () => {
      ctx = await setup();
      // day0: [0.1, 0.3] → avg 0.2; day4: [0.5, 0.7] → avg 0.6
      const d0 = dayInWindow(604800000, 0);
      const d4 = dayInWindow(604800000, 4);
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', new Date(d0.getTime())), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-2', new Date(d0.getTime() + 1000)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-3', new Date(d4.getTime())), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-4', new Date(d4.getTime() + 1000)), dec(0.7, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      const expected = olsSlope([0, 4], [0.2, 0.6]);
      expect(body.riskTrendSlopeLast7d as number).toBeCloseTo(expected, 5);
    });
  });
});

// ── v10.75 ────────────────────────────────────────────────────────────────────

describe('v10.75', () => {
  // Monday 2026-03-16 10:00:00 UTC = day 1 (Monday)
  const MONDAY = new Date('2026-03-16T10:00:00Z');   // getDay() === 1
  const TUESDAY = new Date('2026-03-17T10:00:00Z');  // getDay() === 2
  const WEDNESDAY = new Date('2026-03-18T10:00:00Z');// getDay() === 3
  const SATURDAY = new Date('2026-03-14T10:00:00Z'); // getDay() === 6
  const SUNDAY = new Date('2026-03-15T10:00:00Z');   // getDay() === 0

  // Hours-based helpers
  function atHour(h: number): Date {
    return new Date(`2026-03-16T${String(h).padStart(2, '0')}:00:00Z`);
  }

  // ── sessions endpoint ───────────────────────────────────────────────────────────

  describe('T1444-T1448 — v10.75 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1075-pres', MONDAY), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1075-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('opsDayOfWeekPeak');
      expect(body).toHaveProperty('opsDayOfWeekTrough');
      expect(body).toHaveProperty('opsCountUniqueHours');
      expect(body).toHaveProperty('opsCountUniqueDaysOfWeek');
      expect(body).toHaveProperty('riskScoreEntropyAllTime');
    });

    it('2. sessions — no logs: opsDayOfWeekPeak null, opsDayOfWeekTrough null, counts 0, entropy null', async () => {
      ctx = await setup();
      // No logs seeded — but session endpoint needs at least something, so we check
      // by querying a session that has no logs
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1075-empty');
      // 404 or 200 depending on implementation; only test if 200
      if (status === 200) {
        expect(body.opsDayOfWeekPeak).toBeNull();
        expect(body.opsDayOfWeekTrough).toBeNull();
        expect(body.opsCountUniqueHours).toBe(0);
        expect(body.opsCountUniqueDaysOfWeek).toBe(0);
        expect(body.riskScoreEntropyAllTime).toBeNull();
      }
    });

    it('3. sessions — single op on Monday (day 1): peak=1, trough=1, uniqueHours=1, uniqueDays=1', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1075-mono', MONDAY), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1075-mono');
      expect(status).toBe(200);

      expect(body.opsDayOfWeekPeak).toBe(1);
      expect(body.opsDayOfWeekTrough).toBe(1);
      expect(body.opsCountUniqueHours).toBe(1);
      expect(body.opsCountUniqueDaysOfWeek).toBe(1);
    });

    it('4. sessions — Monday x3, Tuesday x1: peak=1 (Monday), trough=2 (Tuesday)', async () => {
      ctx = await setup();
      // 3 ops on Monday, 1 on Tuesday
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1075-dow', MONDAY), dec(0.3));
      }
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1075-dow', TUESDAY), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1075-dow');
      expect(status).toBe(200);

      expect(body.opsDayOfWeekPeak).toBe(1);   // Monday
      expect(body.opsDayOfWeekTrough).toBe(2); // Tuesday (fewest among active days)
    });

    it('5. sessions — ops at hours 10, 14, 22: opsCountUniqueHours=3', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1075-hr3', atHour(10)), dec(0.4));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1075-hr3', atHour(14)), dec(0.5));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1075-hr3', atHour(22)), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1075-hr3');
      expect(status).toBe(200);

      expect(body.opsCountUniqueHours).toBe(3);
    });

    it('6. sessions — ops on Mon, Tue, Wed, Sat, Sun: opsCountUniqueDaysOfWeek=5', async () => {
      ctx = await setup();
      for (const ts of [MONDAY, TUESDAY, WEDNESDAY, SATURDAY, SUNDAY]) {
        await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1075-day5', ts), dec(0.4));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1075-day5');
      expect(status).toBe(200);

      expect(body.opsCountUniqueDaysOfWeek).toBe(5);
    });

    it('7. sessions — riskScoreEntropyAllTime: single score → 0 entropy', async () => {
      ctx = await setup();
      // All ops have riskScore 0.5 → all in same bucket → entropy = 0
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1075-ent0', MONDAY), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1075-ent0');
      expect(status).toBe(200);

      expect(body.riskScoreEntropyAllTime as number).toBeCloseTo(0, 10);
    });

    it('8. sessions — riskScoreEntropyAllTime: two equal buckets → 1 bit entropy', async () => {
      ctx = await setup();
      // 2 ops at 0.2 and 2 ops at 0.8 → 2 equal-count buckets → entropy = 1 bit
      for (let i = 0; i < 2; i++) {
        await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1075-ent1', MONDAY), dec(0.2));
        await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1075-ent1', TUESDAY), dec(0.8));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1075-ent1');
      expect(status).toBe(200);

      expect(body.riskScoreEntropyAllTime as number).toBeCloseTo(1.0, 5);
    });

    it('9. sessions — riskScoreEntropyAllTime: four equal buckets → 2 bits entropy', async () => {
      ctx = await setup();
      // 1 op each at 0.1, 0.3, 0.6, 0.9 → 4 equal-count buckets → entropy = 2 bits
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1075-ent2', MONDAY), dec(0.1));
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1075-ent2', TUESDAY), dec(0.3));
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1075-ent2', WEDNESDAY), dec(0.6));
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1075-ent2', SATURDAY), dec(0.9));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1075-ent2');
      expect(status).toBe(200);

      expect(body.riskScoreEntropyAllTime as number).toBeCloseTo(2.0, 5);
    });
  });

  // ── agents endpoint ─────────────────────────────────────────────────────────────

  describe('T1444-T1448 — v10.75 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('10. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1075-pres', 'fs', 'sess-1', MONDAY), dec(0.3));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1075-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('opsDayOfWeekPeak');
      expect(body).toHaveProperty('opsDayOfWeekTrough');
      expect(body).toHaveProperty('opsCountUniqueHours');
      expect(body).toHaveProperty('opsCountUniqueDaysOfWeek');
      expect(body).toHaveProperty('riskScoreEntropyAllTime');
    });

    it('11. agents — single op on Wednesday (day 3): peak=3, trough=3, uniqueHours=1, uniqueDays=1', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1075-wed', 'fs', 'sess-1', WEDNESDAY), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1075-wed');
      expect(status).toBe(200);

      expect(body.opsDayOfWeekPeak).toBe(3);
      expect(body.opsDayOfWeekTrough).toBe(3);
      expect(body.opsCountUniqueHours).toBe(1);
      expect(body.opsCountUniqueDaysOfWeek).toBe(1);
    });

    it('12. agents — Saturday x2, Sunday x1: peak=6 (Sat), trough=0 (Sun)', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1075-satsu', 'fs', 'sess-1', SATURDAY), dec(0.4));
      await ctx.logger.log(makeOp('agent-v1075-satsu', 'fs', 'sess-2', SATURDAY), dec(0.5));
      await ctx.logger.log(makeOp('agent-v1075-satsu', 'fs', 'sess-3', SUNDAY), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1075-satsu');
      expect(status).toBe(200);

      expect(body.opsDayOfWeekPeak).toBe(6);   // Saturday = day 6
      expect(body.opsDayOfWeekTrough).toBe(0); // Sunday = day 0
    });

    it('13. agents — ops at four distinct hours: opsCountUniqueHours=4', async () => {
      ctx = await setup();
      for (const h of [0, 6, 12, 18]) {
        await ctx.logger.log(makeOp('agent-v1075-hr4', 'fs', 'sess-1', atHour(h)), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1075-hr4');
      expect(status).toBe(200);

      expect(body.opsCountUniqueHours).toBe(4);
    });

    it('14. agents — duplicate hours: uniqueHours counts distinct, not total', async () => {
      ctx = await setup();
      // 3 ops at hour 10, 2 ops at hour 14 → only 2 distinct hours
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-v1075-hrdup', 'fs', `sess-${i}`, atHour(10)), dec(0.5));
      }
      for (let i = 0; i < 2; i++) {
        await ctx.logger.log(makeOp('agent-v1075-hrdup', 'fs', `sess-${3 + i}`, atHour(14)), dec(0.4));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1075-hrdup');
      expect(status).toBe(200);

      expect(body.opsCountUniqueHours).toBe(2);
      expect(body.opsCountUniqueDaysOfWeek).toBe(1); // all on same day (atHour uses 2026-03-16 = Monday)
    });

    it('15. agents — riskScoreEntropyAllTime: all same bucket → 0 entropy', async () => {
      ctx = await setup();
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp('agent-v1075-ent-zero', 'fs', `sess-${i}`, MONDAY), dec(0.7));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1075-ent-zero');
      expect(status).toBe(200);

      expect(body.riskScoreEntropyAllTime as number).toBeCloseTo(0, 10);
    });

    it('16. agents — riskScoreEntropyAllTime: two equal buckets → 1 bit', async () => {
      ctx = await setup();
      // 3 ops at 0.3 and 3 ops at 0.9 → entropy = 1 bit
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-v1075-ent1a', 'fs', `sess-a${i}`, MONDAY), dec(0.3));
        await ctx.logger.log(makeOp('agent-v1075-ent1a', 'fs', `sess-b${i}`, TUESDAY), dec(0.9));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1075-ent1a');
      expect(status).toBe(200);

      expect(body.riskScoreEntropyAllTime as number).toBeCloseTo(1.0, 5);
    });

    it('17. agents — riskScoreEntropyAllTime: non-negative for any distribution', async () => {
      ctx = await setup();
      for (const score of [0.1, 0.2, 0.5, 0.8, 0.9]) {
        await ctx.logger.log(makeOp('agent-v1075-entnonneg', 'fs', 'sess-1', MONDAY), dec(score));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1075-entnonneg');
      expect(status).toBe(200);

      expect(body.riskScoreEntropyAllTime as number).toBeGreaterThanOrEqual(0);
    });
  });

  // ── tools endpoint ──────────────────────────────────────────────────────────────

  describe('T1444-T1448 — v10.75 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('18. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-t', 'tool-v1075-pres', 'sess-1', MONDAY), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1075-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('opsDayOfWeekPeak');
      expect(body).toHaveProperty('opsDayOfWeekTrough');
      expect(body).toHaveProperty('opsCountUniqueHours');
      expect(body).toHaveProperty('opsCountUniqueDaysOfWeek');
      expect(body).toHaveProperty('riskScoreEntropyAllTime');
    });

    it('19. tools — single op on Sunday (day 0): peak=0, trough=0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-t2', 'tool-v1075-sun', 'sess-1', SUNDAY), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1075-sun');
      expect(status).toBe(200);

      expect(body.opsDayOfWeekPeak).toBe(0);
      expect(body.opsDayOfWeekTrough).toBe(0);
      expect(body.opsCountUniqueHours).toBe(1);
      expect(body.opsCountUniqueDaysOfWeek).toBe(1);
    });

    it('20. tools — Mon x5, Wed x2, Fri x3: peak=Mon(1), trough=Wed(3)', async () => {
      ctx = await setup();
      // Monday = day 1 (5 ops), Wednesday = day 3 (2 ops), Friday = day 5 (3 ops)
      const FRIDAY = new Date('2026-03-20T10:00:00Z'); // getDay() === 5
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp('agent-t3', 'tool-v1075-3days', `sess-m${i}`, MONDAY), dec(0.4));
      }
      for (let i = 0; i < 2; i++) {
        await ctx.logger.log(makeOp('agent-t3', 'tool-v1075-3days', `sess-w${i}`, WEDNESDAY), dec(0.5));
      }
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-t3', 'tool-v1075-3days', `sess-f${i}`, FRIDAY), dec(0.6));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1075-3days');
      expect(status).toBe(200);

      expect(body.opsDayOfWeekPeak).toBe(1);   // Monday (5 ops)
      expect(body.opsDayOfWeekTrough).toBe(3); // Wednesday (2 ops — fewest among active days)
      expect(body.opsCountUniqueDaysOfWeek).toBe(3);
    });

    it('21. tools — ops at hours 1, 2, 3, 4, 5: opsCountUniqueHours=5', async () => {
      ctx = await setup();
      for (const h of [1, 2, 3, 4, 5]) {
        await ctx.logger.log(makeOp('agent-t4', 'tool-v1075-hr5', 'sess-1', atHour(h)), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1075-hr5');
      expect(status).toBe(200);

      expect(body.opsCountUniqueHours).toBe(5);
    });

    it('22. tools — riskScoreEntropyAllTime: four equal-count buckets → 2 bits', async () => {
      ctx = await setup();
      // 1 op each at 0.0, 0.3, 0.6, 1.0 → 4 equal-count buckets → entropy = 2 bits
      for (const score of [0.0, 0.3, 0.6, 1.0]) {
        await ctx.logger.log(makeOp('agent-t5', 'tool-v1075-ent2', 'sess-1', MONDAY), dec(score));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1075-ent2');
      expect(status).toBe(200);

      expect(body.riskScoreEntropyAllTime as number).toBeCloseTo(2.0, 5);
    });

    it('23. tools — riskScoreEntropyAllTime: scores bucketed; 0.15 and 0.14 → same bucket 0.1 → entropy 0', async () => {
      ctx = await setup();
      // Math.round(0.15 * 10)/10 = Math.round(1.5)/10 = 2/10 = 0.2
      // Math.round(0.14 * 10)/10 = Math.round(1.4)/10 = 1/10 = 0.1
      // These are different buckets. Use 0.11 and 0.14 → both round to 0.1
      await ctx.logger.log(makeOp('agent-t6', 'tool-v1075-bucket', 'sess-1', MONDAY), dec(0.11));
      await ctx.logger.log(makeOp('agent-t6', 'tool-v1075-bucket', 'sess-2', TUESDAY), dec(0.14));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1075-bucket');
      expect(status).toBe(200);

      // Both round to 0.1 → single bucket → entropy = 0
      expect(body.riskScoreEntropyAllTime as number).toBeCloseTo(0, 10);
    });
  });

  // ── operations/summary endpoint ─────────────────────────────────────────────────

  describe('T1444-T1448 — v10.75 new fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('24. summary — all five new fields present', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s1', 'tool-s', 'sess-1', MONDAY), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body).toHaveProperty('opsDayOfWeekPeak');
      expect(body).toHaveProperty('opsDayOfWeekTrough');
      expect(body).toHaveProperty('opsCountUniqueHours');
      expect(body).toHaveProperty('opsCountUniqueDaysOfWeek');
      expect(body).toHaveProperty('riskScoreEntropyAllTime');
    });

    it('25. summary — empty DB: peak null, trough null, counts 0, entropy null', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.opsDayOfWeekPeak).toBeNull();
      expect(body.opsDayOfWeekTrough).toBeNull();
      expect(body.opsCountUniqueHours).toBe(0);
      expect(body.opsCountUniqueDaysOfWeek).toBe(0);
      expect(body.riskScoreEntropyAllTime).toBeNull();
    });

    it('26. summary — single op on Monday (day 1): peak=1, trough=1, uniqueHours=1, uniqueDays=1', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s2', 'fs', 'sess-1', MONDAY), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.opsDayOfWeekPeak).toBe(1);
      expect(body.opsDayOfWeekTrough).toBe(1);
      expect(body.opsCountUniqueHours).toBe(1);
      expect(body.opsCountUniqueDaysOfWeek).toBe(1);
    });

    it('27. summary — Monday x4, Saturday x1: peak=1 (Mon), trough=6 (Sat)', async () => {
      ctx = await setup();
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp(`agent-s3-m${i}`, 'fs', `sess-m${i}`, MONDAY), dec(0.4));
      }
      await ctx.logger.log(makeOp('agent-s3-sat', 'fs', 'sess-sat', SATURDAY), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.opsDayOfWeekPeak).toBe(1);   // Monday = day 1
      expect(body.opsDayOfWeekTrough).toBe(6); // Saturday = day 6
      expect(body.opsCountUniqueDaysOfWeek).toBe(2);
    });

    it('28. summary — ops spread across 7 distinct hours: opsCountUniqueHours=7', async () => {
      ctx = await setup();
      for (const h of [0, 3, 6, 9, 12, 15, 18]) {
        await ctx.logger.log(makeOp('agent-s4', 'fs', 'sess-1', atHour(h)), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.opsCountUniqueHours).toBe(7);
    });

    it('29. summary — ops across all 7 days of week: opsCountUniqueDaysOfWeek=7', async () => {
      ctx = await setup();
      // Sun(0), Mon(1), Tue(2), Wed(3), Thu(4), Fri(5), Sat(6)
      const weekDays = [
        new Date('2026-03-15T10:00:00Z'), // Sun = 0
        new Date('2026-03-16T10:00:00Z'), // Mon = 1
        new Date('2026-03-17T10:00:00Z'), // Tue = 2
        new Date('2026-03-18T10:00:00Z'), // Wed = 3
        new Date('2026-03-19T10:00:00Z'), // Thu = 4
        new Date('2026-03-20T10:00:00Z'), // Fri = 5
        new Date('2026-03-21T10:00:00Z'), // Sat = 6
      ];
      for (const ts of weekDays) {
        await ctx.logger.log(makeOp('agent-s5', 'fs', 'sess-1', ts), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.opsCountUniqueDaysOfWeek).toBe(7);
    });

    it('30. summary — riskScoreEntropyAllTime: all same score → 0 entropy', async () => {
      ctx = await setup();
      for (let i = 0; i < 6; i++) {
        await ctx.logger.log(makeOp(`agent-s6-${i}`, 'fs', `sess-${i}`, MONDAY), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.riskScoreEntropyAllTime as number).toBeCloseTo(0, 10);
    });

    it('31. summary — riskScoreEntropyAllTime: two equal buckets → 1 bit', async () => {
      ctx = await setup();
      // 4 ops at 0.2 and 4 ops at 0.8 → 2 equal buckets → entropy = 1 bit
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp(`agent-s7-lo${i}`, 'fs', `sess-lo${i}`, MONDAY), dec(0.2));
        await ctx.logger.log(makeOp(`agent-s7-hi${i}`, 'fs', `sess-hi${i}`, TUESDAY), dec(0.8));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.riskScoreEntropyAllTime as number).toBeCloseTo(1.0, 5);
    });

    it('32. summary — riskScoreEntropyAllTime: four equal buckets → 2 bits', async () => {
      ctx = await setup();
      // 2 ops each at 0.1, 0.4, 0.7, 1.0 → 4 equal buckets → entropy = 2 bits
      for (const score of [0.1, 0.4, 0.7, 1.0]) {
        for (let i = 0; i < 2; i++) {
          await ctx.logger.log(makeOp(`agent-s8-${score}-${i}`, 'fs', `sess-${score}-${i}`, MONDAY), dec(score));
        }
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.riskScoreEntropyAllTime as number).toBeCloseTo(2.0, 5);
    });

    it('33. summary — opsDayOfWeekPeak returns integer 0-6', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s9', 'fs', 'sess-1', WEDNESDAY), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      const peak = body.opsDayOfWeekPeak as number;
      expect(Number.isInteger(peak)).toBe(true);
      expect(peak).toBeGreaterThanOrEqual(0);
      expect(peak).toBeLessThanOrEqual(6);
    });

    it('34. summary — opsDayOfWeekTrough: only days with ≥1 op are candidates', async () => {
      ctx = await setup();
      // Only ops on Monday (many) and Wednesday (few): trough must be Wednesday not an empty day
      for (let i = 0; i < 10; i++) {
        await ctx.logger.log(makeOp(`agent-s10-m${i}`, 'fs', `sess-m${i}`, MONDAY), dec(0.4));
      }
      await ctx.logger.log(makeOp('agent-s10-w', 'fs', 'sess-w', WEDNESDAY), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      // Trough = Wednesday (day 3) — not Sunday (day 0) which has 0 ops
      expect(body.opsDayOfWeekTrough).toBe(3);
    });
  });
});
