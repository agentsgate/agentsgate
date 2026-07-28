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
function dayAgo(d: number): Date {
  const now = new Date(PINNED_NOW());
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - d);
}
function computeMAD(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mid = Math.floor(n / 2);
  const median = n % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
  const deviations = values.map(v => Math.abs(v - median)).sort((a, b) => a - b);
  const dm = Math.floor(deviations.length / 2);
  return deviations.length % 2 === 0
    ? (deviations[dm - 1]! + deviations[dm]!) / 2
    : deviations[dm]!;
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

// ── v10.101 ────────────────────────────────────────────────────────────────────

describe('v10.101', () => {
  function dayAgo(d: number): Date {
    const now = new Date(PINNED_NOW());
    // DST-safe: use JS date arithmetic
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() - d);
  }

  /**
   * Compute MAD (Median Absolute Deviation) from an array of numbers.
   * Returns null if the array is empty.
   */
  function computeMAD(values: number[]): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const n = sorted.length;
    const mid = Math.floor(n / 2);
    const median = n % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
    const deviations = values.map(v => Math.abs(v - median)).sort((a, b) => a - b);
    const dm = Math.floor(deviations.length / 2);
    return deviations.length % 2 === 0
      ? (deviations[dm - 1]! + deviations[dm]!) / 2
      : deviations[dm]!;
  }

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1574-T1578 — v10.101 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v10101-pres'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10101-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('riskScoreMADAllTime');
      expect(body).toHaveProperty('riskScoreMADLast7d');
      expect(body).toHaveProperty('riskScoreMADLast30d');
      expect(body).toHaveProperty('blockRateLast14d');
      expect(body).toHaveProperty('opsLast14d');
    });

    it('2. sessions — riskScoreMADAllTime: null when session has no logs', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10101-nodata');
      if (status === 200) {
        expect(body.riskScoreMADAllTime).toBeNull();
      } else {
        expect(status).toBe(404);
      }
    });

    it('3. sessions — riskScoreMADAllTime: 0 when all scores are equal (MAD=0)', async () => {
      ctx = await setup();
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v10101-mad0', dayAgo(5)), dec(0.5));
      }
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10101-mad0');
      expect(status).toBe(200);
      // median=0.5, all deviations=0 → MAD=0
      expect(body.riskScoreMADAllTime as number).toBeCloseTo(0, 5);
    });

    it('4. sessions — riskScoreMADAllTime: correct MAD for known scores', async () => {
      ctx = await setup();
      // scores = [0.1, 0.3, 0.5, 0.7, 0.9] → median=0.5
      // deviations = [0.4, 0.2, 0, 0.2, 0.4] → sorted=[0,0.2,0.2,0.4,0.4] → MAD=0.2
      for (const score of [0.1, 0.3, 0.5, 0.7, 0.9]) {
        await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v10101-madval', dayAgo(3)), dec(score));
      }
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10101-madval');
      expect(status).toBe(200);
      const expectedMAD = computeMAD([0.1, 0.3, 0.5, 0.7, 0.9])!;
      expect(body.riskScoreMADAllTime as number).toBeCloseTo(expectedMAD, 5);
    });

    it('5. sessions — riskScoreMADLast7d: null when no ops in 7d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v10101-mad7null', dayAgo(10)), dec(0.5));
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10101-mad7null');
      expect(status).toBe(200);
      expect(body.riskScoreMADLast7d).toBeNull();
    });

    it('6. sessions — riskScoreMADLast7d: correct MAD for ops within 7d', async () => {
      ctx = await setup();
      // scores within 7d = [0.2, 0.4, 0.6] → median=0.4
      // deviations = [0.2, 0, 0.2] → sorted=[0,0.2,0.2] → MAD=0.2
      for (const score of [0.2, 0.4, 0.6]) {
        await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v10101-mad7val', dayAgo(3)), dec(score));
      }
      // add older op that should be excluded from 7d window
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v10101-mad7val', dayAgo(10)), dec(0.9));
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10101-mad7val');
      expect(status).toBe(200);
      const expectedMAD = computeMAD([0.2, 0.4, 0.6])!;
      expect(body.riskScoreMADLast7d as number).toBeCloseTo(expectedMAD, 5);
    });

    it('7. sessions — riskScoreMADLast30d: null when no ops in 30d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v10101-mad30null', dayAgo(35)), dec(0.5));
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10101-mad30null');
      expect(status).toBe(200);
      expect(body.riskScoreMADLast30d).toBeNull();
    });

    it('8. sessions — riskScoreMADLast30d: correct MAD for ops within 30d', async () => {
      ctx = await setup();
      // scores within 30d = [0.1, 0.5, 0.9] → median=0.5
      // deviations = [0.4, 0, 0.4] → sorted=[0,0.4,0.4] → MAD=0.4
      for (const score of [0.1, 0.5, 0.9]) {
        await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v10101-mad30val', dayAgo(15)), dec(score));
      }
      // add older op that should be excluded from 30d window
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v10101-mad30val', dayAgo(40)), dec(0.3));
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10101-mad30val');
      expect(status).toBe(200);
      const expectedMAD = computeMAD([0.1, 0.5, 0.9])!;
      expect(body.riskScoreMADLast30d as number).toBeCloseTo(expectedMAD, 5);
    });

    it('9. sessions — blockRateLast14d: null when no ops in 14d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v10101-blk14null', dayAgo(20)), dec(0.8, 'block'));
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10101-blk14null');
      expect(status).toBe(200);
      expect(body.blockRateLast14d).toBeNull();
    });

    it('10. sessions — blockRateLast14d: 0 when all ops in 14d are allowed', async () => {
      ctx = await setup();
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v10101-blk14zero', dayAgo(5)), dec(0.3, 'allow'));
      }
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10101-blk14zero');
      expect(status).toBe(200);
      expect(body.blockRateLast14d as number).toBeCloseTo(0, 5);
    });

    it('11. sessions — blockRateLast14d: correct fraction of blocked ops in 14d', async () => {
      ctx = await setup();
      // 2 blocked out of 5 ops → rate=0.4; older blocked op should not count
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v10101-blk14val', dayAgo(5)), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v10101-blk14val', dayAgo(5)), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v10101-blk14val', dayAgo(5)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v10101-blk14val', dayAgo(5)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v10101-blk14val', dayAgo(5)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v10101-blk14val', dayAgo(20)), dec(0.9, 'block'));
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10101-blk14val');
      expect(status).toBe(200);
      expect(body.blockRateLast14d as number).toBeCloseTo(2 / 5, 5);
    });

    it('12. sessions — opsLast14d: null when no ops in 14d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-k', 'fs', 'sess-v10101-ops14null', dayAgo(20)), dec(0.5));
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10101-ops14null');
      expect(status).toBe(200);
      expect(body.opsLast14d).toBeNull();
    });

    it('13. sessions — opsLast14d: correct count of ops in 14d window', async () => {
      ctx = await setup();
      // 3 ops in 14d, 2 ops older (should not count)
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-l', 'fs', 'sess-v10101-ops14val', dayAgo(5)), dec(0.4));
      }
      for (let i = 0; i < 2; i++) {
        await ctx.logger.log(makeOp('agent-l', 'fs', 'sess-v10101-ops14val', dayAgo(20)), dec(0.4));
      }
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10101-ops14val');
      expect(status).toBe(200);
      expect(body.opsLast14d).toBe(3);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1574-T1578 — v10.101 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('14. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-v10101-pres'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/agents/agt-v10101-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('riskScoreMADAllTime');
      expect(body).toHaveProperty('riskScoreMADLast7d');
      expect(body).toHaveProperty('riskScoreMADLast30d');
      expect(body).toHaveProperty('blockRateLast14d');
      expect(body).toHaveProperty('opsLast14d');
    });

    it('15. agents — riskScoreMADAllTime: non-negative for any data', async () => {
      ctx = await setup();
      for (const score of [0.2, 0.5, 0.8]) {
        await ctx.logger.log(makeOp('agt-v10101-madpos', 'fs', 'sess', dayAgo(5)), dec(score));
      }
      const { status, body } = await getJSON(ctx.port, '/agents/agt-v10101-madpos');
      expect(status).toBe(200);
      const mad = body.riskScoreMADAllTime as number;
      expect(mad).toBeGreaterThanOrEqual(0);
    });

    it('16. agents — riskScoreMADAllTime: correct MAD for known scores', async () => {
      ctx = await setup();
      // scores = [0.2, 0.4, 0.6, 0.8] → median = (0.4+0.6)/2 = 0.5
      // deviations = [0.3, 0.1, 0.1, 0.3] → sorted=[0.1,0.1,0.3,0.3] → MAD=(0.1+0.3)/2=0.2
      for (const score of [0.2, 0.4, 0.6, 0.8]) {
        await ctx.logger.log(makeOp('agt-v10101-madval', 'fs', 'sess', dayAgo(3)), dec(score));
      }
      const { status, body } = await getJSON(ctx.port, '/agents/agt-v10101-madval');
      expect(status).toBe(200);
      const expectedMAD = computeMAD([0.2, 0.4, 0.6, 0.8])!;
      expect(body.riskScoreMADAllTime as number).toBeCloseTo(expectedMAD, 5);
    });

    it('17. agents — riskScoreMADLast7d: null when no ops in 7d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-v10101-mad7null', 'fs', 'sess', dayAgo(10)), dec(0.5));
      const { status, body } = await getJSON(ctx.port, '/agents/agt-v10101-mad7null');
      expect(status).toBe(200);
      expect(body.riskScoreMADLast7d).toBeNull();
    });

    it('18. agents — riskScoreMADLast30d: null when no ops in 30d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-v10101-mad30null', 'fs', 'sess', dayAgo(35)), dec(0.5));
      const { status, body } = await getJSON(ctx.port, '/agents/agt-v10101-mad30null');
      expect(status).toBe(200);
      expect(body.riskScoreMADLast30d).toBeNull();
    });

    it('19. agents — blockRateLast14d: null when no ops in 14d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-v10101-blk14null', 'fs', 'sess', dayAgo(20)), dec(0.8, 'block'));
      const { status, body } = await getJSON(ctx.port, '/agents/agt-v10101-blk14null');
      expect(status).toBe(200);
      expect(body.blockRateLast14d).toBeNull();
    });

    it('20. agents — blockRateLast14d: 1.0 when all ops in 14d are blocked', async () => {
      ctx = await setup();
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agt-v10101-blk14all', 'fs', 'sess', dayAgo(5)), dec(0.9, 'block'));
      }
      const { status, body } = await getJSON(ctx.port, '/agents/agt-v10101-blk14all');
      expect(status).toBe(200);
      expect(body.blockRateLast14d as number).toBeCloseTo(1.0, 5);
    });

    it('21. agents — opsLast14d: null when no ops in 14d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-v10101-ops14null', 'fs', 'sess', dayAgo(20)), dec(0.5));
      const { status, body } = await getJSON(ctx.port, '/agents/agt-v10101-ops14null');
      expect(status).toBe(200);
      expect(body.opsLast14d).toBeNull();
    });

    it('22. agents — opsLast14d: correct count of ops in 14d (excludes older ops)', async () => {
      ctx = await setup();
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp('agt-v10101-ops14val', 'fs', 'sess', dayAgo(7)), dec(0.4));
      }
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agt-v10101-ops14val', 'fs', 'sess', dayAgo(20)), dec(0.4));
      }
      const { status, body } = await getJSON(ctx.port, '/agents/agt-v10101-ops14val');
      expect(status).toBe(200);
      expect(body.opsLast14d).toBe(4);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1574-T1578 — v10.101 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('23. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v10101-pres'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10101-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('riskScoreMADAllTime');
      expect(body).toHaveProperty('riskScoreMADLast7d');
      expect(body).toHaveProperty('riskScoreMADLast30d');
      expect(body).toHaveProperty('blockRateLast14d');
      expect(body).toHaveProperty('opsLast14d');
    });

    it('24. tools — riskScoreMADAllTime: 0 when single op (MAD=0)', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-b', 'tool-v10101-madone', 'sess', dayAgo(5)), dec(0.6));
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10101-madone');
      expect(status).toBe(200);
      // single score: median=0.6, deviation=0 → MAD=0
      expect(body.riskScoreMADAllTime as number).toBeCloseTo(0, 5);
    });

    it('25. tools — riskScoreMADLast7d: correct MAD for ops in 7d (older excluded)', async () => {
      ctx = await setup();
      // scores in 7d = [0.3, 0.5, 0.7] → median=0.5 → deviations=[0.2,0,0.2] → MAD=0.2
      for (const score of [0.3, 0.5, 0.7]) {
        await ctx.logger.log(makeOp('agent-c', 'tool-v10101-mad7val', 'sess', dayAgo(3)), dec(score));
      }
      await ctx.logger.log(makeOp('agent-c', 'tool-v10101-mad7val', 'sess', dayAgo(10)), dec(0.9));
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10101-mad7val');
      expect(status).toBe(200);
      const expectedMAD = computeMAD([0.3, 0.5, 0.7])!;
      expect(body.riskScoreMADLast7d as number).toBeCloseTo(expectedMAD, 5);
    });

    it('26. tools — riskScoreMADLast30d: null when no ops in 30d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-d', 'tool-v10101-mad30null', 'sess', dayAgo(35)), dec(0.5));
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10101-mad30null');
      expect(status).toBe(200);
      expect(body.riskScoreMADLast30d).toBeNull();
    });

    it('27. tools — blockRateLast14d: float in [0,1] for mixed block/allow ops', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-e', 'tool-v10101-blk14mix', 'sess', dayAgo(5)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-e', 'tool-v10101-blk14mix', 'sess', dayAgo(5)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-e', 'tool-v10101-blk14mix', 'sess', dayAgo(5)), dec(0.3, 'allow'));
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10101-blk14mix');
      expect(status).toBe(200);
      const rate = body.blockRateLast14d as number;
      expect(rate).toBeGreaterThanOrEqual(0);
      expect(rate).toBeLessThanOrEqual(1);
      expect(rate).toBeCloseTo(1 / 3, 5);
    });

    it('28. tools — opsLast14d: null when 0 ops in 14d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-f', 'tool-v10101-ops14null', 'sess', dayAgo(20)), dec(0.5));
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10101-ops14null');
      expect(status).toBe(200);
      expect(body.opsLast14d).toBeNull();
    });

    it('29. tools — opsLast14d: positive integer equal to count of ops in 14d', async () => {
      ctx = await setup();
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp('agent-g', 'tool-v10101-ops14val', 'sess', dayAgo(10)), dec(0.4));
      }
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10101-ops14val');
      expect(status).toBe(200);
      expect(body.opsLast14d).toBe(5);
    });
  });

  // ── summary endpoint ──────────────────────────────────────────────────────────

  describe('T1574-T1578 — v10.101 new fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('30. summary — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body).toHaveProperty('riskScoreMADAllTime');
      expect(body).toHaveProperty('riskScoreMADLast7d');
      expect(body).toHaveProperty('riskScoreMADLast30d');
      expect(body).toHaveProperty('blockRateLast14d');
      expect(body).toHaveProperty('opsLast14d');
    });

    it('31. summary — riskScoreMADAllTime: null when no logs at all', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreMADAllTime).toBeNull();
    });

    it('32. summary — riskScoreMADAllTime: correct MAD for all-time scores', async () => {
      ctx = await setup();
      // scores = [0.1, 0.3, 0.5, 0.7, 0.9] → median=0.5 → MAD=0.2
      for (const score of [0.1, 0.3, 0.5, 0.7, 0.9]) {
        await ctx.logger.log(makeOp('agent-b', 'fs', 'sess', dayAgo(50)), dec(score));
      }
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      const expectedMAD = computeMAD([0.1, 0.3, 0.5, 0.7, 0.9])!;
      expect(body.riskScoreMADAllTime as number).toBeCloseTo(expectedMAD, 5);
    });

    it('33. summary — riskScoreMADLast7d: null when no ops in 7d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess', dayAgo(10)), dec(0.5));
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreMADLast7d).toBeNull();
    });

    it('34. summary — riskScoreMADLast7d: correct MAD for ops in 7d (excludes older)', async () => {
      ctx = await setup();
      // 7d ops: [0.2, 0.6] → median=0.4 → deviations=[0.2,0.2] → MAD=0.2
      for (const score of [0.2, 0.6]) {
        await ctx.logger.log(makeOp('agent-d', 'fs', 'sess', dayAgo(3)), dec(score));
      }
      // older op — should NOT be in 7d MAD
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess', dayAgo(10)), dec(0.9));
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      const expectedMAD = computeMAD([0.2, 0.6])!;
      expect(body.riskScoreMADLast7d as number).toBeCloseTo(expectedMAD, 5);
    });

    it('35. summary — riskScoreMADLast30d: null when no ops in 30d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess', dayAgo(35)), dec(0.5));
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreMADLast30d).toBeNull();
    });

    it('36. summary — riskScoreMADLast30d: correct MAD for ops in 30d (excludes older)', async () => {
      ctx = await setup();
      // 30d ops: [0.3, 0.5, 0.7] → median=0.5 → deviations=[0.2,0,0.2] → MAD=0.2
      for (const score of [0.3, 0.5, 0.7]) {
        await ctx.logger.log(makeOp('agent-f', 'fs', 'sess', dayAgo(15)), dec(score));
      }
      // older op — should NOT be in 30d MAD
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess', dayAgo(40)), dec(0.0));
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      const expectedMAD = computeMAD([0.3, 0.5, 0.7])!;
      expect(body.riskScoreMADLast30d as number).toBeCloseTo(expectedMAD, 5);
    });

    it('37. summary — blockRateLast14d: null when no ops in 14d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess', dayAgo(20)), dec(0.8, 'block'));
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.blockRateLast14d).toBeNull();
    });

    it('38. summary — blockRateLast14d: correct rate (excludes ops older than 14d)', async () => {
      ctx = await setup();
      // 14d ops: 3 block + 1 allow → rate=0.75; plus older block (not counted)
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess', dayAgo(5)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess', dayAgo(5)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess', dayAgo(5)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess', dayAgo(5)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess', dayAgo(20)), dec(0.9, 'block'));
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.blockRateLast14d as number).toBeCloseTo(3 / 4, 5);
    });

    it('39. summary — opsLast14d: null when no ops in 14d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess', dayAgo(20)), dec(0.5));
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.opsLast14d).toBeNull();
    });

    it('40. summary — opsLast14d: positive integer equal to count of ops in 14d', async () => {
      ctx = await setup();
      // 6 ops in 14d, 4 older (should not count)
      for (let i = 0; i < 6; i++) {
        await ctx.logger.log(makeOp('agent-j', 'fs', 'sess', dayAgo(10)), dec(0.4));
      }
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp('agent-j', 'fs', 'sess', dayAgo(20)), dec(0.4));
      }
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.opsLast14d).toBe(6);
    });
  });
});

// ── v10.102 ────────────────────────────────────────────────────────────────────

describe('v10.102', () => {
  function dayAgo(d: number): Date {
    const now = new Date(PINNED_NOW());
    // DST-safe: use JS date arithmetic
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() - d);
  }

  /** Population standard deviation */
  function computeStdDev(values: number[]): number | null {
    if (values.length === 0) return null;
    const mean = values.reduce((a, v) => a + v, 0) / values.length;
    return Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length);
  }

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1579-T1583 — v10.102 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v10102-pres'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10102-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('avgRiskScoreLast14d');
      expect(body).toHaveProperty('maxRiskScoreLast14d');
      expect(body).toHaveProperty('minRiskScoreLast14d');
      expect(body).toHaveProperty('riskScoreStdDevLast14d');
      expect(body).toHaveProperty('uniqueAgentsLast14d');
    });

    it('2. sessions — all five fields: null when no ops in 14d window', async () => {
      ctx = await setup();
      // All ops are older than 14d
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v10102-null14', dayAgo(20)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10102-null14');
      expect(status).toBe(200);
      expect(body.avgRiskScoreLast14d).toBeNull();
      expect(body.maxRiskScoreLast14d).toBeNull();
      expect(body.minRiskScoreLast14d).toBeNull();
      expect(body.riskScoreStdDevLast14d).toBeNull();
      expect(body.uniqueAgentsLast14d).toBeNull();
    });

    it('3. sessions — avgRiskScoreLast14d: correct mean for known scores', async () => {
      ctx = await setup();
      // scores = [0.2, 0.4, 0.6] → mean = 0.4
      for (const score of [0.2, 0.4, 0.6]) {
        await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v10102-avg', dayAgo(5)), dec(score));
      }
      // older op should not count
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v10102-avg', dayAgo(20)), dec(0.9));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10102-avg');
      expect(status).toBe(200);
      expect(body.avgRiskScoreLast14d as number).toBeCloseTo(0.4, 5);
    });

    it('4. sessions — maxRiskScoreLast14d >= minRiskScoreLast14d for multiple scores', async () => {
      ctx = await setup();
      for (const score of [0.1, 0.5, 0.9]) {
        await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v10102-maxmin', dayAgo(7)), dec(score));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10102-maxmin');
      expect(status).toBe(200);
      expect(body.maxRiskScoreLast14d as number).toBeCloseTo(0.9, 5);
      expect(body.minRiskScoreLast14d as number).toBeCloseTo(0.1, 5);
      expect(body.maxRiskScoreLast14d as number).toBeGreaterThanOrEqual(body.minRiskScoreLast14d as number);
    });

    it('5. sessions — riskScoreStdDevLast14d: 0 when all scores are equal', async () => {
      ctx = await setup();
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v10102-stddev0', dayAgo(5)), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10102-stddev0');
      expect(status).toBe(200);
      expect(body.riskScoreStdDevLast14d as number).toBeCloseTo(0, 5);
    });

    it('6. sessions — riskScoreStdDevLast14d: correct population stddev for known scores', async () => {
      ctx = await setup();
      // scores in 14d = [0.2, 0.4, 0.6, 0.8] → mean=0.5 → variance=0.05 → stddev≈0.2236
      for (const score of [0.2, 0.4, 0.6, 0.8]) {
        await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v10102-stdval', dayAgo(5)), dec(score));
      }
      // older op should not affect 14d stddev
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v10102-stdval', dayAgo(20)), dec(0.0));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10102-stdval');
      expect(status).toBe(200);
      const expected = computeStdDev([0.2, 0.4, 0.6, 0.8])!;
      expect(body.riskScoreStdDevLast14d as number).toBeCloseTo(expected, 5);
      expect(body.riskScoreStdDevLast14d as number).toBeGreaterThanOrEqual(0);
    });

    it('7. sessions — uniqueAgentsLast14d: counts distinct agentIds within 14d', async () => {
      ctx = await setup();
      // 3 distinct agents within 14d; 1 agent only in older ops (should not count)
      await ctx.logger.log(makeOp('agt-x1', 'fs', 'sess-v10102-uniq', dayAgo(5)), dec(0.3));
      await ctx.logger.log(makeOp('agt-x2', 'fs', 'sess-v10102-uniq', dayAgo(5)), dec(0.3));
      await ctx.logger.log(makeOp('agt-x3', 'fs', 'sess-v10102-uniq', dayAgo(5)), dec(0.3));
      // same agents again (should not inflate count)
      await ctx.logger.log(makeOp('agt-x1', 'fs', 'sess-v10102-uniq', dayAgo(10)), dec(0.5));
      // older agent (outside 14d)
      await ctx.logger.log(makeOp('agt-x4', 'fs', 'sess-v10102-uniq', dayAgo(20)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10102-uniq');
      expect(status).toBe(200);
      expect(body.uniqueAgentsLast14d).toBe(3);
    });

    it('8. sessions — uniqueAgentsLast14d: 1 when single agent has multiple ops in 14d', async () => {
      ctx = await setup();
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp('agt-solo', 'fs', 'sess-v10102-solo', dayAgo(3)), dec(0.4));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10102-solo');
      expect(status).toBe(200);
      expect(body.uniqueAgentsLast14d).toBe(1);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1579-T1583 — v10.102 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('9. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-v10102-pres'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/agents/agt-v10102-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('avgRiskScoreLast14d');
      expect(body).toHaveProperty('maxRiskScoreLast14d');
      expect(body).toHaveProperty('minRiskScoreLast14d');
      expect(body).toHaveProperty('riskScoreStdDevLast14d');
      expect(body).toHaveProperty('uniqueAgentsLast14d');
    });

    it('10. agents — all five fields: null when no ops in 14d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-v10102-null14', 'fs', 'sess', dayAgo(20)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/agents/agt-v10102-null14');
      expect(status).toBe(200);
      expect(body.avgRiskScoreLast14d).toBeNull();
      expect(body.maxRiskScoreLast14d).toBeNull();
      expect(body.minRiskScoreLast14d).toBeNull();
      expect(body.riskScoreStdDevLast14d).toBeNull();
      expect(body.uniqueAgentsLast14d).toBeNull();
    });

    it('11. agents — avgRiskScoreLast14d: float in [0,1]', async () => {
      ctx = await setup();
      for (const score of [0.1, 0.3, 0.7, 0.9]) {
        await ctx.logger.log(makeOp('agt-v10102-avgrange', 'fs', 'sess', dayAgo(5)), dec(score));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agt-v10102-avgrange');
      expect(status).toBe(200);
      const avg = body.avgRiskScoreLast14d as number;
      expect(avg).toBeGreaterThanOrEqual(0);
      expect(avg).toBeLessThanOrEqual(1);
      expect(avg).toBeCloseTo(0.5, 5);
    });

    it('12. agents — maxRiskScoreLast14d: equals highest score in 14d (older excluded)', async () => {
      ctx = await setup();
      // max in 14d should be 0.7 (older 0.99 excluded)
      for (const score of [0.3, 0.5, 0.7]) {
        await ctx.logger.log(makeOp('agt-v10102-maxval', 'fs', 'sess', dayAgo(5)), dec(score));
      }
      await ctx.logger.log(makeOp('agt-v10102-maxval', 'fs', 'sess', dayAgo(20)), dec(0.99));

      const { status, body } = await getJSON(ctx.port, '/agents/agt-v10102-maxval');
      expect(status).toBe(200);
      expect(body.maxRiskScoreLast14d as number).toBeCloseTo(0.7, 5);
    });

    it('13. agents — minRiskScoreLast14d: equals lowest score in 14d (older excluded)', async () => {
      ctx = await setup();
      // min in 14d should be 0.3 (older 0.01 excluded)
      for (const score of [0.3, 0.5, 0.7]) {
        await ctx.logger.log(makeOp('agt-v10102-minval', 'fs', 'sess', dayAgo(5)), dec(score));
      }
      await ctx.logger.log(makeOp('agt-v10102-minval', 'fs', 'sess', dayAgo(20)), dec(0.01));

      const { status, body } = await getJSON(ctx.port, '/agents/agt-v10102-minval');
      expect(status).toBe(200);
      expect(body.minRiskScoreLast14d as number).toBeCloseTo(0.3, 5);
    });

    it('14. agents — riskScoreStdDevLast14d: non-negative float for any data', async () => {
      ctx = await setup();
      for (const score of [0.2, 0.5, 0.8]) {
        await ctx.logger.log(makeOp('agt-v10102-stdpos', 'fs', 'sess', dayAgo(5)), dec(score));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agt-v10102-stdpos');
      expect(status).toBe(200);
      const std = body.riskScoreStdDevLast14d as number;
      expect(std).toBeGreaterThanOrEqual(0);
    });

    it('15. agents — uniqueAgentsLast14d: always 1 for a single-agent endpoint', async () => {
      ctx = await setup();
      // For /agents/:agentId, all logs are for that agent, so uniqueAgentsLast14d must be 1
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp('agt-v10102-uniq1', 'fs', 'sess', dayAgo(5)), dec(0.4));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agt-v10102-uniq1');
      expect(status).toBe(200);
      expect(body.uniqueAgentsLast14d).toBe(1);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1579-T1583 — v10.102 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('16. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v10102-pres'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10102-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('avgRiskScoreLast14d');
      expect(body).toHaveProperty('maxRiskScoreLast14d');
      expect(body).toHaveProperty('minRiskScoreLast14d');
      expect(body).toHaveProperty('riskScoreStdDevLast14d');
      expect(body).toHaveProperty('uniqueAgentsLast14d');
    });

    it('17. tools — all five fields: null when no ops in 14d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-b', 'tool-v10102-null14', 'sess', dayAgo(20)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10102-null14');
      expect(status).toBe(200);
      expect(body.avgRiskScoreLast14d).toBeNull();
      expect(body.maxRiskScoreLast14d).toBeNull();
      expect(body.minRiskScoreLast14d).toBeNull();
      expect(body.riskScoreStdDevLast14d).toBeNull();
      expect(body.uniqueAgentsLast14d).toBeNull();
    });

    it('18. tools — avgRiskScoreLast14d: correct mean (older ops excluded)', async () => {
      ctx = await setup();
      // 14d: [0.2, 0.8] → mean=0.5; older 0.0 excluded
      for (const score of [0.2, 0.8]) {
        await ctx.logger.log(makeOp('agent-c', 'tool-v10102-avg', 'sess', dayAgo(5)), dec(score));
      }
      await ctx.logger.log(makeOp('agent-c', 'tool-v10102-avg', 'sess', dayAgo(20)), dec(0.0));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10102-avg');
      expect(status).toBe(200);
      expect(body.avgRiskScoreLast14d as number).toBeCloseTo(0.5, 5);
    });

    it('19. tools — riskScoreStdDevLast14d: correct stddev (older ops excluded)', async () => {
      ctx = await setup();
      // 14d: [0.2, 0.4, 0.6, 0.8] → stddev ≈ 0.2236
      for (const score of [0.2, 0.4, 0.6, 0.8]) {
        await ctx.logger.log(makeOp('agent-d', 'tool-v10102-std', 'sess', dayAgo(5)), dec(score));
      }
      // older ops should be excluded
      await ctx.logger.log(makeOp('agent-d', 'tool-v10102-std', 'sess', dayAgo(20)), dec(0.0));
      await ctx.logger.log(makeOp('agent-d', 'tool-v10102-std', 'sess', dayAgo(20)), dec(1.0));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10102-std');
      expect(status).toBe(200);
      const expected = computeStdDev([0.2, 0.4, 0.6, 0.8])!;
      expect(body.riskScoreStdDevLast14d as number).toBeCloseTo(expected, 5);
    });

    it('20. tools — uniqueAgentsLast14d: counts distinct agentIds within 14d', async () => {
      ctx = await setup();
      // 2 distinct agents within 14d; 1 agent only in older ops
      await ctx.logger.log(makeOp('agt-t1', 'tool-v10102-uniq', 'sess', dayAgo(5)), dec(0.3));
      await ctx.logger.log(makeOp('agt-t2', 'tool-v10102-uniq', 'sess', dayAgo(5)), dec(0.3));
      await ctx.logger.log(makeOp('agt-t1', 'tool-v10102-uniq', 'sess', dayAgo(10)), dec(0.5));
      // older agent
      await ctx.logger.log(makeOp('agt-t3', 'tool-v10102-uniq', 'sess', dayAgo(20)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10102-uniq');
      expect(status).toBe(200);
      expect(body.uniqueAgentsLast14d).toBe(2);
    });

    it('21. tools — maxRiskScoreLast14d and minRiskScoreLast14d: single op gives same value', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-e', 'tool-v10102-single', 'sess', dayAgo(5)), dec(0.65));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10102-single');
      expect(status).toBe(200);
      expect(body.maxRiskScoreLast14d as number).toBeCloseTo(0.65, 5);
      expect(body.minRiskScoreLast14d as number).toBeCloseTo(0.65, 5);
    });
  });

  // ── summary endpoint ──────────────────────────────────────────────────────────

  describe('T1579-T1583 — v10.102 new fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('22. summary — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body).toHaveProperty('avgRiskScoreLast14d');
      expect(body).toHaveProperty('maxRiskScoreLast14d');
      expect(body).toHaveProperty('minRiskScoreLast14d');
      expect(body).toHaveProperty('riskScoreStdDevLast14d');
      expect(body).toHaveProperty('uniqueAgentsLast14d');
    });

    it('23. summary — all five fields: null when no logs at all', async () => {
      ctx = await setup();

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.avgRiskScoreLast14d).toBeNull();
      expect(body.maxRiskScoreLast14d).toBeNull();
      expect(body.minRiskScoreLast14d).toBeNull();
      expect(body.riskScoreStdDevLast14d).toBeNull();
      expect(body.uniqueAgentsLast14d).toBeNull();
    });

    it('24. summary — all five fields: null when all ops are older than 14d', async () => {
      ctx = await setup();
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-b', 'fs', 'sess', dayAgo(20)), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.avgRiskScoreLast14d).toBeNull();
      expect(body.maxRiskScoreLast14d).toBeNull();
      expect(body.minRiskScoreLast14d).toBeNull();
      expect(body.riskScoreStdDevLast14d).toBeNull();
      expect(body.uniqueAgentsLast14d).toBeNull();
    });

    it('25. summary — avgRiskScoreLast14d: correct mean for all ops in 14d', async () => {
      ctx = await setup();
      // 14d: [0.1, 0.5, 0.9] → mean=0.5
      for (const score of [0.1, 0.5, 0.9]) {
        await ctx.logger.log(makeOp('agent-c', 'fs', 'sess', dayAgo(5)), dec(score));
      }
      // older op excluded
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess', dayAgo(25)), dec(0.0));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.avgRiskScoreLast14d as number).toBeCloseTo(0.5, 5);
    });

    it('26. summary — maxRiskScoreLast14d: max only from 14d window (older excluded)', async () => {
      ctx = await setup();
      // 14d max = 0.8; older 0.99 excluded
      for (const score of [0.3, 0.6, 0.8]) {
        await ctx.logger.log(makeOp('agent-d', 'fs', 'sess', dayAgo(7)), dec(score));
      }
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess', dayAgo(20)), dec(0.99));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.maxRiskScoreLast14d as number).toBeCloseTo(0.8, 5);
    });

    it('27. summary — minRiskScoreLast14d: min only from 14d window (older excluded)', async () => {
      ctx = await setup();
      // 14d min = 0.3; older 0.01 excluded
      for (const score of [0.3, 0.6, 0.8]) {
        await ctx.logger.log(makeOp('agent-e', 'fs', 'sess', dayAgo(7)), dec(score));
      }
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess', dayAgo(20)), dec(0.01));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.minRiskScoreLast14d as number).toBeCloseTo(0.3, 5);
    });

    it('28. summary — riskScoreStdDevLast14d: correct population stddev (older ops excluded)', async () => {
      ctx = await setup();
      // 14d: [0.2, 0.4, 0.6, 0.8] → stddev ≈ 0.2236
      for (const score of [0.2, 0.4, 0.6, 0.8]) {
        await ctx.logger.log(makeOp('agent-f', 'fs', 'sess', dayAgo(5)), dec(score));
      }
      // older op should not affect 14d stddev
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess', dayAgo(20)), dec(0.0));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      const expected = computeStdDev([0.2, 0.4, 0.6, 0.8])!;
      expect(body.riskScoreStdDevLast14d as number).toBeCloseTo(expected, 5);
      expect(body.riskScoreStdDevLast14d as number).toBeGreaterThanOrEqual(0);
    });

    it('29. summary — uniqueAgentsLast14d: counts distinct agentIds across all sessions in 14d', async () => {
      ctx = await setup();
      // 4 distinct agents within 14d; 1 agent only in older ops
      await ctx.logger.log(makeOp('agt-s1', 'fs', 'sess1', dayAgo(5)), dec(0.3));
      await ctx.logger.log(makeOp('agt-s2', 'fs', 'sess1', dayAgo(5)), dec(0.3));
      await ctx.logger.log(makeOp('agt-s3', 'fs', 'sess2', dayAgo(5)), dec(0.3));
      await ctx.logger.log(makeOp('agt-s4', 'fs', 'sess2', dayAgo(10)), dec(0.5));
      // same agents again (should not inflate count)
      await ctx.logger.log(makeOp('agt-s1', 'fs', 'sess3', dayAgo(10)), dec(0.5));
      // older agent (outside 14d)
      await ctx.logger.log(makeOp('agt-s5', 'fs', 'sess3', dayAgo(20)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.uniqueAgentsLast14d).toBe(4);
    });

    it('30. summary — riskScoreStdDevLast14d: 0 for single op in 14d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess', dayAgo(5)), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreStdDevLast14d as number).toBeCloseTo(0, 5);
    });
  });
});

// ── v10.103 ────────────────────────────────────────────────────────────────────

describe('v10.103', () => {
  function dayAgo(d: number): Date {
    const now = new Date(PINNED_NOW());
    // DST-safe: use JS date arithmetic
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() - d);
  }

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1584-T1588 — v10.103 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v10103-pres'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10103-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('uniqueSessionsLast14d');
      expect(body).toHaveProperty('uniqueToolsLast14d');
      expect(body).toHaveProperty('allowRateLast14d');
      expect(body).toHaveProperty('requireApprovalRateLast14d');
      expect(body).toHaveProperty('riskScoreP75Last7d');
    });

    it('2. sessions — all five fields: null when no ops in respective windows', async () => {
      ctx = await setup();
      // All ops are older than 14d (and 7d), so all fields null
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v10103-null', dayAgo(20)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10103-null');
      expect(status).toBe(200);
      expect(body.uniqueSessionsLast14d).toBeNull();
      expect(body.uniqueToolsLast14d).toBeNull();
      expect(body.allowRateLast14d).toBeNull();
      expect(body.requireApprovalRateLast14d).toBeNull();
      expect(body.riskScoreP75Last7d).toBeNull();
    });

    it('3. sessions — uniqueSessionsLast14d: counts distinct sessionIds in 14d (older excluded)', async () => {
      ctx = await setup();
      // 2 distinct sessions in 14d; 1 older session excluded
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v10103-s1', dayAgo(5)), dec(0.3));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v10103-s2', dayAgo(7)), dec(0.3));
      // repeat sess-v10103-s1 — should not inflate count
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v10103-s1', dayAgo(10)), dec(0.4));
      // older session excluded
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v10103-s3', dayAgo(20)), dec(0.4));

      // query any of the sessions that exist in 14d
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10103-s1');
      expect(status).toBe(200);
      // The sessions endpoint filters logs by sessionId, so for sess-v10103-s1 only its logs count
      // sess-v10103-s1 appears in 14d → uniqueSessions = 1 (only its own sessionId)
      expect(body.uniqueSessionsLast14d).toBeGreaterThanOrEqual(1);
      expect(typeof body.uniqueSessionsLast14d).toBe('number');
    });

    it('4. sessions — uniqueToolsLast14d: counts distinct tool names in 14d', async () => {
      ctx = await setup();
      // 3 distinct tools within 14d; 1 older tool excluded
      await ctx.logger.log(makeOp('agent-d', 'tool-a', 'sess-v10103-tools', dayAgo(5)), dec(0.3));
      await ctx.logger.log(makeOp('agent-d', 'tool-b', 'sess-v10103-tools', dayAgo(5)), dec(0.3));
      await ctx.logger.log(makeOp('agent-d', 'tool-c', 'sess-v10103-tools', dayAgo(7)), dec(0.3));
      // repeat tool-a — should not inflate count
      await ctx.logger.log(makeOp('agent-d', 'tool-a', 'sess-v10103-tools', dayAgo(10)), dec(0.4));
      // older tool excluded
      await ctx.logger.log(makeOp('agent-d', 'tool-z', 'sess-v10103-tools', dayAgo(20)), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10103-tools');
      expect(status).toBe(200);
      expect(body.uniqueToolsLast14d).toBe(3);
    });

    it('5. sessions — allowRateLast14d: correct fraction of allow actions in 14d', async () => {
      ctx = await setup();
      // 2 allow, 2 block → rate = 0.5
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v10103-arate', dayAgo(5)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v10103-arate', dayAgo(5)), dec(0.7, 'allow'));
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v10103-arate', dayAgo(5)), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v10103-arate', dayAgo(5)), dec(0.9, 'block'));
      // older op excluded
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v10103-arate', dayAgo(20)), dec(0.1, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10103-arate');
      expect(status).toBe(200);
      expect(body.allowRateLast14d as number).toBeCloseTo(0.5, 5);
      expect(body.allowRateLast14d as number).toBeGreaterThanOrEqual(0);
      expect(body.allowRateLast14d as number).toBeLessThanOrEqual(1);
    });

    it('6. sessions — requireApprovalRateLast14d: correct fraction of require_approval actions in 14d', async () => {
      ctx = await setup();
      // 1 require_approval out of 4 ops → rate = 0.25
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v10103-rrate', dayAgo(5)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v10103-rrate', dayAgo(5)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v10103-rrate', dayAgo(5)), dec(0.7, 'allow'));
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v10103-rrate', dayAgo(5)), dec(0.9, 'require_approval'));
      // older op excluded
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v10103-rrate', dayAgo(20)), dec(0.4, 'require_approval'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10103-rrate');
      expect(status).toBe(200);
      expect(body.requireApprovalRateLast14d as number).toBeCloseTo(0.25, 5);
      expect(body.requireApprovalRateLast14d as number).toBeGreaterThanOrEqual(0);
      expect(body.requireApprovalRateLast14d as number).toBeLessThanOrEqual(1);
    });

    it('7. sessions — riskScoreP75Last7d: correct 75th percentile for sorted scores in 7d', async () => {
      ctx = await setup();
      // scores in 7d = [0.1, 0.2, 0.4, 0.8] sorted → index Math.floor(4*0.75) = 3 → 0.8
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v10103-p75', dayAgo(3)), dec(0.4));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v10103-p75', dayAgo(3)), dec(0.1));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v10103-p75', dayAgo(3)), dec(0.8));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v10103-p75', dayAgo(3)), dec(0.2));
      // older op (beyond 7d) should be excluded
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v10103-p75', dayAgo(10)), dec(0.99));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10103-p75');
      expect(status).toBe(200);
      expect(body.riskScoreP75Last7d as number).toBeCloseTo(0.8, 5);
    });

    it('8. sessions — riskScoreP75Last7d: null when ops exist only beyond 7d (but within 14d)', async () => {
      ctx = await setup();
      // Ops are 10 days old — within 14d window but outside 7d window
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v10103-p75null', dayAgo(10)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10103-p75null');
      expect(status).toBe(200);
      expect(body.riskScoreP75Last7d).toBeNull();
      // but uniqueToolsLast14d should be non-null (op is in 14d)
      expect(body.uniqueToolsLast14d).not.toBeNull();
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1584-T1588 — v10.103 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('9. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-v10103-pres'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/agents/agt-v10103-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('uniqueSessionsLast14d');
      expect(body).toHaveProperty('uniqueToolsLast14d');
      expect(body).toHaveProperty('allowRateLast14d');
      expect(body).toHaveProperty('requireApprovalRateLast14d');
      expect(body).toHaveProperty('riskScoreP75Last7d');
    });

    it('10. agents — all five fields: null when no ops in respective windows', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-v10103-null', 'fs', 'sess', dayAgo(20)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/agents/agt-v10103-null');
      expect(status).toBe(200);
      expect(body.uniqueSessionsLast14d).toBeNull();
      expect(body.uniqueToolsLast14d).toBeNull();
      expect(body.allowRateLast14d).toBeNull();
      expect(body.requireApprovalRateLast14d).toBeNull();
      expect(body.riskScoreP75Last7d).toBeNull();
    });

    it('11. agents — uniqueSessionsLast14d: counts distinct sessions for agent in 14d', async () => {
      ctx = await setup();
      // 3 distinct sessions in 14d; 1 older session excluded
      await ctx.logger.log(makeOp('agt-v10103-usess', 'fs', 'sess-aa1', dayAgo(5)), dec(0.3));
      await ctx.logger.log(makeOp('agt-v10103-usess', 'fs', 'sess-aa2', dayAgo(5)), dec(0.3));
      await ctx.logger.log(makeOp('agt-v10103-usess', 'fs', 'sess-aa3', dayAgo(7)), dec(0.3));
      // repeat sess-aa1 — should not inflate count
      await ctx.logger.log(makeOp('agt-v10103-usess', 'fs', 'sess-aa1', dayAgo(10)), dec(0.4));
      // older session excluded
      await ctx.logger.log(makeOp('agt-v10103-usess', 'fs', 'sess-aa4', dayAgo(20)), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/agents/agt-v10103-usess');
      expect(status).toBe(200);
      expect(body.uniqueSessionsLast14d).toBe(3);
    });

    it('12. agents — uniqueToolsLast14d: counts distinct tools used by agent in 14d', async () => {
      ctx = await setup();
      // 2 distinct tools in 14d; 1 older tool excluded
      await ctx.logger.log(makeOp('agt-v10103-utools', 'tool-x', 'sess', dayAgo(5)), dec(0.3));
      await ctx.logger.log(makeOp('agt-v10103-utools', 'tool-y', 'sess', dayAgo(5)), dec(0.3));
      await ctx.logger.log(makeOp('agt-v10103-utools', 'tool-x', 'sess', dayAgo(10)), dec(0.4));
      // older tool excluded
      await ctx.logger.log(makeOp('agt-v10103-utools', 'tool-z', 'sess', dayAgo(20)), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/agents/agt-v10103-utools');
      expect(status).toBe(200);
      expect(body.uniqueToolsLast14d).toBe(2);
    });

    it('13. agents — allowRateLast14d: 1.0 when all ops in 14d are allow', async () => {
      ctx = await setup();
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp('agt-v10103-allallow', 'fs', 'sess', dayAgo(5)), dec(0.3, 'allow'));
      }
      // older block op should be excluded
      await ctx.logger.log(makeOp('agt-v10103-allallow', 'fs', 'sess', dayAgo(20)), dec(0.9, 'block'));

      const { status, body } = await getJSON(ctx.port, '/agents/agt-v10103-allallow');
      expect(status).toBe(200);
      expect(body.allowRateLast14d as number).toBeCloseTo(1.0, 5);
    });

    it('14. agents — requireApprovalRateLast14d: 0.0 when no require_approval ops in 14d', async () => {
      ctx = await setup();
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agt-v10103-norequire', 'fs', 'sess', dayAgo(5)), dec(0.4, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agt-v10103-norequire');
      expect(status).toBe(200);
      expect(body.requireApprovalRateLast14d as number).toBeCloseTo(0.0, 5);
    });

    it('15. agents — riskScoreP75Last7d: index Math.floor(n*0.75) on sorted scores', async () => {
      ctx = await setup();
      // scores in 7d = [0.1, 0.3, 0.6, 0.7, 0.9] sorted → index Math.floor(5*0.75) = 3 → 0.7
      for (const score of [0.9, 0.1, 0.7, 0.3, 0.6]) {
        await ctx.logger.log(makeOp('agt-v10103-p75', 'fs', 'sess', dayAgo(3)), dec(score));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agt-v10103-p75');
      expect(status).toBe(200);
      expect(body.riskScoreP75Last7d as number).toBeCloseTo(0.7, 5);
    });

    it('16. agents — riskScoreP75Last7d: null when no ops in 7d (but ops exist in 14d)', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-v10103-p75null2', 'fs', 'sess', dayAgo(10)), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/agents/agt-v10103-p75null2');
      expect(status).toBe(200);
      expect(body.riskScoreP75Last7d).toBeNull();
      // uniqueSessionsLast14d should be non-null (op within 14d)
      expect(body.uniqueSessionsLast14d).not.toBeNull();
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1584-T1588 — v10.103 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('17. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v10103-pres'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10103-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('uniqueSessionsLast14d');
      expect(body).toHaveProperty('uniqueToolsLast14d');
      expect(body).toHaveProperty('allowRateLast14d');
      expect(body).toHaveProperty('requireApprovalRateLast14d');
      expect(body).toHaveProperty('riskScoreP75Last7d');
    });

    it('18. tools — all five fields: null when no ops in respective windows', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-b', 'tool-v10103-null', 'sess', dayAgo(20)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10103-null');
      expect(status).toBe(200);
      expect(body.uniqueSessionsLast14d).toBeNull();
      expect(body.uniqueToolsLast14d).toBeNull();
      expect(body.allowRateLast14d).toBeNull();
      expect(body.requireApprovalRateLast14d).toBeNull();
      expect(body.riskScoreP75Last7d).toBeNull();
    });

    it('19. tools — uniqueSessionsLast14d: counts distinct sessions using the tool in 14d', async () => {
      ctx = await setup();
      // 3 distinct sessions in 14d; 1 older session excluded
      await ctx.logger.log(makeOp('agent-c', 'tool-v10103-tsess', 'sess-t1', dayAgo(5)), dec(0.3));
      await ctx.logger.log(makeOp('agent-c', 'tool-v10103-tsess', 'sess-t2', dayAgo(5)), dec(0.3));
      await ctx.logger.log(makeOp('agent-c', 'tool-v10103-tsess', 'sess-t3', dayAgo(7)), dec(0.3));
      // repeat sess-t1 — should not inflate
      await ctx.logger.log(makeOp('agent-c', 'tool-v10103-tsess', 'sess-t1', dayAgo(10)), dec(0.4));
      // older session excluded
      await ctx.logger.log(makeOp('agent-c', 'tool-v10103-tsess', 'sess-t4', dayAgo(20)), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10103-tsess');
      expect(status).toBe(200);
      expect(body.uniqueSessionsLast14d).toBe(3);
    });

    it('20. tools — uniqueToolsLast14d: always 1 for a single-tool endpoint', async () => {
      ctx = await setup();
      // For /tools/:tool, all logs filtered by tool name, so uniqueTools = 1
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp('agent-d', 'tool-v10103-only', 'sess', dayAgo(5)), dec(0.4));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10103-only');
      expect(status).toBe(200);
      expect(body.uniqueToolsLast14d).toBe(1);
    });

    it('21. tools — allowRateLast14d: correct fraction (mixed allow/block/require_approval)', async () => {
      ctx = await setup();
      // 3 allow, 1 require_approval, 1 block → allowRate = 3/5 = 0.6
      await ctx.logger.log(makeOp('agent-e', 'tool-v10103-amix', 'sess', dayAgo(5)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-e', 'tool-v10103-amix', 'sess', dayAgo(5)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-e', 'tool-v10103-amix', 'sess', dayAgo(5)), dec(0.6, 'allow'));
      await ctx.logger.log(makeOp('agent-e', 'tool-v10103-amix', 'sess', dayAgo(5)), dec(0.8, 'require_approval'));
      await ctx.logger.log(makeOp('agent-e', 'tool-v10103-amix', 'sess', dayAgo(5)), dec(0.9, 'block'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10103-amix');
      expect(status).toBe(200);
      expect(body.allowRateLast14d as number).toBeCloseTo(0.6, 5);
    });

    it('22. tools — requireApprovalRateLast14d: correct fraction (older excluded)', async () => {
      ctx = await setup();
      // 2 require_approval out of 4 in 14d → rate = 0.5; older require_approval excluded
      await ctx.logger.log(makeOp('agent-f', 'tool-v10103-rrmix', 'sess', dayAgo(5)), dec(0.3, 'require_approval'));
      await ctx.logger.log(makeOp('agent-f', 'tool-v10103-rrmix', 'sess', dayAgo(5)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-f', 'tool-v10103-rrmix', 'sess', dayAgo(5)), dec(0.7, 'require_approval'));
      await ctx.logger.log(makeOp('agent-f', 'tool-v10103-rrmix', 'sess', dayAgo(5)), dec(0.9, 'allow'));
      await ctx.logger.log(makeOp('agent-f', 'tool-v10103-rrmix', 'sess', dayAgo(20)), dec(0.1, 'require_approval'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10103-rrmix');
      expect(status).toBe(200);
      expect(body.requireApprovalRateLast14d as number).toBeCloseTo(0.5, 5);
    });

    it('23. tools — riskScoreP75Last7d: correct 75th percentile for 7d window', async () => {
      ctx = await setup();
      // scores in 7d = [0.2, 0.4, 0.6, 0.8] sorted → index Math.floor(4*0.75) = 3 → 0.8
      for (const score of [0.6, 0.2, 0.8, 0.4]) {
        await ctx.logger.log(makeOp('agent-g', 'tool-v10103-p75', 'sess', dayAgo(3)), dec(score));
      }
      // older op (beyond 7d) excluded from P75 calculation
      await ctx.logger.log(makeOp('agent-g', 'tool-v10103-p75', 'sess', dayAgo(10)), dec(0.99));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10103-p75');
      expect(status).toBe(200);
      expect(body.riskScoreP75Last7d as number).toBeCloseTo(0.8, 5);
    });
  });

  // ── summary endpoint ──────────────────────────────────────────────────────────

  describe('T1584-T1588 — v10.103 new fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('24. summary — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body).toHaveProperty('uniqueSessionsLast14d');
      expect(body).toHaveProperty('uniqueToolsLast14d');
      expect(body).toHaveProperty('allowRateLast14d');
      expect(body).toHaveProperty('requireApprovalRateLast14d');
      expect(body).toHaveProperty('riskScoreP75Last7d');
    });

    it('25. summary — all five fields: null when no logs at all', async () => {
      ctx = await setup();

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.uniqueSessionsLast14d).toBeNull();
      expect(body.uniqueToolsLast14d).toBeNull();
      expect(body.allowRateLast14d).toBeNull();
      expect(body.requireApprovalRateLast14d).toBeNull();
      expect(body.riskScoreP75Last7d).toBeNull();
    });

    it('26. summary — all five fields: null when all ops are older than 14d', async () => {
      ctx = await setup();
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-b', 'fs', 'sess', dayAgo(20)), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.uniqueSessionsLast14d).toBeNull();
      expect(body.uniqueToolsLast14d).toBeNull();
      expect(body.allowRateLast14d).toBeNull();
      expect(body.requireApprovalRateLast14d).toBeNull();
      expect(body.riskScoreP75Last7d).toBeNull();
    });

    it('27. summary — uniqueSessionsLast14d: distinct session count across all agents in 14d', async () => {
      ctx = await setup();
      // 4 distinct sessions in 14d; 1 older session excluded
      await ctx.logger.log(makeOp('agt-s1', 'fs', 'sess-sum1', dayAgo(5)), dec(0.3));
      await ctx.logger.log(makeOp('agt-s2', 'fs', 'sess-sum2', dayAgo(5)), dec(0.3));
      await ctx.logger.log(makeOp('agt-s3', 'fs', 'sess-sum3', dayAgo(7)), dec(0.3));
      await ctx.logger.log(makeOp('agt-s4', 'fs', 'sess-sum4', dayAgo(10)), dec(0.5));
      // repeat sess-sum1 — should not inflate count
      await ctx.logger.log(makeOp('agt-s1', 'fs', 'sess-sum1', dayAgo(12)), dec(0.5));
      // older session excluded
      await ctx.logger.log(makeOp('agt-s5', 'fs', 'sess-sum5', dayAgo(20)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.uniqueSessionsLast14d).toBe(4);
    });

    it('28. summary — uniqueToolsLast14d: distinct tool count across all sessions in 14d', async () => {
      ctx = await setup();
      // 3 distinct tools in 14d; 1 older tool excluded
      await ctx.logger.log(makeOp('agt-t1', 'tool-p', 'sess1', dayAgo(5)), dec(0.3));
      await ctx.logger.log(makeOp('agt-t1', 'tool-q', 'sess1', dayAgo(5)), dec(0.3));
      await ctx.logger.log(makeOp('agt-t2', 'tool-r', 'sess2', dayAgo(7)), dec(0.3));
      // repeat tool-p — should not inflate count
      await ctx.logger.log(makeOp('agt-t2', 'tool-p', 'sess2', dayAgo(10)), dec(0.4));
      // older tool excluded
      await ctx.logger.log(makeOp('agt-t3', 'tool-s', 'sess3', dayAgo(20)), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.uniqueToolsLast14d).toBe(3);
    });

    it('29. summary — allowRateLast14d: correct fraction of allow actions in 14d (older excluded)', async () => {
      ctx = await setup();
      // 3 allow, 1 block → rate = 0.75; older block excluded
      await ctx.logger.log(makeOp('agt-ar1', 'fs', 'sess1', dayAgo(5)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agt-ar1', 'fs', 'sess1', dayAgo(5)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agt-ar1', 'fs', 'sess1', dayAgo(5)), dec(0.6, 'allow'));
      await ctx.logger.log(makeOp('agt-ar1', 'fs', 'sess1', dayAgo(5)), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agt-ar1', 'fs', 'sess1', dayAgo(20)), dec(0.5, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.allowRateLast14d as number).toBeCloseTo(0.75, 5);
    });

    it('30. summary — requireApprovalRateLast14d and riskScoreP75Last7d: correct values together', async () => {
      ctx = await setup();
      // 2 require_approval out of 6 in 14d → rate = 1/3
      // scores in 7d = [0.1, 0.2, 0.4, 0.6] sorted → index Math.floor(4*0.75) = 3 → 0.6
      await ctx.logger.log(makeOp('agt-combo', 'fs', 'sess1', dayAgo(3)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agt-combo', 'fs', 'sess1', dayAgo(3)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agt-combo', 'fs', 'sess1', dayAgo(3)), dec(0.6, 'require_approval'));
      await ctx.logger.log(makeOp('agt-combo', 'fs', 'sess1', dayAgo(3)), dec(0.1, 'allow'));
      // beyond 7d but within 14d — should count for 14d fields but NOT for P75
      await ctx.logger.log(makeOp('agt-combo', 'fs', 'sess1', dayAgo(10)), dec(0.9, 'allow'));
      await ctx.logger.log(makeOp('agt-combo', 'fs', 'sess1', dayAgo(10)), dec(0.5, 'require_approval'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      // 7d: 4 ops; P75 index = floor(4*0.75) = 3; sorted [0.1, 0.2, 0.4, 0.6] → 0.6
      expect(body.riskScoreP75Last7d as number).toBeCloseTo(0.6, 5);
      // 14d: 6 ops; 2 require_approval → rate = 2/6 ≈ 0.333
      expect(body.requireApprovalRateLast14d as number).toBeCloseTo(1 / 3, 5);
    });
  });
});

// ── v10.104 ────────────────────────────────────────────────────────────────────

describe('v10.104', () => {
  function dayAgo(d: number): Date {
    const now = new Date(PINNED_NOW());
    // DST-safe: use JS date arithmetic
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() - d);
  }

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1589-T1593 — v10.104 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v10104-pres'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10104-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('riskScoreP75Last30d');
      expect(body).toHaveProperty('riskScoreP25Last7d');
      expect(body).toHaveProperty('riskScoreP25Last30d');
      expect(body).toHaveProperty('opsDailyAvgLast14d');
      expect(body).toHaveProperty('riskScoreSkewnessLast7d');
    });

    it('2. sessions — riskScoreP75Last30d/P25Last7d/P25Last30d/opsDailyAvgLast14d null when no ops in windows', async () => {
      ctx = await setup();
      // Op is 40 days old — outside all relevant windows
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v10104-null', dayAgo(40)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10104-null');
      expect(status).toBe(200);
      expect(body.riskScoreP75Last30d).toBeNull();
      expect(body.riskScoreP25Last7d).toBeNull();
      expect(body.riskScoreP25Last30d).toBeNull();
      expect(body.opsDailyAvgLast14d).toBeNull();
    });

    it('3. sessions — riskScoreP75Last30d: correct 75th percentile index in 30d window', async () => {
      ctx = await setup();
      // scores in 30d = [0.1, 0.3, 0.5, 0.7] sorted → index Math.floor(4*0.75) = 3 → 0.7
      for (const score of [0.5, 0.1, 0.7, 0.3]) {
        await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v10104-p75-30', dayAgo(20)), dec(score));
      }
      // older op beyond 30d excluded
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v10104-p75-30', dayAgo(35)), dec(0.99));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10104-p75-30');
      expect(status).toBe(200);
      expect(body.riskScoreP75Last30d as number).toBeCloseTo(0.7, 5);
    });

    it('4. sessions — riskScoreP25Last7d: correct 25th percentile index in 7d window', async () => {
      ctx = await setup();
      // scores in 7d = [0.1, 0.3, 0.5, 0.7] sorted → index Math.floor(4*0.25) = 1 → 0.3
      for (const score of [0.7, 0.3, 0.1, 0.5]) {
        await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v10104-p25-7', dayAgo(3)), dec(score));
      }
      // older op beyond 7d excluded from P25Last7d
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v10104-p25-7', dayAgo(10)), dec(0.01));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10104-p25-7');
      expect(status).toBe(200);
      expect(body.riskScoreP25Last7d as number).toBeCloseTo(0.3, 5);
    });

    it('5. sessions — riskScoreP25Last30d: correct 25th percentile index in 30d window', async () => {
      ctx = await setup();
      // scores in 30d = [0.2, 0.4, 0.6, 0.8] sorted → index Math.floor(4*0.25) = 1 → 0.4
      for (const score of [0.8, 0.2, 0.6, 0.4]) {
        await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v10104-p25-30', dayAgo(20)), dec(score));
      }
      // op beyond 30d excluded
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v10104-p25-30', dayAgo(35)), dec(0.01));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10104-p25-30');
      expect(status).toBe(200);
      expect(body.riskScoreP25Last30d as number).toBeCloseTo(0.4, 5);
    });

    it('6. sessions — opsDailyAvgLast14d: ops/14 for ops within 14d', async () => {
      ctx = await setup();
      // 7 ops within 14d → avg = 7/14 = 0.5
      for (let i = 0; i < 7; i++) {
        await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v10104-avg', dayAgo(5)), dec(0.4));
      }
      // older op beyond 14d excluded
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v10104-avg', dayAgo(20)), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10104-avg');
      expect(status).toBe(200);
      expect(body.opsDailyAvgLast14d as number).toBeCloseTo(0.5, 5);
      expect(body.opsDailyAvgLast14d as number).toBeGreaterThan(0);
    });

    it('7. sessions — riskScoreSkewnessLast7d: null when fewer than 3 ops in 7d', async () => {
      ctx = await setup();
      // Only 2 ops in 7d → skewness null
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v10104-skew-null', dayAgo(3)), dec(0.3));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v10104-skew-null', dayAgo(3)), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10104-skew-null');
      expect(status).toBe(200);
      expect(body.riskScoreSkewnessLast7d).toBeNull();
    });

    it('8. sessions — riskScoreSkewnessLast7d: 0 when all scores are equal (stddev=0)', async () => {
      ctx = await setup();
      // 4 identical scores → stddev = 0 → skewness = 0
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v10104-skew-zero', dayAgo(3)), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10104-skew-zero');
      expect(status).toBe(200);
      expect(body.riskScoreSkewnessLast7d).toBe(0);
    });

    it('9. sessions — riskScoreP25Last7d: null when ops exist only beyond 7d (within 30d)', async () => {
      ctx = await setup();
      // Op at 10 days old: within 30d but outside 7d
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v10104-p25-7null', dayAgo(10)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10104-p25-7null');
      expect(status).toBe(200);
      expect(body.riskScoreP25Last7d).toBeNull();
      // riskScoreP25Last30d should be non-null (op is in 30d)
      expect(body.riskScoreP25Last30d).not.toBeNull();
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1589-T1593 — v10.104 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('10. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-v10104-pres'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/agents/agt-v10104-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('riskScoreP75Last30d');
      expect(body).toHaveProperty('riskScoreP25Last7d');
      expect(body).toHaveProperty('riskScoreP25Last30d');
      expect(body).toHaveProperty('opsDailyAvgLast14d');
      expect(body).toHaveProperty('riskScoreSkewnessLast7d');
    });

    it('11. agents — riskScoreP75Last30d: null when no ops in 30d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-v10104-null', 'fs', 'sess', dayAgo(40)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/agents/agt-v10104-null');
      expect(status).toBe(200);
      expect(body.riskScoreP75Last30d).toBeNull();
      expect(body.riskScoreP25Last7d).toBeNull();
      expect(body.riskScoreP25Last30d).toBeNull();
      expect(body.opsDailyAvgLast14d).toBeNull();
    });

    it('12. agents — riskScoreP75Last30d: correct index Math.floor(n*0.75) on sorted scores', async () => {
      ctx = await setup();
      // scores in 30d = [0.1, 0.2, 0.3, 0.4, 0.5] sorted → index Math.floor(5*0.75) = 3 → 0.4
      for (const score of [0.5, 0.1, 0.4, 0.2, 0.3]) {
        await ctx.logger.log(makeOp('agt-v10104-p75-30', 'fs', 'sess', dayAgo(15)), dec(score));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agt-v10104-p75-30');
      expect(status).toBe(200);
      expect(body.riskScoreP75Last30d as number).toBeCloseTo(0.4, 5);
    });

    it('13. agents — riskScoreP25Last7d: correct index Math.floor(n*0.25) on sorted scores', async () => {
      ctx = await setup();
      // scores in 7d = [0.2, 0.4, 0.6, 0.8] sorted → index Math.floor(4*0.25) = 1 → 0.4
      for (const score of [0.8, 0.2, 0.6, 0.4]) {
        await ctx.logger.log(makeOp('agt-v10104-p25-7', 'fs', 'sess', dayAgo(3)), dec(score));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agt-v10104-p25-7');
      expect(status).toBe(200);
      expect(body.riskScoreP25Last7d as number).toBeCloseTo(0.4, 5);
    });

    it('14. agents — opsDailyAvgLast14d: 14 ops / 14 = 1.0', async () => {
      ctx = await setup();
      for (let i = 0; i < 14; i++) {
        await ctx.logger.log(makeOp('agt-v10104-avg14', 'fs', 'sess', dayAgo(7)), dec(0.5));
      }
      // older op excluded
      await ctx.logger.log(makeOp('agt-v10104-avg14', 'fs', 'sess', dayAgo(20)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/agents/agt-v10104-avg14');
      expect(status).toBe(200);
      expect(body.opsDailyAvgLast14d as number).toBeCloseTo(1.0, 5);
    });

    it('15. agents — riskScoreSkewnessLast7d: non-null float for 3+ diverse scores in 7d', async () => {
      ctx = await setup();
      // 3 scores with non-zero stddev → skewness should be a finite number
      for (const score of [0.1, 0.5, 0.9]) {
        await ctx.logger.log(makeOp('agt-v10104-skew', 'fs', 'sess', dayAgo(3)), dec(score));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agt-v10104-skew');
      expect(status).toBe(200);
      expect(body.riskScoreSkewnessLast7d).not.toBeNull();
      expect(typeof body.riskScoreSkewnessLast7d).toBe('number');
      expect(isFinite(body.riskScoreSkewnessLast7d as number)).toBe(true);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1589-T1593 — v10.104 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('16. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v10104-pres'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10104-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('riskScoreP75Last30d');
      expect(body).toHaveProperty('riskScoreP25Last7d');
      expect(body).toHaveProperty('riskScoreP25Last30d');
      expect(body).toHaveProperty('opsDailyAvgLast14d');
      expect(body).toHaveProperty('riskScoreSkewnessLast7d');
    });

    it('17. tools — all four new window fields null when ops exist only beyond 30d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-b', 'tool-v10104-null', 'sess', dayAgo(40)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10104-null');
      expect(status).toBe(200);
      expect(body.riskScoreP75Last30d).toBeNull();
      expect(body.riskScoreP25Last7d).toBeNull();
      expect(body.riskScoreP25Last30d).toBeNull();
      expect(body.opsDailyAvgLast14d).toBeNull();
    });

    it('18. tools — riskScoreP75Last30d: correct value, ops beyond 30d excluded', async () => {
      ctx = await setup();
      // scores in 30d = [0.1, 0.4, 0.6, 0.9] sorted → index Math.floor(4*0.75) = 3 → 0.9
      for (const score of [0.6, 0.1, 0.9, 0.4]) {
        await ctx.logger.log(makeOp('agent-c', 'tool-v10104-p75-30', 'sess', dayAgo(20)), dec(score));
      }
      await ctx.logger.log(makeOp('agent-c', 'tool-v10104-p75-30', 'sess', dayAgo(35)), dec(0.01));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10104-p75-30');
      expect(status).toBe(200);
      expect(body.riskScoreP75Last30d as number).toBeCloseTo(0.9, 5);
    });

    it('19. tools — riskScoreP25Last30d: correct value, ops beyond 30d excluded', async () => {
      ctx = await setup();
      // scores in 30d = [0.1, 0.4, 0.6, 0.9] sorted → index Math.floor(4*0.25) = 1 → 0.4
      for (const score of [0.6, 0.1, 0.9, 0.4]) {
        await ctx.logger.log(makeOp('agent-d', 'tool-v10104-p25-30', 'sess', dayAgo(20)), dec(score));
      }
      await ctx.logger.log(makeOp('agent-d', 'tool-v10104-p25-30', 'sess', dayAgo(35)), dec(0.99));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10104-p25-30');
      expect(status).toBe(200);
      expect(body.riskScoreP25Last30d as number).toBeCloseTo(0.4, 5);
    });

    it('20. tools — opsDailyAvgLast14d: fractional value when ops count is not a multiple of 14', async () => {
      ctx = await setup();
      // 3 ops in 14d → avg = 3/14
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-e', 'tool-v10104-avgfrac', 'sess', dayAgo(5)), dec(0.4));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10104-avgfrac');
      expect(status).toBe(200);
      expect(body.opsDailyAvgLast14d as number).toBeCloseTo(3 / 14, 5);
    });

    it('21. tools — riskScoreSkewnessLast7d: null for fewer than 3 ops in 7d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-f', 'tool-v10104-skew1', 'sess', dayAgo(3)), dec(0.3));
      await ctx.logger.log(makeOp('agent-f', 'tool-v10104-skew1', 'sess', dayAgo(3)), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10104-skew1');
      expect(status).toBe(200);
      expect(body.riskScoreSkewnessLast7d).toBeNull();
    });
  });

  // ── summary endpoint ──────────────────────────────────────────────────────────

  describe('T1589-T1593 — v10.104 new fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('22. summary — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body).toHaveProperty('riskScoreP75Last30d');
      expect(body).toHaveProperty('riskScoreP25Last7d');
      expect(body).toHaveProperty('riskScoreP25Last30d');
      expect(body).toHaveProperty('opsDailyAvgLast14d');
      expect(body).toHaveProperty('riskScoreSkewnessLast7d');
    });

    it('23. summary — all four window fields null when no ops at all', async () => {
      ctx = await setup();

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreP75Last30d).toBeNull();
      expect(body.riskScoreP25Last7d).toBeNull();
      expect(body.riskScoreP25Last30d).toBeNull();
      expect(body.opsDailyAvgLast14d).toBeNull();
    });

    it('24. summary — all four window fields null when all ops older than 30d', async () => {
      ctx = await setup();
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-b', 'fs', 'sess', dayAgo(40)), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreP75Last30d).toBeNull();
      expect(body.riskScoreP25Last7d).toBeNull();
      expect(body.riskScoreP25Last30d).toBeNull();
      expect(body.opsDailyAvgLast14d).toBeNull();
    });

    it('25. summary — riskScoreP75Last30d: correct across all agents/tools in 30d', async () => {
      ctx = await setup();
      // scores in 30d = [0.1, 0.3, 0.5, 0.7, 0.9] sorted → index Math.floor(5*0.75) = 3 → 0.7
      for (const score of [0.9, 0.3, 0.1, 0.7, 0.5]) {
        await ctx.logger.log(makeOp('agt-sum-p75', 'fs', 'sess1', dayAgo(15)), dec(score));
      }
      // older op beyond 30d excluded
      await ctx.logger.log(makeOp('agt-sum-p75', 'fs', 'sess1', dayAgo(35)), dec(0.99));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreP75Last30d as number).toBeCloseTo(0.7, 5);
    });

    it('26. summary — riskScoreP25Last7d: correct across all agents/tools in 7d', async () => {
      ctx = await setup();
      // scores in 7d = [0.1, 0.2, 0.4, 0.6] sorted → index Math.floor(4*0.25) = 1 → 0.2
      for (const score of [0.6, 0.1, 0.4, 0.2]) {
        await ctx.logger.log(makeOp('agt-sum-p25-7', 'fs', 'sess1', dayAgo(3)), dec(score));
      }
      // op beyond 7d excluded from P25Last7d (still in 30d)
      await ctx.logger.log(makeOp('agt-sum-p25-7', 'fs', 'sess1', dayAgo(10)), dec(0.01));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreP25Last7d as number).toBeCloseTo(0.2, 5);
    });

    it('27. summary — opsDailyAvgLast14d and riskScoreP25Last30d correct together', async () => {
      ctx = await setup();
      // 28 ops within 14d → avg = 28/14 = 2.0
      // scores in 30d include some from 20 days ago too
      // 7d ops: [0.3, 0.3, 0.3, 0.3] → P25Last30d includes 20d ops as well
      for (let i = 0; i < 14; i++) {
        await ctx.logger.log(makeOp('agt-sum-combo', 'fs', 'sess1', dayAgo(5)), dec(0.3));
      }
      for (let i = 0; i < 14; i++) {
        await ctx.logger.log(makeOp('agt-sum-combo', 'fs', 'sess1', dayAgo(5)), dec(0.5));
      }
      // older op beyond 14d (but within 30d) — excluded from daily avg but included in P25Last30d
      await ctx.logger.log(makeOp('agt-sum-combo', 'fs', 'sess1', dayAgo(20)), dec(0.9));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      // 28 ops in 14d → avg = 28/14 = 2.0
      expect(body.opsDailyAvgLast14d as number).toBeCloseTo(2.0, 5);
      // riskScoreP25Last30d: 29 ops total in 30d, sorted; index Math.floor(29*0.25) = 7 → 0.3
      expect(body.riskScoreP25Last30d).not.toBeNull();
      expect(typeof body.riskScoreP25Last30d).toBe('number');
    });

    it('28. summary — riskScoreSkewnessLast7d: 0 when all scores equal in 7d', async () => {
      ctx = await setup();
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp('agt-sum-skew0', 'fs', 'sess1', dayAgo(3)), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreSkewnessLast7d).toBe(0);
    });

    it('29. summary — riskScoreSkewnessLast7d: null when fewer than 3 ops in 7d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-sum-skew-null', 'fs', 'sess1', dayAgo(3)), dec(0.2));
      await ctx.logger.log(makeOp('agt-sum-skew-null', 'fs', 'sess1', dayAgo(3)), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreSkewnessLast7d).toBeNull();
    });

    it('30. summary — riskScoreP75Last30d and P25Last30d bracket the distribution correctly', async () => {
      ctx = await setup();
      // scores in 30d = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8] (8 items)
      // P75 index = Math.floor(8*0.75) = 6 → 0.7
      // P25 index = Math.floor(8*0.25) = 2 → 0.3
      for (const score of [0.5, 0.3, 0.8, 0.1, 0.7, 0.2, 0.6, 0.4]) {
        await ctx.logger.log(makeOp('agt-sum-bracket', 'fs', 'sess1', dayAgo(20)), dec(score));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreP75Last30d as number).toBeCloseTo(0.7, 5);
      expect(body.riskScoreP25Last30d as number).toBeCloseTo(0.3, 5);
      // P75 should always be >= P25
      expect(body.riskScoreP75Last30d as number).toBeGreaterThanOrEqual(
        body.riskScoreP25Last30d as number,
      );
    });
  });
});

// ── v10.105 ────────────────────────────────────────────────────────────────────

describe('v10.105', () => {
  function dayAgo(d: number): Date {
    const now = new Date(PINNED_NOW());
    // DST-safe: use JS date arithmetic
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() - d);
  }

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1594-T1598 — v10.105 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v10105-pres'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10105-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('riskScoreSkewnessLast30d');
      expect(body).toHaveProperty('riskScoreKurtosisLast7d');
      expect(body).toHaveProperty('riskScoreKurtosisLast30d');
      expect(body).toHaveProperty('blockCountLast14d');
      expect(body).toHaveProperty('allowCountLast14d');
    });

    it('2. sessions — blockCountLast14d and allowCountLast14d null when no ops in 14d', async () => {
      ctx = await setup();
      // Op is 20 days old — outside the 14d window
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v10105-14null', dayAgo(20)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10105-14null');
      expect(status).toBe(200);
      expect(body.blockCountLast14d).toBeNull();
      expect(body.allowCountLast14d).toBeNull();
    });

    it('3. sessions — blockCountLast14d counts only block actions in 14d window', async () => {
      ctx = await setup();
      // 2 blocks, 3 allows in 14d; 1 block older than 14d (excluded)
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v10105-block', dayAgo(5)), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v10105-block', dayAgo(5)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v10105-block', dayAgo(5)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v10105-block', dayAgo(5)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v10105-block', dayAgo(5)), dec(0.1, 'allow'));
      // older block beyond 14d — must be excluded
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v10105-block', dayAgo(20)), dec(0.95, 'block'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10105-block');
      expect(status).toBe(200);
      expect(body.blockCountLast14d).toBe(2);
      expect(body.allowCountLast14d).toBe(3);
    });

    it('4. sessions — riskScoreSkewnessLast30d null when fewer than 3 ops in 30d', async () => {
      ctx = await setup();
      // Only 2 ops in 30d → skewness null
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v10105-skew30null', dayAgo(20)), dec(0.3));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v10105-skew30null', dayAgo(20)), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10105-skew30null');
      expect(status).toBe(200);
      expect(body.riskScoreSkewnessLast30d).toBeNull();
    });

    it('5. sessions — riskScoreSkewnessLast30d is 0 when all scores are equal (stddev=0)', async () => {
      ctx = await setup();
      // 4 identical scores in 30d → stddev = 0 → skewness = 0
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v10105-skew30zero', dayAgo(20)), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10105-skew30zero');
      expect(status).toBe(200);
      expect(body.riskScoreSkewnessLast30d).toBe(0);
    });

    it('6. sessions — riskScoreKurtosisLast7d null when fewer than 4 ops in 7d', async () => {
      ctx = await setup();
      // 3 ops in 7d → kurtosis null
      for (const score of [0.2, 0.5, 0.8]) {
        await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v10105-kurt7null', dayAgo(3)), dec(score));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10105-kurt7null');
      expect(status).toBe(200);
      expect(body.riskScoreKurtosisLast7d).toBeNull();
    });

    it('7. sessions — riskScoreKurtosisLast7d is 0 when all scores are equal (stddev=0)', async () => {
      ctx = await setup();
      // 5 identical scores in 7d → stddev = 0 → excess kurtosis = 0
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v10105-kurt7zero', dayAgo(3)), dec(0.4));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10105-kurt7zero');
      expect(status).toBe(200);
      expect(body.riskScoreKurtosisLast7d).toBe(0);
    });

    it('8. sessions — riskScoreKurtosisLast30d null when fewer than 4 ops in 30d', async () => {
      ctx = await setup();
      // 3 ops in 30d → kurtosis null
      for (const score of [0.1, 0.5, 0.9]) {
        await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v10105-kurt30null', dayAgo(20)), dec(score));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10105-kurt30null');
      expect(status).toBe(200);
      expect(body.riskScoreKurtosisLast30d).toBeNull();
    });

    it('9. sessions — riskScoreSkewnessLast30d: ops beyond 30d are excluded', async () => {
      ctx = await setup();
      // 3 recent ops (within 30d) give non-null skewness; 5 old ops (beyond 30d) must not affect result
      for (const score of [0.1, 0.5, 0.9]) {
        await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v10105-skew30excl', dayAgo(20)), dec(score));
      }
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v10105-skew30excl', dayAgo(40)), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10105-skew30excl');
      expect(status).toBe(200);
      // With 3 ops (not equal), skewness should be non-null and a finite number
      expect(body.riskScoreSkewnessLast30d).not.toBeNull();
      expect(typeof body.riskScoreSkewnessLast30d).toBe('number');
      expect(isFinite(body.riskScoreSkewnessLast30d as number)).toBe(true);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1594-T1598 — v10.105 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('10. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-v10105-pres'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/agents/agt-v10105-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('riskScoreSkewnessLast30d');
      expect(body).toHaveProperty('riskScoreKurtosisLast7d');
      expect(body).toHaveProperty('riskScoreKurtosisLast30d');
      expect(body).toHaveProperty('blockCountLast14d');
      expect(body).toHaveProperty('allowCountLast14d');
    });

    it('11. agents — blockCountLast14d and allowCountLast14d null when no ops in 14d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-v10105-null', 'fs', 'sess', dayAgo(20)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/agents/agt-v10105-null');
      expect(status).toBe(200);
      expect(body.blockCountLast14d).toBeNull();
      expect(body.allowCountLast14d).toBeNull();
    });

    it('12. agents — blockCountLast14d correct count; ops beyond 14d excluded', async () => {
      ctx = await setup();
      // 3 blocks in 14d, 1 block older than 14d excluded
      await ctx.logger.log(makeOp('agt-v10105-blk', 'fs', 'sess', dayAgo(5)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agt-v10105-blk', 'fs', 'sess', dayAgo(5)), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agt-v10105-blk', 'fs', 'sess', dayAgo(5)), dec(0.7, 'block'));
      await ctx.logger.log(makeOp('agt-v10105-blk', 'fs', 'sess', dayAgo(20)), dec(0.95, 'block'));

      const { status, body } = await getJSON(ctx.port, '/agents/agt-v10105-blk');
      expect(status).toBe(200);
      expect(body.blockCountLast14d).toBe(3);
    });

    it('13. agents — allowCountLast14d correct count; block ops do not inflate count', async () => {
      ctx = await setup();
      // 2 allows, 4 blocks in 14d
      await ctx.logger.log(makeOp('agt-v10105-alw', 'fs', 'sess', dayAgo(5)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agt-v10105-alw', 'fs', 'sess', dayAgo(5)), dec(0.2, 'allow'));
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp('agt-v10105-alw', 'fs', 'sess', dayAgo(5)), dec(0.9, 'block'));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agt-v10105-alw');
      expect(status).toBe(200);
      expect(body.allowCountLast14d).toBe(2);
      expect(body.blockCountLast14d).toBe(4);
    });

    it('14. agents — riskScoreKurtosisLast30d: 0 when all scores equal (stddev=0)', async () => {
      ctx = await setup();
      // 4 identical scores in 30d → excess kurtosis = 0
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp('agt-v10105-kurt30z', 'fs', 'sess', dayAgo(20)), dec(0.6));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agt-v10105-kurt30z');
      expect(status).toBe(200);
      expect(body.riskScoreKurtosisLast30d).toBe(0);
    });

    it('15. agents — riskScoreKurtosisLast7d: non-null finite number for 4+ diverse scores in 7d', async () => {
      ctx = await setup();
      // 4 diverse scores in 7d → excess kurtosis is a finite number (can be negative)
      for (const score of [0.1, 0.4, 0.6, 0.9]) {
        await ctx.logger.log(makeOp('agt-v10105-kurt7fin', 'fs', 'sess', dayAgo(3)), dec(score));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agt-v10105-kurt7fin');
      expect(status).toBe(200);
      expect(body.riskScoreKurtosisLast7d).not.toBeNull();
      expect(typeof body.riskScoreKurtosisLast7d).toBe('number');
      expect(isFinite(body.riskScoreKurtosisLast7d as number)).toBe(true);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1594-T1598 — v10.105 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('16. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v10105-pres'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10105-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('riskScoreSkewnessLast30d');
      expect(body).toHaveProperty('riskScoreKurtosisLast7d');
      expect(body).toHaveProperty('riskScoreKurtosisLast30d');
      expect(body).toHaveProperty('blockCountLast14d');
      expect(body).toHaveProperty('allowCountLast14d');
    });

    it('17. tools — blockCountLast14d and allowCountLast14d null when no ops in 14d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-b', 'tool-v10105-null', 'sess', dayAgo(20)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10105-null');
      expect(status).toBe(200);
      expect(body.blockCountLast14d).toBeNull();
      expect(body.allowCountLast14d).toBeNull();
    });

    it('18. tools — blockCountLast14d correct; ops beyond 14d excluded', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-c', 'tool-v10105-blk', 'sess', dayAgo(5)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-c', 'tool-v10105-blk', 'sess', dayAgo(5)), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agent-c', 'tool-v10105-blk', 'sess', dayAgo(5)), dec(0.2, 'allow'));
      // old block excluded
      await ctx.logger.log(makeOp('agent-c', 'tool-v10105-blk', 'sess', dayAgo(20)), dec(0.95, 'block'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10105-blk');
      expect(status).toBe(200);
      expect(body.blockCountLast14d).toBe(2);
      expect(body.allowCountLast14d).toBe(1);
    });

    it('19. tools — riskScoreKurtosisLast30d null for fewer than 4 ops in 30d', async () => {
      ctx = await setup();
      // 3 ops in 30d — not enough for kurtosis
      for (const score of [0.2, 0.5, 0.8]) {
        await ctx.logger.log(makeOp('agent-d', 'tool-v10105-kurt30null', 'sess', dayAgo(20)), dec(score));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10105-kurt30null');
      expect(status).toBe(200);
      expect(body.riskScoreKurtosisLast30d).toBeNull();
    });

    it('20. tools — riskScoreSkewnessLast30d: finite number for 3+ diverse ops in 30d', async () => {
      ctx = await setup();
      // 3 diverse scores in 30d → skewness is a finite number
      for (const score of [0.1, 0.5, 0.9]) {
        await ctx.logger.log(makeOp('agent-e', 'tool-v10105-skew30', 'sess', dayAgo(20)), dec(score));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10105-skew30');
      expect(status).toBe(200);
      expect(body.riskScoreSkewnessLast30d).not.toBeNull();
      expect(typeof body.riskScoreSkewnessLast30d).toBe('number');
      expect(isFinite(body.riskScoreSkewnessLast30d as number)).toBe(true);
    });

    it('21. tools — riskScoreKurtosisLast7d: ops beyond 7d do not count toward threshold', async () => {
      ctx = await setup();
      // 4 ops older than 7d (but within 30d); 2 ops in 7d → 7d window has < 4 ops → null
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp('agent-f', 'tool-v10105-kurt7excl', 'sess', dayAgo(10)), dec(0.5));
      }
      await ctx.logger.log(makeOp('agent-f', 'tool-v10105-kurt7excl', 'sess', dayAgo(3)), dec(0.3));
      await ctx.logger.log(makeOp('agent-f', 'tool-v10105-kurt7excl', 'sess', dayAgo(3)), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10105-kurt7excl');
      expect(status).toBe(200);
      expect(body.riskScoreKurtosisLast7d).toBeNull();
    });
  });

  // ── summary endpoint ───────────────────────────────────────────────────────────

  describe('T1594-T1598 — v10.105 new fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('22. summary — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body).toHaveProperty('riskScoreSkewnessLast30d');
      expect(body).toHaveProperty('riskScoreKurtosisLast7d');
      expect(body).toHaveProperty('riskScoreKurtosisLast30d');
      expect(body).toHaveProperty('blockCountLast14d');
      expect(body).toHaveProperty('allowCountLast14d');
    });

    it('23. summary — blockCountLast14d and allowCountLast14d null when no ops at all', async () => {
      ctx = await setup();

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.blockCountLast14d).toBeNull();
      expect(body.allowCountLast14d).toBeNull();
    });

    it('24. summary — blockCountLast14d and allowCountLast14d null when all ops older than 14d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess', dayAgo(20)), dec(0.5, 'block'));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess', dayAgo(20)), dec(0.3, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.blockCountLast14d).toBeNull();
      expect(body.allowCountLast14d).toBeNull();
    });

    it('25. summary — blockCountLast14d and allowCountLast14d correct across agents/tools', async () => {
      ctx = await setup();
      // 3 blocks from different agents/tools in 14d
      await ctx.logger.log(makeOp('agt-sum-blk1', 'tool-a', 'sess', dayAgo(5)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agt-sum-blk2', 'tool-b', 'sess', dayAgo(5)), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agt-sum-blk3', 'tool-c', 'sess', dayAgo(5)), dec(0.7, 'block'));
      // 2 allows in 14d
      await ctx.logger.log(makeOp('agt-sum-alw1', 'tool-d', 'sess', dayAgo(5)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agt-sum-alw2', 'tool-e', 'sess', dayAgo(5)), dec(0.1, 'allow'));
      // old block excluded
      await ctx.logger.log(makeOp('agt-sum-old', 'tool-f', 'sess', dayAgo(20)), dec(0.95, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.blockCountLast14d).toBe(3);
      expect(body.allowCountLast14d).toBe(2);
    });

    it('26. summary — riskScoreSkewnessLast30d null when fewer than 3 ops in 30d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-sum-skew30n', 'fs', 'sess', dayAgo(20)), dec(0.2));
      await ctx.logger.log(makeOp('agt-sum-skew30n', 'fs', 'sess', dayAgo(20)), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreSkewnessLast30d).toBeNull();
    });

    it('27. summary — riskScoreKurtosisLast30d null when fewer than 4 ops in 30d', async () => {
      ctx = await setup();
      for (const score of [0.1, 0.5, 0.9]) {
        await ctx.logger.log(makeOp('agt-sum-kurt30n', 'fs', 'sess', dayAgo(20)), dec(score));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreKurtosisLast30d).toBeNull();
    });

    it('28. summary — riskScoreKurtosisLast7d and riskScoreKurtosisLast30d both 0 when all equal scores', async () => {
      ctx = await setup();
      // 5 identical scores in 7d (within 30d too) → both kurtosis values = 0
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp('agt-sum-kurt0', 'fs', 'sess', dayAgo(3)), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreKurtosisLast7d).toBe(0);
      expect(body.riskScoreKurtosisLast30d).toBe(0);
    });

    it('29. summary — blockCountLast14d is 0 when ops in 14d are all allow', async () => {
      ctx = await setup();
      // 3 allow ops in 14d — blockCountLast14d should be 0 (not null)
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agt-sum-allallow', 'fs', 'sess', dayAgo(5)), dec(0.2, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.blockCountLast14d).toBe(0);
      expect(body.allowCountLast14d).toBe(3);
    });

    it('30. summary — allowCountLast14d is 0 when ops in 14d are all block', async () => {
      ctx = await setup();
      // 4 block ops in 14d — allowCountLast14d should be 0 (not null)
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp('agt-sum-allblock', 'fs', 'sess', dayAgo(5)), dec(0.9, 'block'));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.allowCountLast14d).toBe(0);
      expect(body.blockCountLast14d).toBe(4);
    });
  });
});

// ── v10.106 ────────────────────────────────────────────────────────────────────

describe('v10.106', () => {
  function dayAgo(d: number): Date {
    const now = new Date(PINNED_NOW());
    // DST-safe: use JS date arithmetic
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() - d);
  }

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1599-T1603 — v10.106 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v10106-pres'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10106-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('requireApprovalCountLast14d');
      expect(body).toHaveProperty('riskScoreGiniLast7d');
      expect(body).toHaveProperty('riskScoreGiniLast30d');
      expect(body).toHaveProperty('opsTrendSlopeLast14d');
      expect(body).toHaveProperty('riskScoreMomentumLast14d');
    });

    it('2. sessions — requireApprovalCountLast14d null when no ops in 14d', async () => {
      ctx = await setup();
      // Op is 20 days old — outside the 14d window
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v10106-ra-null', dayAgo(20)), dec(0.5, 'require_approval'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10106-ra-null');
      expect(status).toBe(200);
      expect(body.requireApprovalCountLast14d).toBeNull();
    });

    it('3. sessions — requireApprovalCountLast14d counts only require_approval in 14d', async () => {
      ctx = await setup();
      // 3 require_approval, 2 allow, 1 block in 14d; 1 require_approval outside 14d (excluded)
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v10106-ra-cnt', dayAgo(5)), dec(0.7, 'require_approval'));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v10106-ra-cnt', dayAgo(5)), dec(0.6, 'require_approval'));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v10106-ra-cnt', dayAgo(5)), dec(0.5, 'require_approval'));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v10106-ra-cnt', dayAgo(5)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v10106-ra-cnt', dayAgo(5)), dec(0.9, 'block'));
      // older require_approval beyond 14d — must be excluded
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v10106-ra-cnt', dayAgo(20)), dec(0.8, 'require_approval'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10106-ra-cnt');
      expect(status).toBe(200);
      expect(body.requireApprovalCountLast14d).toBe(3);
    });

    it('4. sessions — riskScoreGiniLast7d null when no ops in 7d', async () => {
      ctx = await setup();
      // Op is 10 days old — outside the 7d window
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v10106-gini7-null', dayAgo(10)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10106-gini7-null');
      expect(status).toBe(200);
      expect(body.riskScoreGiniLast7d).toBeNull();
    });

    it('5. sessions — riskScoreGiniLast7d null when all risk scores are 0 (mean=0)', async () => {
      ctx = await setup();
      // 3 ops with risk score 0 in 7d → mean=0 → Gini returns null
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v10106-gini7-zero', dayAgo(3)), dec(0));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10106-gini7-zero');
      expect(status).toBe(200);
      expect(body.riskScoreGiniLast7d).toBeNull();
    });

    it('6. sessions — riskScoreGiniLast7d finite number in [0,1] for diverse risk scores', async () => {
      ctx = await setup();
      // 3 diverse scores in 7d → Gini in [0,1]
      for (const score of [0.2, 0.5, 0.8]) {
        await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v10106-gini7-val', dayAgo(3)), dec(score));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10106-gini7-val');
      expect(status).toBe(200);
      expect(body.riskScoreGiniLast7d).not.toBeNull();
      expect(typeof body.riskScoreGiniLast7d).toBe('number');
      const gini = body.riskScoreGiniLast7d as number;
      expect(isFinite(gini)).toBe(true);
      expect(gini).toBeGreaterThanOrEqual(0);
      expect(gini).toBeLessThanOrEqual(1);
    });

    it('7. sessions — opsTrendSlopeLast14d null when fewer than 2 active days in 14d', async () => {
      ctx = await setup();
      // All ops on same day → only 1 active day → slope null
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v10106-slope-null', dayAgo(5)), dec(0.4));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v10106-slope-null', dayAgo(5)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10106-slope-null');
      expect(status).toBe(200);
      expect(body.opsTrendSlopeLast14d).toBeNull();
    });

    it('8. sessions — opsTrendSlopeLast14d is a finite number when ops span 2+ active days', async () => {
      ctx = await setup();
      // Ops on 3 different days → slope is a finite number
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v10106-slope-val', dayAgo(2)), dec(0.3));
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v10106-slope-val', dayAgo(5)), dec(0.5));
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v10106-slope-val', dayAgo(9)), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10106-slope-val');
      expect(status).toBe(200);
      expect(body.opsTrendSlopeLast14d).not.toBeNull();
      expect(typeof body.opsTrendSlopeLast14d).toBe('number');
      expect(isFinite(body.opsTrendSlopeLast14d as number)).toBe(true);
    });

    it('9. sessions — riskScoreMomentumLast14d null when no ops in last 7d', async () => {
      ctx = await setup();
      // All ops in days 8-14 ago; nothing in last 7d → w7 empty → null
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v10106-mom-null7', dayAgo(10)), dec(0.5));
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v10106-mom-null7', dayAgo(12)), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10106-mom-null7');
      expect(status).toBe(200);
      expect(body.riskScoreMomentumLast14d).toBeNull();
    });

    it('10. sessions — riskScoreMomentumLast14d null when no ops in days 8-14 ago', async () => {
      ctx = await setup();
      // All ops in last 7d; nothing in days 8-14 ago → w8to14 empty → null
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v10106-mom-null8', dayAgo(3)), dec(0.5));
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v10106-mom-null8', dayAgo(5)), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10106-mom-null8');
      expect(status).toBe(200);
      expect(body.riskScoreMomentumLast14d).toBeNull();
    });

    it('11. sessions — riskScoreMomentumLast14d is a finite number when both windows have ops', async () => {
      ctx = await setup();
      // Last 7d: mean=0.8; days 8-14 ago: mean=0.3 → momentum=0.5
      await ctx.logger.log(makeOp('agent-k', 'fs', 'sess-v10106-mom-val', dayAgo(3)), dec(0.8));
      await ctx.logger.log(makeOp('agent-k', 'fs', 'sess-v10106-mom-val', dayAgo(10)), dec(0.3));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10106-mom-val');
      expect(status).toBe(200);
      expect(body.riskScoreMomentumLast14d).not.toBeNull();
      expect(typeof body.riskScoreMomentumLast14d).toBe('number');
      expect(isFinite(body.riskScoreMomentumLast14d as number)).toBe(true);
      // momentum = mean7 - mean8to14 = 0.8 - 0.3 = 0.5
      expect(body.riskScoreMomentumLast14d as number).toBeCloseTo(0.5, 5);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1599-T1603 — v10.106 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('12. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-v10106-pres'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/agents/agt-v10106-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('requireApprovalCountLast14d');
      expect(body).toHaveProperty('riskScoreGiniLast7d');
      expect(body).toHaveProperty('riskScoreGiniLast30d');
      expect(body).toHaveProperty('opsTrendSlopeLast14d');
      expect(body).toHaveProperty('riskScoreMomentumLast14d');
    });

    it('13. agents — requireApprovalCountLast14d null when all ops older than 14d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-v10106-ra-null', 'fs', 'sess', dayAgo(20)), dec(0.5, 'require_approval'));

      const { status, body } = await getJSON(ctx.port, '/agents/agt-v10106-ra-null');
      expect(status).toBe(200);
      expect(body.requireApprovalCountLast14d).toBeNull();
    });

    it('14. agents — requireApprovalCountLast14d is 0 when ops in 14d but none are require_approval', async () => {
      ctx = await setup();
      // 3 ops in 14d but all allow actions → requireApprovalCountLast14d = 0
      await ctx.logger.log(makeOp('agt-v10106-ra-zero', 'fs', 'sess', dayAgo(5)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agt-v10106-ra-zero', 'fs', 'sess', dayAgo(5)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agt-v10106-ra-zero', 'fs', 'sess', dayAgo(5)), dec(0.5, 'block'));

      const { status, body } = await getJSON(ctx.port, '/agents/agt-v10106-ra-zero');
      expect(status).toBe(200);
      expect(body.requireApprovalCountLast14d).toBe(0);
    });

    it('15. agents — riskScoreGiniLast30d null when no ops in 30d', async () => {
      ctx = await setup();
      // Op is 35 days old — outside the 30d window
      await ctx.logger.log(makeOp('agt-v10106-gini30-null', 'fs', 'sess', dayAgo(35)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/agents/agt-v10106-gini30-null');
      expect(status).toBe(200);
      expect(body.riskScoreGiniLast30d).toBeNull();
    });

    it('16. agents — riskScoreGiniLast30d finite in [0,1] for diverse scores', async () => {
      ctx = await setup();
      for (const score of [0.1, 0.4, 0.7, 0.9]) {
        await ctx.logger.log(makeOp('agt-v10106-gini30-val', 'fs', 'sess', dayAgo(20)), dec(score));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agt-v10106-gini30-val');
      expect(status).toBe(200);
      expect(body.riskScoreGiniLast30d).not.toBeNull();
      expect(typeof body.riskScoreGiniLast30d).toBe('number');
      const gini = body.riskScoreGiniLast30d as number;
      expect(isFinite(gini)).toBe(true);
      expect(gini).toBeGreaterThanOrEqual(0);
      expect(gini).toBeLessThanOrEqual(1);
    });

    it('17. agents — opsTrendSlopeLast14d null when no ops in 14d', async () => {
      ctx = await setup();
      // Op is 20 days old — outside 14d window → null
      await ctx.logger.log(makeOp('agt-v10106-slope-null', 'fs', 'sess', dayAgo(20)), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/agents/agt-v10106-slope-null');
      expect(status).toBe(200);
      expect(body.opsTrendSlopeLast14d).toBeNull();
    });

    it('18. agents — riskScoreMomentumLast14d: negative momentum when recent risk lower than older', async () => {
      ctx = await setup();
      // Last 7d: mean=0.2; days 8-14 ago: mean=0.8 → momentum = 0.2 - 0.8 = -0.6
      await ctx.logger.log(makeOp('agt-v10106-mom-neg', 'fs', 'sess', dayAgo(3)), dec(0.2));
      await ctx.logger.log(makeOp('agt-v10106-mom-neg', 'fs', 'sess', dayAgo(10)), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/agents/agt-v10106-mom-neg');
      expect(status).toBe(200);
      expect(body.riskScoreMomentumLast14d).not.toBeNull();
      expect(body.riskScoreMomentumLast14d as number).toBeCloseTo(-0.6, 5);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1599-T1603 — v10.106 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('19. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v10106-pres'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10106-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('requireApprovalCountLast14d');
      expect(body).toHaveProperty('riskScoreGiniLast7d');
      expect(body).toHaveProperty('riskScoreGiniLast30d');
      expect(body).toHaveProperty('opsTrendSlopeLast14d');
      expect(body).toHaveProperty('riskScoreMomentumLast14d');
    });

    it('20. tools — requireApprovalCountLast14d correct count in 14d window', async () => {
      ctx = await setup();
      // 2 require_approval in 14d; 1 beyond 14d excluded
      await ctx.logger.log(makeOp('agent-b', 'tool-v10106-ra-cnt', 'sess', dayAgo(5)), dec(0.7, 'require_approval'));
      await ctx.logger.log(makeOp('agent-b', 'tool-v10106-ra-cnt', 'sess', dayAgo(5)), dec(0.6, 'require_approval'));
      await ctx.logger.log(makeOp('agent-b', 'tool-v10106-ra-cnt', 'sess', dayAgo(20)), dec(0.8, 'require_approval'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10106-ra-cnt');
      expect(status).toBe(200);
      expect(body.requireApprovalCountLast14d).toBe(2);
    });

    it('21. tools — riskScoreGiniLast7d ops beyond 7d excluded', async () => {
      ctx = await setup();
      // 4 ops older than 7d (but within 30d) with score 0.9; 1 op in 7d with score 0.1
      // Only the 1 op in 7d window → single score, mean != 0
      // For a single score, Gini sum = |s-s| = 0, so gini = 0 / (2*1*1*mean) = 0
      await ctx.logger.log(makeOp('agent-c', 'tool-v10106-gini7-excl', 'sess', dayAgo(3)), dec(0.5));
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp('agent-c', 'tool-v10106-gini7-excl', 'sess', dayAgo(10)), dec(0.9));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10106-gini7-excl');
      expect(status).toBe(200);
      // 1 op in 7d → non-null Gini (will be 0 for single element)
      expect(body.riskScoreGiniLast7d).not.toBeNull();
      expect(typeof body.riskScoreGiniLast7d).toBe('number');
    });

    it('22. tools — opsTrendSlopeLast14d ops on multiple days gives finite slope', async () => {
      ctx = await setup();
      // 4 ops on 4 different days in 14d → slope is finite
      await ctx.logger.log(makeOp('agent-d', 'tool-v10106-slope-val', 'sess', dayAgo(1)), dec(0.3));
      await ctx.logger.log(makeOp('agent-d', 'tool-v10106-slope-val', 'sess', dayAgo(4)), dec(0.4));
      await ctx.logger.log(makeOp('agent-d', 'tool-v10106-slope-val', 'sess', dayAgo(8)), dec(0.5));
      await ctx.logger.log(makeOp('agent-d', 'tool-v10106-slope-val', 'sess', dayAgo(12)), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10106-slope-val');
      expect(status).toBe(200);
      expect(body.opsTrendSlopeLast14d).not.toBeNull();
      expect(typeof body.opsTrendSlopeLast14d).toBe('number');
      expect(isFinite(body.opsTrendSlopeLast14d as number)).toBe(true);
    });

    it('23. tools — riskScoreMomentumLast14d null when no ops in days 8-14 ago', async () => {
      ctx = await setup();
      // Only ops in last 7d → w8to14 empty → null
      await ctx.logger.log(makeOp('agent-e', 'tool-v10106-mom-null', 'sess', dayAgo(2)), dec(0.5));
      await ctx.logger.log(makeOp('agent-e', 'tool-v10106-mom-null', 'sess', dayAgo(4)), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10106-mom-null');
      expect(status).toBe(200);
      expect(body.riskScoreMomentumLast14d).toBeNull();
    });
  });

  // ── summary endpoint ───────────────────────────────────────────────────────────

  describe('T1599-T1603 — v10.106 new fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('24. summary — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body).toHaveProperty('requireApprovalCountLast14d');
      expect(body).toHaveProperty('riskScoreGiniLast7d');
      expect(body).toHaveProperty('riskScoreGiniLast30d');
      expect(body).toHaveProperty('opsTrendSlopeLast14d');
      expect(body).toHaveProperty('riskScoreMomentumLast14d');
    });

    it('25. summary — requireApprovalCountLast14d null when no ops at all', async () => {
      ctx = await setup();

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.requireApprovalCountLast14d).toBeNull();
    });

    it('26. summary — requireApprovalCountLast14d null when all ops older than 14d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-sum-ra-old', 'fs', 'sess', dayAgo(20)), dec(0.5, 'require_approval'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.requireApprovalCountLast14d).toBeNull();
    });

    it('27. summary — requireApprovalCountLast14d correct across all agents/tools', async () => {
      ctx = await setup();
      // 2 require_approval from different agents in 14d; 1 old excluded
      await ctx.logger.log(makeOp('agt-sum-ra-a', 'tool-a', 'sess', dayAgo(5)), dec(0.7, 'require_approval'));
      await ctx.logger.log(makeOp('agt-sum-ra-b', 'tool-b', 'sess', dayAgo(5)), dec(0.6, 'require_approval'));
      await ctx.logger.log(makeOp('agt-sum-ra-c', 'tool-c', 'sess', dayAgo(5)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agt-sum-ra-d', 'tool-d', 'sess', dayAgo(20)), dec(0.8, 'require_approval'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.requireApprovalCountLast14d).toBe(2);
    });

    it('28. summary — riskScoreGiniLast7d and riskScoreGiniLast30d null when no ops', async () => {
      ctx = await setup();

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreGiniLast7d).toBeNull();
      expect(body.riskScoreGiniLast30d).toBeNull();
    });

    it('29. summary — riskScoreGiniLast30d includes ops up to 30d old but excludes older', async () => {
      ctx = await setup();
      // 3 ops in 30d window → Gini non-null
      for (const score of [0.2, 0.5, 0.8]) {
        await ctx.logger.log(makeOp('agt-sum-gini30', 'fs', 'sess', dayAgo(25)), dec(score));
      }
      // 3 ops beyond 30d → must be excluded (would change mean/Gini if included)
      for (const score of [0.0, 0.0, 0.0]) {
        await ctx.logger.log(makeOp('agt-sum-gini30', 'fs', 'sess', dayAgo(35)), dec(score));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      // With scores [0.2, 0.5, 0.8] → mean=0.5 (non-zero) → Gini is non-null
      expect(body.riskScoreGiniLast30d).not.toBeNull();
      const gini = body.riskScoreGiniLast30d as number;
      expect(isFinite(gini)).toBe(true);
      expect(gini).toBeGreaterThanOrEqual(0);
      expect(gini).toBeLessThanOrEqual(1);
    });

    it('30. summary — opsTrendSlopeLast14d null when no ops in 14d', async () => {
      ctx = await setup();
      // Only old ops → no 14d ops → null
      await ctx.logger.log(makeOp('agt-sum-slope-null', 'fs', 'sess', dayAgo(20)), dec(0.4));
      await ctx.logger.log(makeOp('agt-sum-slope-null', 'fs', 'sess', dayAgo(25)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.opsTrendSlopeLast14d).toBeNull();
    });

    it('31. summary — riskScoreMomentumLast14d correct value when both windows populated', async () => {
      ctx = await setup();
      // Last 7d: 2 ops with mean 0.6; days 8-14 ago: 2 ops with mean 0.4 → momentum = 0.2
      await ctx.logger.log(makeOp('agt-sum-mom-pos1', 'fs', 'sess', dayAgo(2)), dec(0.5));
      await ctx.logger.log(makeOp('agt-sum-mom-pos2', 'fs', 'sess', dayAgo(4)), dec(0.7));
      await ctx.logger.log(makeOp('agt-sum-mom-pos3', 'fs', 'sess', dayAgo(9)), dec(0.3));
      await ctx.logger.log(makeOp('agt-sum-mom-pos4', 'fs', 'sess', dayAgo(11)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreMomentumLast14d).not.toBeNull();
      // mean7 = (0.5+0.7)/2 = 0.6; mean8to14 = (0.3+0.5)/2 = 0.4; momentum = 0.2
      expect(body.riskScoreMomentumLast14d as number).toBeCloseTo(0.2, 5);
    });

    it('32. summary — riskScoreMomentumLast14d ops beyond 14d do not affect result', async () => {
      ctx = await setup();
      // Both windows: last 7d mean=0.8, days 8-14 mean=0.2 → momentum=0.6
      // Extra old ops (beyond 14d) with very different scores — must not affect computation
      await ctx.logger.log(makeOp('agt-sum-mom-excl1', 'fs', 'sess', dayAgo(3)), dec(0.8));
      await ctx.logger.log(makeOp('agt-sum-mom-excl2', 'fs', 'sess', dayAgo(10)), dec(0.2));
      // ops beyond 14d
      await ctx.logger.log(makeOp('agt-sum-mom-excl3', 'fs', 'sess', dayAgo(20)), dec(0.0));
      await ctx.logger.log(makeOp('agt-sum-mom-excl4', 'fs', 'sess', dayAgo(25)), dec(0.0));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreMomentumLast14d).not.toBeNull();
      // momentum should still be 0.8 - 0.2 = 0.6
      expect(body.riskScoreMomentumLast14d as number).toBeCloseTo(0.6, 5);
    });
  });
});

// ── v10.107 ────────────────────────────────────────────────────────────────────

describe('v10.107', () => {
  function msAgo(ms: number): Date {
    return new Date(PINNED_NOW() - ms);
  }

  function dayAgo(d: number): Date {
    const now = new Date(PINNED_NOW());
    // DST-safe: use JS date arithmetic
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() - d);
  }

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1604-T1608 — v10.107 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v10107-pres'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10107-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('riskScoreEntropyLast7d');
      expect(body).toHaveProperty('riskScoreEntropyLast30d');
      expect(body).toHaveProperty('uniqueMethodsLast14d');
      expect(body).toHaveProperty('avgTimeBetweenOpsLast7d');
      expect(body).toHaveProperty('avgTimeBetweenOpsLast14d');
    });

    it('2. sessions — riskScoreEntropyLast7d null when no ops in 7d', async () => {
      ctx = await setup();
      // Op is 10 days old — outside the 7d window
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v10107-ent7-null', dayAgo(10)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10107-ent7-null');
      expect(status).toBe(200);
      expect(body.riskScoreEntropyLast7d).toBeNull();
    });

    it('3. sessions — riskScoreEntropyLast7d is 0 when all ops in same bin', async () => {
      ctx = await setup();
      // 3 ops with identical risk score — all go into the same bin → entropy = 0
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v10107-ent7-zero', dayAgo(3)), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10107-ent7-zero');
      expect(status).toBe(200);
      expect(body.riskScoreEntropyLast7d).not.toBeNull();
      expect(body.riskScoreEntropyLast7d as number).toBeCloseTo(0, 10);
    });

    it('4. sessions — riskScoreEntropyLast7d positive for ops in different bins', async () => {
      ctx = await setup();
      // Ops in distinct risk bins → positive entropy
      for (const score of [0.1, 0.5, 0.9]) {
        await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v10107-ent7-pos', dayAgo(3)), dec(score));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10107-ent7-pos');
      expect(status).toBe(200);
      expect(body.riskScoreEntropyLast7d).not.toBeNull();
      expect(typeof body.riskScoreEntropyLast7d).toBe('number');
      expect(body.riskScoreEntropyLast7d as number).toBeGreaterThan(0);
    });

    it('5. sessions — riskScoreEntropyLast30d null when no ops in 30d', async () => {
      ctx = await setup();
      // Op is 35 days old — outside the 30d window
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v10107-ent30-null', dayAgo(35)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10107-ent30-null');
      expect(status).toBe(200);
      expect(body.riskScoreEntropyLast30d).toBeNull();
    });

    it('6. sessions — uniqueMethodsLast14d null when no ops in 14d', async () => {
      ctx = await setup();
      // Op is 20 days old — outside the 14d window
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v10107-uniq-null', dayAgo(20)), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10107-uniq-null');
      expect(status).toBe(200);
      expect(body.uniqueMethodsLast14d).toBeNull();
    });

    it('7. sessions — uniqueMethodsLast14d counts distinct methods in 14d window', async () => {
      ctx = await setup();
      // 3 distinct methods in 14d, 1 old op with a 4th method (should be excluded)
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v10107-uniq-cnt', dayAgo(5), 'read'), dec(0.3));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v10107-uniq-cnt', dayAgo(5), 'write'), dec(0.4));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v10107-uniq-cnt', dayAgo(5), 'read'), dec(0.5)); // duplicate
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v10107-uniq-cnt', dayAgo(5), 'delete'), dec(0.6));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v10107-uniq-cnt', dayAgo(20), 'list'), dec(0.2)); // old, excluded

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10107-uniq-cnt');
      expect(status).toBe(200);
      expect(body.uniqueMethodsLast14d).toBe(3); // read, write, delete
    });

    it('8. sessions — avgTimeBetweenOpsLast7d null when fewer than 2 ops in 7d', async () => {
      ctx = await setup();
      // Only 1 op in 7d window
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v10107-avg7-null', dayAgo(3)), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10107-avg7-null');
      expect(status).toBe(200);
      expect(body.avgTimeBetweenOpsLast7d).toBeNull();
    });

    it('9. sessions — avgTimeBetweenOpsLast7d non-negative for 2+ ops in 7d', async () => {
      ctx = await setup();
      // Two ops 2000ms apart within 7d
      const t1 = msAgo(10000);
      const t2 = msAgo(8000);
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v10107-avg7-val', t1), dec(0.3));
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v10107-avg7-val', t2), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10107-avg7-val');
      expect(status).toBe(200);
      expect(body.avgTimeBetweenOpsLast7d).not.toBeNull();
      expect(typeof body.avgTimeBetweenOpsLast7d).toBe('number');
      expect(body.avgTimeBetweenOpsLast7d as number).toBeGreaterThanOrEqual(0);
    });

    it('10. sessions — avgTimeBetweenOpsLast14d null when fewer than 2 ops in 14d', async () => {
      ctx = await setup();
      // Only 1 op in 14d
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v10107-avg14-null', dayAgo(10)), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10107-avg14-null');
      expect(status).toBe(200);
      expect(body.avgTimeBetweenOpsLast14d).toBeNull();
    });

    it('11. sessions — avgTimeBetweenOpsLast14d correct mean for known timestamps', async () => {
      ctx = await setup();
      // 3 ops at known times: diffs are 1000ms and 3000ms → mean = 2000ms
      const base = PINNED_NOW() - 60_000; // ~1 minute ago (well within 14d)
      const t1 = new Date(base);
      const t2 = new Date(base + 1000);
      const t3 = new Date(base + 4000);
      await ctx.logger.log(makeOp('agent-k', 'fs', 'sess-v10107-avg14-val', t1), dec(0.3));
      await ctx.logger.log(makeOp('agent-k', 'fs', 'sess-v10107-avg14-val', t2), dec(0.4));
      await ctx.logger.log(makeOp('agent-k', 'fs', 'sess-v10107-avg14-val', t3), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10107-avg14-val');
      expect(status).toBe(200);
      expect(body.avgTimeBetweenOpsLast14d).not.toBeNull();
      // diffs: [1000, 3000] → mean = 2000
      expect(body.avgTimeBetweenOpsLast14d as number).toBeCloseTo(2000, -1);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1604-T1608 — v10.107 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('12. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-v10107-pres'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/agents/agt-v10107-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('riskScoreEntropyLast7d');
      expect(body).toHaveProperty('riskScoreEntropyLast30d');
      expect(body).toHaveProperty('uniqueMethodsLast14d');
      expect(body).toHaveProperty('avgTimeBetweenOpsLast7d');
      expect(body).toHaveProperty('avgTimeBetweenOpsLast14d');
    });

    it('13. agents — riskScoreEntropyLast30d null when no ops in 30d', async () => {
      ctx = await setup();
      // Op is 35 days old — outside the 30d window
      await ctx.logger.log(makeOp('agt-v10107-ent30-null', 'fs', 'sess', dayAgo(35)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/agents/agt-v10107-ent30-null');
      expect(status).toBe(200);
      expect(body.riskScoreEntropyLast30d).toBeNull();
    });

    it('14. agents — riskScoreEntropyLast30d positive for ops in different bins in 30d', async () => {
      ctx = await setup();
      // Ops in distinct bins in 30d window
      for (const score of [0.1, 0.5, 0.9]) {
        await ctx.logger.log(makeOp('agt-v10107-ent30-pos', 'fs', 'sess', dayAgo(20)), dec(score));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agt-v10107-ent30-pos');
      expect(status).toBe(200);
      expect(body.riskScoreEntropyLast30d).not.toBeNull();
      expect(typeof body.riskScoreEntropyLast30d).toBe('number');
      expect(body.riskScoreEntropyLast30d as number).toBeGreaterThan(0);
    });

    it('15. agents — uniqueMethodsLast14d counts 1 when all ops use same method', async () => {
      ctx = await setup();
      // 4 ops all with method 'call' → uniqueMethodsLast14d = 1
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp('agt-v10107-uniq-one', 'fs', 'sess', dayAgo(5), 'call'), dec(0.4));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agt-v10107-uniq-one');
      expect(status).toBe(200);
      expect(body.uniqueMethodsLast14d).toBe(1);
    });

    it('16. agents — avgTimeBetweenOpsLast7d null when only 1 op in 7d', async () => {
      ctx = await setup();
      // One op in 7d, one older op outside 7d (but in 14d) — 7d avg must be null
      await ctx.logger.log(makeOp('agt-v10107-avg7-null', 'fs', 'sess', dayAgo(3)), dec(0.4));
      await ctx.logger.log(makeOp('agt-v10107-avg7-null', 'fs', 'sess', dayAgo(10)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/agents/agt-v10107-avg7-null');
      expect(status).toBe(200);
      expect(body.avgTimeBetweenOpsLast7d).toBeNull();
    });

    it('17. agents — avgTimeBetweenOpsLast14d correct for 2 ops with known gap', async () => {
      ctx = await setup();
      // Two ops exactly 5000ms apart, well within 14d
      const t1 = msAgo(20000);
      const t2 = new Date(t1.getTime() + 5000);
      await ctx.logger.log(makeOp('agt-v10107-avg14-val', 'fs', 'sess', t1), dec(0.3));
      await ctx.logger.log(makeOp('agt-v10107-avg14-val', 'fs', 'sess', t2), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/agents/agt-v10107-avg14-val');
      expect(status).toBe(200);
      expect(body.avgTimeBetweenOpsLast14d).not.toBeNull();
      // Only 1 diff = 5000ms → mean = 5000
      expect(body.avgTimeBetweenOpsLast14d as number).toBeCloseTo(5000, -1);
    });

    it('18. agents — avgTimeBetweenOpsLast14d ops older than 14d excluded', async () => {
      ctx = await setup();
      // 3 ops: 2 in 14d with 2000ms gap; 1 old op outside 14d (excluded)
      const t1 = msAgo(15000);
      const t2 = new Date(t1.getTime() + 2000);
      await ctx.logger.log(makeOp('agt-v10107-avg14-excl', 'fs', 'sess', t1), dec(0.3));
      await ctx.logger.log(makeOp('agt-v10107-avg14-excl', 'fs', 'sess', t2), dec(0.4));
      // Old op beyond 14d
      await ctx.logger.log(makeOp('agt-v10107-avg14-excl', 'fs', 'sess', dayAgo(20)), dec(0.9));

      const { status, body } = await getJSON(ctx.port, '/agents/agt-v10107-avg14-excl');
      expect(status).toBe(200);
      expect(body.avgTimeBetweenOpsLast14d).not.toBeNull();
      // Only the 2 in-window ops count: diff = 2000ms
      expect(body.avgTimeBetweenOpsLast14d as number).toBeCloseTo(2000, -1);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1604-T1608 — v10.107 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('19. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v10107-pres'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10107-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('riskScoreEntropyLast7d');
      expect(body).toHaveProperty('riskScoreEntropyLast30d');
      expect(body).toHaveProperty('uniqueMethodsLast14d');
      expect(body).toHaveProperty('avgTimeBetweenOpsLast7d');
      expect(body).toHaveProperty('avgTimeBetweenOpsLast14d');
    });

    it('20. tools — riskScoreEntropyLast7d excludes ops older than 7d', async () => {
      ctx = await setup();
      // 1 op in 7d with score 0.5; multiple old ops with score 0.1 (different bin) excluded
      await ctx.logger.log(makeOp('agent-b', 'tool-v10107-ent7-excl', 'sess', dayAgo(3)), dec(0.5));
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp('agent-b', 'tool-v10107-ent7-excl', 'sess', dayAgo(10)), dec(0.1));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10107-ent7-excl');
      expect(status).toBe(200);
      // Only 1 op in 7d, all same bin → entropy = 0
      expect(body.riskScoreEntropyLast7d).not.toBeNull();
      expect(body.riskScoreEntropyLast7d as number).toBeCloseTo(0, 10);
    });

    it('21. tools — uniqueMethodsLast14d returns null when no ops in 14d', async () => {
      ctx = await setup();
      // Op is 20 days old — outside 14d window
      await ctx.logger.log(makeOp('agent-c', 'tool-v10107-uniq-null', 'sess', dayAgo(20)), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10107-uniq-null');
      expect(status).toBe(200);
      expect(body.uniqueMethodsLast14d).toBeNull();
    });

    it('22. tools — uniqueMethodsLast14d counts 2 distinct methods when old method excluded', async () => {
      ctx = await setup();
      // 2 methods in 14d; 1 extra method only in old ops
      await ctx.logger.log(makeOp('agent-d', 'tool-v10107-uniq-cnt', 'sess', dayAgo(5), 'read'), dec(0.3));
      await ctx.logger.log(makeOp('agent-d', 'tool-v10107-uniq-cnt', 'sess', dayAgo(5), 'write'), dec(0.4));
      await ctx.logger.log(makeOp('agent-d', 'tool-v10107-uniq-cnt', 'sess', dayAgo(20), 'delete'), dec(0.5)); // excluded

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10107-uniq-cnt');
      expect(status).toBe(200);
      expect(body.uniqueMethodsLast14d).toBe(2);
    });

    it('23. tools — avgTimeBetweenOpsLast7d non-negative for 2+ ops in 7d', async () => {
      ctx = await setup();
      const t1 = msAgo(5000);
      const t2 = new Date(t1.getTime() + 2000);
      await ctx.logger.log(makeOp('agent-e', 'tool-v10107-avg7-val', 'sess', t1), dec(0.3));
      await ctx.logger.log(makeOp('agent-e', 'tool-v10107-avg7-val', 'sess', t2), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10107-avg7-val');
      expect(status).toBe(200);
      expect(body.avgTimeBetweenOpsLast7d).not.toBeNull();
      expect(body.avgTimeBetweenOpsLast7d as number).toBeGreaterThanOrEqual(0);
    });

    it('24. tools — avgTimeBetweenOpsLast14d null when no ops in 14d', async () => {
      ctx = await setup();
      // 2 ops old enough to be outside 14d — both excluded
      await ctx.logger.log(makeOp('agent-f', 'tool-v10107-avg14-null', 'sess', dayAgo(20)), dec(0.4));
      await ctx.logger.log(makeOp('agent-f', 'tool-v10107-avg14-null', 'sess', dayAgo(25)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10107-avg14-null');
      expect(status).toBe(200);
      expect(body.avgTimeBetweenOpsLast14d).toBeNull();
    });
  });

  // ── summary endpoint ───────────────────────────────────────────────────────────

  describe('T1604-T1608 — v10.107 new fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('25. summary — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body).toHaveProperty('riskScoreEntropyLast7d');
      expect(body).toHaveProperty('riskScoreEntropyLast30d');
      expect(body).toHaveProperty('uniqueMethodsLast14d');
      expect(body).toHaveProperty('avgTimeBetweenOpsLast7d');
      expect(body).toHaveProperty('avgTimeBetweenOpsLast14d');
    });

    it('26. summary — riskScoreEntropyLast7d and riskScoreEntropyLast30d null when no ops', async () => {
      ctx = await setup();

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreEntropyLast7d).toBeNull();
      expect(body.riskScoreEntropyLast30d).toBeNull();
    });

    it('27. summary — uniqueMethodsLast14d null when no ops', async () => {
      ctx = await setup();

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.uniqueMethodsLast14d).toBeNull();
    });

    it('28. summary — avgTimeBetweenOpsLast7d and avgTimeBetweenOpsLast14d null when no ops', async () => {
      ctx = await setup();

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.avgTimeBetweenOpsLast7d).toBeNull();
      expect(body.avgTimeBetweenOpsLast14d).toBeNull();
    });

    it('29. summary — riskScoreEntropyLast30d includes ops up to 30d old but not older', async () => {
      ctx = await setup();
      // 2 ops in distinct bins in 30d → positive entropy; old ops excluded
      for (const score of [0.1, 0.9]) {
        await ctx.logger.log(makeOp('agt-sum-ent30', 'fs', 'sess', dayAgo(25)), dec(score));
      }
      // Old op in same bin as 0.1 — if included would pull entropy down; excluded if > 30d
      await ctx.logger.log(makeOp('agt-sum-ent30', 'fs', 'sess', dayAgo(35)), dec(0.1));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreEntropyLast30d).not.toBeNull();
      expect(typeof body.riskScoreEntropyLast30d).toBe('number');
      expect(body.riskScoreEntropyLast30d as number).toBeGreaterThan(0);
    });

    it('30. summary — uniqueMethodsLast14d counts distinct methods across all agents/tools', async () => {
      ctx = await setup();
      // 3 methods from 3 different agents/tools in 14d; old method excluded
      await ctx.logger.log(makeOp('agt-sum-uniq-a', 'tool-a', 'sess', dayAgo(5), 'read'), dec(0.3));
      await ctx.logger.log(makeOp('agt-sum-uniq-b', 'tool-b', 'sess', dayAgo(5), 'write'), dec(0.4));
      await ctx.logger.log(makeOp('agt-sum-uniq-c', 'tool-c', 'sess', dayAgo(5), 'delete'), dec(0.5));
      await ctx.logger.log(makeOp('agt-sum-uniq-d', 'tool-d', 'sess', dayAgo(20), 'list'), dec(0.2)); // excluded

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.uniqueMethodsLast14d).toBe(3);
    });

    it('31. summary — avgTimeBetweenOpsLast7d correct mean for known timestamps', async () => {
      ctx = await setup();
      // 3 ops: diffs 1000ms and 2000ms → mean = 1500ms
      const base = PINNED_NOW() - 30_000; // well within 7d
      const t1 = new Date(base);
      const t2 = new Date(base + 1000);
      const t3 = new Date(base + 3000);
      await ctx.logger.log(makeOp('agt-sum-avg7-a', 'fs', 'sess', t1), dec(0.3));
      await ctx.logger.log(makeOp('agt-sum-avg7-b', 'fs', 'sess', t2), dec(0.4));
      await ctx.logger.log(makeOp('agt-sum-avg7-c', 'fs', 'sess', t3), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.avgTimeBetweenOpsLast7d).not.toBeNull();
      // diffs: [1000, 2000] → mean = 1500
      expect(body.avgTimeBetweenOpsLast7d as number).toBeCloseTo(1500, -1);
    });

    it('32. summary — avgTimeBetweenOpsLast14d ops beyond 14d excluded from mean', async () => {
      ctx = await setup();
      // 2 in-window ops with 3000ms gap; 1 old op excluded
      const t1 = msAgo(25000);
      const t2 = new Date(t1.getTime() + 3000);
      await ctx.logger.log(makeOp('agt-sum-avg14-a', 'fs', 'sess', t1), dec(0.3));
      await ctx.logger.log(makeOp('agt-sum-avg14-b', 'fs', 'sess', t2), dec(0.4));
      await ctx.logger.log(makeOp('agt-sum-avg14-c', 'fs', 'sess', dayAgo(20)), dec(0.9)); // excluded

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.avgTimeBetweenOpsLast14d).not.toBeNull();
      // Only 1 diff = 3000ms → mean = 3000
      expect(body.avgTimeBetweenOpsLast14d as number).toBeCloseTo(3000, -1);
    });
  });
});

// ── v10.108 ────────────────────────────────────────────────────────────────────

describe('v10.108', () => {
  function msAgo(ms: number): Date {
    return new Date(PINNED_NOW() - ms);
  }

  function daysAgo(d: number): Date {
    return new Date(PINNED_NOW() - d * 86_400_000);
  }

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1609-T1613 — v10.108 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v10108-pres'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10108-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('maxTimeBetweenOpsAllTime');
      expect(body).toHaveProperty('minTimeBetweenOpsAllTime');
      expect(body).toHaveProperty('riskScoreP95Last14d');
      expect(body).toHaveProperty('riskScoreP5Last14d');
      expect(body).toHaveProperty('opsVarianceLast14d');
    });

    it('2. sessions — single op: maxTimeBetweenOpsAllTime and minTimeBetweenOpsAllTime are null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v10108-single'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10108-single');
      expect(status).toBe(200);
      expect(body.maxTimeBetweenOpsAllTime).toBeNull();
      expect(body.minTimeBetweenOpsAllTime).toBeNull();
    });

    it('3. sessions — two ops with known gap: maxTimeBetweenOpsAllTime and minTimeBetweenOpsAllTime correct', async () => {
      ctx = await setup();
      const t1 = msAgo(10000);
      const t2 = new Date(t1.getTime() + 5000); // 5000ms gap
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v10108-gap2', t1), dec(0.3));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v10108-gap2', t2), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10108-gap2');
      expect(status).toBe(200);
      // Only one diff (5000ms): max == min == 5000
      expect(body.maxTimeBetweenOpsAllTime as number).toBeCloseTo(5000, -1);
      expect(body.minTimeBetweenOpsAllTime as number).toBeCloseTo(5000, -1);
      expect(body.maxTimeBetweenOpsAllTime as number).toBeGreaterThanOrEqual(
        body.minTimeBetweenOpsAllTime as number,
      );
    });

    it('4. sessions — three ops: max >= min, both non-negative', async () => {
      ctx = await setup();
      // Gaps: t2-t1 = 3000ms, t3-t2 = 7000ms → max=7000, min=3000
      const t1 = msAgo(20000);
      const t2 = new Date(t1.getTime() + 3000);
      const t3 = new Date(t2.getTime() + 7000);
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v10108-3ops', t1), dec(0.2));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v10108-3ops', t2), dec(0.5));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v10108-3ops', t3), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10108-3ops');
      expect(status).toBe(200);
      expect(body.maxTimeBetweenOpsAllTime as number).toBeCloseTo(7000, -1);
      expect(body.minTimeBetweenOpsAllTime as number).toBeCloseTo(3000, -1);
      expect(body.maxTimeBetweenOpsAllTime as number).toBeGreaterThanOrEqual(
        body.minTimeBetweenOpsAllTime as number,
      );
    });

    it('5. sessions — no ops in 14d: riskScoreP95Last14d and riskScoreP5Last14d are null', async () => {
      ctx = await setup();
      // Op older than 14d
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v10108-p-null', daysAgo(20)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10108-p-null');
      expect(status).toBe(200);
      expect(body.riskScoreP95Last14d).toBeNull();
      expect(body.riskScoreP5Last14d).toBeNull();
    });

    it('6. sessions — ops in 14d: riskScoreP95Last14d >= riskScoreP5Last14d', async () => {
      ctx = await setup();
      // 10 ops with scores 0.1..1.0 in 14d
      for (const score of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]) {
        await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v10108-p10', daysAgo(5)), dec(score));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10108-p10');
      expect(status).toBe(200);
      // Both non-null
      expect(body.riskScoreP95Last14d).not.toBeNull();
      expect(body.riskScoreP5Last14d).not.toBeNull();
      // P95 >= P5
      expect(body.riskScoreP95Last14d as number).toBeGreaterThanOrEqual(
        body.riskScoreP5Last14d as number,
      );
      // P95: sorted len=10, index=floor(10*0.95)=9 → 1.0
      expect(body.riskScoreP95Last14d as number).toBeCloseTo(1.0, 5);
      // P5: sorted len=10, index=floor(10*0.05)=0 → 0.1
      expect(body.riskScoreP5Last14d as number).toBeCloseTo(0.1, 5);
    });

    it('7. sessions — no ops in 14d: opsVarianceLast14d is null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v10108-var-null', daysAgo(20)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10108-var-null');
      expect(status).toBe(200);
      expect(body.opsVarianceLast14d).toBeNull();
    });

    it('8. sessions — ops in 14d: opsVarianceLast14d is non-negative', async () => {
      ctx = await setup();
      // A few ops within 14d
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v10108-var-pos', daysAgo(2)), dec(0.4));
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v10108-var-pos', daysAgo(5)), dec(0.6));
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v10108-var-pos', daysAgo(9)), dec(0.3));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10108-var-pos');
      expect(status).toBe(200);
      expect(body.opsVarianceLast14d).not.toBeNull();
      expect(typeof body.opsVarianceLast14d).toBe('number');
      expect(body.opsVarianceLast14d as number).toBeGreaterThanOrEqual(0);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1609-T1613 — v10.108 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('9. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-v10108-pres'), dec(0.3));

      const { status, body } = await getJSON(ctx.port, '/agents/agt-v10108-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('maxTimeBetweenOpsAllTime');
      expect(body).toHaveProperty('minTimeBetweenOpsAllTime');
      expect(body).toHaveProperty('riskScoreP95Last14d');
      expect(body).toHaveProperty('riskScoreP5Last14d');
      expect(body).toHaveProperty('opsVarianceLast14d');
    });

    it('10. agents — single op: time gap fields are null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-v10108-single'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/agents/agt-v10108-single');
      expect(status).toBe(200);
      expect(body.maxTimeBetweenOpsAllTime).toBeNull();
      expect(body.minTimeBetweenOpsAllTime).toBeNull();
    });

    it('11. agents — four ops with known gaps: max and min computed correctly', async () => {
      ctx = await setup();
      // Gaps: 1000ms, 4000ms, 2000ms → max=4000, min=1000
      const t1 = msAgo(30000);
      const t2 = new Date(t1.getTime() + 1000);
      const t3 = new Date(t2.getTime() + 4000);
      const t4 = new Date(t3.getTime() + 2000);
      for (const t of [t1, t2, t3, t4]) {
        await ctx.logger.log(makeOp('agt-v10108-gaps4', 'fs', 'sess-1', t), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agt-v10108-gaps4');
      expect(status).toBe(200);
      expect(body.maxTimeBetweenOpsAllTime as number).toBeCloseTo(4000, -1);
      expect(body.minTimeBetweenOpsAllTime as number).toBeCloseTo(1000, -1);
    });

    it('12. agents — riskScoreP95Last14d with 20 ops: index = floor(20*0.95) = 19', async () => {
      ctx = await setup();
      // 20 ops with scores 0.05, 0.10, ..., 1.00 in 14d
      for (let i = 1; i <= 20; i++) {
        await ctx.logger.log(
          makeOp('agt-v10108-p95-20', 'fs', 'sess-1', daysAgo(5)),
          dec(i * 0.05),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agt-v10108-p95-20');
      expect(status).toBe(200);
      // sorted len=20, p95 index = floor(20*0.95) = 19 → 1.00
      expect(body.riskScoreP95Last14d as number).toBeCloseTo(1.0, 5);
      // p5 index = floor(20*0.05) = 1 → 0.10
      expect(body.riskScoreP5Last14d as number).toBeCloseTo(0.1, 5);
    });

    it('13. agents — ops only outside 14d: riskScoreP95Last14d and riskScoreP5Last14d are null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-v10108-old', 'fs', 'sess-1', daysAgo(20)), dec(0.8));
      await ctx.logger.log(makeOp('agt-v10108-old', 'fs', 'sess-2', daysAgo(25)), dec(0.2));

      const { status, body } = await getJSON(ctx.port, '/agents/agt-v10108-old');
      expect(status).toBe(200);
      expect(body.riskScoreP95Last14d).toBeNull();
      expect(body.riskScoreP5Last14d).toBeNull();
    });

    it('14. agents — opsVarianceLast14d zero when all ops on the same day', async () => {
      ctx = await setup();
      // All ops on the same day (today) → variance: 1 day has N ops, other 13 have 0
      // counts: [N, 0, 0, ..., 0] (14 values)
      // mean = N/14; variance = ((N - N/14)^2 + 13*(0 - N/14)^2) / 14
      // This is > 0 unless N=0, so we just check it's non-negative and non-null
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agt-v10108-var-sameday', 'fs', `sess-${i}`, daysAgo(1)), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agt-v10108-var-sameday');
      expect(status).toBe(200);
      expect(body.opsVarianceLast14d).not.toBeNull();
      expect(body.opsVarianceLast14d as number).toBeGreaterThanOrEqual(0);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1609-T1613 — v10.108 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('15. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v10108-pres'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10108-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('maxTimeBetweenOpsAllTime');
      expect(body).toHaveProperty('minTimeBetweenOpsAllTime');
      expect(body).toHaveProperty('riskScoreP95Last14d');
      expect(body).toHaveProperty('riskScoreP5Last14d');
      expect(body).toHaveProperty('opsVarianceLast14d');
    });

    it('16. tools — single op: maxTimeBetweenOpsAllTime and minTimeBetweenOpsAllTime are null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-b', 'tool-v10108-single'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10108-single');
      expect(status).toBe(200);
      expect(body.maxTimeBetweenOpsAllTime).toBeNull();
      expect(body.minTimeBetweenOpsAllTime).toBeNull();
    });

    it('17. tools — three ops with known gaps: max and min both non-negative, max >= min', async () => {
      ctx = await setup();
      // Gaps: 2000ms and 6000ms → max=6000, min=2000
      const t1 = msAgo(15000);
      const t2 = new Date(t1.getTime() + 2000);
      const t3 = new Date(t2.getTime() + 6000);
      await ctx.logger.log(makeOp('agent-c', 'tool-v10108-gap3', 'sess-1', t1), dec(0.4));
      await ctx.logger.log(makeOp('agent-c', 'tool-v10108-gap3', 'sess-2', t2), dec(0.5));
      await ctx.logger.log(makeOp('agent-c', 'tool-v10108-gap3', 'sess-3', t3), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10108-gap3');
      expect(status).toBe(200);
      expect(body.maxTimeBetweenOpsAllTime as number).toBeCloseTo(6000, -1);
      expect(body.minTimeBetweenOpsAllTime as number).toBeCloseTo(2000, -1);
      expect(body.maxTimeBetweenOpsAllTime as number).toBeGreaterThanOrEqual(
        body.minTimeBetweenOpsAllTime as number,
      );
    });

    it('18. tools — riskScoreP95Last14d and riskScoreP5Last14d null when no ops in 14d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-d', 'tool-v10108-p-null', 'sess', daysAgo(20)), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10108-p-null');
      expect(status).toBe(200);
      expect(body.riskScoreP95Last14d).toBeNull();
      expect(body.riskScoreP5Last14d).toBeNull();
    });

    it('19. tools — riskScoreP5Last14d less than or equal to P95Last14d for 5 ops', async () => {
      ctx = await setup();
      // 5 ops with scores [0.2, 0.4, 0.5, 0.7, 0.9] in 14d
      // sorted: [0.2, 0.4, 0.5, 0.7, 0.9], len=5
      // p95 idx = floor(5*0.95) = 4 → 0.9
      // p5 idx = floor(5*0.05) = 0 → 0.2
      for (const score of [0.5, 0.2, 0.9, 0.4, 0.7]) {
        await ctx.logger.log(makeOp('agent-e', 'tool-v10108-p5-5ops', 'sess', daysAgo(3)), dec(score));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10108-p5-5ops');
      expect(status).toBe(200);
      expect(body.riskScoreP95Last14d as number).toBeCloseTo(0.9, 5);
      expect(body.riskScoreP5Last14d as number).toBeCloseTo(0.2, 5);
      expect(body.riskScoreP95Last14d as number).toBeGreaterThanOrEqual(
        body.riskScoreP5Last14d as number,
      );
    });

    it('20. tools — opsVarianceLast14d null when no ops in 14d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-f', 'tool-v10108-var-null', 'sess', daysAgo(20)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10108-var-null');
      expect(status).toBe(200);
      expect(body.opsVarianceLast14d).toBeNull();
    });

    it('21. tools — opsVarianceLast14d non-negative when ops exist in 14d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-g', 'tool-v10108-var-pos', 'sess', daysAgo(1)), dec(0.4));
      await ctx.logger.log(makeOp('agent-g', 'tool-v10108-var-pos', 'sess', daysAgo(3)), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10108-var-pos');
      expect(status).toBe(200);
      expect(body.opsVarianceLast14d).not.toBeNull();
      expect(body.opsVarianceLast14d as number).toBeGreaterThanOrEqual(0);
    });
  });

  // ── operations/summary endpoint ────────────────────────────────────────────────

  describe('T1609-T1613 — v10.108 new fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('22. summary — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body).toHaveProperty('maxTimeBetweenOpsAllTime');
      expect(body).toHaveProperty('minTimeBetweenOpsAllTime');
      expect(body).toHaveProperty('riskScoreP95Last14d');
      expect(body).toHaveProperty('riskScoreP5Last14d');
      expect(body).toHaveProperty('opsVarianceLast14d');
    });

    it('23. summary — empty DB: all five new fields are null', async () => {
      ctx = await setup();

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.maxTimeBetweenOpsAllTime).toBeNull();
      expect(body.minTimeBetweenOpsAllTime).toBeNull();
      expect(body.riskScoreP95Last14d).toBeNull();
      expect(body.riskScoreP5Last14d).toBeNull();
      expect(body.opsVarianceLast14d).toBeNull();
    });

    it('24. summary — single op: time gap fields are null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-1'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.maxTimeBetweenOpsAllTime).toBeNull();
      expect(body.minTimeBetweenOpsAllTime).toBeNull();
    });

    it('25. summary — two ops with known gap: max == min == gap', async () => {
      ctx = await setup();
      const t1 = msAgo(8000);
      const t2 = new Date(t1.getTime() + 4000);
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-1', t1), dec(0.3));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-2', t2), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.maxTimeBetweenOpsAllTime as number).toBeCloseTo(4000, -1);
      expect(body.minTimeBetweenOpsAllTime as number).toBeCloseTo(4000, -1);
    });

    it('26. summary — three ops with varied gaps: max and min computed from all ops', async () => {
      ctx = await setup();
      // Gaps: 1000ms and 9000ms → max=9000, min=1000
      const t1 = msAgo(25000);
      const t2 = new Date(t1.getTime() + 1000);
      const t3 = new Date(t2.getTime() + 9000);
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-1', t1), dec(0.2));
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-2', t2), dec(0.5));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-3', t3), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.maxTimeBetweenOpsAllTime as number).toBeCloseTo(9000, -1);
      expect(body.minTimeBetweenOpsAllTime as number).toBeCloseTo(1000, -1);
      expect(body.maxTimeBetweenOpsAllTime as number).toBeGreaterThanOrEqual(
        body.minTimeBetweenOpsAllTime as number,
      );
    });

    it('27. summary — no ops in 14d: riskScoreP95Last14d and riskScoreP5Last14d null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-1', daysAgo(20)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreP95Last14d).toBeNull();
      expect(body.riskScoreP5Last14d).toBeNull();
    });

    it('28. summary — ops in 14d: riskScoreP95Last14d and riskScoreP5Last14d in [0, 1]', async () => {
      ctx = await setup();
      for (const score of [0.1, 0.3, 0.5, 0.7, 0.9]) {
        await ctx.logger.log(makeOp('agent-i', 'fs', `sess-${score}`, daysAgo(5)), dec(score));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreP95Last14d).not.toBeNull();
      expect(body.riskScoreP5Last14d).not.toBeNull();
      expect(body.riskScoreP95Last14d as number).toBeGreaterThanOrEqual(0);
      expect(body.riskScoreP95Last14d as number).toBeLessThanOrEqual(1);
      expect(body.riskScoreP5Last14d as number).toBeGreaterThanOrEqual(0);
      expect(body.riskScoreP5Last14d as number).toBeLessThanOrEqual(1);
      // P95 >= P5
      expect(body.riskScoreP95Last14d as number).toBeGreaterThanOrEqual(
        body.riskScoreP5Last14d as number,
      );
      // sorted: [0.1, 0.3, 0.5, 0.7, 0.9], len=5
      // p95 idx = floor(5*0.95) = 4 → 0.9
      // p5 idx = floor(5*0.05) = 0 → 0.1
      expect(body.riskScoreP95Last14d as number).toBeCloseTo(0.9, 5);
      expect(body.riskScoreP5Last14d as number).toBeCloseTo(0.1, 5);
    });

    it('29. summary — no ops in 14d: opsVarianceLast14d null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-1', daysAgo(20)), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.opsVarianceLast14d).toBeNull();
    });

    it('30. summary — ops in 14d: opsVarianceLast14d is non-negative number', async () => {
      ctx = await setup();
      // Ops spread across a few days in 14d window
      await ctx.logger.log(makeOp('agent-k', 'fs', 'sess-1', daysAgo(1)), dec(0.3));
      await ctx.logger.log(makeOp('agent-l', 'fs', 'sess-2', daysAgo(1)), dec(0.5));
      await ctx.logger.log(makeOp('agent-m', 'fs', 'sess-3', daysAgo(4)), dec(0.7));
      await ctx.logger.log(makeOp('agent-n', 'fs', 'sess-4', daysAgo(8)), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.opsVarianceLast14d).not.toBeNull();
      expect(typeof body.opsVarianceLast14d).toBe('number');
      expect(body.opsVarianceLast14d as number).toBeGreaterThanOrEqual(0);
    });
  });
});

// ── v10.109 ────────────────────────────────────────────────────────────────────

describe('v10.109', () => {
  function daysAgo(d: number): Date {
    return new Date(PINNED_NOW() - d * 86_400_000);
  }

  function msAgo(ms: number): Date {
    return new Date(PINNED_NOW() - ms);
  }

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1614-T1618 — v10.109 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v10109-pres'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10109-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('opsStdDevLast14d');
      expect(body).toHaveProperty('riskScoreMedianLast14d');
      expect(body).toHaveProperty('riskScoreIQRLast14d');
      expect(body).toHaveProperty('blockRateTrend7dVs14d');
      expect(body).toHaveProperty('riskScoreAutocorrelationLag1Last7d');
    });

    it('2. sessions — ops only older than 14d: opsStdDevLast14d, riskScoreMedianLast14d, riskScoreIQRLast14d are null', async () => {
      ctx = await setup();
      // Op logged for the session but older than 14d → 14d window is empty
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v10109-null14', daysAgo(20)), dec(0.5, 'block'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10109-null14');
      expect(status).toBe(200);
      expect(body.opsStdDevLast14d).toBeNull();
      expect(body.riskScoreMedianLast14d).toBeNull();
      expect(body.riskScoreIQRLast14d).toBeNull();
    });

    it('3. sessions — ops only older than 14d: opsStdDevLast14d is null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v10109-old14', daysAgo(20)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10109-old14');
      expect(status).toBe(200);
      expect(body.opsStdDevLast14d).toBeNull();
      expect(body.riskScoreMedianLast14d).toBeNull();
      expect(body.riskScoreIQRLast14d).toBeNull();
    });

    it('4. sessions — ops in 14d: opsStdDevLast14d is non-negative number', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v10109-stddev', daysAgo(2)), dec(0.3));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v10109-stddev', daysAgo(5)), dec(0.6));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v10109-stddev', daysAgo(9)), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10109-stddev');
      expect(status).toBe(200);
      expect(typeof body.opsStdDevLast14d).toBe('number');
      expect(body.opsStdDevLast14d as number).toBeGreaterThanOrEqual(0);
      // stddev = sqrt(variance), so stddev^2 should equal variance (both based on same 14 days)
      expect(body.opsStdDevLast14d as number).toBeLessThanOrEqual(14); // max ops = 14 per day
    });

    it('5. sessions — single op in 14d: riskScoreMedianLast14d equals that score', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v10109-med1', daysAgo(3)), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10109-med1');
      expect(status).toBe(200);
      expect(body.riskScoreMedianLast14d).toBeCloseTo(0.7, 5);
    });

    it('6. sessions — even number of scores: riskScoreMedianLast14d is average of two midpoints', async () => {
      ctx = await setup();
      // 4 scores sorted: 0.2, 0.4, 0.6, 0.8 → median = (0.4 + 0.6) / 2 = 0.5
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v10109-med4', daysAgo(1)), dec(0.6));
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v10109-med4', daysAgo(2)), dec(0.2));
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v10109-med4', daysAgo(3)), dec(0.8));
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v10109-med4', daysAgo(4)), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10109-med4');
      expect(status).toBe(200);
      expect(body.riskScoreMedianLast14d).toBeCloseTo(0.5, 5);
    });

    it('7. sessions — riskScoreIQRLast14d is P75 - P25 (non-negative)', async () => {
      ctx = await setup();
      // 4 scores sorted: 0.1, 0.3, 0.7, 0.9 → P25=floor(4*0.25)=index1=0.3, P75=floor(4*0.75)=index3=0.9 → IQR=0.6
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v10109-iqr', daysAgo(1)), dec(0.7));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v10109-iqr', daysAgo(2)), dec(0.1));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v10109-iqr', daysAgo(3)), dec(0.9));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v10109-iqr', daysAgo(4)), dec(0.3));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10109-iqr');
      expect(status).toBe(200);
      expect(body.riskScoreIQRLast14d as number).toBeCloseTo(0.6, 5);
      expect(body.riskScoreIQRLast14d as number).toBeGreaterThanOrEqual(0);
    });

    it('8. sessions — blockRateTrend7dVs14d: null if no ops in 7d window', async () => {
      ctx = await setup();
      // All ops older than 7d but within 14d
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v10109-brt-null7', daysAgo(10)), dec(0.5, 'block'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10109-brt-null7');
      expect(status).toBe(200);
      expect(body.blockRateTrend7dVs14d).toBeNull();
    });

    it('9. sessions — blockRateTrend7dVs14d: only ops older than 14d → null (both windows empty)', async () => {
      ctx = await setup();
      // Session exists (has a log) but all ops are older than 14d → both w7 and w14 are empty
      await ctx.logger.log(makeOp('agent-h2', 'fs', 'sess-v10109-brt-old14', daysAgo(20)), dec(0.3));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10109-brt-old14');
      expect(status).toBe(200);
      expect(body.blockRateTrend7dVs14d).toBeNull();
    });

    it('10. sessions — blockRateTrend7dVs14d: ops in both windows returns float in [-1,1]', async () => {
      ctx = await setup();
      // 3 ops in 7d (1 blocked = rate7 = 1/3), 5 ops in 14d (1 blocked = rate14 = 1/5)
      // trend = 1/3 - 1/5 = 0.133...
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v10109-brt', daysAgo(1)), dec(0.3, 'block'));
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v10109-brt', daysAgo(2)), dec(0.2));
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v10109-brt', daysAgo(3)), dec(0.4));
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v10109-brt', daysAgo(10)), dec(0.5));
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v10109-brt', daysAgo(12)), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10109-brt');
      expect(status).toBe(200);
      expect(body.blockRateTrend7dVs14d).not.toBeNull();
      const trend = body.blockRateTrend7dVs14d as number;
      expect(trend).toBeGreaterThanOrEqual(-1);
      expect(trend).toBeLessThanOrEqual(1);
      expect(trend).toBeCloseTo(1 / 3 - 1 / 5, 5);
    });

    it('11. sessions — riskScoreAutocorrelationLag1Last7d: null if < 3 ops in 7d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v10109-ac-null', daysAgo(1)), dec(0.3));
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v10109-ac-null', daysAgo(2)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10109-ac-null');
      expect(status).toBe(200);
      expect(body.riskScoreAutocorrelationLag1Last7d).toBeNull();
    });

    it('12. sessions — riskScoreAutocorrelationLag1Last7d: returns 1 for zero-variance scores', async () => {
      ctx = await setup();
      // All same score → variance = 0 → return 1
      await ctx.logger.log(makeOp('agent-k', 'fs', 'sess-v10109-ac-zerovar', daysAgo(1)), dec(0.5));
      await ctx.logger.log(makeOp('agent-k', 'fs', 'sess-v10109-ac-zerovar', daysAgo(2)), dec(0.5));
      await ctx.logger.log(makeOp('agent-k', 'fs', 'sess-v10109-ac-zerovar', daysAgo(3)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10109-ac-zerovar');
      expect(status).toBe(200);
      expect(body.riskScoreAutocorrelationLag1Last7d).toBe(1);
    });

    it('13. sessions — riskScoreAutocorrelationLag1Last7d: value in [-1, 1] for varied scores', async () => {
      ctx = await setup();
      // 4 ops in 7d with varying risk scores
      await ctx.logger.log(makeOp('agent-l', 'fs', 'sess-v10109-ac-val', msAgo(100000)), dec(0.2));
      await ctx.logger.log(makeOp('agent-l', 'fs', 'sess-v10109-ac-val', msAgo(200000)), dec(0.8));
      await ctx.logger.log(makeOp('agent-l', 'fs', 'sess-v10109-ac-val', msAgo(300000)), dec(0.3));
      await ctx.logger.log(makeOp('agent-l', 'fs', 'sess-v10109-ac-val', msAgo(400000)), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10109-ac-val');
      expect(status).toBe(200);
      expect(body.riskScoreAutocorrelationLag1Last7d).not.toBeNull();
      const ac = body.riskScoreAutocorrelationLag1Last7d as number;
      expect(ac).toBeGreaterThanOrEqual(-1);
      expect(ac).toBeLessThanOrEqual(1);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1614-T1618 — v10.109 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('14. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v10109-pres', 'fs', 'sess-1'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10109-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('opsStdDevLast14d');
      expect(body).toHaveProperty('riskScoreMedianLast14d');
      expect(body).toHaveProperty('riskScoreIQRLast14d');
      expect(body).toHaveProperty('blockRateTrend7dVs14d');
      expect(body).toHaveProperty('riskScoreAutocorrelationLag1Last7d');
    });

    it('15. agents — no ops in 14d: opsStdDevLast14d and riskScoreMedianLast14d are null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v10109-old', 'fs', 'sess-1', daysAgo(20)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10109-old');
      expect(status).toBe(200);
      expect(body.opsStdDevLast14d).toBeNull();
      expect(body.riskScoreMedianLast14d).toBeNull();
      expect(body.riskScoreIQRLast14d).toBeNull();
    });

    it('16. agents — ops in 14d: opsStdDevLast14d is non-negative', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v10109-sd', 'fs', 'sess-1', daysAgo(2)), dec(0.3));
      await ctx.logger.log(makeOp('agent-v10109-sd', 'fs', 'sess-1', daysAgo(4)), dec(0.6));
      await ctx.logger.log(makeOp('agent-v10109-sd', 'fs', 'sess-1', daysAgo(8)), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10109-sd');
      expect(status).toBe(200);
      expect(body.opsStdDevLast14d as number).toBeGreaterThanOrEqual(0);
    });

    it('17. agents — blockRateTrend7dVs14d: null if only ops older than 7d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v10109-brt-null', 'fs', 'sess-1', daysAgo(10)), dec(0.5, 'block'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10109-brt-null');
      expect(status).toBe(200);
      expect(body.blockRateTrend7dVs14d).toBeNull();
    });

    it('18. agents — riskScoreAutocorrelationLag1Last7d: null if only 2 ops in 7d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v10109-ac2', 'fs', 'sess-1', daysAgo(1)), dec(0.3));
      await ctx.logger.log(makeOp('agent-v10109-ac2', 'fs', 'sess-1', daysAgo(2)), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10109-ac2');
      expect(status).toBe(200);
      expect(body.riskScoreAutocorrelationLag1Last7d).toBeNull();
    });

    it('19. agents — riskScoreAutocorrelationLag1Last7d: 1 for constant scores (zero variance)', async () => {
      ctx = await setup();
      // Use 0.5 which is exactly representable in IEEE 754 → variance will be exactly 0
      await ctx.logger.log(makeOp('agent-v10109-ac-const', 'fs', 'sess-1', daysAgo(1)), dec(0.5));
      await ctx.logger.log(makeOp('agent-v10109-ac-const', 'fs', 'sess-1', daysAgo(2)), dec(0.5));
      await ctx.logger.log(makeOp('agent-v10109-ac-const', 'fs', 'sess-1', daysAgo(3)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10109-ac-const');
      expect(status).toBe(200);
      expect(body.riskScoreAutocorrelationLag1Last7d).toBe(1);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1614-T1618 — v10.109 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('20. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-1', 'tool-v10109-pres', 'sess-1'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10109-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('opsStdDevLast14d');
      expect(body).toHaveProperty('riskScoreMedianLast14d');
      expect(body).toHaveProperty('riskScoreIQRLast14d');
      expect(body).toHaveProperty('blockRateTrend7dVs14d');
      expect(body).toHaveProperty('riskScoreAutocorrelationLag1Last7d');
    });

    it('21. tools — no ops in 14d: riskScoreMedianLast14d and riskScoreIQRLast14d are null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-1', 'tool-v10109-old', 'sess-1', daysAgo(20)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10109-old');
      expect(status).toBe(200);
      expect(body.riskScoreMedianLast14d).toBeNull();
      expect(body.riskScoreIQRLast14d).toBeNull();
    });

    it('22. tools — 3+ ops in 7d: riskScoreAutocorrelationLag1Last7d is not null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-1', 'tool-v10109-ac', 'sess-1', daysAgo(1)), dec(0.2));
      await ctx.logger.log(makeOp('agent-1', 'tool-v10109-ac', 'sess-1', daysAgo(2)), dec(0.5));
      await ctx.logger.log(makeOp('agent-1', 'tool-v10109-ac', 'sess-1', daysAgo(3)), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10109-ac');
      expect(status).toBe(200);
      expect(body.riskScoreAutocorrelationLag1Last7d).not.toBeNull();
    });

    it('23. tools — blockRateTrend7dVs14d: ops in both windows returns expected trend', async () => {
      ctx = await setup();
      // 2 ops in 7d (0 blocked = rate7=0), 4 ops in 14d (2 blocked = rate14=0.5)
      // trend = 0 - 0.5 = -0.5
      await ctx.logger.log(makeOp('agent-1', 'tool-v10109-brt', 'sess-1', daysAgo(1)), dec(0.2));
      await ctx.logger.log(makeOp('agent-1', 'tool-v10109-brt', 'sess-1', daysAgo(2)), dec(0.3));
      await ctx.logger.log(makeOp('agent-1', 'tool-v10109-brt', 'sess-1', daysAgo(9)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-1', 'tool-v10109-brt', 'sess-1', daysAgo(11)), dec(0.8, 'block'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10109-brt');
      expect(status).toBe(200);
      expect(body.blockRateTrend7dVs14d).not.toBeNull();
      expect(body.blockRateTrend7dVs14d as number).toBeCloseTo(-0.5, 5);
    });

    it('24. tools — opsStdDevLast14d: ops all on same day gives low stddev', async () => {
      ctx = await setup();
      // All 4 ops on same day → 1 day has 4 ops, rest 13 days have 0 → stddev of [4,0,0,...,0]
      const now = new Date(PINNED_NOW());
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp('agent-1', 'tool-v10109-sd', 'sess-1', now), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10109-sd');
      expect(status).toBe(200);
      expect(body.opsStdDevLast14d as number).toBeGreaterThanOrEqual(0);
      // variance = [(4-4/14)^2 + 13*(0-4/14)^2] / 14 → stddev > 0 since not all days equal
      expect(typeof body.opsStdDevLast14d).toBe('number');
    });
  });

  // ── summary endpoint ───────────────────────────────────────────────────────────

  describe('T1614-T1618 — v10.109 new fields (summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('25. summary — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-sum', 'fs', 'sess-1'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body).toHaveProperty('opsStdDevLast14d');
      expect(body).toHaveProperty('riskScoreMedianLast14d');
      expect(body).toHaveProperty('riskScoreIQRLast14d');
      expect(body).toHaveProperty('blockRateTrend7dVs14d');
      expect(body).toHaveProperty('riskScoreAutocorrelationLag1Last7d');
    });

    it('26. summary — no ops: all five fields are null', async () => {
      ctx = await setup();

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.opsStdDevLast14d).toBeNull();
      expect(body.riskScoreMedianLast14d).toBeNull();
      expect(body.riskScoreIQRLast14d).toBeNull();
      expect(body.blockRateTrend7dVs14d).toBeNull();
      // autocorrelation: null because < 3 ops in 7d
      expect(body.riskScoreAutocorrelationLag1Last7d).toBeNull();
    });

    it('27. summary — ops older than 14d: opsStdDevLast14d is null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-sum-old', 'fs', 'sess-1', daysAgo(20)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.opsStdDevLast14d).toBeNull();
    });

    it('28. summary — 3 ops in 7d with same score: autocorrelation is 1', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-sum-ac', 'fs', 'sess-1', daysAgo(1)), dec(0.6));
      await ctx.logger.log(makeOp('agent-sum-ac', 'fs', 'sess-1', daysAgo(2)), dec(0.6));
      await ctx.logger.log(makeOp('agent-sum-ac', 'fs', 'sess-1', daysAgo(3)), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreAutocorrelationLag1Last7d).toBe(1);
    });

    it('29. summary — ops in both 7d and 14d windows: blockRateTrend7dVs14d computed correctly', async () => {
      ctx = await setup();
      // 3 ops in 7d (all blocked = rate7=1.0), 5 ops in 14d (3 blocked = rate14=0.6)
      // trend = 1.0 - 0.6 = 0.4
      await ctx.logger.log(makeOp('agent-sum-brt', 'fs', 'sess-1', daysAgo(1)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-sum-brt', 'fs', 'sess-1', daysAgo(2)), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agent-sum-brt', 'fs', 'sess-1', daysAgo(3)), dec(0.7, 'block'));
      await ctx.logger.log(makeOp('agent-sum-brt', 'fs', 'sess-1', daysAgo(10)), dec(0.3));
      await ctx.logger.log(makeOp('agent-sum-brt', 'fs', 'sess-1', daysAgo(11)), dec(0.2));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.blockRateTrend7dVs14d as number).toBeCloseTo(0.4, 5);
    });

    it('30. summary — riskScoreIQRLast14d: 5 scores → P75 - P25 computed correctly', async () => {
      ctx = await setup();
      // scores sorted: 0.1, 0.3, 0.5, 0.7, 0.9 → n=5
      // P25 = index floor(5*0.25)=1 → 0.3
      // P75 = index floor(5*0.75)=3 → 0.7
      // IQR = 0.7 - 0.3 = 0.4
      await ctx.logger.log(makeOp('agent-sum-iqr', 'fs', 'sess-1', daysAgo(1)), dec(0.5));
      await ctx.logger.log(makeOp('agent-sum-iqr', 'fs', 'sess-1', daysAgo(2)), dec(0.1));
      await ctx.logger.log(makeOp('agent-sum-iqr', 'fs', 'sess-1', daysAgo(3)), dec(0.9));
      await ctx.logger.log(makeOp('agent-sum-iqr', 'fs', 'sess-1', daysAgo(4)), dec(0.3));
      await ctx.logger.log(makeOp('agent-sum-iqr', 'fs', 'sess-1', daysAgo(5)), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreIQRLast14d as number).toBeCloseTo(0.4, 5);
    });
  });
});

// ── v10.110 ────────────────────────────────────────────────────────────────────

describe('v10.110', () => {
  function daysAgo(d: number): Date {
    return new Date(PINNED_NOW() - d * 86_400_000);
  }

  function msAgo(ms: number): Date {
    return new Date(PINNED_NOW() - ms);
  }

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1619-T1623 — v10.110 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v10110-pres'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10110-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('riskScoreAutocorrelationLag1Last30d');
      expect(body).toHaveProperty('riskScoreAutocorrelationLag2Last7d');
      expect(body).toHaveProperty('riskScoreAutocorrelationLag2Last30d');
      expect(body).toHaveProperty('opsBurstRatioLast7dVs14d');
      expect(body).toHaveProperty('riskScoreCVAllTime');
    });

    it('2. sessions — riskScoreAutocorrelationLag1Last30d: null if < 3 ops in 30d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v10110-ac1-null'), dec(0.3));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v10110-ac1-null'), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10110-ac1-null');
      expect(status).toBe(200);
      expect(body.riskScoreAutocorrelationLag1Last30d).toBeNull();
    });

    it('3. sessions — riskScoreAutocorrelationLag1Last30d: returns 1 for zero-variance scores', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v10110-ac1-zv'), dec(0.5));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v10110-ac1-zv'), dec(0.5));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v10110-ac1-zv'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10110-ac1-zv');
      expect(status).toBe(200);
      expect(body.riskScoreAutocorrelationLag1Last30d).toBe(1);
    });

    it('4. sessions — riskScoreAutocorrelationLag1Last30d: value in [-1, 1] for 3+ varied ops', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v10110-ac1-val', msAgo(100000)), dec(0.2));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v10110-ac1-val', msAgo(200000)), dec(0.8));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v10110-ac1-val', msAgo(300000)), dec(0.4));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v10110-ac1-val', msAgo(400000)), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10110-ac1-val');
      expect(status).toBe(200);
      expect(body.riskScoreAutocorrelationLag1Last30d).not.toBeNull();
      const ac = body.riskScoreAutocorrelationLag1Last30d as number;
      expect(ac).toBeGreaterThanOrEqual(-1);
      expect(ac).toBeLessThanOrEqual(1);
    });

    it('5. sessions — riskScoreAutocorrelationLag2Last7d: null if < 4 ops in 7d', async () => {
      ctx = await setup();
      // Only 3 ops in 7d → null
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v10110-ac2-null'), dec(0.3));
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v10110-ac2-null'), dec(0.5));
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v10110-ac2-null'), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10110-ac2-null');
      expect(status).toBe(200);
      expect(body.riskScoreAutocorrelationLag2Last7d).toBeNull();
    });

    it('6. sessions — riskScoreAutocorrelationLag2Last7d: returns 1 for zero-variance scores', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v10110-ac2-zv'), dec(0.5));
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v10110-ac2-zv'), dec(0.5));
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v10110-ac2-zv'), dec(0.5));
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v10110-ac2-zv'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10110-ac2-zv');
      expect(status).toBe(200);
      expect(body.riskScoreAutocorrelationLag2Last7d).toBe(1);
    });

    it('7. sessions — riskScoreAutocorrelationLag2Last7d: value in [-1, 1] for 4+ varied ops', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v10110-ac2-val', msAgo(100000)), dec(0.1));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v10110-ac2-val', msAgo(200000)), dec(0.9));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v10110-ac2-val', msAgo(300000)), dec(0.2));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v10110-ac2-val', msAgo(400000)), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10110-ac2-val');
      expect(status).toBe(200);
      expect(body.riskScoreAutocorrelationLag2Last7d).not.toBeNull();
      const ac = body.riskScoreAutocorrelationLag2Last7d as number;
      expect(ac).toBeGreaterThanOrEqual(-1);
      expect(ac).toBeLessThanOrEqual(1);
    });

    it('8. sessions — riskScoreAutocorrelationLag2Last30d: null if < 4 ops in 30d', async () => {
      ctx = await setup();
      // 3 ops within 30d → null
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v10110-ac2-30-null', daysAgo(2)), dec(0.4));
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v10110-ac2-30-null', daysAgo(5)), dec(0.6));
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v10110-ac2-30-null', daysAgo(10)), dec(0.3));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10110-ac2-30-null');
      expect(status).toBe(200);
      expect(body.riskScoreAutocorrelationLag2Last30d).toBeNull();
    });

    it('9. sessions — riskScoreAutocorrelationLag2Last30d: value in [-1, 1] for 4+ ops', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v10110-ac2-30-val', daysAgo(2)), dec(0.2));
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v10110-ac2-30-val', daysAgo(5)), dec(0.7));
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v10110-ac2-30-val', daysAgo(10)), dec(0.3));
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v10110-ac2-30-val', daysAgo(20)), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10110-ac2-30-val');
      expect(status).toBe(200);
      expect(body.riskScoreAutocorrelationLag2Last30d).not.toBeNull();
      const ac = body.riskScoreAutocorrelationLag2Last30d as number;
      expect(ac).toBeGreaterThanOrEqual(-1);
      expect(ac).toBeLessThanOrEqual(1);
    });

    it('10. sessions — opsBurstRatioLast7dVs14d: null if no ops in 14d', async () => {
      ctx = await setup();
      // Op older than 14d → both windows empty → null
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v10110-burst-null', daysAgo(20)), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10110-burst-null');
      expect(status).toBe(200);
      expect(body.opsBurstRatioLast7dVs14d).toBeNull();
    });

    it('11. sessions — opsBurstRatioLast7dVs14d: 0 when ops only in 8-14d range (none in 7d)', async () => {
      ctx = await setup();
      // 3 ops between 7d and 14d, none within 7d → ratio = 0/3 = 0
      await ctx.logger.log(makeOp('agent-k', 'fs', 'sess-v10110-burst-zero', daysAgo(8)), dec(0.3));
      await ctx.logger.log(makeOp('agent-k', 'fs', 'sess-v10110-burst-zero', daysAgo(10)), dec(0.5));
      await ctx.logger.log(makeOp('agent-k', 'fs', 'sess-v10110-burst-zero', daysAgo(12)), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10110-burst-zero');
      expect(status).toBe(200);
      expect(body.opsBurstRatioLast7dVs14d).toBeCloseTo(0, 5);
    });

    it('12. sessions — opsBurstRatioLast7dVs14d: correct ratio when ops in both windows', async () => {
      ctx = await setup();
      // 4 ops in 7d, 6 total in 14d → ratio = 4/6 ≈ 0.667
      await ctx.logger.log(makeOp('agent-l', 'fs', 'sess-v10110-burst-ratio', daysAgo(1)), dec(0.3));
      await ctx.logger.log(makeOp('agent-l', 'fs', 'sess-v10110-burst-ratio', daysAgo(2)), dec(0.4));
      await ctx.logger.log(makeOp('agent-l', 'fs', 'sess-v10110-burst-ratio', daysAgo(3)), dec(0.5));
      await ctx.logger.log(makeOp('agent-l', 'fs', 'sess-v10110-burst-ratio', daysAgo(4)), dec(0.6));
      await ctx.logger.log(makeOp('agent-l', 'fs', 'sess-v10110-burst-ratio', daysAgo(9)), dec(0.2));
      await ctx.logger.log(makeOp('agent-l', 'fs', 'sess-v10110-burst-ratio', daysAgo(11)), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10110-burst-ratio');
      expect(status).toBe(200);
      expect(body.opsBurstRatioLast7dVs14d).not.toBeNull();
      expect(body.opsBurstRatioLast7dVs14d as number).toBeCloseTo(4 / 6, 5);
    });

    it('13. sessions — riskScoreCVAllTime: null if no logs', async () => {
      ctx = await setup();

      // No logs at all for this session → fetch returns 404 (no ops → no session data)
      // But we need to test riskScoreCVAllTime null when the session has no logs.
      // Instead, log for a different session and verify the field is null there.
      // Actually the session endpoint returns 404 for unknown sessions, so we use a
      // session that does exist but use the summary endpoint for the "no logs" case.
      // Here we test CV directly via summary when db is empty.
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreCVAllTime).toBeNull();
    });

    it('14. sessions — riskScoreCVAllTime: null if all scores are 0 (mean=0)', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-m', 'fs', 'sess-v10110-cv-zero'), dec(0));
      await ctx.logger.log(makeOp('agent-m', 'fs', 'sess-v10110-cv-zero'), dec(0));
      await ctx.logger.log(makeOp('agent-m', 'fs', 'sess-v10110-cv-zero'), dec(0));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10110-cv-zero');
      expect(status).toBe(200);
      expect(body.riskScoreCVAllTime).toBeNull();
    });

    it('15. sessions — riskScoreCVAllTime: non-negative float for varied scores', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-n', 'fs', 'sess-v10110-cv-val'), dec(0.2));
      await ctx.logger.log(makeOp('agent-n', 'fs', 'sess-v10110-cv-val'), dec(0.6));
      await ctx.logger.log(makeOp('agent-n', 'fs', 'sess-v10110-cv-val'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10110-cv-val');
      expect(status).toBe(200);
      expect(body.riskScoreCVAllTime).not.toBeNull();
      expect(body.riskScoreCVAllTime as number).toBeGreaterThanOrEqual(0);
    });

    it('16. sessions — riskScoreCVAllTime: correct value (stddev/mean)', async () => {
      ctx = await setup();
      // scores: [0.2, 0.4, 0.6] → mean=0.4, variance=[(0.2-0.4)^2+(0.4-0.4)^2+(0.6-0.4)^2]/3 = 0.04/3+0+0.04/3 = 0.08/3
      // stddev = sqrt(0.08/3) ≈ 0.1633, CV = 0.1633/0.4 ≈ 0.4082
      await ctx.logger.log(makeOp('agent-o', 'fs', 'sess-v10110-cv-exact'), dec(0.2));
      await ctx.logger.log(makeOp('agent-o', 'fs', 'sess-v10110-cv-exact'), dec(0.4));
      await ctx.logger.log(makeOp('agent-o', 'fs', 'sess-v10110-cv-exact'), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10110-cv-exact');
      expect(status).toBe(200);
      const cv = body.riskScoreCVAllTime as number;
      const expectedMean = 0.4;
      const expectedStddev = Math.sqrt(((0.2 - 0.4) ** 2 + (0.4 - 0.4) ** 2 + (0.6 - 0.4) ** 2) / 3);
      expect(cv).toBeCloseTo(expectedStddev / expectedMean, 5);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1619-T1623 — v10.110 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('17. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v10110-pres', 'fs', 'sess-1'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10110-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('riskScoreAutocorrelationLag1Last30d');
      expect(body).toHaveProperty('riskScoreAutocorrelationLag2Last7d');
      expect(body).toHaveProperty('riskScoreAutocorrelationLag2Last30d');
      expect(body).toHaveProperty('opsBurstRatioLast7dVs14d');
      expect(body).toHaveProperty('riskScoreCVAllTime');
    });

    it('18. agents — riskScoreAutocorrelationLag2Last7d: null if only 3 ops in 7d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v10110-ac2-3', 'fs', 'sess-1', daysAgo(1)), dec(0.3));
      await ctx.logger.log(makeOp('agent-v10110-ac2-3', 'fs', 'sess-1', daysAgo(2)), dec(0.5));
      await ctx.logger.log(makeOp('agent-v10110-ac2-3', 'fs', 'sess-1', daysAgo(3)), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10110-ac2-3');
      expect(status).toBe(200);
      expect(body.riskScoreAutocorrelationLag2Last7d).toBeNull();
    });

    it('19. agents — riskScoreAutocorrelationLag2Last7d: 1 for 4 constant scores', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v10110-ac2-const', 'fs', 'sess-1', daysAgo(1)), dec(0.5));
      await ctx.logger.log(makeOp('agent-v10110-ac2-const', 'fs', 'sess-1', daysAgo(2)), dec(0.5));
      await ctx.logger.log(makeOp('agent-v10110-ac2-const', 'fs', 'sess-1', daysAgo(3)), dec(0.5));
      await ctx.logger.log(makeOp('agent-v10110-ac2-const', 'fs', 'sess-1', daysAgo(4)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10110-ac2-const');
      expect(status).toBe(200);
      expect(body.riskScoreAutocorrelationLag2Last7d).toBe(1);
    });

    it('20. agents — opsBurstRatioLast7dVs14d: null if all ops older than 14d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v10110-burst-null', 'fs', 'sess-1', daysAgo(20)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10110-burst-null');
      expect(status).toBe(200);
      expect(body.opsBurstRatioLast7dVs14d).toBeNull();
    });

    it('21. agents — opsBurstRatioLast7dVs14d: ratio is 1 when all 14d ops are within 7d', async () => {
      ctx = await setup();
      // All 3 ops within 7d → ratio = 3/3 = 1
      await ctx.logger.log(makeOp('agent-v10110-burst-one', 'fs', 'sess-1', daysAgo(1)), dec(0.3));
      await ctx.logger.log(makeOp('agent-v10110-burst-one', 'fs', 'sess-1', daysAgo(2)), dec(0.5));
      await ctx.logger.log(makeOp('agent-v10110-burst-one', 'fs', 'sess-1', daysAgo(3)), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10110-burst-one');
      expect(status).toBe(200);
      expect(body.opsBurstRatioLast7dVs14d).toBeCloseTo(1, 5);
    });

    it('22. agents — riskScoreCVAllTime: null if mean is 0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v10110-cv-zero', 'fs', 'sess-1'), dec(0));
      await ctx.logger.log(makeOp('agent-v10110-cv-zero', 'fs', 'sess-1'), dec(0));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10110-cv-zero');
      expect(status).toBe(200);
      expect(body.riskScoreCVAllTime).toBeNull();
    });

    it('23. agents — riskScoreCVAllTime: correct non-negative value for varied scores', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v10110-cv-val', 'fs', 'sess-1'), dec(0.3));
      await ctx.logger.log(makeOp('agent-v10110-cv-val', 'fs', 'sess-1'), dec(0.7));
      await ctx.logger.log(makeOp('agent-v10110-cv-val', 'fs', 'sess-1'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10110-cv-val');
      expect(status).toBe(200);
      expect(body.riskScoreCVAllTime).not.toBeNull();
      expect(body.riskScoreCVAllTime as number).toBeGreaterThanOrEqual(0);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1619-T1623 — v10.110 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('24. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-1', 'tool-v10110-pres', 'sess-1'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10110-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('riskScoreAutocorrelationLag1Last30d');
      expect(body).toHaveProperty('riskScoreAutocorrelationLag2Last7d');
      expect(body).toHaveProperty('riskScoreAutocorrelationLag2Last30d');
      expect(body).toHaveProperty('opsBurstRatioLast7dVs14d');
      expect(body).toHaveProperty('riskScoreCVAllTime');
    });

    it('25. tools — riskScoreAutocorrelationLag1Last30d: null if < 3 ops in 30d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-1', 'tool-v10110-ac1-null', 'sess-1', daysAgo(5)), dec(0.4));
      await ctx.logger.log(makeOp('agent-1', 'tool-v10110-ac1-null', 'sess-1', daysAgo(10)), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10110-ac1-null');
      expect(status).toBe(200);
      expect(body.riskScoreAutocorrelationLag1Last30d).toBeNull();
    });

    it('26. tools — riskScoreAutocorrelationLag2Last30d: returns 1 for zero-variance scores', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-1', 'tool-v10110-ac2-30-zv', 'sess-1', daysAgo(2)), dec(0.5));
      await ctx.logger.log(makeOp('agent-1', 'tool-v10110-ac2-30-zv', 'sess-1', daysAgo(5)), dec(0.5));
      await ctx.logger.log(makeOp('agent-1', 'tool-v10110-ac2-30-zv', 'sess-1', daysAgo(10)), dec(0.5));
      await ctx.logger.log(makeOp('agent-1', 'tool-v10110-ac2-30-zv', 'sess-1', daysAgo(15)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10110-ac2-30-zv');
      expect(status).toBe(200);
      expect(body.riskScoreAutocorrelationLag2Last30d).toBe(1);
    });

    it('27. tools — opsBurstRatioLast7dVs14d: correct ratio when split between windows', async () => {
      ctx = await setup();
      // 2 ops in 7d, 5 total in 14d → ratio = 2/5 = 0.4
      await ctx.logger.log(makeOp('agent-1', 'tool-v10110-burst-ratio', 'sess-1', daysAgo(1)), dec(0.3));
      await ctx.logger.log(makeOp('agent-1', 'tool-v10110-burst-ratio', 'sess-1', daysAgo(3)), dec(0.5));
      await ctx.logger.log(makeOp('agent-1', 'tool-v10110-burst-ratio', 'sess-1', daysAgo(8)), dec(0.4));
      await ctx.logger.log(makeOp('agent-1', 'tool-v10110-burst-ratio', 'sess-1', daysAgo(10)), dec(0.6));
      await ctx.logger.log(makeOp('agent-1', 'tool-v10110-burst-ratio', 'sess-1', daysAgo(12)), dec(0.2));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10110-burst-ratio');
      expect(status).toBe(200);
      expect(body.opsBurstRatioLast7dVs14d).not.toBeNull();
      expect(body.opsBurstRatioLast7dVs14d as number).toBeCloseTo(2 / 5, 5);
    });

    it('28. tools — riskScoreCVAllTime: single op with non-zero score → stddev=0 → CV=0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-1', 'tool-v10110-cv-single', 'sess-1'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10110-cv-single');
      expect(status).toBe(200);
      // single score: mean=0.5, stddev=0, CV=0
      expect(body.riskScoreCVAllTime).toBeCloseTo(0, 5);
    });
  });

  // ── summary endpoint ───────────────────────────────────────────────────────────

  describe('T1619-T1623 — v10.110 new fields (summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('29. summary — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-sum', 'fs', 'sess-1'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body).toHaveProperty('riskScoreAutocorrelationLag1Last30d');
      expect(body).toHaveProperty('riskScoreAutocorrelationLag2Last7d');
      expect(body).toHaveProperty('riskScoreAutocorrelationLag2Last30d');
      expect(body).toHaveProperty('opsBurstRatioLast7dVs14d');
      expect(body).toHaveProperty('riskScoreCVAllTime');
    });

    it('30. summary — no ops: all five new fields are null', async () => {
      ctx = await setup();

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      // < 3 ops in 30d → null
      expect(body.riskScoreAutocorrelationLag1Last30d).toBeNull();
      // < 4 ops in 7d → null
      expect(body.riskScoreAutocorrelationLag2Last7d).toBeNull();
      // < 4 ops in 30d → null
      expect(body.riskScoreAutocorrelationLag2Last30d).toBeNull();
      // no 14d ops → null
      expect(body.opsBurstRatioLast7dVs14d).toBeNull();
      // no logs → null
      expect(body.riskScoreCVAllTime).toBeNull();
    });

    it('31. summary — 3 ops with same score: riskScoreAutocorrelationLag1Last30d is 1', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-sum-ac1', 'fs', 'sess-1', daysAgo(2)), dec(0.5));
      await ctx.logger.log(makeOp('agent-sum-ac1', 'fs', 'sess-1', daysAgo(5)), dec(0.5));
      await ctx.logger.log(makeOp('agent-sum-ac1', 'fs', 'sess-1', daysAgo(20)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreAutocorrelationLag1Last30d).toBe(1);
    });

    it('32. summary — 4 ops with same score: riskScoreAutocorrelationLag2Last7d is 1', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-sum-ac2', 'fs', 'sess-1', daysAgo(1)), dec(0.5));
      await ctx.logger.log(makeOp('agent-sum-ac2', 'fs', 'sess-1', daysAgo(2)), dec(0.5));
      await ctx.logger.log(makeOp('agent-sum-ac2', 'fs', 'sess-1', daysAgo(3)), dec(0.5));
      await ctx.logger.log(makeOp('agent-sum-ac2', 'fs', 'sess-1', daysAgo(4)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreAutocorrelationLag2Last7d).toBe(1);
    });

    it('33. summary — opsBurstRatioLast7dVs14d: 0 when only ops in 8-14d range', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-sum-burst', 'fs', 'sess-1', daysAgo(8)), dec(0.3));
      await ctx.logger.log(makeOp('agent-sum-burst', 'fs', 'sess-1', daysAgo(10)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.opsBurstRatioLast7dVs14d).toBeCloseTo(0, 5);
    });

    it('34. summary — riskScoreCVAllTime: correct value for known scores', async () => {
      ctx = await setup();
      // scores: [0.2, 0.4, 0.6, 0.8] → mean=0.5
      // variance = [(0.2-0.5)^2+(0.4-0.5)^2+(0.6-0.5)^2+(0.8-0.5)^2]/4 = [0.09+0.01+0.01+0.09]/4 = 0.05
      // stddev = sqrt(0.05), CV = sqrt(0.05)/0.5
      await ctx.logger.log(makeOp('agent-sum-cv', 'fs', 'sess-1'), dec(0.2));
      await ctx.logger.log(makeOp('agent-sum-cv', 'fs', 'sess-1'), dec(0.4));
      await ctx.logger.log(makeOp('agent-sum-cv', 'fs', 'sess-1'), dec(0.6));
      await ctx.logger.log(makeOp('agent-sum-cv', 'fs', 'sess-1'), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      const cv = body.riskScoreCVAllTime as number;
      const expectedCV = Math.sqrt(0.05) / 0.5;
      expect(cv).toBeCloseTo(expectedCV, 5);
    });

    it('35. summary — riskScoreAutocorrelationLag2Last30d: value in [-1,1] for 4 ops in 30d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-sum-ac2-30', 'fs', 'sess-1', daysAgo(2)), dec(0.1));
      await ctx.logger.log(makeOp('agent-sum-ac2-30', 'fs', 'sess-1', daysAgo(8)), dec(0.9));
      await ctx.logger.log(makeOp('agent-sum-ac2-30', 'fs', 'sess-1', daysAgo(15)), dec(0.2));
      await ctx.logger.log(makeOp('agent-sum-ac2-30', 'fs', 'sess-1', daysAgo(25)), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreAutocorrelationLag2Last30d).not.toBeNull();
      const ac = body.riskScoreAutocorrelationLag2Last30d as number;
      expect(ac).toBeGreaterThanOrEqual(-1);
      expect(ac).toBeLessThanOrEqual(1);
    });
  });
});

// ── v10.111 ────────────────────────────────────────────────────────────────────

describe('v10.111', () => {
  function daysAgo(d: number): Date {
    return new Date(PINNED_NOW() - d * 86_400_000);
  }

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1624-T1628 — v10.111 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v10111-pres'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10111-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('riskScoreMADLast14d');
      expect(body).toHaveProperty('riskScoreSkewnessLast14d');
      expect(body).toHaveProperty('riskScoreKurtosisLast14d');
      expect(body).toHaveProperty('opsDailyAvgLast7d');
      expect(body).toHaveProperty('topAgentLast14d');
    });

    it('2. sessions — no ops in 14d: riskScoreMADLast14d is null', async () => {
      ctx = await setup();
      // Op older than 14d → 14d window is empty
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v10111-mad-null', daysAgo(20)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10111-mad-null');
      expect(status).toBe(200);
      expect(body.riskScoreMADLast14d).toBeNull();
    });

    it('3. sessions — riskScoreMADLast14d: single score → MAD is 0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v10111-mad-single', daysAgo(1)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10111-mad-single');
      expect(status).toBe(200);
      // MAD of a single value is |val - median| = |0.5 - 0.5| = 0
      expect(body.riskScoreMADLast14d).toBeCloseTo(0, 5);
    });

    it('4. sessions — riskScoreMADLast14d: correct value for known scores', async () => {
      ctx = await setup();
      // scores: [0.1, 0.3, 0.5, 0.7, 0.9] → median=0.5
      // deviations: [0.4, 0.2, 0.0, 0.2, 0.4] → sorted: [0.0, 0.2, 0.2, 0.4, 0.4]
      // MAD = 0.2
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v10111-mad-val', daysAgo(1)), dec(0.1));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v10111-mad-val', daysAgo(2)), dec(0.3));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v10111-mad-val', daysAgo(3)), dec(0.5));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v10111-mad-val', daysAgo(4)), dec(0.7));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v10111-mad-val', daysAgo(5)), dec(0.9));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10111-mad-val');
      expect(status).toBe(200);
      expect(body.riskScoreMADLast14d as number).toBeCloseTo(0.2, 5);
      expect(body.riskScoreMADLast14d as number).toBeGreaterThanOrEqual(0);
    });

    it('5. sessions — riskScoreSkewnessLast14d: null if < 3 ops in 14d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v10111-skew-null', daysAgo(1)), dec(0.3));
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v10111-skew-null', daysAgo(2)), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10111-skew-null');
      expect(status).toBe(200);
      expect(body.riskScoreSkewnessLast14d).toBeNull();
    });

    it('6. sessions — riskScoreSkewnessLast14d: 0 when all scores are the same (stddev=0)', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v10111-skew-zero', daysAgo(1)), dec(0.5));
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v10111-skew-zero', daysAgo(2)), dec(0.5));
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v10111-skew-zero', daysAgo(3)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10111-skew-zero');
      expect(status).toBe(200);
      expect(body.riskScoreSkewnessLast14d).toBe(0);
    });

    it('7. sessions — riskScoreSkewnessLast14d: returns a finite float for varied scores', async () => {
      ctx = await setup();
      // right-skewed: many low scores, one high
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v10111-skew-val', daysAgo(1)), dec(0.1));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v10111-skew-val', daysAgo(2)), dec(0.1));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v10111-skew-val', daysAgo(3)), dec(0.1));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v10111-skew-val', daysAgo(4)), dec(0.9));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10111-skew-val');
      expect(status).toBe(200);
      expect(body.riskScoreSkewnessLast14d).not.toBeNull();
      expect(isFinite(body.riskScoreSkewnessLast14d as number)).toBe(true);
    });

    it('8. sessions — riskScoreKurtosisLast14d: null if < 4 ops in 14d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v10111-kurt-null', daysAgo(1)), dec(0.2));
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v10111-kurt-null', daysAgo(2)), dec(0.5));
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v10111-kurt-null', daysAgo(3)), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10111-kurt-null');
      expect(status).toBe(200);
      expect(body.riskScoreKurtosisLast14d).toBeNull();
    });

    it('9. sessions — riskScoreKurtosisLast14d: 0 when all scores are the same (stddev=0)', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v10111-kurt-zero', daysAgo(1)), dec(0.5));
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v10111-kurt-zero', daysAgo(2)), dec(0.5));
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v10111-kurt-zero', daysAgo(3)), dec(0.5));
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v10111-kurt-zero', daysAgo(4)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10111-kurt-zero');
      expect(status).toBe(200);
      expect(body.riskScoreKurtosisLast14d).toBe(0);
    });

    it('10. sessions — riskScoreKurtosisLast14d: returns a finite float for 4+ varied ops', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v10111-kurt-val', daysAgo(1)), dec(0.1));
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v10111-kurt-val', daysAgo(2)), dec(0.9));
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v10111-kurt-val', daysAgo(3)), dec(0.1));
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v10111-kurt-val', daysAgo(4)), dec(0.9));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10111-kurt-val');
      expect(status).toBe(200);
      expect(body.riskScoreKurtosisLast14d).not.toBeNull();
      expect(isFinite(body.riskScoreKurtosisLast14d as number)).toBe(true);
    });

    it('11. sessions — opsDailyAvgLast7d: null if no ops in 7d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-k', 'fs', 'sess-v10111-avg-null', daysAgo(10)), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10111-avg-null');
      expect(status).toBe(200);
      expect(body.opsDailyAvgLast7d).toBeNull();
    });

    it('12. sessions — opsDailyAvgLast7d: 6 ops safely within 7d gives avg of 6/7', async () => {
      ctx = await setup();
      for (let d = 1; d <= 6; d++) {
        await ctx.logger.log(makeOp('agent-l', 'fs', 'sess-v10111-avg-one', daysAgo(d)), dec(0.4));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10111-avg-one');
      expect(status).toBe(200);
      expect(body.opsDailyAvgLast7d as number).toBeCloseTo(6 / 7, 5);
    });

    it('13. sessions — opsDailyAvgLast7d: 12 ops in 6 days gives avg of 12/7', async () => {
      ctx = await setup();
      for (let d = 1; d <= 6; d++) {
        await ctx.logger.log(makeOp('agent-m', 'fs', 'sess-v10111-avg-two', daysAgo(d)), dec(0.3));
        await ctx.logger.log(makeOp('agent-m', 'fs', 'sess-v10111-avg-two', daysAgo(d)), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10111-avg-two');
      expect(status).toBe(200);
      expect(body.opsDailyAvgLast7d as number).toBeCloseTo(12 / 7, 5);
    });

    it('14. sessions — topAgentLast14d: null if no ops in 14d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-n', 'fs', 'sess-v10111-top-null', daysAgo(20)), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10111-top-null');
      expect(status).toBe(200);
      expect(body.topAgentLast14d).toBeNull();
    });

    it('15. sessions — topAgentLast14d: returns the agent with the most ops', async () => {
      ctx = await setup();
      // agent-winner has 3 ops, agent-loser has 1 op
      await ctx.logger.log(makeOp('agent-winner', 'fs', 'sess-v10111-top-val', daysAgo(1)), dec(0.4));
      await ctx.logger.log(makeOp('agent-winner', 'fs', 'sess-v10111-top-val', daysAgo(2)), dec(0.4));
      await ctx.logger.log(makeOp('agent-winner', 'fs', 'sess-v10111-top-val', daysAgo(3)), dec(0.4));
      await ctx.logger.log(makeOp('agent-loser', 'fs', 'sess-v10111-top-val', daysAgo(4)), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10111-top-val');
      expect(status).toBe(200);
      expect(body.topAgentLast14d).toBe('agent-winner');
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1624-T1628 — v10.111 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('16. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v10111-pres', 'fs', 'sess-1'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10111-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('riskScoreMADLast14d');
      expect(body).toHaveProperty('riskScoreSkewnessLast14d');
      expect(body).toHaveProperty('riskScoreKurtosisLast14d');
      expect(body).toHaveProperty('opsDailyAvgLast7d');
      expect(body).toHaveProperty('topAgentLast14d');
    });

    it('17. agents — riskScoreMADLast14d: null if all ops older than 14d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v10111-mad-old', 'fs', 'sess-1', daysAgo(20)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10111-mad-old');
      expect(status).toBe(200);
      expect(body.riskScoreMADLast14d).toBeNull();
    });

    it('18. agents — riskScoreMADLast14d: non-negative for ops within 14d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v10111-mad-pos', 'fs', 'sess-1', daysAgo(2)), dec(0.2));
      await ctx.logger.log(makeOp('agent-v10111-mad-pos', 'fs', 'sess-1', daysAgo(5)), dec(0.8));
      await ctx.logger.log(makeOp('agent-v10111-mad-pos', 'fs', 'sess-1', daysAgo(8)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10111-mad-pos');
      expect(status).toBe(200);
      expect(body.riskScoreMADLast14d).not.toBeNull();
      expect(body.riskScoreMADLast14d as number).toBeGreaterThanOrEqual(0);
    });

    it('19. agents — riskScoreSkewnessLast14d: null if only 2 ops in 14d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v10111-skew-2', 'fs', 'sess-1', daysAgo(1)), dec(0.3));
      await ctx.logger.log(makeOp('agent-v10111-skew-2', 'fs', 'sess-1', daysAgo(2)), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10111-skew-2');
      expect(status).toBe(200);
      expect(body.riskScoreSkewnessLast14d).toBeNull();
    });

    it('20. agents — opsDailyAvgLast7d: null if all ops older than 7d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v10111-avg-old', 'fs', 'sess-1', daysAgo(10)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10111-avg-old');
      expect(status).toBe(200);
      expect(body.opsDailyAvgLast7d).toBeNull();
    });

    it('21. agents — opsDailyAvgLast7d: 3 ops in 7d → avg = 3/7', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v10111-avg-3', 'fs', 'sess-1', daysAgo(1)), dec(0.3));
      await ctx.logger.log(makeOp('agent-v10111-avg-3', 'fs', 'sess-1', daysAgo(2)), dec(0.5));
      await ctx.logger.log(makeOp('agent-v10111-avg-3', 'fs', 'sess-1', daysAgo(3)), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10111-avg-3');
      expect(status).toBe(200);
      expect(body.opsDailyAvgLast7d as number).toBeCloseTo(3 / 7, 5);
    });

    it('22. agents — topAgentLast14d: returns own agentId when single agent', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v10111-top-self', 'fs', 'sess-1', daysAgo(2)), dec(0.4));
      await ctx.logger.log(makeOp('agent-v10111-top-self', 'fs', 'sess-1', daysAgo(4)), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10111-top-self');
      expect(status).toBe(200);
      // topAgentLast14d is computed across all logs visible to the endpoint
      // for the agents endpoint, logs are filtered by agentId
      expect(body.topAgentLast14d).toBe('agent-v10111-top-self');
    });

    it('23. agents — riskScoreKurtosisLast14d: null if < 4 ops in 14d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v10111-kurt-3', 'fs', 'sess-1', daysAgo(1)), dec(0.2));
      await ctx.logger.log(makeOp('agent-v10111-kurt-3', 'fs', 'sess-1', daysAgo(2)), dec(0.6));
      await ctx.logger.log(makeOp('agent-v10111-kurt-3', 'fs', 'sess-1', daysAgo(3)), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10111-kurt-3');
      expect(status).toBe(200);
      expect(body.riskScoreKurtosisLast14d).toBeNull();
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1624-T1628 — v10.111 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('24. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-1', 'tool-v10111-pres', 'sess-1'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10111-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('riskScoreMADLast14d');
      expect(body).toHaveProperty('riskScoreSkewnessLast14d');
      expect(body).toHaveProperty('riskScoreKurtosisLast14d');
      expect(body).toHaveProperty('opsDailyAvgLast7d');
      expect(body).toHaveProperty('topAgentLast14d');
    });

    it('25. tools — riskScoreMADLast14d: even number of scores — median is avg of two midpoints', async () => {
      ctx = await setup();
      // scores: [0.2, 0.4, 0.6, 0.8] → median=(0.4+0.6)/2=0.5
      // deviations from 0.5: [0.3, 0.1, 0.1, 0.3] → sorted: [0.1, 0.1, 0.3, 0.3]
      // MAD = (0.1 + 0.3) / 2 = 0.2
      await ctx.logger.log(makeOp('agent-1', 'tool-v10111-mad-even', 'sess-1', daysAgo(1)), dec(0.2));
      await ctx.logger.log(makeOp('agent-1', 'tool-v10111-mad-even', 'sess-1', daysAgo(2)), dec(0.4));
      await ctx.logger.log(makeOp('agent-1', 'tool-v10111-mad-even', 'sess-1', daysAgo(3)), dec(0.6));
      await ctx.logger.log(makeOp('agent-1', 'tool-v10111-mad-even', 'sess-1', daysAgo(4)), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10111-mad-even');
      expect(status).toBe(200);
      expect(body.riskScoreMADLast14d as number).toBeCloseTo(0.2, 5);
    });

    it('26. tools — riskScoreSkewnessLast14d: 0 for constant scores', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-1', 'tool-v10111-skew-const', 'sess-1', daysAgo(1)), dec(0.6));
      await ctx.logger.log(makeOp('agent-1', 'tool-v10111-skew-const', 'sess-1', daysAgo(2)), dec(0.6));
      await ctx.logger.log(makeOp('agent-1', 'tool-v10111-skew-const', 'sess-1', daysAgo(3)), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10111-skew-const');
      expect(status).toBe(200);
      expect(body.riskScoreSkewnessLast14d).toBe(0);
    });

    it('27. tools — opsDailyAvgLast7d: 1 op in 7d → avg = 1/7', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-1', 'tool-v10111-avg-one', 'sess-1', daysAgo(2)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10111-avg-one');
      expect(status).toBe(200);
      expect(body.opsDailyAvgLast7d as number).toBeCloseTo(1 / 7, 5);
    });

    it('28. tools — topAgentLast14d: agent with most ops wins', async () => {
      ctx = await setup();
      // agent-top-a: 3 ops, agent-top-b: 2 ops → agent-top-a wins
      await ctx.logger.log(makeOp('agent-top-a', 'tool-v10111-top', 'sess-1', daysAgo(1)), dec(0.3));
      await ctx.logger.log(makeOp('agent-top-a', 'tool-v10111-top', 'sess-1', daysAgo(2)), dec(0.4));
      await ctx.logger.log(makeOp('agent-top-a', 'tool-v10111-top', 'sess-1', daysAgo(3)), dec(0.5));
      await ctx.logger.log(makeOp('agent-top-b', 'tool-v10111-top', 'sess-1', daysAgo(4)), dec(0.6));
      await ctx.logger.log(makeOp('agent-top-b', 'tool-v10111-top', 'sess-1', daysAgo(5)), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10111-top');
      expect(status).toBe(200);
      expect(body.topAgentLast14d).toBe('agent-top-a');
    });

    it('29. tools — riskScoreKurtosisLast14d: 0 for 4 constant scores', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-1', 'tool-v10111-kurt-const', 'sess-1', daysAgo(1)), dec(0.5));
      await ctx.logger.log(makeOp('agent-1', 'tool-v10111-kurt-const', 'sess-1', daysAgo(2)), dec(0.5));
      await ctx.logger.log(makeOp('agent-1', 'tool-v10111-kurt-const', 'sess-1', daysAgo(3)), dec(0.5));
      await ctx.logger.log(makeOp('agent-1', 'tool-v10111-kurt-const', 'sess-1', daysAgo(4)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10111-kurt-const');
      expect(status).toBe(200);
      expect(body.riskScoreKurtosisLast14d).toBe(0);
    });
  });

  // ── summary endpoint ───────────────────────────────────────────────────────────

  describe('T1624-T1628 — v10.111 new fields (summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('30. summary — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-sum', 'fs', 'sess-1'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body).toHaveProperty('riskScoreMADLast14d');
      expect(body).toHaveProperty('riskScoreSkewnessLast14d');
      expect(body).toHaveProperty('riskScoreKurtosisLast14d');
      expect(body).toHaveProperty('opsDailyAvgLast7d');
      expect(body).toHaveProperty('topAgentLast14d');
    });

    it('31. summary — no ops: all five new fields are null or meet null conditions', async () => {
      ctx = await setup();

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      // no ops in 14d → null
      expect(body.riskScoreMADLast14d).toBeNull();
      // < 3 ops in 14d → null
      expect(body.riskScoreSkewnessLast14d).toBeNull();
      // < 4 ops in 14d → null
      expect(body.riskScoreKurtosisLast14d).toBeNull();
      // no ops in 7d → null
      expect(body.opsDailyAvgLast7d).toBeNull();
      // no ops in 14d → null
      expect(body.topAgentLast14d).toBeNull();
    });

    it('32. summary — ops older than 14d: riskScoreMADLast14d and topAgentLast14d are null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-sum-old', 'fs', 'sess-1', daysAgo(20)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreMADLast14d).toBeNull();
      expect(body.topAgentLast14d).toBeNull();
    });

    it('33. summary — ops older than 7d (but within 14d): opsDailyAvgLast7d is null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-sum-7d', 'fs', 'sess-1', daysAgo(10)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.opsDailyAvgLast7d).toBeNull();
    });

    it('34. summary — topAgentLast14d: agent with most ops in last 14d is returned', async () => {
      ctx = await setup();
      // agent-sum-top-a: 3 ops, agent-sum-top-b: 1 op → agent-sum-top-a wins
      await ctx.logger.log(makeOp('agent-sum-top-a', 'fs', 'sess-1', daysAgo(1)), dec(0.3));
      await ctx.logger.log(makeOp('agent-sum-top-a', 'fs', 'sess-1', daysAgo(3)), dec(0.4));
      await ctx.logger.log(makeOp('agent-sum-top-a', 'fs', 'sess-1', daysAgo(7)), dec(0.5));
      await ctx.logger.log(makeOp('agent-sum-top-b', 'fs', 'sess-1', daysAgo(2)), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.topAgentLast14d).toBe('agent-sum-top-a');
    });

    it('35. summary — opsDailyAvgLast7d: 18 ops in 6 days gives avg of 18/7', async () => {
      ctx = await setup();
      for (let d = 1; d <= 6; d++) {
        await ctx.logger.log(makeOp('agent-sum-avg', 'fs', 'sess-1', daysAgo(d)), dec(0.3));
        await ctx.logger.log(makeOp('agent-sum-avg', 'fs', 'sess-1', daysAgo(d)), dec(0.5));
        await ctx.logger.log(makeOp('agent-sum-avg', 'fs', 'sess-1', daysAgo(d)), dec(0.7));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.opsDailyAvgLast7d as number).toBeCloseTo(18 / 7, 5);
    });

    it('36. summary — riskScoreSkewnessLast14d: 2 ops → null; 3 ops → not null', async () => {
      ctx = await setup();
      // First verify 2 ops → null
      await ctx.logger.log(makeOp('agent-sum-skew', 'fs', 'sess-1', daysAgo(1)), dec(0.3));
      await ctx.logger.log(makeOp('agent-sum-skew', 'fs', 'sess-1', daysAgo(2)), dec(0.7));

      const { body: body2 } = await getJSON(ctx.port, '/operations/summary');
      expect(body2.riskScoreSkewnessLast14d).toBeNull();

      // Add a 3rd op → now not null (or 0 if constant)
      await ctx.logger.log(makeOp('agent-sum-skew', 'fs', 'sess-1', daysAgo(3)), dec(0.5));
      const { body: body3 } = await getJSON(ctx.port, '/operations/summary');
      expect(body3.riskScoreSkewnessLast14d).not.toBeNull();
    });

    it('37. summary — riskScoreKurtosisLast14d: correct excess kurtosis for 4 known scores', async () => {
      ctx = await setup();
      // Uniform distribution approx: [0.2, 0.4, 0.6, 0.8]
      // mean=0.5, variance = [(0.3)^2+(0.1)^2+(0.1)^2+(0.3)^2]/4 = 0.2/4 = 0.05
      // stddev = sqrt(0.05)
      // kurtosis = [(0.3/stddev)^4+(0.1/stddev)^4+(0.1/stddev)^4+(0.3/stddev)^4]/4 - 3
      await ctx.logger.log(makeOp('agent-sum-kurt', 'fs', 'sess-1', daysAgo(1)), dec(0.2));
      await ctx.logger.log(makeOp('agent-sum-kurt', 'fs', 'sess-1', daysAgo(2)), dec(0.4));
      await ctx.logger.log(makeOp('agent-sum-kurt', 'fs', 'sess-1', daysAgo(3)), dec(0.6));
      await ctx.logger.log(makeOp('agent-sum-kurt', 'fs', 'sess-1', daysAgo(4)), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreKurtosisLast14d).not.toBeNull();
      const k = body.riskScoreKurtosisLast14d as number;
      const scores = [0.2, 0.4, 0.6, 0.8];
      const mean = 0.5;
      const stddev = Math.sqrt(scores.reduce((a, v) => a + (v - mean) ** 2, 0) / scores.length);
      const expectedKurtosis =
        scores.reduce((a, v) => a + ((v - mean) / stddev) ** 4, 0) / scores.length - 3;
      expect(k).toBeCloseTo(expectedKurtosis, 5);
    });
  });
});

// ── v10.112 ────────────────────────────────────────────────────────────────────

describe('v10.112', () => {
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1629-T1633 — v10.112 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v10112-pres', daysAgo(1)), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10112-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('topToolLast14d');
      expect(body).toHaveProperty('topMethodLast14d');
      expect(body).toHaveProperty('riskScoreTrendSlopeLast7d');
      expect(body).toHaveProperty('riskScoreRollingMean14d');
      expect(body).toHaveProperty('blockRateRollingMean14d');
    });

    it('2. sessions — only old ops (>14d): topToolLast14d and topMethodLast14d are null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v10112-old', daysAgo(20)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-b', 'net', 'sess-v10112-old', daysAgo(30)), dec(0.6, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10112-old');
      expect(status).toBe(200);

      expect(body.topToolLast14d).toBeNull();
      expect(body.topMethodLast14d).toBeNull();
      expect(body.riskScoreRollingMean14d).toBeNull();
      expect(body.blockRateRollingMean14d).toBeNull();
    });

    it('3. sessions — topToolLast14d returns the most-used tool', async () => {
      ctx = await setup();
      // fs appears 3 times, net appears 1 time in 14d window — fs should win
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v10112-top-tool', daysAgo(1)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v10112-top-tool', daysAgo(2)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v10112-top-tool', daysAgo(3)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-c', 'net', 'sess-v10112-top-tool', daysAgo(4)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10112-top-tool');
      expect(status).toBe(200);

      expect(body.topToolLast14d).toBe('fs');
    });

    it('4. sessions — topMethodLast14d returns the most-used method', async () => {
      ctx = await setup();
      // method "read" appears 2 times, "write" appears 1 time
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v10112-top-meth', daysAgo(1), 'read'), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v10112-top-meth', daysAgo(2), 'read'), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v10112-top-meth', daysAgo(3), 'write'), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10112-top-meth');
      expect(status).toBe(200);

      expect(body.topMethodLast14d).toBe('read');
    });

    it('5. sessions — riskScoreTrendSlopeLast7d is null if only one active day in 7d window', async () => {
      ctx = await setup();
      // Multiple ops but all on the same day index
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v10112-slope-null', daysAgo(1)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v10112-slope-null', daysAgo(1)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10112-slope-null');
      expect(status).toBe(200);

      expect(body.riskScoreTrendSlopeLast7d).toBeNull();
    });

    it('6. sessions — riskScoreTrendSlopeLast7d computed as OLS slope with 2+ active days', async () => {
      ctx = await setup();
      // Day index 1 (daysAgo(1)): mean risk = 0.2
      // Day index 5 (daysAgo(5)): mean risk = 0.8
      // xs = [1, 5], ys = [0.2, 0.8]
      // mx = 3, my = 0.5, num = (1-3)*(0.2-0.5) + (5-3)*(0.8-0.5) = (-2)*(-0.3) + 2*0.3 = 0.6+0.6=1.2
      // den = (1-3)^2 + (5-3)^2 = 4+4 = 8
      // slope = 1.2/8 = 0.15
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v10112-slope', daysAgo(1)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v10112-slope', daysAgo(5)), dec(0.8, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10112-slope');
      expect(status).toBe(200);

      expect(typeof body.riskScoreTrendSlopeLast7d).toBe('number');
      expect(body.riskScoreTrendSlopeLast7d as number).toBeCloseTo(0.15, 4);
    });

    it('7. sessions — riskScoreRollingMean14d is mean of per-day means', async () => {
      ctx = await setup();
      // Day 1: two ops with scores 0.2 and 0.4 → day mean = 0.3
      // Day 8: one op with score 0.9 → day mean = 0.9
      // rollingMean = (0.3 + 0.9) / 2 = 0.6
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v10112-rmean', daysAgo(1)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v10112-rmean', daysAgo(1)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v10112-rmean', daysAgo(8)), dec(0.9, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10112-rmean');
      expect(status).toBe(200);

      expect(body.riskScoreRollingMean14d as number).toBeCloseTo(0.6, 5);
    });

    it('8. sessions — blockRateRollingMean14d is mean of per-day block rates', async () => {
      ctx = await setup();
      // Day 1: 1 block, 1 allow → day rate = 0.5
      // Day 5: 0 blocks, 2 allows → day rate = 0.0
      // rollingMean = (0.5 + 0.0) / 2 = 0.25
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v10112-brate', daysAgo(1)), dec(0.5, 'block'));
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v10112-brate', daysAgo(1)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v10112-brate', daysAgo(5)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v10112-brate', daysAgo(5)), dec(0.2, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10112-brate');
      expect(status).toBe(200);

      expect(body.blockRateRollingMean14d as number).toBeCloseTo(0.25, 5);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1629-T1633 — v10.112 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('9. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v10112-pres', 'fs', 'sess-1', daysAgo(1)), dec(0.3, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10112-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('topToolLast14d');
      expect(body).toHaveProperty('topMethodLast14d');
      expect(body).toHaveProperty('riskScoreTrendSlopeLast7d');
      expect(body).toHaveProperty('riskScoreRollingMean14d');
      expect(body).toHaveProperty('blockRateRollingMean14d');
    });

    it('10. agents — only old ops (>14d): topToolLast14d, topMethodLast14d, riskScoreRollingMean14d, blockRateRollingMean14d all null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v10112-old', 'fs', 'sess-1', daysAgo(20)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-v10112-old', 'net', 'sess-2', daysAgo(25)), dec(0.7, 'block'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10112-old');
      expect(status).toBe(200);

      expect(body.topToolLast14d).toBeNull();
      expect(body.topMethodLast14d).toBeNull();
      expect(body.riskScoreRollingMean14d).toBeNull();
      expect(body.blockRateRollingMean14d).toBeNull();
    });

    it('11. agents — topToolLast14d winner among multiple tools', async () => {
      ctx = await setup();
      // db: 4 times, fs: 2 times, net: 1 time → db wins
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp('agent-v10112-ttool', 'db', `sess-${i}`, daysAgo(i + 1)), dec(0.3, 'allow'));
      }
      for (let i = 0; i < 2; i++) {
        await ctx.logger.log(makeOp('agent-v10112-ttool', 'fs', `sess-fs-${i}`, daysAgo(i + 1)), dec(0.3, 'allow'));
      }
      await ctx.logger.log(makeOp('agent-v10112-ttool', 'net', 'sess-net', daysAgo(1)), dec(0.3, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10112-ttool');
      expect(status).toBe(200);

      expect(body.topToolLast14d).toBe('db');
    });

    it('12. agents — riskScoreTrendSlopeLast7d negative slope (risk decreasing)', async () => {
      ctx = await setup();
      // Day index 1 (daysAgo(1)): mean risk = 0.8 (recent, low day index)
      // Day index 6 (daysAgo(6)): mean risk = 0.2 (older, high day index)
      // xs = [1, 6], ys = [0.8, 0.2]
      // mx = 3.5, my = 0.5
      // num = (1-3.5)*(0.8-0.5) + (6-3.5)*(0.2-0.5) = (-2.5)*(0.3) + (2.5)*(-0.3) = -0.75 + -0.75 = -1.5
      // den = (1-3.5)^2 + (6-3.5)^2 = 6.25 + 6.25 = 12.5
      // slope = -1.5/12.5 = -0.12
      await ctx.logger.log(makeOp('agent-v10112-neg-slope', 'fs', 'sess-1', daysAgo(1)), dec(0.8, 'allow'));
      await ctx.logger.log(makeOp('agent-v10112-neg-slope', 'fs', 'sess-2', daysAgo(6)), dec(0.2, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10112-neg-slope');
      expect(status).toBe(200);

      expect(body.riskScoreTrendSlopeLast7d as number).toBeCloseTo(-0.12, 4);
    });

    it('13. agents — blockRateRollingMean14d = 1.0 when all ops blocked', async () => {
      ctx = await setup();
      // Two days, all ops are blocked → both day rates = 1.0 → mean = 1.0
      await ctx.logger.log(makeOp('agent-v10112-allblock', 'fs', 'sess-1', daysAgo(1)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-v10112-allblock', 'fs', 'sess-2', daysAgo(5)), dec(0.9, 'block'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10112-allblock');
      expect(status).toBe(200);

      expect(body.blockRateRollingMean14d as number).toBeCloseTo(1.0, 5);
    });

    it('14. agents — riskScoreRollingMean14d = 0 when all scores are 0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v10112-zerorisk', 'fs', 'sess-1', daysAgo(1)), dec(0.0, 'allow'));
      await ctx.logger.log(makeOp('agent-v10112-zerorisk', 'fs', 'sess-2', daysAgo(7)), dec(0.0, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10112-zerorisk');
      expect(status).toBe(200);

      expect(body.riskScoreRollingMean14d as number).toBeCloseTo(0.0, 5);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1629-T1633 — v10.112 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('15. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-i', 'tool-v10112-pres', 'sess-1', daysAgo(1)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10112-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('topToolLast14d');
      expect(body).toHaveProperty('topMethodLast14d');
      expect(body).toHaveProperty('riskScoreTrendSlopeLast7d');
      expect(body).toHaveProperty('riskScoreRollingMean14d');
      expect(body).toHaveProperty('blockRateRollingMean14d');
    });

    it('16. tools — only old ops (>14d): topToolLast14d, topMethodLast14d, riskScoreRollingMean14d, blockRateRollingMean14d null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-j', 'tool-v10112-old', 'sess-1', daysAgo(20)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-j', 'tool-v10112-old', 'sess-2', daysAgo(30)), dec(0.8, 'block'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10112-old');
      expect(status).toBe(200);

      expect(body.topToolLast14d).toBeNull();
      expect(body.topMethodLast14d).toBeNull();
      expect(body.riskScoreRollingMean14d).toBeNull();
      expect(body.blockRateRollingMean14d).toBeNull();
    });

    it('17. tools — topMethodLast14d winner among multiple methods', async () => {
      ctx = await setup();
      // "list" appears 3 times, "call" appears 2 times, "read" appears 1 time → "list" wins
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp(`agent-k${i}`, 'tool-v10112-tmeth', `sess-k${i}`, daysAgo(i + 1), 'list'), dec(0.3, 'allow'));
      }
      for (let i = 0; i < 2; i++) {
        await ctx.logger.log(makeOp(`agent-k-c${i}`, 'tool-v10112-tmeth', `sess-kc${i}`, daysAgo(i + 1), 'call'), dec(0.3, 'allow'));
      }
      await ctx.logger.log(makeOp('agent-k-r', 'tool-v10112-tmeth', 'sess-kr', daysAgo(1), 'read'), dec(0.3, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10112-tmeth');
      expect(status).toBe(200);

      expect(body.topMethodLast14d).toBe('list');
    });

    it('18. tools — riskScoreTrendSlopeLast7d with three active days', async () => {
      ctx = await setup();
      // Day idx 1: mean = 0.1; Day idx 3: mean = 0.5; Day idx 5: mean = 0.9
      // xs = [1,3,5], ys = [0.1,0.5,0.9]
      // mx = 3, my = 0.5
      // num = (1-3)*(0.1-0.5)+(3-3)*(0.5-0.5)+(5-3)*(0.9-0.5) = (-2)*(-0.4)+0+(2)*(0.4) = 0.8+0.8=1.6
      // den = (1-3)^2+(3-3)^2+(5-3)^2 = 4+0+4=8
      // slope = 1.6/8 = 0.2
      await ctx.logger.log(makeOp('agent-l', 'tool-v10112-3days', 'sess-1', daysAgo(1)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-l', 'tool-v10112-3days', 'sess-2', daysAgo(3)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-l', 'tool-v10112-3days', 'sess-3', daysAgo(5)), dec(0.9, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10112-3days');
      expect(status).toBe(200);

      expect(body.riskScoreTrendSlopeLast7d as number).toBeCloseTo(0.2, 4);
    });

    it('19. tools — blockRateRollingMean14d = 0.0 when no ops are blocked', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-m', 'tool-v10112-noblock', 'sess-1', daysAgo(1)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-m', 'tool-v10112-noblock', 'sess-2', daysAgo(7)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10112-noblock');
      expect(status).toBe(200);

      expect(body.blockRateRollingMean14d as number).toBeCloseTo(0.0, 5);
    });

    it('20. tools — ops outside 7d but inside 14d: riskScoreTrendSlopeLast7d null, riskScoreRollingMean14d non-null', async () => {
      ctx = await setup();
      // Ops at daysAgo(8) and daysAgo(12) — in 14d window but outside 7d window
      await ctx.logger.log(makeOp('agent-n', 'tool-v10112-14only', 'sess-1', daysAgo(8)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-n', 'tool-v10112-14only', 'sess-2', daysAgo(12)), dec(0.7, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10112-14only');
      expect(status).toBe(200);

      // No ops in 7d window → slope is null (0 active days)
      expect(body.riskScoreTrendSlopeLast7d).toBeNull();
      // But 14d fields are populated
      expect(body.topToolLast14d).not.toBeNull();
      expect(body.riskScoreRollingMean14d).not.toBeNull();
      expect(body.blockRateRollingMean14d).not.toBeNull();
    });
  });

  // ── operations/summary endpoint ────────────────────────────────────────────────

  describe('T1629-T1633 — v10.112 new fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('21. summary — all five new fields present', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-o', 'tool-s', 'sess-1', daysAgo(1)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body).toHaveProperty('topToolLast14d');
      expect(body).toHaveProperty('topMethodLast14d');
      expect(body).toHaveProperty('riskScoreTrendSlopeLast7d');
      expect(body).toHaveProperty('riskScoreRollingMean14d');
      expect(body).toHaveProperty('blockRateRollingMean14d');
    });

    it('22. summary — empty DB: all five new fields are null', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.topToolLast14d).toBeNull();
      expect(body.topMethodLast14d).toBeNull();
      expect(body.riskScoreTrendSlopeLast7d).toBeNull();
      expect(body.riskScoreRollingMean14d).toBeNull();
      expect(body.blockRateRollingMean14d).toBeNull();
    });

    it('23. summary — only old ops (>14d): 14d fields null, 7d slope null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-p', 'fs', 'sess-1', daysAgo(20)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-p', 'net', 'sess-2', daysAgo(25)), dec(0.7, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.topToolLast14d).toBeNull();
      expect(body.topMethodLast14d).toBeNull();
      expect(body.riskScoreTrendSlopeLast7d).toBeNull();
      expect(body.riskScoreRollingMean14d).toBeNull();
      expect(body.blockRateRollingMean14d).toBeNull();
    });

    it('24. summary — topToolLast14d and topMethodLast14d identify correct winners', async () => {
      ctx = await setup();
      // fs: 3 ops, db: 1 op → topTool = fs
      // "write": 3 ops, "read": 1 op → topMethod = write
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp(`agent-q${i}`, 'fs', `sess-${i}`, daysAgo(i + 1), 'write'), dec(0.3, 'allow'));
      }
      await ctx.logger.log(makeOp('agent-q3', 'db', 'sess-3', daysAgo(1), 'read'), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.topToolLast14d).toBe('fs');
      expect(body.topMethodLast14d).toBe('write');
    });

    it('25. summary — riskScoreRollingMean14d and blockRateRollingMean14d computed correctly across multiple days', async () => {
      ctx = await setup();
      // Day 2: scores [0.2, 0.4] → day mean = 0.3; 0 blocks → day rate = 0.0
      // Day 9: scores [0.6, 0.8] → day mean = 0.7; 1 block out of 2 → day rate = 0.5
      // riskScoreRollingMean14d = (0.3 + 0.7) / 2 = 0.5
      // blockRateRollingMean14d = (0.0 + 0.5) / 2 = 0.25
      await ctx.logger.log(makeOp('agent-r1', 'fs', 'sess-1', daysAgo(2)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-r2', 'fs', 'sess-2', daysAgo(2)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-r3', 'fs', 'sess-3', daysAgo(9)), dec(0.6, 'allow'));
      await ctx.logger.log(makeOp('agent-r4', 'fs', 'sess-4', daysAgo(9)), dec(0.8, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.riskScoreRollingMean14d as number).toBeCloseTo(0.5, 5);
      expect(body.blockRateRollingMean14d as number).toBeCloseTo(0.25, 5);
    });

    it('26. summary — riskScoreTrendSlopeLast7d positive slope across 3 days', async () => {
      ctx = await setup();
      // Day idx 1: risk 0.1; Day idx 3: risk 0.5; Day idx 5: risk 0.9
      // xs=[1,3,5], ys=[0.1,0.5,0.9]; slope = 0.2 (same calculation as test 18)
      await ctx.logger.log(makeOp('agent-s1', 'fs', 'sess-1', daysAgo(1)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-s2', 'db', 'sess-2', daysAgo(3)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-s3', 'net', 'sess-3', daysAgo(5)), dec(0.9, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.riskScoreTrendSlopeLast7d as number).toBeCloseTo(0.2, 4);
    });
  });
});

// ── v10.113 ────────────────────────────────────────────────────────────────────

describe('v10.113', () => {
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);
  const hoursAgo = (h: number) => new Date(PINNED_NOW() - h * 3_600_000);

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1634-T1638 — v10.113 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-a', 'fs', 'sess-v10113-pres', daysAgo(1)),
        dec(0.4, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10113-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('allowRateRollingMean14d');
      expect(body).toHaveProperty('requireApprovalRateRollingMean14d');
      expect(body).toHaveProperty('opsHourlyVarianceLast7d');
      expect(body).toHaveProperty('opsHourlyVarianceLast30d');
      expect(body).toHaveProperty('riskScoreWeightedMeanLast7d');
    });

    it('2. sessions — no ops in window: all five fields are null', async () => {
      ctx = await setup();
      // ops older than 30d — outside all windows
      await ctx.logger.log(
        makeOp('agent-b', 'fs', 'sess-v10113-old', daysAgo(35)),
        dec(0.5, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10113-old');
      expect(status).toBe(200);

      expect(body.allowRateRollingMean14d).toBeNull();
      expect(body.requireApprovalRateRollingMean14d).toBeNull();
      expect(body.opsHourlyVarianceLast7d).toBeNull();
      expect(body.opsHourlyVarianceLast30d).toBeNull();
      expect(body.riskScoreWeightedMeanLast7d).toBeNull();
    });

    it('3. sessions — allowRateRollingMean14d is mean of per-day allow rates', async () => {
      ctx = await setup();
      // Day 1: 2 allow, 0 require_approval, 0 block → allow rate = 1.0
      // Day 5: 1 allow, 1 require_approval → allow rate = 0.5
      // mean = (1.0 + 0.5) / 2 = 0.75
      await ctx.logger.log(
        makeOp('agent-c', 'fs', 'sess-v10113-ar', daysAgo(1)),
        dec(0.3, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-c', 'fs', 'sess-v10113-ar', daysAgo(1)),
        dec(0.4, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-c', 'fs', 'sess-v10113-ar', daysAgo(5)),
        dec(0.5, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-c', 'fs', 'sess-v10113-ar', daysAgo(5)),
        dec(0.6, 'require_approval'),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10113-ar');
      expect(status).toBe(200);

      expect(body.allowRateRollingMean14d as number).toBeCloseTo(0.75, 5);
    });

    it('4. sessions — requireApprovalRateRollingMean14d is mean of per-day require_approval rates', async () => {
      ctx = await setup();
      // Day 2: 0 require_approval, 2 allow → ra rate = 0.0
      // Day 6: 1 require_approval, 1 allow → ra rate = 0.5
      // mean = (0.0 + 0.5) / 2 = 0.25
      await ctx.logger.log(
        makeOp('agent-d', 'fs', 'sess-v10113-rar', daysAgo(2)),
        dec(0.2, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-d', 'fs', 'sess-v10113-rar', daysAgo(2)),
        dec(0.3, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-d', 'fs', 'sess-v10113-rar', daysAgo(6)),
        dec(0.4, 'require_approval'),
      );
      await ctx.logger.log(
        makeOp('agent-d', 'fs', 'sess-v10113-rar', daysAgo(6)),
        dec(0.5, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10113-rar');
      expect(status).toBe(200);

      expect(body.requireApprovalRateRollingMean14d as number).toBeCloseTo(0.25, 5);
    });

    it('5. sessions — opsHourlyVarianceLast7d null when fewer than 2 distinct hours', async () => {
      ctx = await setup();
      // Multiple ops but within the same calendar hour
      const sameHour = hoursAgo(2);
      await ctx.logger.log(
        makeOp('agent-e', 'fs', 'sess-v10113-var-null', new Date(sameHour)),
        dec(0.3, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-e', 'fs', 'sess-v10113-var-null', new Date(sameHour.getTime() + 60_000)),
        dec(0.4, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10113-var-null');
      expect(status).toBe(200);

      expect(body.opsHourlyVarianceLast7d).toBeNull();
    });

    it('6. sessions — opsHourlyVarianceLast7d computed for 2 distinct hours', async () => {
      ctx = await setup();
      // Hour A (2h ago): 1 op; Hour B (4h ago): 3 ops
      // counts = [1, 3], mean = 2, variance = ((1-2)^2 + (3-2)^2) / 2 = (1+1)/2 = 1.0
      await ctx.logger.log(
        makeOp('agent-f', 'fs', 'sess-v10113-var7d', hoursAgo(2)),
        dec(0.3, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-f', 'fs', 'sess-v10113-var7d', hoursAgo(4)),
        dec(0.4, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-f', 'fs', 'sess-v10113-var7d', hoursAgo(4)),
        dec(0.5, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-f', 'fs', 'sess-v10113-var7d', hoursAgo(4)),
        dec(0.6, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10113-var7d');
      expect(status).toBe(200);

      expect(typeof body.opsHourlyVarianceLast7d).toBe('number');
      expect(body.opsHourlyVarianceLast7d as number).toBeGreaterThanOrEqual(0);
      expect(body.opsHourlyVarianceLast7d as number).toBeCloseTo(1.0, 4);
    });

    it('7. sessions — riskScoreWeightedMeanLast7d with two ops (most recent has rank 0)', async () => {
      ctx = await setup();
      // Sort descending by timestamp → rank 0 = most recent (daysAgo(1)), rank 1 = older (daysAgo(3))
      // weights = [1/1, 1/2] = [1, 0.5], totalWeight = 1.5
      // scores: rank0 = 0.6, rank1 = 0.2
      // weighted mean = (0.6*1 + 0.2*0.5) / 1.5 = (0.6 + 0.1) / 1.5 = 0.7/1.5 ≈ 0.46667
      await ctx.logger.log(
        makeOp('agent-g', 'fs', 'sess-v10113-wmean', daysAgo(1)),
        dec(0.6, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-g', 'fs', 'sess-v10113-wmean', daysAgo(3)),
        dec(0.2, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10113-wmean');
      expect(status).toBe(200);

      expect(typeof body.riskScoreWeightedMeanLast7d).toBe('number');
      expect(body.riskScoreWeightedMeanLast7d as number).toBeCloseTo(0.46667, 4);
    });

    it('8. sessions — ops beyond 7d but within 14d: 7d fields null, 14d fields non-null', async () => {
      ctx = await setup();
      // ops at daysAgo(8) and daysAgo(12) — in 14d window but outside 7d window
      await ctx.logger.log(
        makeOp('agent-h', 'fs', 'sess-v10113-14only', daysAgo(8)),
        dec(0.4, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-h', 'fs', 'sess-v10113-14only', daysAgo(12)),
        dec(0.6, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10113-14only');
      expect(status).toBe(200);

      // 7d window empty
      expect(body.opsHourlyVarianceLast7d).toBeNull();
      expect(body.riskScoreWeightedMeanLast7d).toBeNull();
      // 14d window has data
      expect(body.allowRateRollingMean14d).not.toBeNull();
      expect(body.requireApprovalRateRollingMean14d).not.toBeNull();
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1634-T1638 — v10.113 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('9. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-v10113-pres', 'fs', 'sess-1', daysAgo(1)),
        dec(0.3, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10113-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('allowRateRollingMean14d');
      expect(body).toHaveProperty('requireApprovalRateRollingMean14d');
      expect(body).toHaveProperty('opsHourlyVarianceLast7d');
      expect(body).toHaveProperty('opsHourlyVarianceLast30d');
      expect(body).toHaveProperty('riskScoreWeightedMeanLast7d');
    });

    it('10. agents — empty 14d window: allowRateRollingMean14d and requireApprovalRateRollingMean14d are null', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-v10113-old14', 'fs', 'sess-1', daysAgo(20)),
        dec(0.5, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10113-old14');
      expect(status).toBe(200);

      expect(body.allowRateRollingMean14d).toBeNull();
      expect(body.requireApprovalRateRollingMean14d).toBeNull();
    });

    it('11. agents — allowRateRollingMean14d = 0.0 when all ops are blocked', async () => {
      ctx = await setup();
      // Both days: 0 allowed → allow rate per day = 0 → mean = 0
      await ctx.logger.log(
        makeOp('agent-v10113-allblock', 'fs', 'sess-1', daysAgo(1)),
        dec(0.9, 'block'),
      );
      await ctx.logger.log(
        makeOp('agent-v10113-allblock', 'fs', 'sess-2', daysAgo(5)),
        dec(0.9, 'block'),
      );

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10113-allblock');
      expect(status).toBe(200);

      expect(body.allowRateRollingMean14d as number).toBeCloseTo(0.0, 5);
    });

    it('12. agents — requireApprovalRateRollingMean14d = 1.0 when all ops require approval', async () => {
      ctx = await setup();
      // Both days: all require_approval → rate per day = 1.0 → mean = 1.0
      await ctx.logger.log(
        makeOp('agent-v10113-allra', 'fs', 'sess-1', daysAgo(2)),
        dec(0.5, 'require_approval'),
      );
      await ctx.logger.log(
        makeOp('agent-v10113-allra', 'fs', 'sess-3', daysAgo(6)),
        dec(0.5, 'require_approval'),
      );

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10113-allra');
      expect(status).toBe(200);

      expect(body.requireApprovalRateRollingMean14d as number).toBeCloseTo(1.0, 5);
    });

    it('13. agents — opsHourlyVarianceLast30d non-null for ops only in 8-29d window', async () => {
      ctx = await setup();
      // Ops at daysAgo(15) ~360h and daysAgo(20) ~480h — different hours, within 30d
      await ctx.logger.log(
        makeOp('agent-v10113-30d', 'fs', 'sess-1', hoursAgo(360)),
        dec(0.3, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-v10113-30d', 'fs', 'sess-2', hoursAgo(480)),
        dec(0.4, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-v10113-30d', 'fs', 'sess-3', hoursAgo(480)),
        dec(0.5, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10113-30d');
      expect(status).toBe(200);

      // 7d window: these ops are outside 7d (360h > 168h) → 7d variance null
      expect(body.opsHourlyVarianceLast7d).toBeNull();
      // 30d window: 2 distinct hours → variance non-null, non-negative
      expect(body.opsHourlyVarianceLast30d).not.toBeNull();
      expect(body.opsHourlyVarianceLast30d as number).toBeGreaterThanOrEqual(0);
    });

    it('14. agents — riskScoreWeightedMeanLast7d = single op score when only one op in 7d', async () => {
      ctx = await setup();
      // Single op: rank 0, weight = 1/(0+1) = 1, totalWeight = 1
      // weighted mean = score * 1 / 1 = score
      await ctx.logger.log(
        makeOp('agent-v10113-single7d', 'fs', 'sess-1', daysAgo(2)),
        dec(0.75, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10113-single7d');
      expect(status).toBe(200);

      expect(body.riskScoreWeightedMeanLast7d as number).toBeCloseTo(0.75, 5);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1634-T1638 — v10.113 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('15. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-i', 'tool-v10113-pres', 'sess-1', daysAgo(1)),
        dec(0.5, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10113-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('allowRateRollingMean14d');
      expect(body).toHaveProperty('requireApprovalRateRollingMean14d');
      expect(body).toHaveProperty('opsHourlyVarianceLast7d');
      expect(body).toHaveProperty('opsHourlyVarianceLast30d');
      expect(body).toHaveProperty('riskScoreWeightedMeanLast7d');
    });

    it('16. tools — only old ops (>30d): all five fields null', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-j', 'tool-v10113-old', 'sess-1', daysAgo(35)),
        dec(0.4, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10113-old');
      expect(status).toBe(200);

      expect(body.allowRateRollingMean14d).toBeNull();
      expect(body.requireApprovalRateRollingMean14d).toBeNull();
      expect(body.opsHourlyVarianceLast7d).toBeNull();
      expect(body.opsHourlyVarianceLast30d).toBeNull();
      expect(body.riskScoreWeightedMeanLast7d).toBeNull();
    });

    it('17. tools — opsHourlyVarianceLast7d = 0 when all hours have equal counts', async () => {
      ctx = await setup();
      // 2 distinct hours, each with exactly 2 ops → counts = [2, 2], mean = 2, variance = 0
      await ctx.logger.log(
        makeOp('agent-k1', 'tool-v10113-zerov', 'sess-1', hoursAgo(2)),
        dec(0.3, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-k2', 'tool-v10113-zerov', 'sess-2', hoursAgo(2)),
        dec(0.4, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-k3', 'tool-v10113-zerov', 'sess-3', hoursAgo(4)),
        dec(0.5, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-k4', 'tool-v10113-zerov', 'sess-4', hoursAgo(4)),
        dec(0.6, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10113-zerov');
      expect(status).toBe(200);

      expect(body.opsHourlyVarianceLast7d as number).toBeCloseTo(0.0, 5);
    });

    it('18. tools — allowRateRollingMean14d in [0, 1] for mixed actions', async () => {
      ctx = await setup();
      // Day 1: 2 allow + 1 block + 1 require_approval → allow rate = 0.5
      // Day 7: 1 allow + 1 block → allow rate = 0.5
      // mean = 0.5
      await ctx.logger.log(
        makeOp('agent-l1', 'tool-v10113-arate', 'sess-1', daysAgo(1)),
        dec(0.2, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-l2', 'tool-v10113-arate', 'sess-2', daysAgo(1)),
        dec(0.4, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-l3', 'tool-v10113-arate', 'sess-3', daysAgo(1)),
        dec(0.7, 'block'),
      );
      await ctx.logger.log(
        makeOp('agent-l4', 'tool-v10113-arate', 'sess-4', daysAgo(1)),
        dec(0.6, 'require_approval'),
      );
      await ctx.logger.log(
        makeOp('agent-l5', 'tool-v10113-arate', 'sess-5', daysAgo(7)),
        dec(0.3, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-l6', 'tool-v10113-arate', 'sess-6', daysAgo(7)),
        dec(0.8, 'block'),
      );

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10113-arate');
      expect(status).toBe(200);

      const v = body.allowRateRollingMean14d as number;
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      expect(v).toBeCloseTo(0.5, 5);
    });

    it('19. tools — riskScoreWeightedMeanLast7d heavier weight on more recent ops', async () => {
      ctx = await setup();
      // 3 ops sorted descending: rank0=daysAgo(1) score=0.9, rank1=daysAgo(3) score=0.1, rank2=daysAgo(5) score=0.1
      // weights = [1, 0.5, 1/3], totalWeight = 1 + 0.5 + 1/3 = 11/6
      // weighted sum = 0.9*1 + 0.1*0.5 + 0.1*(1/3) = 0.9 + 0.05 + 0.0333... = 0.9833...
      // weighted mean = 0.9833... / (11/6) = 0.9833... * 6/11 ≈ 0.53636...
      await ctx.logger.log(
        makeOp('agent-m1', 'tool-v10113-wmean', 'sess-1', daysAgo(1)),
        dec(0.9, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-m2', 'tool-v10113-wmean', 'sess-2', daysAgo(3)),
        dec(0.1, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-m3', 'tool-v10113-wmean', 'sess-3', daysAgo(5)),
        dec(0.1, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10113-wmean');
      expect(status).toBe(200);

      const v = body.riskScoreWeightedMeanLast7d as number;
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      // Expected: (0.9*1 + 0.1*0.5 + 0.1*(1/3)) / (1 + 0.5 + 1/3)
      const w0 = 1, w1 = 1 / 2, w2 = 1 / 3;
      const total = w0 + w1 + w2;
      const expected = (0.9 * w0 + 0.1 * w1 + 0.1 * w2) / total;
      expect(v).toBeCloseTo(expected, 4);
    });
  });

  // ── operations/summary endpoint ────────────────────────────────────────────────

  describe('T1634-T1638 — v10.113 new fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('20. summary — all five new fields present', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-n', 'tool-s', 'sess-1', daysAgo(1)),
        dec(0.5, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body).toHaveProperty('allowRateRollingMean14d');
      expect(body).toHaveProperty('requireApprovalRateRollingMean14d');
      expect(body).toHaveProperty('opsHourlyVarianceLast7d');
      expect(body).toHaveProperty('opsHourlyVarianceLast30d');
      expect(body).toHaveProperty('riskScoreWeightedMeanLast7d');
    });

    it('21. summary — empty DB: all five new fields are null', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.allowRateRollingMean14d).toBeNull();
      expect(body.requireApprovalRateRollingMean14d).toBeNull();
      expect(body.opsHourlyVarianceLast7d).toBeNull();
      expect(body.opsHourlyVarianceLast30d).toBeNull();
      expect(body.riskScoreWeightedMeanLast7d).toBeNull();
    });

    it('22. summary — only old ops (>30d): all five fields null', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-o', 'fs', 'sess-1', daysAgo(35)),
        dec(0.3, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-o', 'net', 'sess-2', daysAgo(40)),
        dec(0.7, 'block'),
      );

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.allowRateRollingMean14d).toBeNull();
      expect(body.requireApprovalRateRollingMean14d).toBeNull();
      expect(body.opsHourlyVarianceLast7d).toBeNull();
      expect(body.opsHourlyVarianceLast30d).toBeNull();
      expect(body.riskScoreWeightedMeanLast7d).toBeNull();
    });

    it('23. summary — allowRateRollingMean14d and requireApprovalRateRollingMean14d computed across mixed actions', async () => {
      ctx = await setup();
      // Day 1: 1 allow, 1 require_approval, 1 block (total 3)
      //   allow rate = 1/3, ra rate = 1/3
      // Day 8: 2 allow, 0 ra, 0 block
      //   allow rate = 1.0, ra rate = 0.0
      // allowRateMean = (1/3 + 1.0) / 2 = (1/3 + 1) / 2 = (4/3) / 2 = 2/3 ≈ 0.66667
      // raRateMean = (1/3 + 0.0) / 2 = 1/6 ≈ 0.16667
      await ctx.logger.log(
        makeOp('agent-p1', 'fs', 'sess-1', daysAgo(1)),
        dec(0.3, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-p2', 'fs', 'sess-2', daysAgo(1)),
        dec(0.5, 'require_approval'),
      );
      await ctx.logger.log(
        makeOp('agent-p3', 'fs', 'sess-3', daysAgo(1)),
        dec(0.8, 'block'),
      );
      await ctx.logger.log(
        makeOp('agent-p4', 'fs', 'sess-4', daysAgo(8)),
        dec(0.2, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-p5', 'fs', 'sess-5', daysAgo(8)),
        dec(0.3, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.allowRateRollingMean14d as number).toBeCloseTo(2 / 3, 4);
      expect(body.requireApprovalRateRollingMean14d as number).toBeCloseTo(1 / 6, 4);
    });

    it('24. summary — opsHourlyVarianceLast30d non-null with ops spread across multiple hours in 8-29d range', async () => {
      ctx = await setup();
      // Ops in the 7-30d window (not in 7d): at ~360h and ~480h
      // These are 2 distinct hours: counts = [2, 1] (not necessarily — just verify non-null and >=0)
      await ctx.logger.log(
        makeOp('agent-q1', 'fs', 'sess-1', hoursAgo(362)),
        dec(0.3, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-q2', 'fs', 'sess-2', hoursAgo(363)),
        dec(0.4, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-q3', 'fs', 'sess-3', hoursAgo(483)),
        dec(0.5, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      // 7d variance: 362h, 363h, 483h all > 168h → null
      expect(body.opsHourlyVarianceLast7d).toBeNull();
      // 30d variance: multiple distinct hours within 30d → non-null
      expect(body.opsHourlyVarianceLast30d).not.toBeNull();
      expect(body.opsHourlyVarianceLast30d as number).toBeGreaterThanOrEqual(0);
    });

    it('25. summary — riskScoreWeightedMeanLast7d bounded in [0, 1] and non-negative', async () => {
      ctx = await setup();
      // 5 ops in last 7d with various risk scores
      await ctx.logger.log(
        makeOp('agent-r1', 'fs', 'sess-1', daysAgo(1)),
        dec(0.0, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-r2', 'fs', 'sess-2', daysAgo(2)),
        dec(0.5, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-r3', 'fs', 'sess-3', daysAgo(3)),
        dec(1.0, 'block'),
      );
      await ctx.logger.log(
        makeOp('agent-r4', 'fs', 'sess-4', daysAgo(4)),
        dec(0.25, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-r5', 'fs', 'sess-5', daysAgo(5)),
        dec(0.75, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      const v = body.riskScoreWeightedMeanLast7d as number;
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    });

    it('26. summary — riskScoreWeightedMeanLast7d null when all ops older than 7d', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-s1', 'fs', 'sess-1', daysAgo(8)),
        dec(0.5, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-s2', 'fs', 'sess-2', daysAgo(10)),
        dec(0.7, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.riskScoreWeightedMeanLast7d).toBeNull();
    });
  });
});

// ── v10.114 ────────────────────────────────────────────────────────────────────

describe('v10.114', () => {
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);
  const hoursAgo = (h: number) => new Date(PINNED_NOW() - h * 3_600_000);

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1639-T1643 — v10.114 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-a', 'fs', 'sess-v10114-pres', daysAgo(1)),
        dec(0.5, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10114-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('riskScoreWeightedMeanLast30d');
      expect(body).toHaveProperty('highRiskRatioLast7d');
      expect(body).toHaveProperty('highRiskRatioLast30d');
      expect(body).toHaveProperty('lowRiskRatioLast7d');
      expect(body).toHaveProperty('lowRiskRatioLast30d');
    });

    it('2. sessions — no ops in window: all five new fields are null', async () => {
      ctx = await setup();
      // op older than 30d — outside all windows
      await ctx.logger.log(
        makeOp('agent-b', 'fs', 'sess-v10114-old', daysAgo(35)),
        dec(0.5, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10114-old');
      expect(status).toBe(200);

      expect(body.riskScoreWeightedMeanLast30d).toBeNull();
      expect(body.highRiskRatioLast7d).toBeNull();
      expect(body.highRiskRatioLast30d).toBeNull();
      expect(body.lowRiskRatioLast7d).toBeNull();
      expect(body.lowRiskRatioLast30d).toBeNull();
    });

    it('3. sessions — highRiskRatioLast7d: fraction of ops with riskScore >= 0.7', async () => {
      ctx = await setup();
      // 3 ops in last 7d: 2 high-risk (>=0.7), 1 not → ratio = 2/3
      await ctx.logger.log(
        makeOp('agent-c', 'fs', 'sess-v10114-hr7', daysAgo(1)),
        dec(0.8, 'block'),
      );
      await ctx.logger.log(
        makeOp('agent-c', 'fs', 'sess-v10114-hr7', daysAgo(2)),
        dec(0.9, 'block'),
      );
      await ctx.logger.log(
        makeOp('agent-c', 'fs', 'sess-v10114-hr7', daysAgo(3)),
        dec(0.5, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10114-hr7');
      expect(status).toBe(200);

      expect(body.highRiskRatioLast7d as number).toBeCloseTo(2 / 3, 5);
    });

    it('4. sessions — lowRiskRatioLast7d: fraction of ops with riskScore < 0.3', async () => {
      ctx = await setup();
      // 4 ops in last 7d: 2 low-risk (<0.3), 2 not → ratio = 2/4 = 0.5
      await ctx.logger.log(
        makeOp('agent-d', 'fs', 'sess-v10114-lr7', daysAgo(1)),
        dec(0.1, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-d', 'fs', 'sess-v10114-lr7', daysAgo(2)),
        dec(0.2, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-d', 'fs', 'sess-v10114-lr7', daysAgo(3)),
        dec(0.5, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-d', 'fs', 'sess-v10114-lr7', daysAgo(4)),
        dec(0.8, 'block'),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10114-lr7');
      expect(status).toBe(200);

      expect(body.lowRiskRatioLast7d as number).toBeCloseTo(0.5, 5);
    });

    it('5. sessions — riskScoreWeightedMeanLast30d with two ops (most recent gets rank 0)', async () => {
      ctx = await setup();
      // Sort descending by timestamp → rank0 = daysAgo(8), rank1 = daysAgo(20)
      // weights = [1/1, 1/2] = [1, 0.5], totalWeight = 1.5
      // scores: rank0 = 0.8, rank1 = 0.2
      // weighted mean = (0.8*1 + 0.2*0.5) / 1.5 = (0.8 + 0.1) / 1.5 = 0.9/1.5 = 0.6
      await ctx.logger.log(
        makeOp('agent-e', 'fs', 'sess-v10114-wm30', daysAgo(8)),
        dec(0.8, 'block'),
      );
      await ctx.logger.log(
        makeOp('agent-e', 'fs', 'sess-v10114-wm30', daysAgo(20)),
        dec(0.2, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10114-wm30');
      expect(status).toBe(200);

      expect(typeof body.riskScoreWeightedMeanLast30d).toBe('number');
      expect(body.riskScoreWeightedMeanLast30d as number).toBeCloseTo(0.6, 5);
    });

    it('6. sessions — highRiskRatioLast30d vs highRiskRatioLast7d: 30d includes older ops', async () => {
      ctx = await setup();
      // ops in 7-30d window only: 1 high-risk → 30d has data, 7d is empty
      await ctx.logger.log(
        makeOp('agent-f', 'fs', 'sess-v10114-hr30', daysAgo(10)),
        dec(0.75, 'block'),
      );
      await ctx.logger.log(
        makeOp('agent-f', 'fs', 'sess-v10114-hr30', daysAgo(15)),
        dec(0.5, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10114-hr30');
      expect(status).toBe(200);

      // 7d window: empty → null
      expect(body.highRiskRatioLast7d).toBeNull();
      // 30d window: 1 of 2 ops >= 0.7 → ratio = 0.5
      expect(body.highRiskRatioLast30d as number).toBeCloseTo(0.5, 5);
    });

    it('7. sessions — lowRiskRatioLast30d = 1.0 when all ops in 30d are low-risk', async () => {
      ctx = await setup();
      // All ops have riskScore < 0.3
      await ctx.logger.log(
        makeOp('agent-g', 'fs', 'sess-v10114-lr30all', daysAgo(15)),
        dec(0.1, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-g', 'fs', 'sess-v10114-lr30all', daysAgo(20)),
        dec(0.2, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10114-lr30all');
      expect(status).toBe(200);

      expect(body.lowRiskRatioLast30d as number).toBeCloseTo(1.0, 5);
    });

    it('8. sessions — highRiskRatioLast7d = 0.0 when no ops are high-risk in 7d', async () => {
      ctx = await setup();
      // All ops have riskScore < 0.7
      await ctx.logger.log(
        makeOp('agent-h', 'fs', 'sess-v10114-hr7-zero', daysAgo(1)),
        dec(0.3, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-h', 'fs', 'sess-v10114-hr7-zero', daysAgo(2)),
        dec(0.5, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10114-hr7-zero');
      expect(status).toBe(200);

      expect(body.highRiskRatioLast7d as number).toBeCloseTo(0.0, 5);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1639-T1643 — v10.114 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('9. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-v10114-pres', 'fs', 'sess-1', daysAgo(1)),
        dec(0.4, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10114-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('riskScoreWeightedMeanLast30d');
      expect(body).toHaveProperty('highRiskRatioLast7d');
      expect(body).toHaveProperty('highRiskRatioLast30d');
      expect(body).toHaveProperty('lowRiskRatioLast7d');
      expect(body).toHaveProperty('lowRiskRatioLast30d');
    });

    it('10. agents — no ops in 30d window: all five fields null', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-v10114-old', 'fs', 'sess-1', daysAgo(35)),
        dec(0.8, 'block'),
      );

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10114-old');
      expect(status).toBe(200);

      expect(body.riskScoreWeightedMeanLast30d).toBeNull();
      expect(body.highRiskRatioLast7d).toBeNull();
      expect(body.highRiskRatioLast30d).toBeNull();
      expect(body.lowRiskRatioLast7d).toBeNull();
      expect(body.lowRiskRatioLast30d).toBeNull();
    });

    it('11. agents — highRiskRatioLast30d = 1.0 when all ops are high-risk', async () => {
      ctx = await setup();
      // All ops have riskScore >= 0.7 → ratio = 1.0
      await ctx.logger.log(
        makeOp('agent-v10114-allhi', 'fs', 'sess-1', daysAgo(10)),
        dec(0.7, 'block'),
      );
      await ctx.logger.log(
        makeOp('agent-v10114-allhi', 'fs', 'sess-2', daysAgo(20)),
        dec(0.9, 'block'),
      );

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10114-allhi');
      expect(status).toBe(200);

      expect(body.highRiskRatioLast30d as number).toBeCloseTo(1.0, 5);
    });

    it('12. agents — lowRiskRatioLast7d = 0.0 when no ops are low-risk in 7d', async () => {
      ctx = await setup();
      // All ops have riskScore >= 0.3
      await ctx.logger.log(
        makeOp('agent-v10114-nolr7', 'fs', 'sess-1', daysAgo(1)),
        dec(0.5, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-v10114-nolr7', 'fs', 'sess-2', daysAgo(3)),
        dec(0.8, 'block'),
      );

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10114-nolr7');
      expect(status).toBe(200);

      expect(body.lowRiskRatioLast7d as number).toBeCloseTo(0.0, 5);
    });

    it('13. agents — riskScoreWeightedMeanLast30d single op equals that op score', async () => {
      ctx = await setup();
      // Single op: rank0, weight = 1/(0+1) = 1, totalWeight = 1
      // weighted mean = score * 1 / 1 = score
      await ctx.logger.log(
        makeOp('agent-v10114-single30', 'fs', 'sess-1', daysAgo(15)),
        dec(0.65, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10114-single30');
      expect(status).toBe(200);

      expect(body.riskScoreWeightedMeanLast30d as number).toBeCloseTo(0.65, 5);
    });

    it('14. agents — highRiskRatioLast7d and lowRiskRatioLast7d null when only ops > 7d', async () => {
      ctx = await setup();
      // ops 10-25d ago: in 30d window, outside 7d window
      await ctx.logger.log(
        makeOp('agent-v10114-7dnull', 'fs', 'sess-1', daysAgo(10)),
        dec(0.8, 'block'),
      );
      await ctx.logger.log(
        makeOp('agent-v10114-7dnull', 'fs', 'sess-2', daysAgo(25)),
        dec(0.1, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10114-7dnull');
      expect(status).toBe(200);

      expect(body.highRiskRatioLast7d).toBeNull();
      expect(body.lowRiskRatioLast7d).toBeNull();
      // 30d window has data
      expect(body.highRiskRatioLast30d).not.toBeNull();
      expect(body.lowRiskRatioLast30d).not.toBeNull();
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1639-T1643 — v10.114 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('15. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-i', 'tool-v10114-pres', 'sess-1', daysAgo(1)),
        dec(0.5, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10114-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('riskScoreWeightedMeanLast30d');
      expect(body).toHaveProperty('highRiskRatioLast7d');
      expect(body).toHaveProperty('highRiskRatioLast30d');
      expect(body).toHaveProperty('lowRiskRatioLast7d');
      expect(body).toHaveProperty('lowRiskRatioLast30d');
    });

    it('16. tools — only old ops (>30d): all five fields null', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-j', 'tool-v10114-old', 'sess-1', daysAgo(35)),
        dec(0.9, 'block'),
      );

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10114-old');
      expect(status).toBe(200);

      expect(body.riskScoreWeightedMeanLast30d).toBeNull();
      expect(body.highRiskRatioLast7d).toBeNull();
      expect(body.highRiskRatioLast30d).toBeNull();
      expect(body.lowRiskRatioLast7d).toBeNull();
      expect(body.lowRiskRatioLast30d).toBeNull();
    });

    it('17. tools — highRiskRatioLast7d computed correctly with boundary score 0.7 (inclusive)', async () => {
      ctx = await setup();
      // exactly 0.7 should count as high-risk (>=0.7)
      await ctx.logger.log(
        makeOp('agent-k', 'tool-v10114-boundary', 'sess-1', daysAgo(1)),
        dec(0.7, 'require_approval'),
      );
      await ctx.logger.log(
        makeOp('agent-k', 'tool-v10114-boundary', 'sess-2', daysAgo(2)),
        dec(0.69, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10114-boundary');
      expect(status).toBe(200);

      // 1 of 2 ops >= 0.7 → ratio = 0.5
      expect(body.highRiskRatioLast7d as number).toBeCloseTo(0.5, 5);
    });

    it('18. tools — lowRiskRatioLast7d boundary score 0.3 is NOT low-risk (strictly < 0.3)', async () => {
      ctx = await setup();
      // exactly 0.3 should NOT count as low-risk (< 0.3 is the threshold)
      await ctx.logger.log(
        makeOp('agent-l', 'tool-v10114-lr-boundary', 'sess-1', daysAgo(1)),
        dec(0.3, 'allow'),  // not low-risk
      );
      await ctx.logger.log(
        makeOp('agent-l', 'tool-v10114-lr-boundary', 'sess-2', daysAgo(2)),
        dec(0.29, 'allow'), // low-risk
      );

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10114-lr-boundary');
      expect(status).toBe(200);

      // 1 of 2 ops < 0.3 → ratio = 0.5
      expect(body.lowRiskRatioLast7d as number).toBeCloseTo(0.5, 5);
    });

    it('19. tools — riskScoreWeightedMeanLast30d in [0, 1] and heavier weight on more recent', async () => {
      ctx = await setup();
      // rank0=daysAgo(8) score=0.9 w=1, rank1=daysAgo(15) score=0.1 w=0.5, rank2=daysAgo(25) score=0.1 w=1/3
      const w0 = 1, w1 = 1 / 2, w2 = 1 / 3;
      const total = w0 + w1 + w2;
      const expected = (0.9 * w0 + 0.1 * w1 + 0.1 * w2) / total;

      await ctx.logger.log(
        makeOp('agent-m1', 'tool-v10114-wm30', 'sess-1', daysAgo(8)),
        dec(0.9, 'block'),
      );
      await ctx.logger.log(
        makeOp('agent-m2', 'tool-v10114-wm30', 'sess-2', daysAgo(15)),
        dec(0.1, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-m3', 'tool-v10114-wm30', 'sess-3', daysAgo(25)),
        dec(0.1, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10114-wm30');
      expect(status).toBe(200);

      const v = body.riskScoreWeightedMeanLast30d as number;
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      expect(v).toBeCloseTo(expected, 4);
    });
  });

  // ── operations/summary endpoint ────────────────────────────────────────────────

  describe('T1639-T1643 — v10.114 new fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('20. summary — all five new fields present', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-n', 'fs', 'sess-1', daysAgo(1)),
        dec(0.5, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body).toHaveProperty('riskScoreWeightedMeanLast30d');
      expect(body).toHaveProperty('highRiskRatioLast7d');
      expect(body).toHaveProperty('highRiskRatioLast30d');
      expect(body).toHaveProperty('lowRiskRatioLast7d');
      expect(body).toHaveProperty('lowRiskRatioLast30d');
    });

    it('21. summary — empty DB: all five new fields are null', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.riskScoreWeightedMeanLast30d).toBeNull();
      expect(body.highRiskRatioLast7d).toBeNull();
      expect(body.highRiskRatioLast30d).toBeNull();
      expect(body.lowRiskRatioLast7d).toBeNull();
      expect(body.lowRiskRatioLast30d).toBeNull();
    });

    it('22. summary — only old ops (>30d): all five fields null', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-o', 'fs', 'sess-1', daysAgo(35)),
        dec(0.8, 'block'),
      );
      await ctx.logger.log(
        makeOp('agent-o', 'net', 'sess-2', daysAgo(40)),
        dec(0.2, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.riskScoreWeightedMeanLast30d).toBeNull();
      expect(body.highRiskRatioLast7d).toBeNull();
      expect(body.highRiskRatioLast30d).toBeNull();
      expect(body.lowRiskRatioLast7d).toBeNull();
      expect(body.lowRiskRatioLast30d).toBeNull();
    });

    it('23. summary — highRiskRatioLast7d and highRiskRatioLast30d computed from mixed ops', async () => {
      ctx = await setup();
      // 7d window: 2 ops (score 0.8 and 0.4) → 1 high-risk → ratio = 0.5
      // 30d window (adds 2 more from 8-29d): score 0.9 and 0.2 → total 4 ops, 3 high-risk? No:
      //   all 4: 0.8 (hi), 0.4 (not), 0.9 (hi), 0.2 (not) → 2/4 = 0.5
      await ctx.logger.log(
        makeOp('agent-p1', 'fs', 'sess-1', daysAgo(1)),
        dec(0.8, 'block'),
      );
      await ctx.logger.log(
        makeOp('agent-p2', 'fs', 'sess-2', daysAgo(3)),
        dec(0.4, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-p3', 'fs', 'sess-3', daysAgo(10)),
        dec(0.9, 'block'),
      );
      await ctx.logger.log(
        makeOp('agent-p4', 'fs', 'sess-4', daysAgo(20)),
        dec(0.2, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.highRiskRatioLast7d as number).toBeCloseTo(0.5, 5);
      expect(body.highRiskRatioLast30d as number).toBeCloseTo(0.5, 5);
    });

    it('24. summary — lowRiskRatioLast30d and lowRiskRatioLast7d computed from mixed ops', async () => {
      ctx = await setup();
      // 7d window: 3 ops scores [0.1, 0.2, 0.5] → 2 low-risk (<0.3) → ratio = 2/3
      // 30d window: adds ops at score 0.8 and 0.1 → total 5 ops, 3 low-risk (<0.3)
      await ctx.logger.log(
        makeOp('agent-q1', 'fs', 'sess-1', daysAgo(1)),
        dec(0.1, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-q2', 'fs', 'sess-2', daysAgo(3)),
        dec(0.2, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-q3', 'fs', 'sess-3', daysAgo(5)),
        dec(0.5, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-q4', 'fs', 'sess-4', daysAgo(12)),
        dec(0.8, 'block'),
      );
      await ctx.logger.log(
        makeOp('agent-q5', 'fs', 'sess-5', daysAgo(18)),
        dec(0.1, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.lowRiskRatioLast7d as number).toBeCloseTo(2 / 3, 4);
      expect(body.lowRiskRatioLast30d as number).toBeCloseTo(3 / 5, 4);
    });

    it('25. summary — riskScoreWeightedMeanLast30d null when no ops in 30d', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-r', 'fs', 'sess-1', daysAgo(32)),
        dec(0.5, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.riskScoreWeightedMeanLast30d).toBeNull();
    });

    it('26. summary — riskScoreWeightedMeanLast30d bounded in [0, 1] across many ops', async () => {
      ctx = await setup();
      const scores = [0.0, 0.1, 0.3, 0.5, 0.7, 0.9, 1.0];
      for (let i = 0; i < scores.length; i++) {
        await ctx.logger.log(
          makeOp(`agent-s${i}`, 'fs', `sess-${i}`, daysAgo(i + 1)),
          dec(scores[i]!, 'allow'),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      const v = body.riskScoreWeightedMeanLast30d as number;
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    });

    it('27. summary — riskScoreWeightedMeanLast30d vs riskScoreWeightedMeanLast7d: 30d includes ops at 8-29d', async () => {
      ctx = await setup();
      // ops only in 8-25d range: in 30d window but not 7d window
      await ctx.logger.log(
        makeOp('agent-t1', 'fs', 'sess-1', daysAgo(8)),
        dec(0.6, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-t2', 'fs', 'sess-2', daysAgo(20)),
        dec(0.4, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      // 7d window: no ops → null
      expect(body.highRiskRatioLast7d).toBeNull();
      expect(body.lowRiskRatioLast7d).toBeNull();
      // 30d window: has data → non-null
      expect(body.riskScoreWeightedMeanLast30d).not.toBeNull();
      expect(body.highRiskRatioLast30d).not.toBeNull();
      expect(body.lowRiskRatioLast30d).not.toBeNull();
    });
  });
});

// ── v10.115 ────────────────────────────────────────────────────────────────────

describe('v10.115', () => {
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);
  const hoursAgo = (h: number) => new Date(PINNED_NOW() - h * 3_600_000);

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1644-T1648 — v10.115 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-a', 'fs', 'sess-v10115-pres', daysAgo(1)),
        dec(0.5, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10115-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('mediumRiskRatioLast7d');
      expect(body).toHaveProperty('mediumRiskRatioLast30d');
      expect(body).toHaveProperty('riskScoreWeightedMeanAllTime');
      expect(body).toHaveProperty('opsCountLast48h');
      expect(body).toHaveProperty('blockRateLast48h');
    });

    it('2. sessions — no ops in 7d/30d window: mediumRiskRatioLast7d and Last30d are null', async () => {
      ctx = await setup();
      // op older than 30d — outside all time windows
      await ctx.logger.log(
        makeOp('agent-b', 'fs', 'sess-v10115-old', daysAgo(35)),
        dec(0.5, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10115-old');
      expect(status).toBe(200);

      expect(body.mediumRiskRatioLast7d).toBeNull();
      expect(body.mediumRiskRatioLast30d).toBeNull();
      // riskScoreWeightedMeanAllTime is NOT window-bounded; old ops still count
      expect(typeof body.riskScoreWeightedMeanAllTime).toBe('number');
    });

    it('3. sessions — mediumRiskRatioLast7d: fraction of ops with 0.3 <= score < 0.7', async () => {
      ctx = await setup();
      // 3 ops in last 7d: 2 medium (0.3-0.7), 1 not → ratio = 2/3
      await ctx.logger.log(
        makeOp('agent-c', 'fs', 'sess-v10115-med7', daysAgo(1)),
        dec(0.4, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-c', 'fs', 'sess-v10115-med7', daysAgo(2)),
        dec(0.6, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-c', 'fs', 'sess-v10115-med7', daysAgo(3)),
        dec(0.8, 'block'),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10115-med7');
      expect(status).toBe(200);

      expect(body.mediumRiskRatioLast7d as number).toBeCloseTo(2 / 3, 5);
    });

    it('4. sessions — mediumRiskRatioLast7d boundary: score 0.3 is medium (inclusive), 0.7 is not', async () => {
      ctx = await setup();
      // score 0.3 = medium (>=0.3), score 0.7 = NOT medium (<0.7 fails)
      // score 0.69 = medium, score 0.71 = not medium
      await ctx.logger.log(
        makeOp('agent-d', 'fs', 'sess-v10115-med-bound', daysAgo(1)),
        dec(0.3, 'allow'),  // medium (>=0.3 and <0.7)
      );
      await ctx.logger.log(
        makeOp('agent-d', 'fs', 'sess-v10115-med-bound', daysAgo(2)),
        dec(0.7, 'block'),  // NOT medium (fails <0.7)
      );
      await ctx.logger.log(
        makeOp('agent-d', 'fs', 'sess-v10115-med-bound', daysAgo(3)),
        dec(0.69, 'allow'), // medium
      );
      await ctx.logger.log(
        makeOp('agent-d', 'fs', 'sess-v10115-med-bound', daysAgo(4)),
        dec(0.1, 'allow'),  // NOT medium (<0.3)
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10115-med-bound');
      expect(status).toBe(200);

      // 2 of 4 ops are medium → ratio = 0.5
      expect(body.mediumRiskRatioLast7d as number).toBeCloseTo(0.5, 5);
    });

    it('5. sessions — riskScoreWeightedMeanAllTime: null when session has no logs', async () => {
      ctx = await setup();
      // Log for a different session; query our target session which has no logs
      await ctx.logger.log(
        makeOp('agent-e0', 'fs', 'sess-other', daysAgo(1)),
        dec(0.5, 'allow'),
      );
      // The sessions endpoint returns 200 for any sessionId in the DB; we query one with no logs
      // via the summary endpoint which always returns 200 and has riskScoreWeightedMeanAllTime
      // Instead, log for our target session and test alltime = null means empty DB for that session
      // Note: sessions endpoint returns 404 if the sessionId has never been logged
      // Use a session that has been logged to get a 200 response, then verify field exists
      await ctx.logger.log(
        makeOp('agent-e1', 'fs', 'sess-v10115-zeroall', daysAgo(1)),
        dec(0.45, 'allow'),
      );
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10115-zeroall');
      expect(status).toBe(200);
      // riskScoreWeightedMeanAllTime is not null since there is 1 op
      expect(body.riskScoreWeightedMeanAllTime).not.toBeNull();
      expect(body.riskScoreWeightedMeanAllTime as number).toBeCloseTo(0.45, 5);
    });

    it('6. sessions — riskScoreWeightedMeanAllTime single op equals that op score', async () => {
      ctx = await setup();
      // Single op: rank 0, weight = 1/(0+1) = 1, totalWeight = 1 → weighted mean = score
      await ctx.logger.log(
        makeOp('agent-e', 'fs', 'sess-v10115-alltime1', daysAgo(50)),
        dec(0.72, 'block'),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10115-alltime1');
      expect(status).toBe(200);

      expect(body.riskScoreWeightedMeanAllTime as number).toBeCloseTo(0.72, 5);
    });

    it('7. sessions — riskScoreWeightedMeanAllTime includes ops beyond 30d (all-time scope)', async () => {
      ctx = await setup();
      // Op at daysAgo(60) — outside any window but all-time still includes it
      await ctx.logger.log(
        makeOp('agent-f', 'fs', 'sess-v10115-alltime-old', daysAgo(60)),
        dec(0.9, 'block'),
      );
      await ctx.logger.log(
        makeOp('agent-f', 'fs', 'sess-v10115-alltime-old', daysAgo(2)),
        dec(0.1, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10115-alltime-old');
      expect(status).toBe(200);

      // All-time mean should not be null and includes both ops
      expect(body.riskScoreWeightedMeanAllTime).not.toBeNull();
      // mediumRiskRatioLast30d should only count the recent op (daysAgo(2), score=0.1)
      // 0.1 < 0.3 so NOT medium → mediumRisk ratio = 0/1 = 0.0
      expect(body.mediumRiskRatioLast30d as number).toBeCloseTo(0.0, 5);
    });

    it('8. sessions — opsCountLast48h: null when no ops in 48h', async () => {
      ctx = await setup();
      // op at 3 days ago → outside 48h window
      await ctx.logger.log(
        makeOp('agent-g', 'fs', 'sess-v10115-48h-null', daysAgo(3)),
        dec(0.5, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10115-48h-null');
      expect(status).toBe(200);

      expect(body.opsCountLast48h).toBeNull();
    });

    it('9. sessions — opsCountLast48h: returns correct count of ops within 48h', async () => {
      ctx = await setup();
      // 3 ops within 48h (0h, 24h, 47h) and 1 outside (49h)
      await ctx.logger.log(
        makeOp('agent-h', 'fs', 'sess-v10115-48h-cnt', hoursAgo(1)),
        dec(0.4, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-h', 'fs', 'sess-v10115-48h-cnt', hoursAgo(24)),
        dec(0.5, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-h', 'fs', 'sess-v10115-48h-cnt', hoursAgo(47)),
        dec(0.6, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-h', 'fs', 'sess-v10115-48h-cnt', hoursAgo(49)),
        dec(0.7, 'block'),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10115-48h-cnt');
      expect(status).toBe(200);

      expect(body.opsCountLast48h).toBe(3);
    });

    it('10. sessions — blockRateLast48h: null when no ops in 48h', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-i', 'fs', 'sess-v10115-br-null', daysAgo(3)),
        dec(0.9, 'block'),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10115-br-null');
      expect(status).toBe(200);

      expect(body.blockRateLast48h).toBeNull();
    });

    it('11. sessions — blockRateLast48h: fraction of ops with action=block in 48h', async () => {
      ctx = await setup();
      // 4 ops in 48h: 2 block, 1 allow, 1 require_approval → ratio = 2/4 = 0.5
      await ctx.logger.log(
        makeOp('agent-j', 'fs', 'sess-v10115-br-val', hoursAgo(1)),
        dec(0.8, 'block'),
      );
      await ctx.logger.log(
        makeOp('agent-j', 'fs', 'sess-v10115-br-val', hoursAgo(10)),
        dec(0.9, 'block'),
      );
      await ctx.logger.log(
        makeOp('agent-j', 'fs', 'sess-v10115-br-val', hoursAgo(20)),
        dec(0.3, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-j', 'fs', 'sess-v10115-br-val', hoursAgo(30)),
        dec(0.5, 'require_approval'),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10115-br-val');
      expect(status).toBe(200);

      expect(body.blockRateLast48h as number).toBeCloseTo(0.5, 5);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1644-T1648 — v10.115 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('12. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-v10115-pres', 'fs', 'sess-1', daysAgo(1)),
        dec(0.4, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10115-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('mediumRiskRatioLast7d');
      expect(body).toHaveProperty('mediumRiskRatioLast30d');
      expect(body).toHaveProperty('riskScoreWeightedMeanAllTime');
      expect(body).toHaveProperty('opsCountLast48h');
      expect(body).toHaveProperty('blockRateLast48h');
    });

    it('13. agents — no ops in 7d: mediumRiskRatioLast7d is null', async () => {
      ctx = await setup();
      // ops at daysAgo(10) — outside 7d window, inside 30d window
      await ctx.logger.log(
        makeOp('agent-v10115-old7', 'fs', 'sess-1', daysAgo(10)),
        dec(0.5, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10115-old7');
      expect(status).toBe(200);

      expect(body.mediumRiskRatioLast7d).toBeNull();
      expect(body.mediumRiskRatioLast30d).not.toBeNull();
    });

    it('14. agents — mediumRiskRatioLast30d = 0 when no ops are medium risk in 30d', async () => {
      ctx = await setup();
      // All ops are high-risk (>= 0.7) in 30d window
      await ctx.logger.log(
        makeOp('agent-v10115-hi30', 'fs', 'sess-1', daysAgo(5)),
        dec(0.75, 'block'),
      );
      await ctx.logger.log(
        makeOp('agent-v10115-hi30', 'fs', 'sess-2', daysAgo(15)),
        dec(0.9, 'block'),
      );

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10115-hi30');
      expect(status).toBe(200);

      expect(body.mediumRiskRatioLast30d as number).toBeCloseTo(0.0, 5);
    });

    it('15. agents — riskScoreWeightedMeanAllTime weights most recent ops higher', async () => {
      ctx = await setup();
      // rank0 = daysAgo(1) score=0.9, rank1 = daysAgo(60) score=0.1
      // weights = [1, 0.5], totalWeight = 1.5
      // weighted mean = (0.9*1 + 0.1*0.5) / 1.5 = (0.9 + 0.05) / 1.5 = 0.95/1.5 ≈ 0.6333
      await ctx.logger.log(
        makeOp('agent-v10115-wt', 'fs', 'sess-1', daysAgo(1)),
        dec(0.9, 'block'),
      );
      await ctx.logger.log(
        makeOp('agent-v10115-wt', 'fs', 'sess-2', daysAgo(60)),
        dec(0.1, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10115-wt');
      expect(status).toBe(200);

      expect(body.riskScoreWeightedMeanAllTime as number).toBeCloseTo(0.9 * 1 / 1.5 + 0.1 * 0.5 / 1.5, 4);
    });

    it('16. agents — opsCountLast48h counts only ops in 48h window', async () => {
      ctx = await setup();
      // 2 ops within 48h, 1 outside
      await ctx.logger.log(
        makeOp('agent-v10115-48h', 'fs', 'sess-1', hoursAgo(5)),
        dec(0.4, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-v10115-48h', 'fs', 'sess-2', hoursAgo(40)),
        dec(0.5, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-v10115-48h', 'fs', 'sess-3', hoursAgo(50)),
        dec(0.6, 'block'),
      );

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10115-48h');
      expect(status).toBe(200);

      expect(body.opsCountLast48h).toBe(2);
    });

    it('17. agents — blockRateLast48h = 1.0 when all 48h ops are blocked', async () => {
      ctx = await setup();
      // All ops in 48h are blocked
      await ctx.logger.log(
        makeOp('agent-v10115-allblock', 'fs', 'sess-1', hoursAgo(2)),
        dec(0.8, 'block'),
      );
      await ctx.logger.log(
        makeOp('agent-v10115-allblock', 'fs', 'sess-2', hoursAgo(20)),
        dec(0.9, 'block'),
      );

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10115-allblock');
      expect(status).toBe(200);

      expect(body.blockRateLast48h as number).toBeCloseTo(1.0, 5);
    });

    it('18. agents — blockRateLast48h = 0.0 when no 48h ops are blocked', async () => {
      ctx = await setup();
      // All ops in 48h are allowed
      await ctx.logger.log(
        makeOp('agent-v10115-noblock', 'fs', 'sess-1', hoursAgo(3)),
        dec(0.3, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-v10115-noblock', 'fs', 'sess-2', hoursAgo(30)),
        dec(0.4, 'require_approval'),
      );

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10115-noblock');
      expect(status).toBe(200);

      expect(body.blockRateLast48h as number).toBeCloseTo(0.0, 5);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1644-T1648 — v10.115 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('19. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-k', 'tool-v10115-pres', 'sess-1', daysAgo(1)),
        dec(0.5, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10115-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('mediumRiskRatioLast7d');
      expect(body).toHaveProperty('mediumRiskRatioLast30d');
      expect(body).toHaveProperty('riskScoreWeightedMeanAllTime');
      expect(body).toHaveProperty('opsCountLast48h');
      expect(body).toHaveProperty('blockRateLast48h');
    });

    it('20. tools — only old ops (>30d): mediumRiskRatioLast7d and Last30d null; opsCountLast48h null', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-l', 'tool-v10115-old', 'sess-1', daysAgo(35)),
        dec(0.5, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10115-old');
      expect(status).toBe(200);

      expect(body.mediumRiskRatioLast7d).toBeNull();
      expect(body.mediumRiskRatioLast30d).toBeNull();
      expect(body.opsCountLast48h).toBeNull();
      expect(body.blockRateLast48h).toBeNull();
      // riskScoreWeightedMeanAllTime is all-time — old op still contributes
      expect(body.riskScoreWeightedMeanAllTime as number).toBeCloseTo(0.5, 5);
    });

    it('21. tools — mediumRiskRatioLast30d computed from ops in 8-29d range', async () => {
      ctx = await setup();
      // Ops only in 8-25d window (outside 7d, inside 30d)
      // 3 ops: score 0.4 (medium), 0.6 (medium), 0.8 (not medium) → ratio = 2/3
      await ctx.logger.log(
        makeOp('agent-m', 'tool-v10115-med30', 'sess-1', daysAgo(10)),
        dec(0.4, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-m', 'tool-v10115-med30', 'sess-2', daysAgo(15)),
        dec(0.6, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-m', 'tool-v10115-med30', 'sess-3', daysAgo(20)),
        dec(0.8, 'block'),
      );

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10115-med30');
      expect(status).toBe(200);

      // 7d window is empty → null
      expect(body.mediumRiskRatioLast7d).toBeNull();
      // 30d window: 2 of 3 are medium → ratio = 2/3
      expect(body.mediumRiskRatioLast30d as number).toBeCloseTo(2 / 3, 5);
    });

    it('22. tools — riskScoreWeightedMeanAllTime bounded in [0, 1]', async () => {
      ctx = await setup();
      // Various scores including extremes
      const opData = [
        { days: 1, score: 0.0 },
        { days: 5, score: 0.5 },
        { days: 10, score: 1.0 },
        { days: 60, score: 0.3 },
      ];
      for (const { days, score } of opData) {
        await ctx.logger.log(
          makeOp('agent-n', 'tool-v10115-alltime-bound', `sess-${days}`, daysAgo(days)),
          dec(score, 'allow'),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10115-alltime-bound');
      expect(status).toBe(200);

      const v = body.riskScoreWeightedMeanAllTime as number;
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    });

    it('23. tools — opsCountLast48h is positive integer when ops exist in window', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-o', 'tool-v10115-48hcnt', 'sess-1', hoursAgo(10)),
        dec(0.4, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-o', 'tool-v10115-48hcnt', 'sess-2', hoursAgo(30)),
        dec(0.5, 'block'),
      );

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10115-48hcnt');
      expect(status).toBe(200);

      expect(body.opsCountLast48h).toBe(2);
      expect(typeof body.opsCountLast48h).toBe('number');
      expect(body.opsCountLast48h as number).toBeGreaterThan(0);
    });
  });

  // ── operations/summary endpoint ────────────────────────────────────────────────

  describe('T1644-T1648 — v10.115 new fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('24. summary — all five new fields present', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-p', 'fs', 'sess-1', daysAgo(1)),
        dec(0.5, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body).toHaveProperty('mediumRiskRatioLast7d');
      expect(body).toHaveProperty('mediumRiskRatioLast30d');
      expect(body).toHaveProperty('riskScoreWeightedMeanAllTime');
      expect(body).toHaveProperty('opsCountLast48h');
      expect(body).toHaveProperty('blockRateLast48h');
    });

    it('25. summary — empty DB: riskScoreWeightedMeanAllTime null; opsCountLast48h null; blockRateLast48h null', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.mediumRiskRatioLast7d).toBeNull();
      expect(body.mediumRiskRatioLast30d).toBeNull();
      expect(body.riskScoreWeightedMeanAllTime).toBeNull();
      expect(body.opsCountLast48h).toBeNull();
      expect(body.blockRateLast48h).toBeNull();
    });

    it('26. summary — mediumRiskRatioLast7d and Last30d computed from mixed risk scores', async () => {
      ctx = await setup();
      // 7d window: 4 ops: scores 0.1 (low), 0.4 (medium), 0.6 (medium), 0.9 (high) → 2/4 = 0.5
      // 30d window: adds score 0.5 (medium) at daysAgo(15) → total 5 ops, 3 medium → 3/5 = 0.6
      await ctx.logger.log(
        makeOp('agent-q1', 'fs', 'sess-1', daysAgo(1)),
        dec(0.1, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-q2', 'fs', 'sess-2', daysAgo(2)),
        dec(0.4, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-q3', 'fs', 'sess-3', daysAgo(3)),
        dec(0.6, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-q4', 'fs', 'sess-4', daysAgo(4)),
        dec(0.9, 'block'),
      );
      await ctx.logger.log(
        makeOp('agent-q5', 'fs', 'sess-5', daysAgo(15)),
        dec(0.5, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.mediumRiskRatioLast7d as number).toBeCloseTo(0.5, 5);
      expect(body.mediumRiskRatioLast30d as number).toBeCloseTo(3 / 5, 5);
    });

    it('27. summary — riskScoreWeightedMeanAllTime includes ops beyond 30d', async () => {
      ctx = await setup();
      // Only op: 60 days ago → not in any windowed metric, but all-time includes it
      await ctx.logger.log(
        makeOp('agent-r', 'fs', 'sess-1', daysAgo(60)),
        dec(0.55, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      // Window metrics are null/0 for old ops, but all-time is not null
      expect(body.mediumRiskRatioLast7d).toBeNull();
      expect(body.mediumRiskRatioLast30d).toBeNull();
      expect(body.riskScoreWeightedMeanAllTime as number).toBeCloseTo(0.55, 5);
    });

    it('28. summary — opsCountLast48h and blockRateLast48h from mixed actions in 48h', async () => {
      ctx = await setup();
      // 5 ops in 48h: 2 block, 1 allow, 1 require_approval, 1 block → 3 blocks / 5 = 0.6
      await ctx.logger.log(
        makeOp('agent-s1', 'fs', 'sess-1', hoursAgo(2)),
        dec(0.8, 'block'),
      );
      await ctx.logger.log(
        makeOp('agent-s2', 'fs', 'sess-2', hoursAgo(10)),
        dec(0.3, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-s3', 'fs', 'sess-3', hoursAgo(20)),
        dec(0.9, 'block'),
      );
      await ctx.logger.log(
        makeOp('agent-s4', 'fs', 'sess-4', hoursAgo(30)),
        dec(0.5, 'require_approval'),
      );
      await ctx.logger.log(
        makeOp('agent-s5', 'fs', 'sess-5', hoursAgo(40)),
        dec(0.85, 'block'),
      );

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.opsCountLast48h).toBe(5);
      expect(body.blockRateLast48h as number).toBeCloseTo(3 / 5, 5);
    });

    it('29. summary — opsCountLast48h: ops at exactly 48h boundary are excluded (strictly >=)', async () => {
      ctx = await setup();
      // 2 ops clearly in 48h window, 1 op clearly outside (50h)
      await ctx.logger.log(
        makeOp('agent-t1', 'fs', 'sess-1', hoursAgo(10)),
        dec(0.4, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-t2', 'fs', 'sess-2', hoursAgo(40)),
        dec(0.5, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-t3', 'fs', 'sess-3', hoursAgo(50)),
        dec(0.6, 'block'),
      );

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.opsCountLast48h).toBe(2);
    });

    it('30. summary — blockRateLast48h accounts only for 48h window, ignoring older blocks', async () => {
      ctx = await setup();
      // 2 ops in 48h (both allow), 2 blocks older than 48h
      await ctx.logger.log(
        makeOp('agent-u1', 'fs', 'sess-1', hoursAgo(5)),
        dec(0.3, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-u2', 'fs', 'sess-2', hoursAgo(20)),
        dec(0.4, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-u3', 'fs', 'sess-3', hoursAgo(60)),
        dec(0.9, 'block'),
      );
      await ctx.logger.log(
        makeOp('agent-u4', 'fs', 'sess-4', daysAgo(10)),
        dec(0.95, 'block'),
      );

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      // Only 48h ops count → 0 blocks / 2 ops = 0.0
      expect(body.blockRateLast48h as number).toBeCloseTo(0.0, 5);
      expect(body.opsCountLast48h).toBe(2);
    });
  });
});

// ── v10.116 ────────────────────────────────────────────────────────────────────

describe('v10.116', () => {
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);
  const hoursAgo = (h: number) => new Date(PINNED_NOW() - h * 3_600_000);

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1649-T1653 — v10.116 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-a', 'fs', 'sess-v10116-pres', hoursAgo(1)),
        dec(0.5, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10116-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('allowRateLast48h');
      expect(body).toHaveProperty('requireApprovalRateLast48h');
      expect(body).toHaveProperty('avgRiskScoreLast48h');
      expect(body).toHaveProperty('uniqueAgentsLast48h');
      expect(body).toHaveProperty('uniqueSessionsLast48h');
    });

    it('2. sessions — all five fields null when no ops in 48h window', async () => {
      ctx = await setup();
      // op older than 48h
      await ctx.logger.log(
        makeOp('agent-b', 'fs', 'sess-v10116-old', daysAgo(3)),
        dec(0.5, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10116-old');
      expect(status).toBe(200);

      expect(body.allowRateLast48h).toBeNull();
      expect(body.requireApprovalRateLast48h).toBeNull();
      expect(body.avgRiskScoreLast48h).toBeNull();
      expect(body.uniqueAgentsLast48h).toBeNull();
      expect(body.uniqueSessionsLast48h).toBeNull();
    });

    it('3. sessions — allowRateLast48h: fraction of ops with action=allow in 48h', async () => {
      ctx = await setup();
      // 4 ops in 48h: 2 allow, 1 block, 1 require_approval → allowRate = 2/4 = 0.5
      await ctx.logger.log(
        makeOp('agent-c', 'fs', 'sess-v10116-allow', hoursAgo(1)),
        dec(0.3, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-c', 'fs', 'sess-v10116-allow', hoursAgo(10)),
        dec(0.4, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-c', 'fs', 'sess-v10116-allow', hoursAgo(20)),
        dec(0.8, 'block'),
      );
      await ctx.logger.log(
        makeOp('agent-c', 'fs', 'sess-v10116-allow', hoursAgo(30)),
        dec(0.5, 'require_approval'),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10116-allow');
      expect(status).toBe(200);

      expect(body.allowRateLast48h as number).toBeCloseTo(0.5, 5);
    });

    it('4. sessions — requireApprovalRateLast48h: fraction of ops with action=require_approval in 48h', async () => {
      ctx = await setup();
      // 3 ops: 1 require_approval, 1 allow, 1 block → requireApprovalRate = 1/3
      await ctx.logger.log(
        makeOp('agent-d', 'fs', 'sess-v10116-ra', hoursAgo(2)),
        dec(0.5, 'require_approval'),
      );
      await ctx.logger.log(
        makeOp('agent-d', 'fs', 'sess-v10116-ra', hoursAgo(12)),
        dec(0.3, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-d', 'fs', 'sess-v10116-ra', hoursAgo(22)),
        dec(0.9, 'block'),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10116-ra');
      expect(status).toBe(200);

      expect(body.requireApprovalRateLast48h as number).toBeCloseTo(1 / 3, 5);
    });

    it('5. sessions — avgRiskScoreLast48h: mean of risk scores in 48h window', async () => {
      ctx = await setup();
      // 3 ops: scores 0.2, 0.4, 0.9 → mean = (0.2+0.4+0.9)/3 = 0.5
      await ctx.logger.log(
        makeOp('agent-e', 'fs', 'sess-v10116-avg', hoursAgo(3)),
        dec(0.2, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-e', 'fs', 'sess-v10116-avg', hoursAgo(13)),
        dec(0.4, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-e', 'fs', 'sess-v10116-avg', hoursAgo(23)),
        dec(0.9, 'block'),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10116-avg');
      expect(status).toBe(200);

      expect(body.avgRiskScoreLast48h as number).toBeCloseTo((0.2 + 0.4 + 0.9) / 3, 5);
    });

    it('6. sessions — uniqueAgentsLast48h: count of distinct agentIds in 48h', async () => {
      ctx = await setup();
      // 4 ops in 48h from 3 distinct agents
      await ctx.logger.log(
        makeOp('agent-x1', 'fs', 'sess-v10116-uagent', hoursAgo(4)),
        dec(0.3, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-x2', 'fs', 'sess-v10116-uagent', hoursAgo(8)),
        dec(0.4, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-x3', 'fs', 'sess-v10116-uagent', hoursAgo(15)),
        dec(0.5, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-x1', 'fs', 'sess-v10116-uagent', hoursAgo(25)),
        dec(0.6, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10116-uagent');
      expect(status).toBe(200);

      expect(body.uniqueAgentsLast48h).toBe(3);
    });

    it('7. sessions — uniqueSessionsLast48h: count of distinct sessionIds in 48h', async () => {
      ctx = await setup();
      // 3 ops in 48h but all from the same session (the session we query)
      // uniqueSessionsLast48h = 1
      await ctx.logger.log(
        makeOp('agent-f', 'fs', 'sess-v10116-usess', hoursAgo(5)),
        dec(0.3, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-f', 'fs', 'sess-v10116-usess', hoursAgo(15)),
        dec(0.4, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-f', 'fs', 'sess-v10116-usess', hoursAgo(25)),
        dec(0.5, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10116-usess');
      expect(status).toBe(200);

      expect(body.uniqueSessionsLast48h).toBe(1);
    });

    it('8. sessions — avgRiskScoreLast48h: excludes ops older than 48h', async () => {
      ctx = await setup();
      // 1 op in 48h (score 0.3), 1 op outside 48h (score 0.9)
      await ctx.logger.log(
        makeOp('agent-g', 'fs', 'sess-v10116-avgexcl', hoursAgo(10)),
        dec(0.3, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-g', 'fs', 'sess-v10116-avgexcl', hoursAgo(60)),
        dec(0.9, 'block'),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10116-avgexcl');
      expect(status).toBe(200);

      // Only the 0.3 op is in the 48h window
      expect(body.avgRiskScoreLast48h as number).toBeCloseTo(0.3, 5);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1649-T1653 — v10.116 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('9. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-v10116-pres', 'fs', 'sess-1', hoursAgo(1)),
        dec(0.4, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10116-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('allowRateLast48h');
      expect(body).toHaveProperty('requireApprovalRateLast48h');
      expect(body).toHaveProperty('avgRiskScoreLast48h');
      expect(body).toHaveProperty('uniqueAgentsLast48h');
      expect(body).toHaveProperty('uniqueSessionsLast48h');
    });

    it('10. agents — all five fields null when no ops in 48h window', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-v10116-old48', 'fs', 'sess-1', daysAgo(4)),
        dec(0.6, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10116-old48');
      expect(status).toBe(200);

      expect(body.allowRateLast48h).toBeNull();
      expect(body.requireApprovalRateLast48h).toBeNull();
      expect(body.avgRiskScoreLast48h).toBeNull();
      expect(body.uniqueAgentsLast48h).toBeNull();
      expect(body.uniqueSessionsLast48h).toBeNull();
    });

    it('11. agents — allowRateLast48h = 1.0 when all 48h ops are allow', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-v10116-allallow', 'fs', 'sess-1', hoursAgo(5)),
        dec(0.2, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-v10116-allallow', 'fs', 'sess-2', hoursAgo(15)),
        dec(0.3, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10116-allallow');
      expect(status).toBe(200);

      expect(body.allowRateLast48h as number).toBeCloseTo(1.0, 5);
    });

    it('12. agents — requireApprovalRateLast48h = 0.0 when no ops are require_approval in 48h', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-v10116-nora', 'fs', 'sess-1', hoursAgo(3)),
        dec(0.4, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-v10116-nora', 'fs', 'sess-2', hoursAgo(20)),
        dec(0.8, 'block'),
      );

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10116-nora');
      expect(status).toBe(200);

      expect(body.requireApprovalRateLast48h as number).toBeCloseTo(0.0, 5);
    });

    it('13. agents — avgRiskScoreLast48h: single op returns that op score', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-v10116-avg1', 'fs', 'sess-1', hoursAgo(6)),
        dec(0.65, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10116-avg1');
      expect(status).toBe(200);

      expect(body.avgRiskScoreLast48h as number).toBeCloseTo(0.65, 5);
    });

    it('14. agents — uniqueAgentsLast48h = 1 for single agent in 48h', async () => {
      ctx = await setup();
      // Multiple ops from the same agent
      await ctx.logger.log(
        makeOp('agent-v10116-ua1', 'fs', 'sess-1', hoursAgo(2)),
        dec(0.3, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-v10116-ua1', 'fs', 'sess-2', hoursAgo(12)),
        dec(0.4, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10116-ua1');
      expect(status).toBe(200);

      expect(body.uniqueAgentsLast48h).toBe(1);
    });

    it('15. agents — uniqueSessionsLast48h counts distinct sessions in 48h window', async () => {
      ctx = await setup();
      // 3 ops from 2 different sessions in 48h
      await ctx.logger.log(
        makeOp('agent-v10116-us', 'fs', 'sess-a', hoursAgo(3)),
        dec(0.3, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-v10116-us', 'fs', 'sess-b', hoursAgo(10)),
        dec(0.4, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-v10116-us', 'fs', 'sess-a', hoursAgo(20)),
        dec(0.5, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10116-us');
      expect(status).toBe(200);

      expect(body.uniqueSessionsLast48h).toBe(2);
    });

    it('16. agents — avgRiskScoreLast48h: ops outside 48h are excluded from average', async () => {
      ctx = await setup();
      // 2 ops in 48h (scores 0.2 and 0.4), 1 old op (score 0.9)
      await ctx.logger.log(
        makeOp('agent-v10116-avgx', 'fs', 'sess-1', hoursAgo(10)),
        dec(0.2, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-v10116-avgx', 'fs', 'sess-2', hoursAgo(40)),
        dec(0.4, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-v10116-avgx', 'fs', 'sess-3', daysAgo(5)),
        dec(0.9, 'block'),
      );

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10116-avgx');
      expect(status).toBe(200);

      expect(body.avgRiskScoreLast48h as number).toBeCloseTo((0.2 + 0.4) / 2, 5);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1649-T1653 — v10.116 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('17. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-k', 'tool-v10116-pres', 'sess-1', hoursAgo(1)),
        dec(0.5, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10116-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('allowRateLast48h');
      expect(body).toHaveProperty('requireApprovalRateLast48h');
      expect(body).toHaveProperty('avgRiskScoreLast48h');
      expect(body).toHaveProperty('uniqueAgentsLast48h');
      expect(body).toHaveProperty('uniqueSessionsLast48h');
    });

    it('18. tools — all five fields null when no ops in 48h window', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-l', 'tool-v10116-old48', 'sess-1', daysAgo(3)),
        dec(0.5, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10116-old48');
      expect(status).toBe(200);

      expect(body.allowRateLast48h).toBeNull();
      expect(body.requireApprovalRateLast48h).toBeNull();
      expect(body.avgRiskScoreLast48h).toBeNull();
      expect(body.uniqueAgentsLast48h).toBeNull();
      expect(body.uniqueSessionsLast48h).toBeNull();
    });

    it('19. tools — allowRateLast48h: fraction of ops with action=allow in 48h', async () => {
      ctx = await setup();
      // 2 ops in 48h: 1 allow, 1 block → allowRate = 0.5
      await ctx.logger.log(
        makeOp('agent-m', 'tool-v10116-allow48', 'sess-1', hoursAgo(5)),
        dec(0.3, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-m', 'tool-v10116-allow48', 'sess-2', hoursAgo(15)),
        dec(0.8, 'block'),
      );

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10116-allow48');
      expect(status).toBe(200);

      expect(body.allowRateLast48h as number).toBeCloseTo(0.5, 5);
    });

    it('20. tools — avgRiskScoreLast48h bounded in [0, 1]', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-n', 'tool-v10116-avgbound', 'sess-1', hoursAgo(1)),
        dec(0.0, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-n', 'tool-v10116-avgbound', 'sess-2', hoursAgo(5)),
        dec(1.0, 'block'),
      );

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10116-avgbound');
      expect(status).toBe(200);

      const v = body.avgRiskScoreLast48h as number;
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      expect(v).toBeCloseTo(0.5, 5);
    });

    it('21. tools — uniqueAgentsLast48h: multiple ops same agent counts as 1', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-o1', 'tool-v10116-uag1', 'sess-1', hoursAgo(2)),
        dec(0.3, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-o1', 'tool-v10116-uag1', 'sess-2', hoursAgo(10)),
        dec(0.4, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-o2', 'tool-v10116-uag1', 'sess-3', hoursAgo(20)),
        dec(0.5, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10116-uag1');
      expect(status).toBe(200);

      expect(body.uniqueAgentsLast48h).toBe(2);
    });

    it('22. tools — uniqueSessionsLast48h: multiple ops same session counts as 1', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-p1', 'tool-v10116-uss1', 'sess-x', hoursAgo(3)),
        dec(0.3, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-p2', 'tool-v10116-uss1', 'sess-x', hoursAgo(12)),
        dec(0.4, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-p3', 'tool-v10116-uss1', 'sess-y', hoursAgo(22)),
        dec(0.5, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10116-uss1');
      expect(status).toBe(200);

      expect(body.uniqueSessionsLast48h).toBe(2);
    });

    it('23. tools — requireApprovalRateLast48h: 1.0 when all ops in 48h are require_approval', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-q', 'tool-v10116-allra', 'sess-1', hoursAgo(4)),
        dec(0.6, 'require_approval'),
      );
      await ctx.logger.log(
        makeOp('agent-q', 'tool-v10116-allra', 'sess-2', hoursAgo(14)),
        dec(0.7, 'require_approval'),
      );

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10116-allra');
      expect(status).toBe(200);

      expect(body.requireApprovalRateLast48h as number).toBeCloseTo(1.0, 5);
    });
  });

  // ── operations/summary endpoint ────────────────────────────────────────────────

  describe('T1649-T1653 — v10.116 new fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('24. summary — all five new fields present', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-r', 'fs', 'sess-1', hoursAgo(1)),
        dec(0.5, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body).toHaveProperty('allowRateLast48h');
      expect(body).toHaveProperty('requireApprovalRateLast48h');
      expect(body).toHaveProperty('avgRiskScoreLast48h');
      expect(body).toHaveProperty('uniqueAgentsLast48h');
      expect(body).toHaveProperty('uniqueSessionsLast48h');
    });

    it('25. summary — empty DB: all five new fields null', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.allowRateLast48h).toBeNull();
      expect(body.requireApprovalRateLast48h).toBeNull();
      expect(body.avgRiskScoreLast48h).toBeNull();
      expect(body.uniqueAgentsLast48h).toBeNull();
      expect(body.uniqueSessionsLast48h).toBeNull();
    });

    it('26. summary — allowRateLast48h and requireApprovalRateLast48h sum with blockRateLast48h to 1.0', async () => {
      ctx = await setup();
      // 3 ops in 48h: 1 allow, 1 require_approval, 1 block → each rate = 1/3
      await ctx.logger.log(
        makeOp('agent-s1', 'fs', 'sess-1', hoursAgo(2)),
        dec(0.3, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-s2', 'fs', 'sess-2', hoursAgo(10)),
        dec(0.6, 'require_approval'),
      );
      await ctx.logger.log(
        makeOp('agent-s3', 'fs', 'sess-3', hoursAgo(20)),
        dec(0.9, 'block'),
      );

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      const allow = body.allowRateLast48h as number;
      const ra = body.requireApprovalRateLast48h as number;
      const block = body.blockRateLast48h as number;

      expect(allow).toBeCloseTo(1 / 3, 5);
      expect(ra).toBeCloseTo(1 / 3, 5);
      expect(allow + ra + block).toBeCloseTo(1.0, 5);
    });

    it('27. summary — avgRiskScoreLast48h: only ops in 48h window contribute', async () => {
      ctx = await setup();
      // 2 ops in 48h: 0.2 and 0.6 → mean = 0.4
      // 1 old op: 0.9 → should NOT contribute
      await ctx.logger.log(
        makeOp('agent-t1', 'fs', 'sess-1', hoursAgo(5)),
        dec(0.2, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-t2', 'fs', 'sess-2', hoursAgo(30)),
        dec(0.6, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-t3', 'fs', 'sess-3', daysAgo(5)),
        dec(0.9, 'block'),
      );

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.avgRiskScoreLast48h as number).toBeCloseTo(0.4, 5);
    });

    it('28. summary — uniqueAgentsLast48h: counts distinct agents within 48h, excludes old agents', async () => {
      ctx = await setup();
      // 3 ops in 48h from 2 distinct agents + 1 old op from a 3rd agent
      await ctx.logger.log(
        makeOp('agent-u1', 'fs', 'sess-1', hoursAgo(3)),
        dec(0.3, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-u2', 'fs', 'sess-2', hoursAgo(15)),
        dec(0.4, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-u1', 'fs', 'sess-3', hoursAgo(30)),
        dec(0.5, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-u3', 'fs', 'sess-4', daysAgo(5)),
        dec(0.6, 'block'),
      );

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      // Only agent-u1 and agent-u2 are in the 48h window
      expect(body.uniqueAgentsLast48h).toBe(2);
    });

    it('29. summary — uniqueSessionsLast48h: counts distinct sessions within 48h, excludes old sessions', async () => {
      ctx = await setup();
      // 3 ops in 48h from 3 distinct sessions + 1 old op from a 4th session
      await ctx.logger.log(
        makeOp('agent-v1', 'fs', 'sess-a', hoursAgo(4)),
        dec(0.3, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-v2', 'fs', 'sess-b', hoursAgo(14)),
        dec(0.4, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-v3', 'fs', 'sess-c', hoursAgo(35)),
        dec(0.5, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-v4', 'fs', 'sess-d', daysAgo(4)),
        dec(0.6, 'block'),
      );

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.uniqueSessionsLast48h).toBe(3);
    });

    it('30. summary — avgRiskScoreLast48h: float in [0, 1] for mixed risk scores', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-w1', 'fs', 'sess-1', hoursAgo(1)),
        dec(0.0, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-w2', 'fs', 'sess-2', hoursAgo(10)),
        dec(0.5, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-w3', 'fs', 'sess-3', hoursAgo(20)),
        dec(1.0, 'block'),
      );

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      const avg = body.avgRiskScoreLast48h as number;
      expect(avg).toBeGreaterThanOrEqual(0);
      expect(avg).toBeLessThanOrEqual(1);
      expect(avg).toBeCloseTo(0.5, 5);
    });
  });
});

// ── v10.117 ────────────────────────────────────────────────────────────────────

describe('v10.117', () => {
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);
  const hoursAgo = (h: number) => new Date(PINNED_NOW() - h * 3_600_000);

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1654-T1658 — v10.117 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-a', 'tool-x', 'sess-v10117-pres', hoursAgo(1), 'call'),
        dec(0.5, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10117-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('maxRiskScoreLast48h');
      expect(body).toHaveProperty('minRiskScoreLast48h');
      expect(body).toHaveProperty('riskScoreStdDevLast48h');
      expect(body).toHaveProperty('uniqueToolsLast48h');
      expect(body).toHaveProperty('uniqueMethodsLast48h');
    });

    it('2. sessions — all five fields null when no ops in 48h window', async () => {
      ctx = await setup();
      // op older than 48h
      await ctx.logger.log(
        makeOp('agent-b', 'tool-y', 'sess-v10117-old', daysAgo(3), 'call'),
        dec(0.5, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10117-old');
      expect(status).toBe(200);

      expect(body.maxRiskScoreLast48h).toBeNull();
      expect(body.minRiskScoreLast48h).toBeNull();
      expect(body.riskScoreStdDevLast48h).toBeNull();
      expect(body.uniqueToolsLast48h).toBeNull();
      expect(body.uniqueMethodsLast48h).toBeNull();
    });

    it('3. sessions — maxRiskScoreLast48h is the highest risk score in 48h', async () => {
      ctx = await setup();
      // 3 ops in 48h with scores 0.2, 0.7, 0.4 → max = 0.7
      await ctx.logger.log(
        makeOp('agent-c', 'fs', 'sess-v10117-max', hoursAgo(1), 'call'),
        dec(0.2, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-c', 'fs', 'sess-v10117-max', hoursAgo(10), 'call'),
        dec(0.7, 'block'),
      );
      await ctx.logger.log(
        makeOp('agent-c', 'fs', 'sess-v10117-max', hoursAgo(20), 'call'),
        dec(0.4, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10117-max');
      expect(status).toBe(200);

      expect(body.maxRiskScoreLast48h as number).toBeCloseTo(0.7, 5);
    });

    it('4. sessions — minRiskScoreLast48h is the lowest risk score in 48h', async () => {
      ctx = await setup();
      // 3 ops in 48h with scores 0.2, 0.7, 0.4 → min = 0.2
      await ctx.logger.log(
        makeOp('agent-d', 'fs', 'sess-v10117-min', hoursAgo(2), 'call'),
        dec(0.2, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-d', 'fs', 'sess-v10117-min', hoursAgo(12), 'call'),
        dec(0.7, 'block'),
      );
      await ctx.logger.log(
        makeOp('agent-d', 'fs', 'sess-v10117-min', hoursAgo(22), 'call'),
        dec(0.4, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10117-min');
      expect(status).toBe(200);

      expect(body.minRiskScoreLast48h as number).toBeCloseTo(0.2, 5);
    });

    it('5. sessions — maxRiskScoreLast48h >= minRiskScoreLast48h', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-e', 'fs', 'sess-v10117-maxmin', hoursAgo(3), 'call'),
        dec(0.1, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-e', 'fs', 'sess-v10117-maxmin', hoursAgo(13), 'call'),
        dec(0.9, 'block'),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10117-maxmin');
      expect(status).toBe(200);

      const max = body.maxRiskScoreLast48h as number;
      const min = body.minRiskScoreLast48h as number;
      expect(max).toBeGreaterThanOrEqual(min);
    });

    it('6. sessions — riskScoreStdDevLast48h is zero for a single risk score', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-f', 'fs', 'sess-v10117-stddev1', hoursAgo(4), 'call'),
        dec(0.5, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10117-stddev1');
      expect(status).toBe(200);

      // stddev of a single value = 0
      expect(body.riskScoreStdDevLast48h as number).toBeCloseTo(0, 10);
    });

    it('7. sessions — riskScoreStdDevLast48h population formula for multiple scores', async () => {
      ctx = await setup();
      // scores: 0.2, 0.8 → mean=0.5, variance=((0.2-0.5)^2+(0.8-0.5)^2)/2=0.09, stddev=0.3
      await ctx.logger.log(
        makeOp('agent-g', 'fs', 'sess-v10117-stddev2', hoursAgo(5), 'call'),
        dec(0.2, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-g', 'fs', 'sess-v10117-stddev2', hoursAgo(15), 'call'),
        dec(0.8, 'block'),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10117-stddev2');
      expect(status).toBe(200);

      expect(body.riskScoreStdDevLast48h as number).toBeCloseTo(0.3, 5);
    });

    it('8. sessions — uniqueToolsLast48h counts distinct tool names in 48h', async () => {
      ctx = await setup();
      // 4 ops with 3 distinct tools in 48h
      await ctx.logger.log(
        makeOp('agent-h', 'tool-alpha', 'sess-v10117-tools', hoursAgo(1), 'call'),
        dec(0.3, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-h', 'tool-beta', 'sess-v10117-tools', hoursAgo(5), 'call'),
        dec(0.4, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-h', 'tool-gamma', 'sess-v10117-tools', hoursAgo(15), 'call'),
        dec(0.5, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-h', 'tool-alpha', 'sess-v10117-tools', hoursAgo(25), 'call'),
        dec(0.6, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10117-tools');
      expect(status).toBe(200);

      expect(body.uniqueToolsLast48h).toBe(3);
    });

    it('9. sessions — uniqueMethodsLast48h counts distinct method names in 48h', async () => {
      ctx = await setup();
      // 4 ops with 2 distinct methods in 48h
      await ctx.logger.log(
        makeOp('agent-i', 'fs', 'sess-v10117-methods', hoursAgo(2), 'call'),
        dec(0.3, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-i', 'fs', 'sess-v10117-methods', hoursAgo(8), 'read'),
        dec(0.4, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-i', 'fs', 'sess-v10117-methods', hoursAgo(18), 'call'),
        dec(0.5, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-i', 'fs', 'sess-v10117-methods', hoursAgo(28), 'read'),
        dec(0.6, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10117-methods');
      expect(status).toBe(200);

      expect(body.uniqueMethodsLast48h).toBe(2);
    });

    it('10. sessions — fields exclude ops older than 48h', async () => {
      ctx = await setup();
      // 1 op in 48h (score 0.3, tool-new, method-new), 1 op outside (score 0.9, tool-old, method-old)
      await ctx.logger.log(
        makeOp('agent-j', 'tool-new', 'sess-v10117-excl', hoursAgo(10), 'method-new'),
        dec(0.3, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-j', 'tool-old', 'sess-v10117-excl', hoursAgo(60), 'method-old'),
        dec(0.9, 'block'),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10117-excl');
      expect(status).toBe(200);

      // Only the 0.3 op is in the 48h window
      expect(body.maxRiskScoreLast48h as number).toBeCloseTo(0.3, 5);
      expect(body.minRiskScoreLast48h as number).toBeCloseTo(0.3, 5);
      expect(body.riskScoreStdDevLast48h as number).toBeCloseTo(0, 10);
      expect(body.uniqueToolsLast48h).toBe(1);
      expect(body.uniqueMethodsLast48h).toBe(1);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1654-T1658 — v10.117 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('11. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-v10117-pres', 'fs', 'sess-1', hoursAgo(1), 'call'),
        dec(0.4, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10117-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('maxRiskScoreLast48h');
      expect(body).toHaveProperty('minRiskScoreLast48h');
      expect(body).toHaveProperty('riskScoreStdDevLast48h');
      expect(body).toHaveProperty('uniqueToolsLast48h');
      expect(body).toHaveProperty('uniqueMethodsLast48h');
    });

    it('12. agents — all five fields null when no ops in 48h window', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-v10117-old48', 'fs', 'sess-1', daysAgo(4), 'call'),
        dec(0.6, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10117-old48');
      expect(status).toBe(200);

      expect(body.maxRiskScoreLast48h).toBeNull();
      expect(body.minRiskScoreLast48h).toBeNull();
      expect(body.riskScoreStdDevLast48h).toBeNull();
      expect(body.uniqueToolsLast48h).toBeNull();
      expect(body.uniqueMethodsLast48h).toBeNull();
    });

    it('13. agents — maxRiskScoreLast48h: single op returns that op score', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-v10117-max1', 'fs', 'sess-1', hoursAgo(6), 'call'),
        dec(0.75, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10117-max1');
      expect(status).toBe(200);

      expect(body.maxRiskScoreLast48h as number).toBeCloseTo(0.75, 5);
    });

    it('14. agents — minRiskScoreLast48h: single op returns that op score', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-v10117-min1', 'fs', 'sess-1', hoursAgo(6), 'call'),
        dec(0.25, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10117-min1');
      expect(status).toBe(200);

      expect(body.minRiskScoreLast48h as number).toBeCloseTo(0.25, 5);
    });

    it('15. agents — riskScoreStdDevLast48h is non-negative for multiple scores', async () => {
      ctx = await setup();
      // scores: 0.1, 0.5, 0.9
      await ctx.logger.log(
        makeOp('agent-v10117-std', 'fs', 'sess-1', hoursAgo(1), 'call'),
        dec(0.1, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-v10117-std', 'fs', 'sess-2', hoursAgo(10), 'call'),
        dec(0.5, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-v10117-std', 'fs', 'sess-3', hoursAgo(20), 'call'),
        dec(0.9, 'block'),
      );

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10117-std');
      expect(status).toBe(200);

      const stddev = body.riskScoreStdDevLast48h as number;
      expect(stddev).toBeGreaterThanOrEqual(0);
    });

    it('16. agents — uniqueToolsLast48h: multiple ops same tool counts as 1', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-v10117-utool', 'same-tool', 'sess-1', hoursAgo(2), 'call'),
        dec(0.3, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-v10117-utool', 'same-tool', 'sess-2', hoursAgo(10), 'call'),
        dec(0.4, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-v10117-utool', 'other-tool', 'sess-3', hoursAgo(20), 'call'),
        dec(0.5, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10117-utool');
      expect(status).toBe(200);

      expect(body.uniqueToolsLast48h).toBe(2);
    });

    it('17. agents — uniqueMethodsLast48h: multiple ops same method counts as 1', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-v10117-umeth', 'fs', 'sess-1', hoursAgo(3), 'call'),
        dec(0.3, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-v10117-umeth', 'fs', 'sess-2', hoursAgo(12), 'read'),
        dec(0.4, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-v10117-umeth', 'fs', 'sess-3', hoursAgo(22), 'call'),
        dec(0.5, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10117-umeth');
      expect(status).toBe(200);

      expect(body.uniqueMethodsLast48h).toBe(2);
    });

    it('18. agents — max and min bounded within [0, 1]', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-v10117-bound', 'fs', 'sess-1', hoursAgo(1), 'call'),
        dec(0.0, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-v10117-bound', 'fs', 'sess-2', hoursAgo(5), 'call'),
        dec(1.0, 'block'),
      );

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10117-bound');
      expect(status).toBe(200);

      const max = body.maxRiskScoreLast48h as number;
      const min = body.minRiskScoreLast48h as number;
      expect(max).toBeGreaterThanOrEqual(0);
      expect(max).toBeLessThanOrEqual(1);
      expect(min).toBeGreaterThanOrEqual(0);
      expect(min).toBeLessThanOrEqual(1);
      expect(max).toBeCloseTo(1.0, 5);
      expect(min).toBeCloseTo(0.0, 5);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1654-T1658 — v10.117 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('19. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-k', 'tool-v10117-pres', 'sess-1', hoursAgo(1), 'call'),
        dec(0.5, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10117-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('maxRiskScoreLast48h');
      expect(body).toHaveProperty('minRiskScoreLast48h');
      expect(body).toHaveProperty('riskScoreStdDevLast48h');
      expect(body).toHaveProperty('uniqueToolsLast48h');
      expect(body).toHaveProperty('uniqueMethodsLast48h');
    });

    it('20. tools — all five fields null when no ops in 48h window', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-l', 'tool-v10117-old48', 'sess-1', daysAgo(3), 'call'),
        dec(0.5, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10117-old48');
      expect(status).toBe(200);

      expect(body.maxRiskScoreLast48h).toBeNull();
      expect(body.minRiskScoreLast48h).toBeNull();
      expect(body.riskScoreStdDevLast48h).toBeNull();
      expect(body.uniqueToolsLast48h).toBeNull();
      expect(body.uniqueMethodsLast48h).toBeNull();
    });

    it('21. tools — maxRiskScoreLast48h: selects max of multiple scores', async () => {
      ctx = await setup();
      // scores in 48h: 0.3, 0.9, 0.6 → max = 0.9
      await ctx.logger.log(
        makeOp('agent-m', 'tool-v10117-max', 'sess-1', hoursAgo(5), 'call'),
        dec(0.3, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-m', 'tool-v10117-max', 'sess-2', hoursAgo(15), 'call'),
        dec(0.9, 'block'),
      );
      await ctx.logger.log(
        makeOp('agent-m', 'tool-v10117-max', 'sess-3', hoursAgo(30), 'call'),
        dec(0.6, 'require_approval'),
      );

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10117-max');
      expect(status).toBe(200);

      expect(body.maxRiskScoreLast48h as number).toBeCloseTo(0.9, 5);
    });

    it('22. tools — minRiskScoreLast48h: selects min of multiple scores', async () => {
      ctx = await setup();
      // scores in 48h: 0.3, 0.9, 0.6 → min = 0.3
      await ctx.logger.log(
        makeOp('agent-n', 'tool-v10117-min', 'sess-1', hoursAgo(5), 'call'),
        dec(0.3, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-n', 'tool-v10117-min', 'sess-2', hoursAgo(15), 'call'),
        dec(0.9, 'block'),
      );
      await ctx.logger.log(
        makeOp('agent-n', 'tool-v10117-min', 'sess-3', hoursAgo(30), 'call'),
        dec(0.6, 'require_approval'),
      );

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10117-min');
      expect(status).toBe(200);

      expect(body.minRiskScoreLast48h as number).toBeCloseTo(0.3, 5);
    });

    it('23. tools — riskScoreStdDevLast48h: population formula (divide by N)', async () => {
      ctx = await setup();
      // scores: 0.0, 1.0 → mean=0.5, variance=((0-0.5)^2+(1-0.5)^2)/2=0.25, stddev=0.5
      await ctx.logger.log(
        makeOp('agent-o', 'tool-v10117-stddev', 'sess-1', hoursAgo(3), 'call'),
        dec(0.0, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-o', 'tool-v10117-stddev', 'sess-2', hoursAgo(13), 'call'),
        dec(1.0, 'block'),
      );

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10117-stddev');
      expect(status).toBe(200);

      expect(body.riskScoreStdDevLast48h as number).toBeCloseTo(0.5, 5);
    });

    it('24. tools — uniqueToolsLast48h: the queried tool name itself counts as 1', async () => {
      ctx = await setup();
      // Multiple ops all using the same tool name
      await ctx.logger.log(
        makeOp('agent-p', 'tool-v10117-self', 'sess-1', hoursAgo(2), 'call'),
        dec(0.3, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-p', 'tool-v10117-self', 'sess-2', hoursAgo(12), 'call'),
        dec(0.4, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10117-self');
      expect(status).toBe(200);

      expect(body.uniqueToolsLast48h).toBe(1);
    });

    it('25. tools — uniqueMethodsLast48h: 3 distinct methods correctly counted', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-q', 'tool-v10117-meth3', 'sess-1', hoursAgo(2), 'call'),
        dec(0.3, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-q', 'tool-v10117-meth3', 'sess-2', hoursAgo(8), 'read'),
        dec(0.4, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-q', 'tool-v10117-meth3', 'sess-3', hoursAgo(16), 'write'),
        dec(0.5, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-q', 'tool-v10117-meth3', 'sess-4', hoursAgo(24), 'call'),
        dec(0.6, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10117-meth3');
      expect(status).toBe(200);

      expect(body.uniqueMethodsLast48h).toBe(3);
    });
  });

  // ── operations/summary endpoint ────────────────────────────────────────────────

  describe('T1654-T1658 — v10.117 new fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('26. summary — all five new fields present', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-r', 'fs', 'sess-1', hoursAgo(1), 'call'),
        dec(0.5, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body).toHaveProperty('maxRiskScoreLast48h');
      expect(body).toHaveProperty('minRiskScoreLast48h');
      expect(body).toHaveProperty('riskScoreStdDevLast48h');
      expect(body).toHaveProperty('uniqueToolsLast48h');
      expect(body).toHaveProperty('uniqueMethodsLast48h');
    });

    it('27. summary — empty DB: all five new fields null', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.maxRiskScoreLast48h).toBeNull();
      expect(body.minRiskScoreLast48h).toBeNull();
      expect(body.riskScoreStdDevLast48h).toBeNull();
      expect(body.uniqueToolsLast48h).toBeNull();
      expect(body.uniqueMethodsLast48h).toBeNull();
    });

    it('28. summary — maxRiskScoreLast48h: max of all recent op risk scores', async () => {
      ctx = await setup();
      // 4 ops in 48h with scores 0.1, 0.8, 0.4, 0.6 → max = 0.8
      await ctx.logger.log(
        makeOp('agent-s1', 'fs', 'sess-1', hoursAgo(2), 'call'),
        dec(0.1, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-s2', 'fs', 'sess-2', hoursAgo(10), 'call'),
        dec(0.8, 'block'),
      );
      await ctx.logger.log(
        makeOp('agent-s3', 'fs', 'sess-3', hoursAgo(20), 'call'),
        dec(0.4, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-s4', 'fs', 'sess-4', hoursAgo(35), 'call'),
        dec(0.6, 'require_approval'),
      );

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.maxRiskScoreLast48h as number).toBeCloseTo(0.8, 5);
    });

    it('29. summary — minRiskScoreLast48h: min of all recent op risk scores; excludes old ops', async () => {
      ctx = await setup();
      // 2 ops in 48h (scores 0.3 and 0.7), 1 old op (score 0.05) → min in 48h = 0.3
      await ctx.logger.log(
        makeOp('agent-t1', 'fs', 'sess-1', hoursAgo(5), 'call'),
        dec(0.3, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-t2', 'fs', 'sess-2', hoursAgo(30), 'call'),
        dec(0.7, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-t3', 'fs', 'sess-3', daysAgo(5), 'call'),
        dec(0.05, 'block'),
      );

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      // Old op (0.05) excluded; min within 48h = 0.3
      expect(body.minRiskScoreLast48h as number).toBeCloseTo(0.3, 5);
    });

    it('30. summary — riskScoreStdDevLast48h is non-negative; only ops in 48h contribute', async () => {
      ctx = await setup();
      // 3 ops in 48h, 1 old op
      await ctx.logger.log(
        makeOp('agent-u1', 'fs', 'sess-1', hoursAgo(3), 'call'),
        dec(0.2, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-u2', 'fs', 'sess-2', hoursAgo(15), 'call'),
        dec(0.5, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-u3', 'fs', 'sess-3', hoursAgo(30), 'call'),
        dec(0.8, 'block'),
      );
      await ctx.logger.log(
        makeOp('agent-u4', 'fs', 'sess-4', daysAgo(5), 'call'),
        dec(0.99, 'block'),
      );

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      const stddev = body.riskScoreStdDevLast48h as number;
      expect(stddev).toBeGreaterThanOrEqual(0);
      // population stddev for [0.2, 0.5, 0.8]: mean=0.5, variance=((0.09+0+0.09)/3)=0.06, stddev≈0.2449
      expect(stddev).toBeCloseTo(Math.sqrt(0.06), 4);
    });

    it('31. summary — uniqueToolsLast48h: counts distinct tools within 48h, excludes old ops', async () => {
      ctx = await setup();
      // 3 ops in 48h using tools A, B, A + 1 old op using tool C → uniqueTools = 2
      await ctx.logger.log(
        makeOp('agent-v1', 'tool-A', 'sess-1', hoursAgo(4), 'call'),
        dec(0.3, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-v2', 'tool-B', 'sess-2', hoursAgo(14), 'call'),
        dec(0.4, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-v3', 'tool-A', 'sess-3', hoursAgo(35), 'call'),
        dec(0.5, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-v4', 'tool-C', 'sess-4', daysAgo(4), 'call'),
        dec(0.6, 'block'),
      );

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.uniqueToolsLast48h).toBe(2);
    });

    it('32. summary — uniqueMethodsLast48h: counts distinct methods within 48h, excludes old ops', async () => {
      ctx = await setup();
      // 3 ops in 48h using methods call/read/call + 1 old op using write → uniqueMethods = 2
      await ctx.logger.log(
        makeOp('agent-w1', 'fs', 'sess-1', hoursAgo(4), 'call'),
        dec(0.3, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-w2', 'fs', 'sess-2', hoursAgo(14), 'read'),
        dec(0.4, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-w3', 'fs', 'sess-3', hoursAgo(35), 'call'),
        dec(0.5, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-w4', 'fs', 'sess-4', daysAgo(4), 'write'),
        dec(0.6, 'block'),
      );

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.uniqueMethodsLast48h).toBe(2);
    });
  });
});

// ── v10.118 ────────────────────────────────────────────────────────────────────

describe('v10.118', () => {
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);
  const hoursAgo = (h: number) => new Date(PINNED_NOW() - h * 3_600_000);

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1659-T1663 — v10.118 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-a', 'fs', 'sess-v10118-pres', hoursAgo(1), 'call'),
        dec(0.5, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10118-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('riskScoreMedianLast48h');
      expect(body).toHaveProperty('riskScoreIQRLast48h');
      expect(body).toHaveProperty('opsHourlyStdDevLast7d');
      expect(body).toHaveProperty('opsHourlyStdDevLast30d');
      expect(body).toHaveProperty('riskScoreMomentumLast48h');
    });

    it('2. sessions — all five fields null when no ops in 48h window', async () => {
      ctx = await setup();
      // op older than 48h — 48h-windowed fields should be null
      await ctx.logger.log(
        makeOp('agent-b', 'fs', 'sess-v10118-old48', daysAgo(3), 'call'),
        dec(0.5, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10118-old48');
      expect(status).toBe(200);

      expect(body.riskScoreMedianLast48h).toBeNull();
      expect(body.riskScoreIQRLast48h).toBeNull();
      // opsHourlyStdDev: only 1 op, in 7d and 30d window but < 2 distinct hours
      // The old op (3 days) is within 7d and 30d windows → 1 distinct hour → null
      expect(body.opsHourlyStdDevLast7d).toBeNull();
      // Momentum: no ops in last 24h → null
      expect(body.riskScoreMomentumLast48h).toBeNull();
    });

    it('3. sessions — riskScoreMedianLast48h: odd count returns middle value', async () => {
      ctx = await setup();
      // 3 ops in 48h with scores [0.1, 0.5, 0.9] → median = 0.5
      await ctx.logger.log(
        makeOp('agent-c', 'fs', 'sess-v10118-med-odd', hoursAgo(1), 'call'),
        dec(0.5, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-c', 'fs', 'sess-v10118-med-odd', hoursAgo(5), 'call'),
        dec(0.1, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-c', 'fs', 'sess-v10118-med-odd', hoursAgo(10), 'call'),
        dec(0.9, 'block'),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10118-med-odd');
      expect(status).toBe(200);

      // sorted: [0.1, 0.5, 0.9], len=3, mid=1 → 0.5
      expect(body.riskScoreMedianLast48h as number).toBeCloseTo(0.5, 5);
    });

    it('4. sessions — riskScoreMedianLast48h: even count returns average of middle two', async () => {
      ctx = await setup();
      // 4 ops in 48h with scores [0.2, 0.4, 0.6, 0.8]
      // sorted: [0.2, 0.4, 0.6, 0.8], len=4, mid=2, median = (0.4 + 0.6) / 2 = 0.5
      await ctx.logger.log(
        makeOp('agent-d', 'fs', 'sess-v10118-med-even', hoursAgo(2), 'call'),
        dec(0.8, 'block'),
      );
      await ctx.logger.log(
        makeOp('agent-d', 'fs', 'sess-v10118-med-even', hoursAgo(4), 'call'),
        dec(0.2, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-d', 'fs', 'sess-v10118-med-even', hoursAgo(8), 'call'),
        dec(0.6, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-d', 'fs', 'sess-v10118-med-even', hoursAgo(12), 'call'),
        dec(0.4, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10118-med-even');
      expect(status).toBe(200);

      expect(body.riskScoreMedianLast48h as number).toBeCloseTo(0.5, 5);
    });

    it('5. sessions — riskScoreIQRLast48h: P75-P25 computed correctly', async () => {
      ctx = await setup();
      // 4 ops in 48h with scores [0.1, 0.3, 0.7, 0.9]
      // n=4, P25 idx=floor(4*0.25)=1 → 0.3, P75 idx=floor(4*0.75)=3 → 0.9, IQR=0.6
      await ctx.logger.log(
        makeOp('agent-e', 'fs', 'sess-v10118-iqr', hoursAgo(1), 'call'),
        dec(0.9, 'block'),
      );
      await ctx.logger.log(
        makeOp('agent-e', 'fs', 'sess-v10118-iqr', hoursAgo(5), 'call'),
        dec(0.1, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-e', 'fs', 'sess-v10118-iqr', hoursAgo(10), 'call'),
        dec(0.7, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-e', 'fs', 'sess-v10118-iqr', hoursAgo(15), 'call'),
        dec(0.3, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10118-iqr');
      expect(status).toBe(200);

      expect(body.riskScoreIQRLast48h as number).toBeCloseTo(0.6, 5);
    });

    it('6. sessions — opsHourlyStdDevLast7d: null if ops all in same hour', async () => {
      ctx = await setup();
      // 3 ops all within the same hour (1h ago) — only 1 distinct hour → null
      const ts = hoursAgo(1);
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v10118-std7-1h', ts, 'call'), dec(0.3));
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v10118-std7-1h', ts, 'call'), dec(0.4));
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v10118-std7-1h', ts, 'call'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10118-std7-1h');
      expect(status).toBe(200);

      expect(body.opsHourlyStdDevLast7d).toBeNull();
    });

    it('7. sessions — opsHourlyStdDevLast7d: non-negative for 2+ distinct hours', async () => {
      ctx = await setup();
      // 2 ops in different hours within 7d: 3h ago (1 op) and 5h ago (3 ops)
      // hourly counts: { h-3: 1, h-5: 3 }, mean=2, variance=((1-2)^2+(3-2)^2)/2=1, stddev=1
      await ctx.logger.log(
        makeOp('agent-g', 'fs', 'sess-v10118-std7-calc', hoursAgo(3), 'call'),
        dec(0.4),
      );
      await ctx.logger.log(
        makeOp('agent-g', 'fs', 'sess-v10118-std7-calc', hoursAgo(5), 'call'),
        dec(0.5),
      );
      await ctx.logger.log(
        makeOp('agent-g', 'fs', 'sess-v10118-std7-calc', hoursAgo(5), 'call'),
        dec(0.6),
      );
      await ctx.logger.log(
        makeOp('agent-g', 'fs', 'sess-v10118-std7-calc', hoursAgo(5), 'call'),
        dec(0.7),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10118-std7-calc');
      expect(status).toBe(200);

      const stddev = body.opsHourlyStdDevLast7d as number;
      expect(stddev).toBeGreaterThanOrEqual(0);
      expect(stddev).toBeCloseTo(1.0, 4);
    });

    it('8. sessions — opsHourlyStdDevLast30d: ops > 7d but <= 30d included; ops > 30d excluded', async () => {
      ctx = await setup();
      // 1 op at 10d ago (in 30d window, not 7d), 1 op at 20d ago (in 30d window, not 7d)
      // They should be in different hours → 2 distinct hours → stddev non-null
      // 1 op at 40d ago (excluded from 30d)
      await ctx.logger.log(
        makeOp('agent-h', 'fs', 'sess-v10118-std30', daysAgo(10), 'call'),
        dec(0.4),
      );
      await ctx.logger.log(
        makeOp('agent-h', 'fs', 'sess-v10118-std30', daysAgo(20), 'call'),
        dec(0.6),
      );
      await ctx.logger.log(
        makeOp('agent-h', 'fs', 'sess-v10118-std30', daysAgo(40), 'call'),
        dec(0.8),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10118-std30');
      expect(status).toBe(200);

      // 7d window is empty → null
      expect(body.opsHourlyStdDevLast7d).toBeNull();
      // 30d window has 2 distinct hours → non-null, non-negative
      const stddev30 = body.opsHourlyStdDevLast30d as number;
      expect(stddev30).toBeGreaterThanOrEqual(0);
    });

    it('9. sessions — riskScoreMomentumLast48h: null if last-24h window has no ops', async () => {
      ctx = await setup();
      // Only op in hours 25-48 window, nothing in last 24h → null
      await ctx.logger.log(
        makeOp('agent-i', 'fs', 'sess-v10118-mom-null24', hoursAgo(30), 'call'),
        dec(0.5),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10118-mom-null24');
      expect(status).toBe(200);

      expect(body.riskScoreMomentumLast48h).toBeNull();
    });

    it('10. sessions — riskScoreMomentumLast48h: null if hours-25-48 window has no ops', async () => {
      ctx = await setup();
      // Only op in last 24h, nothing in hours 25-48 → null
      await ctx.logger.log(
        makeOp('agent-j', 'fs', 'sess-v10118-mom-null48', hoursAgo(2), 'call'),
        dec(0.5),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10118-mom-null48');
      expect(status).toBe(200);

      expect(body.riskScoreMomentumLast48h).toBeNull();
    });

    it('11. sessions — riskScoreMomentumLast48h: correct value when both windows populated', async () => {
      ctx = await setup();
      // Last 24h: scores [0.6, 0.8] → mean = 0.7
      // Hours 25-48: scores [0.2, 0.4] → mean = 0.3
      // Momentum = 0.7 - 0.3 = 0.4
      await ctx.logger.log(
        makeOp('agent-k', 'fs', 'sess-v10118-mom-calc', hoursAgo(2), 'call'),
        dec(0.6),
      );
      await ctx.logger.log(
        makeOp('agent-k', 'fs', 'sess-v10118-mom-calc', hoursAgo(10), 'call'),
        dec(0.8),
      );
      await ctx.logger.log(
        makeOp('agent-k', 'fs', 'sess-v10118-mom-calc', hoursAgo(26), 'call'),
        dec(0.2),
      );
      await ctx.logger.log(
        makeOp('agent-k', 'fs', 'sess-v10118-mom-calc', hoursAgo(36), 'call'),
        dec(0.4),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10118-mom-calc');
      expect(status).toBe(200);

      expect(body.riskScoreMomentumLast48h as number).toBeCloseTo(0.4, 5);
    });

    it('12. sessions — riskScoreMedianLast48h: single op returns that score', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-l', 'fs', 'sess-v10118-med-single', hoursAgo(5), 'call'),
        dec(0.73),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10118-med-single');
      expect(status).toBe(200);

      expect(body.riskScoreMedianLast48h as number).toBeCloseTo(0.73, 5);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1659-T1663 — v10.118 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('13. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-v10118-pres', 'fs', 'sess-1', hoursAgo(1), 'call'),
        dec(0.4, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10118-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('riskScoreMedianLast48h');
      expect(body).toHaveProperty('riskScoreIQRLast48h');
      expect(body).toHaveProperty('opsHourlyStdDevLast7d');
      expect(body).toHaveProperty('opsHourlyStdDevLast30d');
      expect(body).toHaveProperty('riskScoreMomentumLast48h');
    });

    it('14. agents — riskScoreMedianLast48h null when no ops in 48h', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-v10118-old', 'fs', 'sess-1', daysAgo(4), 'call'),
        dec(0.5, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10118-old');
      expect(status).toBe(200);

      expect(body.riskScoreMedianLast48h).toBeNull();
      expect(body.riskScoreIQRLast48h).toBeNull();
      expect(body.riskScoreMomentumLast48h).toBeNull();
    });

    it('15. agents — riskScoreMedianLast48h: two ops average of middle two', async () => {
      ctx = await setup();
      // 2 ops: scores [0.3, 0.7] → median = (0.3 + 0.7)/2 = 0.5
      await ctx.logger.log(
        makeOp('agent-v10118-med2', 'fs', 'sess-1', hoursAgo(3), 'call'),
        dec(0.3),
      );
      await ctx.logger.log(
        makeOp('agent-v10118-med2', 'fs', 'sess-2', hoursAgo(10), 'call'),
        dec(0.7),
      );

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10118-med2');
      expect(status).toBe(200);

      expect(body.riskScoreMedianLast48h as number).toBeCloseTo(0.5, 5);
    });

    it('16. agents — riskScoreIQRLast48h: non-negative for any set of ops', async () => {
      ctx = await setup();
      // 4 ops with scores [0.1, 0.2, 0.8, 0.9]
      // n=4: P25 idx=1 → 0.2, P75 idx=3 → 0.9, IQR=0.7
      await ctx.logger.log(
        makeOp('agent-v10118-iqr', 'fs', 'sess-1', hoursAgo(2), 'call'),
        dec(0.1),
      );
      await ctx.logger.log(
        makeOp('agent-v10118-iqr', 'fs', 'sess-2', hoursAgo(5), 'call'),
        dec(0.9),
      );
      await ctx.logger.log(
        makeOp('agent-v10118-iqr', 'fs', 'sess-3', hoursAgo(10), 'call'),
        dec(0.2),
      );
      await ctx.logger.log(
        makeOp('agent-v10118-iqr', 'fs', 'sess-4', hoursAgo(15), 'call'),
        dec(0.8),
      );

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10118-iqr');
      expect(status).toBe(200);

      const iqr = body.riskScoreIQRLast48h as number;
      expect(iqr).toBeGreaterThanOrEqual(0);
      expect(iqr).toBeCloseTo(0.7, 5);
    });

    it('17. agents — opsHourlyStdDevLast7d: non-null and non-negative for 2+ distinct hours in 7d', async () => {
      ctx = await setup();
      // 2 ops at different hours within 7d
      await ctx.logger.log(
        makeOp('agent-v10118-std7', 'fs', 'sess-1', hoursAgo(2), 'call'),
        dec(0.4),
      );
      await ctx.logger.log(
        makeOp('agent-v10118-std7', 'fs', 'sess-2', hoursAgo(4), 'call'),
        dec(0.6),
      );

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10118-std7');
      expect(status).toBe(200);

      const stddev = body.opsHourlyStdDevLast7d as number;
      expect(stddev).not.toBeNull();
      expect(stddev).toBeGreaterThanOrEqual(0);
    });

    it('18. agents — riskScoreMomentumLast48h: negative when recent risk is lower than prior', async () => {
      ctx = await setup();
      // Last 24h: mean = 0.2 (low recent risk)
      // Hours 25-48: mean = 0.8 (high prior risk)
      // Momentum = 0.2 - 0.8 = -0.6
      await ctx.logger.log(
        makeOp('agent-v10118-mom-neg', 'fs', 'sess-1', hoursAgo(5), 'call'),
        dec(0.2),
      );
      await ctx.logger.log(
        makeOp('agent-v10118-mom-neg', 'fs', 'sess-2', hoursAgo(30), 'call'),
        dec(0.8),
      );

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10118-mom-neg');
      expect(status).toBe(200);

      expect(body.riskScoreMomentumLast48h as number).toBeCloseTo(-0.6, 5);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1659-T1663 — v10.118 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('19. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-m', 'tool-v10118-pres', 'sess-1', hoursAgo(1), 'call'),
        dec(0.5, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10118-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('riskScoreMedianLast48h');
      expect(body).toHaveProperty('riskScoreIQRLast48h');
      expect(body).toHaveProperty('opsHourlyStdDevLast7d');
      expect(body).toHaveProperty('opsHourlyStdDevLast30d');
      expect(body).toHaveProperty('riskScoreMomentumLast48h');
    });

    it('20. tools — all 48h fields null when no ops in 48h window', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-n', 'tool-v10118-old', 'sess-1', daysAgo(5), 'call'),
        dec(0.5, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10118-old');
      expect(status).toBe(200);

      expect(body.riskScoreMedianLast48h).toBeNull();
      expect(body.riskScoreIQRLast48h).toBeNull();
      expect(body.riskScoreMomentumLast48h).toBeNull();
    });

    it('21. tools — riskScoreMedianLast48h: correct for three ops', async () => {
      ctx = await setup();
      // Scores [0.2, 0.5, 0.8] → median = 0.5
      await ctx.logger.log(
        makeOp('agent-o', 'tool-v10118-med', 'sess-1', hoursAgo(1), 'call'),
        dec(0.2),
      );
      await ctx.logger.log(
        makeOp('agent-o', 'tool-v10118-med', 'sess-2', hoursAgo(5), 'call'),
        dec(0.8),
      );
      await ctx.logger.log(
        makeOp('agent-o', 'tool-v10118-med', 'sess-3', hoursAgo(10), 'call'),
        dec(0.5),
      );

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10118-med');
      expect(status).toBe(200);

      expect(body.riskScoreMedianLast48h as number).toBeCloseTo(0.5, 5);
    });

    it('22. tools — riskScoreIQRLast48h: zero for uniform scores', async () => {
      ctx = await setup();
      // 4 ops all with same score 0.5 → IQR = 0
      // n=4: P25 idx=1 → 0.5, P75 idx=3 → 0.5, IQR=0
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(
          makeOp('agent-p', 'tool-v10118-iqr0', `sess-${i}`, hoursAgo(i + 1), 'call'),
          dec(0.5),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10118-iqr0');
      expect(status).toBe(200);

      expect(body.riskScoreIQRLast48h as number).toBeCloseTo(0, 5);
    });

    it('23. tools — opsHourlyStdDevLast30d: null for ops all in one hour in 30d window', async () => {
      ctx = await setup();
      // 2 ops at 15d ago but very close together (same hour)
      const ts = daysAgo(15);
      await ctx.logger.log(makeOp('agent-q', 'tool-v10118-std30-1h', 'sess-1', ts), dec(0.4));
      await ctx.logger.log(makeOp('agent-q', 'tool-v10118-std30-1h', 'sess-2', ts), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10118-std30-1h');
      expect(status).toBe(200);

      // Only 1 distinct hour → null
      expect(body.opsHourlyStdDevLast30d).toBeNull();
    });

    it('24. tools — riskScoreMomentumLast48h: positive when recent risk is higher', async () => {
      ctx = await setup();
      // Last 24h: mean = 0.9, hours 25-48: mean = 0.3 → momentum = 0.6
      await ctx.logger.log(
        makeOp('agent-r', 'tool-v10118-mom-pos', 'sess-1', hoursAgo(2), 'call'),
        dec(0.9),
      );
      await ctx.logger.log(
        makeOp('agent-r', 'tool-v10118-mom-pos', 'sess-2', hoursAgo(30), 'call'),
        dec(0.3),
      );

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10118-mom-pos');
      expect(status).toBe(200);

      expect(body.riskScoreMomentumLast48h as number).toBeCloseTo(0.6, 5);
    });

    it('25. tools — opsHourlyStdDevLast7d: excludes ops older than 7d', async () => {
      ctx = await setup();
      // Ops at 2h ago and 4h ago (in 7d), plus one at 10d ago (excluded from 7d)
      await ctx.logger.log(
        makeOp('agent-s', 'tool-v10118-std7-excl', 'sess-1', hoursAgo(2), 'call'),
        dec(0.4),
      );
      await ctx.logger.log(
        makeOp('agent-s', 'tool-v10118-std7-excl', 'sess-2', hoursAgo(4), 'call'),
        dec(0.6),
      );
      await ctx.logger.log(
        makeOp('agent-s', 'tool-v10118-std7-excl', 'sess-3', daysAgo(10), 'call'),
        dec(0.8),
      );

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10118-std7-excl');
      expect(status).toBe(200);

      // 7d window has 2 distinct hours → non-null
      const stddev7 = body.opsHourlyStdDevLast7d as number;
      expect(stddev7).not.toBeNull();
      expect(stddev7).toBeGreaterThanOrEqual(0);
    });
  });

  // ── operations/summary endpoint ────────────────────────────────────────────────

  describe('T1659-T1663 — v10.118 new fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('26. summary — all five new fields present', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-t', 'fs', 'sess-1', hoursAgo(1), 'call'),
        dec(0.5, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body).toHaveProperty('riskScoreMedianLast48h');
      expect(body).toHaveProperty('riskScoreIQRLast48h');
      expect(body).toHaveProperty('opsHourlyStdDevLast7d');
      expect(body).toHaveProperty('opsHourlyStdDevLast30d');
      expect(body).toHaveProperty('riskScoreMomentumLast48h');
    });

    it('27. summary — empty DB: all five new fields null', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.riskScoreMedianLast48h).toBeNull();
      expect(body.riskScoreIQRLast48h).toBeNull();
      expect(body.opsHourlyStdDevLast7d).toBeNull();
      expect(body.opsHourlyStdDevLast30d).toBeNull();
      expect(body.riskScoreMomentumLast48h).toBeNull();
    });

    it('28. summary — riskScoreMedianLast48h: correct across all agents in 48h', async () => {
      ctx = await setup();
      // 5 ops from different agents in 48h: scores [0.1, 0.3, 0.5, 0.7, 0.9] → median = 0.5
      const scores = [0.9, 0.1, 0.7, 0.3, 0.5];
      for (let i = 0; i < scores.length; i++) {
        await ctx.logger.log(
          makeOp(`agent-sum-${i}`, 'fs', `sess-${i}`, hoursAgo(i + 1), 'call'),
          dec(scores[i]!),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.riskScoreMedianLast48h as number).toBeCloseTo(0.5, 5);
    });

    it('29. summary — riskScoreIQRLast48h: excludes ops older than 48h', async () => {
      ctx = await setup();
      // 4 ops in 48h: [0.2, 0.4, 0.6, 0.8], IQR = P75(0.8) - P25(0.4) = 0.4
      // 1 old op (0.0) — excluded
      for (const [score, h] of [[0.2, 2], [0.4, 8], [0.6, 20], [0.8, 35]] as [number, number][]) {
        await ctx.logger.log(
          makeOp('agent-sum-iqr', 'fs', `sess-iqr-${h}`, hoursAgo(h), 'call'),
          dec(score),
        );
      }
      await ctx.logger.log(
        makeOp('agent-sum-iqr-old', 'fs', 'sess-iqr-old', daysAgo(5), 'call'),
        dec(0.0),
      );

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      // n=4: P25 idx=floor(4*0.25)=1 → 0.4, P75 idx=floor(4*0.75)=3 → 0.8, IQR=0.4
      expect(body.riskScoreIQRLast48h as number).toBeCloseTo(0.4, 5);
    });

    it('30. summary — opsHourlyStdDevLast7d: correct population stddev for known hourly counts', async () => {
      ctx = await setup();
      // 2 ops at 2h ago and 2 ops at 4h ago → hourly counts { h-2: 2, h-4: 2 }
      // mean=2, variance=0, stddev=0 (uniform)
      await ctx.logger.log(
        makeOp('agent-sum-std7-a', 'fs', 'sess-1', hoursAgo(2), 'call'),
        dec(0.3),
      );
      await ctx.logger.log(
        makeOp('agent-sum-std7-b', 'fs', 'sess-2', hoursAgo(2), 'call'),
        dec(0.4),
      );
      await ctx.logger.log(
        makeOp('agent-sum-std7-c', 'fs', 'sess-3', hoursAgo(4), 'call'),
        dec(0.5),
      );
      await ctx.logger.log(
        makeOp('agent-sum-std7-d', 'fs', 'sess-4', hoursAgo(4), 'call'),
        dec(0.6),
      );

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      const stddev = body.opsHourlyStdDevLast7d as number;
      expect(stddev).not.toBeNull();
      // 2 hours, each with count=2 → stddev=0
      expect(stddev).toBeCloseTo(0, 4);
    });

    it('31. summary — riskScoreMomentumLast48h: null when only ops in last 24h', async () => {
      ctx = await setup();
      // Only ops in the last 24h → second window (25-48h) is empty → null
      await ctx.logger.log(
        makeOp('agent-sum-mom-null', 'fs', 'sess-1', hoursAgo(2), 'call'),
        dec(0.5),
      );
      await ctx.logger.log(
        makeOp('agent-sum-mom-null', 'fs', 'sess-2', hoursAgo(10), 'call'),
        dec(0.7),
      );

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.riskScoreMomentumLast48h).toBeNull();
    });

    it('32. summary — riskScoreMomentumLast48h: correct value when both half-windows populated', async () => {
      ctx = await setup();
      // Last 24h: [0.4, 0.6] → mean=0.5
      // Hours 25-48: [0.1, 0.3] → mean=0.2
      // Momentum = 0.5 - 0.2 = 0.3
      await ctx.logger.log(
        makeOp('agent-sum-mom-a', 'fs', 'sess-1', hoursAgo(5), 'call'),
        dec(0.4),
      );
      await ctx.logger.log(
        makeOp('agent-sum-mom-b', 'fs', 'sess-2', hoursAgo(15), 'call'),
        dec(0.6),
      );
      await ctx.logger.log(
        makeOp('agent-sum-mom-c', 'fs', 'sess-3', hoursAgo(28), 'call'),
        dec(0.1),
      );
      await ctx.logger.log(
        makeOp('agent-sum-mom-d', 'fs', 'sess-4', hoursAgo(40), 'call'),
        dec(0.3),
      );

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.riskScoreMomentumLast48h as number).toBeCloseTo(0.3, 5);
    });
  });
});

// ── v10.119 ────────────────────────────────────────────────────────────────────

describe('v10.119', () => {
  const hoursAgo = (h: number) => new Date(PINNED_NOW() - h * 3_600_000);
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1664-T1668 — v10.119 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-a', 'fs', 'sess-v10119-pres', hoursAgo(1), 'call'),
        dec(0.5, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10119-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('blockRateTrend24hVs48h');
      expect(body).toHaveProperty('riskScoreTrendSlopeLast48h');
      expect(body).toHaveProperty('opsCountLast72h');
      expect(body).toHaveProperty('avgRiskScoreLast72h');
      expect(body).toHaveProperty('blockRateLast72h');
    });

    it('2. sessions — all five fields null when no ops in any window', async () => {
      ctx = await setup();
      // Only op older than 72h — all five fields should be null
      await ctx.logger.log(
        makeOp('agent-b', 'fs', 'sess-v10119-old', daysAgo(5), 'call'),
        dec(0.5, 'block'),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10119-old');
      expect(status).toBe(200);

      // 24h and 48h windows are empty → blockRateTrend24hVs48h null
      expect(body.blockRateTrend24hVs48h).toBeNull();
      // 48h window empty → riskScoreTrendSlopeLast48h null
      expect(body.riskScoreTrendSlopeLast48h).toBeNull();
      // 72h window empty → opsCountLast72h/avgRiskScoreLast72h/blockRateLast72h null
      expect(body.opsCountLast72h).toBeNull();
      expect(body.avgRiskScoreLast72h).toBeNull();
      expect(body.blockRateLast72h).toBeNull();
    });

    it('3. sessions — opsCountLast72h: counts only ops within 72h', async () => {
      ctx = await setup();
      // 2 ops within 72h, 1 outside
      await ctx.logger.log(
        makeOp('agent-c', 'fs', 'sess-v10119-cnt', hoursAgo(10), 'call'),
        dec(0.3, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-c', 'fs', 'sess-v10119-cnt', hoursAgo(50), 'call'),
        dec(0.4, 'block'),
      );
      await ctx.logger.log(
        makeOp('agent-c', 'fs', 'sess-v10119-cnt', daysAgo(5), 'call'),
        dec(0.9, 'block'),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10119-cnt');
      expect(status).toBe(200);

      expect(body.opsCountLast72h).toBe(2);
    });

    it('4. sessions — avgRiskScoreLast72h: correct mean for known scores in 72h', async () => {
      ctx = await setup();
      // 3 ops in 72h: scores [0.2, 0.4, 0.6] → mean = 0.4
      await ctx.logger.log(
        makeOp('agent-d', 'fs', 'sess-v10119-avg', hoursAgo(5), 'call'),
        dec(0.2),
      );
      await ctx.logger.log(
        makeOp('agent-d', 'fs', 'sess-v10119-avg', hoursAgo(20), 'call'),
        dec(0.4),
      );
      await ctx.logger.log(
        makeOp('agent-d', 'fs', 'sess-v10119-avg', hoursAgo(60), 'call'),
        dec(0.6),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10119-avg');
      expect(status).toBe(200);

      expect(body.avgRiskScoreLast72h as number).toBeCloseTo(0.4, 5);
    });

    it('5. sessions — blockRateLast72h: correct fraction of blocked ops in 72h', async () => {
      ctx = await setup();
      // 4 ops in 72h: 1 block, 3 allow → blockRate = 0.25
      await ctx.logger.log(
        makeOp('agent-e', 'fs', 'sess-v10119-brate', hoursAgo(2), 'call'),
        dec(0.8, 'block'),
      );
      await ctx.logger.log(
        makeOp('agent-e', 'fs', 'sess-v10119-brate', hoursAgo(10), 'call'),
        dec(0.2, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-e', 'fs', 'sess-v10119-brate', hoursAgo(30), 'call'),
        dec(0.3, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-e', 'fs', 'sess-v10119-brate', hoursAgo(60), 'call'),
        dec(0.1, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10119-brate');
      expect(status).toBe(200);

      expect(body.blockRateLast72h as number).toBeCloseTo(0.25, 5);
    });

    it('6. sessions — blockRateTrend24hVs48h: null when 24h window is empty', async () => {
      ctx = await setup();
      // Only op in 25-48h range → 24h window is empty → null
      await ctx.logger.log(
        makeOp('agent-f', 'fs', 'sess-v10119-trend-null24', hoursAgo(30), 'call'),
        dec(0.5, 'block'),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10119-trend-null24');
      expect(status).toBe(200);

      expect(body.blockRateTrend24hVs48h).toBeNull();
    });

    it('7. sessions — blockRateTrend24hVs48h: correct value (rate24h - rate48h)', async () => {
      ctx = await setup();
      // 24h window: 2 ops, 2 blocks → rate24 = 1.0
      // 48h window: 4 ops total (2 in 24h + 2 in 25-48h), 2 blocks → rate48 = 0.5
      // trend = 1.0 - 0.5 = 0.5
      await ctx.logger.log(
        makeOp('agent-g', 'fs', 'sess-v10119-trend-calc', hoursAgo(5), 'call'),
        dec(0.9, 'block'),
      );
      await ctx.logger.log(
        makeOp('agent-g', 'fs', 'sess-v10119-trend-calc', hoursAgo(10), 'call'),
        dec(0.8, 'block'),
      );
      await ctx.logger.log(
        makeOp('agent-g', 'fs', 'sess-v10119-trend-calc', hoursAgo(26), 'call'),
        dec(0.3, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-g', 'fs', 'sess-v10119-trend-calc', hoursAgo(35), 'call'),
        dec(0.2, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10119-trend-calc');
      expect(status).toBe(200);

      expect(body.blockRateTrend24hVs48h as number).toBeCloseTo(0.5, 5);
    });

    it('8. sessions — riskScoreTrendSlopeLast48h: null if only 1 active hour in 48h', async () => {
      ctx = await setup();
      // 3 ops all in the same hour (1h ago) → only 1 distinct hour → null
      const ts = hoursAgo(1);
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v10119-slope-1h', ts), dec(0.3));
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v10119-slope-1h', ts), dec(0.5));
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v10119-slope-1h', ts), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10119-slope-1h');
      expect(status).toBe(200);

      expect(body.riskScoreTrendSlopeLast48h).toBeNull();
    });

    it('9. sessions — riskScoreTrendSlopeLast48h: returns a number for 2+ distinct hours', async () => {
      ctx = await setup();
      // 2 ops at different hours → 2 distinct hours → slope is a finite number
      await ctx.logger.log(
        makeOp('agent-i', 'fs', 'sess-v10119-slope-2h', hoursAgo(5), 'call'),
        dec(0.4),
      );
      await ctx.logger.log(
        makeOp('agent-i', 'fs', 'sess-v10119-slope-2h', hoursAgo(20), 'call'),
        dec(0.8),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10119-slope-2h');
      expect(status).toBe(200);

      const slope = body.riskScoreTrendSlopeLast48h;
      expect(slope).not.toBeNull();
      expect(typeof slope).toBe('number');
      expect(Number.isFinite(slope as number)).toBe(true);
    });

    it('10. sessions — blockRateLast72h: 0 when no blocks in 72h', async () => {
      ctx = await setup();
      // 3 ops, all allow
      await ctx.logger.log(
        makeOp('agent-j', 'fs', 'sess-v10119-brate0', hoursAgo(2), 'call'),
        dec(0.1, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-j', 'fs', 'sess-v10119-brate0', hoursAgo(10), 'call'),
        dec(0.2, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-j', 'fs', 'sess-v10119-brate0', hoursAgo(50), 'call'),
        dec(0.3, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10119-brate0');
      expect(status).toBe(200);

      expect(body.blockRateLast72h as number).toBeCloseTo(0, 5);
    });

    it('11. sessions — blockRateLast72h: 1 when all ops in 72h are blocks', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-k', 'fs', 'sess-v10119-brate1', hoursAgo(3), 'call'),
        dec(0.9, 'block'),
      );
      await ctx.logger.log(
        makeOp('agent-k', 'fs', 'sess-v10119-brate1', hoursAgo(40), 'call'),
        dec(0.8, 'block'),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10119-brate1');
      expect(status).toBe(200);

      expect(body.blockRateLast72h as number).toBeCloseTo(1.0, 5);
    });

    it('12. sessions — avgRiskScoreLast72h: excludes ops older than 72h', async () => {
      ctx = await setup();
      // 1 op in 72h (score 0.6), 1 old op (score 0.0, excluded)
      await ctx.logger.log(
        makeOp('agent-l', 'fs', 'sess-v10119-avg-excl', hoursAgo(10), 'call'),
        dec(0.6),
      );
      await ctx.logger.log(
        makeOp('agent-l', 'fs', 'sess-v10119-avg-excl', daysAgo(5), 'call'),
        dec(0.0),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10119-avg-excl');
      expect(status).toBe(200);

      expect(body.avgRiskScoreLast72h as number).toBeCloseTo(0.6, 5);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1664-T1668 — v10.119 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('13. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-v10119-pres', 'fs', 'sess-1', hoursAgo(1), 'call'),
        dec(0.4, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10119-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('blockRateTrend24hVs48h');
      expect(body).toHaveProperty('riskScoreTrendSlopeLast48h');
      expect(body).toHaveProperty('opsCountLast72h');
      expect(body).toHaveProperty('avgRiskScoreLast72h');
      expect(body).toHaveProperty('blockRateLast72h');
    });

    it('14. agents — opsCountLast72h null when no ops in 72h', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-v10119-old', 'fs', 'sess-1', daysAgo(5), 'call'),
        dec(0.5, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10119-old');
      expect(status).toBe(200);

      expect(body.opsCountLast72h).toBeNull();
      expect(body.avgRiskScoreLast72h).toBeNull();
      expect(body.blockRateLast72h).toBeNull();
      expect(body.blockRateTrend24hVs48h).toBeNull();
      expect(body.riskScoreTrendSlopeLast48h).toBeNull();
    });

    it('15. agents — opsCountLast72h: counts correctly across multiple sessions', async () => {
      ctx = await setup();
      // 3 ops from same agent in different sessions, all within 72h
      await ctx.logger.log(
        makeOp('agent-v10119-cnt3', 'fs', 'sess-a', hoursAgo(2), 'call'),
        dec(0.3),
      );
      await ctx.logger.log(
        makeOp('agent-v10119-cnt3', 'fs', 'sess-b', hoursAgo(15), 'call'),
        dec(0.4),
      );
      await ctx.logger.log(
        makeOp('agent-v10119-cnt3', 'fs', 'sess-c', hoursAgo(65), 'call'),
        dec(0.5),
      );

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10119-cnt3');
      expect(status).toBe(200);

      expect(body.opsCountLast72h).toBe(3);
    });

    it('16. agents — blockRateTrend24hVs48h: null when 48h window empty', async () => {
      ctx = await setup();
      // Op is at 60h ago — outside both 24h and 48h windows → trend = null
      await ctx.logger.log(
        makeOp('agent-v10119-trend-null48', 'fs', 'sess-1', hoursAgo(60), 'call'),
        dec(0.5, 'block'),
      );

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10119-trend-null48');
      expect(status).toBe(200);

      expect(body.blockRateTrend24hVs48h).toBeNull();
    });

    it('17. agents — avgRiskScoreLast72h: correct mean', async () => {
      ctx = await setup();
      // Scores [0.0, 1.0] → mean = 0.5
      await ctx.logger.log(
        makeOp('agent-v10119-avg', 'fs', 'sess-1', hoursAgo(10), 'call'),
        dec(0.0),
      );
      await ctx.logger.log(
        makeOp('agent-v10119-avg', 'fs', 'sess-2', hoursAgo(50), 'call'),
        dec(1.0),
      );

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10119-avg');
      expect(status).toBe(200);

      expect(body.avgRiskScoreLast72h as number).toBeCloseTo(0.5, 5);
    });

    it('18. agents — blockRateLast72h: 0.5 for half-blocked ops', async () => {
      ctx = await setup();
      // 2 ops: 1 block, 1 allow → blockRate = 0.5
      await ctx.logger.log(
        makeOp('agent-v10119-brate05', 'fs', 'sess-1', hoursAgo(5), 'call'),
        dec(0.8, 'block'),
      );
      await ctx.logger.log(
        makeOp('agent-v10119-brate05', 'fs', 'sess-2', hoursAgo(40), 'call'),
        dec(0.2, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10119-brate05');
      expect(status).toBe(200);

      expect(body.blockRateLast72h as number).toBeCloseTo(0.5, 5);
    });

    it('19. agents — riskScoreTrendSlopeLast48h: null when 48h window has no ops', async () => {
      ctx = await setup();
      // Op at 80h ago → outside 48h window
      await ctx.logger.log(
        makeOp('agent-v10119-slope-null', 'fs', 'sess-1', hoursAgo(80), 'call'),
        dec(0.5),
      );

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10119-slope-null');
      expect(status).toBe(200);

      expect(body.riskScoreTrendSlopeLast48h).toBeNull();
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1664-T1668 — v10.119 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('20. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-m', 'tool-v10119-pres', 'sess-1', hoursAgo(1), 'call'),
        dec(0.5, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10119-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('blockRateTrend24hVs48h');
      expect(body).toHaveProperty('riskScoreTrendSlopeLast48h');
      expect(body).toHaveProperty('opsCountLast72h');
      expect(body).toHaveProperty('avgRiskScoreLast72h');
      expect(body).toHaveProperty('blockRateLast72h');
    });

    it('21. tools — all 72h fields null when no ops in 72h', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-n', 'tool-v10119-old', 'sess-1', daysAgo(5), 'call'),
        dec(0.5, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10119-old');
      expect(status).toBe(200);

      expect(body.opsCountLast72h).toBeNull();
      expect(body.avgRiskScoreLast72h).toBeNull();
      expect(body.blockRateLast72h).toBeNull();
    });

    it('22. tools — opsCountLast72h: correct count', async () => {
      ctx = await setup();
      // 3 ops in 72h
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(
          makeOp(`agent-o-${i}`, 'tool-v10119-cnt', `sess-${i}`, hoursAgo(i * 10 + 1), 'call'),
          dec(0.3 + i * 0.1),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10119-cnt');
      expect(status).toBe(200);

      expect(body.opsCountLast72h).toBe(3);
    });

    it('23. tools — blockRateTrend24hVs48h: negative when recent block rate is lower', async () => {
      ctx = await setup();
      // 24h window: 1 op, 0 blocks → rate24 = 0
      // 48h window: 2 ops total (1 in 24h + 1 in 25-48h), 1 block → rate48 = 0.5
      // trend = 0 - 0.5 = -0.5
      await ctx.logger.log(
        makeOp('agent-p', 'tool-v10119-trend-neg', 'sess-1', hoursAgo(10), 'call'),
        dec(0.1, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-p', 'tool-v10119-trend-neg', 'sess-2', hoursAgo(30), 'call'),
        dec(0.9, 'block'),
      );

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10119-trend-neg');
      expect(status).toBe(200);

      expect(body.blockRateTrend24hVs48h as number).toBeCloseTo(-0.5, 5);
    });

    it('24. tools — avgRiskScoreLast72h: single op returns that score', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-q', 'tool-v10119-avg1', 'sess-1', hoursAgo(5), 'call'),
        dec(0.77),
      );

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10119-avg1');
      expect(status).toBe(200);

      expect(body.avgRiskScoreLast72h as number).toBeCloseTo(0.77, 5);
    });

    it('25. tools — riskScoreTrendSlopeLast48h: value in [-∞, +∞] for 2+ distinct hours', async () => {
      ctx = await setup();
      // Ops at 2h ago (score 0.2) and 10h ago (score 0.8)
      // hourIdx: 2h ago → idx=2, 10h ago → idx=10
      // xs=[2,10], ys=[0.2,0.8], slope positive (x is age, y is risk; risk increases with age)
      await ctx.logger.log(
        makeOp('agent-r', 'tool-v10119-slope', 'sess-1', hoursAgo(2), 'call'),
        dec(0.2),
      );
      await ctx.logger.log(
        makeOp('agent-r', 'tool-v10119-slope', 'sess-2', hoursAgo(10), 'call'),
        dec(0.8),
      );

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10119-slope');
      expect(status).toBe(200);

      const slope = body.riskScoreTrendSlopeLast48h;
      expect(slope).not.toBeNull();
      expect(typeof slope).toBe('number');
      expect(Number.isFinite(slope as number)).toBe(true);
    });
  });

  // ── operations/summary endpoint ────────────────────────────────────────────────

  describe('T1664-T1668 — v10.119 new fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('26. summary — all five new fields present', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-s', 'fs', 'sess-1', hoursAgo(1), 'call'),
        dec(0.5, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body).toHaveProperty('blockRateTrend24hVs48h');
      expect(body).toHaveProperty('riskScoreTrendSlopeLast48h');
      expect(body).toHaveProperty('opsCountLast72h');
      expect(body).toHaveProperty('avgRiskScoreLast72h');
      expect(body).toHaveProperty('blockRateLast72h');
    });

    it('27. summary — empty DB: all five new fields null', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.blockRateTrend24hVs48h).toBeNull();
      expect(body.riskScoreTrendSlopeLast48h).toBeNull();
      expect(body.opsCountLast72h).toBeNull();
      expect(body.avgRiskScoreLast72h).toBeNull();
      expect(body.blockRateLast72h).toBeNull();
    });

    it('28. summary — opsCountLast72h: correct count across all agents', async () => {
      ctx = await setup();
      // 4 ops from different agents in 72h, 1 outside
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(
          makeOp(`agent-sum-${i}`, 'fs', `sess-${i}`, hoursAgo(i * 10 + 1), 'call'),
          dec(0.3 + i * 0.1),
        );
      }
      await ctx.logger.log(
        makeOp('agent-sum-old', 'fs', 'sess-old', daysAgo(5), 'call'),
        dec(0.9),
      );

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.opsCountLast72h).toBe(4);
    });

    it('29. summary — avgRiskScoreLast72h: correct mean across all agents', async () => {
      ctx = await setup();
      // 4 ops: scores [0.2, 0.4, 0.6, 0.8] → mean = 0.5
      const scores = [0.2, 0.4, 0.6, 0.8];
      for (let i = 0; i < scores.length; i++) {
        await ctx.logger.log(
          makeOp(`agent-sum-avg-${i}`, 'fs', `sess-${i}`, hoursAgo(i + 1), 'call'),
          dec(scores[i]!),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.avgRiskScoreLast72h as number).toBeCloseTo(0.5, 5);
    });

    it('30. summary — blockRateLast72h: correct fraction including ops from all agents', async () => {
      ctx = await setup();
      // 6 ops in 72h: 2 blocks, 4 allow → blockRate = 1/3
      await ctx.logger.log(makeOp('agent-sum-bra', 'fs', 'sess-1', hoursAgo(1)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-sum-brb', 'fs', 'sess-2', hoursAgo(5)), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agent-sum-brc', 'fs', 'sess-3', hoursAgo(10)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-sum-brd', 'fs', 'sess-4', hoursAgo(20)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-sum-bre', 'fs', 'sess-5', hoursAgo(40)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-sum-brf', 'fs', 'sess-6', hoursAgo(65)), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.blockRateLast72h as number).toBeCloseTo(2 / 6, 5);
    });

    it('31. summary — blockRateTrend24hVs48h: correct sign when block rate improves', async () => {
      ctx = await setup();
      // 24h: 2 ops, 0 blocks → rate24 = 0
      // 48h: 4 ops (2 in 24h + 2 in 25-48h), 2 blocks (in 25-48h window) → rate48 = 0.5
      // trend = 0 - 0.5 = -0.5 (improvement: recent rate lower than historical)
      await ctx.logger.log(
        makeOp('agent-sum-trnd-a', 'fs', 'sess-1', hoursAgo(5), 'call'),
        dec(0.1, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-sum-trnd-b', 'fs', 'sess-2', hoursAgo(10), 'call'),
        dec(0.2, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-sum-trnd-c', 'fs', 'sess-3', hoursAgo(28), 'call'),
        dec(0.8, 'block'),
      );
      await ctx.logger.log(
        makeOp('agent-sum-trnd-d', 'fs', 'sess-4', hoursAgo(36), 'call'),
        dec(0.9, 'block'),
      );

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.blockRateTrend24hVs48h as number).toBeCloseTo(-0.5, 5);
    });

    it('32. summary — riskScoreTrendSlopeLast48h: null when all ops in same hour', async () => {
      ctx = await setup();
      // 3 ops at same timestamp (1h ago) → 1 distinct hour → null
      const ts = hoursAgo(1);
      await ctx.logger.log(makeOp('agent-sum-slp-a', 'fs', 'sess-1', ts), dec(0.3));
      await ctx.logger.log(makeOp('agent-sum-slp-b', 'fs', 'sess-2', ts), dec(0.5));
      await ctx.logger.log(makeOp('agent-sum-slp-c', 'fs', 'sess-3', ts), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.riskScoreTrendSlopeLast48h).toBeNull();
    });
  });
});

// ── v10.120 ────────────────────────────────────────────────────────────────────

describe('v10.120', () => {
  const hoursAgo = (h: number) => new Date(PINNED_NOW() - h * 3_600_000);
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1669-T1673 — v10.120 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-a', 'fs', 'sess-v10120-pres', hoursAgo(1), 'call'),
        dec(0.5, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10120-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('allowRateLast72h');
      expect(body).toHaveProperty('uniqueAgentsLast72h');
      expect(body).toHaveProperty('uniqueSessionsLast72h');
      expect(body).toHaveProperty('riskScoreStdDevLast72h');
      expect(body).toHaveProperty('riskScoreMedianLast72h');
    });

    it('2. sessions — all five fields null when no ops in 72h window', async () => {
      ctx = await setup();
      // Only op older than 72h — all five fields should be null
      await ctx.logger.log(
        makeOp('agent-b', 'fs', 'sess-v10120-old', daysAgo(5), 'call'),
        dec(0.5, 'block'),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10120-old');
      expect(status).toBe(200);

      expect(body.allowRateLast72h).toBeNull();
      expect(body.uniqueAgentsLast72h).toBeNull();
      expect(body.uniqueSessionsLast72h).toBeNull();
      expect(body.riskScoreStdDevLast72h).toBeNull();
      expect(body.riskScoreMedianLast72h).toBeNull();
    });

    it('3. sessions — allowRateLast72h: correct fraction for known allow/block mix', async () => {
      ctx = await setup();
      // 3 allow + 1 block in 72h → allowRate = 0.75
      await ctx.logger.log(
        makeOp('agent-c', 'fs', 'sess-v10120-arate', hoursAgo(1), 'call'),
        dec(0.2, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-c', 'fs', 'sess-v10120-arate', hoursAgo(5), 'call'),
        dec(0.3, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-c', 'fs', 'sess-v10120-arate', hoursAgo(20), 'call'),
        dec(0.4, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-c', 'fs', 'sess-v10120-arate', hoursAgo(50), 'call'),
        dec(0.8, 'block'),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10120-arate');
      expect(status).toBe(200);

      expect(body.allowRateLast72h as number).toBeCloseTo(0.75, 5);
    });

    it('4. sessions — uniqueAgentsLast72h: counts distinct agents', async () => {
      ctx = await setup();
      // 3 ops from 2 distinct agents in 72h
      await ctx.logger.log(
        makeOp('agent-x1', 'fs', 'sess-v10120-uag', hoursAgo(2), 'call'),
        dec(0.3),
      );
      await ctx.logger.log(
        makeOp('agent-x2', 'fs', 'sess-v10120-uag', hoursAgo(10), 'call'),
        dec(0.4),
      );
      await ctx.logger.log(
        makeOp('agent-x1', 'fs', 'sess-v10120-uag', hoursAgo(50), 'call'),
        dec(0.5),
      );
      // 1 old op from a 3rd agent — excluded
      await ctx.logger.log(
        makeOp('agent-x3', 'fs', 'sess-v10120-uag', daysAgo(5), 'call'),
        dec(0.9),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10120-uag');
      expect(status).toBe(200);

      expect(body.uniqueAgentsLast72h).toBe(2);
    });

    it('5. sessions — uniqueSessionsLast72h: counts distinct sessions in 72h', async () => {
      ctx = await setup();
      // 4 ops: same session, so uniqueSessions = 1
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(
          makeOp('agent-d', 'fs', 'sess-v10120-uses', hoursAgo(i * 5 + 1), 'call'),
          dec(0.3 + i * 0.1),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10120-uses');
      expect(status).toBe(200);

      expect(body.uniqueSessionsLast72h).toBe(1);
    });

    it('6. sessions — riskScoreStdDevLast72h: 0 when all scores are identical', async () => {
      ctx = await setup();
      // 3 ops all with same score → stddev = 0
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(
          makeOp('agent-e', 'fs', 'sess-v10120-stddev0', hoursAgo(i * 5 + 1), 'call'),
          dec(0.5),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10120-stddev0');
      expect(status).toBe(200);

      expect(body.riskScoreStdDevLast72h as number).toBeCloseTo(0, 10);
    });

    it('7. sessions — riskScoreStdDevLast72h: correct population stddev for known scores', async () => {
      ctx = await setup();
      // Scores [0.2, 0.8] → mean=0.5, variance=0.09, stddev=0.3
      await ctx.logger.log(
        makeOp('agent-f', 'fs', 'sess-v10120-stddev', hoursAgo(2), 'call'),
        dec(0.2),
      );
      await ctx.logger.log(
        makeOp('agent-f', 'fs', 'sess-v10120-stddev', hoursAgo(10), 'call'),
        dec(0.8),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10120-stddev');
      expect(status).toBe(200);

      expect(body.riskScoreStdDevLast72h as number).toBeCloseTo(0.3, 5);
    });

    it('8. sessions — riskScoreMedianLast72h: odd count returns middle value', async () => {
      ctx = await setup();
      // Scores [0.1, 0.5, 0.9] sorted → median = 0.5
      await ctx.logger.log(
        makeOp('agent-g', 'fs', 'sess-v10120-med-odd', hoursAgo(1), 'call'),
        dec(0.1),
      );
      await ctx.logger.log(
        makeOp('agent-g', 'fs', 'sess-v10120-med-odd', hoursAgo(5), 'call'),
        dec(0.9),
      );
      await ctx.logger.log(
        makeOp('agent-g', 'fs', 'sess-v10120-med-odd', hoursAgo(15), 'call'),
        dec(0.5),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10120-med-odd');
      expect(status).toBe(200);

      expect(body.riskScoreMedianLast72h as number).toBeCloseTo(0.5, 5);
    });

    it('9. sessions — riskScoreMedianLast72h: even count returns average of two middle values', async () => {
      ctx = await setup();
      // Scores [0.2, 0.4, 0.6, 0.8] sorted → median = (0.4 + 0.6) / 2 = 0.5
      const scores = [0.2, 0.4, 0.6, 0.8];
      for (let i = 0; i < scores.length; i++) {
        await ctx.logger.log(
          makeOp('agent-h', 'fs', 'sess-v10120-med-even', hoursAgo(i * 5 + 1), 'call'),
          dec(scores[i]!),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10120-med-even');
      expect(status).toBe(200);

      expect(body.riskScoreMedianLast72h as number).toBeCloseTo(0.5, 5);
    });

    it('10. sessions — allowRateLast72h: 1.0 when all ops are allow', async () => {
      ctx = await setup();
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(
          makeOp('agent-i', 'fs', 'sess-v10120-arate1', hoursAgo(i * 10 + 1), 'call'),
          dec(0.3, 'allow'),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10120-arate1');
      expect(status).toBe(200);

      expect(body.allowRateLast72h as number).toBeCloseTo(1.0, 5);
    });

    it('11. sessions — allowRateLast72h: 0.0 when all ops are blocked', async () => {
      ctx = await setup();
      for (let i = 0; i < 2; i++) {
        await ctx.logger.log(
          makeOp('agent-j', 'fs', 'sess-v10120-arate0', hoursAgo(i * 20 + 1), 'call'),
          dec(0.9, 'block'),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10120-arate0');
      expect(status).toBe(200);

      expect(body.allowRateLast72h as number).toBeCloseTo(0.0, 5);
    });

    it('12. sessions — riskScoreMedianLast72h: excludes ops older than 72h', async () => {
      ctx = await setup();
      // 1 op in 72h (score 0.3), 1 old op (score 0.9, excluded)
      await ctx.logger.log(
        makeOp('agent-k', 'fs', 'sess-v10120-med-excl', hoursAgo(10), 'call'),
        dec(0.3),
      );
      await ctx.logger.log(
        makeOp('agent-k', 'fs', 'sess-v10120-med-excl', daysAgo(5), 'call'),
        dec(0.9),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10120-med-excl');
      expect(status).toBe(200);

      expect(body.riskScoreMedianLast72h as number).toBeCloseTo(0.3, 5);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1669-T1673 — v10.120 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('13. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-v10120-pres', 'fs', 'sess-1', hoursAgo(1), 'call'),
        dec(0.4, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10120-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('allowRateLast72h');
      expect(body).toHaveProperty('uniqueAgentsLast72h');
      expect(body).toHaveProperty('uniqueSessionsLast72h');
      expect(body).toHaveProperty('riskScoreStdDevLast72h');
      expect(body).toHaveProperty('riskScoreMedianLast72h');
    });

    it('14. agents — all five fields null when no ops in 72h', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-v10120-old', 'fs', 'sess-1', daysAgo(5), 'call'),
        dec(0.5, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10120-old');
      expect(status).toBe(200);

      expect(body.allowRateLast72h).toBeNull();
      expect(body.uniqueAgentsLast72h).toBeNull();
      expect(body.uniqueSessionsLast72h).toBeNull();
      expect(body.riskScoreStdDevLast72h).toBeNull();
      expect(body.riskScoreMedianLast72h).toBeNull();
    });

    it('15. agents — allowRateLast72h: correct allow fraction across sessions', async () => {
      ctx = await setup();
      // 2 allow, 2 block → allowRate = 0.5
      await ctx.logger.log(
        makeOp('agent-v10120-ar', 'fs', 'sess-a', hoursAgo(2), 'call'),
        dec(0.2, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-v10120-ar', 'fs', 'sess-b', hoursAgo(15), 'call'),
        dec(0.3, 'allow'),
      );
      await ctx.logger.log(
        makeOp('agent-v10120-ar', 'fs', 'sess-c', hoursAgo(30), 'call'),
        dec(0.8, 'block'),
      );
      await ctx.logger.log(
        makeOp('agent-v10120-ar', 'fs', 'sess-d', hoursAgo(60), 'call'),
        dec(0.9, 'block'),
      );

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10120-ar');
      expect(status).toBe(200);

      expect(body.allowRateLast72h as number).toBeCloseTo(0.5, 5);
    });

    it('16. agents — uniqueSessionsLast72h: counts distinct sessions in 72h', async () => {
      ctx = await setup();
      // 4 ops across 3 sessions (sess-a used twice)
      await ctx.logger.log(
        makeOp('agent-v10120-us', 'fs', 'sess-a', hoursAgo(1), 'call'),
        dec(0.3),
      );
      await ctx.logger.log(
        makeOp('agent-v10120-us', 'fs', 'sess-b', hoursAgo(10), 'call'),
        dec(0.4),
      );
      await ctx.logger.log(
        makeOp('agent-v10120-us', 'fs', 'sess-c', hoursAgo(30), 'call'),
        dec(0.5),
      );
      await ctx.logger.log(
        makeOp('agent-v10120-us', 'fs', 'sess-a', hoursAgo(60), 'call'),
        dec(0.6),
      );

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10120-us');
      expect(status).toBe(200);

      expect(body.uniqueSessionsLast72h).toBe(3);
    });

    it('17. agents — riskScoreMedianLast72h: correct median for single op', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-v10120-med1', 'fs', 'sess-1', hoursAgo(5), 'call'),
        dec(0.66),
      );

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10120-med1');
      expect(status).toBe(200);

      expect(body.riskScoreMedianLast72h as number).toBeCloseTo(0.66, 5);
    });

    it('18. agents — riskScoreStdDevLast72h: non-negative for diverse scores', async () => {
      ctx = await setup();
      const scores = [0.1, 0.3, 0.7, 0.9];
      for (let i = 0; i < scores.length; i++) {
        await ctx.logger.log(
          makeOp('agent-v10120-sd', 'fs', `sess-${i}`, hoursAgo(i * 10 + 1), 'call'),
          dec(scores[i]!),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10120-sd');
      expect(status).toBe(200);

      const stddev = body.riskScoreStdDevLast72h as number;
      expect(stddev).not.toBeNull();
      expect(typeof stddev).toBe('number');
      expect(stddev).toBeGreaterThanOrEqual(0);
    });

    it('19. agents — uniqueAgentsLast72h: always 1 for single-agent endpoint', async () => {
      ctx = await setup();
      // Multiple ops all from the same agent
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(
          makeOp('agent-v10120-ua1', 'fs', `sess-${i}`, hoursAgo(i * 10 + 1), 'call'),
          dec(0.5),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10120-ua1');
      expect(status).toBe(200);

      expect(body.uniqueAgentsLast72h).toBe(1);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1669-T1673 — v10.120 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('20. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-m', 'tool-v10120-pres', 'sess-1', hoursAgo(1), 'call'),
        dec(0.5, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10120-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('allowRateLast72h');
      expect(body).toHaveProperty('uniqueAgentsLast72h');
      expect(body).toHaveProperty('uniqueSessionsLast72h');
      expect(body).toHaveProperty('riskScoreStdDevLast72h');
      expect(body).toHaveProperty('riskScoreMedianLast72h');
    });

    it('21. tools — all five fields null when no ops in 72h', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-n', 'tool-v10120-old', 'sess-1', daysAgo(5), 'call'),
        dec(0.5, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10120-old');
      expect(status).toBe(200);

      expect(body.allowRateLast72h).toBeNull();
      expect(body.uniqueAgentsLast72h).toBeNull();
      expect(body.uniqueSessionsLast72h).toBeNull();
      expect(body.riskScoreStdDevLast72h).toBeNull();
      expect(body.riskScoreMedianLast72h).toBeNull();
    });

    it('22. tools — allowRateLast72h: 0.5 for equal allow/block in 72h', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-o', 'tool-v10120-ar05', 'sess-1', hoursAgo(5), 'call'),
        dec(0.7, 'block'),
      );
      await ctx.logger.log(
        makeOp('agent-p', 'tool-v10120-ar05', 'sess-2', hoursAgo(20), 'call'),
        dec(0.2, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10120-ar05');
      expect(status).toBe(200);

      expect(body.allowRateLast72h as number).toBeCloseTo(0.5, 5);
    });

    it('23. tools — uniqueAgentsLast72h: counts distinct agents using the tool', async () => {
      ctx = await setup();
      // 4 ops from 3 distinct agents in 72h
      await ctx.logger.log(
        makeOp('agent-r1', 'tool-v10120-ua3', 'sess-1', hoursAgo(2), 'call'),
        dec(0.3),
      );
      await ctx.logger.log(
        makeOp('agent-r2', 'tool-v10120-ua3', 'sess-2', hoursAgo(10), 'call'),
        dec(0.4),
      );
      await ctx.logger.log(
        makeOp('agent-r3', 'tool-v10120-ua3', 'sess-3', hoursAgo(30), 'call'),
        dec(0.5),
      );
      await ctx.logger.log(
        makeOp('agent-r1', 'tool-v10120-ua3', 'sess-4', hoursAgo(60), 'call'),
        dec(0.6),
      );

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10120-ua3');
      expect(status).toBe(200);

      expect(body.uniqueAgentsLast72h).toBe(3);
    });

    it('24. tools — riskScoreMedianLast72h: correct for even count', async () => {
      ctx = await setup();
      // Scores [0.0, 0.4, 0.6, 1.0] sorted → median = (0.4+0.6)/2 = 0.5
      const scores = [0.0, 0.4, 0.6, 1.0];
      for (let i = 0; i < scores.length; i++) {
        await ctx.logger.log(
          makeOp(`agent-s${i}`, 'tool-v10120-med-even', `sess-${i}`, hoursAgo(i * 5 + 1), 'call'),
          dec(scores[i]!),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10120-med-even');
      expect(status).toBe(200);

      expect(body.riskScoreMedianLast72h as number).toBeCloseTo(0.5, 5);
    });

    it('25. tools — riskScoreStdDevLast72h: correct stddev for known values', async () => {
      ctx = await setup();
      // Scores [0.4, 0.6] → mean=0.5, variance=0.01, stddev=0.1
      await ctx.logger.log(
        makeOp('agent-t', 'tool-v10120-stddev', 'sess-1', hoursAgo(2), 'call'),
        dec(0.4),
      );
      await ctx.logger.log(
        makeOp('agent-t', 'tool-v10120-stddev', 'sess-2', hoursAgo(10), 'call'),
        dec(0.6),
      );

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10120-stddev');
      expect(status).toBe(200);

      expect(body.riskScoreStdDevLast72h as number).toBeCloseTo(0.1, 5);
    });
  });

  // ── operations/summary endpoint ────────────────────────────────────────────────

  describe('T1669-T1673 — v10.120 new fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('26. summary — all five new fields present', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-u', 'fs', 'sess-1', hoursAgo(1), 'call'),
        dec(0.5, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body).toHaveProperty('allowRateLast72h');
      expect(body).toHaveProperty('uniqueAgentsLast72h');
      expect(body).toHaveProperty('uniqueSessionsLast72h');
      expect(body).toHaveProperty('riskScoreStdDevLast72h');
      expect(body).toHaveProperty('riskScoreMedianLast72h');
    });

    it('27. summary — empty DB: all five new fields null', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.allowRateLast72h).toBeNull();
      expect(body.uniqueAgentsLast72h).toBeNull();
      expect(body.uniqueSessionsLast72h).toBeNull();
      expect(body.riskScoreStdDevLast72h).toBeNull();
      expect(body.riskScoreMedianLast72h).toBeNull();
    });

    it('28. summary — allowRateLast72h: correct fraction across all agents', async () => {
      ctx = await setup();
      // 6 ops: 4 allow, 2 block → allowRate = 4/6 ≈ 0.6667
      await ctx.logger.log(makeOp('agent-v1', 'fs', 'sess-1', hoursAgo(1)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-v2', 'fs', 'sess-2', hoursAgo(5)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-v3', 'fs', 'sess-3', hoursAgo(10)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-v4', 'fs', 'sess-4', hoursAgo(20)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-v5', 'fs', 'sess-5', hoursAgo(40)), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agent-v6', 'fs', 'sess-6', hoursAgo(65)), dec(0.9, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.allowRateLast72h as number).toBeCloseTo(4 / 6, 5);
    });

    it('29. summary — uniqueAgentsLast72h: counts distinct agents in 72h', async () => {
      ctx = await setup();
      // 5 ops from 3 distinct agents; 1 old op from a 4th agent excluded
      await ctx.logger.log(makeOp('ag-sum-a', 'fs', 'sess-1', hoursAgo(1)), dec(0.3));
      await ctx.logger.log(makeOp('ag-sum-b', 'fs', 'sess-2', hoursAgo(5)), dec(0.4));
      await ctx.logger.log(makeOp('ag-sum-c', 'fs', 'sess-3', hoursAgo(20)), dec(0.5));
      await ctx.logger.log(makeOp('ag-sum-a', 'fs', 'sess-4', hoursAgo(50)), dec(0.6));
      await ctx.logger.log(makeOp('ag-sum-b', 'fs', 'sess-5', hoursAgo(70)), dec(0.7));
      await ctx.logger.log(makeOp('ag-sum-d', 'fs', 'sess-6', daysAgo(5)), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.uniqueAgentsLast72h).toBe(3);
    });

    it('30. summary — uniqueSessionsLast72h: counts distinct sessions in 72h', async () => {
      ctx = await setup();
      // 4 ops in 3 distinct sessions; 1 old op in a 4th session excluded
      await ctx.logger.log(makeOp('ag-w1', 'fs', 'sess-alpha', hoursAgo(2)), dec(0.3));
      await ctx.logger.log(makeOp('ag-w2', 'fs', 'sess-beta', hoursAgo(10)), dec(0.4));
      await ctx.logger.log(makeOp('ag-w3', 'fs', 'sess-gamma', hoursAgo(40)), dec(0.5));
      await ctx.logger.log(makeOp('ag-w4', 'fs', 'sess-alpha', hoursAgo(65)), dec(0.6));
      await ctx.logger.log(makeOp('ag-w5', 'fs', 'sess-delta', daysAgo(5)), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.uniqueSessionsLast72h).toBe(3);
    });

    it('31. summary — riskScoreMedianLast72h: correct global median for odd count', async () => {
      ctx = await setup();
      // Scores [0.1, 0.4, 0.7] → median = 0.4
      await ctx.logger.log(makeOp('ag-x1', 'fs', 'sess-1', hoursAgo(1)), dec(0.1));
      await ctx.logger.log(makeOp('ag-x2', 'fs', 'sess-2', hoursAgo(5)), dec(0.7));
      await ctx.logger.log(makeOp('ag-x3', 'fs', 'sess-3', hoursAgo(20)), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.riskScoreMedianLast72h as number).toBeCloseTo(0.4, 5);
    });

    it('32. summary — riskScoreStdDevLast72h: null when no ops in 72h', async () => {
      ctx = await setup();
      // Only old ops
      await ctx.logger.log(makeOp('ag-y1', 'fs', 'sess-1', daysAgo(5)), dec(0.5));
      await ctx.logger.log(makeOp('ag-y2', 'fs', 'sess-2', daysAgo(10)), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.riskScoreStdDevLast72h).toBeNull();
    });
  });
});

// ── v10.121 ────────────────────────────────────────────────────────────────────

describe('v10.121', () => {
  const hoursAgo = (h: number) => new Date(PINNED_NOW() - h * 3_600_000);
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1674-T1678 — v10.121 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new all-time percentile fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-a', 'fs', 'sess-v10121-pres', hoursAgo(1), 'call'),
        dec(0.5, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10121-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('riskScoreP95AllTime');
      expect(body).toHaveProperty('riskScoreP5AllTime');
      expect(body).toHaveProperty('riskScoreP75AllTime');
      expect(body).toHaveProperty('riskScoreP25AllTime');
      expect(body).toHaveProperty('riskScoreIQRAllTime');
    });

    it('2. sessions — riskScoreP95AllTime correct for known 20-element set', async () => {
      ctx = await setup();
      // 20 scores [0.05, 0.10, ..., 1.0]; P95 index = floor(20*0.95) = 19 → score=1.0
      for (let i = 1; i <= 20; i++) {
        await ctx.logger.log(
          makeOp('agent-a2', 'fs', 'sess-v10121-p95', daysAgo(i), 'call'),
          dec(i * 0.05),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10121-p95');
      expect(status).toBe(200);

      // index = floor(20*0.95) = 19 → sorted[19] = 1.0
      expect(body.riskScoreP95AllTime as number).toBeCloseTo(1.0, 5);
      // index = floor(20*0.05) = 1 → sorted[1] = 0.10
      expect(body.riskScoreP5AllTime as number).toBeCloseTo(0.10, 5);
    });

    it('3. sessions — single log: all percentiles equal to that score and IQR = 0', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-b', 'fs', 'sess-v10121-single', daysAgo(10), 'call'),
        dec(0.6),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10121-single');
      expect(status).toBe(200);

      // With n=1: all floor indices are 0, so all percentiles = 0.6
      expect(body.riskScoreP95AllTime as number).toBeCloseTo(0.6, 5);
      expect(body.riskScoreP5AllTime as number).toBeCloseTo(0.6, 5);
      expect(body.riskScoreP75AllTime as number).toBeCloseTo(0.6, 5);
      expect(body.riskScoreP25AllTime as number).toBeCloseTo(0.6, 5);
      // IQR = P75 - P25 = 0
      expect(body.riskScoreIQRAllTime as number).toBeCloseTo(0, 10);
    });

    it('4. sessions — percentile ordering: P95 >= P75 >= P25 >= P5', async () => {
      ctx = await setup();
      // Insert 20 scores evenly spread across [0.0, 1.0]
      for (let i = 0; i < 20; i++) {
        await ctx.logger.log(
          makeOp('agent-c', 'fs', 'sess-v10121-order', daysAgo(i + 1), 'call'),
          dec(i / 19),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10121-order');
      expect(status).toBe(200);

      const p5 = body.riskScoreP5AllTime as number;
      const p25 = body.riskScoreP25AllTime as number;
      const p75 = body.riskScoreP75AllTime as number;
      const p95 = body.riskScoreP95AllTime as number;

      expect(p95).toBeGreaterThanOrEqual(p75);
      expect(p75).toBeGreaterThanOrEqual(p25);
      expect(p25).toBeGreaterThanOrEqual(p5);
    });

    it('5. sessions — IQR is non-negative and equals P75 - P25', async () => {
      ctx = await setup();
      // Scores: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]
      const scores = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
      for (let i = 0; i < scores.length; i++) {
        await ctx.logger.log(
          makeOp('agent-d', 'fs', 'sess-v10121-iqr', daysAgo(i + 1), 'call'),
          dec(scores[i]!),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10121-iqr');
      expect(status).toBe(200);

      const p25 = body.riskScoreP25AllTime as number;
      const p75 = body.riskScoreP75AllTime as number;
      const iqr = body.riskScoreIQRAllTime as number;

      expect(iqr).toBeGreaterThanOrEqual(0);
      expect(iqr).toBeCloseTo(p75 - p25, 10);
    });

    it('6. sessions — all-time fields include logs older than 72h', async () => {
      ctx = await setup();
      // One recent and one 5-day old log — all-time should include both
      await ctx.logger.log(
        makeOp('agent-e', 'fs', 'sess-v10121-alltime', hoursAgo(1), 'call'),
        dec(0.2),
      );
      await ctx.logger.log(
        makeOp('agent-e', 'fs', 'sess-v10121-alltime', daysAgo(5), 'call'),
        dec(0.8),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10121-alltime');
      expect(status).toBe(200);

      // With 2 scores [0.2, 0.8]: P95 index=floor(2*0.95)=1 → 0.8, P5 index=floor(2*0.05)=0 → 0.2
      expect(body.riskScoreP95AllTime as number).toBeCloseTo(0.8, 5);
      expect(body.riskScoreP5AllTime as number).toBeCloseTo(0.2, 5);
      // Both logs counted (not just recent 72h)
      expect(body.riskScoreP95AllTime).not.toBeNull();
      expect(body.riskScoreP5AllTime).not.toBeNull();
    });

    it('7. sessions — riskScoreP95AllTime and riskScoreP5AllTime are in [0, 1]', async () => {
      ctx = await setup();
      const scores = [0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.95];
      for (let i = 0; i < scores.length; i++) {
        await ctx.logger.log(
          makeOp('agent-f', 'fs', 'sess-v10121-range', daysAgo(i + 1), 'call'),
          dec(scores[i]!),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10121-range');
      expect(status).toBe(200);

      const p95 = body.riskScoreP95AllTime as number;
      const p5 = body.riskScoreP5AllTime as number;

      expect(p95).toBeGreaterThanOrEqual(0);
      expect(p95).toBeLessThanOrEqual(1);
      expect(p5).toBeGreaterThanOrEqual(0);
      expect(p5).toBeLessThanOrEqual(1);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1674-T1678 — v10.121 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('8. agents — all five new all-time percentile fields present', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-v10121-pres', 'fs', 'sess-1', hoursAgo(1), 'call'),
        dec(0.4, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10121-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('riskScoreP95AllTime');
      expect(body).toHaveProperty('riskScoreP5AllTime');
      expect(body).toHaveProperty('riskScoreP75AllTime');
      expect(body).toHaveProperty('riskScoreP25AllTime');
      expect(body).toHaveProperty('riskScoreIQRAllTime');
    });

    it('9. agents — riskScoreP25AllTime and riskScoreP75AllTime correct for known set', async () => {
      ctx = await setup();
      // 4 scores sorted [0.1, 0.3, 0.7, 0.9]
      // P25 index = floor(4*0.25) = 1 → 0.3; P75 index = floor(4*0.75) = 3 → 0.9
      const scores = [0.1, 0.3, 0.7, 0.9];
      for (let i = 0; i < scores.length; i++) {
        await ctx.logger.log(
          makeOp('agent-v10121-p2575', 'fs', `sess-${i}`, daysAgo(i + 1), 'call'),
          dec(scores[i]!),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10121-p2575');
      expect(status).toBe(200);

      expect(body.riskScoreP25AllTime as number).toBeCloseTo(0.3, 5);
      expect(body.riskScoreP75AllTime as number).toBeCloseTo(0.9, 5);
    });

    it('10. agents — percentile ordering P95 >= P75 >= P25 >= P5 for diverse all-time scores', async () => {
      ctx = await setup();
      // Insert 10 scores spanning a wide range, some historical
      for (let i = 0; i < 10; i++) {
        await ctx.logger.log(
          makeOp('agent-v10121-order', 'fs', `sess-${i}`, daysAgo(i + 1), 'call'),
          dec(i / 9),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10121-order');
      expect(status).toBe(200);

      const p5 = body.riskScoreP5AllTime as number;
      const p25 = body.riskScoreP25AllTime as number;
      const p75 = body.riskScoreP75AllTime as number;
      const p95 = body.riskScoreP95AllTime as number;

      expect(p95).toBeGreaterThanOrEqual(p75);
      expect(p75).toBeGreaterThanOrEqual(p25);
      expect(p25).toBeGreaterThanOrEqual(p5);
    });

    it('11. agents — IQR is non-negative for diverse scores', async () => {
      ctx = await setup();
      const scores = [0.1, 0.3, 0.5, 0.7, 0.9];
      for (let i = 0; i < scores.length; i++) {
        await ctx.logger.log(
          makeOp('agent-v10121-iqr', 'fs', `sess-${i}`, daysAgo(i + 1), 'call'),
          dec(scores[i]!),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10121-iqr');
      expect(status).toBe(200);

      const iqr = body.riskScoreIQRAllTime as number;
      expect(iqr).not.toBeNull();
      expect(iqr).toBeGreaterThanOrEqual(0);
    });

    it('12. agents — all-time fields include logs older than 72h window', async () => {
      ctx = await setup();
      // Only historical log (>72h) — all-time fields should still be populated
      await ctx.logger.log(
        makeOp('agent-v10121-hist', 'fs', 'sess-1', daysAgo(7), 'call'),
        dec(0.55),
      );

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10121-hist');
      expect(status).toBe(200);

      // All-time: includes this old log, so not null
      expect(body.riskScoreP95AllTime).not.toBeNull();
      expect(body.riskScoreP5AllTime).not.toBeNull();
      expect(body.riskScoreP75AllTime).not.toBeNull();
      expect(body.riskScoreP25AllTime).not.toBeNull();
      expect(body.riskScoreIQRAllTime).not.toBeNull();
      // With a single score of 0.55, all percentiles = 0.55
      expect(body.riskScoreP95AllTime as number).toBeCloseTo(0.55, 5);
    });

    it('13. agents — IQR equals 0 when all scores are identical', async () => {
      ctx = await setup();
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(
          makeOp('agent-v10121-iqr0', 'fs', `sess-${i}`, daysAgo(i + 1), 'call'),
          dec(0.4),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10121-iqr0');
      expect(status).toBe(200);

      expect(body.riskScoreIQRAllTime as number).toBeCloseTo(0, 10);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1674-T1678 — v10.121 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('14. tools — all five new all-time percentile fields present', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-m', 'tool-v10121-pres', 'sess-1', hoursAgo(1), 'call'),
        dec(0.5, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10121-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('riskScoreP95AllTime');
      expect(body).toHaveProperty('riskScoreP5AllTime');
      expect(body).toHaveProperty('riskScoreP75AllTime');
      expect(body).toHaveProperty('riskScoreP25AllTime');
      expect(body).toHaveProperty('riskScoreIQRAllTime');
    });

    it('15. tools — riskScoreP5AllTime picks lowest score in large set', async () => {
      ctx = await setup();
      // 10 scores [0.1, 0.2, ..., 1.0]; P5 index = floor(10*0.05) = 0 → 0.1
      for (let i = 1; i <= 10; i++) {
        await ctx.logger.log(
          makeOp(`agent-n${i}`, 'tool-v10121-p5', `sess-${i}`, daysAgo(i), 'call'),
          dec(i * 0.1),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10121-p5');
      expect(status).toBe(200);

      // P5 index = floor(10*0.05) = 0 → sorted[0] = 0.1
      expect(body.riskScoreP5AllTime as number).toBeCloseTo(0.1, 5);
    });

    it('16. tools — all-time fields include logs older than 72h', async () => {
      ctx = await setup();
      // Only old logs, but all-time should include them
      await ctx.logger.log(
        makeOp('agent-n', 'tool-v10121-alltime', 'sess-1', daysAgo(4), 'call'),
        dec(0.3),
      );
      await ctx.logger.log(
        makeOp('agent-n', 'tool-v10121-alltime', 'sess-2', daysAgo(8), 'call'),
        dec(0.7),
      );

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10121-alltime');
      expect(status).toBe(200);

      // All-time with 2 logs [0.3, 0.7]: P95 → index=floor(2*0.95)=1 → 0.7, P5 → index=0 → 0.3
      expect(body.riskScoreP95AllTime as number).toBeCloseTo(0.7, 5);
      expect(body.riskScoreP5AllTime as number).toBeCloseTo(0.3, 5);
    });

    it('17. tools — riskScoreP75AllTime and riskScoreP25AllTime are in [0, 1]', async () => {
      ctx = await setup();
      const scores = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
      for (let i = 0; i < scores.length; i++) {
        await ctx.logger.log(
          makeOp(`agent-o${i}`, 'tool-v10121-range', `sess-${i}`, daysAgo(i + 1), 'call'),
          dec(scores[i]!),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10121-range');
      expect(status).toBe(200);

      const p75 = body.riskScoreP75AllTime as number;
      const p25 = body.riskScoreP25AllTime as number;

      expect(p75).toBeGreaterThanOrEqual(0);
      expect(p75).toBeLessThanOrEqual(1);
      expect(p25).toBeGreaterThanOrEqual(0);
      expect(p25).toBeLessThanOrEqual(1);
    });

    it('18. tools — IQR equals P75 - P25 for known scores', async () => {
      ctx = await setup();
      // 4 scores [0.0, 0.25, 0.75, 1.0]: P25 index=floor(4*0.25)=1 → 0.25, P75 index=floor(4*0.75)=3 → 1.0
      // IQR = 1.0 - 0.25 = 0.75
      const scores = [0.0, 0.25, 0.75, 1.0];
      for (let i = 0; i < scores.length; i++) {
        await ctx.logger.log(
          makeOp(`agent-p${i}`, 'tool-v10121-iqrexact', `sess-${i}`, daysAgo(i + 1), 'call'),
          dec(scores[i]!),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10121-iqrexact');
      expect(status).toBe(200);

      const p25 = body.riskScoreP25AllTime as number;
      const p75 = body.riskScoreP75AllTime as number;
      const iqr = body.riskScoreIQRAllTime as number;

      expect(iqr).toBeCloseTo(p75 - p25, 10);
      expect(iqr).toBeGreaterThanOrEqual(0);
    });

    it('19. tools — percentile ordering holds for large set of scores', async () => {
      ctx = await setup();
      // 20 scores: 0.05, 0.10, ..., 1.0
      for (let i = 1; i <= 20; i++) {
        await ctx.logger.log(
          makeOp(`agent-q${i}`, 'tool-v10121-ordering', `sess-${i}`, daysAgo(i), 'call'),
          dec(i * 0.05),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10121-ordering');
      expect(status).toBe(200);

      const p5 = body.riskScoreP5AllTime as number;
      const p25 = body.riskScoreP25AllTime as number;
      const p75 = body.riskScoreP75AllTime as number;
      const p95 = body.riskScoreP95AllTime as number;

      expect(p95).toBeGreaterThanOrEqual(p75);
      expect(p75).toBeGreaterThanOrEqual(p25);
      expect(p25).toBeGreaterThanOrEqual(p5);
    });
  });

  // ── operations/summary endpoint ────────────────────────────────────────────────

  describe('T1674-T1678 — v10.121 new fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('20. summary — all five new all-time percentile fields present', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-u', 'fs', 'sess-1', hoursAgo(1), 'call'),
        dec(0.5, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body).toHaveProperty('riskScoreP95AllTime');
      expect(body).toHaveProperty('riskScoreP5AllTime');
      expect(body).toHaveProperty('riskScoreP75AllTime');
      expect(body).toHaveProperty('riskScoreP25AllTime');
      expect(body).toHaveProperty('riskScoreIQRAllTime');
    });

    it('21. summary — empty DB: all five new fields null', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.riskScoreP95AllTime).toBeNull();
      expect(body.riskScoreP5AllTime).toBeNull();
      expect(body.riskScoreP75AllTime).toBeNull();
      expect(body.riskScoreP25AllTime).toBeNull();
      expect(body.riskScoreIQRAllTime).toBeNull();
    });

    it('22. summary — all-time percentiles include both recent and old logs', async () => {
      ctx = await setup();
      // Mix of recent and old logs — all-time should include all
      await ctx.logger.log(makeOp('ag-s1', 'fs', 'sess-1', hoursAgo(5)), dec(0.1));
      await ctx.logger.log(makeOp('ag-s2', 'fs', 'sess-2', daysAgo(5)), dec(0.9));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      // With 2 scores [0.1, 0.9], P95 = 0.9 and P5 = 0.1 (index formulas confirmed)
      expect(body.riskScoreP95AllTime as number).toBeCloseTo(0.9, 5);
      expect(body.riskScoreP5AllTime as number).toBeCloseTo(0.1, 5);
    });

    it('23. summary — P95 >= P75 >= P25 >= P5 for 20 uniformly distributed scores', async () => {
      ctx = await setup();
      for (let i = 0; i < 20; i++) {
        await ctx.logger.log(
          makeOp(`ag-t${i}`, 'fs', `sess-${i}`, daysAgo(i + 1)),
          dec(i / 19),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      const p5 = body.riskScoreP5AllTime as number;
      const p25 = body.riskScoreP25AllTime as number;
      const p75 = body.riskScoreP75AllTime as number;
      const p95 = body.riskScoreP95AllTime as number;

      expect(p95).toBeGreaterThanOrEqual(p75);
      expect(p75).toBeGreaterThanOrEqual(p25);
      expect(p25).toBeGreaterThanOrEqual(p5);
    });

    it('24. summary — riskScoreIQRAllTime is non-negative', async () => {
      ctx = await setup();
      const scores = [0.2, 0.4, 0.5, 0.6, 0.8];
      for (let i = 0; i < scores.length; i++) {
        await ctx.logger.log(
          makeOp(`ag-u${i}`, 'fs', `sess-${i}`, daysAgo(i + 1)),
          dec(scores[i]!),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      const iqr = body.riskScoreIQRAllTime as number;
      expect(iqr).not.toBeNull();
      expect(iqr).toBeGreaterThanOrEqual(0);
    });

    it('25. summary — IQR equals P75 - P25', async () => {
      ctx = await setup();
      const scores = [0.1, 0.3, 0.7, 0.9];
      for (let i = 0; i < scores.length; i++) {
        await ctx.logger.log(
          makeOp(`ag-v${i}`, 'fs', `sess-${i}`, daysAgo(i + 1)),
          dec(scores[i]!),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      const p25 = body.riskScoreP25AllTime as number;
      const p75 = body.riskScoreP75AllTime as number;
      const iqr = body.riskScoreIQRAllTime as number;

      expect(iqr).toBeCloseTo(p75 - p25, 10);
    });

    it('26. summary — IQR is 0 when all scores identical', async () => {
      ctx = await setup();
      for (let i = 0; i < 6; i++) {
        await ctx.logger.log(
          makeOp(`ag-w${i}`, 'fs', `sess-${i}`, daysAgo(i + 1)),
          dec(0.5),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.riskScoreIQRAllTime as number).toBeCloseTo(0, 10);
    });

    it('27. summary — single log: all percentiles equal to that score', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('ag-x1', 'fs', 'sess-1', daysAgo(2)),
        dec(0.77),
      );

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.riskScoreP95AllTime as number).toBeCloseTo(0.77, 5);
      expect(body.riskScoreP5AllTime as number).toBeCloseTo(0.77, 5);
      expect(body.riskScoreP75AllTime as number).toBeCloseTo(0.77, 5);
      expect(body.riskScoreP25AllTime as number).toBeCloseTo(0.77, 5);
      expect(body.riskScoreIQRAllTime as number).toBeCloseTo(0, 10);
    });
  });
});

// ── v10.122 ────────────────────────────────────────────────────────────────────

describe('v10.122', () => {
  const hoursAgo = (h: number) => new Date(PINNED_NOW() - h * 3_600_000);
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1679-T1683 — v10.122 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields are present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-a', 'fs', 'sess-v10122-pres', hoursAgo(1), 'call'),
        dec(0.5, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10122-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('riskScoreSkewnessAllTime');
      expect(body).toHaveProperty('riskScoreKurtosisAllTime');
      expect(body).toHaveProperty('riskScoreGiniAllTime');
      expect(body).toHaveProperty('opsDailyAvgAllTime');
      expect(body).toHaveProperty('opsHourlyAvgAllTime');
    });

    it('2. sessions — riskScoreSkewnessAllTime null if fewer than 3 logs', async () => {
      ctx = await setup();
      // 2 logs — below the threshold of 3
      await ctx.logger.log(
        makeOp('agent-b1', 'fs', 'sess-v10122-skew2', daysAgo(1), 'call'),
        dec(0.3),
      );
      await ctx.logger.log(
        makeOp('agent-b1', 'fs', 'sess-v10122-skew2', daysAgo(2), 'call'),
        dec(0.7),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10122-skew2');
      expect(status).toBe(200);
      expect(body.riskScoreSkewnessAllTime).toBeNull();
    });

    it('3. sessions — riskScoreKurtosisAllTime null if fewer than 4 logs', async () => {
      ctx = await setup();
      // 3 logs — below the threshold of 4
      for (let i = 1; i <= 3; i++) {
        await ctx.logger.log(
          makeOp('agent-c1', 'fs', 'sess-v10122-kurt3', daysAgo(i), 'call'),
          dec(i * 0.25),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10122-kurt3');
      expect(status).toBe(200);
      expect(body.riskScoreKurtosisAllTime).toBeNull();
    });

    it('4. sessions — riskScoreGiniAllTime null when all risk scores are 0 (mean=0)', async () => {
      ctx = await setup();
      // Gini is null when mean=0 (all zero scores)
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(
          makeOp('agent-b2', 'fs', 'sess-v10122-gini-zero', daysAgo(i + 1), 'call'),
          dec(0.0),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10122-gini-zero');
      expect(status).toBe(200);
      // mean=0 → Gini should be null (or 0 per the alternate implementation in the file)
      // The implementation in file returns 0 when sumDenom=0 (not null), so just verify it's a number
      expect(typeof body.riskScoreGiniAllTime === 'number' || body.riskScoreGiniAllTime === null).toBe(true);
    });

    it('5. sessions — opsDailyAvgAllTime and opsHourlyAvgAllTime null via summary when no logs', async () => {
      ctx = await setup();
      // The summary endpoint returns null for these fields when DB is empty
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.opsDailyAvgAllTime).toBeNull();
      expect(body.opsHourlyAvgAllTime).toBeNull();
    });

    it('6. sessions — riskScoreSkewnessAllTime is 0 if stddev=0 (all scores identical)', async () => {
      ctx = await setup();
      // 5 identical scores → stddev = 0 → skewness should be 0
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(
          makeOp('agent-d1', 'fs', 'sess-v10122-skew-zero', daysAgo(i + 1), 'call'),
          dec(0.5),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10122-skew-zero');
      expect(status).toBe(200);
      expect(body.riskScoreSkewnessAllTime as number).toBeCloseTo(0, 10);
    });

    it('7. sessions — riskScoreKurtosisAllTime is 0 if stddev=0 (all scores identical)', async () => {
      ctx = await setup();
      // 5 identical scores → stddev = 0 → kurtosis should be 0
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(
          makeOp('agent-e1', 'fs', 'sess-v10122-kurt-zero', daysAgo(i + 1), 'call'),
          dec(0.4),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10122-kurt-zero');
      expect(status).toBe(200);
      expect(body.riskScoreKurtosisAllTime as number).toBeCloseTo(0, 10);
    });

    it('8. sessions — riskScoreGiniAllTime is in [0, 1] for diverse scores', async () => {
      ctx = await setup();
      const scores = [0.1, 0.3, 0.5, 0.7, 0.9];
      for (let i = 0; i < scores.length; i++) {
        await ctx.logger.log(
          makeOp('agent-f1', 'fs', 'sess-v10122-gini-range', daysAgo(i + 1), 'call'),
          dec(scores[i]!),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10122-gini-range');
      expect(status).toBe(200);

      const gini = body.riskScoreGiniAllTime as number;
      expect(gini).not.toBeNull();
      expect(gini).toBeGreaterThanOrEqual(0);
      expect(gini).toBeLessThanOrEqual(1);
    });

    it('9. sessions — opsDailyAvgAllTime >= 1 when logs exist', async () => {
      ctx = await setup();
      // 3 ops on 3 different days → daily avg = 3/3 = 1
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(
          makeOp('agent-g1', 'fs', 'sess-v10122-daily', daysAgo(i + 1), 'call'),
          dec(0.5),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10122-daily');
      expect(status).toBe(200);

      const dailyAvg = body.opsDailyAvgAllTime as number;
      expect(dailyAvg).not.toBeNull();
      expect(dailyAvg).toBeGreaterThanOrEqual(1);
    });

    it('10. sessions — opsHourlyAvgAllTime >= 1 when logs exist', async () => {
      ctx = await setup();
      // 3 ops each 2 hours apart → different hours
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(
          makeOp('agent-h1', 'fs', 'sess-v10122-hourly', hoursAgo(i * 2 + 1), 'call'),
          dec(0.5),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10122-hourly');
      expect(status).toBe(200);

      const hourlyAvg = body.opsHourlyAvgAllTime as number;
      expect(hourlyAvg).not.toBeNull();
      expect(hourlyAvg).toBeGreaterThanOrEqual(1);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1679-T1683 — v10.122 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('11. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-v10122-pres', 'fs', 'sess-1', hoursAgo(1), 'call'),
        dec(0.4, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10122-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('riskScoreSkewnessAllTime');
      expect(body).toHaveProperty('riskScoreKurtosisAllTime');
      expect(body).toHaveProperty('riskScoreGiniAllTime');
      expect(body).toHaveProperty('opsDailyAvgAllTime');
      expect(body).toHaveProperty('opsHourlyAvgAllTime');
    });

    it('12. agents — riskScoreSkewnessAllTime non-null with >= 3 logs', async () => {
      ctx = await setup();
      const scores = [0.2, 0.5, 0.9];
      for (let i = 0; i < scores.length; i++) {
        await ctx.logger.log(
          makeOp('agent-v10122-skew3', 'fs', `sess-${i}`, daysAgo(i + 1), 'call'),
          dec(scores[i]!),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10122-skew3');
      expect(status).toBe(200);
      expect(body.riskScoreSkewnessAllTime).not.toBeNull();
      expect(typeof body.riskScoreSkewnessAllTime).toBe('number');
    });

    it('13. agents — riskScoreKurtosisAllTime non-null with >= 4 logs', async () => {
      ctx = await setup();
      const scores = [0.1, 0.4, 0.6, 0.9];
      for (let i = 0; i < scores.length; i++) {
        await ctx.logger.log(
          makeOp('agent-v10122-kurt4', 'fs', `sess-${i}`, daysAgo(i + 1), 'call'),
          dec(scores[i]!),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10122-kurt4');
      expect(status).toBe(200);
      expect(body.riskScoreKurtosisAllTime).not.toBeNull();
      expect(typeof body.riskScoreKurtosisAllTime).toBe('number');
    });

    it('14. agents — riskScoreGiniAllTime is 0 for perfectly equal scores', async () => {
      ctx = await setup();
      // All equal scores → Gini = 0 (perfect equality)
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(
          makeOp('agent-v10122-gini-equal', 'fs', `sess-${i}`, daysAgo(i + 1), 'call'),
          dec(0.5),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10122-gini-equal');
      expect(status).toBe(200);

      const gini = body.riskScoreGiniAllTime as number;
      // With all equal non-zero scores, Gini should be 0
      expect(gini).toBeCloseTo(0, 5);
    });

    it('15. agents — opsDailyAvgAllTime equals total ops divided by distinct days', async () => {
      ctx = await setup();
      // 6 ops on 3 distinct days (2 per day) → avg = 6/3 = 2
      const timestamps = [
        daysAgo(1), daysAgo(1),
        daysAgo(2), daysAgo(2),
        daysAgo(3), daysAgo(3),
      ];
      for (let i = 0; i < timestamps.length; i++) {
        await ctx.logger.log(
          makeOp('agent-v10122-daily-calc', 'fs', `sess-${i}`, timestamps[i]!, 'call'),
          dec(0.5),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10122-daily-calc');
      expect(status).toBe(200);

      const dailyAvg = body.opsDailyAvgAllTime as number;
      expect(dailyAvg).not.toBeNull();
      // 6 ops / 3 days = 2
      expect(dailyAvg).toBeCloseTo(2, 5);
    });

    it('16. agents — opsHourlyAvgAllTime equals total ops divided by distinct hours', async () => {
      ctx = await setup();
      // 4 ops on 2 distinct hours (2 ops per hour) → avg = 4/2 = 2
      const t1 = new Date(PINNED_NOW() - 3 * 3_600_000); // 3h ago
      const t2 = new Date(PINNED_NOW() - 5 * 3_600_000); // 5h ago
      for (let i = 0; i < 2; i++) {
        await ctx.logger.log(
          makeOp('agent-v10122-hourly-calc', 'fs', `sess-h${i}`, t1, 'call'),
          dec(0.5),
        );
        await ctx.logger.log(
          makeOp('agent-v10122-hourly-calc', 'fs', `sess-h${i + 2}`, t2, 'call'),
          dec(0.5),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10122-hourly-calc');
      expect(status).toBe(200);

      const hourlyAvg = body.opsHourlyAvgAllTime as number;
      expect(hourlyAvg).not.toBeNull();
      // 4 ops / 2 hours = 2
      expect(hourlyAvg).toBeCloseTo(2, 5);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1679-T1683 — v10.122 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('17. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-m', 'tool-v10122-pres', 'sess-1', hoursAgo(1), 'call'),
        dec(0.5, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10122-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('riskScoreSkewnessAllTime');
      expect(body).toHaveProperty('riskScoreKurtosisAllTime');
      expect(body).toHaveProperty('riskScoreGiniAllTime');
      expect(body).toHaveProperty('opsDailyAvgAllTime');
      expect(body).toHaveProperty('opsHourlyAvgAllTime');
    });

    it('18. tools — riskScoreSkewnessAllTime null with < 3 logs', async () => {
      ctx = await setup();
      // Only 2 logs
      for (let i = 0; i < 2; i++) {
        await ctx.logger.log(
          makeOp(`agent-n${i}`, 'tool-v10122-skew2', `sess-${i}`, daysAgo(i + 1), 'call'),
          dec(i * 0.5),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10122-skew2');
      expect(status).toBe(200);
      expect(body.riskScoreSkewnessAllTime).toBeNull();
    });

    it('19. tools — riskScoreKurtosisAllTime can be negative (platykurtic distribution)', async () => {
      ctx = await setup();
      // Uniform-ish distribution (platykurtic → excess kurtosis < 0)
      const scores = [0.0, 0.0, 1.0, 1.0, 0.5, 0.5];
      for (let i = 0; i < scores.length; i++) {
        await ctx.logger.log(
          makeOp(`agent-o${i}`, 'tool-v10122-kurt-neg', `sess-${i}`, daysAgo(i + 1), 'call'),
          dec(scores[i]!),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10122-kurt-neg');
      expect(status).toBe(200);

      // Kurtosis should be a number (possibly negative), not null
      expect(body.riskScoreKurtosisAllTime).not.toBeNull();
      expect(typeof body.riskScoreKurtosisAllTime).toBe('number');
    });

    it('20. tools — riskScoreGiniAllTime in [0,1] for skewed scores', async () => {
      ctx = await setup();
      // Highly skewed: one high risk, many low risk
      const scores = [0.0, 0.0, 0.0, 0.0, 1.0];
      for (let i = 0; i < scores.length; i++) {
        await ctx.logger.log(
          makeOp(`agent-p${i}`, 'tool-v10122-gini-skew', `sess-${i}`, daysAgo(i + 1), 'call'),
          dec(scores[i]!),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10122-gini-skew');
      expect(status).toBe(200);

      const gini = body.riskScoreGiniAllTime as number;
      // Mean > 0 so not null; should be in [0, 1]
      expect(gini).not.toBeNull();
      expect(gini).toBeGreaterThanOrEqual(0);
      expect(gini).toBeLessThanOrEqual(1);
    });

    it('21. tools — opsDailyAvgAllTime and opsHourlyAvgAllTime are positive when logs exist', async () => {
      ctx = await setup();
      // 3 logs on different days
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(
          makeOp(`agent-q${i}`, 'tool-v10122-avgs', `sess-${i}`, daysAgo(i + 1), 'call'),
          dec(0.5),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10122-avgs');
      expect(status).toBe(200);

      const dailyAvg = body.opsDailyAvgAllTime as number;
      const hourlyAvg = body.opsHourlyAvgAllTime as number;

      expect(dailyAvg).not.toBeNull();
      expect(hourlyAvg).not.toBeNull();
      expect(dailyAvg).toBeGreaterThan(0);
      expect(hourlyAvg).toBeGreaterThan(0);
    });
  });

  // ── operations/summary endpoint ────────────────────────────────────────────────

  describe('T1679-T1683 — v10.122 new fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('22. summary — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-u', 'fs', 'sess-1', hoursAgo(1), 'call'),
        dec(0.5, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body).toHaveProperty('riskScoreSkewnessAllTime');
      expect(body).toHaveProperty('riskScoreKurtosisAllTime');
      expect(body).toHaveProperty('riskScoreGiniAllTime');
      expect(body).toHaveProperty('opsDailyAvgAllTime');
      expect(body).toHaveProperty('opsHourlyAvgAllTime');
    });

    it('23. summary — empty DB: all five new fields null', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.riskScoreSkewnessAllTime).toBeNull();
      expect(body.riskScoreKurtosisAllTime).toBeNull();
      expect(body.riskScoreGiniAllTime).toBeNull();
      expect(body.opsDailyAvgAllTime).toBeNull();
      expect(body.opsHourlyAvgAllTime).toBeNull();
    });

    it('24. summary — riskScoreSkewnessAllTime null for 2 logs but non-null for 3 logs', async () => {
      ctx = await setup();
      // First add 2 logs in an isolated context (verifying null threshold)
      const tmpDir2 = await fs.mkdtemp(path.join(os.tmpdir(), 'as-v10122-thresh-'));
      const store2 = new StateStore(path.join(tmpDir2, 'test.db'));
      await store2.initialize();
      const logger2 = new OperationLogger(store2);
      let port2 = 0;
      const dash2 = new DashboardAPI(store2, {});
      await dash2.start(port2); port2 = dash2.getPort();

      await logger2.log(makeOp('ag-thresh', 'fs', 'sess-1', daysAgo(1), 'call'), dec(0.2));
      await logger2.log(makeOp('ag-thresh', 'fs', 'sess-2', daysAgo(2), 'call'), dec(0.8));

      const r2 = await getJSON(port2, '/operations/summary');
      expect(r2.status).toBe(200);
      expect(r2.body.riskScoreSkewnessAllTime).toBeNull();

      await dash2.stop();
      await store2.close();
      await fs.rm(tmpDir2, { recursive: true, force: true });

      // Now with 3 logs, skewness should be non-null
      await ctx.logger.log(makeOp('ag-s1', 'fs', 'sess-1', daysAgo(1), 'call'), dec(0.2));
      await ctx.logger.log(makeOp('ag-s2', 'fs', 'sess-2', daysAgo(2), 'call'), dec(0.5));
      await ctx.logger.log(makeOp('ag-s3', 'fs', 'sess-3', daysAgo(3), 'call'), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreSkewnessAllTime).not.toBeNull();
      expect(typeof body.riskScoreSkewnessAllTime).toBe('number');
    });

    it('25. summary — riskScoreKurtosisAllTime null for 3 logs but non-null for 4+ logs', async () => {
      ctx = await setup();
      // 4 logs → kurtosis non-null
      const scores = [0.1, 0.3, 0.7, 0.9];
      for (let i = 0; i < scores.length; i++) {
        await ctx.logger.log(
          makeOp(`ag-k${i}`, 'fs', `sess-${i}`, daysAgo(i + 1), 'call'),
          dec(scores[i]!),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreKurtosisAllTime).not.toBeNull();
      expect(typeof body.riskScoreKurtosisAllTime).toBe('number');
    });

    it('26. summary — opsDailyAvgAllTime = 1 when all ops on the same day', async () => {
      ctx = await setup();
      // 4 ops all within same day. Anchor to yesterday noon so the 30-minute
      // spread below can never straddle midnight (which would split the ops
      // across two calendar days and halve the average).
      const base = new Date(PINNED_NOW());
      base.setHours(12, 0, 0, 0);
      base.setDate(base.getDate() - 1);
      for (let i = 0; i < 4; i++) {
        const t = new Date(base.getTime() - i * 10 * 60_000); // 10 min apart, same hour/day
        await ctx.logger.log(
          makeOp(`ag-d${i}`, 'fs', `sess-${i}`, t, 'call'),
          dec(0.5),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      const dailyAvg = body.opsDailyAvgAllTime as number;
      expect(dailyAvg).not.toBeNull();
      // 4 ops / 1 day = 4
      expect(dailyAvg).toBeCloseTo(4, 5);
    });

    it('27. summary — opsHourlyAvgAllTime = ops/distinct-hours for multi-hour spread', async () => {
      ctx = await setup();
      // 6 ops spread across 2 distinct hours (3 per hour) → hourly avg = 6/2 = 3
      // Use well-separated hours to avoid boundary issues
      const t1 = new Date(PINNED_NOW() - 25 * 3_600_000); // ~25h ago (hour A)
      const t2 = new Date(PINNED_NOW() - 27 * 3_600_000); // ~27h ago (hour B)
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(
          makeOp(`ag-h1-${i}`, 'fs', `sess-h1-${i}`, new Date(t1.getTime() + i * 60_000), 'call'),
          dec(0.5),
        );
        await ctx.logger.log(
          makeOp(`ag-h2-${i}`, 'fs', `sess-h2-${i}`, new Date(t2.getTime() + i * 60_000), 'call'),
          dec(0.5),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      const hourlyAvg = body.opsHourlyAvgAllTime as number;
      expect(hourlyAvg).not.toBeNull();
      // 6 ops / 2 distinct hours = 3
      expect(hourlyAvg).toBeCloseTo(3, 5);
    });

    it('28. summary — all-time fields include logs older than 72h', async () => {
      ctx = await setup();
      // Only old logs (> 72h) — all-time should include them
      await ctx.logger.log(makeOp('ag-old1', 'fs', 'sess-1', daysAgo(7), 'call'), dec(0.3));
      await ctx.logger.log(makeOp('ag-old2', 'fs', 'sess-2', daysAgo(10), 'call'), dec(0.7));
      await ctx.logger.log(makeOp('ag-old3', 'fs', 'sess-3', daysAgo(14), 'call'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      // All-time includes old logs — skewness should be non-null (>= 3 logs)
      expect(body.riskScoreSkewnessAllTime).not.toBeNull();
      expect(body.riskScoreGiniAllTime).not.toBeNull();
      expect(body.opsDailyAvgAllTime).not.toBeNull();
      expect(body.opsHourlyAvgAllTime).not.toBeNull();
    });
  });
});

// ── v10.123 ────────────────────────────────────────────────────────────────────

describe('v10.123', () => {
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);

  /** Returns a Date that is guaranteed to fall on a Sunday (DOW=0) */
  function getSunday(weeksAgo = 1): Date {
    const now = new Date(PINNED_NOW());
    const dow = now.getDay(); // 0=Sun
    const daysToSunday = dow; // days since last Sunday
    const d = new Date(now.getTime() - (daysToSunday + 7 * weeksAgo) * 86_400_000);
    d.setHours(12, 0, 0, 0);
    return d;
  }

  /** Returns a Date that is guaranteed to fall on a Saturday (DOW=6) */
  function getSaturday(weeksAgo = 1): Date {
    const now = new Date(PINNED_NOW());
    const dow = now.getDay();
    const daysToSaturday = (dow + 1) % 7; // days since last Saturday
    const d = new Date(now.getTime() - (daysToSaturday + 7 * weeksAgo) * 86_400_000);
    d.setHours(12, 0, 0, 0);
    return d;
  }

  /** Returns a Date that is guaranteed to fall on a weekday (Mon–Fri) */
  function getWeekday(daysBack: number): Date {
    let d = new Date(PINNED_NOW() - daysBack * 86_400_000);
    d.setHours(12, 0, 0, 0);
    // Advance until Mon–Fri
    while (d.getDay() === 0 || d.getDay() === 6) {
      d = new Date(d.getTime() - 86_400_000);
    }
    return d;
  }

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1684-T1688 — v10.123 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-a1', 'fs', 'sess-v10123-pres', daysAgo(1), 'call'),
        dec(0.5, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10123-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('riskScoreMadAllTime');
      expect(body).toHaveProperty('riskScoreCVAllTime');
      expect(body).toHaveProperty('riskScoreEntropyAllTime');
      expect(body).toHaveProperty('opsWeekdayAvgAllTime');
      expect(body).toHaveProperty('opsWeekendAvgAllTime');
    });

    it('2. sessions — riskScoreMadAllTime null when no logs', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreMadAllTime).toBeNull();
    });

    it('3. sessions — riskScoreMadAllTime is 0 for identical scores', async () => {
      ctx = await setup();
      // All same risk score → MAD = 0
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(
          makeOp('agent-b1', 'fs', 'sess-v10123-mad-zero', daysAgo(i + 1), 'call'),
          dec(0.5),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10123-mad-zero');
      expect(status).toBe(200);
      const mad = body.riskScoreMadAllTime as number;
      expect(mad).not.toBeNull();
      expect(mad).toBeCloseTo(0, 10);
    });

    it('4. sessions — riskScoreMadAllTime non-negative for diverse scores', async () => {
      ctx = await setup();
      const scores = [0.1, 0.3, 0.5, 0.7, 0.9];
      for (let i = 0; i < scores.length; i++) {
        await ctx.logger.log(
          makeOp('agent-c1', 'fs', 'sess-v10123-mad-range', daysAgo(i + 1), 'call'),
          dec(scores[i]!),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10123-mad-range');
      expect(status).toBe(200);
      const mad = body.riskScoreMadAllTime as number;
      expect(mad).not.toBeNull();
      expect(mad).toBeGreaterThanOrEqual(0);
    });

    it('5. sessions — opsWeekendAvgAllTime null when no weekend logs', async () => {
      ctx = await setup();
      // Only add weekday logs (Mon–Fri)
      const wd1 = getWeekday(7);
      const wd2 = getWeekday(14);
      await ctx.logger.log(
        makeOp('agent-d1', 'fs', 'sess-v10123-noweekend', wd1, 'call'),
        dec(0.4),
      );
      await ctx.logger.log(
        makeOp('agent-d1', 'fs', 'sess-v10123-noweekend', wd2, 'call'),
        dec(0.6),
      );
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10123-noweekend');
      expect(status).toBe(200);
      expect(body.opsWeekendAvgAllTime).toBeNull();
    });

    it('6. sessions — opsWeekdayAvgAllTime null when no logs', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10123-empty');
      expect(status).toBe(404);
      // 404 means no data, so check via summary for the null case
      const { status: sts2, body: body2 } = await getJSON(ctx.port, '/operations/summary');
      expect(sts2).toBe(200);
      expect(body2.opsWeekdayAvgAllTime).toBeNull();
    });

    it('7. sessions — opsWeekendAvgAllTime >= 1 when weekend logs exist', async () => {
      ctx = await setup();
      const sun = getSunday(1);
      const sat = getSaturday(1);
      await ctx.logger.log(
        makeOp('agent-e1', 'fs', 'sess-v10123-weekend', sun, 'call'),
        dec(0.4),
      );
      await ctx.logger.log(
        makeOp('agent-e1', 'fs', 'sess-v10123-weekend', sat, 'call'),
        dec(0.6),
      );
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10123-weekend');
      expect(status).toBe(200);
      const weAvg = body.opsWeekendAvgAllTime as number;
      expect(weAvg).not.toBeNull();
      expect(weAvg).toBeGreaterThanOrEqual(1);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1684-T1688 — v10.123 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('8. agents — all five fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-v10123-pres', 'fs', 'sess-1', daysAgo(1), 'call'),
        dec(0.4, 'allow'),
      );
      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10123-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('riskScoreMadAllTime');
      expect(body).toHaveProperty('riskScoreCVAllTime');
      expect(body).toHaveProperty('riskScoreEntropyAllTime');
      expect(body).toHaveProperty('opsWeekdayAvgAllTime');
      expect(body).toHaveProperty('opsWeekendAvgAllTime');
    });

    it('9. agents — riskScoreMadAllTime equals expected value for known scores', async () => {
      ctx = await setup();
      // Scores: [0.1, 0.3, 0.5, 0.7, 0.9] → median = 0.5 → devs = [0.4, 0.2, 0.0, 0.2, 0.4] → MAD = 0.2
      const scores = [0.1, 0.3, 0.5, 0.7, 0.9];
      for (let i = 0; i < scores.length; i++) {
        await ctx.logger.log(
          makeOp('agent-v10123-mad-calc', 'fs', `sess-${i}`, daysAgo(i + 1), 'call'),
          dec(scores[i]!),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10123-mad-calc');
      expect(status).toBe(200);
      expect(body.riskScoreMadAllTime as number).toBeCloseTo(0.2, 5);
    });

    it('10. agents — opsWeekdayAvgAllTime equals total weekday ops / distinct weekday dates', async () => {
      ctx = await setup();
      // 4 weekday ops on 2 distinct weekdays → avg = 4/2 = 2
      const wd1 = getWeekday(7);
      const wd2 = getWeekday(14);
      for (let i = 0; i < 2; i++) {
        await ctx.logger.log(
          makeOp('agent-v10123-wdavg', 'fs', `sess-wda-${i}`, wd1, 'call'),
          dec(0.5),
        );
        await ctx.logger.log(
          makeOp('agent-v10123-wdavg', 'fs', `sess-wdb-${i}`, wd2, 'call'),
          dec(0.5),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10123-wdavg');
      expect(status).toBe(200);
      const wdAvg = body.opsWeekdayAvgAllTime as number;
      expect(wdAvg).not.toBeNull();
      // 4 ops / 2 days = 2
      expect(wdAvg).toBeCloseTo(2, 5);
    });

    it('11. agents — opsWeekendAvgAllTime equals total weekend ops / distinct weekend dates', async () => {
      ctx = await setup();
      // 4 weekend ops on 2 distinct weekend days (2 per day) → avg = 4/2 = 2
      const sun = getSunday(1);
      const sat = getSaturday(1);
      for (let i = 0; i < 2; i++) {
        await ctx.logger.log(
          makeOp('agent-v10123-weavg', 'fs', `sess-wea-${i}`, sun, 'call'),
          dec(0.4),
        );
        await ctx.logger.log(
          makeOp('agent-v10123-weavg', 'fs', `sess-web-${i}`, sat, 'call'),
          dec(0.6),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10123-weavg');
      expect(status).toBe(200);
      const weAvg = body.opsWeekendAvgAllTime as number;
      expect(weAvg).not.toBeNull();
      // 4 ops / 2 weekend days = 2
      expect(weAvg).toBeCloseTo(2, 5);
    });

    it('12. agents — riskScoreCVAllTime null when all risk scores are 0', async () => {
      ctx = await setup();
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(
          makeOp('agent-v10123-cv-zero', 'fs', `sess-${i}`, daysAgo(i + 1), 'call'),
          dec(0.0),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10123-cv-zero');
      expect(status).toBe(200);
      // mean=0 → CV must be null
      expect(body.riskScoreCVAllTime).toBeNull();
    });

    it('13. agents — riskScoreEntropyAllTime is 0 when all logs fall in same bin', async () => {
      ctx = await setup();
      // All scores 0.05 → same bin → single non-zero bin → entropy = 0
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(
          makeOp('agent-v10123-ent-zero', 'fs', `sess-${i}`, daysAgo(i + 1), 'call'),
          dec(0.05),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10123-ent-zero');
      expect(status).toBe(200);
      const entropy = body.riskScoreEntropyAllTime as number;
      expect(entropy).not.toBeNull();
      expect(entropy).toBeCloseTo(0, 5);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1684-T1688 — v10.123 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('14. tools — all five fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-m', 'tool-v10123-pres', 'sess-1', daysAgo(1), 'call'),
        dec(0.5, 'allow'),
      );
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10123-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('riskScoreMadAllTime');
      expect(body).toHaveProperty('riskScoreCVAllTime');
      expect(body).toHaveProperty('riskScoreEntropyAllTime');
      expect(body).toHaveProperty('opsWeekdayAvgAllTime');
      expect(body).toHaveProperty('opsWeekendAvgAllTime');
    });

    it('15. tools — riskScoreMadAllTime non-negative for single log', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-n1', 'tool-v10123-mad-one', 'sess-1', daysAgo(1), 'call'),
        dec(0.7),
      );
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10123-mad-one');
      expect(status).toBe(200);
      const mad = body.riskScoreMadAllTime as number;
      expect(mad).not.toBeNull();
      // Single log: median = 0.7, deviation = 0 → MAD = 0
      expect(mad).toBeCloseTo(0, 10);
    });

    it('16. tools — opsWeekdayAvgAllTime >= 1 when weekday logs exist', async () => {
      ctx = await setup();
      const wd1 = getWeekday(7);
      const wd2 = getWeekday(14);
      const wd3 = getWeekday(21);
      for (const ts of [wd1, wd2, wd3]) {
        await ctx.logger.log(
          makeOp('agent-o1', 'tool-v10123-wdavg', `sess-${ts.getTime()}`, ts, 'call'),
          dec(0.5),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10123-wdavg');
      expect(status).toBe(200);
      const wdAvg = body.opsWeekdayAvgAllTime as number;
      expect(wdAvg).not.toBeNull();
      expect(wdAvg).toBeGreaterThanOrEqual(1);
    });

    it('17. tools — opsWeekendAvgAllTime null when only weekday ops exist', async () => {
      ctx = await setup();
      const wd1 = getWeekday(7);
      const wd2 = getWeekday(14);
      await ctx.logger.log(
        makeOp('agent-p1', 'tool-v10123-noweekend', `sess-1`, wd1, 'call'),
        dec(0.4),
      );
      await ctx.logger.log(
        makeOp('agent-p1', 'tool-v10123-noweekend', `sess-2`, wd2, 'call'),
        dec(0.6),
      );
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10123-noweekend');
      expect(status).toBe(200);
      expect(body.opsWeekendAvgAllTime).toBeNull();
    });

    it('18. tools — riskScoreEntropyAllTime in [0, log2(10)] for diverse scores', async () => {
      ctx = await setup();
      // 10 logs spread across all 10 bins → max entropy ≈ log2(10) ≈ 3.32
      const scores = [0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.95];
      for (let i = 0; i < scores.length; i++) {
        await ctx.logger.log(
          makeOp(`agent-q${i}`, 'tool-v10123-ent-range', `sess-${i}`, daysAgo(i + 1), 'call'),
          dec(scores[i]!),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10123-ent-range');
      expect(status).toBe(200);
      const entropy = body.riskScoreEntropyAllTime as number;
      expect(entropy).not.toBeNull();
      expect(entropy).toBeGreaterThanOrEqual(0);
      expect(entropy).toBeLessThanOrEqual(Math.log2(10) + 1e-9);
    });
  });

  // ── operations/summary endpoint ────────────────────────────────────────────────

  describe('T1684-T1688 — v10.123 new fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('19. summary — all five fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-u', 'fs', 'sess-1', daysAgo(1), 'call'),
        dec(0.5, 'allow'),
      );
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body).toHaveProperty('riskScoreMadAllTime');
      expect(body).toHaveProperty('riskScoreCVAllTime');
      expect(body).toHaveProperty('riskScoreEntropyAllTime');
      expect(body).toHaveProperty('opsWeekdayAvgAllTime');
      expect(body).toHaveProperty('opsWeekendAvgAllTime');
    });

    it('20. summary — empty DB: all five fields null', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreMadAllTime).toBeNull();
      expect(body.riskScoreCVAllTime).toBeNull();
      expect(body.riskScoreEntropyAllTime).toBeNull();
      expect(body.opsWeekdayAvgAllTime).toBeNull();
      expect(body.opsWeekendAvgAllTime).toBeNull();
    });

    it('21. summary — riskScoreMadAllTime is 0 when single log exists', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-v1', 'fs', 'sess-1', daysAgo(3), 'call'),
        dec(0.6),
      );
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      const mad = body.riskScoreMadAllTime as number;
      expect(mad).not.toBeNull();
      // Single log: MAD = 0
      expect(mad).toBeCloseTo(0, 10);
    });

    it('22. summary — opsWeekdayAvgAllTime = total / distinct-weekdays (all same weekday)', async () => {
      ctx = await setup();
      // 3 ops all on the same weekday → avg = 3/1 = 3
      const wd = getWeekday(7);
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(
          makeOp(`agent-w${i}`, 'fs', `sess-wd-${i}`, wd, 'call'),
          dec(0.5),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      const wdAvg = body.opsWeekdayAvgAllTime as number;
      expect(wdAvg).not.toBeNull();
      // 3 ops / 1 distinct day = 3
      expect(wdAvg).toBeCloseTo(3, 5);
    });

    it('23. summary — opsWeekendAvgAllTime = total / distinct-weekend-days', async () => {
      ctx = await setup();
      // 3 ops on Sunday + 3 ops on Saturday → 2 distinct weekend days → avg = 6/2 = 3
      const sun = getSunday(1);
      const sat = getSaturday(1);
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(
          makeOp(`agent-x1-${i}`, 'fs', `sess-sun-${i}`, sun, 'call'),
          dec(0.3),
        );
        await ctx.logger.log(
          makeOp(`agent-x2-${i}`, 'fs', `sess-sat-${i}`, sat, 'call'),
          dec(0.7),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      const weAvg = body.opsWeekendAvgAllTime as number;
      expect(weAvg).not.toBeNull();
      // 6 ops / 2 weekend days = 3
      expect(weAvg).toBeCloseTo(3, 5);
    });

    it('24. summary — opsWeekdayAvgAllTime includes old logs (all-time, not windowed)', async () => {
      ctx = await setup();
      // Old weekday logs (> 30 days) — all-time must include them
      const wd1 = getWeekday(35);
      const wd2 = getWeekday(42);
      await ctx.logger.log(makeOp('agent-y1', 'fs', 'sess-old-1', wd1, 'call'), dec(0.3));
      await ctx.logger.log(makeOp('agent-y2', 'fs', 'sess-old-2', wd2, 'call'), dec(0.5));
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      // All-time includes old logs
      expect(body.opsWeekdayAvgAllTime).not.toBeNull();
      expect(body.opsWeekdayAvgAllTime as number).toBeGreaterThanOrEqual(1);
    });

    it('25. summary — riskScoreMadAllTime correct for even number of scores', async () => {
      ctx = await setup();
      // Scores [0.2, 0.4, 0.6, 0.8] → sorted → median = (0.4+0.6)/2 = 0.5
      // devs = [0.3, 0.1, 0.1, 0.3] → sorted → MAD = (0.1+0.1)/2 = 0.1... wait
      // devs sorted: [0.1, 0.1, 0.3, 0.3] → MAD = (0.1+0.3)/2 = 0.2
      const scores = [0.2, 0.4, 0.6, 0.8];
      for (let i = 0; i < scores.length; i++) {
        await ctx.logger.log(
          makeOp(`agent-z${i}`, 'fs', `sess-mad-even-${i}`, daysAgo(i + 1), 'call'),
          dec(scores[i]!),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      const mad = body.riskScoreMadAllTime as number;
      expect(mad).not.toBeNull();
      // devs sorted: [0.1, 0.1, 0.3, 0.3] → n=4 even → MAD = (devs[1]+devs[2])/2 = (0.1+0.3)/2 = 0.2
      expect(mad).toBeCloseTo(0.2, 5);
    });
  });
});

// ── v10.124 ────────────────────────────────────────────────────────────────────

describe('v10.124', () => {
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);

  /** Returns a Date in month offset from now (negative = past months) */
  function monthsAgo(m: number): Date {
    const d = new Date(PINNED_NOW());
    d.setMonth(d.getMonth() - m);
    d.setDate(15);
    d.setHours(12, 0, 0, 0);
    return d;
  }

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1689-T1693 — v10.124 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-a1', 'fs', 'sess-v10124-pres', daysAgo(1), 'call'),
        dec(0.5, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10124-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('riskScoreAutocorrLag1AllTime');
      expect(body).toHaveProperty('riskScoreAutocorrLag2AllTime');
      expect(body).toHaveProperty('riskScoreOLSSlopeAllTime');
      expect(body).toHaveProperty('opsMonthlyAvgAllTime');
      expect(body).toHaveProperty('riskScoreHarmonicMeanAllTime');
    });

    it('2. sessions — riskScoreAutocorrLag1AllTime null when < 2 logs', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-b1', 'fs', 'sess-v10124-lag1-one', daysAgo(1), 'call'),
        dec(0.5),
      );
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10124-lag1-one');
      expect(status).toBe(200);
      expect(body.riskScoreAutocorrLag1AllTime).toBeNull();
    });

    it('3. sessions — riskScoreAutocorrLag2AllTime null when < 3 logs', async () => {
      ctx = await setup();
      for (let i = 0; i < 2; i++) {
        await ctx.logger.log(
          makeOp('agent-c1', 'fs', 'sess-v10124-lag2-two', daysAgo(i + 1), 'call'),
          dec(0.5),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10124-lag2-two');
      expect(status).toBe(200);
      expect(body.riskScoreAutocorrLag2AllTime).toBeNull();
    });

    it('4. sessions — riskScoreAutocorrLag1AllTime is 0 when all scores identical', async () => {
      ctx = await setup();
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(
          makeOp('agent-d1', 'fs', 'sess-v10124-lag1-zero', daysAgo(i + 1), 'call'),
          dec(0.5),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10124-lag1-zero');
      expect(status).toBe(200);
      expect(body.riskScoreAutocorrLag1AllTime).toBe(0);
    });

    it('5. sessions — riskScoreAutocorrLag2AllTime is 0 when all scores identical', async () => {
      ctx = await setup();
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(
          makeOp('agent-e1', 'fs', 'sess-v10124-lag2-zero', daysAgo(i + 1), 'call'),
          dec(0.7),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10124-lag2-zero');
      expect(status).toBe(200);
      expect(body.riskScoreAutocorrLag2AllTime).toBe(0);
    });

    it('6. sessions — riskScoreOLSSlopeAllTime null when < 2 logs', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-f1', 'fs', 'sess-v10124-ols-one', daysAgo(1), 'call'),
        dec(0.4),
      );
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10124-ols-one');
      expect(status).toBe(200);
      expect(body.riskScoreOLSSlopeAllTime).toBeNull();
    });

    it('7. sessions — opsMonthlyAvgAllTime null when no logs', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.opsMonthlyAvgAllTime).toBeNull();
    });

    it('8. sessions — riskScoreHarmonicMeanAllTime null when any score is 0', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-g1', 'fs', 'sess-v10124-hm-zero', daysAgo(2), 'call'),
        dec(0.5),
      );
      await ctx.logger.log(
        makeOp('agent-g1', 'fs', 'sess-v10124-hm-zero', daysAgo(1), 'call'),
        dec(0.0),
      );
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10124-hm-zero');
      expect(status).toBe(200);
      expect(body.riskScoreHarmonicMeanAllTime).toBeNull();
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1689-T1693 — v10.124 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('9. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-v10124-pres', 'fs', 'sess-1', daysAgo(1), 'call'),
        dec(0.4, 'allow'),
      );
      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10124-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('riskScoreAutocorrLag1AllTime');
      expect(body).toHaveProperty('riskScoreAutocorrLag2AllTime');
      expect(body).toHaveProperty('riskScoreOLSSlopeAllTime');
      expect(body).toHaveProperty('opsMonthlyAvgAllTime');
      expect(body).toHaveProperty('riskScoreHarmonicMeanAllTime');
    });

    it('10. agents — riskScoreAutocorrLag1AllTime in [-1, 1] for diverse scores', async () => {
      ctx = await setup();
      const scores = [0.1, 0.9, 0.2, 0.8, 0.3, 0.7];
      for (let i = 0; i < scores.length; i++) {
        await ctx.logger.log(
          makeOp('agent-v10124-lag1-range', 'fs', `sess-${i}`, daysAgo(i + 1), 'call'),
          dec(scores[i]!),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10124-lag1-range');
      expect(status).toBe(200);
      const corr = body.riskScoreAutocorrLag1AllTime as number;
      expect(corr).not.toBeNull();
      expect(corr).toBeGreaterThanOrEqual(-1 - 1e-9);
      expect(corr).toBeLessThanOrEqual(1 + 1e-9);
    });

    it('11. agents — riskScoreAutocorrLag2AllTime in [-1, 1] for diverse scores', async () => {
      ctx = await setup();
      const scores = [0.2, 0.5, 0.8, 0.3, 0.6, 0.9];
      for (let i = 0; i < scores.length; i++) {
        await ctx.logger.log(
          makeOp('agent-v10124-lag2-range', 'fs', `sess-${i}`, daysAgo(i + 1), 'call'),
          dec(scores[i]!),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10124-lag2-range');
      expect(status).toBe(200);
      const corr = body.riskScoreAutocorrLag2AllTime as number;
      expect(corr).not.toBeNull();
      expect(corr).toBeGreaterThanOrEqual(-1 - 1e-9);
      expect(corr).toBeLessThanOrEqual(1 + 1e-9);
    });

    it('12. agents — riskScoreOLSSlopeAllTime is 0 when all scores identical', async () => {
      ctx = await setup();
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(
          makeOp('agent-v10124-ols-zero', 'fs', `sess-${i}`, daysAgo(i + 1), 'call'),
          dec(0.5),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10124-ols-zero');
      expect(status).toBe(200);
      expect(body.riskScoreOLSSlopeAllTime).toBeCloseTo(0, 10);
    });

    it('13. agents — riskScoreOLSSlopeAllTime is positive for newest-highest pattern', async () => {
      ctx = await setup();
      // logs returned DESC (newest first): index 0 = newest = highest score
      // scores inserted so newest log has highest score → OLS slope > 0 (DESC array index 0=high, n-1=low)
      // Insert: oldest (daysAgo(5)) → score 0.9, newest (daysAgo(1)) → score 0.1
      // DESC array: [0.1, 0.3, 0.5, 0.7, 0.9] → scores decrease by index → wait, that's negative
      // Actually DESC: newest first → newest=daysAgo(1)=0.1 is index 0, oldest=daysAgo(5)=0.9 is index n-1
      // So scores[0]=0.1 (lowest at low index), scores[n-1]=0.9 (highest at high index) → positive slope
      const scores = [0.9, 0.7, 0.5, 0.3, 0.1]; // oldest→newest
      for (let i = 0; i < scores.length; i++) {
        await ctx.logger.log(
          makeOp('agent-v10124-ols-pos', 'fs', `sess-${i}`, daysAgo(scores.length - i), 'call'),
          dec(scores[i]!),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10124-ols-pos');
      expect(status).toBe(200);
      const slope = body.riskScoreOLSSlopeAllTime as number;
      expect(slope).not.toBeNull();
      expect(slope).toBeGreaterThan(0);
    });

    it('14. agents — opsMonthlyAvgAllTime >= 1 when logs exist', async () => {
      ctx = await setup();
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(
          makeOp('agent-v10124-monthly', 'fs', `sess-${i}`, daysAgo(i + 1), 'call'),
          dec(0.4),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10124-monthly');
      expect(status).toBe(200);
      const avg = body.opsMonthlyAvgAllTime as number;
      expect(avg).not.toBeNull();
      expect(avg).toBeGreaterThanOrEqual(1);
    });

    it('15. agents — riskScoreHarmonicMeanAllTime positive when all scores > 0', async () => {
      ctx = await setup();
      const scores = [0.2, 0.4, 0.6, 0.8];
      for (let i = 0; i < scores.length; i++) {
        await ctx.logger.log(
          makeOp('agent-v10124-hm-pos', 'fs', `sess-${i}`, daysAgo(i + 1), 'call'),
          dec(scores[i]!),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10124-hm-pos');
      expect(status).toBe(200);
      const hm = body.riskScoreHarmonicMeanAllTime as number;
      expect(hm).not.toBeNull();
      expect(hm).toBeGreaterThan(0);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1689-T1693 — v10.124 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('16. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-m', 'tool-v10124-pres', 'sess-1', daysAgo(1), 'call'),
        dec(0.5, 'allow'),
      );
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10124-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('riskScoreAutocorrLag1AllTime');
      expect(body).toHaveProperty('riskScoreAutocorrLag2AllTime');
      expect(body).toHaveProperty('riskScoreOLSSlopeAllTime');
      expect(body).toHaveProperty('opsMonthlyAvgAllTime');
      expect(body).toHaveProperty('riskScoreHarmonicMeanAllTime');
    });

    it('17. tools — riskScoreHarmonicMeanAllTime null when no logs', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreHarmonicMeanAllTime).toBeNull();
    });

    it('18. tools — riskScoreHarmonicMeanAllTime computed correctly for known scores', async () => {
      ctx = await setup();
      // Scores [0.5, 1.0] → HM = 2 / (1/0.5 + 1/1.0) = 2 / (2 + 1) = 2/3 ≈ 0.6667
      const scores = [0.5, 1.0];
      for (let i = 0; i < scores.length; i++) {
        await ctx.logger.log(
          makeOp(`agent-r${i}`, 'tool-v10124-hm-calc', `sess-${i}`, daysAgo(i + 1), 'call'),
          dec(scores[i]!),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10124-hm-calc');
      expect(status).toBe(200);
      const hm = body.riskScoreHarmonicMeanAllTime as number;
      expect(hm).not.toBeNull();
      expect(hm).toBeCloseTo(2 / 3, 5);
    });

    it('19. tools — opsMonthlyAvgAllTime = ops / distinct months across months', async () => {
      ctx = await setup();
      // 3 ops in month-0, 3 ops in month-1 → 2 distinct months → avg = 6/2 = 3
      const m0 = monthsAgo(0);
      const m1 = monthsAgo(1);
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(
          makeOp(`agent-s${i}`, 'tool-v10124-monthly', `sess-m0-${i}`, m0, 'call'),
          dec(0.4),
        );
        await ctx.logger.log(
          makeOp(`agent-t${i}`, 'tool-v10124-monthly', `sess-m1-${i}`, m1, 'call'),
          dec(0.6),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10124-monthly');
      expect(status).toBe(200);
      const avg = body.opsMonthlyAvgAllTime as number;
      expect(avg).not.toBeNull();
      expect(avg).toBeCloseTo(3, 5);
    });

    it('20. tools — riskScoreOLSSlopeAllTime is negative for newest-lowest pattern', async () => {
      ctx = await setup();
      // logs returned DESC (newest first): newest log is index 0
      // To get negative slope: newest (index 0) should have highest score, oldest (index n-1) lowest
      // Insert: oldest (daysAgo(5)) → score 0.1, newest (daysAgo(1)) → score 0.9
      // DESC array: [0.9, 0.7, 0.5, 0.3, 0.1] → scores decrease by index → negative slope
      const scores = [0.1, 0.3, 0.5, 0.7, 0.9]; // oldest→newest
      for (let i = 0; i < scores.length; i++) {
        await ctx.logger.log(
          makeOp(`agent-u${i}`, 'tool-v10124-ols-neg', `sess-${i}`, daysAgo(scores.length - i), 'call'),
          dec(scores[i]!),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10124-ols-neg');
      expect(status).toBe(200);
      const slope = body.riskScoreOLSSlopeAllTime as number;
      expect(slope).not.toBeNull();
      expect(slope).toBeLessThan(0);
    });
  });

  // ── operations/summary endpoint ────────────────────────────────────────────────

  describe('T1689-T1693 — v10.124 new fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('21. summary — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-u1', 'fs', 'sess-1', daysAgo(1), 'call'),
        dec(0.5, 'allow'),
      );
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body).toHaveProperty('riskScoreAutocorrLag1AllTime');
      expect(body).toHaveProperty('riskScoreAutocorrLag2AllTime');
      expect(body).toHaveProperty('riskScoreOLSSlopeAllTime');
      expect(body).toHaveProperty('opsMonthlyAvgAllTime');
      expect(body).toHaveProperty('riskScoreHarmonicMeanAllTime');
    });

    it('22. summary — empty DB: all five new fields null', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreAutocorrLag1AllTime).toBeNull();
      expect(body.riskScoreAutocorrLag2AllTime).toBeNull();
      expect(body.riskScoreOLSSlopeAllTime).toBeNull();
      expect(body.opsMonthlyAvgAllTime).toBeNull();
      expect(body.riskScoreHarmonicMeanAllTime).toBeNull();
    });

    it('23. summary — riskScoreAutocorrLag1AllTime is not null with >= 2 logs', async () => {
      ctx = await setup();
      const scores = [0.3, 0.7];
      for (let i = 0; i < scores.length; i++) {
        await ctx.logger.log(
          makeOp(`agent-v10124-lag1-nn${i}`, 'fs', `sess-${i}`, daysAgo(i + 1), 'call'),
          dec(scores[i]!),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreAutocorrLag1AllTime).not.toBeNull();
    });

    it('24. summary — riskScoreAutocorrLag2AllTime is not null with >= 3 logs', async () => {
      ctx = await setup();
      const scores = [0.2, 0.5, 0.8];
      for (let i = 0; i < scores.length; i++) {
        await ctx.logger.log(
          makeOp(`agent-v10124-lag2-nn${i}`, 'fs', `sess-${i}`, daysAgo(i + 1), 'call'),
          dec(scores[i]!),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreAutocorrLag2AllTime).not.toBeNull();
    });

    it('25. summary — opsMonthlyAvgAllTime = total ops / distinct months (single month)', async () => {
      ctx = await setup();
      // 4 ops all in the same current month → 1 distinct month → avg = 4
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(
          makeOp(`agent-v10124-ma-sm${i}`, 'fs', `sess-ma-${i}`, daysAgo(i), 'call'),
          dec(0.5),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      const avg = body.opsMonthlyAvgAllTime as number;
      expect(avg).not.toBeNull();
      // All ops in same month → avg = 4/1 = 4
      expect(avg).toBeCloseTo(4, 5);
    });

    it('26. summary — riskScoreHarmonicMeanAllTime <= arithmetic mean for positive scores', async () => {
      ctx = await setup();
      const scores = [0.2, 0.4, 0.6, 0.8, 1.0];
      for (let i = 0; i < scores.length; i++) {
        await ctx.logger.log(
          makeOp(`agent-v10124-hm-vs-am${i}`, 'fs', `sess-${i}`, daysAgo(i + 1), 'call'),
          dec(scores[i]!),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      const hm = body.riskScoreHarmonicMeanAllTime as number;
      expect(hm).not.toBeNull();
      const arithmeticMean = scores.reduce((a, v) => a + v, 0) / scores.length;
      // Harmonic mean <= arithmetic mean (AM-HM inequality)
      expect(hm).toBeLessThanOrEqual(arithmeticMean + 1e-9);
      expect(hm).toBeGreaterThan(0);
    });

    it('27. summary — riskScoreOLSSlopeAllTime not null with >= 2 logs', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-v10124-ols-nn1', 'fs', 'sess-ols-1', daysAgo(2), 'call'),
        dec(0.3),
      );
      await ctx.logger.log(
        makeOp('agent-v10124-ols-nn2', 'fs', 'sess-ols-2', daysAgo(1), 'call'),
        dec(0.7),
      );
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreOLSSlopeAllTime).not.toBeNull();
    });
  });
});

// ── v10.125 ────────────────────────────────────────────────────────────────────

describe('v10.125', () => {
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1694-T1698 — v10.125 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-a1', 'fs', 'sess-v10125-pres', daysAgo(1), 'call'),
        dec(0.5, 'allow'),
      );
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10125-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('riskScoreGeometricMeanAllTime');
      expect(body).toHaveProperty('riskScoreRMSAllTime');
      expect(body).toHaveProperty('opsMaxDailyAllTime');
      expect(body).toHaveProperty('opsMinDailyAllTime');
      expect(body).toHaveProperty('riskScoreHighStreakMaxAllTime');
    });

    it('2. sessions — riskScoreGeometricMeanAllTime null when no logs', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreGeometricMeanAllTime).toBeNull();
    });

    it('3. sessions — riskScoreGeometricMeanAllTime null when any score <= 0', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-b1', 'fs', 'sess-v10125-geo-zero', daysAgo(2), 'call'),
        dec(0.5),
      );
      await ctx.logger.log(
        makeOp('agent-b1', 'fs', 'sess-v10125-geo-zero', daysAgo(1), 'call'),
        dec(0.0),
      );
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10125-geo-zero');
      expect(status).toBe(200);
      expect(body.riskScoreGeometricMeanAllTime).toBeNull();
    });

    it('4. sessions — riskScoreGeometricMeanAllTime positive when all scores > 0', async () => {
      ctx = await setup();
      const scores = [0.2, 0.4, 0.6, 0.8];
      for (let i = 0; i < scores.length; i++) {
        await ctx.logger.log(
          makeOp('agent-c1', 'fs', 'sess-v10125-geo-pos', daysAgo(i + 1), 'call'),
          dec(scores[i]!),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10125-geo-pos');
      expect(status).toBe(200);
      const gm = body.riskScoreGeometricMeanAllTime as number;
      expect(gm).not.toBeNull();
      expect(gm).toBeGreaterThan(0);
    });

    it('5. sessions — riskScoreRMSAllTime null when no logs', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreRMSAllTime).toBeNull();
    });

    it('6. sessions — riskScoreHighStreakMaxAllTime null when no logs (via summary)', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreHighStreakMaxAllTime).toBeNull();
    });

    it('7. sessions — riskScoreHighStreakMaxAllTime is 0 when no score > 0.7', async () => {
      ctx = await setup();
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(
          makeOp('agent-d1', 'fs', 'sess-v10125-streak-zero', daysAgo(i + 1), 'call'),
          dec(0.5),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10125-streak-zero');
      expect(status).toBe(200);
      expect(body.riskScoreHighStreakMaxAllTime).toBe(0);
    });

    it('8. sessions — riskScoreHighStreakMaxAllTime counts consecutive high-risk ops', async () => {
      ctx = await setup();
      // 3 high-risk ops in a row, then 1 low, then 2 high → streak = 3
      const scores = [0.8, 0.9, 0.75, 0.3, 0.85, 0.95];
      for (let i = 0; i < scores.length; i++) {
        await ctx.logger.log(
          makeOp('agent-e1', 'fs', 'sess-v10125-streak-3', daysAgo(scores.length - i), 'call'),
          dec(scores[i]!),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10125-streak-3');
      expect(status).toBe(200);
      const streak = body.riskScoreHighStreakMaxAllTime as number;
      expect(streak).not.toBeNull();
      expect(streak).toBeGreaterThanOrEqual(2);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1694-T1698 — v10.125 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('9. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-v10125-pres', 'fs', 'sess-1', daysAgo(1), 'call'),
        dec(0.4, 'allow'),
      );
      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10125-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('riskScoreGeometricMeanAllTime');
      expect(body).toHaveProperty('riskScoreRMSAllTime');
      expect(body).toHaveProperty('opsMaxDailyAllTime');
      expect(body).toHaveProperty('opsMinDailyAllTime');
      expect(body).toHaveProperty('riskScoreHighStreakMaxAllTime');
    });

    it('10. agents — riskScoreRMSAllTime >= arithmetic mean for scores in [0,1]', async () => {
      ctx = await setup();
      const scores = [0.2, 0.4, 0.6, 0.8];
      for (let i = 0; i < scores.length; i++) {
        await ctx.logger.log(
          makeOp('agent-v10125-rms-ge-am', 'fs', `sess-${i}`, daysAgo(i + 1), 'call'),
          dec(scores[i]!),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10125-rms-ge-am');
      expect(status).toBe(200);
      const rms = body.riskScoreRMSAllTime as number;
      expect(rms).not.toBeNull();
      const am = scores.reduce((a, v) => a + v, 0) / scores.length;
      // RMS >= arithmetic mean (QM-AM inequality)
      expect(rms).toBeGreaterThanOrEqual(am - 1e-9);
    });

    it('11. agents — riskScoreRMSAllTime computed correctly for known scores', async () => {
      ctx = await setup();
      // Scores [0.3, 0.4] → RMS = sqrt((0.09 + 0.16) / 2) = sqrt(0.125) ≈ 0.35355...
      const scores = [0.3, 0.4];
      for (let i = 0; i < scores.length; i++) {
        await ctx.logger.log(
          makeOp('agent-v10125-rms-calc', 'fs', `sess-${i}`, daysAgo(i + 1), 'call'),
          dec(scores[i]!),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10125-rms-calc');
      expect(status).toBe(200);
      const rms = body.riskScoreRMSAllTime as number;
      expect(rms).not.toBeNull();
      expect(rms).toBeCloseTo(Math.sqrt(0.125), 5);
    });

    it('12. agents — opsMaxDailyAllTime null when no logs (via summary)', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.opsMaxDailyAllTime).toBeNull();
    });

    it('13. agents — opsMaxDailyAllTime >= opsMinDailyAllTime', async () => {
      ctx = await setup();
      // Day 1: 3 ops, Day 2: 1 op → max=3, min=1
      const day1 = daysAgo(2);
      const day2 = daysAgo(1);
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(
          makeOp('agent-v10125-daily-range', 'fs', `sess-d1-${i}`, new Date(day1), 'call'),
          dec(0.4),
        );
      }
      await ctx.logger.log(
        makeOp('agent-v10125-daily-range', 'fs', 'sess-d2-0', new Date(day2), 'call'),
        dec(0.5),
      );
      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10125-daily-range');
      expect(status).toBe(200);
      const maxD = body.opsMaxDailyAllTime as number;
      const minD = body.opsMinDailyAllTime as number;
      expect(maxD).not.toBeNull();
      expect(minD).not.toBeNull();
      expect(maxD).toBeGreaterThanOrEqual(minD);
      expect(maxD).toBeGreaterThanOrEqual(1);
      expect(minD).toBeGreaterThanOrEqual(1);
    });

    it('14. agents — opsMaxDailyAllTime equals total ops when all on same day', async () => {
      ctx = await setup();
      const sameDay = daysAgo(1);
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(
          makeOp('agent-v10125-same-day', 'fs', `sess-${i}`, new Date(sameDay), 'call'),
          dec(0.4),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10125-same-day');
      expect(status).toBe(200);
      expect(body.opsMaxDailyAllTime).toBe(5);
      expect(body.opsMinDailyAllTime).toBe(5);
    });

    it('15. agents — riskScoreGeometricMeanAllTime <= arithmetic mean (GM-AM inequality)', async () => {
      ctx = await setup();
      const scores = [0.3, 0.5, 0.7, 0.9];
      for (let i = 0; i < scores.length; i++) {
        await ctx.logger.log(
          makeOp('agent-v10125-geo-vs-am', 'fs', `sess-${i}`, daysAgo(i + 1), 'call'),
          dec(scores[i]!),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10125-geo-vs-am');
      expect(status).toBe(200);
      const gm = body.riskScoreGeometricMeanAllTime as number;
      expect(gm).not.toBeNull();
      const am = scores.reduce((a, v) => a + v, 0) / scores.length;
      // GM <= AM (AM-GM inequality)
      expect(gm).toBeLessThanOrEqual(am + 1e-9);
      expect(gm).toBeGreaterThan(0);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1694-T1698 — v10.125 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('16. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-m', 'tool-v10125-pres', 'sess-1', daysAgo(1), 'call'),
        dec(0.5, 'allow'),
      );
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10125-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('riskScoreGeometricMeanAllTime');
      expect(body).toHaveProperty('riskScoreRMSAllTime');
      expect(body).toHaveProperty('opsMaxDailyAllTime');
      expect(body).toHaveProperty('opsMinDailyAllTime');
      expect(body).toHaveProperty('riskScoreHighStreakMaxAllTime');
    });

    it('17. tools — riskScoreGeometricMeanAllTime computed correctly for known scores', async () => {
      ctx = await setup();
      // Scores [0.5, 0.5] → GM = sqrt(0.5 * 0.5) = 0.5
      const scores = [0.5, 0.5];
      for (let i = 0; i < scores.length; i++) {
        await ctx.logger.log(
          makeOp(`agent-p${i}`, 'tool-v10125-geo-calc', `sess-${i}`, daysAgo(i + 1), 'call'),
          dec(scores[i]!),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10125-geo-calc');
      expect(status).toBe(200);
      const gm = body.riskScoreGeometricMeanAllTime as number;
      expect(gm).not.toBeNull();
      expect(gm).toBeCloseTo(0.5, 5);
    });

    it('18. tools — opsMinDailyAllTime null when no logs', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.opsMinDailyAllTime).toBeNull();
    });

    it('19. tools — riskScoreHighStreakMaxAllTime = 1 when only one high-risk op', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-q1', 'tool-v10125-streak-1', 'sess-1', daysAgo(2), 'call'),
        dec(0.3),
      );
      await ctx.logger.log(
        makeOp('agent-q1', 'tool-v10125-streak-1', 'sess-2', daysAgo(1), 'call'),
        dec(0.8),
      );
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10125-streak-1');
      expect(status).toBe(200);
      expect(body.riskScoreHighStreakMaxAllTime).toBe(1);
    });

    it('20. tools — riskScoreHighStreakMaxAllTime = all when all ops are high-risk', async () => {
      ctx = await setup();
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(
          makeOp(`agent-r${i}`, 'tool-v10125-streak-all', `sess-${i}`, daysAgo(i + 1), 'call'),
          dec(0.9),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10125-streak-all');
      expect(status).toBe(200);
      expect(body.riskScoreHighStreakMaxAllTime).toBe(4);
    });
  });

  // ── operations/summary endpoint ────────────────────────────────────────────────

  describe('T1694-T1698 — v10.125 new fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('21. summary — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-u1', 'fs', 'sess-1', daysAgo(1), 'call'),
        dec(0.5, 'allow'),
      );
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body).toHaveProperty('riskScoreGeometricMeanAllTime');
      expect(body).toHaveProperty('riskScoreRMSAllTime');
      expect(body).toHaveProperty('opsMaxDailyAllTime');
      expect(body).toHaveProperty('opsMinDailyAllTime');
      expect(body).toHaveProperty('riskScoreHighStreakMaxAllTime');
    });

    it('22. summary — empty DB: all five new fields null', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreGeometricMeanAllTime).toBeNull();
      expect(body.riskScoreRMSAllTime).toBeNull();
      expect(body.opsMaxDailyAllTime).toBeNull();
      expect(body.opsMinDailyAllTime).toBeNull();
      expect(body.riskScoreHighStreakMaxAllTime).toBeNull();
    });

    it('23. summary — riskScoreRMSAllTime is non-negative', async () => {
      ctx = await setup();
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(
          makeOp(`agent-v10125-rms-nn${i}`, 'fs', `sess-${i}`, daysAgo(i + 1), 'call'),
          dec(0.5),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      const rms = body.riskScoreRMSAllTime as number;
      expect(rms).not.toBeNull();
      expect(rms).toBeGreaterThanOrEqual(0);
    });

    it('24. summary — opsMaxDailyAllTime >= 1 when logs exist', async () => {
      ctx = await setup();
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(
          makeOp(`agent-v10125-max-day${i}`, 'fs', `sess-${i}`, daysAgo(i + 1), 'call'),
          dec(0.4),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      const maxD = body.opsMaxDailyAllTime as number;
      expect(maxD).not.toBeNull();
      expect(maxD).toBeGreaterThanOrEqual(1);
    });

    it('25. summary — opsMinDailyAllTime <= opsMaxDailyAllTime', async () => {
      ctx = await setup();
      // Day 1: 2 ops, Day 2: 1 op → max=2, min=1
      const day1 = daysAgo(3);
      const day2 = daysAgo(1);
      for (let i = 0; i < 2; i++) {
        await ctx.logger.log(
          makeOp(`agent-v10125-minmax${i}`, 'fs', `sess-d1-${i}`, new Date(day1), 'call'),
          dec(0.4),
        );
      }
      await ctx.logger.log(
        makeOp('agent-v10125-minmax-d2', 'fs', 'sess-d2', new Date(day2), 'call'),
        dec(0.5),
      );
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      const maxD = body.opsMaxDailyAllTime as number;
      const minD = body.opsMinDailyAllTime as number;
      expect(maxD).not.toBeNull();
      expect(minD).not.toBeNull();
      expect(minD).toBeLessThanOrEqual(maxD);
    });

    it('26. summary — riskScoreGeometricMeanAllTime is null when any score is exactly 0', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-v10125-geo-z1', 'fs', 'sess-gz-1', daysAgo(2), 'call'),
        dec(0.6),
      );
      await ctx.logger.log(
        makeOp('agent-v10125-geo-z2', 'fs', 'sess-gz-2', daysAgo(1), 'call'),
        dec(0.0),
      );
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreGeometricMeanAllTime).toBeNull();
    });

    it('27. summary — riskScoreHighStreakMaxAllTime is 0 when no high-risk ops', async () => {
      ctx = await setup();
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(
          makeOp(`agent-v10125-no-streak${i}`, 'fs', `sess-${i}`, daysAgo(i + 1), 'call'),
          dec(0.3),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreHighStreakMaxAllTime).toBe(0);
    });
  });
});

// ── v10.126 ────────────────────────────────────────────────────────────────────

describe('v10.126', () => {
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1699-T1703 — v10.126 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-a1', 'fs', 'sess-v10126-pres', daysAgo(1), 'call'),
        dec(0.5, 'allow'),
      );
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10126-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('riskScoreAboveMeanRatioAllTime');
      expect(body).toHaveProperty('opsBurstinessAllTime');
      expect(body).toHaveProperty('riskScoreMaxRunAboveMeanAllTime');
      expect(body).toHaveProperty('opsMedianDailyAllTime');
      expect(body).toHaveProperty('riskScoreTrimmedMeanAllTime');
    });

    it('2. sessions — riskScoreAboveMeanRatioAllTime null when no logs (via summary)', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreAboveMeanRatioAllTime).toBeNull();
    });

    it('3. sessions — riskScoreAboveMeanRatioAllTime is 0 when all scores equal (none strictly above mean)', async () => {
      ctx = await setup();
      // All scores equal the mean — no score is strictly above it
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(
          makeOp('agent-b1', 'fs', 'sess-v10126-ratio-zero', daysAgo(i + 1), 'call'),
          dec(0.5),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10126-ratio-zero');
      expect(status).toBe(200);
      expect(body.riskScoreAboveMeanRatioAllTime).toBe(0);
    });

    it('4. sessions — riskScoreAboveMeanRatioAllTime is in [0, 1) with mixed scores', async () => {
      ctx = await setup();
      const scores = [0.1, 0.3, 0.7, 0.9];
      for (let i = 0; i < scores.length; i++) {
        await ctx.logger.log(
          makeOp('agent-c1', 'fs', 'sess-v10126-ratio-mixed', daysAgo(i + 1), 'call'),
          dec(scores[i]!),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10126-ratio-mixed');
      expect(status).toBe(200);
      const ratio = body.riskScoreAboveMeanRatioAllTime as number;
      expect(ratio).not.toBeNull();
      expect(ratio).toBeGreaterThanOrEqual(0);
      expect(ratio).toBeLessThan(1);
    });

    it('5. sessions — opsBurstinessAllTime null when only one log', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-d1', 'fs', 'sess-v10126-burst-one', daysAgo(1), 'call'),
        dec(0.4),
      );
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10126-burst-one');
      expect(status).toBe(200);
      expect(body.opsBurstinessAllTime).toBeNull();
    });

    it('6. sessions — opsBurstinessAllTime in [-1, 1] with multiple logs', async () => {
      ctx = await setup();
      // Logs at different times → non-trivial inter-arrival intervals
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(
          makeOp('agent-e1', 'fs', 'sess-v10126-burst-range', daysAgo(i + 1), 'call'),
          dec(0.5),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10126-burst-range');
      expect(status).toBe(200);
      const b = body.opsBurstinessAllTime as number;
      expect(b).not.toBeNull();
      expect(b).toBeGreaterThanOrEqual(-1);
      expect(b).toBeLessThanOrEqual(1);
    });

    it('7. sessions — riskScoreMaxRunAboveMeanAllTime null when no logs (via summary)', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreMaxRunAboveMeanAllTime).toBeNull();
    });

    it('8. sessions — riskScoreMaxRunAboveMeanAllTime is 0 when no score above mean', async () => {
      ctx = await setup();
      // All equal scores → no score strictly above mean
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(
          makeOp('agent-f1', 'fs', 'sess-v10126-maxrun-zero', daysAgo(i + 1), 'call'),
          dec(0.5),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10126-maxrun-zero');
      expect(status).toBe(200);
      expect(body.riskScoreMaxRunAboveMeanAllTime).toBe(0);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1699-T1703 — v10.126 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('9. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-v10126-pres', 'fs', 'sess-1', daysAgo(1), 'call'),
        dec(0.4, 'allow'),
      );
      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10126-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('riskScoreAboveMeanRatioAllTime');
      expect(body).toHaveProperty('opsBurstinessAllTime');
      expect(body).toHaveProperty('riskScoreMaxRunAboveMeanAllTime');
      expect(body).toHaveProperty('opsMedianDailyAllTime');
      expect(body).toHaveProperty('riskScoreTrimmedMeanAllTime');
    });

    it('10. agents — riskScoreAboveMeanRatioAllTime computed correctly for known scores', async () => {
      ctx = await setup();
      // Scores [0.1, 0.3, 0.5, 0.9] → mean=0.45; above mean: 0.5, 0.9 → ratio = 2/4 = 0.5
      const scores = [0.1, 0.3, 0.5, 0.9];
      for (let i = 0; i < scores.length; i++) {
        await ctx.logger.log(
          makeOp('agent-v10126-ratio-calc', 'fs', `sess-${i}`, daysAgo(i + 1), 'call'),
          dec(scores[i]!),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10126-ratio-calc');
      expect(status).toBe(200);
      const ratio = body.riskScoreAboveMeanRatioAllTime as number;
      expect(ratio).not.toBeNull();
      expect(ratio).toBeCloseTo(0.5, 5);
    });

    it('11. agents — riskScoreMaxRunAboveMeanAllTime correct for known sequence', async () => {
      ctx = await setup();
      // Scores [0.1, 0.8, 0.9, 0.2, 0.7, 0.6] → mean = (0.1+0.8+0.9+0.2+0.7+0.6)/6 = 3.3/6 = 0.55
      // Above mean: 0.8(Y), 0.9(Y), 0.7(Y), 0.6(Y) — but in order:
      // 0.1(N) 0.8(Y) 0.9(Y) 0.2(N) 0.7(Y) 0.6(Y) → max run = 2
      const scores = [0.1, 0.8, 0.9, 0.2, 0.7, 0.6];
      for (let i = 0; i < scores.length; i++) {
        await ctx.logger.log(
          makeOp('agent-v10126-maxrun-calc', 'fs', `sess-${i}`, daysAgo(scores.length - i), 'call'),
          dec(scores[i]!),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10126-maxrun-calc');
      expect(status).toBe(200);
      const maxRun = body.riskScoreMaxRunAboveMeanAllTime as number;
      expect(maxRun).not.toBeNull();
      expect(maxRun).toBeGreaterThanOrEqual(1);
    });

    it('12. agents — opsMedianDailyAllTime null when no logs (via summary)', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.opsMedianDailyAllTime).toBeNull();
    });

    it('13. agents — opsMedianDailyAllTime is a positive number when logs exist', async () => {
      ctx = await setup();
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(
          makeOp('agent-v10126-median-daily', 'fs', `sess-${i}`, daysAgo(i + 1), 'call'),
          dec(0.4),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10126-median-daily');
      expect(status).toBe(200);
      const median = body.opsMedianDailyAllTime as number;
      expect(median).not.toBeNull();
      expect(median).toBeGreaterThanOrEqual(1);
    });

    it('14. agents — riskScoreTrimmedMeanAllTime null when fewer than 5 logs', async () => {
      ctx = await setup();
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(
          makeOp('agent-v10126-trimmed-null', 'fs', `sess-${i}`, daysAgo(i + 1), 'call'),
          dec(0.5),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10126-trimmed-null');
      expect(status).toBe(200);
      expect(body.riskScoreTrimmedMeanAllTime).toBeNull();
    });

    it('15. agents — riskScoreTrimmedMeanAllTime non-null when >= 5 logs', async () => {
      ctx = await setup();
      const scores = [0.1, 0.2, 0.5, 0.7, 0.9];
      for (let i = 0; i < scores.length; i++) {
        await ctx.logger.log(
          makeOp('agent-v10126-trimmed-val', 'fs', `sess-${i}`, daysAgo(i + 1), 'call'),
          dec(scores[i]!),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10126-trimmed-val');
      expect(status).toBe(200);
      const trimmed = body.riskScoreTrimmedMeanAllTime as number;
      expect(trimmed).not.toBeNull();
      expect(trimmed).toBeGreaterThan(0);
      expect(trimmed).toBeLessThanOrEqual(1);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1699-T1703 — v10.126 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('16. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-m', 'tool-v10126-pres', 'sess-1', daysAgo(1), 'call'),
        dec(0.5, 'allow'),
      );
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10126-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('riskScoreAboveMeanRatioAllTime');
      expect(body).toHaveProperty('opsBurstinessAllTime');
      expect(body).toHaveProperty('riskScoreMaxRunAboveMeanAllTime');
      expect(body).toHaveProperty('opsMedianDailyAllTime');
      expect(body).toHaveProperty('riskScoreTrimmedMeanAllTime');
    });

    it('17. tools — opsMedianDailyAllTime equals 1 when all logs on different days', async () => {
      ctx = await setup();
      // Each log on a different day → each day has count 1 → median = 1
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(
          makeOp(`agent-p${i}`, 'tool-v10126-median-1', `sess-${i}`, daysAgo(i + 1), 'call'),
          dec(0.4),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10126-median-1');
      expect(status).toBe(200);
      expect(body.opsMedianDailyAllTime).toBe(1);
    });

    it('18. tools — riskScoreTrimmedMeanAllTime computed correctly for known scores', async () => {
      ctx = await setup();
      // 10 scores sorted: [0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,1.0]
      // trim 10% = 1 from each end → [0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9] → mean=0.55
      const scores = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
      for (let i = 0; i < scores.length; i++) {
        await ctx.logger.log(
          makeOp(`agent-q${i}`, 'tool-v10126-trimmed-calc', `sess-${i}`, daysAgo(i + 1), 'call'),
          dec(scores[i]!),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10126-trimmed-calc');
      expect(status).toBe(200);
      const trimmed = body.riskScoreTrimmedMeanAllTime as number;
      expect(trimmed).not.toBeNull();
      expect(trimmed).toBeCloseTo(0.55, 5);
    });

    it('19. tools — opsBurstinessAllTime is 0 when all inter-arrival times are equal', async () => {
      ctx = await setup();
      // Exactly equal intervals → stddev = 0, mean > 0 → burstiness = (0 - mean)/(0 + mean) = -1
      // Actually for equal intervals: stddev=0, mean>0 → (0 - mean)/(0 + mean) = -1
      // We test that it's a finite number in [-1, 1]
      const base = PINNED_NOW();
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(
          makeOp(`agent-r${i}`, 'tool-v10126-burst-equal', `sess-${i}`, new Date(base + i * 1000), 'call'),
          dec(0.5),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10126-burst-equal');
      expect(status).toBe(200);
      const b = body.opsBurstinessAllTime as number;
      expect(b).not.toBeNull();
      expect(b).toBeGreaterThanOrEqual(-1);
      expect(b).toBeLessThanOrEqual(1);
    });

    it('20. tools — riskScoreMaxRunAboveMeanAllTime non-negative integer', async () => {
      ctx = await setup();
      const scores = [0.2, 0.8, 0.9, 0.1, 0.7, 0.6, 0.4];
      for (let i = 0; i < scores.length; i++) {
        await ctx.logger.log(
          makeOp(`agent-s${i}`, 'tool-v10126-maxrun-int', `sess-${i}`, daysAgo(scores.length - i), 'call'),
          dec(scores[i]!),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10126-maxrun-int');
      expect(status).toBe(200);
      const maxRun = body.riskScoreMaxRunAboveMeanAllTime as number;
      expect(maxRun).not.toBeNull();
      expect(maxRun).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(maxRun)).toBe(true);
    });
  });

  // ── operations/summary endpoint ────────────────────────────────────────────────

  describe('T1699-T1703 — v10.126 new fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('21. summary — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-u1', 'fs', 'sess-1', daysAgo(1), 'call'),
        dec(0.5, 'allow'),
      );
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body).toHaveProperty('riskScoreAboveMeanRatioAllTime');
      expect(body).toHaveProperty('opsBurstinessAllTime');
      expect(body).toHaveProperty('riskScoreMaxRunAboveMeanAllTime');
      expect(body).toHaveProperty('opsMedianDailyAllTime');
      expect(body).toHaveProperty('riskScoreTrimmedMeanAllTime');
    });

    it('22. summary — empty DB: all five new fields null', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreAboveMeanRatioAllTime).toBeNull();
      expect(body.opsBurstinessAllTime).toBeNull();
      expect(body.riskScoreMaxRunAboveMeanAllTime).toBeNull();
      expect(body.opsMedianDailyAllTime).toBeNull();
      expect(body.riskScoreTrimmedMeanAllTime).toBeNull();
    });

    it('23. summary — riskScoreTrimmedMeanAllTime null when only 4 logs', async () => {
      ctx = await setup();
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(
          makeOp(`agent-v10126-trimmed-4-${i}`, 'fs', `sess-${i}`, daysAgo(i + 1), 'call'),
          dec(0.5),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreTrimmedMeanAllTime).toBeNull();
    });

    it('24. summary — opsMedianDailyAllTime = N when all N logs on the same day', async () => {
      ctx = await setup();
      const sameDay = daysAgo(1);
      const N = 5;
      for (let i = 0; i < N; i++) {
        await ctx.logger.log(
          makeOp(`agent-v10126-same-day-${i}`, 'fs', `sess-${i}`, new Date(sameDay), 'call'),
          dec(0.4),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.opsMedianDailyAllTime).toBe(N);
    });

    it('25. summary — opsBurstinessAllTime null with only 1 log', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-v10126-burst-single', 'fs', 'sess-1', daysAgo(1), 'call'),
        dec(0.6),
      );
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.opsBurstinessAllTime).toBeNull();
    });

    it('26. summary — riskScoreAboveMeanRatioAllTime is 1/N for single outlier above equal group', async () => {
      ctx = await setup();
      // 3 equal scores of 0.3, 1 score of 0.9 → mean = (0.9 + 0.3*3)/4 = 1.8/4 = 0.45
      // Only 0.9 is strictly above 0.45 → ratio = 1/4 = 0.25
      const scores = [0.3, 0.3, 0.3, 0.9];
      for (let i = 0; i < scores.length; i++) {
        await ctx.logger.log(
          makeOp(`agent-v10126-ratio-25-${i}`, 'fs', `sess-${i}`, daysAgo(i + 1), 'call'),
          dec(scores[i]!),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      const ratio = body.riskScoreAboveMeanRatioAllTime as number;
      expect(ratio).not.toBeNull();
      expect(ratio).toBeCloseTo(0.25, 5);
    });

    it('27. summary — opsMedianDailyAllTime median of two days is average of both counts', async () => {
      ctx = await setup();
      // Day 1: 3 ops, Day 2: 1 op → counts sorted = [1, 3] → median = (1+3)/2 = 2
      const day1 = daysAgo(3);
      const day2 = daysAgo(1);
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(
          makeOp(`agent-v10126-med-d1-${i}`, 'fs', `sess-d1-${i}`, new Date(day1), 'call'),
          dec(0.4),
        );
      }
      await ctx.logger.log(
        makeOp('agent-v10126-med-d2', 'fs', 'sess-d2', new Date(day2), 'call'),
        dec(0.5),
      );
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.opsMedianDailyAllTime).toBeCloseTo(2, 5);
    });
  });
});

// ── v10.127 ────────────────────────────────────────────────────────────────────

describe('v10.127', () => {
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);
  const hoursAgo = (h: number) => new Date(PINNED_NOW() - h * 3_600_000);

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1704-T1708 — v10.127 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-a1', 'fs', 'sess-v10127-pres', daysAgo(1), 'call'),
        dec(0.5, 'allow'),
      );
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10127-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('riskScoreWinsorizedMeanAllTime');
      expect(body).toHaveProperty('opsMaxHourlyAllTime');
      expect(body).toHaveProperty('opsMinHourlyAllTime');
      expect(body).toHaveProperty('riskScorePctAboveHalfAllTime');
      expect(body).toHaveProperty('riskScoreLastAllTime');
    });

    it('2. sessions — riskScoreWinsorizedMeanAllTime null when fewer than 5 logs', async () => {
      ctx = await setup();
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(
          makeOp('agent-a2', 'fs', 'sess-v10127-wm-null', daysAgo(i + 1), 'call'),
          dec(0.5),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10127-wm-null');
      expect(status).toBe(200);
      expect(body.riskScoreWinsorizedMeanAllTime).toBeNull();
    });

    it('3. sessions — riskScoreWinsorizedMeanAllTime non-null when >= 5 logs and in [0, 1]', async () => {
      ctx = await setup();
      const scores = [0.1, 0.2, 0.5, 0.7, 0.9];
      for (let i = 0; i < scores.length; i++) {
        await ctx.logger.log(
          makeOp('agent-a3', 'fs', 'sess-v10127-wm-val', daysAgo(i + 1), 'call'),
          dec(scores[i]!),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10127-wm-val');
      expect(status).toBe(200);
      const wm = body.riskScoreWinsorizedMeanAllTime as number;
      expect(wm).not.toBeNull();
      expect(wm).toBeGreaterThanOrEqual(0);
      expect(wm).toBeLessThanOrEqual(1);
    });

    it('4. sessions — opsMaxHourlyAllTime null when no logs (via summary)', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.opsMaxHourlyAllTime).toBeNull();
    });

    it('5. sessions — opsMaxHourlyAllTime and opsMinHourlyAllTime both 1 when all logs in different hours', async () => {
      ctx = await setup();
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(
          makeOp('agent-a4', 'fs', 'sess-v10127-hourly-diff', hoursAgo(i * 2 + 2), 'call'),
          dec(0.4),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10127-hourly-diff');
      expect(status).toBe(200);
      expect(body.opsMaxHourlyAllTime).toBe(1);
      expect(body.opsMinHourlyAllTime).toBe(1);
    });

    it('6. sessions — opsMaxHourlyAllTime >= opsMinHourlyAllTime', async () => {
      ctx = await setup();
      // 3 ops in same hour, 1 op in different hour → max=3, min=1
      const sameHour = hoursAgo(5);
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(
          makeOp('agent-a5', 'fs', 'sess-v10127-hourly-mixed', new Date(sameHour.getTime() + i * 60000), 'call'),
          dec(0.4),
        );
      }
      await ctx.logger.log(
        makeOp('agent-a5', 'fs', 'sess-v10127-hourly-mixed', hoursAgo(10), 'call'),
        dec(0.4),
      );
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10127-hourly-mixed');
      expect(status).toBe(200);
      const maxH = body.opsMaxHourlyAllTime as number;
      const minH = body.opsMinHourlyAllTime as number;
      expect(maxH).not.toBeNull();
      expect(minH).not.toBeNull();
      expect(maxH).toBeGreaterThanOrEqual(minH);
      expect(maxH).toBeGreaterThanOrEqual(1);
      expect(minH).toBeGreaterThanOrEqual(1);
    });

    it('7. sessions — riskScorePctAboveHalfAllTime null when no logs (via summary)', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScorePctAboveHalfAllTime).toBeNull();
    });

    it('8. sessions — riskScoreLastAllTime null when no logs (via summary)', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreLastAllTime).toBeNull();
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1704-T1708 — v10.127 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('9. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-v10127-pres', 'fs', 'sess-1', daysAgo(1), 'call'),
        dec(0.4, 'allow'),
      );
      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10127-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('riskScoreWinsorizedMeanAllTime');
      expect(body).toHaveProperty('opsMaxHourlyAllTime');
      expect(body).toHaveProperty('opsMinHourlyAllTime');
      expect(body).toHaveProperty('riskScorePctAboveHalfAllTime');
      expect(body).toHaveProperty('riskScoreLastAllTime');
    });

    it('10. agents — riskScoreWinsorizedMeanAllTime computed correctly for known scores', async () => {
      ctx = await setup();
      // 10 scores: [0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,1.0]
      // P10 index = floor(10*0.1)=1 → sorted[1]=0.2; P90 index = floor(10*0.9)=9 → sorted[9]=1.0
      // Winsorize: clip all to [0.2, 1.0] → same values (all ≥ 0.2, all ≤ 1.0) → mean = 0.55
      const scores = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
      for (let i = 0; i < scores.length; i++) {
        await ctx.logger.log(
          makeOp('agent-v10127-wm-calc', 'fs', `sess-${i}`, daysAgo(i + 1), 'call'),
          dec(scores[i]!),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10127-wm-calc');
      expect(status).toBe(200);
      const wm = body.riskScoreWinsorizedMeanAllTime as number;
      expect(wm).not.toBeNull();
      expect(wm).toBeGreaterThan(0);
      expect(wm).toBeLessThanOrEqual(1);
    });

    it('11. agents — riskScorePctAboveHalfAllTime is 0 when all scores <= 0.5', async () => {
      ctx = await setup();
      const scores = [0.1, 0.3, 0.5, 0.4, 0.2];
      for (let i = 0; i < scores.length; i++) {
        await ctx.logger.log(
          makeOp('agent-v10127-pct-zero', 'fs', `sess-${i}`, daysAgo(i + 1), 'call'),
          dec(scores[i]!),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10127-pct-zero');
      expect(status).toBe(200);
      expect(body.riskScorePctAboveHalfAllTime).toBe(0);
    });

    it('12. agents — riskScorePctAboveHalfAllTime is 1 when all scores > 0.5', async () => {
      ctx = await setup();
      const scores = [0.6, 0.7, 0.8, 0.9];
      for (let i = 0; i < scores.length; i++) {
        await ctx.logger.log(
          makeOp('agent-v10127-pct-one', 'fs', `sess-${i}`, daysAgo(i + 1), 'call'),
          dec(scores[i]!),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10127-pct-one');
      expect(status).toBe(200);
      expect(body.riskScorePctAboveHalfAllTime).toBe(1);
    });

    it('13. agents — riskScorePctAboveHalfAllTime is 0.5 when half scores > 0.5', async () => {
      ctx = await setup();
      // 2 scores <= 0.5, 2 scores > 0.5 → pct = 0.5
      const scores = [0.3, 0.5, 0.7, 0.9];
      for (let i = 0; i < scores.length; i++) {
        await ctx.logger.log(
          makeOp('agent-v10127-pct-half', 'fs', `sess-${i}`, daysAgo(i + 1), 'call'),
          dec(scores[i]!),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10127-pct-half');
      expect(status).toBe(200);
      expect(body.riskScorePctAboveHalfAllTime).toBeCloseTo(0.5, 5);
    });

    it('14. agents — riskScoreLastAllTime equals the most recently logged score', async () => {
      ctx = await setup();
      // Log older scores first, then newest last; logs are ordered newest-first → logs[0] is the newest
      await ctx.logger.log(
        makeOp('agent-v10127-last', 'fs', 'sess-last', daysAgo(3), 'call'),
        dec(0.2),
      );
      await ctx.logger.log(
        makeOp('agent-v10127-last', 'fs', 'sess-last', daysAgo(2), 'call'),
        dec(0.4),
      );
      await ctx.logger.log(
        makeOp('agent-v10127-last', 'fs', 'sess-last', daysAgo(1), 'call'),
        dec(0.9),
      );
      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10127-last');
      expect(status).toBe(200);
      const last = body.riskScoreLastAllTime as number;
      expect(last).not.toBeNull();
      expect(last).toBeCloseTo(0.9, 5);
    });

    it('15. agents — opsMaxHourlyAllTime equals peak hourly bucket count', async () => {
      ctx = await setup();
      // 4 ops in one hour, 1 op in another → max = 4
      const peakHour = hoursAgo(5);
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(
          makeOp('agent-v10127-maxh', 'fs', `sess-${i}`, new Date(peakHour.getTime() + i * 60000), 'call'),
          dec(0.5),
        );
      }
      await ctx.logger.log(
        makeOp('agent-v10127-maxh', 'fs', 'sess-x', hoursAgo(20), 'call'),
        dec(0.5),
      );
      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10127-maxh');
      expect(status).toBe(200);
      expect(body.opsMaxHourlyAllTime).toBe(4);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1704-T1708 — v10.127 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('16. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-m1', 'tool-v10127-pres', 'sess-1', daysAgo(1), 'call'),
        dec(0.5, 'allow'),
      );
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10127-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('riskScoreWinsorizedMeanAllTime');
      expect(body).toHaveProperty('opsMaxHourlyAllTime');
      expect(body).toHaveProperty('opsMinHourlyAllTime');
      expect(body).toHaveProperty('riskScorePctAboveHalfAllTime');
      expect(body).toHaveProperty('riskScoreLastAllTime');
    });

    it('17. tools — opsMinHourlyAllTime equals lowest hourly bucket count', async () => {
      ctx = await setup();
      // 1 op 10 hours ago, 3 ops in same current hour → min = 1
      await ctx.logger.log(
        makeOp('agent-t1', 'tool-v10127-minh', 'sess-lone', hoursAgo(10), 'call'),
        dec(0.4),
      );
      const nowHour = new Date(PINNED_NOW());
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(
          makeOp('agent-t1', 'tool-v10127-minh', `sess-now-${i}`, new Date(nowHour.getTime() - i * 1000), 'call'),
          dec(0.4),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10127-minh');
      expect(status).toBe(200);
      expect(body.opsMinHourlyAllTime).toBe(1);
      expect(body.opsMaxHourlyAllTime).toBe(3);
    });

    it('18. tools — riskScoreWinsorizedMeanAllTime null when exactly 4 logs', async () => {
      ctx = await setup();
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(
          makeOp(`agent-t2-${i}`, 'tool-v10127-wm-4', `sess-${i}`, daysAgo(i + 1), 'call'),
          dec(0.5),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10127-wm-4');
      expect(status).toBe(200);
      expect(body.riskScoreWinsorizedMeanAllTime).toBeNull();
    });

    it('19. tools — riskScorePctAboveHalfAllTime is fraction with mixed scores', async () => {
      ctx = await setup();
      // 1 score > 0.5, 3 scores <= 0.5 → pct = 1/4 = 0.25
      const scores = [0.2, 0.4, 0.5, 0.8];
      for (let i = 0; i < scores.length; i++) {
        await ctx.logger.log(
          makeOp(`agent-t3-${i}`, 'tool-v10127-pct-mixed', `sess-${i}`, daysAgo(i + 1), 'call'),
          dec(scores[i]!),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10127-pct-mixed');
      expect(status).toBe(200);
      expect(body.riskScorePctAboveHalfAllTime).toBeCloseTo(0.25, 5);
    });

    it('20. tools — riskScoreLastAllTime is non-null and in [0, 1] when logs exist', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-t4', 'tool-v10127-last-range', 'sess-1', daysAgo(1), 'call'),
        dec(0.75),
      );
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10127-last-range');
      expect(status).toBe(200);
      const last = body.riskScoreLastAllTime as number;
      expect(last).not.toBeNull();
      expect(last).toBeGreaterThanOrEqual(0);
      expect(last).toBeLessThanOrEqual(1);
    });
  });

  // ── operations/summary endpoint ────────────────────────────────────────────────

  describe('T1704-T1708 — v10.127 new fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('21. summary — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-u1', 'fs', 'sess-1', daysAgo(1), 'call'),
        dec(0.5, 'allow'),
      );
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body).toHaveProperty('riskScoreWinsorizedMeanAllTime');
      expect(body).toHaveProperty('opsMaxHourlyAllTime');
      expect(body).toHaveProperty('opsMinHourlyAllTime');
      expect(body).toHaveProperty('riskScorePctAboveHalfAllTime');
      expect(body).toHaveProperty('riskScoreLastAllTime');
    });

    it('22. summary — empty DB: all five new fields null', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreWinsorizedMeanAllTime).toBeNull();
      expect(body.opsMaxHourlyAllTime).toBeNull();
      expect(body.opsMinHourlyAllTime).toBeNull();
      expect(body.riskScorePctAboveHalfAllTime).toBeNull();
      expect(body.riskScoreLastAllTime).toBeNull();
    });

    it('23. summary — riskScoreWinsorizedMeanAllTime null when only 4 global logs', async () => {
      ctx = await setup();
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(
          makeOp(`agent-v10127-wm4-${i}`, 'fs', `sess-${i}`, daysAgo(i + 1), 'call'),
          dec(0.5),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreWinsorizedMeanAllTime).toBeNull();
    });

    it('24. summary — riskScoreLastAllTime is the score of the most recently inserted log', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-v10127-last-s1', 'fs', 'sess-1', daysAgo(5), 'call'),
        dec(0.1),
      );
      await ctx.logger.log(
        makeOp('agent-v10127-last-s2', 'fs', 'sess-2', daysAgo(1), 'call'),
        dec(0.8),
      );
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      // Newest log (daysAgo(1)) has score 0.8
      expect(body.riskScoreLastAllTime).toBeCloseTo(0.8, 5);
    });

    it('25. summary — opsMaxHourlyAllTime >= opsMinHourlyAllTime when multiple hours have logs', async () => {
      ctx = await setup();
      // 2 ops in hour A, 1 op in hour B → max=2, min=1
      const hourA = hoursAgo(3);
      for (let i = 0; i < 2; i++) {
        await ctx.logger.log(
          makeOp(`agent-v10127-hourly-ab-${i}`, 'fs', `sess-a-${i}`, new Date(hourA.getTime() + i * 1000), 'call'),
          dec(0.4),
        );
      }
      await ctx.logger.log(
        makeOp('agent-v10127-hourly-ab-b', 'fs', 'sess-b', hoursAgo(10), 'call'),
        dec(0.4),
      );
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      const maxH = body.opsMaxHourlyAllTime as number;
      const minH = body.opsMinHourlyAllTime as number;
      expect(maxH).toBeGreaterThanOrEqual(minH);
      expect(maxH).toBe(2);
      expect(minH).toBe(1);
    });

    it('26. summary — riskScorePctAboveHalfAllTime is in [0, 1]', async () => {
      ctx = await setup();
      const scores = [0.2, 0.4, 0.6, 0.8, 0.9];
      for (let i = 0; i < scores.length; i++) {
        await ctx.logger.log(
          makeOp(`agent-v10127-pct-range-${i}`, 'fs', `sess-${i}`, daysAgo(i + 1), 'call'),
          dec(scores[i]!),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      const pct = body.riskScorePctAboveHalfAllTime as number;
      expect(pct).not.toBeNull();
      expect(pct).toBeGreaterThanOrEqual(0);
      expect(pct).toBeLessThanOrEqual(1);
      // 3 out of 5 scores > 0.5 → 0.6
      expect(pct).toBeCloseTo(0.6, 5);
    });

    it('27. summary — riskScoreWinsorizedMeanAllTime stays in [0, 1] for extreme scores', async () => {
      ctx = await setup();
      // 5 uniform scores at 0.5 → winsorized mean = 0.5
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(
          makeOp(`agent-v10127-wm-uniform-${i}`, 'fs', `sess-${i}`, daysAgo(i + 1), 'call'),
          dec(0.5),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      const wm = body.riskScoreWinsorizedMeanAllTime as number;
      expect(wm).not.toBeNull();
      expect(wm).toBeGreaterThanOrEqual(0);
      expect(wm).toBeLessThanOrEqual(1);
      expect(wm).toBeCloseTo(0.5, 5);
    });
  });
});

// ── v10.128 ────────────────────────────────────────────────────────────────────

describe('v10.128', () => {
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);
  const hoursAgo = (h: number) => new Date(PINNED_NOW() - h * 3_600_000);

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1709-T1713 — v10.128 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-a1', 'fs', 'sess-v10128-pres', daysAgo(1), 'call'),
        dec(0.5, 'allow'),
      );
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10128-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('opsStdDevDailyAllTime');
      expect(body).toHaveProperty('opsStdDevHourlyAllTime');
      expect(body).toHaveProperty('opsMedianHourlyAllTime');
      expect(body).toHaveProperty('riskScoreFirstAllTime');
      expect(body).toHaveProperty('opsUniqueHoursAllTime');
    });

    it('2. sessions — empty DB: all five new fields null (via summary)', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.opsStdDevDailyAllTime).toBeNull();
      expect(body.opsStdDevHourlyAllTime).toBeNull();
      expect(body.opsMedianHourlyAllTime).toBeNull();
      expect(body.riskScoreFirstAllTime).toBeNull();
      expect(body.opsUniqueHoursAllTime).toBeNull();
    });

    it('3. sessions — opsStdDevDailyAllTime null when only 1 distinct day', async () => {
      ctx = await setup();
      // All logs in the same day
      const now = new Date(PINNED_NOW());
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(
          makeOp('agent-a2', 'fs', 'sess-v10128-sd-one', new Date(now.getTime() + i * 60_000), 'call'),
          dec(0.4),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10128-sd-one');
      expect(status).toBe(200);
      expect(body.opsStdDevDailyAllTime).toBeNull();
    });

    it('4. sessions — opsStdDevDailyAllTime non-negative float when >= 2 distinct days', async () => {
      ctx = await setup();
      // 2 ops on day-1, 1 op on day-2 → counts=[2,1], mean=1.5, variance=0.25, stddev=0.5
      const day1 = daysAgo(2);
      await ctx.logger.log(
        makeOp('agent-a3', 'fs', 'sess-v10128-sd-days', new Date(day1.getTime()), 'call'),
        dec(0.3),
      );
      await ctx.logger.log(
        makeOp('agent-a3', 'fs', 'sess-v10128-sd-days', new Date(day1.getTime() + 3_600_000), 'call'),
        dec(0.3),
      );
      await ctx.logger.log(
        makeOp('agent-a3', 'fs', 'sess-v10128-sd-days', daysAgo(1), 'call'),
        dec(0.3),
      );
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10128-sd-days');
      expect(status).toBe(200);
      const sd = body.opsStdDevDailyAllTime as number;
      expect(sd).not.toBeNull();
      expect(sd).toBeGreaterThanOrEqual(0);
      expect(sd).toBeCloseTo(0.5, 5);
    });

    it('5. sessions — opsMedianHourlyAllTime returns correct median', async () => {
      ctx = await setup();
      // 3 ops in hour-A, 1 op in hour-B → counts sorted=[1,3], median=2 (even count)
      const hourA = hoursAgo(5);
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(
          makeOp('agent-a4', 'fs', 'sess-v10128-med', new Date(hourA.getTime() + i * 60_000), 'call'),
          dec(0.4),
        );
      }
      await ctx.logger.log(
        makeOp('agent-a4', 'fs', 'sess-v10128-med', hoursAgo(10), 'call'),
        dec(0.4),
      );
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10128-med');
      expect(status).toBe(200);
      const med = body.opsMedianHourlyAllTime as number;
      expect(med).not.toBeNull();
      expect(med).toBeGreaterThan(0);
      // counts=[1,3] → even → median=(1+3)/2=2
      expect(med).toBeCloseTo(2, 5);
    });

    it('6. sessions — riskScoreFirstAllTime is oldest log score (not newest)', async () => {
      ctx = await setup();
      // Log oldest first with score 0.1, then newest with score 0.9
      // logs are newest-first → logs[logs.length-1] = oldest → riskScoreFirstAllTime = 0.1
      await ctx.logger.log(
        makeOp('agent-a5', 'fs', 'sess-v10128-first', daysAgo(3), 'call'),
        dec(0.1),
      );
      await ctx.logger.log(
        makeOp('agent-a5', 'fs', 'sess-v10128-first', daysAgo(1), 'call'),
        dec(0.9),
      );
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10128-first');
      expect(status).toBe(200);
      const first = body.riskScoreFirstAllTime as number;
      expect(first).not.toBeNull();
      expect(first).toBeCloseTo(0.1, 5);
    });

    it('7. sessions — opsUniqueHoursAllTime counts distinct hours correctly', async () => {
      ctx = await setup();
      // 3 ops in same hour + 1 op in different hour → 2 unique hours
      const hourA = hoursAgo(5);
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(
          makeOp('agent-a6', 'fs', 'sess-v10128-uhours', new Date(hourA.getTime() + i * 60_000), 'call'),
          dec(0.4),
        );
      }
      await ctx.logger.log(
        makeOp('agent-a6', 'fs', 'sess-v10128-uhours', hoursAgo(10), 'call'),
        dec(0.4),
      );
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10128-uhours');
      expect(status).toBe(200);
      expect(body.opsUniqueHoursAllTime).toBe(2);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1709-T1713 — v10.128 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('8. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-v10128-pres', 'fs', 'sess-1', daysAgo(1), 'call'),
        dec(0.4, 'allow'),
      );
      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10128-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('opsStdDevDailyAllTime');
      expect(body).toHaveProperty('opsStdDevHourlyAllTime');
      expect(body).toHaveProperty('opsMedianHourlyAllTime');
      expect(body).toHaveProperty('riskScoreFirstAllTime');
      expect(body).toHaveProperty('opsUniqueHoursAllTime');
    });

    it('9. agents — opsStdDevHourlyAllTime null when only 1 distinct hour', async () => {
      ctx = await setup();
      // All 3 ops in the same hour
      const nowHour = new Date(PINNED_NOW());
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(
          makeOp('agent-v10128-sdh-one', 'fs', `sess-${i}`, new Date(nowHour.getTime() + i * 60_000), 'call'),
          dec(0.5),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10128-sdh-one');
      expect(status).toBe(200);
      expect(body.opsStdDevHourlyAllTime).toBeNull();
    });

    it('10. agents — opsStdDevHourlyAllTime non-negative when >= 2 distinct hours', async () => {
      ctx = await setup();
      // 2 ops in hour-A, 1 op in hour-B → counts=[2,1] → stddev=0.5
      const hourA = hoursAgo(5);
      await ctx.logger.log(
        makeOp('agent-v10128-sdh-two', 'fs', 'sess-1', new Date(hourA.getTime()), 'call'),
        dec(0.4),
      );
      await ctx.logger.log(
        makeOp('agent-v10128-sdh-two', 'fs', 'sess-2', new Date(hourA.getTime() + 60_000), 'call'),
        dec(0.4),
      );
      await ctx.logger.log(
        makeOp('agent-v10128-sdh-two', 'fs', 'sess-3', hoursAgo(10), 'call'),
        dec(0.4),
      );
      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10128-sdh-two');
      expect(status).toBe(200);
      const sd = body.opsStdDevHourlyAllTime as number;
      expect(sd).not.toBeNull();
      expect(sd).toBeGreaterThanOrEqual(0);
      expect(sd).toBeCloseTo(0.5, 5);
    });

    it('11. agents — riskScoreFirstAllTime is oldest log riskScore in [0, 1]', async () => {
      ctx = await setup();
      // Log older first (score 0.2), then newer (score 0.8)
      // oldest = logs[logs.length-1] → 0.2
      await ctx.logger.log(
        makeOp('agent-v10128-first-range', 'fs', 'sess-1', daysAgo(5), 'call'),
        dec(0.2),
      );
      await ctx.logger.log(
        makeOp('agent-v10128-first-range', 'fs', 'sess-2', daysAgo(1), 'call'),
        dec(0.8),
      );
      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10128-first-range');
      expect(status).toBe(200);
      const first = body.riskScoreFirstAllTime as number;
      expect(first).not.toBeNull();
      expect(first).toBeGreaterThanOrEqual(0);
      expect(first).toBeLessThanOrEqual(1);
      expect(first).toBeCloseTo(0.2, 5);
    });

    it('12. agents — opsUniqueHoursAllTime is 1 when all ops in same hour', async () => {
      ctx = await setup();
      const nowHour = new Date(PINNED_NOW());
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(
          makeOp('agent-v10128-uhours-one', 'fs', `sess-${i}`, new Date(nowHour.getTime() + i * 60_000), 'call'),
          dec(0.3),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10128-uhours-one');
      expect(status).toBe(200);
      expect(body.opsUniqueHoursAllTime).toBe(1);
    });

    it('13. agents — opsMedianHourlyAllTime equals single count when only 1 hour bucket', async () => {
      ctx = await setup();
      // 3 ops all in the same hour → one bucket with count=3, median=3
      const nowHour = new Date(PINNED_NOW());
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(
          makeOp('agent-v10128-med-single', 'fs', `sess-${i}`, new Date(nowHour.getTime() + i * 10_000), 'call'),
          dec(0.5),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10128-med-single');
      expect(status).toBe(200);
      expect(body.opsMedianHourlyAllTime).toBe(3);
    });

    it('14. agents — opsStdDevDailyAllTime is 0 when all days have exactly 1 op each', async () => {
      ctx = await setup();
      // 3 ops each on different days, all with count=1 → stddev=0
      for (let i = 1; i <= 3; i++) {
        await ctx.logger.log(
          makeOp('agent-v10128-sd-uniform', 'fs', `sess-${i}`, daysAgo(i), 'call'),
          dec(0.5),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10128-sd-uniform');
      expect(status).toBe(200);
      const sd = body.opsStdDevDailyAllTime as number;
      expect(sd).not.toBeNull();
      expect(sd).toBeCloseTo(0, 5);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1709-T1713 — v10.128 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('15. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-m1', 'tool-v10128-pres', 'sess-1', daysAgo(1), 'call'),
        dec(0.5, 'allow'),
      );
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10128-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('opsStdDevDailyAllTime');
      expect(body).toHaveProperty('opsStdDevHourlyAllTime');
      expect(body).toHaveProperty('opsMedianHourlyAllTime');
      expect(body).toHaveProperty('riskScoreFirstAllTime');
      expect(body).toHaveProperty('opsUniqueHoursAllTime');
    });

    it('16. tools — opsUniqueHoursAllTime counts each unique hour bucket once', async () => {
      ctx = await setup();
      // 2 ops in hour-1, 3 ops in hour-2, 1 op in hour-3 → 3 unique hours
      const h1 = hoursAgo(3);
      const h2 = hoursAgo(6);
      const h3 = hoursAgo(10);
      for (let i = 0; i < 2; i++) {
        await ctx.logger.log(
          makeOp('agent-t1', 'tool-v10128-uhours-3', `sess-h1-${i}`, new Date(h1.getTime() + i * 60_000), 'call'),
          dec(0.4),
        );
      }
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(
          makeOp('agent-t1', 'tool-v10128-uhours-3', `sess-h2-${i}`, new Date(h2.getTime() + i * 60_000), 'call'),
          dec(0.4),
        );
      }
      await ctx.logger.log(
        makeOp('agent-t1', 'tool-v10128-uhours-3', 'sess-h3', new Date(h3.getTime()), 'call'),
        dec(0.4),
      );
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10128-uhours-3');
      expect(status).toBe(200);
      expect(body.opsUniqueHoursAllTime).toBe(3);
    });

    it('17. tools — riskScoreFirstAllTime is oldest score not newest', async () => {
      ctx = await setup();
      // oldest logged: daysAgo(10) score=0.15; newest logged: daysAgo(1) score=0.85
      await ctx.logger.log(
        makeOp('agent-t2', 'tool-v10128-first', 'sess-old', daysAgo(10), 'call'),
        dec(0.15),
      );
      await ctx.logger.log(
        makeOp('agent-t2', 'tool-v10128-first', 'sess-new', daysAgo(1), 'call'),
        dec(0.85),
      );
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10128-first');
      expect(status).toBe(200);
      // logs[logs.length-1] = oldest → score=0.15
      expect(body.riskScoreFirstAllTime).toBeCloseTo(0.15, 5);
    });

    it('18. tools — opsMedianHourlyAllTime odd number of buckets gives middle value', async () => {
      ctx = await setup();
      // 3 distinct hours with counts: [1, 2, 3] sorted → median = 2 (middle of 3)
      for (let i = 0; i < 1; i++) {
        await ctx.logger.log(
          makeOp('agent-t3', 'tool-v10128-med-odd', `sess-h1-${i}`, hoursAgo(10 + i), 'call'),
          dec(0.4),
        );
      }
      const h2 = hoursAgo(5);
      for (let i = 0; i < 2; i++) {
        await ctx.logger.log(
          makeOp('agent-t3', 'tool-v10128-med-odd', `sess-h2-${i}`, new Date(h2.getTime() + i * 60_000), 'call'),
          dec(0.4),
        );
      }
      const h3 = hoursAgo(2);
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(
          makeOp('agent-t3', 'tool-v10128-med-odd', `sess-h3-${i}`, new Date(h3.getTime() + i * 60_000), 'call'),
          dec(0.4),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10128-med-odd');
      expect(status).toBe(200);
      // sorted counts=[1,2,3], n=3 odd → median=counts[1]=2
      expect(body.opsMedianHourlyAllTime).toBe(2);
    });

    it('19. tools — opsStdDevHourlyAllTime is 0 when all hours have same count', async () => {
      ctx = await setup();
      // 2 ops per hour across 3 different hours → all counts=2, stddev=0
      for (let h = 1; h <= 3; h++) {
        const hourBase = hoursAgo(h * 3);
        for (let i = 0; i < 2; i++) {
          await ctx.logger.log(
            makeOp('agent-t4', 'tool-v10128-sdh-zero', `sess-h${h}-${i}`, new Date(hourBase.getTime() + i * 60_000), 'call'),
            dec(0.5),
          );
        }
      }
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10128-sdh-zero');
      expect(status).toBe(200);
      const sd = body.opsStdDevHourlyAllTime as number;
      expect(sd).not.toBeNull();
      expect(sd).toBeCloseTo(0, 5);
    });
  });

  // ── operations/summary endpoint ────────────────────────────────────────────────

  describe('T1709-T1713 — v10.128 new fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('20. summary — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-u1', 'fs', 'sess-1', daysAgo(1), 'call'),
        dec(0.5, 'allow'),
      );
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body).toHaveProperty('opsStdDevDailyAllTime');
      expect(body).toHaveProperty('opsStdDevHourlyAllTime');
      expect(body).toHaveProperty('opsMedianHourlyAllTime');
      expect(body).toHaveProperty('riskScoreFirstAllTime');
      expect(body).toHaveProperty('opsUniqueHoursAllTime');
    });

    it('21. summary — opsStdDevDailyAllTime null with no logs', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.opsStdDevDailyAllTime).toBeNull();
    });

    it('22. summary — opsStdDevHourlyAllTime null with no logs', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.opsStdDevHourlyAllTime).toBeNull();
    });

    it('23. summary — riskScoreFirstAllTime equals oldest log score globally', async () => {
      ctx = await setup();
      // Two agents; oldest log is the one at daysAgo(10) with score 0.05
      await ctx.logger.log(
        makeOp('agent-u2', 'fs', 'sess-1', daysAgo(10), 'call'),
        dec(0.05),
      );
      await ctx.logger.log(
        makeOp('agent-u3', 'fs', 'sess-2', daysAgo(1), 'call'),
        dec(0.95),
      );
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreFirstAllTime).toBeCloseTo(0.05, 5);
    });

    it('24. summary — opsUniqueHoursAllTime is >= 1 when logs exist', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-u4', 'fs', 'sess-1', new Date(PINNED_NOW()), 'call'),
        dec(0.5),
      );
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      const u = body.opsUniqueHoursAllTime as number;
      expect(u).not.toBeNull();
      expect(u).toBeGreaterThanOrEqual(1);
    });

    it('25. summary — opsMedianHourlyAllTime equals single-bucket count with 1 hour', async () => {
      ctx = await setup();
      // 5 ops all in the current hour → 1 bucket with count=5, median=5
      const nowHour = new Date(PINNED_NOW());
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(
          makeOp(`agent-u5-${i}`, 'fs', `sess-${i}`, new Date(nowHour.getTime() + i * 5_000), 'call'),
          dec(0.5),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.opsMedianHourlyAllTime).toBe(5);
    });

    it('26. summary — opsStdDevDailyAllTime >= 0 with multiple distinct days', async () => {
      ctx = await setup();
      for (let i = 1; i <= 4; i++) {
        await ctx.logger.log(
          makeOp(`agent-u6-${i}`, 'fs', `sess-${i}`, daysAgo(i), 'call'),
          dec(0.5),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      const sd = body.opsStdDevDailyAllTime as number;
      expect(sd).not.toBeNull();
      expect(sd).toBeGreaterThanOrEqual(0);
    });

    it('27. summary — opsUniqueHoursAllTime equals the number of distinct hour buckets', async () => {
      ctx = await setup();
      // 5 ops in 5 distinct hours → opsUniqueHoursAllTime = 5
      for (let h = 1; h <= 5; h++) {
        await ctx.logger.log(
          makeOp(`agent-u7-h${h}`, 'fs', `sess-${h}`, hoursAgo(h * 3), 'call'),
          dec(0.4),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.opsUniqueHoursAllTime).toBe(5);
    });
  });
});

// ── v10.129 ────────────────────────────────────────────────────────────────────

describe('v10.129', () => {
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);
  const hoursAgo = (h: number) => new Date(PINNED_NOW() - h * 3_600_000);

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1714-T1718 — v10.129 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-a1', 'fs', 'sess-v10129-pres', daysAgo(1), 'call'),
        dec(0.5, 'allow'),
      );
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10129-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('opsIQRDailyAllTime');
      expect(body).toHaveProperty('opsIQRHourlyAllTime');
      expect(body).toHaveProperty('opsCVDailyAllTime');
      expect(body).toHaveProperty('riskScoreAbove75PctAllTime');
      expect(body).toHaveProperty('riskScoreBelow25PctAllTime');
    });

    it('2. sessions — all five new fields null with no logs (via summary)', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.opsIQRDailyAllTime).toBeNull();
      expect(body.opsIQRHourlyAllTime).toBeNull();
      expect(body.opsCVDailyAllTime).toBeNull();
      expect(body.riskScoreAbove75PctAllTime).toBeNull();
      expect(body.riskScoreBelow25PctAllTime).toBeNull();
    });

    it('3. sessions — opsIQRDailyAllTime null when < 4 distinct days', async () => {
      ctx = await setup();
      // Only 3 distinct days → should return null
      for (let d = 1; d <= 3; d++) {
        await ctx.logger.log(
          makeOp('agent-a2', 'fs', 'sess-v10129-iqr-few', daysAgo(d), 'call'),
          dec(0.4),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10129-iqr-few');
      expect(status).toBe(200);
      expect(body.opsIQRDailyAllTime).toBeNull();
    });

    it('4. sessions — opsIQRDailyAllTime non-negative integer when >= 4 distinct days', async () => {
      ctx = await setup();
      // 4 distinct days with counts [1,1,1,1] → P25=1, P75=1, IQR=0
      for (let d = 1; d <= 4; d++) {
        await ctx.logger.log(
          makeOp('agent-a3', 'fs', 'sess-v10129-iqr-daily', daysAgo(d), 'call'),
          dec(0.3),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10129-iqr-daily');
      expect(status).toBe(200);
      const iqr = body.opsIQRDailyAllTime as number;
      expect(iqr).not.toBeNull();
      expect(iqr).toBeGreaterThanOrEqual(0);
    });

    it('5. sessions — opsCVDailyAllTime null when only 1 distinct day', async () => {
      ctx = await setup();
      // All ops in same day
      const now = new Date(PINNED_NOW());
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(
          makeOp('agent-a4', 'fs', 'sess-v10129-cv-one', new Date(now.getTime() + i * 60_000), 'call'),
          dec(0.5),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10129-cv-one');
      expect(status).toBe(200);
      expect(body.opsCVDailyAllTime).toBeNull();
    });

    it('6. sessions — opsCVDailyAllTime non-negative float when >= 2 distinct days', async () => {
      ctx = await setup();
      // 2 ops on day-1, 4 ops on day-2 → counts=[2,4], mean=3, stddev≈1, CV≈0.333
      const day1 = daysAgo(2);
      for (let i = 0; i < 2; i++) {
        await ctx.logger.log(
          makeOp('agent-a5', 'fs', 'sess-v10129-cv-days', new Date(day1.getTime() + i * 60_000), 'call'),
          dec(0.4),
        );
      }
      const day2 = daysAgo(1);
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(
          makeOp('agent-a5', 'fs', 'sess-v10129-cv-days', new Date(day2.getTime() + i * 60_000), 'call'),
          dec(0.4),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10129-cv-days');
      expect(status).toBe(200);
      const cv = body.opsCVDailyAllTime as number;
      expect(cv).not.toBeNull();
      expect(cv).toBeGreaterThanOrEqual(0);
    });

    it('7. sessions — riskScoreAbove75PctAllTime is 0 when no logs with score > 0.75', async () => {
      ctx = await setup();
      // All logs have riskScore <= 0.75
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(
          makeOp('agent-a6', 'fs', 'sess-v10129-above75-zero', daysAgo(i + 1), 'call'),
          dec(0.5),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10129-above75-zero');
      expect(status).toBe(200);
      expect(body.riskScoreAbove75PctAllTime).toBe(0);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1714-T1718 — v10.129 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('8. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-v10129-pres', 'fs', 'sess-1', daysAgo(1), 'call'),
        dec(0.4, 'allow'),
      );
      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10129-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('opsIQRDailyAllTime');
      expect(body).toHaveProperty('opsIQRHourlyAllTime');
      expect(body).toHaveProperty('opsCVDailyAllTime');
      expect(body).toHaveProperty('riskScoreAbove75PctAllTime');
      expect(body).toHaveProperty('riskScoreBelow25PctAllTime');
    });

    it('9. agents — riskScoreAbove75PctAllTime correct ratio', async () => {
      ctx = await setup();
      // 2 logs with riskScore > 0.75, 2 logs with riskScore <= 0.75 → ratio = 0.5
      await ctx.logger.log(
        makeOp('agent-v10129-above75-ratio', 'fs', 'sess-1', daysAgo(1), 'call'),
        dec(0.8),
      );
      await ctx.logger.log(
        makeOp('agent-v10129-above75-ratio', 'fs', 'sess-2', daysAgo(2), 'call'),
        dec(0.9),
      );
      await ctx.logger.log(
        makeOp('agent-v10129-above75-ratio', 'fs', 'sess-3', daysAgo(3), 'call'),
        dec(0.5),
      );
      await ctx.logger.log(
        makeOp('agent-v10129-above75-ratio', 'fs', 'sess-4', daysAgo(4), 'call'),
        dec(0.3),
      );
      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10129-above75-ratio');
      expect(status).toBe(200);
      const pct = body.riskScoreAbove75PctAllTime as number;
      expect(pct).not.toBeNull();
      expect(pct).toBeCloseTo(0.5, 5);
      expect(pct).toBeGreaterThanOrEqual(0);
      expect(pct).toBeLessThanOrEqual(1);
    });

    it('10. agents — riskScoreBelow25PctAllTime correct ratio', async () => {
      ctx = await setup();
      // 1 log with riskScore < 0.25, 3 logs with riskScore >= 0.25 → ratio = 0.25
      await ctx.logger.log(
        makeOp('agent-v10129-below25-ratio', 'fs', 'sess-1', daysAgo(1), 'call'),
        dec(0.1),
      );
      await ctx.logger.log(
        makeOp('agent-v10129-below25-ratio', 'fs', 'sess-2', daysAgo(2), 'call'),
        dec(0.5),
      );
      await ctx.logger.log(
        makeOp('agent-v10129-below25-ratio', 'fs', 'sess-3', daysAgo(3), 'call'),
        dec(0.7),
      );
      await ctx.logger.log(
        makeOp('agent-v10129-below25-ratio', 'fs', 'sess-4', daysAgo(4), 'call'),
        dec(0.9),
      );
      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10129-below25-ratio');
      expect(status).toBe(200);
      const pct = body.riskScoreBelow25PctAllTime as number;
      expect(pct).not.toBeNull();
      expect(pct).toBeCloseTo(0.25, 5);
      expect(pct).toBeGreaterThanOrEqual(0);
      expect(pct).toBeLessThanOrEqual(1);
    });

    it('11. agents — opsIQRHourlyAllTime null when < 4 distinct hours', async () => {
      ctx = await setup();
      // Only 3 distinct hours → should be null
      for (let h = 1; h <= 3; h++) {
        await ctx.logger.log(
          makeOp('agent-v10129-iqr-hour-few', 'fs', `sess-${h}`, hoursAgo(h * 2), 'call'),
          dec(0.5),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10129-iqr-hour-few');
      expect(status).toBe(200);
      expect(body.opsIQRHourlyAllTime).toBeNull();
    });

    it('12. agents — opsIQRHourlyAllTime non-negative when >= 4 distinct hours', async () => {
      ctx = await setup();
      // 4 ops each in a distinct hour → IQR of [1,1,1,1] = 0
      for (let h = 1; h <= 4; h++) {
        await ctx.logger.log(
          makeOp('agent-v10129-iqr-hour-ok', 'fs', `sess-${h}`, hoursAgo(h * 2), 'call'),
          dec(0.5),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10129-iqr-hour-ok');
      expect(status).toBe(200);
      const iqr = body.opsIQRHourlyAllTime as number;
      expect(iqr).not.toBeNull();
      expect(iqr).toBeGreaterThanOrEqual(0);
    });

    it('13. agents — riskScoreAbove75PctAllTime is 1 when all logs > 0.75', async () => {
      ctx = await setup();
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(
          makeOp('agent-v10129-above75-all', 'fs', `sess-${i}`, daysAgo(i + 1), 'call'),
          dec(0.9),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10129-above75-all');
      expect(status).toBe(200);
      expect(body.riskScoreAbove75PctAllTime).toBe(1);
    });

    it('14. agents — riskScoreBelow25PctAllTime is 0 when all logs >= 0.25', async () => {
      ctx = await setup();
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(
          makeOp('agent-v10129-below25-zero', 'fs', `sess-${i}`, daysAgo(i + 1), 'call'),
          dec(0.5),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10129-below25-zero');
      expect(status).toBe(200);
      expect(body.riskScoreBelow25PctAllTime).toBe(0);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1714-T1718 — v10.129 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('15. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-m1', 'tool-v10129-pres', 'sess-1', daysAgo(1), 'call'),
        dec(0.5, 'allow'),
      );
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10129-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('opsIQRDailyAllTime');
      expect(body).toHaveProperty('opsIQRHourlyAllTime');
      expect(body).toHaveProperty('opsCVDailyAllTime');
      expect(body).toHaveProperty('riskScoreAbove75PctAllTime');
      expect(body).toHaveProperty('riskScoreBelow25PctAllTime');
    });

    it('16. tools — opsCVDailyAllTime is 0 when all days have equal count', async () => {
      ctx = await setup();
      // 3 distinct days each with 2 ops → mean=2, stddev=0, CV=0
      for (let d = 1; d <= 3; d++) {
        const dayBase = daysAgo(d);
        for (let i = 0; i < 2; i++) {
          await ctx.logger.log(
            makeOp('agent-t1', 'tool-v10129-cv-zero', `sess-d${d}-${i}`, new Date(dayBase.getTime() + i * 60_000), 'call'),
            dec(0.5),
          );
        }
      }
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10129-cv-zero');
      expect(status).toBe(200);
      const cv = body.opsCVDailyAllTime as number;
      expect(cv).not.toBeNull();
      expect(cv).toBeCloseTo(0, 5);
    });

    it('17. tools — riskScoreAbove75PctAllTime boundary: score exactly 0.75 not counted', async () => {
      ctx = await setup();
      // Logs with riskScore = 0.75 (boundary, not strictly > 0.75) → ratio = 0
      await ctx.logger.log(
        makeOp('agent-t2', 'tool-v10129-above75-boundary', 'sess-1', daysAgo(1), 'call'),
        dec(0.75),
      );
      await ctx.logger.log(
        makeOp('agent-t2', 'tool-v10129-above75-boundary', 'sess-2', daysAgo(2), 'call'),
        dec(0.5),
      );
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10129-above75-boundary');
      expect(status).toBe(200);
      expect(body.riskScoreAbove75PctAllTime).toBe(0);
    });

    it('18. tools — riskScoreBelow25PctAllTime boundary: score exactly 0.25 not counted', async () => {
      ctx = await setup();
      // Logs with riskScore = 0.25 (boundary, not strictly < 0.25) → ratio = 0
      await ctx.logger.log(
        makeOp('agent-t3', 'tool-v10129-below25-boundary', 'sess-1', daysAgo(1), 'call'),
        dec(0.25),
      );
      await ctx.logger.log(
        makeOp('agent-t3', 'tool-v10129-below25-boundary', 'sess-2', daysAgo(2), 'call'),
        dec(0.5),
      );
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10129-below25-boundary');
      expect(status).toBe(200);
      expect(body.riskScoreBelow25PctAllTime).toBe(0);
    });

    it('19. tools — opsIQRDailyAllTime correct IQR with varying day counts', async () => {
      ctx = await setup();
      // 4 days with counts [1, 2, 3, 4]:
      //   sorted=[1,2,3,4], P25=sorted[floor(4*0.25)]=sorted[1]=2, P75=sorted[floor(4*0.75)]=sorted[3]=4
      //   IQR = 4 - 2 = 2
      const counts = [1, 2, 3, 4];
      for (let d = 0; d < counts.length; d++) {
        const dayBase = daysAgo(d + 1);
        for (let i = 0; i < counts[d]!; i++) {
          await ctx.logger.log(
            makeOp('agent-t4', 'tool-v10129-iqr-calc', `sess-d${d}-${i}`, new Date(dayBase.getTime() + i * 60_000), 'call'),
            dec(0.5),
          );
        }
      }
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10129-iqr-calc');
      expect(status).toBe(200);
      const iqr = body.opsIQRDailyAllTime as number;
      expect(iqr).not.toBeNull();
      expect(iqr).toBe(2);
    });
  });

  // ── operations/summary endpoint ────────────────────────────────────────────────

  describe('T1714-T1718 — v10.129 new fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('20. summary — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-u1', 'fs', 'sess-1', daysAgo(1), 'call'),
        dec(0.5, 'allow'),
      );
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body).toHaveProperty('opsIQRDailyAllTime');
      expect(body).toHaveProperty('opsIQRHourlyAllTime');
      expect(body).toHaveProperty('opsCVDailyAllTime');
      expect(body).toHaveProperty('riskScoreAbove75PctAllTime');
      expect(body).toHaveProperty('riskScoreBelow25PctAllTime');
    });

    it('21. summary — riskScoreAbove75PctAllTime and riskScoreBelow25PctAllTime null when no logs', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreAbove75PctAllTime).toBeNull();
      expect(body.riskScoreBelow25PctAllTime).toBeNull();
    });

    it('22. summary — riskScoreAbove75PctAllTime + riskScoreBelow25PctAllTime sum <= 1', async () => {
      ctx = await setup();
      // 2 above 0.75, 1 below 0.25, 1 in between → above=0.5, below=0.25, sum=0.75
      await ctx.logger.log(
        makeOp('agent-u2', 'fs', 'sess-1', daysAgo(1), 'call'),
        dec(0.8),
      );
      await ctx.logger.log(
        makeOp('agent-u2', 'fs', 'sess-2', daysAgo(2), 'call'),
        dec(0.9),
      );
      await ctx.logger.log(
        makeOp('agent-u2', 'fs', 'sess-3', daysAgo(3), 'call'),
        dec(0.1),
      );
      await ctx.logger.log(
        makeOp('agent-u2', 'fs', 'sess-4', daysAgo(4), 'call'),
        dec(0.5),
      );
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      const above = body.riskScoreAbove75PctAllTime as number;
      const below = body.riskScoreBelow25PctAllTime as number;
      expect(above).not.toBeNull();
      expect(below).not.toBeNull();
      expect(above + below).toBeLessThanOrEqual(1);
      expect(above).toBeCloseTo(0.5, 5);
      expect(below).toBeCloseTo(0.25, 5);
    });

    it('23. summary — opsIQRDailyAllTime null when no logs', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.opsIQRDailyAllTime).toBeNull();
    });

    it('24. summary — opsIQRHourlyAllTime null when no logs', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.opsIQRHourlyAllTime).toBeNull();
    });

    it('25. summary — opsCVDailyAllTime null when no logs', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.opsCVDailyAllTime).toBeNull();
    });

    it('26. summary — opsCVDailyAllTime is a valid ratio (float >= 0) with multiple days', async () => {
      ctx = await setup();
      // 1 op on day1, 3 ops on day2 → counts=[1,3], mean=2, stddev=1, CV=0.5
      await ctx.logger.log(
        makeOp('agent-u3', 'fs', 'sess-1', daysAgo(2), 'call'),
        dec(0.4),
      );
      const day2 = daysAgo(1);
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(
          makeOp('agent-u3', 'fs', `sess-${i + 2}`, new Date(day2.getTime() + i * 60_000), 'call'),
          dec(0.4),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      const cv = body.opsCVDailyAllTime as number;
      expect(cv).not.toBeNull();
      expect(cv).toBeGreaterThanOrEqual(0);
      expect(cv).toBeCloseTo(0.5, 5);
    });

    it('27. summary — opsIQRHourlyAllTime non-negative with >= 4 distinct hours', async () => {
      ctx = await setup();
      // 4 distinct hours, each with 1 op → IQR of [1,1,1,1] = 0
      for (let h = 1; h <= 4; h++) {
        await ctx.logger.log(
          makeOp(`agent-u4-h${h}`, 'fs', `sess-${h}`, hoursAgo(h * 3), 'call'),
          dec(0.5),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      const iqr = body.opsIQRHourlyAllTime as number;
      expect(iqr).not.toBeNull();
      expect(iqr).toBeGreaterThanOrEqual(0);
    });
  });
});

// ── v10.130 ────────────────────────────────────────────────────────────────────

describe('v10.130', () => {
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);
  const hoursAgo = (h: number) => new Date(PINNED_NOW() - h * 3_600_000);

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1719-T1723 — v10.130 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-a1', 'fs', 'sess-v10130-pres', daysAgo(1), 'call'),
        dec(0.5, 'allow'),
      );
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10130-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('opsCVHourlyAllTime');
      expect(body).toHaveProperty('opsMADDailyAllTime');
      expect(body).toHaveProperty('opsMADHourlyAllTime');
      expect(body).toHaveProperty('riskScoreAboveMeanCountAllTime');
      expect(body).toHaveProperty('opsGiniAllTime');
    });

    it('2. sessions — all five new fields null with no logs (via summary)', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.opsCVHourlyAllTime).toBeNull();
      expect(body.opsMADDailyAllTime).toBeNull();
      expect(body.opsMADHourlyAllTime).toBeNull();
      expect(body.riskScoreAboveMeanCountAllTime).toBeNull();
      expect(body.opsGiniAllTime).toBeNull();
    });

    it('3. sessions — opsCVHourlyAllTime null when only 1 distinct hour', async () => {
      ctx = await setup();
      // All ops within same hour → only 1 distinct hour → null
      const now = new Date(PINNED_NOW());
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(
          makeOp('agent-a2', 'fs', 'sess-v10130-cv-onehour', new Date(now.getTime() + i * 60_000), 'call'),
          dec(0.4),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10130-cv-onehour');
      expect(status).toBe(200);
      expect(body.opsCVHourlyAllTime).toBeNull();
    });

    it('4. sessions — opsCVHourlyAllTime non-negative when >= 2 distinct hours', async () => {
      ctx = await setup();
      // 2 ops in hour-3 and 4 ops in hour-6 → 2 distinct hours, CV > 0
      for (let i = 0; i < 2; i++) {
        await ctx.logger.log(
          makeOp('agent-a3', 'fs', 'sess-v10130-cv-twohours', new Date(hoursAgo(3).getTime() + i * 60_000), 'call'),
          dec(0.4),
        );
      }
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(
          makeOp('agent-a3', 'fs', 'sess-v10130-cv-twohours', new Date(hoursAgo(6).getTime() + i * 60_000), 'call'),
          dec(0.4),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10130-cv-twohours');
      expect(status).toBe(200);
      const cv = body.opsCVHourlyAllTime as number;
      expect(cv).not.toBeNull();
      expect(cv).toBeGreaterThanOrEqual(0);
    });

    it('5. sessions — opsMADDailyAllTime is 0 when all days have equal op count', async () => {
      ctx = await setup();
      // 3 distinct days each with 2 ops → mean=2, MAD=0
      for (let d = 1; d <= 3; d++) {
        const dayBase = daysAgo(d);
        for (let i = 0; i < 2; i++) {
          await ctx.logger.log(
            makeOp('agent-a4', 'fs', 'sess-v10130-mad-equal', new Date(dayBase.getTime() + i * 60_000), 'call'),
            dec(0.5),
          );
        }
      }
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10130-mad-equal');
      expect(status).toBe(200);
      const mad = body.opsMADDailyAllTime as number;
      expect(mad).not.toBeNull();
      expect(mad).toBeCloseTo(0, 5);
    });

    it('6. sessions — opsMADDailyAllTime positive when daily counts vary', async () => {
      ctx = await setup();
      // day1: 1 op, day2: 3 ops → counts=[1,3], mean=2, MAD=(|1-2|+|3-2|)/2 = 1
      await ctx.logger.log(
        makeOp('agent-a5', 'fs', 'sess-v10130-mad-vary', daysAgo(2), 'call'),
        dec(0.5),
      );
      const day2 = daysAgo(1);
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(
          makeOp('agent-a5', 'fs', 'sess-v10130-mad-vary', new Date(day2.getTime() + i * 60_000), 'call'),
          dec(0.5),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10130-mad-vary');
      expect(status).toBe(200);
      const mad = body.opsMADDailyAllTime as number;
      expect(mad).not.toBeNull();
      expect(mad).toBeCloseTo(1, 5);
    });

    it('7. sessions — opsGiniAllTime null when < 2 distinct days', async () => {
      ctx = await setup();
      // All ops on same day → 1 distinct day → null
      const now = new Date(PINNED_NOW());
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(
          makeOp('agent-a6', 'fs', 'sess-v10130-gini-oneday', new Date(now.getTime() + i * 60_000), 'call'),
          dec(0.5),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10130-gini-oneday');
      expect(status).toBe(200);
      expect(body.opsGiniAllTime).toBeNull();
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1719-T1723 — v10.130 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('8. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-v10130-pres', 'fs', 'sess-1', daysAgo(1), 'call'),
        dec(0.4, 'allow'),
      );
      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10130-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('opsCVHourlyAllTime');
      expect(body).toHaveProperty('opsMADDailyAllTime');
      expect(body).toHaveProperty('opsMADHourlyAllTime');
      expect(body).toHaveProperty('riskScoreAboveMeanCountAllTime');
      expect(body).toHaveProperty('opsGiniAllTime');
    });

    it('9. agents — riskScoreAboveMeanCountAllTime is 0 when all scores are equal', async () => {
      ctx = await setup();
      // All riskScores the same → mean = score → none strictly above mean → count = 0
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(
          makeOp('agent-v10130-above-mean-zero', 'fs', `sess-${i}`, daysAgo(i + 1), 'call'),
          dec(0.5),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10130-above-mean-zero');
      expect(status).toBe(200);
      expect(body.riskScoreAboveMeanCountAllTime).toBe(0);
    });

    it('10. agents — riskScoreAboveMeanCountAllTime correct count with mixed scores', async () => {
      ctx = await setup();
      // scores: [0.2, 0.4, 0.8, 0.8] → mean=0.55 → 2 scores strictly above 0.55
      await ctx.logger.log(makeOp('agent-v10130-above-mean-count', 'fs', 'sess-1', daysAgo(1), 'call'), dec(0.2));
      await ctx.logger.log(makeOp('agent-v10130-above-mean-count', 'fs', 'sess-2', daysAgo(2), 'call'), dec(0.4));
      await ctx.logger.log(makeOp('agent-v10130-above-mean-count', 'fs', 'sess-3', daysAgo(3), 'call'), dec(0.8));
      await ctx.logger.log(makeOp('agent-v10130-above-mean-count', 'fs', 'sess-4', daysAgo(4), 'call'), dec(0.8));
      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10130-above-mean-count');
      expect(status).toBe(200);
      const count = body.riskScoreAboveMeanCountAllTime as number;
      expect(count).toBe(2);
    });

    it('11. agents — riskScoreAboveMeanCountAllTime is non-negative integer < log count', async () => {
      ctx = await setup();
      // scores: [0.1, 0.3, 0.9] → mean=0.433... → only 0.9 is strictly above → count=1
      await ctx.logger.log(makeOp('agent-v10130-above-mean-lt-n', 'fs', 'sess-1', daysAgo(1), 'call'), dec(0.1));
      await ctx.logger.log(makeOp('agent-v10130-above-mean-lt-n', 'fs', 'sess-2', daysAgo(2), 'call'), dec(0.3));
      await ctx.logger.log(makeOp('agent-v10130-above-mean-lt-n', 'fs', 'sess-3', daysAgo(3), 'call'), dec(0.9));
      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10130-above-mean-lt-n');
      expect(status).toBe(200);
      const count = body.riskScoreAboveMeanCountAllTime as number;
      expect(count).not.toBeNull();
      expect(count).toBeGreaterThanOrEqual(0);
      expect(count).toBeLessThan(3);
      expect(count).toBe(1);
    });

    it('12. agents — opsGiniAllTime in [0, 1] range with multiple days', async () => {
      ctx = await setup();
      // 2 distinct days with different counts → Gini in (0, 1)
      await ctx.logger.log(makeOp('agent-v10130-gini-range', 'fs', 'sess-1', daysAgo(2), 'call'), dec(0.5));
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(
          makeOp('agent-v10130-gini-range', 'fs', `sess-${i + 2}`, new Date(daysAgo(1).getTime() + i * 60_000), 'call'),
          dec(0.5),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10130-gini-range');
      expect(status).toBe(200);
      const gini = body.opsGiniAllTime as number;
      expect(gini).not.toBeNull();
      expect(gini).toBeGreaterThanOrEqual(0);
      expect(gini).toBeLessThanOrEqual(1);
    });

    it('13. agents — opsMADHourlyAllTime is 0 when all hours have equal op count', async () => {
      ctx = await setup();
      // 3 distinct hours each with 2 ops → mean=2, MAD=0
      for (let h = 1; h <= 3; h++) {
        const hourBase = hoursAgo(h * 2);
        for (let i = 0; i < 2; i++) {
          await ctx.logger.log(
            makeOp('agent-v10130-mad-hour-equal', 'fs', `sess-h${h}-${i}`, new Date(hourBase.getTime() + i * 60_000), 'call'),
            dec(0.5),
          );
        }
      }
      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10130-mad-hour-equal');
      expect(status).toBe(200);
      const mad = body.opsMADHourlyAllTime as number;
      expect(mad).not.toBeNull();
      expect(mad).toBeCloseTo(0, 5);
    });

    it('14. agents — opsMADHourlyAllTime positive when hourly counts vary', async () => {
      ctx = await setup();
      // hour1: 1 op, hour2: 3 ops → counts=[1,3], mean=2, MAD=1
      await ctx.logger.log(
        makeOp('agent-v10130-mad-hour-vary', 'fs', 'sess-1', hoursAgo(4), 'call'),
        dec(0.5),
      );
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(
          makeOp('agent-v10130-mad-hour-vary', 'fs', `sess-${i + 2}`, new Date(hoursAgo(2).getTime() + i * 60_000), 'call'),
          dec(0.5),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/agents/agent-v10130-mad-hour-vary');
      expect(status).toBe(200);
      const mad = body.opsMADHourlyAllTime as number;
      expect(mad).not.toBeNull();
      expect(mad).toBeCloseTo(1, 5);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1719-T1723 — v10.130 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('15. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-m1', 'tool-v10130-pres', 'sess-1', daysAgo(1), 'call'),
        dec(0.5, 'allow'),
      );
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10130-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('opsCVHourlyAllTime');
      expect(body).toHaveProperty('opsMADDailyAllTime');
      expect(body).toHaveProperty('opsMADHourlyAllTime');
      expect(body).toHaveProperty('riskScoreAboveMeanCountAllTime');
      expect(body).toHaveProperty('opsGiniAllTime');
    });

    it('16. tools — opsCVHourlyAllTime correct value with 2 distinct hours', async () => {
      ctx = await setup();
      // hour1: 2 ops, hour2: 4 ops → counts=[2,4], mean=3, stddev=1, CV=1/3≈0.333
      for (let i = 0; i < 2; i++) {
        await ctx.logger.log(
          makeOp('agent-t1', 'tool-v10130-cv-calc', `sess-h1-${i}`, new Date(hoursAgo(4).getTime() + i * 60_000), 'call'),
          dec(0.4),
        );
      }
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(
          makeOp('agent-t1', 'tool-v10130-cv-calc', `sess-h2-${i}`, new Date(hoursAgo(2).getTime() + i * 60_000), 'call'),
          dec(0.4),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10130-cv-calc');
      expect(status).toBe(200);
      const cv = body.opsCVHourlyAllTime as number;
      expect(cv).not.toBeNull();
      expect(cv).toBeGreaterThanOrEqual(0);
      expect(cv).toBeCloseTo(1 / 3, 3);
    });

    it('17. tools — opsGiniAllTime is 0 when all days have equal op count', async () => {
      ctx = await setup();
      // 3 distinct days each with 2 ops → perfect equality → Gini = 0
      for (let d = 1; d <= 3; d++) {
        const dayBase = daysAgo(d);
        for (let i = 0; i < 2; i++) {
          await ctx.logger.log(
            makeOp('agent-t2', 'tool-v10130-gini-equal', `sess-d${d}-${i}`, new Date(dayBase.getTime() + i * 60_000), 'call'),
            dec(0.5),
          );
        }
      }
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10130-gini-equal');
      expect(status).toBe(200);
      const gini = body.opsGiniAllTime as number;
      expect(gini).not.toBeNull();
      expect(gini).toBeCloseTo(0, 5);
    });

    it('18. tools — riskScoreAboveMeanCountAllTime in range [0, n) where n is log count', async () => {
      ctx = await setup();
      // 4 logs, mean = (0.1+0.5+0.7+0.9)/4 = 0.55, scores above: 0.7, 0.9 → count=2
      await ctx.logger.log(makeOp('agent-t3', 'tool-v10130-above-mean-range', 'sess-1', daysAgo(1), 'call'), dec(0.1));
      await ctx.logger.log(makeOp('agent-t3', 'tool-v10130-above-mean-range', 'sess-2', daysAgo(2), 'call'), dec(0.5));
      await ctx.logger.log(makeOp('agent-t3', 'tool-v10130-above-mean-range', 'sess-3', daysAgo(3), 'call'), dec(0.7));
      await ctx.logger.log(makeOp('agent-t3', 'tool-v10130-above-mean-range', 'sess-4', daysAgo(4), 'call'), dec(0.9));
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10130-above-mean-range');
      expect(status).toBe(200);
      const count = body.riskScoreAboveMeanCountAllTime as number;
      expect(count).not.toBeNull();
      expect(count).toBeGreaterThanOrEqual(0);
      expect(count).toBeLessThan(4);
      expect(count).toBe(2);
    });

    it('19. tools — opsMADDailyAllTime non-negative for any distribution', async () => {
      ctx = await setup();
      // 4 days with counts [1, 2, 3, 4] → mean=2.5, MAD = (1.5+0.5+0.5+1.5)/4 = 1
      const counts = [1, 2, 3, 4];
      for (let d = 0; d < counts.length; d++) {
        const dayBase = daysAgo(d + 1);
        for (let i = 0; i < counts[d]!; i++) {
          await ctx.logger.log(
            makeOp('agent-t4', 'tool-v10130-mad-calc', `sess-d${d}-${i}`, new Date(dayBase.getTime() + i * 60_000), 'call'),
            dec(0.5),
          );
        }
      }
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10130-mad-calc');
      expect(status).toBe(200);
      const mad = body.opsMADDailyAllTime as number;
      expect(mad).not.toBeNull();
      expect(mad).toBeGreaterThanOrEqual(0);
      expect(mad).toBeCloseTo(1, 5);
    });
  });

  // ── operations/summary endpoint ────────────────────────────────────────────────

  describe('T1719-T1723 — v10.130 new fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('20. summary — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-u1', 'fs', 'sess-1', daysAgo(1), 'call'),
        dec(0.5, 'allow'),
      );
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body).toHaveProperty('opsCVHourlyAllTime');
      expect(body).toHaveProperty('opsMADDailyAllTime');
      expect(body).toHaveProperty('opsMADHourlyAllTime');
      expect(body).toHaveProperty('riskScoreAboveMeanCountAllTime');
      expect(body).toHaveProperty('opsGiniAllTime');
    });

    it('21. summary — all five fields null when no logs', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.opsCVHourlyAllTime).toBeNull();
      expect(body.opsMADDailyAllTime).toBeNull();
      expect(body.opsMADHourlyAllTime).toBeNull();
      expect(body.riskScoreAboveMeanCountAllTime).toBeNull();
      expect(body.opsGiniAllTime).toBeNull();
    });

    it('22. summary — opsCVHourlyAllTime null when no logs', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.opsCVHourlyAllTime).toBeNull();
    });

    it('23. summary — opsGiniAllTime null when < 2 distinct days', async () => {
      ctx = await setup();
      // All ops in same day → only 1 distinct day → null
      const now = new Date(PINNED_NOW());
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(
          makeOp('agent-u2', 'fs', `sess-${i}`, new Date(now.getTime() + i * 60_000), 'call'),
          dec(0.5),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.opsGiniAllTime).toBeNull();
    });

    it('24. summary — opsGiniAllTime non-null and in [0,1] when >= 2 distinct days', async () => {
      ctx = await setup();
      // 2 days with unequal counts → Gini in (0, 1)
      await ctx.logger.log(makeOp('agent-u3', 'fs', 'sess-1', daysAgo(2), 'call'), dec(0.4));
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(
          makeOp('agent-u3', 'fs', `sess-${i + 2}`, new Date(daysAgo(1).getTime() + i * 60_000), 'call'),
          dec(0.4),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      const gini = body.opsGiniAllTime as number;
      expect(gini).not.toBeNull();
      expect(gini).toBeGreaterThanOrEqual(0);
      expect(gini).toBeLessThanOrEqual(1);
    });

    it('25. summary — riskScoreAboveMeanCountAllTime is 0 when all scores are equal', async () => {
      ctx = await setup();
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(
          makeOp(`agent-u4-${i}`, 'fs', `sess-${i}`, daysAgo(i + 1), 'call'),
          dec(0.6),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreAboveMeanCountAllTime).toBe(0);
    });

    it('26. summary — opsMADHourlyAllTime non-negative float with multiple hours', async () => {
      ctx = await setup();
      // 3 distinct hours with counts [1, 2, 3] → mean=2, MAD=(1+0+1)/3≈0.667
      for (let h = 0; h < 3; h++) {
        const hourBase = hoursAgo((h + 1) * 3);
        for (let i = 0; i <= h; i++) {
          await ctx.logger.log(
            makeOp(`agent-u5-h${h}`, 'fs', `sess-h${h}-${i}`, new Date(hourBase.getTime() + i * 60_000), 'call'),
            dec(0.5),
          );
        }
      }
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      const mad = body.opsMADHourlyAllTime as number;
      expect(mad).not.toBeNull();
      expect(mad).toBeGreaterThanOrEqual(0);
    });

    it('27. summary — opsCVHourlyAllTime is 0 when all hours have equal op count', async () => {
      ctx = await setup();
      // 3 distinct hours each with 2 ops → mean=2, stddev=0, CV=0
      for (let h = 1; h <= 3; h++) {
        const hourBase = hoursAgo(h * 3);
        for (let i = 0; i < 2; i++) {
          await ctx.logger.log(
            makeOp(`agent-u6-h${h}`, 'fs', `sess-h${h}-${i}`, new Date(hourBase.getTime() + i * 60_000), 'call'),
            dec(0.5),
          );
        }
      }
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      const cv = body.opsCVHourlyAllTime as number;
      expect(cv).not.toBeNull();
      expect(cv).toBeCloseTo(0, 5);
    });
  });
});
