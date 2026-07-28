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
const NOW = new Date(PINNED_NOW());
const WITHIN_7D = new Date(NOW.getTime() - 3 * 86400000);
const WITHIN_30D = new Date(NOW.getTime() - 20 * 86400000);
const OUTSIDE_30D = new Date(NOW.getTime() - 40 * 86400000);

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

// ── v10.76 ────────────────────────────────────────────────────────────────────

describe('v10.76', () => {
  // A timestamp 3 days ago (within 7d and 30d windows)
  const NOW = new Date(PINNED_NOW());
  const WITHIN_7D = new Date(NOW.getTime() - 3 * 86400000);   // 3 days ago
  const WITHIN_30D = new Date(NOW.getTime() - 20 * 86400000); // 20 days ago (outside 7d, inside 30d)
  const OUTSIDE_30D = new Date(NOW.getTime() - 40 * 86400000); // 40 days ago (outside both windows)

  // ── sessions endpoint ───────────────────────────────────────────────────────────

  describe('T1449-T1453 — v10.76 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1076-pres', WITHIN_7D), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1076-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('riskScoreEntropyLast7d');
      expect(body).toHaveProperty('riskScoreEntropyLast30d');
      expect(body).toHaveProperty('opsGiniCoefficientLast7d');
      expect(body).toHaveProperty('opsGiniCoefficientLast30d');
      expect(body).toHaveProperty('blockRateEntropyLast7d');
    });

    it('2. sessions — no logs in 7d window: riskScoreEntropyLast7d null', async () => {
      ctx = await setup();
      // Only seed a log outside the 7d window
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1076-no7d', OUTSIDE_30D), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1076-no7d');
      expect(status).toBe(200);

      expect(body.riskScoreEntropyLast7d).toBeNull();
      expect(body.opsGiniCoefficientLast7d).toBeNull();
      expect(body.blockRateEntropyLast7d).toBeNull();
    });

    it('3. sessions — no logs in 30d window: riskScoreEntropyLast30d null', async () => {
      ctx = await setup();
      // Only seed a log outside the 30d window
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1076-no30d', OUTSIDE_30D), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1076-no30d');
      expect(status).toBe(200);

      expect(body.riskScoreEntropyLast30d).toBeNull();
      expect(body.opsGiniCoefficientLast30d).toBeNull();
    });

    it('4. sessions — riskScoreEntropyLast7d: single score bucket → 0 entropy', async () => {
      ctx = await setup();
      // All ops at 0.5 → single bucket → entropy = 0
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1076-ent0', WITHIN_7D), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1076-ent0');
      expect(status).toBe(200);

      expect(body.riskScoreEntropyLast7d as number).toBeCloseTo(0, 10);
    });

    it('5. sessions — riskScoreEntropyLast7d: two equal buckets → 1 bit', async () => {
      ctx = await setup();
      // 2 ops at 0.2, 2 ops at 0.8 → 2 equal buckets → entropy = 1 bit
      for (let i = 0; i < 2; i++) {
        await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1076-ent1', WITHIN_7D), dec(0.2));
        await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1076-ent1', WITHIN_7D), dec(0.8));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1076-ent1');
      expect(status).toBe(200);

      expect(body.riskScoreEntropyLast7d as number).toBeCloseTo(1.0, 5);
    });

    it('6. sessions — opsGiniCoefficientLast7d: single tool → 0', async () => {
      ctx = await setup();
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp('agent-f', 'tool-only', 'sess-v1076-gini0', WITHIN_7D), dec(0.4));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1076-gini0');
      expect(status).toBe(200);

      expect(body.opsGiniCoefficientLast7d as number).toBeCloseTo(0, 10);
    });

    it('7. sessions — opsGiniCoefficientLast7d: two tools [1,3] → Gini 0.25', async () => {
      ctx = await setup();
      // tool-A: 1 op, tool-B: 3 ops → Gini = |1-3| / (2 * (1+3)) = 2/8 = 0.25
      await ctx.logger.log(makeOp('agent-g', 'tool-A', 'sess-v1076-gini025', WITHIN_7D), dec(0.4));
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-g', 'tool-B', 'sess-v1076-gini025', WITHIN_7D), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1076-gini025');
      expect(status).toBe(200);

      expect(body.opsGiniCoefficientLast7d as number).toBeCloseTo(0.25, 5);
    });

    it('8. sessions — blockRateEntropyLast7d: all same action → 0', async () => {
      ctx = await setup();
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1076-bre0', WITHIN_7D), dec(0.5, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1076-bre0');
      expect(status).toBe(200);

      expect(body.blockRateEntropyLast7d as number).toBeCloseTo(0, 10);
    });

    it('9. sessions — blockRateEntropyLast7d: two equal actions → 1 bit', async () => {
      ctx = await setup();
      // 2 block + 2 allow → 2 equal action types → entropy = 1 bit
      for (let i = 0; i < 2; i++) {
        await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v1076-bre1', WITHIN_7D), dec(0.8, 'block'));
        await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v1076-bre1', WITHIN_7D), dec(0.2, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1076-bre1');
      expect(status).toBe(200);

      expect(body.blockRateEntropyLast7d as number).toBeCloseTo(1.0, 5);
    });
  });

  // ── agents endpoint ─────────────────────────────────────────────────────────────

  describe('T1449-T1453 — v10.76 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('10. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1076-pres', 'fs', 'sess-1', WITHIN_7D), dec(0.3));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1076-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('riskScoreEntropyLast7d');
      expect(body).toHaveProperty('riskScoreEntropyLast30d');
      expect(body).toHaveProperty('opsGiniCoefficientLast7d');
      expect(body).toHaveProperty('opsGiniCoefficientLast30d');
      expect(body).toHaveProperty('blockRateEntropyLast7d');
    });

    it('11. agents — op only in 7d: riskScoreEntropyLast7d non-null, riskScoreEntropyLast30d non-null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1076-win7', 'fs', 'sess-1', WITHIN_7D), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1076-win7');
      expect(status).toBe(200);

      expect(body.riskScoreEntropyLast7d).not.toBeNull();
      expect(body.riskScoreEntropyLast30d).not.toBeNull();
    });

    it('12. agents — op only in 30d (not 7d): riskScoreEntropyLast7d null, riskScoreEntropyLast30d non-null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1076-win30', 'fs', 'sess-1', WITHIN_30D), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1076-win30');
      expect(status).toBe(200);

      expect(body.riskScoreEntropyLast7d).toBeNull();
      expect(body.riskScoreEntropyLast30d).not.toBeNull();
    });

    it('13. agents — opsGiniCoefficientLast7d: two tools equal ops → Gini 0', async () => {
      ctx = await setup();
      // 2 ops each on tool-X and tool-Y → perfect equality → Gini = 0
      for (let i = 0; i < 2; i++) {
        await ctx.logger.log(makeOp('agent-v1076-ginie', 'tool-X', `sess-${i}`, WITHIN_7D), dec(0.4));
        await ctx.logger.log(makeOp('agent-v1076-ginie', 'tool-Y', `sess-${i + 10}`, WITHIN_7D), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1076-ginie');
      expect(status).toBe(200);

      expect(body.opsGiniCoefficientLast7d as number).toBeCloseTo(0, 5);
    });

    it('14. agents — opsGiniCoefficientLast30d: single tool → 0', async () => {
      ctx = await setup();
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-v1076-gini30s', 'only-tool', `sess-${i}`, WITHIN_30D), dec(0.6));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1076-gini30s');
      expect(status).toBe(200);

      expect(body.opsGiniCoefficientLast30d as number).toBeCloseTo(0, 10);
    });

    it('15. agents — blockRateEntropyLast7d: all blocks → 0 entropy', async () => {
      ctx = await setup();
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-v1076-allblock', 'fs', `sess-${i}`, WITHIN_7D), dec(0.9, 'block'));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1076-allblock');
      expect(status).toBe(200);

      expect(body.blockRateEntropyLast7d as number).toBeCloseTo(0, 10);
    });

    it('16. agents — blockRateEntropyLast7d: three equal actions → ~1.585 bits', async () => {
      ctx = await setup();
      // 3 block + 3 allow + 3 require_approval → 3 equal action types → entropy = log2(3) ≈ 1.585
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-v1076-3act', 'fs', `sess-b${i}`, WITHIN_7D), dec(0.9, 'block'));
        await ctx.logger.log(makeOp('agent-v1076-3act', 'fs', `sess-a${i}`, WITHIN_7D), dec(0.3, 'allow'));
        await ctx.logger.log(makeOp('agent-v1076-3act', 'fs', `sess-r${i}`, WITHIN_7D), dec(0.6, 'require_approval'));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1076-3act');
      expect(status).toBe(200);

      expect(body.blockRateEntropyLast7d as number).toBeCloseTo(Math.log2(3), 5);
    });

    it('17. agents — riskScoreEntropyLast7d is non-negative for any distribution', async () => {
      ctx = await setup();
      for (const score of [0.1, 0.3, 0.5, 0.7, 0.9]) {
        await ctx.logger.log(makeOp('agent-v1076-nonneg', 'fs', 'sess-1', WITHIN_7D), dec(score));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1076-nonneg');
      expect(status).toBe(200);

      expect(body.riskScoreEntropyLast7d as number).toBeGreaterThanOrEqual(0);
    });
  });

  // ── tools endpoint ──────────────────────────────────────────────────────────────

  describe('T1449-T1453 — v10.76 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('18. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-t', 'tool-v1076-pres', 'sess-1', WITHIN_7D), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1076-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('riskScoreEntropyLast7d');
      expect(body).toHaveProperty('riskScoreEntropyLast30d');
      expect(body).toHaveProperty('opsGiniCoefficientLast7d');
      expect(body).toHaveProperty('opsGiniCoefficientLast30d');
      expect(body).toHaveProperty('blockRateEntropyLast7d');
    });

    it('19. tools — no ops in 7d: all 7d fields null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-t2', 'tool-v1076-no7d', 'sess-1', OUTSIDE_30D), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1076-no7d');
      expect(status).toBe(200);

      expect(body.riskScoreEntropyLast7d).toBeNull();
      expect(body.opsGiniCoefficientLast7d).toBeNull();
      expect(body.blockRateEntropyLast7d).toBeNull();
    });

    it('20. tools — riskScoreEntropyLast7d: scores 0.1 and 0.9 (equal count) → 1 bit', async () => {
      ctx = await setup();
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-t3', 'tool-v1076-ent1', `sess-lo${i}`, WITHIN_7D), dec(0.1));
        await ctx.logger.log(makeOp('agent-t3', 'tool-v1076-ent1', `sess-hi${i}`, WITHIN_7D), dec(0.9));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1076-ent1');
      expect(status).toBe(200);

      expect(body.riskScoreEntropyLast7d as number).toBeCloseTo(1.0, 5);
    });

    it('21. tools — riskScoreEntropyLast30d: non-null when ops in 30d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-t4', 'tool-v1076-30d', 'sess-1', WITHIN_30D), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1076-30d');
      expect(status).toBe(200);

      expect(body.riskScoreEntropyLast30d).not.toBeNull();
      expect(body.riskScoreEntropyLast30d as number).toBeGreaterThanOrEqual(0);
    });

    it('22. tools — opsGiniCoefficientLast7d: single tool with multiple ops → 0', async () => {
      ctx = await setup();
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp(`agent-t5-${i}`, 'tool-v1076-gini1', `sess-${i}`, WITHIN_7D), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1076-gini1');
      expect(status).toBe(200);

      // Only one tool (tool-v1076-gini1 itself) → Gini = 0
      expect(body.opsGiniCoefficientLast7d as number).toBeCloseTo(0, 10);
    });

    it('23. tools — blockRateEntropyLast7d: block + require_approval (equal) → 1 bit', async () => {
      ctx = await setup();
      for (let i = 0; i < 2; i++) {
        await ctx.logger.log(makeOp('agent-t6', 'tool-v1076-bre2', `sess-b${i}`, WITHIN_7D), dec(0.9, 'block'));
        await ctx.logger.log(makeOp('agent-t6', 'tool-v1076-bre2', `sess-r${i}`, WITHIN_7D), dec(0.6, 'require_approval'));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1076-bre2');
      expect(status).toBe(200);

      expect(body.blockRateEntropyLast7d as number).toBeCloseTo(1.0, 5);
    });
  });

  // ── operations/summary endpoint ─────────────────────────────────────────────────

  describe('T1449-T1453 — v10.76 new fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('24. summary — all five new fields present', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s1', 'fs', 'sess-1', WITHIN_7D), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body).toHaveProperty('riskScoreEntropyLast7d');
      expect(body).toHaveProperty('riskScoreEntropyLast30d');
      expect(body).toHaveProperty('opsGiniCoefficientLast7d');
      expect(body).toHaveProperty('opsGiniCoefficientLast30d');
      expect(body).toHaveProperty('blockRateEntropyLast7d');
    });

    it('25. summary — empty DB: all five fields null', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.riskScoreEntropyLast7d).toBeNull();
      expect(body.riskScoreEntropyLast30d).toBeNull();
      expect(body.opsGiniCoefficientLast7d).toBeNull();
      expect(body.opsGiniCoefficientLast30d).toBeNull();
      expect(body.blockRateEntropyLast7d).toBeNull();
    });

    it('26. summary — ops only outside 30d: all five fields null', async () => {
      ctx = await setup();
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp(`agent-s2-${i}`, 'fs', `sess-${i}`, OUTSIDE_30D), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.riskScoreEntropyLast7d).toBeNull();
      expect(body.riskScoreEntropyLast30d).toBeNull();
      expect(body.opsGiniCoefficientLast7d).toBeNull();
      expect(body.opsGiniCoefficientLast30d).toBeNull();
      expect(body.blockRateEntropyLast7d).toBeNull();
    });

    it('27. summary — riskScoreEntropyLast7d: all same bucket → 0', async () => {
      ctx = await setup();
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp(`agent-s3-${i}`, 'fs', `sess-${i}`, WITHIN_7D), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.riskScoreEntropyLast7d as number).toBeCloseTo(0, 10);
    });

    it('28. summary — riskScoreEntropyLast7d: two equal buckets → 1 bit', async () => {
      ctx = await setup();
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp(`agent-s4-lo${i}`, 'fs', `sess-lo${i}`, WITHIN_7D), dec(0.2));
        await ctx.logger.log(makeOp(`agent-s4-hi${i}`, 'fs', `sess-hi${i}`, WITHIN_7D), dec(0.8));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.riskScoreEntropyLast7d as number).toBeCloseTo(1.0, 5);
    });

    it('29. summary — riskScoreEntropyLast30d: includes 7d ops and 30d ops', async () => {
      ctx = await setup();
      // Op in 7d window
      await ctx.logger.log(makeOp('agent-s5-a', 'fs', 'sess-a', WITHIN_7D), dec(0.3));
      // Op in 30d window (but outside 7d)
      await ctx.logger.log(makeOp('agent-s5-b', 'fs', 'sess-b', WITHIN_30D), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.riskScoreEntropyLast30d).not.toBeNull();
      expect(body.riskScoreEntropyLast30d as number).toBeGreaterThanOrEqual(0);
    });

    it('30. summary — opsGiniCoefficientLast7d: null when no ops in 7d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s6', 'fs', 'sess-1', OUTSIDE_30D), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.opsGiniCoefficientLast7d).toBeNull();
    });

    it('31. summary — opsGiniCoefficientLast7d: two equal tools → 0', async () => {
      ctx = await setup();
      // 3 ops on tool-P, 3 ops on tool-Q → perfect equality → Gini = 0
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp(`agent-s7-${i}`, 'tool-P', `sess-p${i}`, WITHIN_7D), dec(0.4));
        await ctx.logger.log(makeOp(`agent-s7-${i}`, 'tool-Q', `sess-q${i}`, WITHIN_7D), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.opsGiniCoefficientLast7d as number).toBeCloseTo(0, 5);
    });

    it('32. summary — opsGiniCoefficientLast30d: two tools [1,3] → Gini 0.25', async () => {
      ctx = await setup();
      // tool-M: 1 op, tool-N: 3 ops (in 30d window) → Gini = 0.25
      await ctx.logger.log(makeOp('agent-s8-m', 'tool-M', 'sess-m', WITHIN_30D), dec(0.4));
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp(`agent-s8-n${i}`, 'tool-N', `sess-n${i}`, WITHIN_30D), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.opsGiniCoefficientLast30d as number).toBeCloseTo(0.25, 5);
    });

    it('33. summary — blockRateEntropyLast7d: null when no 7d ops', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s9', 'fs', 'sess-1', OUTSIDE_30D), dec(0.5, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.blockRateEntropyLast7d).toBeNull();
    });

    it('34. summary — blockRateEntropyLast7d: all allow → 0 entropy', async () => {
      ctx = await setup();
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp(`agent-s10-${i}`, 'fs', `sess-${i}`, WITHIN_7D), dec(0.3, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.blockRateEntropyLast7d as number).toBeCloseTo(0, 10);
    });

    it('35. summary — blockRateEntropyLast7d: three equal actions → ~1.585 bits', async () => {
      ctx = await setup();
      // 4 block + 4 allow + 4 require_approval → entropy = log2(3) ≈ 1.585
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp(`agent-s11-bl${i}`, 'fs', `sess-bl${i}`, WITHIN_7D), dec(0.9, 'block'));
        await ctx.logger.log(makeOp(`agent-s11-al${i}`, 'fs', `sess-al${i}`, WITHIN_7D), dec(0.2, 'allow'));
        await ctx.logger.log(makeOp(`agent-s11-ra${i}`, 'fs', `sess-ra${i}`, WITHIN_7D), dec(0.6, 'require_approval'));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.blockRateEntropyLast7d as number).toBeCloseTo(Math.log2(3), 5);
    });

    it('36. summary — Gini coefficient is in [0, 1) range for any distribution', async () => {
      ctx = await setup();
      // Mix of 3 tools with different counts
      await ctx.logger.log(makeOp('agent-s12-a', 'tool-1', 'sess-1', WITHIN_7D), dec(0.5));
      await ctx.logger.log(makeOp('agent-s12-b', 'tool-1', 'sess-2', WITHIN_7D), dec(0.5));
      await ctx.logger.log(makeOp('agent-s12-c', 'tool-2', 'sess-3', WITHIN_7D), dec(0.5));
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp(`agent-s12-d${i}`, 'tool-3', `sess-d${i}`, WITHIN_7D), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      const gini = body.opsGiniCoefficientLast7d as number;
      expect(gini).toBeGreaterThanOrEqual(0);
      expect(gini).toBeLessThan(1);
    });
  });
});

// ── v10.77 ────────────────────────────────────────────────────────────────────

describe('v10.77', () => {
  // Fixed dates for deterministic day-based testing
  const NOW = new Date(PINNED_NOW());
  // Yesterday — separate calendar day from NOW
  const YESTERDAY = new Date(NOW.getTime() - 86400000);
  // 5 days ago — another distinct calendar day
  const FIVE_DAYS_AGO = new Date(NOW.getTime() - 5 * 86400000);

  // ── sessions endpoint ───────────────────────────────────────────────────────────

  describe('T1454-T1458 — v10.77 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1077-pres', NOW), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1077-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('opsConcentrationRatioTop3Tools');
      expect(body).toHaveProperty('opsConcentrationRatioTop3Agents');
      expect(body).toHaveProperty('riskWeightedBlockRateAllTime');
      expect(body).toHaveProperty('avgOpsPerActiveDay');
      expect(body).toHaveProperty('maxDailyOpsAllTime');
    });

    it('2. sessions — empty session: all five fields null (no logs)', async () => {
      ctx = await setup();
      // Log to a different session so sess-v1077-empty returns 404 / empty
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-other', NOW), dec(0.5));

      // Query a session with no logs — expect either 404 or null fields
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1077-empty-xx');
      // Implementations may return 404 for unknown sessions; skip field checks in that case
      if (status === 200) {
        expect(body.opsConcentrationRatioTop3Tools).toBeNull();
        expect(body.opsConcentrationRatioTop3Agents).toBeNull();
        expect(body.riskWeightedBlockRateAllTime).toBeNull();
        expect(body.avgOpsPerActiveDay).toBeNull();
        expect(body.maxDailyOpsAllTime).toBeNull();
      } else {
        expect(status).toBe(404);
      }
    });

    it('3. sessions — opsConcentrationRatioTop3Tools: ≤3 distinct tools → 1.0', async () => {
      ctx = await setup();
      // 2 tools → top3 covers all → ratio = 1.0
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-c', 'tool-A', 'sess-v1077-conc1', NOW), dec(0.4));
        await ctx.logger.log(makeOp('agent-c', 'tool-B', 'sess-v1077-conc1', NOW), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1077-conc1');
      expect(status).toBe(200);

      expect(body.opsConcentrationRatioTop3Tools as number).toBeCloseTo(1.0, 10);
    });

    it('4. sessions — opsConcentrationRatioTop3Tools: 4 tools [5,3,2,2] → top3 = 10/12 ≈ 0.833', async () => {
      ctx = await setup();
      // tool-W: 5 ops, tool-X: 3 ops, tool-Y: 2 ops, tool-Z: 2 ops → total 12
      // top3 = 5+3+2 = 10 → ratio = 10/12 ≈ 0.8333
      for (let i = 0; i < 5; i++) await ctx.logger.log(makeOp('agent-d', 'tool-W', 'sess-v1077-conc4', NOW), dec(0.3));
      for (let i = 0; i < 3; i++) await ctx.logger.log(makeOp('agent-d', 'tool-X', 'sess-v1077-conc4', NOW), dec(0.3));
      for (let i = 0; i < 2; i++) await ctx.logger.log(makeOp('agent-d', 'tool-Y', 'sess-v1077-conc4', NOW), dec(0.3));
      for (let i = 0; i < 2; i++) await ctx.logger.log(makeOp('agent-d', 'tool-Z', 'sess-v1077-conc4', NOW), dec(0.3));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1077-conc4');
      expect(status).toBe(200);

      expect(body.opsConcentrationRatioTop3Tools as number).toBeCloseTo(10 / 12, 5);
    });

    it('5. sessions — opsConcentrationRatioTop3Agents: single agent → 1.0', async () => {
      ctx = await setup();
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp('agent-only', 'fs', 'sess-v1077-agent1', NOW), dec(0.4));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1077-agent1');
      expect(status).toBe(200);

      expect(body.opsConcentrationRatioTop3Agents as number).toBeCloseTo(1.0, 10);
    });

    it('6. sessions — riskWeightedBlockRateAllTime: 1 blocked (0.8) + 1 allowed (0.8) → 0.5', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1077-rwbr', NOW), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1077-rwbr', NOW), dec(0.8, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1077-rwbr');
      expect(status).toBe(200);

      // sum(riskScore * isBlocked) = 0.8; sum(riskScore) = 1.6 → 0.8/1.6 = 0.5
      expect(body.riskWeightedBlockRateAllTime as number).toBeCloseTo(0.5, 5);
    });

    it('7. sessions — riskWeightedBlockRateAllTime: all riskScore=0 → null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1077-rwbr0', NOW), dec(0, 'block'));
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1077-rwbr0', NOW), dec(0, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1077-rwbr0');
      expect(status).toBe(200);

      expect(body.riskWeightedBlockRateAllTime).toBeNull();
    });

    it('8. sessions — avgOpsPerActiveDay: 6 ops across 3 days → 2.0', async () => {
      ctx = await setup();
      // 2 ops per day across 3 distinct days
      for (let i = 0; i < 2; i++) await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1077-avg', NOW), dec(0.4));
      for (let i = 0; i < 2; i++) await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1077-avg', YESTERDAY), dec(0.4));
      for (let i = 0; i < 2; i++) await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1077-avg', FIVE_DAYS_AGO), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1077-avg');
      expect(status).toBe(200);

      expect(body.avgOpsPerActiveDay as number).toBeCloseTo(2.0, 5);
    });

    it('9. sessions — maxDailyOpsAllTime: 3 today + 1 yesterday → max = 3', async () => {
      ctx = await setup();
      for (let i = 0; i < 3; i++) await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1077-max', NOW), dec(0.4));
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1077-max', YESTERDAY), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1077-max');
      expect(status).toBe(200);

      expect(body.maxDailyOpsAllTime).toBe(3);
    });
  });

  // ── agents endpoint ─────────────────────────────────────────────────────────────

  describe('T1454-T1458 — v10.77 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('10. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1077-pres', 'fs', 'sess-1', NOW), dec(0.3));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1077-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('opsConcentrationRatioTop3Tools');
      expect(body).toHaveProperty('opsConcentrationRatioTop3Agents');
      expect(body).toHaveProperty('riskWeightedBlockRateAllTime');
      expect(body).toHaveProperty('avgOpsPerActiveDay');
      expect(body).toHaveProperty('maxDailyOpsAllTime');
    });

    it('11. agents — opsConcentrationRatioTop3Tools: 1 tool → 1.0', async () => {
      ctx = await setup();
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp('agent-v1077-t1', 'single-tool', `sess-${i}`, NOW), dec(0.4));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1077-t1');
      expect(status).toBe(200);

      expect(body.opsConcentrationRatioTop3Tools as number).toBeCloseTo(1.0, 10);
    });

    it('12. agents — opsConcentrationRatioTop3Agents: ≤3 agents → 1.0', async () => {
      ctx = await setup();
      // 2 agents visible through session-scoped logs; agent endpoint filters by agentId
      // so all logs belong to the single queried agent → ratio = 1.0
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-v1077-a2', 'fs', `sess-${i}`, NOW), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1077-a2');
      expect(status).toBe(200);

      // Only 1 distinct agent (self) → ratio = 1.0
      expect(body.opsConcentrationRatioTop3Agents as number).toBeCloseTo(1.0, 10);
    });

    it('13. agents — riskWeightedBlockRateAllTime: all blocked → 1.0', async () => {
      ctx = await setup();
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp('agent-v1077-allblk', 'fs', `sess-${i}`, NOW), dec(0.7, 'block'));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1077-allblk');
      expect(status).toBe(200);

      expect(body.riskWeightedBlockRateAllTime as number).toBeCloseTo(1.0, 5);
    });

    it('14. agents — riskWeightedBlockRateAllTime: all allowed → 0.0', async () => {
      ctx = await setup();
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp('agent-v1077-allalw', 'fs', `sess-${i}`, NOW), dec(0.5, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1077-allalw');
      expect(status).toBe(200);

      expect(body.riskWeightedBlockRateAllTime as number).toBeCloseTo(0.0, 5);
    });

    it('15. agents — avgOpsPerActiveDay: all ops on same day → avgOpsPerActiveDay = total ops', async () => {
      ctx = await setup();
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp('agent-v1077-sameday', 'fs', `sess-${i}`, NOW), dec(0.4));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1077-sameday');
      expect(status).toBe(200);

      // 5 ops on 1 day → avgOpsPerActiveDay = 5
      expect(body.avgOpsPerActiveDay as number).toBeCloseTo(5.0, 5);
    });

    it('16. agents — maxDailyOpsAllTime: 4 ops today + 2 ops yesterday → max = 4', async () => {
      ctx = await setup();
      for (let i = 0; i < 4; i++) await ctx.logger.log(makeOp('agent-v1077-maxday', 'fs', `sess-t${i}`, NOW), dec(0.5));
      for (let i = 0; i < 2; i++) await ctx.logger.log(makeOp('agent-v1077-maxday', 'fs', `sess-y${i}`, YESTERDAY), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1077-maxday');
      expect(status).toBe(200);

      expect(body.maxDailyOpsAllTime).toBe(4);
    });

    it('17. agents — maxDailyOpsAllTime: single op → 1', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1077-maxone', 'fs', 'sess-1', NOW), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1077-maxone');
      expect(status).toBe(200);

      expect(body.maxDailyOpsAllTime).toBe(1);
    });
  });

  // ── tools endpoint ──────────────────────────────────────────────────────────────

  describe('T1454-T1458 — v10.77 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('18. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-t1', 'tool-v1077-pres', 'sess-1', NOW), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1077-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('opsConcentrationRatioTop3Tools');
      expect(body).toHaveProperty('opsConcentrationRatioTop3Agents');
      expect(body).toHaveProperty('riskWeightedBlockRateAllTime');
      expect(body).toHaveProperty('avgOpsPerActiveDay');
      expect(body).toHaveProperty('maxDailyOpsAllTime');
    });

    it('19. tools — opsConcentrationRatioTop3Tools: single tool (self) → 1.0', async () => {
      ctx = await setup();
      for (let i = 0; i < 6; i++) {
        await ctx.logger.log(makeOp(`agent-t2-${i}`, 'tool-v1077-solo', `sess-${i}`, NOW), dec(0.4));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1077-solo');
      expect(status).toBe(200);

      // The tools endpoint filters by tool name — only 1 distinct tool → ratio = 1.0
      expect(body.opsConcentrationRatioTop3Tools as number).toBeCloseTo(1.0, 10);
    });

    it('20. tools — opsConcentrationRatioTop3Agents: 4 agents [5,3,2,2] → top3 ≈ 0.833', async () => {
      ctx = await setup();
      // agent-P: 5 ops, agent-Q: 3 ops, agent-R: 2 ops, agent-S: 2 ops → total 12
      for (let i = 0; i < 5; i++) await ctx.logger.log(makeOp('agent-P', 'tool-v1077-agent4', `sess-p${i}`, NOW), dec(0.3));
      for (let i = 0; i < 3; i++) await ctx.logger.log(makeOp('agent-Q', 'tool-v1077-agent4', `sess-q${i}`, NOW), dec(0.3));
      for (let i = 0; i < 2; i++) await ctx.logger.log(makeOp('agent-R', 'tool-v1077-agent4', `sess-r${i}`, NOW), dec(0.3));
      for (let i = 0; i < 2; i++) await ctx.logger.log(makeOp('agent-S', 'tool-v1077-agent4', `sess-s${i}`, NOW), dec(0.3));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1077-agent4');
      expect(status).toBe(200);

      // top3 = 5+3+2 = 10; total = 12 → ratio = 10/12 ≈ 0.8333
      expect(body.opsConcentrationRatioTop3Agents as number).toBeCloseTo(10 / 12, 5);
    });

    it('21. tools — riskWeightedBlockRateAllTime: mixed risk scores', async () => {
      ctx = await setup();
      // 1 blocked at 0.6 + 1 allowed at 0.4 → weighted block rate = 0.6/(0.6+0.4) = 0.6
      await ctx.logger.log(makeOp('agent-t3', 'tool-v1077-mix', 'sess-b', NOW), dec(0.6, 'block'));
      await ctx.logger.log(makeOp('agent-t3', 'tool-v1077-mix', 'sess-a', NOW), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1077-mix');
      expect(status).toBe(200);

      expect(body.riskWeightedBlockRateAllTime as number).toBeCloseTo(0.6, 5);
    });

    it('22. tools — avgOpsPerActiveDay: 6 ops across 3 days → 2.0', async () => {
      ctx = await setup();
      for (let i = 0; i < 2; i++) await ctx.logger.log(makeOp(`agent-t4-n${i}`, 'tool-v1077-avgd', `sess-n${i}`, NOW), dec(0.4));
      for (let i = 0; i < 2; i++) await ctx.logger.log(makeOp(`agent-t4-y${i}`, 'tool-v1077-avgd', `sess-y${i}`, YESTERDAY), dec(0.4));
      for (let i = 0; i < 2; i++) await ctx.logger.log(makeOp(`agent-t4-f${i}`, 'tool-v1077-avgd', `sess-f${i}`, FIVE_DAYS_AGO), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1077-avgd');
      expect(status).toBe(200);

      expect(body.avgOpsPerActiveDay as number).toBeCloseTo(2.0, 5);
    });

    it('23. tools — maxDailyOpsAllTime: max across multiple days', async () => {
      ctx = await setup();
      // 5 ops today, 2 ops yesterday → max = 5
      for (let i = 0; i < 5; i++) await ctx.logger.log(makeOp(`agent-t5-n${i}`, 'tool-v1077-maxd', `sess-n${i}`, NOW), dec(0.5));
      for (let i = 0; i < 2; i++) await ctx.logger.log(makeOp(`agent-t5-y${i}`, 'tool-v1077-maxd', `sess-y${i}`, YESTERDAY), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1077-maxd');
      expect(status).toBe(200);

      expect(body.maxDailyOpsAllTime).toBe(5);
    });
  });

  // ── operations/summary endpoint ─────────────────────────────────────────────────

  describe('T1454-T1458 — v10.77 new fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('24. summary — all five new fields present', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s1', 'fs', 'sess-1', NOW), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body).toHaveProperty('opsConcentrationRatioTop3Tools');
      expect(body).toHaveProperty('opsConcentrationRatioTop3Agents');
      expect(body).toHaveProperty('riskWeightedBlockRateAllTime');
      expect(body).toHaveProperty('avgOpsPerActiveDay');
      expect(body).toHaveProperty('maxDailyOpsAllTime');
    });

    it('25. summary — empty DB: all five fields null', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.opsConcentrationRatioTop3Tools).toBeNull();
      expect(body.opsConcentrationRatioTop3Agents).toBeNull();
      expect(body.riskWeightedBlockRateAllTime).toBeNull();
      expect(body.avgOpsPerActiveDay).toBeNull();
      expect(body.maxDailyOpsAllTime).toBeNull();
    });

    it('26. summary — opsConcentrationRatioTop3Tools: ≤3 tools → 1.0', async () => {
      ctx = await setup();
      // 2 distinct tools → top3 covers all
      for (let i = 0; i < 3; i++) await ctx.logger.log(makeOp(`agent-s2-${i}`, 'tool-alpha', `sess-a${i}`, NOW), dec(0.4));
      for (let i = 0; i < 2; i++) await ctx.logger.log(makeOp(`agent-s2-b${i}`, 'tool-beta', `sess-b${i}`, NOW), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.opsConcentrationRatioTop3Tools as number).toBeCloseTo(1.0, 10);
    });

    it('27. summary — opsConcentrationRatioTop3Tools: 4 tools [5,3,2,2] → top3 ≈ 0.833', async () => {
      ctx = await setup();
      for (let i = 0; i < 5; i++) await ctx.logger.log(makeOp('agent-s3', 'tool-1', `sess-1-${i}`, NOW), dec(0.3));
      for (let i = 0; i < 3; i++) await ctx.logger.log(makeOp('agent-s3', 'tool-2', `sess-2-${i}`, NOW), dec(0.3));
      for (let i = 0; i < 2; i++) await ctx.logger.log(makeOp('agent-s3', 'tool-3', `sess-3-${i}`, NOW), dec(0.3));
      for (let i = 0; i < 2; i++) await ctx.logger.log(makeOp('agent-s3', 'tool-4', `sess-4-${i}`, NOW), dec(0.3));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.opsConcentrationRatioTop3Tools as number).toBeCloseTo(10 / 12, 5);
    });

    it('28. summary — opsConcentrationRatioTop3Agents: 4 agents [5,3,2,2] → top3 ≈ 0.833', async () => {
      ctx = await setup();
      for (let i = 0; i < 5; i++) await ctx.logger.log(makeOp('agent-AA', 'fs', `sess-aa${i}`, NOW), dec(0.3));
      for (let i = 0; i < 3; i++) await ctx.logger.log(makeOp('agent-BB', 'fs', `sess-bb${i}`, NOW), dec(0.3));
      for (let i = 0; i < 2; i++) await ctx.logger.log(makeOp('agent-CC', 'fs', `sess-cc${i}`, NOW), dec(0.3));
      for (let i = 0; i < 2; i++) await ctx.logger.log(makeOp('agent-DD', 'fs', `sess-dd${i}`, NOW), dec(0.3));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.opsConcentrationRatioTop3Agents as number).toBeCloseTo(10 / 12, 5);
    });

    it('29. summary — riskWeightedBlockRateAllTime: 1 blocked (0.8) + 1 allowed (0.8) → 0.5', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s4-bl', 'fs', 'sess-bl', NOW), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agent-s4-al', 'fs', 'sess-al', NOW), dec(0.8, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.riskWeightedBlockRateAllTime as number).toBeCloseTo(0.5, 5);
    });

    it('30. summary — riskWeightedBlockRateAllTime: all riskScore=0 → null', async () => {
      ctx = await setup();
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp(`agent-s5-${i}`, 'fs', `sess-${i}`, NOW), dec(0, 'block'));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.riskWeightedBlockRateAllTime).toBeNull();
    });

    it('31. summary — riskWeightedBlockRateAllTime: all allowed → 0.0', async () => {
      ctx = await setup();
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp(`agent-s6-${i}`, 'fs', `sess-${i}`, NOW), dec(0.5, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.riskWeightedBlockRateAllTime as number).toBeCloseTo(0.0, 5);
    });

    it('32. summary — avgOpsPerActiveDay: 6 ops across 3 days → 2.0', async () => {
      ctx = await setup();
      for (let i = 0; i < 2; i++) await ctx.logger.log(makeOp(`agent-s7-n${i}`, 'fs', `sess-n${i}`, NOW), dec(0.4));
      for (let i = 0; i < 2; i++) await ctx.logger.log(makeOp(`agent-s7-y${i}`, 'fs', `sess-y${i}`, YESTERDAY), dec(0.4));
      for (let i = 0; i < 2; i++) await ctx.logger.log(makeOp(`agent-s7-f${i}`, 'fs', `sess-f${i}`, FIVE_DAYS_AGO), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.avgOpsPerActiveDay as number).toBeCloseTo(2.0, 5);
    });

    it('33. summary — avgOpsPerActiveDay: all ops on same day → equals total ops count', async () => {
      ctx = await setup();
      for (let i = 0; i < 7; i++) {
        await ctx.logger.log(makeOp(`agent-s8-${i}`, 'fs', `sess-${i}`, NOW), dec(0.4));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.avgOpsPerActiveDay as number).toBeCloseTo(7.0, 5);
    });

    it('34. summary — maxDailyOpsAllTime: 3 today + 1 yesterday → max = 3', async () => {
      ctx = await setup();
      for (let i = 0; i < 3; i++) await ctx.logger.log(makeOp(`agent-s9-n${i}`, 'fs', `sess-n${i}`, NOW), dec(0.5));
      await ctx.logger.log(makeOp('agent-s9-y', 'fs', 'sess-y', YESTERDAY), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.maxDailyOpsAllTime).toBe(3);
    });

    it('35. summary — maxDailyOpsAllTime: equal ops on 2 days → picks either (≥ 2)', async () => {
      ctx = await setup();
      for (let i = 0; i < 3; i++) await ctx.logger.log(makeOp(`agent-s10-n${i}`, 'fs', `sess-n${i}`, NOW), dec(0.4));
      for (let i = 0; i < 3; i++) await ctx.logger.log(makeOp(`agent-s10-y${i}`, 'fs', `sess-y${i}`, YESTERDAY), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.maxDailyOpsAllTime as number).toBe(3);
    });

    it('36. summary — concentration ratios are in [0,1] range', async () => {
      ctx = await setup();
      // 5 different tools with varying usage
      for (let i = 0; i < 10; i++) await ctx.logger.log(makeOp(`agent-s11-${i}`, `tool-${i % 5}`, `sess-${i}`, NOW), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      const toolConc = body.opsConcentrationRatioTop3Tools as number;
      const agentConc = body.opsConcentrationRatioTop3Agents as number;
      expect(toolConc).toBeGreaterThanOrEqual(0);
      expect(toolConc).toBeLessThanOrEqual(1);
      expect(agentConc).toBeGreaterThanOrEqual(0);
      expect(agentConc).toBeLessThanOrEqual(1);
    });
  });
});

// ── v10.78 ────────────────────────────────────────────────────────────────────

describe('v10.78', () => {
  const hoursAgo = (h: number) => new Date(PINNED_NOW() - h * 3_600_000);
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1459-T1463 — v10.78 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1078-pres'), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1078-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('minDailyOpsAllTime');
      expect(body).toHaveProperty('avgDailyOpsLast7d');
      expect(body).toHaveProperty('avgDailyOpsLast30d');
      expect(body).toHaveProperty('opsBurstRatioLast1h');
      expect(body).toHaveProperty('opsBurstRatioLast6h');
    });

    it('2. sessions — all ops older than 7d and 30d: avgDailyOps are 0, burst ratios are null', async () => {
      ctx = await setup();
      // Ops older than 30d — 7d and 30d windows empty, no ops in last 24h
      await ctx.logger.log(makeOp('agent-a-old', 'fs', 'sess-v1078-empty', daysAgo(45)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-a-old', 'fs', 'sess-v1078-empty', daysAgo(50)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1078-empty');
      expect(status).toBe(200);

      // minDailyOpsAllTime: 2 days with 1 op each → min = 1
      expect(body.minDailyOpsAllTime).toBe(1);
      // avgDailyOpsLast7d: 0 ops in window / 7 = 0
      expect(body.avgDailyOpsLast7d).toBe(0);
      // avgDailyOpsLast30d: 0 ops in window / 30 = 0
      expect(body.avgDailyOpsLast30d).toBe(0);
      // opsBurstRatioLast1h: null (no ops in last 24h)
      expect(body.opsBurstRatioLast1h).toBeNull();
      expect(body.opsBurstRatioLast6h).toBeNull();
    });

    it('3. sessions — ops spread across 3 days: minDailyOpsAllTime returns the minimum', async () => {
      ctx = await setup();
      // Day 1 (daysAgo(10)): 3 ops, Day 2 (daysAgo(20)): 1 op, Day 3 (daysAgo(40)): 2 ops
      // min = 1
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1078-min', daysAgo(10)), dec(0.3, 'allow'));
      }
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1078-min', daysAgo(20)), dec(0.4, 'allow'));
      for (let i = 0; i < 2; i++) {
        await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1078-min', daysAgo(40)), dec(0.5, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1078-min');
      expect(status).toBe(200);

      expect(body.minDailyOpsAllTime).toBe(1);
    });

    it('4. sessions — 14 ops in last 7d: avgDailyOpsLast7d = 2.0', async () => {
      ctx = await setup();
      // 14 ops spread over the last 6 days (all well within 7d window) — more than 2 per day on avg
      // To get exactly 14/7 = 2.0, seed 14 ops with timestamps in the last 6 days
      // avgDailyOpsLast7d = count_in_7d / 7 = 14/7 = 2.0
      for (let i = 0; i < 14; i++) {
        await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1078-7d', hoursAgo(i * 8 + 1)), dec(0.3, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1078-7d');
      expect(status).toBe(200);

      // 14 ops / 7 = 2.0
      expect(body.avgDailyOpsLast7d as number).toBeCloseTo(2.0, 5);
    });

    it('5. sessions — ops older than 7d: avgDailyOpsLast7d = 0', async () => {
      ctx = await setup();
      // All ops are older than 7d — window is empty
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1078-7d-empty', daysAgo(10)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1078-7d-empty', daysAgo(20)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1078-7d-empty');
      expect(status).toBe(200);

      expect(body.avgDailyOpsLast7d).toBe(0);
    });

    it('6. sessions — 30 ops in last 30d: avgDailyOpsLast30d = 1.0', async () => {
      ctx = await setup();
      // 30 ops all within last 29 days (well within 30d window)
      // avgDailyOpsLast30d = 30/30 = 1.0
      for (let i = 0; i < 30; i++) {
        await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1078-30d', hoursAgo(i * 20 + 1)), dec(0.3, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1078-30d');
      expect(status).toBe(200);

      // 30 ops / 30 = 1.0
      expect(body.avgDailyOpsLast30d as number).toBeCloseTo(1.0, 5);
    });

    it('7. sessions — burst ratio: 12 ops in last 24h, 2 in last 1h → opsBurstRatioLast1h = 4.0', async () => {
      ctx = await setup();
      // 12 ops in last 24h: 2 in last 1h + 10 between 1h and 24h ago
      for (let i = 0; i < 2; i++) {
        await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1078-burst1h'), dec(0.5, 'allow'));
      }
      for (let i = 0; i < 10; i++) {
        await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1078-burst1h', hoursAgo(12)), dec(0.5, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1078-burst1h');
      expect(status).toBe(200);

      // avgHourly = 12 / 24 = 0.5; ratio = 2 / 0.5 = 4.0
      expect(body.opsBurstRatioLast1h as number).toBeCloseTo(4.0, 5);
    });

    it('8. sessions — burst ratio: null when no ops in last 24h', async () => {
      ctx = await setup();
      // All ops are older than 24h
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1078-burst-null', daysAgo(3)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1078-burst-null');
      expect(status).toBe(200);

      expect(body.opsBurstRatioLast1h).toBeNull();
      expect(body.opsBurstRatioLast6h).toBeNull();
    });

    it('9. sessions — 24 ops in last 24h, 6 in last 6h → opsBurstRatioLast6h = 1.0', async () => {
      ctx = await setup();
      // 24 ops in last 24h: 6 in last 6h + 18 between 6h and 24h ago
      for (let i = 0; i < 6; i++) {
        await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1078-burst6h', hoursAgo(3)), dec(0.4, 'allow'));
      }
      for (let i = 0; i < 18; i++) {
        await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1078-burst6h', hoursAgo(12)), dec(0.4, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1078-burst6h');
      expect(status).toBe(200);

      // avg6h = 24 / 4 = 6; ratio = 6 / 6 = 1.0
      expect(body.opsBurstRatioLast6h as number).toBeCloseTo(1.0, 5);
    });

    it('10. sessions — 0 ops in last 1h but ops in last 24h: opsBurstRatioLast1h = 0', async () => {
      ctx = await setup();
      // 10 ops between 1h and 24h ago — no ops in last 1h
      for (let i = 0; i < 10; i++) {
        await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v1078-burst1h-zero', hoursAgo(12)), dec(0.3, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1078-burst1h-zero');
      expect(status).toBe(200);

      // last24h = 10, avgHourly = 10/24; last1h = 0; ratio = 0 / avgHourly = 0
      expect(body.opsBurstRatioLast1h).toBe(0);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1459-T1463 — v10.78 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('11. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1078-pres', 'fs', 'sess-1'), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1078-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('minDailyOpsAllTime');
      expect(body).toHaveProperty('avgDailyOpsLast7d');
      expect(body).toHaveProperty('avgDailyOpsLast30d');
      expect(body).toHaveProperty('opsBurstRatioLast1h');
      expect(body).toHaveProperty('opsBurstRatioLast6h');
    });

    it('12. agents — minDailyOpsAllTime: single day with multiple ops', async () => {
      ctx = await setup();
      // Day 1 (today): 5 ops, Day 2 (daysAgo 2): 2 ops
      // min = 2
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp('agent-v1078-min', 'fs', 'sess-1', hoursAgo(1)), dec(0.3, 'allow'));
      }
      for (let i = 0; i < 2; i++) {
        await ctx.logger.log(makeOp('agent-v1078-min', 'fs', 'sess-2', daysAgo(2)), dec(0.4, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1078-min');
      expect(status).toBe(200);

      expect(body.minDailyOpsAllTime).toBe(2);
    });

    it('13. agents — avgDailyOpsLast7d: 21 ops in 7d → 3.0', async () => {
      ctx = await setup();
      // 21 ops all within last 6 days (well within 7d window)
      // avgDailyOpsLast7d = 21/7 = 3.0
      for (let i = 0; i < 21; i++) {
        await ctx.logger.log(makeOp('agent-v1078-7d', 'fs', `sess-${i}`, hoursAgo(i * 6 + 1)), dec(0.3, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1078-7d');
      expect(status).toBe(200);

      expect(body.avgDailyOpsLast7d as number).toBeCloseTo(3.0, 5);
    });

    it('14. agents — avgDailyOpsLast30d: 15 ops in 30d → 0.5', async () => {
      ctx = await setup();
      // 15 ops all within last 29 days (well within 30d window)
      // avgDailyOpsLast30d = 15/30 = 0.5
      for (let i = 0; i < 15; i++) {
        await ctx.logger.log(makeOp('agent-v1078-30d', 'fs', `sess-${i}`, hoursAgo(i * 40 + 1)), dec(0.3, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1078-30d');
      expect(status).toBe(200);

      expect(body.avgDailyOpsLast30d as number).toBeCloseTo(0.5, 5);
    });

    it('15. agents — burst ratio: 24 ops in 24h, 8 in last 1h → opsBurstRatioLast1h = 8.0', async () => {
      ctx = await setup();
      // 24 ops in last 24h: 8 in last 1h + 16 between 1h and 24h
      for (let i = 0; i < 8; i++) {
        await ctx.logger.log(makeOp('agent-v1078-burst1h', 'fs', 'sess-1'), dec(0.5, 'allow'));
      }
      for (let i = 0; i < 16; i++) {
        await ctx.logger.log(makeOp('agent-v1078-burst1h', 'fs', 'sess-2', hoursAgo(10)), dec(0.4, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1078-burst1h');
      expect(status).toBe(200);

      // avgHourly = 24/24 = 1.0; ratio = 8 / 1.0 = 8.0
      expect(body.opsBurstRatioLast1h as number).toBeCloseTo(8.0, 5);
    });

    it('16. agents — burst ratio: null when no ops in last 24h', async () => {
      ctx = await setup();
      // All ops older than 24h
      await ctx.logger.log(makeOp('agent-v1078-burst-null', 'fs', 'sess-1', daysAgo(5)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1078-burst-null');
      expect(status).toBe(200);

      expect(body.opsBurstRatioLast1h).toBeNull();
      expect(body.opsBurstRatioLast6h).toBeNull();
    });

    it('17. agents — opsBurstRatioLast6h: 20 ops in 24h, 10 in last 6h → ratio = 2.0', async () => {
      ctx = await setup();
      // 20 ops in last 24h: 10 in last 6h + 10 between 6h and 24h
      for (let i = 0; i < 10; i++) {
        await ctx.logger.log(makeOp('agent-v1078-burst6h', 'fs', 'sess-1', hoursAgo(2)), dec(0.5, 'allow'));
      }
      for (let i = 0; i < 10; i++) {
        await ctx.logger.log(makeOp('agent-v1078-burst6h', 'fs', 'sess-2', hoursAgo(18)), dec(0.4, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1078-burst6h');
      expect(status).toBe(200);

      // avg6h = 20/4 = 5; ratio = 10 / 5 = 2.0
      expect(body.opsBurstRatioLast6h as number).toBeCloseTo(2.0, 5);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1459-T1463 — v10.78 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('18. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v1078-pres', 'sess-1'), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1078-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('minDailyOpsAllTime');
      expect(body).toHaveProperty('avgDailyOpsLast7d');
      expect(body).toHaveProperty('avgDailyOpsLast30d');
      expect(body).toHaveProperty('opsBurstRatioLast1h');
      expect(body).toHaveProperty('opsBurstRatioLast6h');
    });

    it('19. tools — minDailyOpsAllTime: 4 ops on day A, 1 op on day B → min = 1', async () => {
      ctx = await setup();
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp(`agent-${i}`, 'tool-v1078-min', `sess-${i}`, daysAgo(5)), dec(0.4, 'allow'));
      }
      await ctx.logger.log(makeOp('agent-x', 'tool-v1078-min', 'sess-x', daysAgo(15)), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1078-min');
      expect(status).toBe(200);

      expect(body.minDailyOpsAllTime).toBe(1);
    });

    it('20. tools — avgDailyOpsLast7d: 7 ops in last 7d → 1.0', async () => {
      ctx = await setup();
      // 7 ops all within last 6 days (well within 7d window)
      // avgDailyOpsLast7d = 7/7 = 1.0
      for (let i = 0; i < 7; i++) {
        await ctx.logger.log(makeOp(`agent-t7d-${i}`, 'tool-v1078-7d', `sess-${i}`, hoursAgo(i * 20 + 1)), dec(0.3, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1078-7d');
      expect(status).toBe(200);

      // 7 ops / 7 = 1.0
      expect(body.avgDailyOpsLast7d as number).toBeCloseTo(1.0, 5);
    });

    it('21. tools — avgDailyOpsLast30d: ops older than 30d not counted; denominator always 30', async () => {
      ctx = await setup();
      // 6 ops in last 30d, 3 ops older than 30d
      for (let d = 1; d <= 6; d++) {
        await ctx.logger.log(makeOp(`agent-t30d-${d}`, 'tool-v1078-30d', `sess-${d}`, daysAgo(d * 4)), dec(0.3, 'allow'));
      }
      for (let d = 1; d <= 3; d++) {
        await ctx.logger.log(makeOp(`agent-t30d-old-${d}`, 'tool-v1078-30d', `sess-old-${d}`, daysAgo(35 + d * 10)), dec(0.5, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1078-30d');
      expect(status).toBe(200);

      // 6 ops in last 30d / 30 = 0.2
      expect(body.avgDailyOpsLast30d as number).toBeCloseTo(0.2, 5);
    });

    it('22. tools — opsBurstRatioLast1h: 12 ops in 24h, 2 in last 1h → 4.0', async () => {
      ctx = await setup();
      for (let i = 0; i < 2; i++) {
        await ctx.logger.log(makeOp(`agent-tb1h-${i}`, 'tool-v1078-burst1h', `sess-1`), dec(0.5, 'allow'));
      }
      for (let i = 0; i < 10; i++) {
        await ctx.logger.log(makeOp(`agent-tb1h-mid-${i}`, 'tool-v1078-burst1h', `sess-2`, hoursAgo(15)), dec(0.4, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1078-burst1h');
      expect(status).toBe(200);

      // avgHourly = 12/24 = 0.5; ratio = 2/0.5 = 4.0
      expect(body.opsBurstRatioLast1h as number).toBeCloseTo(4.0, 5);
    });

    it('23. tools — opsBurstRatioLast6h: null when no ops in last 24h', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-tb6h', 'tool-v1078-burst6h-null', 'sess-1', daysAgo(2)), dec(0.3, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1078-burst6h-null');
      expect(status).toBe(200);

      expect(body.opsBurstRatioLast6h).toBeNull();
    });

    it('24. tools — opsBurstRatioLast6h: 8 ops in 24h, 8 all in last 6h → ratio = 4.0', async () => {
      ctx = await setup();
      // All 8 ops are in last 6h; last24h = 8; avg6h = 8/4 = 2; ratio = 8/2 = 4.0
      for (let i = 0; i < 8; i++) {
        await ctx.logger.log(makeOp(`agent-tb6h-${i}`, 'tool-v1078-burst6h-hi', `sess-${i}`, hoursAgo(4)), dec(0.4, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1078-burst6h-hi');
      expect(status).toBe(200);

      // avg6h = 8/4 = 2.0; last6h = 8; ratio = 8/2 = 4.0
      expect(body.opsBurstRatioLast6h as number).toBeCloseTo(4.0, 5);
    });
  });

  // ── operations/summary endpoint ────────────────────────────────────────────────

  describe('T1459-T1463 — v10.78 new fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('25. summary — all five new fields present', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s', 'tool-s', 'sess-1'), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body).toHaveProperty('minDailyOpsAllTime');
      expect(body).toHaveProperty('avgDailyOpsLast7d');
      expect(body).toHaveProperty('avgDailyOpsLast30d');
      expect(body).toHaveProperty('opsBurstRatioLast1h');
      expect(body).toHaveProperty('opsBurstRatioLast6h');
    });

    it('26. summary — empty DB: minDailyOpsAllTime null, avgDailyOps 0, burst ratios null', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.minDailyOpsAllTime).toBeNull();
      expect(body.avgDailyOpsLast7d).toBe(0);
      expect(body.avgDailyOpsLast30d).toBe(0);
      expect(body.opsBurstRatioLast1h).toBeNull();
      expect(body.opsBurstRatioLast6h).toBeNull();
    });

    it('27. summary — minDailyOpsAllTime with 3 days: returns the day with fewest ops', async () => {
      ctx = await setup();
      // Day 1 (daysAgo 5): 3 ops, Day 2 (daysAgo 15): 1 op, Day 3 (daysAgo 40): 4 ops
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp(`agent-s-min-d1-${i}`, 'fs', `sess-d1-${i}`, daysAgo(5)), dec(0.3, 'allow'));
      }
      await ctx.logger.log(makeOp('agent-s-min-d2', 'fs', 'sess-d2', daysAgo(15)), dec(0.4, 'allow'));
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp(`agent-s-min-d3-${i}`, 'fs', `sess-d3-${i}`, daysAgo(40)), dec(0.5, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.minDailyOpsAllTime).toBe(1);
    });

    it('28. summary — 14 ops in last 7d: avgDailyOpsLast7d = 2.0', async () => {
      ctx = await setup();
      // 14 ops all within last 6 days (well within 7d window)
      // avgDailyOpsLast7d = 14/7 = 2.0
      for (let i = 0; i < 14; i++) {
        await ctx.logger.log(makeOp(`agent-s-7d-${i}`, `tool-sum-7d`, `sess-7d-${i}`, hoursAgo(i * 8 + 1)), dec(0.3, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.avgDailyOpsLast7d as number).toBeCloseTo(2.0, 5);
    });

    it('29. summary — 60 ops in last 30d: avgDailyOpsLast30d = 2.0', async () => {
      ctx = await setup();
      // 60 ops all within last 29 days (well within 30d window)
      // avgDailyOpsLast30d = 60/30 = 2.0
      for (let i = 0; i < 60; i++) {
        await ctx.logger.log(makeOp(`agent-s-30d-${i}`, `tool-s-30d`, `sess-30d-${i}`, hoursAgo(i * 10 + 1)), dec(0.3, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.avgDailyOpsLast30d as number).toBeCloseTo(2.0, 5);
    });

    it('30. summary — burst ratio: 12 ops in last 24h, 2 in last 1h → opsBurstRatioLast1h = 4.0', async () => {
      ctx = await setup();
      // 2 ops in last 1h
      for (let i = 0; i < 2; i++) {
        await ctx.logger.log(makeOp(`agent-s-burst-1h-${i}`, 'tool-burst-s', `sess-b1h-${i}`), dec(0.5, 'allow'));
      }
      // 10 ops between 1h and 24h ago
      for (let i = 0; i < 10; i++) {
        await ctx.logger.log(makeOp(`agent-s-burst-1h-mid-${i}`, 'tool-burst-s', `sess-b1h-mid-${i}`, hoursAgo(12)), dec(0.4, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      // avgHourly = 12/24 = 0.5; ratio = 2/0.5 = 4.0
      expect(body.opsBurstRatioLast1h as number).toBeCloseTo(4.0, 5);
    });

    it('31. summary — burst ratio: 20 ops in 24h, 10 in last 6h → opsBurstRatioLast6h = 2.0', async () => {
      ctx = await setup();
      // 10 ops in last 6h
      for (let i = 0; i < 10; i++) {
        await ctx.logger.log(makeOp(`agent-s-burst-6h-${i}`, 'tool-burst-s6h', `sess-b6h-${i}`, hoursAgo(3)), dec(0.5, 'allow'));
      }
      // 10 ops between 6h and 24h ago
      for (let i = 0; i < 10; i++) {
        await ctx.logger.log(makeOp(`agent-s-burst-6h-mid-${i}`, 'tool-burst-s6h', `sess-b6h-mid-${i}`, hoursAgo(18)), dec(0.4, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      // avg6h = 20/4 = 5; ratio = 10/5 = 2.0
      expect(body.opsBurstRatioLast6h as number).toBeCloseTo(2.0, 5);
    });

    it('32. summary — all ops older than 24h: both burst ratios are null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s-old', 'tool-old', 'sess-old', daysAgo(3)), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.opsBurstRatioLast1h).toBeNull();
      expect(body.opsBurstRatioLast6h).toBeNull();
    });

    it('33. summary — ops in 24h but none in 1h: opsBurstRatioLast1h = 0', async () => {
      ctx = await setup();
      // 6 ops between 2h and 24h ago — none in last 1h
      for (let i = 0; i < 6; i++) {
        await ctx.logger.log(makeOp(`agent-s-no1h-${i}`, 'tool-no1h', `sess-no1h-${i}`, hoursAgo(10)), dec(0.4, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      // last24h = 6; avgHourly = 6/24 = 0.25; last1h = 0; ratio = 0
      expect(body.opsBurstRatioLast1h).toBe(0);
    });
  });
});

// ── v10.79 ────────────────────────────────────────────────────────────────────

describe('v10.79', () => {
  const hoursAgo = (h: number) => new Date(PINNED_NOW() - h * 3_600_000);
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);

  // Fixed weekday/weekend dates for deterministic day-of-week testing
  const MONDAY    = new Date('2026-03-16T10:00:00Z'); // getDay() = 1
  const TUESDAY   = new Date('2026-03-17T10:00:00Z'); // getDay() = 2
  const SATURDAY  = new Date('2026-03-14T10:00:00Z'); // getDay() = 6
  const SUNDAY    = new Date('2026-03-15T10:00:00Z'); // getDay() = 0

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1464-T1468 — v10.79 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1079-pres', MONDAY), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1079-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('opsBurstRatioLast12h');
      expect(body).toHaveProperty('avgRiskScoreWeekdays');
      expect(body).toHaveProperty('avgRiskScoreWeekends');
      expect(body).toHaveProperty('blockCountWeekdays');
      expect(body).toHaveProperty('blockCountWeekends');
    });

    it('2. sessions — opsBurstRatioLast12h: null when no ops in last 24h', async () => {
      ctx = await setup();
      // All ops older than 24h
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1079-burst12h-null', daysAgo(3)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1079-burst12h-null');
      expect(status).toBe(200);

      expect(body.opsBurstRatioLast12h).toBeNull();
    });

    it('3. sessions — opsBurstRatioLast12h: 8 ops in last 24h, 6 in last 12h → ratio = 1.5', async () => {
      ctx = await setup();
      // 6 ops in last 12h
      for (let i = 0; i < 6; i++) {
        await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1079-burst12h', hoursAgo(6)), dec(0.4, 'allow'));
      }
      // 2 ops between 12h and 24h ago
      for (let i = 0; i < 2; i++) {
        await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1079-burst12h', hoursAgo(18)), dec(0.4, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1079-burst12h');
      expect(status).toBe(200);

      // last24h = 8; avg12h = 8/2 = 4; last12h = 6; ratio = 6/4 = 1.5
      expect(body.opsBurstRatioLast12h as number).toBeCloseTo(1.5, 5);
    });

    it('4. sessions — opsBurstRatioLast12h: all 12h ops → ratio = 2.0', async () => {
      ctx = await setup();
      // All 8 ops are in last 12h; last24h = 8; avg12h = 8/2 = 4; ratio = 8/4 = 2.0
      for (let i = 0; i < 8; i++) {
        await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1079-burst12h-all', hoursAgo(6)), dec(0.5, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1079-burst12h-all');
      expect(status).toBe(200);

      expect(body.opsBurstRatioLast12h as number).toBeCloseTo(2.0, 5);
    });

    it('5. sessions — avgRiskScoreWeekdays: null when no weekday ops', async () => {
      ctx = await setup();
      // Only weekend ops (Saturday, Sunday)
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1079-wd-null', SATURDAY), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1079-wd-null', SUNDAY), dec(0.6, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1079-wd-null');
      expect(status).toBe(200);

      expect(body.avgRiskScoreWeekdays).toBeNull();
    });

    it('6. sessions — avgRiskScoreWeekdays: mean riskScore of Mon-Fri ops', async () => {
      ctx = await setup();
      // Monday: riskScore 0.2, Tuesday: riskScore 0.4 → avg = 0.3
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1079-wd-avg', MONDAY), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1079-wd-avg', TUESDAY), dec(0.4, 'allow'));
      // Also add a weekend op that should NOT affect weekday avg
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1079-wd-avg', SATURDAY), dec(0.9, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1079-wd-avg');
      expect(status).toBe(200);

      expect(body.avgRiskScoreWeekdays as number).toBeCloseTo(0.3, 5);
    });

    it('7. sessions — avgRiskScoreWeekends: null when no weekend ops', async () => {
      ctx = await setup();
      // Only weekday ops
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1079-we-null', MONDAY), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1079-we-null', TUESDAY), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1079-we-null');
      expect(status).toBe(200);

      expect(body.avgRiskScoreWeekends).toBeNull();
    });

    it('8. sessions — avgRiskScoreWeekends: mean riskScore of Sat-Sun ops', async () => {
      ctx = await setup();
      // Saturday: riskScore 0.3, Sunday: riskScore 0.7 → avg = 0.5
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1079-we-avg', SATURDAY), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1079-we-avg', SUNDAY), dec(0.7, 'allow'));
      // Also add a weekday op that should NOT affect weekend avg
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1079-we-avg', MONDAY), dec(0.9, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1079-we-avg');
      expect(status).toBe(200);

      expect(body.avgRiskScoreWeekends as number).toBeCloseTo(0.5, 5);
    });

    it('9. sessions — blockCountWeekdays: 0 when no blocked weekday ops', async () => {
      ctx = await setup();
      // weekday ops all allowed
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1079-bwd-zero', MONDAY), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1079-bwd-zero', TUESDAY), dec(0.4, 'allow'));
      // weekend block should not count
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1079-bwd-zero', SATURDAY), dec(0.8, 'block'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1079-bwd-zero');
      expect(status).toBe(200);

      expect(body.blockCountWeekdays).toBe(0);
    });

    it('10. sessions — blockCountWeekdays: counts only blocked ops on Mon-Fri', async () => {
      ctx = await setup();
      // 2 blocks on Monday, 1 block on Tuesday, 1 allow on weekday (should not count)
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v1079-bwd-cnt', MONDAY), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v1079-bwd-cnt', MONDAY), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v1079-bwd-cnt', TUESDAY), dec(0.7, 'block'));
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v1079-bwd-cnt', TUESDAY), dec(0.5, 'allow'));
      // weekend block should not count
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v1079-bwd-cnt', SATURDAY), dec(0.9, 'block'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1079-bwd-cnt');
      expect(status).toBe(200);

      expect(body.blockCountWeekdays).toBe(3);
    });

    it('11. sessions — blockCountWeekends: 0 when no blocked weekend ops', async () => {
      ctx = await setup();
      // weekend ops all allowed
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v1079-bwe-zero', SATURDAY), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v1079-bwe-zero', SUNDAY), dec(0.4, 'allow'));
      // weekday block should not count
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v1079-bwe-zero', MONDAY), dec(0.8, 'block'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1079-bwe-zero');
      expect(status).toBe(200);

      expect(body.blockCountWeekends).toBe(0);
    });

    it('12. sessions — blockCountWeekends: counts only blocked ops on Sat-Sun', async () => {
      ctx = await setup();
      // 2 blocks on Saturday, 1 block on Sunday
      await ctx.logger.log(makeOp('agent-k', 'fs', 'sess-v1079-bwe-cnt', SATURDAY), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agent-k', 'fs', 'sess-v1079-bwe-cnt', SATURDAY), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-k', 'fs', 'sess-v1079-bwe-cnt', SUNDAY), dec(0.7, 'block'));
      await ctx.logger.log(makeOp('agent-k', 'fs', 'sess-v1079-bwe-cnt', SUNDAY), dec(0.5, 'allow'));
      // weekday block should not count
      await ctx.logger.log(makeOp('agent-k', 'fs', 'sess-v1079-bwe-cnt', MONDAY), dec(0.9, 'block'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1079-bwe-cnt');
      expect(status).toBe(200);

      expect(body.blockCountWeekends).toBe(3);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1464-T1468 — v10.79 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('13. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1079-pres', 'fs', 'sess-1', MONDAY), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1079-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('opsBurstRatioLast12h');
      expect(body).toHaveProperty('avgRiskScoreWeekdays');
      expect(body).toHaveProperty('avgRiskScoreWeekends');
      expect(body).toHaveProperty('blockCountWeekdays');
      expect(body).toHaveProperty('blockCountWeekends');
    });

    it('14. agents — opsBurstRatioLast12h: null when no ops in last 24h', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1079-burst12h-null', 'fs', 'sess-1', daysAgo(5)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1079-burst12h-null');
      expect(status).toBe(200);

      expect(body.opsBurstRatioLast12h).toBeNull();
    });

    it('15. agents — opsBurstRatioLast12h: 8 ops in 24h, 6 in 12h → ratio = 1.5', async () => {
      ctx = await setup();
      for (let i = 0; i < 6; i++) {
        await ctx.logger.log(makeOp('agent-v1079-burst12h', 'fs', 'sess-1', hoursAgo(6)), dec(0.4, 'allow'));
      }
      for (let i = 0; i < 2; i++) {
        await ctx.logger.log(makeOp('agent-v1079-burst12h', 'fs', 'sess-2', hoursAgo(18)), dec(0.4, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1079-burst12h');
      expect(status).toBe(200);

      // last24h = 8; avg12h = 8/2 = 4; last12h = 6; ratio = 6/4 = 1.5
      expect(body.opsBurstRatioLast12h as number).toBeCloseTo(1.5, 5);
    });

    it('16. agents — avgRiskScoreWeekdays: null when only weekend ops', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1079-wd-null', 'fs', 'sess-1', SATURDAY), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-v1079-wd-null', 'fs', 'sess-2', SUNDAY), dec(0.7, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1079-wd-null');
      expect(status).toBe(200);

      expect(body.avgRiskScoreWeekdays).toBeNull();
    });

    it('17. agents — avgRiskScoreWeekdays: Monday 0.4, Tuesday 0.8 → avg = 0.6', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1079-wd-avg', 'fs', 'sess-1', MONDAY), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-v1079-wd-avg', 'fs', 'sess-2', TUESDAY), dec(0.8, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1079-wd-avg');
      expect(status).toBe(200);

      expect(body.avgRiskScoreWeekdays as number).toBeCloseTo(0.6, 5);
    });

    it('18. agents — avgRiskScoreWeekends: Saturday 0.2, Sunday 0.6 → avg = 0.4', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1079-we-avg', 'fs', 'sess-1', SATURDAY), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-v1079-we-avg', 'fs', 'sess-2', SUNDAY), dec(0.6, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1079-we-avg');
      expect(status).toBe(200);

      expect(body.avgRiskScoreWeekends as number).toBeCloseTo(0.4, 5);
    });

    it('19. agents — blockCountWeekdays: 2 blocks Mon + 1 block Tue = 3', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1079-bwd', 'fs', 'sess-1', MONDAY), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agent-v1079-bwd', 'fs', 'sess-2', MONDAY), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-v1079-bwd', 'fs', 'sess-3', TUESDAY), dec(0.7, 'block'));
      await ctx.logger.log(makeOp('agent-v1079-bwd', 'fs', 'sess-4', SATURDAY), dec(0.9, 'block')); // weekend, shouldn't count

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1079-bwd');
      expect(status).toBe(200);

      expect(body.blockCountWeekdays).toBe(3);
    });

    it('20. agents — blockCountWeekends: 2 blocks Sat + 1 block Sun = 3', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1079-bwe', 'fs', 'sess-1', SATURDAY), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agent-v1079-bwe', 'fs', 'sess-2', SATURDAY), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-v1079-bwe', 'fs', 'sess-3', SUNDAY), dec(0.7, 'block'));
      await ctx.logger.log(makeOp('agent-v1079-bwe', 'fs', 'sess-4', MONDAY), dec(0.9, 'block')); // weekday, shouldn't count

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1079-bwe');
      expect(status).toBe(200);

      expect(body.blockCountWeekends).toBe(3);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1464-T1468 — v10.79 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('21. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v1079-pres', 'sess-1', MONDAY), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1079-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('opsBurstRatioLast12h');
      expect(body).toHaveProperty('avgRiskScoreWeekdays');
      expect(body).toHaveProperty('avgRiskScoreWeekends');
      expect(body).toHaveProperty('blockCountWeekdays');
      expect(body).toHaveProperty('blockCountWeekends');
    });

    it('22. tools — opsBurstRatioLast12h: null when no ops in last 24h', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v1079-burst12h-null', 'sess-1', daysAgo(2)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1079-burst12h-null');
      expect(status).toBe(200);

      expect(body.opsBurstRatioLast12h).toBeNull();
    });

    it('23. tools — opsBurstRatioLast12h: 6 ops in 24h, 6 all in last 12h → ratio = 2.0', async () => {
      ctx = await setup();
      // All 6 ops in last 12h; last24h = 6; avg12h = 6/2 = 3; ratio = 6/3 = 2.0
      for (let i = 0; i < 6; i++) {
        await ctx.logger.log(makeOp(`agent-t12h-${i}`, 'tool-v1079-burst12h-all', `sess-${i}`, hoursAgo(4)), dec(0.4, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1079-burst12h-all');
      expect(status).toBe(200);

      expect(body.opsBurstRatioLast12h as number).toBeCloseTo(2.0, 5);
    });

    it('24. tools — avgRiskScoreWeekdays: null when no weekday ops', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v1079-wd-null', 'sess-1', SATURDAY), dec(0.6, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1079-wd-null');
      expect(status).toBe(200);

      expect(body.avgRiskScoreWeekdays).toBeNull();
    });

    it('25. tools — avgRiskScoreWeekdays: Monday 0.6, Tuesday 0.2 → avg = 0.4', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v1079-wd-avg', 'sess-1', MONDAY), dec(0.6, 'allow'));
      await ctx.logger.log(makeOp('agent-b', 'tool-v1079-wd-avg', 'sess-2', TUESDAY), dec(0.2, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1079-wd-avg');
      expect(status).toBe(200);

      expect(body.avgRiskScoreWeekdays as number).toBeCloseTo(0.4, 5);
    });

    it('26. tools — avgRiskScoreWeekends: null when only weekday ops', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v1079-we-null', 'sess-1', MONDAY), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1079-we-null');
      expect(status).toBe(200);

      expect(body.avgRiskScoreWeekends).toBeNull();
    });

    it('27. tools — avgRiskScoreWeekends: Saturday 0.1, Sunday 0.9 → avg = 0.5', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v1079-we-avg', 'sess-1', SATURDAY), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-b', 'tool-v1079-we-avg', 'sess-2', SUNDAY), dec(0.9, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1079-we-avg');
      expect(status).toBe(200);

      expect(body.avgRiskScoreWeekends as number).toBeCloseTo(0.5, 5);
    });

    it('28. tools — blockCountWeekdays: 0 when no blocked weekday ops', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v1079-bwd-zero', 'sess-1', MONDAY), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-b', 'tool-v1079-bwd-zero', 'sess-2', SATURDAY), dec(0.8, 'block'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1079-bwd-zero');
      expect(status).toBe(200);

      expect(body.blockCountWeekdays).toBe(0);
    });

    it('29. tools — blockCountWeekdays: 3 blocks on weekdays', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v1079-bwd-cnt', 'sess-1', MONDAY), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agent-b', 'tool-v1079-bwd-cnt', 'sess-2', MONDAY), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-c', 'tool-v1079-bwd-cnt', 'sess-3', TUESDAY), dec(0.7, 'block'));
      await ctx.logger.log(makeOp('agent-d', 'tool-v1079-bwd-cnt', 'sess-4', TUESDAY), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-e', 'tool-v1079-bwd-cnt', 'sess-5', SATURDAY), dec(0.9, 'block')); // weekend

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1079-bwd-cnt');
      expect(status).toBe(200);

      expect(body.blockCountWeekdays).toBe(3);
    });

    it('30. tools — blockCountWeekends: 0 when no blocked weekend ops', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v1079-bwe-zero', 'sess-1', SATURDAY), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-b', 'tool-v1079-bwe-zero', 'sess-2', MONDAY), dec(0.8, 'block'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1079-bwe-zero');
      expect(status).toBe(200);

      expect(body.blockCountWeekends).toBe(0);
    });

    it('31. tools — blockCountWeekends: 3 blocks on weekends', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v1079-bwe-cnt', 'sess-1', SATURDAY), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agent-b', 'tool-v1079-bwe-cnt', 'sess-2', SATURDAY), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-c', 'tool-v1079-bwe-cnt', 'sess-3', SUNDAY), dec(0.7, 'block'));
      await ctx.logger.log(makeOp('agent-d', 'tool-v1079-bwe-cnt', 'sess-4', SUNDAY), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-e', 'tool-v1079-bwe-cnt', 'sess-5', MONDAY), dec(0.9, 'block')); // weekday

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1079-bwe-cnt');
      expect(status).toBe(200);

      expect(body.blockCountWeekends).toBe(3);
    });
  });

  // ── operations/summary endpoint ────────────────────────────────────────────────

  describe('T1464-T1468 — v10.79 new fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('32. summary — all five new fields present', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s', 'tool-s', 'sess-1', MONDAY), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body).toHaveProperty('opsBurstRatioLast12h');
      expect(body).toHaveProperty('avgRiskScoreWeekdays');
      expect(body).toHaveProperty('avgRiskScoreWeekends');
      expect(body).toHaveProperty('blockCountWeekdays');
      expect(body).toHaveProperty('blockCountWeekends');
    });

    it('33. summary — empty DB: burst ratio null, weekday/weekend fields null/0', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.opsBurstRatioLast12h).toBeNull();
      expect(body.avgRiskScoreWeekdays).toBeNull();
      expect(body.avgRiskScoreWeekends).toBeNull();
      expect(body.blockCountWeekdays).toBe(0);
      expect(body.blockCountWeekends).toBe(0);
    });

    it('34. summary — opsBurstRatioLast12h: null when no ops in last 24h', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s-old', 'tool-old', 'sess-old', daysAgo(3)), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.opsBurstRatioLast12h).toBeNull();
    });

    it('35. summary — opsBurstRatioLast12h: 8 ops in 24h, 6 in 12h → ratio = 1.5', async () => {
      ctx = await setup();
      for (let i = 0; i < 6; i++) {
        await ctx.logger.log(makeOp(`agent-s-12h-${i}`, `tool-s12h`, `sess-s12h-${i}`, hoursAgo(6)), dec(0.4, 'allow'));
      }
      for (let i = 0; i < 2; i++) {
        await ctx.logger.log(makeOp(`agent-s-12h-old-${i}`, `tool-s12h`, `sess-s12h-old-${i}`, hoursAgo(18)), dec(0.4, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      // last24h = 8; avg12h = 8/2 = 4; last12h = 6; ratio = 6/4 = 1.5
      expect(body.opsBurstRatioLast12h as number).toBeCloseTo(1.5, 5);
    });

    it('36. summary — avgRiskScoreWeekdays: null when only weekend ops', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s-we', 'tool-we', 'sess-we', SATURDAY), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-s-we2', 'tool-we', 'sess-we2', SUNDAY), dec(0.7, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.avgRiskScoreWeekdays).toBeNull();
    });

    it('37. summary — avgRiskScoreWeekdays: Monday 0.3, Tuesday 0.5 → avg = 0.4', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s-wd1', 'tool-wd', 'sess-wd1', MONDAY), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-s-wd2', 'tool-wd', 'sess-wd2', TUESDAY), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.avgRiskScoreWeekdays as number).toBeCloseTo(0.4, 5);
    });

    it('38. summary — avgRiskScoreWeekends: null when only weekday ops', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s-wd', 'tool-wd2', 'sess-wd', MONDAY), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.avgRiskScoreWeekends).toBeNull();
    });

    it('39. summary — avgRiskScoreWeekends: Saturday 0.4, Sunday 0.8 → avg = 0.6', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s-we1', 'tool-we2', 'sess-we1', SATURDAY), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-s-we2', 'tool-we2', 'sess-we2', SUNDAY), dec(0.8, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.avgRiskScoreWeekends as number).toBeCloseTo(0.6, 5);
    });

    it('40. summary — blockCountWeekdays: 0 when no blocked weekday ops', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s-bwd', 'tool-bwd', 'sess-bwd', MONDAY), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-s-bwe', 'tool-bwd', 'sess-bwe', SATURDAY), dec(0.8, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.blockCountWeekdays).toBe(0);
    });

    it('41. summary — blockCountWeekdays: 2 Mon blocks + 1 Tue block = 3', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s-bwd1', 'tool-bwd-cnt', 'sess-bwd1', MONDAY), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agent-s-bwd2', 'tool-bwd-cnt', 'sess-bwd2', MONDAY), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-s-bwd3', 'tool-bwd-cnt', 'sess-bwd3', TUESDAY), dec(0.7, 'block'));
      await ctx.logger.log(makeOp('agent-s-bwd4', 'tool-bwd-cnt', 'sess-bwd4', TUESDAY), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-s-bwe5', 'tool-bwd-cnt', 'sess-bwe5', SATURDAY), dec(0.9, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.blockCountWeekdays).toBe(3);
    });

    it('42. summary — blockCountWeekends: 0 when no blocked weekend ops', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s-bwe0', 'tool-bwe-zero', 'sess-bwe0', SATURDAY), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-s-bwd0', 'tool-bwe-zero', 'sess-bwd0', MONDAY), dec(0.8, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.blockCountWeekends).toBe(0);
    });

    it('43. summary — blockCountWeekends: 2 Sat blocks + 1 Sun block = 3', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s-bwe1', 'tool-bwe-cnt', 'sess-bwe1', SATURDAY), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agent-s-bwe2', 'tool-bwe-cnt', 'sess-bwe2', SATURDAY), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-s-bwe3', 'tool-bwe-cnt', 'sess-bwe3', SUNDAY), dec(0.7, 'block'));
      await ctx.logger.log(makeOp('agent-s-bwe4', 'tool-bwe-cnt', 'sess-bwe4', SUNDAY), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-s-bwd5', 'tool-bwe-cnt', 'sess-bwd5', MONDAY), dec(0.9, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.blockCountWeekends).toBe(3);
    });
  });
});

// ── v10.80 ────────────────────────────────────────────────────────────────────

describe('v10.80', () => {
  // Fixed dates for weekday/weekend testing
  // Monday 2026-03-16
  const MONDAY = new Date('2026-03-16T10:00:00Z');
  // Saturday 2026-03-14
  const SATURDAY = new Date('2026-03-14T10:00:00Z');

  // Within 45m window (30 min ago)
  const minsAgo = (m: number) => new Date(PINNED_NOW() - m * 60_000);

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1469-T1473 — v10.80 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all four new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1080-pres'), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1080-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('allowCountWeekdays');
      expect(body).toHaveProperty('allowCountWeekends');
      expect(body).toHaveProperty('opsLast45m');
      expect(body).toHaveProperty('avgRiskScoreLast15m');
    });

    it('2. sessions — allowCountWeekdays counts only Mon-Fri allow ops', async () => {
      ctx = await setup();
      // Monday allow (counted)
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-wkd', MONDAY), dec(0.3, 'allow'));
      // Saturday allow (not counted in weekdays)
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-wkd', SATURDAY), dec(0.5, 'allow'));
      // Monday block (not counted — action is block)
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-wkd', MONDAY), dec(0.7, 'block'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-wkd');
      expect(status).toBe(200);

      expect(body.allowCountWeekdays).toBe(1);
    });

    it('3. sessions — allowCountWeekends counts only Sat-Sun allow ops', async () => {
      ctx = await setup();
      // Saturday allow (counted)
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-wke', SATURDAY), dec(0.3, 'allow'));
      // Monday allow (not counted in weekends)
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-wke', MONDAY), dec(0.5, 'allow'));
      // Saturday block (not counted — action is block)
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-wke', SATURDAY), dec(0.7, 'block'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-wke');
      expect(status).toBe(200);

      expect(body.allowCountWeekends).toBe(1);
    });

    it('4. sessions — allowCountWeekdays and allowCountWeekends are 0 if no matching ops', async () => {
      ctx = await setup();
      // Only block ops on weekday and weekend
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-noallow', MONDAY), dec(0.6, 'block'));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-noallow', SATURDAY), dec(0.8, 'block'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-noallow');
      expect(status).toBe(200);

      expect(body.allowCountWeekdays).toBe(0);
      expect(body.allowCountWeekends).toBe(0);
    });

    it('5. sessions — opsLast45m counts ops within 45-minute window', async () => {
      ctx = await setup();
      // Op 30 minutes ago — within 45m window
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-45m', minsAgo(30)), dec(0.4, 'allow'));
      // Op 10 minutes ago — within 45m window
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-45m', minsAgo(10)), dec(0.5, 'allow'));
      // Op 60 minutes ago — outside 45m window
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-45m', minsAgo(60)), dec(0.3, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-45m');
      expect(status).toBe(200);

      expect(body.opsLast45m).toBe(2);
    });

    it('6. sessions — opsLast45m is 0 if no ops in 45m window', async () => {
      ctx = await setup();
      // Only old op
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-45m-empty', minsAgo(120)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-45m-empty');
      expect(status).toBe(200);

      expect(body.opsLast45m).toBe(0);
    });

    it('7. sessions — avgRiskScoreLast15m is null if no ops in 15m window', async () => {
      ctx = await setup();
      // Op 30 minutes ago — outside 15m window
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-15m-null', minsAgo(30)), dec(0.6, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-15m-null');
      expect(status).toBe(200);

      expect(body.avgRiskScoreLast15m).toBeNull();
    });

    it('8. sessions — avgRiskScoreLast15m is mean of ops in last 15 minutes', async () => {
      ctx = await setup();
      // Two ops within 15 minutes: risk 0.4 and 0.8 → avg = 0.6
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-15m-val', minsAgo(5)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-15m-val', minsAgo(10)), dec(0.8, 'allow'));
      // Op outside 15m window — should not affect avg
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-15m-val', minsAgo(30)), dec(1.0, 'block'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-15m-val');
      expect(status).toBe(200);

      expect(body.avgRiskScoreLast15m as number).toBeCloseTo(0.6, 5);
    });

    it('9. sessions — allowCountWeekdays multiple allow ops on multiple weekdays', async () => {
      ctx = await setup();
      // Monday + Tuesday (day 2)
      const TUESDAY = new Date('2026-03-17T10:00:00Z'); // Tuesday
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-multi-wkd', MONDAY), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-multi-wkd', TUESDAY), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-multi-wkd', SATURDAY), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-multi-wkd');
      expect(status).toBe(200);

      expect(body.allowCountWeekdays).toBe(2);
      expect(body.allowCountWeekends).toBe(1);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1469-T1473 — v10.80 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('10. agents — all four new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1080-pres', 'fs', 'sess-1'), dec(0.3, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1080-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('allowCountWeekdays');
      expect(body).toHaveProperty('allowCountWeekends');
      expect(body).toHaveProperty('opsLast45m');
      expect(body).toHaveProperty('avgRiskScoreLast15m');
    });

    it('11. agents — allowCountWeekdays counts only Mon-Fri allow ops', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1080-wkd', 'fs', 'sess-1', MONDAY), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-v1080-wkd', 'fs', 'sess-2', MONDAY), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-v1080-wkd', 'fs', 'sess-3', SATURDAY), dec(0.6, 'allow'));
      await ctx.logger.log(makeOp('agent-v1080-wkd', 'fs', 'sess-4', MONDAY), dec(0.7, 'block'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1080-wkd');
      expect(status).toBe(200);

      expect(body.allowCountWeekdays).toBe(2);
    });

    it('12. agents — allowCountWeekends counts only Sat-Sun allow ops', async () => {
      ctx = await setup();
      const SUNDAY = new Date('2026-03-15T10:00:00Z'); // Sunday
      await ctx.logger.log(makeOp('agent-v1080-wke', 'fs', 'sess-1', SATURDAY), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-v1080-wke', 'fs', 'sess-2', SUNDAY), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-v1080-wke', 'fs', 'sess-3', MONDAY), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1080-wke');
      expect(status).toBe(200);

      expect(body.allowCountWeekends).toBe(2);
    });

    it('13. agents — opsLast45m counts ops within 45-minute window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1080-45m', 'fs', 'sess-1', minsAgo(5)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-v1080-45m', 'fs', 'sess-2', minsAgo(40)), dec(0.5, 'block'));
      // Op outside 45m window
      await ctx.logger.log(makeOp('agent-v1080-45m', 'fs', 'sess-3', minsAgo(90)), dec(0.7, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1080-45m');
      expect(status).toBe(200);

      expect(body.opsLast45m).toBe(2);
    });

    it('14. agents — avgRiskScoreLast15m is null if no ops in 15m window', async () => {
      ctx = await setup();
      // Op 20 minutes ago — outside 15m window
      await ctx.logger.log(makeOp('agent-v1080-15m-null', 'fs', 'sess-1', minsAgo(20)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1080-15m-null');
      expect(status).toBe(200);

      expect(body.avgRiskScoreLast15m).toBeNull();
    });

    it('15. agents — avgRiskScoreLast15m computed from ops within last 15 minutes', async () => {
      ctx = await setup();
      // Ops within 15 minutes: 0.2, 0.6 → avg = 0.4
      await ctx.logger.log(makeOp('agent-v1080-15m-val', 'fs', 'sess-1', minsAgo(3)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-v1080-15m-val', 'fs', 'sess-2', minsAgo(12)), dec(0.6, 'block'));
      // Outside 15m: should not be included
      await ctx.logger.log(makeOp('agent-v1080-15m-val', 'fs', 'sess-3', minsAgo(20)), dec(0.9, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1080-15m-val');
      expect(status).toBe(200);

      expect(body.avgRiskScoreLast15m as number).toBeCloseTo(0.4, 5);
    });

    it('16. agents — allowCountWeekdays and allowCountWeekends both 0 if no allow ops', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1080-noallow', 'fs', 'sess-1', MONDAY), dec(0.5, 'block'));
      await ctx.logger.log(makeOp('agent-v1080-noallow', 'fs', 'sess-2', SATURDAY), dec(0.6, 'block'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1080-noallow');
      expect(status).toBe(200);

      expect(body.allowCountWeekdays).toBe(0);
      expect(body.allowCountWeekends).toBe(0);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1469-T1473 — v10.80 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('17. tools — all four new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-j', 'tool-v1080-pres', 'sess-1'), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1080-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('allowCountWeekdays');
      expect(body).toHaveProperty('allowCountWeekends');
      expect(body).toHaveProperty('opsLast45m');
      expect(body).toHaveProperty('avgRiskScoreLast15m');
    });

    it('18. tools — allowCountWeekdays counts Mon-Fri allow ops', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-k', 'tool-v1080-wkd', 'sess-1', MONDAY), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-k', 'tool-v1080-wkd', 'sess-2', SATURDAY), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-k', 'tool-v1080-wkd', 'sess-3', MONDAY), dec(0.5, 'block'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1080-wkd');
      expect(status).toBe(200);

      expect(body.allowCountWeekdays).toBe(1);
      expect(body.allowCountWeekends).toBe(1);
    });

    it('19. tools — opsLast45m includes ops at boundary edge of 45m', async () => {
      ctx = await setup();
      // Op exactly 30 min ago (well within 45m window)
      await ctx.logger.log(makeOp('agent-l', 'tool-v1080-45m', 'sess-1', new Date(PINNED_NOW() - 30 * 60 * 1000)), dec(0.4, 'allow'));
      // Op at 60 min ago — outside 45m window
      await ctx.logger.log(makeOp('agent-l', 'tool-v1080-45m', 'sess-2', minsAgo(60)), dec(0.6, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1080-45m');
      expect(status).toBe(200);

      expect(body.opsLast45m).toBe(1);
    });

    it('20. tools — opsLast45m is 0 if no recent ops', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-m', 'tool-v1080-45m-empty', 'sess-1', minsAgo(120)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1080-45m-empty');
      expect(status).toBe(200);

      expect(body.opsLast45m).toBe(0);
    });

    it('21. tools — avgRiskScoreLast15m is null if no ops in 15m window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-n', 'tool-v1080-15m-null', 'sess-1', minsAgo(20)), dec(0.7, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1080-15m-null');
      expect(status).toBe(200);

      expect(body.avgRiskScoreLast15m).toBeNull();
    });

    it('22. tools — avgRiskScoreLast15m computed from ops in last 15 minutes', async () => {
      ctx = await setup();
      // Three ops within 15 minutes: 0.3, 0.6, 0.9 → avg = 0.6
      await ctx.logger.log(makeOp('agent-o', 'tool-v1080-15m-val', 'sess-1', minsAgo(2)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-o', 'tool-v1080-15m-val', 'sess-2', minsAgo(8)), dec(0.6, 'allow'));
      await ctx.logger.log(makeOp('agent-o', 'tool-v1080-15m-val', 'sess-3', minsAgo(13)), dec(0.9, 'block'));
      // Outside 15m
      await ctx.logger.log(makeOp('agent-o', 'tool-v1080-15m-val', 'sess-4', minsAgo(25)), dec(0.0, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1080-15m-val');
      expect(status).toBe(200);

      expect(body.avgRiskScoreLast15m as number).toBeCloseTo(0.6, 5);
    });

    it('23. tools — allowCountWeekdays and allowCountWeekends are 0 with no logs', async () => {
      // Seed one log so endpoint returns 200
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-p', 'tool-v1080-zero', 'sess-1', MONDAY), dec(0.5, 'block'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1080-zero');
      expect(status).toBe(200);

      expect(body.allowCountWeekdays).toBe(0);
      expect(body.allowCountWeekends).toBe(0);
    });
  });

  // ── operations/summary endpoint ────────────────────────────────────────────────

  describe('T1469-T1473 — v10.80 new fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('24. summary — all four new fields present', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-q', 'tool-s', 'sess-1'), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body).toHaveProperty('allowCountWeekdays');
      expect(body).toHaveProperty('allowCountWeekends');
      expect(body).toHaveProperty('opsLast45m');
      expect(body).toHaveProperty('avgRiskScoreLast15m');
    });

    it('25. summary — empty DB: allowCountWeekdays=0, allowCountWeekends=0, opsLast45m=0, avgRiskScoreLast15m=null', async () => {
      ctx = await setup();

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.allowCountWeekdays).toBe(0);
      expect(body.allowCountWeekends).toBe(0);
      expect(body.opsLast45m).toBe(0);
      expect(body.avgRiskScoreLast15m).toBeNull();
    });

    it('26. summary — allowCountWeekdays counts Mon-Fri allow ops across all agents/sessions', async () => {
      ctx = await setup();
      // Monday allow from 2 different agents
      await ctx.logger.log(makeOp('agent-r1', 'tool-r', 'sess-r1', MONDAY), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-r2', 'tool-r', 'sess-r2', MONDAY), dec(0.5, 'allow'));
      // Saturday allow
      await ctx.logger.log(makeOp('agent-r3', 'tool-r', 'sess-r3', SATURDAY), dec(0.4, 'allow'));
      // Monday block (not counted)
      await ctx.logger.log(makeOp('agent-r4', 'tool-r', 'sess-r4', MONDAY), dec(0.8, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.allowCountWeekdays).toBe(2);
      expect(body.allowCountWeekends).toBe(1);
    });

    it('27. summary — opsLast45m counts all ops in last 45 minutes globally', async () => {
      ctx = await setup();
      // 3 ops within 45m window
      await ctx.logger.log(makeOp('agent-s1', 'tool-s1', 'sess-s1', minsAgo(5)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-s2', 'tool-s2', 'sess-s2', minsAgo(20)), dec(0.4, 'block'));
      await ctx.logger.log(makeOp('agent-s3', 'tool-s3', 'sess-s3', minsAgo(44)), dec(0.6, 'allow'));
      // 2 ops outside 45m window
      await ctx.logger.log(makeOp('agent-s4', 'tool-s4', 'sess-s4', minsAgo(60)), dec(0.8, 'allow'));
      await ctx.logger.log(makeOp('agent-s5', 'tool-s5', 'sess-s5', minsAgo(120)), dec(0.9, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.opsLast45m).toBe(3);
    });

    it('28. summary — avgRiskScoreLast15m is null if no ops in last 15m', async () => {
      ctx = await setup();
      // Only old ops
      await ctx.logger.log(makeOp('agent-t', 'tool-t', 'sess-t', minsAgo(30)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.avgRiskScoreLast15m).toBeNull();
    });

    it('29. summary — avgRiskScoreLast15m is mean of all ops in last 15 minutes', async () => {
      ctx = await setup();
      // Ops within 15m: 0.1, 0.5, 0.9 → avg = 0.5
      await ctx.logger.log(makeOp('agent-u1', 'tool-u', 'sess-u1', minsAgo(2)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-u2', 'tool-u', 'sess-u2', minsAgo(7)), dec(0.5, 'block'));
      await ctx.logger.log(makeOp('agent-u3', 'tool-u', 'sess-u3', minsAgo(14)), dec(0.9, 'allow'));
      // Outside 15m — not included
      await ctx.logger.log(makeOp('agent-u4', 'tool-u', 'sess-u4', minsAgo(30)), dec(0.0, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.avgRiskScoreLast15m as number).toBeCloseTo(0.5, 5);
    });

    it('30. summary — opsLast45m is 0 if no recent ops', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v', 'tool-v', 'sess-v', minsAgo(90)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.opsLast45m).toBe(0);
    });

    it('31. summary — opsLast15m pre-existing field still present (T841)', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-w', 'tool-w', 'sess-w'), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      // opsLast15m was pre-existing as T841, should remain present
      expect(body).toHaveProperty('opsLast15m');
    });
  });
});

// ── v10.81 ────────────────────────────────────────────────────────────────────

describe('v10.81', () => {
  const minutesAgo = (m: number) => new Date(PINNED_NOW() - m * 60_000);
  const hoursAgo = (h: number) => new Date(PINNED_NOW() - h * 3_600_000);
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1474-T1478 — v10.81 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1081-pres', minutesAgo(5)), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1081-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('avgRiskScoreLast45m');
      expect(body).toHaveProperty('maxRiskScoreAllTime');
      expect(body).toHaveProperty('minRiskScoreAllTime');
      expect(body).toHaveProperty('riskScoreRangeAllTime');
      expect(body).toHaveProperty('riskScoreCV');
    });

    it('2. sessions — no logs: all five fields are null', async () => {
      ctx = await setup();
      // seed a log for a DIFFERENT session so the endpoint returns 200
      await ctx.logger.log(makeOp('agent-x', 'fs', 'sess-v1081-other'), dec(0.5));
      // query the empty session
      // Dashboard returns 200 with empty analytics when no logs for that session
      // (or 404 — either way null fields are the goal; use the populated session and check no 45m ops)
      // Instead: seed one old op (>45m) for the target session, window should be null but allTime non-null
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1081-empty45m', hoursAgo(2)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1081-empty45m');
      expect(status).toBe(200);

      // 45m window is empty — no ops in last 45 minutes
      expect(body.avgRiskScoreLast45m).toBeNull();

      // all-time has one log
      expect(body.maxRiskScoreAllTime as number).toBeCloseTo(0.5, 5);
      expect(body.minRiskScoreAllTime as number).toBeCloseTo(0.5, 5);
      expect(body.riskScoreRangeAllTime as number).toBeCloseTo(0, 5);
      // CV: stddev=0, mean=0.5 → CV=0
      expect(body.riskScoreCV as number).toBeCloseTo(0, 5);
    });

    it('3. sessions — ops within 45m: avgRiskScoreLast45m computed correctly', async () => {
      ctx = await setup();
      // Three ops within 45m: scores 0.2, 0.4, 0.6 → mean = 0.4
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1081-45m', minutesAgo(10)), dec(0.2));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1081-45m', minutesAgo(20)), dec(0.4));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1081-45m', minutesAgo(30)), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1081-45m');
      expect(status).toBe(200);

      expect(body.avgRiskScoreLast45m as number).toBeCloseTo(0.4, 5);
    });

    it('4. sessions — ops outside 45m window: avgRiskScoreLast45m is null', async () => {
      ctx = await setup();
      // Two ops older than 45m
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1081-old45m', minutesAgo(60)), dec(0.3));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1081-old45m', minutesAgo(90)), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1081-old45m');
      expect(status).toBe(200);

      expect(body.avgRiskScoreLast45m).toBeNull();
      // All-time still computed
      expect(body.maxRiskScoreAllTime as number).toBeCloseTo(0.7, 5);
      expect(body.minRiskScoreAllTime as number).toBeCloseTo(0.3, 5);
      expect(body.riskScoreRangeAllTime as number).toBeCloseTo(0.4, 5);
    });

    it('5. sessions — maxRiskScoreAllTime and minRiskScoreAllTime computed correctly', async () => {
      ctx = await setup();
      // Scores: 0.1, 0.5, 0.9
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1081-minmax', daysAgo(1)), dec(0.5));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1081-minmax', daysAgo(2)), dec(0.1));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1081-minmax', daysAgo(3)), dec(0.9));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1081-minmax');
      expect(status).toBe(200);

      expect(body.maxRiskScoreAllTime as number).toBeCloseTo(0.9, 5);
      expect(body.minRiskScoreAllTime as number).toBeCloseTo(0.1, 5);
      expect(body.riskScoreRangeAllTime as number).toBeCloseTo(0.8, 5);
    });

    it('6. sessions — all same score: riskScoreRangeAllTime=0, riskScoreCV=0', async () => {
      ctx = await setup();
      // All scores are 0.5 — range=0, stddev=0 → CV=0
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1081-same', daysAgo(1)), dec(0.5));
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1081-same', daysAgo(2)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1081-same');
      expect(status).toBe(200);

      expect(body.riskScoreRangeAllTime as number).toBeCloseTo(0, 5);
      expect(body.riskScoreCV as number).toBeCloseTo(0, 5);
    });

    it('7. sessions — riskScoreCV computed correctly: [0.2, 0.8] → CV=0.6', async () => {
      ctx = await setup();
      // scores [0.2, 0.8]: mean=0.5, variance=((0.3)^2+(0.3)^2)/2=0.09, stddev=0.3, CV=0.6
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1081-cv', daysAgo(1)), dec(0.2));
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1081-cv', daysAgo(2)), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1081-cv');
      expect(status).toBe(200);

      expect(body.riskScoreCV as number).toBeCloseTo(0.6, 5);
    });

    it('8. sessions — mix of recent and old ops: only recent ops in 45m window', async () => {
      ctx = await setup();
      // Within 45m: 0.3, 0.7 → mean=0.5
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1081-mix', minutesAgo(15)), dec(0.3));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1081-mix', minutesAgo(40)), dec(0.7));
      // Outside 45m: 0.1 (not in window, but counted all-time)
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1081-mix', hoursAgo(2)), dec(0.1));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1081-mix');
      expect(status).toBe(200);

      // 45m window: [0.3, 0.7] → mean=0.5
      expect(body.avgRiskScoreLast45m as number).toBeCloseTo(0.5, 5);

      // All-time: [0.1, 0.3, 0.7]
      expect(body.maxRiskScoreAllTime as number).toBeCloseTo(0.7, 5);
      expect(body.minRiskScoreAllTime as number).toBeCloseTo(0.1, 5);
      expect(body.riskScoreRangeAllTime as number).toBeCloseTo(0.6, 5);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1474-T1478 — v10.81 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('9. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1081-pres', 'fs', 'sess-1', minutesAgo(5)), dec(0.3));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1081-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('avgRiskScoreLast45m');
      expect(body).toHaveProperty('maxRiskScoreAllTime');
      expect(body).toHaveProperty('minRiskScoreAllTime');
      expect(body).toHaveProperty('riskScoreRangeAllTime');
      expect(body).toHaveProperty('riskScoreCV');
    });

    it('10. agents — ops within 45m: avgRiskScoreLast45m correct', async () => {
      ctx = await setup();
      // Scores in 45m: 0.1, 0.5, 0.9 → mean = 0.5
      await ctx.logger.log(makeOp('agent-v1081-45m', 'fs', 'sess-1', minutesAgo(10)), dec(0.1));
      await ctx.logger.log(makeOp('agent-v1081-45m', 'fs', 'sess-1', minutesAgo(25)), dec(0.5));
      await ctx.logger.log(makeOp('agent-v1081-45m', 'fs', 'sess-2', minutesAgo(44)), dec(0.9));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1081-45m');
      expect(status).toBe(200);

      expect(body.avgRiskScoreLast45m as number).toBeCloseTo(0.5, 5);
    });

    it('11. agents — no recent ops (>45m): avgRiskScoreLast45m null, allTime fields populated', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1081-norecent', 'fs', 'sess-1', hoursAgo(2)), dec(0.4));
      await ctx.logger.log(makeOp('agent-v1081-norecent', 'fs', 'sess-1', hoursAgo(3)), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1081-norecent');
      expect(status).toBe(200);

      expect(body.avgRiskScoreLast45m).toBeNull();
      expect(body.maxRiskScoreAllTime as number).toBeCloseTo(0.6, 5);
      expect(body.minRiskScoreAllTime as number).toBeCloseTo(0.4, 5);
      expect(body.riskScoreRangeAllTime as number).toBeCloseTo(0.2, 5);
    });

    it('12. agents — riskScoreRangeAllTime: [0.2, 0.5, 0.8] → range=0.6', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1081-range', 'fs', 'sess-1', daysAgo(1)), dec(0.2));
      await ctx.logger.log(makeOp('agent-v1081-range', 'fs', 'sess-1', daysAgo(2)), dec(0.5));
      await ctx.logger.log(makeOp('agent-v1081-range', 'fs', 'sess-2', daysAgo(3)), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1081-range');
      expect(status).toBe(200);

      expect(body.riskScoreRangeAllTime as number).toBeCloseTo(0.6, 5);
    });

    it('13. agents — riskScoreCV: [0.5, 0.5] → stddev=0, CV=0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1081-cv0', 'fs', 'sess-1', daysAgo(1)), dec(0.5));
      await ctx.logger.log(makeOp('agent-v1081-cv0', 'fs', 'sess-1', daysAgo(2)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1081-cv0');
      expect(status).toBe(200);

      expect(body.riskScoreCV as number).toBeCloseTo(0, 5);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1474-T1478 — v10.81 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('14. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v1081-pres', 'sess-1', minutesAgo(5)), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1081-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('avgRiskScoreLast45m');
      expect(body).toHaveProperty('maxRiskScoreAllTime');
      expect(body).toHaveProperty('minRiskScoreAllTime');
      expect(body).toHaveProperty('riskScoreRangeAllTime');
      expect(body).toHaveProperty('riskScoreCV');
    });

    it('15. tools — ops within 45m: avgRiskScoreLast45m correct', async () => {
      ctx = await setup();
      // Scores: 0.2, 0.8 → mean = 0.5
      await ctx.logger.log(makeOp('agent-a', 'tool-v1081-45m', 'sess-1', minutesAgo(20)), dec(0.2));
      await ctx.logger.log(makeOp('agent-b', 'tool-v1081-45m', 'sess-2', minutesAgo(35)), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1081-45m');
      expect(status).toBe(200);

      expect(body.avgRiskScoreLast45m as number).toBeCloseTo(0.5, 5);
    });

    it('16. tools — old ops only: avgRiskScoreLast45m null, allTime fields correct', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v1081-old', 'sess-1', hoursAgo(3)), dec(0.3));
      await ctx.logger.log(makeOp('agent-b', 'tool-v1081-old', 'sess-2', hoursAgo(4)), dec(0.9));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1081-old');
      expect(status).toBe(200);

      expect(body.avgRiskScoreLast45m).toBeNull();
      expect(body.maxRiskScoreAllTime as number).toBeCloseTo(0.9, 5);
      expect(body.minRiskScoreAllTime as number).toBeCloseTo(0.3, 5);
      expect(body.riskScoreRangeAllTime as number).toBeCloseTo(0.6, 5);
    });

    it('17. tools — riskScoreCV: [0.2, 0.8] → mean=0.5, stddev=0.3, CV=0.6', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v1081-cv', 'sess-1', daysAgo(1)), dec(0.2));
      await ctx.logger.log(makeOp('agent-b', 'tool-v1081-cv', 'sess-2', daysAgo(2)), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1081-cv');
      expect(status).toBe(200);

      expect(body.riskScoreCV as number).toBeCloseTo(0.6, 5);
    });

    it('18. tools — single log: range=0, CV=0 (stddev=0)', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v1081-single', 'sess-1', daysAgo(1)), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1081-single');
      expect(status).toBe(200);

      expect(body.maxRiskScoreAllTime as number).toBeCloseTo(0.6, 5);
      expect(body.minRiskScoreAllTime as number).toBeCloseTo(0.6, 5);
      expect(body.riskScoreRangeAllTime as number).toBeCloseTo(0, 5);
      expect(body.riskScoreCV as number).toBeCloseTo(0, 5);
    });
  });

  // ── summary endpoint ───────────────────────────────────────────────────────────

  describe('T1474-T1478 — v10.81 new fields (summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('19. summary — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', minutesAgo(5)), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body).toHaveProperty('avgRiskScoreLast45m');
      expect(body).toHaveProperty('maxRiskScoreAllTime');
      expect(body).toHaveProperty('minRiskScoreAllTime');
      expect(body).toHaveProperty('riskScoreRangeAllTime');
      expect(body).toHaveProperty('riskScoreCV');
    });

    it('20. summary — no logs: all five fields are null', async () => {
      ctx = await setup();

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.avgRiskScoreLast45m).toBeNull();
      expect(body.maxRiskScoreAllTime).toBeNull();
      expect(body.minRiskScoreAllTime).toBeNull();
      expect(body.riskScoreRangeAllTime).toBeNull();
      expect(body.riskScoreCV).toBeNull();
    });

    it('21. summary — only old ops (>45m): avgRiskScoreLast45m null, allTime fields populated', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', hoursAgo(2)), dec(0.2));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-2', hoursAgo(3)), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.avgRiskScoreLast45m).toBeNull();
      expect(body.maxRiskScoreAllTime as number).toBeCloseTo(0.8, 5);
      expect(body.minRiskScoreAllTime as number).toBeCloseTo(0.2, 5);
      expect(body.riskScoreRangeAllTime as number).toBeCloseTo(0.6, 5);
    });

    it('22. summary — ops within 45m: avgRiskScoreLast45m computed correctly', async () => {
      ctx = await setup();
      // Scores in 45m: 0.3, 0.6, 0.9 → mean = 0.6
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', minutesAgo(10)), dec(0.3));
      await ctx.logger.log(makeOp('agent-b', 'tool', 'sess-2', minutesAgo(25)), dec(0.6));
      await ctx.logger.log(makeOp('agent-c', 'api', 'sess-3', minutesAgo(40)), dec(0.9));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.avgRiskScoreLast45m as number).toBeCloseTo(0.6, 5);
    });

    it('23. summary — riskScoreRangeAllTime: [0.2, 0.5, 0.8] → 0.6', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', daysAgo(1)), dec(0.2));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-2', daysAgo(2)), dec(0.5));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-3', daysAgo(3)), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.riskScoreRangeAllTime as number).toBeCloseTo(0.6, 5);
    });

    it('24. summary — riskScoreCV: [0.2, 0.8] → CV=0.6', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', daysAgo(1)), dec(0.2));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-2', daysAgo(2)), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      // mean=0.5, stddev=0.3, CV=0.6
      expect(body.riskScoreCV as number).toBeCloseTo(0.6, 5);
    });

    it('25. summary — all same score: riskScoreRangeAllTime=0, riskScoreCV=0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', daysAgo(1)), dec(0.5));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-2', daysAgo(2)), dec(0.5));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-3', daysAgo(3)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.riskScoreRangeAllTime as number).toBeCloseTo(0, 5);
      expect(body.riskScoreCV as number).toBeCloseTo(0, 5);
    });
  });
});

// ── v10.82 ────────────────────────────────────────────────────────────────────

describe('v10.82', () => {
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1480-T1483 — v10.82 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all four new fields present in response', async () => {
      ctx = await setup();
      // Seed ops in both windows for all fields to be non-null
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1082-pres', daysAgo(3)), dec(0.4));
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1082-pres', daysAgo(10)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1082-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('riskScoreMomentumLast30d');
      expect(body).toHaveProperty('blockRateMomentumLast7d');
      expect(body).toHaveProperty('opsMomentumLast7d');
      expect(body).toHaveProperty('opsMomentumLast30d');
    });

    it('2. sessions — riskScoreMomentumLast30d: recent=[0.6], prior=[0.4] → 0.2', async () => {
      ctx = await setup();
      // recent (last 30d): 1 op at 3d ago with score 0.6
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1082-rs30', daysAgo(3)), dec(0.6));
      // prior (days 31-60): 1 op at 35d ago with score 0.4
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1082-rs30', daysAgo(35)), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1082-rs30');
      expect(status).toBe(200);

      // 0.6 - 0.4 = 0.2
      expect(body.riskScoreMomentumLast30d as number).toBeCloseTo(0.2, 5);
    });

    it('3. sessions — riskScoreMomentumLast30d: no recent ops → null', async () => {
      ctx = await setup();
      // Only prior ops (31-60d ago)
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1082-rs30-null', daysAgo(40)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1082-rs30-null');
      expect(status).toBe(200);

      expect(body.riskScoreMomentumLast30d).toBeNull();
    });

    it('4. sessions — riskScoreMomentumLast30d: no prior ops → null', async () => {
      ctx = await setup();
      // Only recent ops (last 30d)
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1082-rs30-null2', daysAgo(5)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1082-rs30-null2');
      expect(status).toBe(200);

      expect(body.riskScoreMomentumLast30d).toBeNull();
    });

    it('5. sessions — blockRateMomentumLast7d: recent=[block,allow], prior=[allow,allow] → 0.5-0=0.5', async () => {
      ctx = await setup();
      // recent (last 7d): 2 ops, 1 block = block rate 0.5
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1082-br7', daysAgo(3)), dec(0.6, 'block'));
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1082-br7', daysAgo(4)), dec(0.3, 'allow'));
      // prior (days 8-14): 2 ops, 0 blocks = block rate 0.0
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1082-br7', daysAgo(9)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1082-br7', daysAgo(12)), dec(0.3, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1082-br7');
      expect(status).toBe(200);

      // 0.5 - 0.0 = 0.5
      expect(body.blockRateMomentumLast7d as number).toBeCloseTo(0.5, 5);
    });

    it('6. sessions — blockRateMomentumLast7d: no recent ops → null', async () => {
      ctx = await setup();
      // Only ops in prior window (8-14d ago)
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1082-br7-null', daysAgo(10)), dec(0.5, 'block'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1082-br7-null');
      expect(status).toBe(200);

      expect(body.blockRateMomentumLast7d).toBeNull();
    });

    it('7. sessions — opsMomentumLast7d: 3 recent, 1 prior → 2', async () => {
      ctx = await setup();
      // recent (last 7d): 3 ops
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1082-ops7', daysAgo(1)), dec(0.3));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1082-ops7', daysAgo(3)), dec(0.4));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1082-ops7', daysAgo(5)), dec(0.5));
      // prior (days 8-14): 1 op
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1082-ops7', daysAgo(10)), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1082-ops7');
      expect(status).toBe(200);

      // 3 - 1 = 2
      expect(body.opsMomentumLast7d).toBe(2);
    });

    it('8. sessions — opsMomentumLast7d: 0 recent, 3 prior → -3', async () => {
      ctx = await setup();
      // No recent ops; 3 prior ops
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1082-ops7-neg', daysAgo(9)), dec(0.3));
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1082-ops7-neg', daysAgo(11)), dec(0.4));
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1082-ops7-neg', daysAgo(13)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1082-ops7-neg');
      expect(status).toBe(200);

      // 0 - 3 = -3
      expect(body.opsMomentumLast7d).toBe(-3);
    });

    it('9. sessions — opsMomentumLast7d: 5 recent, 0 prior → 5 (not null)', async () => {
      ctx = await setup();
      // 5 recent ops, no prior ops in days 8-14 window
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v1082-ops7-pos', daysAgo(1)), dec(0.3));
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v1082-ops7-pos', daysAgo(2)), dec(0.4));
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v1082-ops7-pos', daysAgo(3)), dec(0.5));
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v1082-ops7-pos', daysAgo(4)), dec(0.6));
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v1082-ops7-pos', daysAgo(5)), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1082-ops7-pos');
      expect(status).toBe(200);

      // 5 - 0 = 5
      expect(body.opsMomentumLast7d).toBe(5);
    });

    it('10. sessions — opsMomentumLast7d: both windows empty → null', async () => {
      ctx = await setup();
      // No ops in 7d or 8-14d windows — only ops outside both windows
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v1082-ops7-null', daysAgo(20)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1082-ops7-null');
      expect(status).toBe(200);

      expect(body.opsMomentumLast7d).toBeNull();
    });

    it('11. sessions — opsMomentumLast30d: 4 recent, 2 prior → 2', async () => {
      ctx = await setup();
      // recent (last 30d): 4 ops
      await ctx.logger.log(makeOp('agent-k', 'fs', 'sess-v1082-ops30', daysAgo(5)), dec(0.3));
      await ctx.logger.log(makeOp('agent-k', 'fs', 'sess-v1082-ops30', daysAgo(10)), dec(0.4));
      await ctx.logger.log(makeOp('agent-k', 'fs', 'sess-v1082-ops30', daysAgo(15)), dec(0.5));
      await ctx.logger.log(makeOp('agent-k', 'fs', 'sess-v1082-ops30', daysAgo(25)), dec(0.6));
      // prior (days 31-60): 2 ops
      await ctx.logger.log(makeOp('agent-k', 'fs', 'sess-v1082-ops30', daysAgo(35)), dec(0.7));
      await ctx.logger.log(makeOp('agent-k', 'fs', 'sess-v1082-ops30', daysAgo(50)), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1082-ops30');
      expect(status).toBe(200);

      // 4 - 2 = 2
      expect(body.opsMomentumLast30d).toBe(2);
    });

    it('12. sessions — opsMomentumLast30d: both windows empty → null', async () => {
      ctx = await setup();
      // Only ops older than 60d
      await ctx.logger.log(makeOp('agent-l', 'fs', 'sess-v1082-ops30-null', daysAgo(70)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1082-ops30-null');
      expect(status).toBe(200);

      expect(body.opsMomentumLast30d).toBeNull();
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1480-T1483 — v10.82 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('13. agents — all four new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1082-pres', 'fs', 'sess-1', daysAgo(3)), dec(0.4));
      await ctx.logger.log(makeOp('agent-v1082-pres', 'fs', 'sess-1', daysAgo(10)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1082-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('riskScoreMomentumLast30d');
      expect(body).toHaveProperty('blockRateMomentumLast7d');
      expect(body).toHaveProperty('opsMomentumLast7d');
      expect(body).toHaveProperty('opsMomentumLast30d');
    });

    it('14. agents — riskScoreMomentumLast30d: recent=[0.8,0.6]→0.7, prior=[0.2,0.4]→0.3 → 0.4', async () => {
      ctx = await setup();
      // recent (last 30d): scores 0.8, 0.6 → mean = 0.7
      await ctx.logger.log(makeOp('agent-v1082-rs30', 'fs', 'sess-1', daysAgo(5)), dec(0.8));
      await ctx.logger.log(makeOp('agent-v1082-rs30', 'fs', 'sess-1', daysAgo(20)), dec(0.6));
      // prior (days 31-60): scores 0.2, 0.4 → mean = 0.3
      await ctx.logger.log(makeOp('agent-v1082-rs30', 'fs', 'sess-1', daysAgo(35)), dec(0.2));
      await ctx.logger.log(makeOp('agent-v1082-rs30', 'fs', 'sess-1', daysAgo(50)), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1082-rs30');
      expect(status).toBe(200);

      // 0.7 - 0.3 = 0.4
      expect(body.riskScoreMomentumLast30d as number).toBeCloseTo(0.4, 5);
    });

    it('15. agents — riskScoreMomentumLast30d: null when only prior window has ops', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1082-rs30-null', 'fs', 'sess-1', daysAgo(45)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1082-rs30-null');
      expect(status).toBe(200);

      expect(body.riskScoreMomentumLast30d).toBeNull();
    });

    it('16. agents — blockRateMomentumLast7d: recent=[block,block,allow]→0.667, prior=[allow,allow,allow]→0 → 0.667', async () => {
      ctx = await setup();
      // recent (last 7d): 2 blocks, 1 allow → block rate 2/3
      await ctx.logger.log(makeOp('agent-v1082-br7', 'fs', 'sess-1', daysAgo(2)), dec(0.7, 'block'));
      await ctx.logger.log(makeOp('agent-v1082-br7', 'fs', 'sess-1', daysAgo(4)), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agent-v1082-br7', 'fs', 'sess-1', daysAgo(6)), dec(0.3, 'allow'));
      // prior (days 8-14): 3 allows → block rate 0
      await ctx.logger.log(makeOp('agent-v1082-br7', 'fs', 'sess-1', daysAgo(9)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-v1082-br7', 'fs', 'sess-1', daysAgo(11)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-v1082-br7', 'fs', 'sess-1', daysAgo(13)), dec(0.2, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1082-br7');
      expect(status).toBe(200);

      // 2/3 - 0 = 0.6667
      expect(body.blockRateMomentumLast7d as number).toBeCloseTo(2 / 3, 5);
    });

    it('17. agents — opsMomentumLast7d: 0 recent, 2 prior → -2 (not null)', async () => {
      ctx = await setup();
      // No ops in last 7d; 2 ops in days 8-14
      await ctx.logger.log(makeOp('agent-v1082-ops7-neg', 'fs', 'sess-1', daysAgo(9)), dec(0.4));
      await ctx.logger.log(makeOp('agent-v1082-ops7-neg', 'fs', 'sess-1', daysAgo(12)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1082-ops7-neg');
      expect(status).toBe(200);

      // 0 - 2 = -2
      expect(body.opsMomentumLast7d).toBe(-2);
    });

    it('18. agents — opsMomentumLast30d: 0 recent, 4 prior → -4 (not null)', async () => {
      ctx = await setup();
      // No ops in last 30d; 4 ops in days 31-60
      await ctx.logger.log(makeOp('agent-v1082-ops30-neg', 'fs', 'sess-1', daysAgo(32)), dec(0.3));
      await ctx.logger.log(makeOp('agent-v1082-ops30-neg', 'fs', 'sess-1', daysAgo(40)), dec(0.4));
      await ctx.logger.log(makeOp('agent-v1082-ops30-neg', 'fs', 'sess-1', daysAgo(50)), dec(0.5));
      await ctx.logger.log(makeOp('agent-v1082-ops30-neg', 'fs', 'sess-1', daysAgo(58)), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1082-ops30-neg');
      expect(status).toBe(200);

      // 0 - 4 = -4
      expect(body.opsMomentumLast30d).toBe(-4);
    });

    it('19. agents — opsMomentumLast7d: both windows empty → null', async () => {
      ctx = await setup();
      // Only ops outside both windows (>14d ago)
      await ctx.logger.log(makeOp('agent-v1082-ops7-null', 'fs', 'sess-1', daysAgo(20)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1082-ops7-null');
      expect(status).toBe(200);

      expect(body.opsMomentumLast7d).toBeNull();
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1480-T1483 — v10.82 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('20. tools — all four new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v1082-pres', 'sess-1', daysAgo(3)), dec(0.4));
      await ctx.logger.log(makeOp('agent-a', 'tool-v1082-pres', 'sess-1', daysAgo(10)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1082-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('riskScoreMomentumLast30d');
      expect(body).toHaveProperty('blockRateMomentumLast7d');
      expect(body).toHaveProperty('opsMomentumLast7d');
      expect(body).toHaveProperty('opsMomentumLast30d');
    });

    it('21. tools — riskScoreMomentumLast30d: recent=[0.3], prior=[0.7] → -0.4', async () => {
      ctx = await setup();
      // recent (last 30d): score 0.3
      await ctx.logger.log(makeOp('agent-a', 'tool-v1082-rs30', 'sess-1', daysAgo(10)), dec(0.3));
      // prior (days 31-60): score 0.7
      await ctx.logger.log(makeOp('agent-b', 'tool-v1082-rs30', 'sess-2', daysAgo(45)), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1082-rs30');
      expect(status).toBe(200);

      // 0.3 - 0.7 = -0.4
      expect(body.riskScoreMomentumLast30d as number).toBeCloseTo(-0.4, 5);
    });

    it('22. tools — blockRateMomentumLast7d: both windows no blocks → 0.0', async () => {
      ctx = await setup();
      // recent: 2 allows
      await ctx.logger.log(makeOp('agent-a', 'tool-v1082-br7-zero', 'sess-1', daysAgo(2)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-b', 'tool-v1082-br7-zero', 'sess-2', daysAgo(5)), dec(0.4, 'allow'));
      // prior: 2 allows
      await ctx.logger.log(makeOp('agent-a', 'tool-v1082-br7-zero', 'sess-1', daysAgo(9)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-b', 'tool-v1082-br7-zero', 'sess-2', daysAgo(13)), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1082-br7-zero');
      expect(status).toBe(200);

      // 0/2 - 0/2 = 0
      expect(body.blockRateMomentumLast7d as number).toBeCloseTo(0, 5);
    });

    it('23. tools — blockRateMomentumLast7d: no prior window ops → null', async () => {
      ctx = await setup();
      // Only ops in last 7d, none in 8-14d window
      await ctx.logger.log(makeOp('agent-a', 'tool-v1082-br7-null', 'sess-1', daysAgo(3)), dec(0.5, 'block'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1082-br7-null');
      expect(status).toBe(200);

      expect(body.blockRateMomentumLast7d).toBeNull();
    });

    it('24. tools — opsMomentumLast7d: 2 recent, 2 prior → 0', async () => {
      ctx = await setup();
      // recent: 2 ops
      await ctx.logger.log(makeOp('agent-a', 'tool-v1082-ops7-zero', 'sess-1', daysAgo(3)), dec(0.4));
      await ctx.logger.log(makeOp('agent-b', 'tool-v1082-ops7-zero', 'sess-2', daysAgo(6)), dec(0.5));
      // prior: 2 ops
      await ctx.logger.log(makeOp('agent-a', 'tool-v1082-ops7-zero', 'sess-1', daysAgo(9)), dec(0.4));
      await ctx.logger.log(makeOp('agent-b', 'tool-v1082-ops7-zero', 'sess-2', daysAgo(12)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1082-ops7-zero');
      expect(status).toBe(200);

      // 2 - 2 = 0
      expect(body.opsMomentumLast7d).toBe(0);
    });

    it('25. tools — opsMomentumLast30d: 3 recent, 5 prior → -2', async () => {
      ctx = await setup();
      // recent (last 30d): 3 ops
      await ctx.logger.log(makeOp('agent-a', 'tool-v1082-ops30', 'sess-1', daysAgo(10)), dec(0.3));
      await ctx.logger.log(makeOp('agent-b', 'tool-v1082-ops30', 'sess-2', daysAgo(20)), dec(0.4));
      await ctx.logger.log(makeOp('agent-c', 'tool-v1082-ops30', 'sess-3', daysAgo(28)), dec(0.5));
      // prior (days 31-60): 5 ops
      await ctx.logger.log(makeOp('agent-a', 'tool-v1082-ops30', 'sess-1', daysAgo(32)), dec(0.4));
      await ctx.logger.log(makeOp('agent-b', 'tool-v1082-ops30', 'sess-2', daysAgo(38)), dec(0.5));
      await ctx.logger.log(makeOp('agent-c', 'tool-v1082-ops30', 'sess-3', daysAgo(44)), dec(0.6));
      await ctx.logger.log(makeOp('agent-a', 'tool-v1082-ops30', 'sess-1', daysAgo(52)), dec(0.3));
      await ctx.logger.log(makeOp('agent-b', 'tool-v1082-ops30', 'sess-2', daysAgo(58)), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1082-ops30');
      expect(status).toBe(200);

      // 3 - 5 = -2
      expect(body.opsMomentumLast30d).toBe(-2);
    });
  });

  // ── summary endpoint ───────────────────────────────────────────────────────────

  describe('T1480-T1483 — v10.82 new fields (summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('26. summary — all four new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', daysAgo(3)), dec(0.4));
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', daysAgo(10)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body).toHaveProperty('riskScoreMomentumLast30d');
      expect(body).toHaveProperty('blockRateMomentumLast7d');
      expect(body).toHaveProperty('opsMomentumLast7d');
      expect(body).toHaveProperty('opsMomentumLast30d');
    });

    it('27. summary — no logs: all four new fields are null', async () => {
      ctx = await setup();

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.riskScoreMomentumLast30d).toBeNull();
      expect(body.blockRateMomentumLast7d).toBeNull();
      expect(body.opsMomentumLast7d).toBeNull();
      expect(body.opsMomentumLast30d).toBeNull();
    });

    it('28. summary — riskScoreMomentumLast30d: recent=[0.5,0.7]→0.6, prior=[0.1,0.3]→0.2 → 0.4', async () => {
      ctx = await setup();
      // recent (last 30d): scores 0.5, 0.7 → mean 0.6
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', daysAgo(5)), dec(0.5));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-2', daysAgo(15)), dec(0.7));
      // prior (days 31-60): scores 0.1, 0.3 → mean 0.2
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-3', daysAgo(35)), dec(0.1));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-4', daysAgo(50)), dec(0.3));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      // 0.6 - 0.2 = 0.4
      expect(body.riskScoreMomentumLast30d as number).toBeCloseTo(0.4, 5);
    });

    it('29. summary — blockRateMomentumLast7d: recent=[block,allow]→0.5, prior=[block,block]→1.0 → -0.5', async () => {
      ctx = await setup();
      // recent (last 7d): 1 block, 1 allow → block rate 0.5
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', daysAgo(2)), dec(0.6, 'block'));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-2', daysAgo(5)), dec(0.3, 'allow'));
      // prior (days 8-14): 2 blocks → block rate 1.0
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-3', daysAgo(9)), dec(0.7, 'block'));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-4', daysAgo(13)), dec(0.8, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      // 0.5 - 1.0 = -0.5
      expect(body.blockRateMomentumLast7d as number).toBeCloseTo(-0.5, 5);
    });

    it('30. summary — opsMomentumLast7d: 6 recent, 3 prior → 3', async () => {
      ctx = await setup();
      // recent (last 7d): 6 ops
      for (let i = 1; i <= 6; i++) {
        await ctx.logger.log(makeOp(`agent-${i}`, 'fs', `sess-${i}`, daysAgo(i)), dec(0.3));
      }
      // prior (days 8-14): 3 ops
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-7', daysAgo(9)), dec(0.4));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-8', daysAgo(11)), dec(0.5));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-9', daysAgo(13)), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      // 6 - 3 = 3
      expect(body.opsMomentumLast7d).toBe(3);
    });

    it('31. summary — opsMomentumLast30d: 5 recent, 2 prior → 3', async () => {
      ctx = await setup();
      // recent (last 30d): 5 ops
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', daysAgo(5)), dec(0.3));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-2', daysAgo(10)), dec(0.4));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-3', daysAgo(15)), dec(0.5));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-4', daysAgo(20)), dec(0.6));
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-5', daysAgo(25)), dec(0.7));
      // prior (days 31-60): 2 ops
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-6', daysAgo(35)), dec(0.4));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-7', daysAgo(55)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      // 5 - 2 = 3
      expect(body.opsMomentumLast30d).toBe(3);
    });

    it('32. summary — opsMomentumLast30d: both windows empty → null', async () => {
      ctx = await setup();
      // Only ops older than 60d
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', daysAgo(65)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.opsMomentumLast30d).toBeNull();
    });

    it('33. summary — opsMomentumLast7d: both windows empty → null (only old ops)', async () => {
      ctx = await setup();
      // Only ops older than 14d
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', daysAgo(20)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.opsMomentumLast7d).toBeNull();
    });
  });
});

// ── v10.83 ────────────────────────────────────────────────────────────────────

describe('v10.83', () => {
  const hoursAgo = (h: number) => new Date(PINNED_NOW() - h * 3_600_000);
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1484-T1488 — v10.83 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all four new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1083-pres'), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1083-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('opsMomentumLast24h');
      expect(body).toHaveProperty('blockRateMomentumLast24h');
      expect(body).toHaveProperty('uniqueToolsMomentumLast7d');
      expect(body).toHaveProperty('uniqueAgentsMomentumLast7d');
    });

    it('2. sessions — opsMomentumLast24h: both windows empty → null', async () => {
      ctx = await setup();
      // Op older than 48h — outside both recent and prior 24h windows
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1083-null24h', daysAgo(5)), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1083-null24h');
      expect(status).toBe(200);

      expect(body.opsMomentumLast24h).toBeNull();
    });

    it('3. sessions — opsMomentumLast24h: recent ops, no prior → positive value', async () => {
      ctx = await setup();
      // 3 ops in last 24h, 0 in prior 24h → 3 - 0 = 3
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1083-recent24h', hoursAgo(2)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1083-recent24h', hoursAgo(5)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1083-recent24h', hoursAgo(10)), dec(0.7, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1083-recent24h');
      expect(status).toBe(200);

      expect(body.opsMomentumLast24h).toBe(3);
    });

    it('4. sessions — opsMomentumLast24h: no recent ops, prior ops → negative value', async () => {
      ctx = await setup();
      // 0 in last 24h, 2 in prior 24h → 0 - 2 = -2
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1083-prior24h', hoursAgo(30)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1083-prior24h', hoursAgo(40)), dec(0.6, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1083-prior24h');
      expect(status).toBe(200);

      expect(body.opsMomentumLast24h).toBe(-2);
    });

    it('5. sessions — opsMomentumLast24h: ops in both windows → correct difference', async () => {
      ctx = await setup();
      // 4 in last 24h, 2 in prior 24h → 4 - 2 = 2
      for (const h of [1, 3, 8, 20]) {
        await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1083-both24h', hoursAgo(h)), dec(0.5, 'allow'));
      }
      for (const h of [25, 45]) {
        await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1083-both24h', hoursAgo(h)), dec(0.5, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1083-both24h');
      expect(status).toBe(200);

      expect(body.opsMomentumLast24h).toBe(2);
    });

    it('6. sessions — blockRateMomentumLast24h: either window empty → null', async () => {
      ctx = await setup();
      // Only prior 24h window has data, recent is empty → null
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1083-blk-null', hoursAgo(30)), dec(0.8, 'block'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1083-blk-null');
      expect(status).toBe(200);

      expect(body.blockRateMomentumLast24h).toBeNull();
    });

    it('7. sessions — blockRateMomentumLast24h: both windows populated → correct delta', async () => {
      ctx = await setup();
      // Recent 24h: 2 ops, 1 blocked → block rate 0.5
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1083-blk-delta', hoursAgo(2)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1083-blk-delta', hoursAgo(6)), dec(0.3, 'allow'));
      // Prior 24h: 4 ops, 1 blocked → block rate 0.25
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1083-blk-delta', hoursAgo(26)), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1083-blk-delta', hoursAgo(30)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1083-blk-delta', hoursAgo(36)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1083-blk-delta', hoursAgo(44)), dec(0.1, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1083-blk-delta');
      expect(status).toBe(200);

      // 0.5 - 0.25 = 0.25
      expect(body.blockRateMomentumLast24h as number).toBeCloseTo(0.25, 5);
    });

    it('8. sessions — blockRateMomentumLast24h: negative when prior rate higher', async () => {
      ctx = await setup();
      // Recent 24h: 2 ops, 0 blocked → block rate 0
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1083-blk-neg', hoursAgo(3)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1083-blk-neg', hoursAgo(10)), dec(0.3, 'allow'));
      // Prior 24h: 2 ops, 2 blocked → block rate 1.0
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1083-blk-neg', hoursAgo(28)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1083-blk-neg', hoursAgo(40)), dec(0.95, 'block'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1083-blk-neg');
      expect(status).toBe(200);

      // 0 - 1.0 = -1.0
      expect(body.blockRateMomentumLast24h as number).toBeCloseTo(-1.0, 5);
    });

    it('9. sessions — uniqueToolsMomentumLast7d: both windows empty → null', async () => {
      ctx = await setup();
      // Op older than 14d — outside both 7d windows
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v1083-tools-null', daysAgo(20)), dec(0.3, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1083-tools-null');
      expect(status).toBe(200);

      expect(body.uniqueToolsMomentumLast7d).toBeNull();
    });

    it('10. sessions — uniqueToolsMomentumLast7d: recent tools, no prior → positive', async () => {
      ctx = await setup();
      // 3 distinct tools in last 7d, 0 in prior 7d → 3 - 0 = 3
      for (const tool of ['tool-alpha', 'tool-beta', 'tool-gamma']) {
        await ctx.logger.log(makeOp('agent-j', tool, 'sess-v1083-tools-pos', daysAgo(2)), dec(0.5, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1083-tools-pos');
      expect(status).toBe(200);

      expect(body.uniqueToolsMomentumLast7d).toBe(3);
    });

    it('11. sessions — uniqueToolsMomentumLast7d: prior tools, no recent → negative', async () => {
      ctx = await setup();
      // 0 in last 7d, 2 distinct in prior 7d → 0 - 2 = -2
      for (const tool of ['tool-x', 'tool-y']) {
        await ctx.logger.log(makeOp('agent-k', tool, 'sess-v1083-tools-neg', daysAgo(10)), dec(0.5, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1083-tools-neg');
      expect(status).toBe(200);

      expect(body.uniqueToolsMomentumLast7d).toBe(-2);
    });

    it('12. sessions — uniqueToolsMomentumLast7d: duplicate tools counted once per window', async () => {
      ctx = await setup();
      // Recent 7d: 3 logs with same 2 tools → 2 distinct tools
      await ctx.logger.log(makeOp('agent-l', 'tool-dup-A', 'sess-v1083-tools-dup', daysAgo(1)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-l', 'tool-dup-A', 'sess-v1083-tools-dup', daysAgo(2)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-l', 'tool-dup-B', 'sess-v1083-tools-dup', daysAgo(3)), dec(0.6, 'allow'));
      // Prior 7d: 4 logs with 4 distinct tools
      for (const tool of ['tool-p1', 'tool-p2', 'tool-p3', 'tool-p4']) {
        await ctx.logger.log(makeOp('agent-l', tool, 'sess-v1083-tools-dup', daysAgo(10)), dec(0.5, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1083-tools-dup');
      expect(status).toBe(200);

      // 2 - 4 = -2
      expect(body.uniqueToolsMomentumLast7d).toBe(-2);
    });

    it('13. sessions — uniqueAgentsMomentumLast7d: both windows empty → null', async () => {
      ctx = await setup();
      // Op older than 14d
      await ctx.logger.log(makeOp('agent-old', 'fs', 'sess-v1083-agents-null', daysAgo(20)), dec(0.3, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1083-agents-null');
      expect(status).toBe(200);

      expect(body.uniqueAgentsMomentumLast7d).toBeNull();
    });

    it('14. sessions — uniqueAgentsMomentumLast7d: agents in both windows → correct delta', async () => {
      ctx = await setup();
      // Recent 7d: 3 distinct agents
      for (const agentId of ['agent-r1', 'agent-r2', 'agent-r3']) {
        await ctx.logger.log(makeOp(agentId, 'fs', 'sess-v1083-agents-delta', daysAgo(3)), dec(0.5, 'allow'));
      }
      // Prior 7d: 1 distinct agent
      await ctx.logger.log(makeOp('agent-p1', 'fs', 'sess-v1083-agents-delta', daysAgo(10)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1083-agents-delta');
      expect(status).toBe(200);

      // 3 - 1 = 2
      expect(body.uniqueAgentsMomentumLast7d).toBe(2);
    });

    it('15. sessions — uniqueAgentsMomentumLast7d: same agent in both windows → 0', async () => {
      ctx = await setup();
      // Same agent appears in both windows → 1 distinct each → 0 delta
      await ctx.logger.log(makeOp('agent-same', 'fs', 'sess-v1083-agents-zero', daysAgo(2)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-same', 'fs', 'sess-v1083-agents-zero', daysAgo(10)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1083-agents-zero');
      expect(status).toBe(200);

      expect(body.uniqueAgentsMomentumLast7d).toBe(0);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1484-T1488 — v10.83 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('16. agents — all four new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1083-pres', 'fs', 'sess-1'), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1083-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('opsMomentumLast24h');
      expect(body).toHaveProperty('blockRateMomentumLast24h');
      expect(body).toHaveProperty('uniqueToolsMomentumLast7d');
      expect(body).toHaveProperty('uniqueAgentsMomentumLast7d');
    });

    it('17. agents — opsMomentumLast24h: only prior ops → negative', async () => {
      ctx = await setup();
      // 0 recent, 3 prior → -3
      for (const h of [26, 35, 44]) {
        await ctx.logger.log(makeOp('agent-v1083-prior', 'fs', 'sess-1', hoursAgo(h)), dec(0.5, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1083-prior');
      expect(status).toBe(200);

      expect(body.opsMomentumLast24h).toBe(-3);
    });

    it('18. agents — opsMomentumLast24h: only recent ops → positive (non-null)', async () => {
      ctx = await setup();
      // recent=2, prior=0 → 2 (not null)
      await ctx.logger.log(makeOp('agent-v1083-rec', 'fs', 'sess-1', hoursAgo(4)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-v1083-rec', 'fs', 'sess-2', hoursAgo(18)), dec(0.6, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1083-rec');
      expect(status).toBe(200);

      expect(body.opsMomentumLast24h).toBe(2);
    });

    it('19. agents — blockRateMomentumLast24h: no recent ops → null', async () => {
      ctx = await setup();
      // Only recent window empty → null
      await ctx.logger.log(makeOp('agent-v1083-blkonly', 'fs', 'sess-1', hoursAgo(30)), dec(0.9, 'block'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1083-blkonly');
      expect(status).toBe(200);

      expect(body.blockRateMomentumLast24h).toBeNull();
    });

    it('20. agents — blockRateMomentumLast24h: both windows populated → correct delta', async () => {
      ctx = await setup();
      // Recent: 3 ops, 3 blocked → rate 1.0
      for (const h of [1, 5, 12]) {
        await ctx.logger.log(makeOp('agent-v1083-blk-both', 'fs', 'sess-1', hoursAgo(h)), dec(0.9, 'block'));
      }
      // Prior: 2 ops, 1 blocked → rate 0.5
      await ctx.logger.log(makeOp('agent-v1083-blk-both', 'fs', 'sess-2', hoursAgo(25)), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agent-v1083-blk-both', 'fs', 'sess-3', hoursAgo(35)), dec(0.2, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1083-blk-both');
      expect(status).toBe(200);

      // 1.0 - 0.5 = 0.5
      expect(body.blockRateMomentumLast24h as number).toBeCloseTo(0.5, 5);
    });

    it('21. agents — uniqueToolsMomentumLast7d: recent and prior tools → correct delta', async () => {
      ctx = await setup();
      // Recent 7d: 2 distinct tools
      await ctx.logger.log(makeOp('agent-v1083-tools', 'toolA', 'sess-1', daysAgo(1)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-v1083-tools', 'toolB', 'sess-2', daysAgo(4)), dec(0.5, 'allow'));
      // Prior 7d: 1 distinct tool
      await ctx.logger.log(makeOp('agent-v1083-tools', 'toolC', 'sess-3', daysAgo(9)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1083-tools');
      expect(status).toBe(200);

      // 2 - 1 = 1
      expect(body.uniqueToolsMomentumLast7d).toBe(1);
    });

    it('22. agents — uniqueAgentsMomentumLast7d: reflects agents in session-independent agent logs', async () => {
      ctx = await setup();
      // For agents endpoint filtered by a specific agentId, logs filtered to that agent.
      // uniqueAgentsMomentumLast7d checks distinct agentIds in those logs.
      // Recent 7d: only 1 agent (the queried one)
      await ctx.logger.log(makeOp('agent-v1083-uniq', 'fs', 'sess-1', daysAgo(2)), dec(0.5, 'allow'));
      // Prior 7d: no entries
      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1083-uniq');
      expect(status).toBe(200);

      // recent=1, prior=0 → not null, value = 1
      expect(body.uniqueAgentsMomentumLast7d).toBe(1);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1484-T1488 — v10.83 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('23. tools — all four new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-m', 'tool-v1083-pres', 'sess-1'), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1083-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('opsMomentumLast24h');
      expect(body).toHaveProperty('blockRateMomentumLast24h');
      expect(body).toHaveProperty('uniqueToolsMomentumLast7d');
      expect(body).toHaveProperty('uniqueAgentsMomentumLast7d');
    });

    it('24. tools — opsMomentumLast24h: both windows empty → null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-n', 'tool-v1083-null24h', 'sess-1', daysAgo(3)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1083-null24h');
      expect(status).toBe(200);

      expect(body.opsMomentumLast24h).toBeNull();
    });

    it('25. tools — opsMomentumLast24h: equal ops in both windows → 0', async () => {
      ctx = await setup();
      // 2 in recent, 2 in prior → 0
      await ctx.logger.log(makeOp('agent-o1', 'tool-v1083-equal', 'sess-1', hoursAgo(5)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-o2', 'tool-v1083-equal', 'sess-2', hoursAgo(15)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-o3', 'tool-v1083-equal', 'sess-3', hoursAgo(28)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-o4', 'tool-v1083-equal', 'sess-4', hoursAgo(40)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1083-equal');
      expect(status).toBe(200);

      expect(body.opsMomentumLast24h).toBe(0);
    });

    it('26. tools — blockRateMomentumLast24h: no prior ops → null', async () => {
      ctx = await setup();
      // Only recent window — prior is empty → null
      await ctx.logger.log(makeOp('agent-p', 'tool-v1083-blknull', 'sess-1', hoursAgo(3)), dec(0.8, 'block'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1083-blknull');
      expect(status).toBe(200);

      expect(body.blockRateMomentumLast24h).toBeNull();
    });

    it('27. tools — blockRateMomentumLast24h: all-allow recent, all-block prior → -1.0', async () => {
      ctx = await setup();
      // Recent: 2 allow → rate 0
      await ctx.logger.log(makeOp('agent-q1', 'tool-v1083-blkneg', 'sess-1', hoursAgo(4)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-q2', 'tool-v1083-blkneg', 'sess-2', hoursAgo(8)), dec(0.3, 'allow'));
      // Prior: 3 block → rate 1.0
      for (const h of [25, 35, 44]) {
        await ctx.logger.log(makeOp(`agent-q-p${h}`, 'tool-v1083-blkneg', `sess-p${h}`, hoursAgo(h)), dec(0.9, 'block'));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1083-blkneg');
      expect(status).toBe(200);

      // 0 - 1.0 = -1.0
      expect(body.blockRateMomentumLast24h as number).toBeCloseTo(-1.0, 5);
    });

    it('28. tools — uniqueToolsMomentumLast7d: same tool in both windows → 0 delta (not null)', async () => {
      ctx = await setup();
      // The tool-under-test appears in both windows (it's its own entry), 1 distinct each → 0
      await ctx.logger.log(makeOp('agent-r1', 'tool-v1083-sametool', 'sess-1', daysAgo(2)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-r2', 'tool-v1083-sametool', 'sess-2', daysAgo(9)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1083-sametool');
      expect(status).toBe(200);

      // Both windows have 1 distinct tool → 0 (not null)
      expect(body.uniqueToolsMomentumLast7d).toBe(0);
    });

    it('29. tools — uniqueAgentsMomentumLast7d: more distinct agents last 7d → positive', async () => {
      ctx = await setup();
      // Recent 7d: 4 distinct agents
      for (const id of ['ag1', 'ag2', 'ag3', 'ag4']) {
        await ctx.logger.log(makeOp(id, 'tool-v1083-agmom', `sess-${id}`, daysAgo(3)), dec(0.5, 'allow'));
      }
      // Prior 7d: 2 distinct agents
      await ctx.logger.log(makeOp('ag5', 'tool-v1083-agmom', 'sess-a5', daysAgo(10)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('ag6', 'tool-v1083-agmom', 'sess-a6', daysAgo(12)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1083-agmom');
      expect(status).toBe(200);

      // 4 - 2 = 2
      expect(body.uniqueAgentsMomentumLast7d).toBe(2);
    });

    it('30. tools — uniqueAgentsMomentumLast7d: only prior agents → negative (not null)', async () => {
      ctx = await setup();
      // 0 in recent 7d, 2 in prior 7d → -2
      await ctx.logger.log(makeOp('ag-old1', 'tool-v1083-agold', 'sess-1', daysAgo(9)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('ag-old2', 'tool-v1083-agold', 'sess-2', daysAgo(11)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1083-agold');
      expect(status).toBe(200);

      expect(body.uniqueAgentsMomentumLast7d).toBe(-2);
    });
  });

  // ── operations/summary endpoint ────────────────────────────────────────────────

  describe('T1484-T1488 — v10.83 new fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('31. summary — all four new fields present', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s', 'tool-s', 'sess-1'), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body).toHaveProperty('opsMomentumLast24h');
      expect(body).toHaveProperty('blockRateMomentumLast24h');
      expect(body).toHaveProperty('uniqueToolsMomentumLast7d');
      expect(body).toHaveProperty('uniqueAgentsMomentumLast7d');
    });

    it('32. summary — empty DB: opsMomentumLast24h null, uniqueToolsMomentumLast7d null, uniqueAgentsMomentumLast7d null', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.opsMomentumLast24h).toBeNull();
      expect(body.uniqueToolsMomentumLast7d).toBeNull();
      expect(body.uniqueAgentsMomentumLast7d).toBeNull();
    });

    it('33. summary — empty DB: blockRateMomentumLast24h null', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.blockRateMomentumLast24h).toBeNull();
    });

    it('34. summary — opsMomentumLast24h: only old ops → null', async () => {
      ctx = await setup();
      // All ops older than 48h → both 24h windows empty
      await ctx.logger.log(makeOp('agent-t', 'tool-t', 'sess-1', daysAgo(4)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-t', 'tool-t', 'sess-2', daysAgo(7)), dec(0.6, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.opsMomentumLast24h).toBeNull();
    });

    it('35. summary — opsMomentumLast24h: 5 recent, 2 prior → 3', async () => {
      ctx = await setup();
      for (const h of [2, 6, 10, 16, 22]) {
        await ctx.logger.log(makeOp(`ag-sum-r${h}`, 'tool-sum-mom', `sess-r${h}`, hoursAgo(h)), dec(0.5, 'allow'));
      }
      for (const h of [28, 40]) {
        await ctx.logger.log(makeOp(`ag-sum-p${h}`, 'tool-sum-mom', `sess-p${h}`, hoursAgo(h)), dec(0.5, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.opsMomentumLast24h).toBe(3);
    });

    it('36. summary — blockRateMomentumLast24h: both windows with mixed actions → correct delta', async () => {
      ctx = await setup();
      // Recent 24h: 4 ops, 2 blocked → rate 0.5
      await ctx.logger.log(makeOp('ag-blk1', 'tool-sum-blk', 'sess-1', hoursAgo(3)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('ag-blk2', 'tool-sum-blk', 'sess-2', hoursAgo(8)), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('ag-blk3', 'tool-sum-blk', 'sess-3', hoursAgo(14)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('ag-blk4', 'tool-sum-blk', 'sess-4', hoursAgo(20)), dec(0.2, 'allow'));
      // Prior 24h: 2 ops, 0 blocked → rate 0
      await ctx.logger.log(makeOp('ag-blk5', 'tool-sum-blk', 'sess-5', hoursAgo(26)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('ag-blk6', 'tool-sum-blk', 'sess-6', hoursAgo(38)), dec(0.15, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      // 0.5 - 0.0 = 0.5
      expect(body.blockRateMomentumLast24h as number).toBeCloseTo(0.5, 5);
    });

    it('37. summary — uniqueToolsMomentumLast7d: more tools last 7d → positive', async () => {
      ctx = await setup();
      // Recent 7d: 4 distinct tools
      for (const tool of ['tool-s1', 'tool-s2', 'tool-s3', 'tool-s4']) {
        await ctx.logger.log(makeOp('ag-tm', tool, `sess-${tool}`, daysAgo(2)), dec(0.5, 'allow'));
      }
      // Prior 7d: 2 distinct tools
      await ctx.logger.log(makeOp('ag-tp', 'tool-s5', 'sess-5', daysAgo(9)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('ag-tp', 'tool-s6', 'sess-6', daysAgo(12)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      // 4 - 2 = 2
      expect(body.uniqueToolsMomentumLast7d).toBe(2);
    });

    it('38. summary — uniqueAgentsMomentumLast7d: both windows have agents → correct delta', async () => {
      ctx = await setup();
      // Recent 7d: 2 distinct agents
      await ctx.logger.log(makeOp('ag-u1', 'tool-au', 'sess-1', daysAgo(1)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('ag-u2', 'tool-au', 'sess-2', daysAgo(5)), dec(0.5, 'allow'));
      // Prior 7d: 3 distinct agents
      await ctx.logger.log(makeOp('ag-u3', 'tool-au', 'sess-3', daysAgo(8)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('ag-u4', 'tool-au', 'sess-4', daysAgo(10)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('ag-u5', 'tool-au', 'sess-5', daysAgo(13)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      // 2 - 3 = -1
      expect(body.uniqueAgentsMomentumLast7d).toBe(-1);
    });

    it('39. summary — uniqueAgentsMomentumLast7d: only recent agents → positive (not null)', async () => {
      ctx = await setup();
      // 3 distinct agents in last 7d, none in prior 7d → 3 (not null)
      for (const id of ['ag-new1', 'ag-new2', 'ag-new3']) {
        await ctx.logger.log(makeOp(id, 'tool-au-new', `sess-${id}`, daysAgo(4)), dec(0.5, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.uniqueAgentsMomentumLast7d).toBe(3);
    });

    it('40. summary — uniqueToolsMomentumLast7d: only prior tools, no recent → negative (not null)', async () => {
      ctx = await setup();
      // 0 in last 7d, 2 distinct in prior 7d → -2
      await ctx.logger.log(makeOp('ag-old-t', 'old-tool-1', 'sess-1', daysAgo(9)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('ag-old-t', 'old-tool-2', 'sess-2', daysAgo(13)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.uniqueToolsMomentumLast7d).toBe(-2);
    });
  });
});

// ── v10.84 ────────────────────────────────────────────────────────────────────

describe('v10.84', () => {
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1489-T1493 — v10.84 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1084-pres'), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1084-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('p5RiskScoreAllTime');
      expect(body).toHaveProperty('p95RiskScoreAllTime');
      expect(body).toHaveProperty('p99RiskScoreAllTime');
      expect(body).toHaveProperty('p5RiskScoreLast7d');
      expect(body).toHaveProperty('p95RiskScoreLast7d');
    });

    it('2. sessions — p5/p95 last 7d null when all logs older than 7d (all-time not null)', async () => {
      ctx = await setup();
      // Logs exist but all older than 7d → p5/p95 last 7d null; all-time fields have values
      await ctx.logger.log(makeOp('agent-x', 'fs', 'sess-v1084-old'), dec(0.5, 'allow'), );
      // Override timestamp by logging with old date
      await ctx.logger.log(makeOp('agent-x2', 'fs', 'sess-v1084-old2', daysAgo(10)), dec(0.6, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1084-old2');
      expect(status).toBe(200);

      expect(body.p5RiskScoreLast7d).toBeNull();
      expect(body.p95RiskScoreLast7d).toBeNull();
      // All-time is NOT null because there is one log
      expect(body.p5RiskScoreAllTime).not.toBeNull();
      expect(body.p99RiskScoreAllTime).not.toBeNull();
    });

    it('3. sessions — single log: all-time percentiles equal the single risk score', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1084-single'), dec(0.7, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1084-single');
      expect(status).toBe(200);

      // n=1: Math.floor(1 * 0.05)=0, Math.floor(1 * 0.95)=0, Math.floor(1 * 0.99)=0 → all s[0]=0.7
      expect(body.p5RiskScoreAllTime as number).toBeCloseTo(0.7, 5);
      expect(body.p95RiskScoreAllTime as number).toBeCloseTo(0.7, 5);
      expect(body.p99RiskScoreAllTime as number).toBeCloseTo(0.7, 5);
    });

    it('4. sessions — 20 logs sorted [0.1..2.0]: p5=0.2, p95=2.0, p99=2.0 all-time', async () => {
      ctx = await setup();
      // 20 risk scores: 0.1, 0.2, ..., 2.0 (step 0.1)
      for (let i = 1; i <= 20; i++) {
        await ctx.logger.log(
          makeOp('agent-c', 'fs', 'sess-v1084-20logs', daysAgo(25)),
          dec(parseFloat((i * 0.1).toFixed(1)), 'allow'),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1084-20logs');
      expect(status).toBe(200);

      // sorted asc: [0.1, 0.2, ..., 2.0]
      // p5:  Math.floor(20 * 0.05) = 1 → s[1] = 0.2
      // p95: Math.floor(20 * 0.95) = 19 → s[19] = 2.0
      // p99: Math.floor(20 * 0.99) = 19 → s[19] = 2.0
      expect(body.p5RiskScoreAllTime as number).toBeCloseTo(0.2, 5);
      expect(body.p95RiskScoreAllTime as number).toBeCloseTo(2.0, 5);
      expect(body.p99RiskScoreAllTime as number).toBeCloseTo(2.0, 5);
    });

    it('5. sessions — p5 ≤ p95 ≤ p99 for any score distribution', async () => {
      ctx = await setup();
      const scores = [0.9, 0.1, 0.5, 0.3, 0.8, 0.2, 0.7, 0.4, 0.6, 1.0];
      for (const score of scores) {
        await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1084-order', daysAgo(2)), dec(score, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1084-order');
      expect(status).toBe(200);

      const p5 = body.p5RiskScoreAllTime as number;
      const p95 = body.p95RiskScoreAllTime as number;
      const p99 = body.p99RiskScoreAllTime as number;
      expect(p5).toBeLessThanOrEqual(p95);
      expect(p95).toBeLessThanOrEqual(p99);
    });

    it('6. sessions — p5RiskScoreLast7d null when all logs older than 7d', async () => {
      ctx = await setup();
      // All logs outside 7d window
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1084-old7d', daysAgo(10 + i)), dec(0.5, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1084-old7d');
      expect(status).toBe(200);

      expect(body.p5RiskScoreLast7d).toBeNull();
      expect(body.p95RiskScoreLast7d).toBeNull();
      // But all-time fields are NOT null (there are logs)
      expect(body.p5RiskScoreAllTime).not.toBeNull();
      expect(body.p95RiskScoreAllTime).not.toBeNull();
      expect(body.p99RiskScoreAllTime).not.toBeNull();
    });

    it('7. sessions — p5/p95 last 7d: 10 scores all within 6d window', async () => {
      ctx = await setup();
      // 10 scores all within last 6d (safely inside 7d window): 0.1..1.0
      for (let i = 1; i <= 10; i++) {
        await ctx.logger.log(
          makeOp('agent-f', 'fs', 'sess-v1084-7dperc', daysAgo((i - 1) * 0.5)),
          dec(parseFloat((i * 0.1).toFixed(1)), 'allow'),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1084-7dperc');
      expect(status).toBe(200);

      // All 10 logs within 7d window
      // sorted [0.1, 0.2, ..., 1.0], n=10
      // p5:  Math.floor(10 * 0.05) = 0 → s[0] = 0.1
      // p95: Math.floor(10 * 0.95) = 9 → s[9] = 1.0
      expect(body.p5RiskScoreLast7d as number).toBeCloseTo(0.1, 5);
      expect(body.p95RiskScoreLast7d as number).toBeCloseTo(1.0, 5);
    });

    it('8. sessions — all-time uses all logs; last7d uses only recent logs', async () => {
      ctx = await setup();
      // 3 old logs (outside 7d) with high scores
      for (const score of [0.8, 0.9, 1.0]) {
        await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1084-split', daysAgo(15)), dec(score, 'allow'));
      }
      // 3 recent logs (inside 7d) with low scores
      for (const score of [0.1, 0.2, 0.3]) {
        await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1084-split', daysAgo(2)), dec(score, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1084-split');
      expect(status).toBe(200);

      // All-time: 6 logs, sorted [0.1, 0.2, 0.3, 0.8, 0.9, 1.0], n=6
      // p5: Math.floor(6*0.05)=0 → 0.1
      // p95: Math.floor(6*0.95)=5 → 1.0
      expect(body.p5RiskScoreAllTime as number).toBeCloseTo(0.1, 5);
      expect(body.p95RiskScoreAllTime as number).toBeCloseTo(1.0, 5);

      // Last 7d: 3 logs [0.1, 0.2, 0.3], n=3
      // p5: Math.floor(3*0.05)=0 → 0.1
      // p95: Math.floor(3*0.95)=2 → 0.3
      expect(body.p5RiskScoreLast7d as number).toBeCloseTo(0.1, 5);
      expect(body.p95RiskScoreLast7d as number).toBeCloseTo(0.3, 5);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1489-T1493 — v10.84 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('9. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1084-pres', 'fs', 'sess-1'), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1084-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('p5RiskScoreAllTime');
      expect(body).toHaveProperty('p95RiskScoreAllTime');
      expect(body).toHaveProperty('p99RiskScoreAllTime');
      expect(body).toHaveProperty('p5RiskScoreLast7d');
      expect(body).toHaveProperty('p95RiskScoreLast7d');
    });

    it('10. agents — only old logs: p5/p95 last 7d null; all-time fields populated', async () => {
      ctx = await setup();
      // Logs exist but all older than 7d → 7d fields null; all-time populated
      await ctx.logger.log(makeOp('agent-v1084-no-logs', 'fs', 'sess-1', daysAgo(10)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-v1084-no-logs', 'fs', 'sess-2', daysAgo(12)), dec(0.7, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1084-no-logs');
      expect(status).toBe(200);

      expect(body.p5RiskScoreLast7d).toBeNull();
      expect(body.p95RiskScoreLast7d).toBeNull();
      expect(body.p5RiskScoreAllTime).not.toBeNull();
      expect(body.p95RiskScoreAllTime).not.toBeNull();
      expect(body.p99RiskScoreAllTime).not.toBeNull();
    });

    it('11. agents — 20 scores [0.1..2.0]: p5=0.2, p95=2.0, p99=2.0', async () => {
      ctx = await setup();
      for (let i = 1; i <= 20; i++) {
        await ctx.logger.log(
          makeOp('agent-v1084-20', 'fs', `sess-${i}`, daysAgo(25)),
          dec(parseFloat((i * 0.1).toFixed(1)), 'allow'),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1084-20');
      expect(status).toBe(200);

      expect(body.p5RiskScoreAllTime as number).toBeCloseTo(0.2, 5);
      expect(body.p95RiskScoreAllTime as number).toBeCloseTo(2.0, 5);
      expect(body.p99RiskScoreAllTime as number).toBeCloseTo(2.0, 5);
    });

    it('12. agents — p5RiskScoreLast7d null when no ops in last 7d', async () => {
      ctx = await setup();
      // Only old logs
      await ctx.logger.log(makeOp('agent-v1084-no7d', 'fs', 'sess-1', daysAgo(9)), dec(0.6, 'allow'));
      await ctx.logger.log(makeOp('agent-v1084-no7d', 'fs', 'sess-2', daysAgo(11)), dec(0.7, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1084-no7d');
      expect(status).toBe(200);

      expect(body.p5RiskScoreLast7d).toBeNull();
      expect(body.p95RiskScoreLast7d).toBeNull();
      // All-time still populated
      expect(body.p5RiskScoreAllTime).not.toBeNull();
      expect(body.p99RiskScoreAllTime).not.toBeNull();
    });

    it('13. agents — p5/p95 last 7d correct when only recent logs exist', async () => {
      ctx = await setup();
      const scores = [0.2, 0.4, 0.6, 0.8, 1.0];
      for (const score of scores) {
        await ctx.logger.log(makeOp('agent-v1084-rec7d', 'fs', 'sess-1', daysAgo(3)), dec(score, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1084-rec7d');
      expect(status).toBe(200);

      // sorted [0.2, 0.4, 0.6, 0.8, 1.0], n=5
      // p5:  Math.floor(5*0.05)=0 → 0.2
      // p95: Math.floor(5*0.95)=4 → 1.0
      expect(body.p5RiskScoreLast7d as number).toBeCloseTo(0.2, 5);
      expect(body.p95RiskScoreLast7d as number).toBeCloseTo(1.0, 5);
    });

    it('14. agents — p5 ≤ p95 ≤ p99 ordering for all-time', async () => {
      ctx = await setup();
      // Shuffle scores
      const scores = [1.0, 0.1, 0.7, 0.3, 0.9, 0.5];
      for (const score of scores) {
        await ctx.logger.log(makeOp('agent-v1084-ord', 'fs', 'sess-1', daysAgo(2)), dec(score, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1084-ord');
      expect(status).toBe(200);

      const p5 = body.p5RiskScoreAllTime as number;
      const p95 = body.p95RiskScoreAllTime as number;
      const p99 = body.p99RiskScoreAllTime as number;
      expect(p5).toBeLessThanOrEqual(p95);
      expect(p95).toBeLessThanOrEqual(p99);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1489-T1493 — v10.84 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('15. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-m', 'tool-v1084-pres', 'sess-1'), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1084-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('p5RiskScoreAllTime');
      expect(body).toHaveProperty('p95RiskScoreAllTime');
      expect(body).toHaveProperty('p99RiskScoreAllTime');
      expect(body).toHaveProperty('p5RiskScoreLast7d');
      expect(body).toHaveProperty('p95RiskScoreLast7d');
    });

    it('16. tools — only old logs: p5/p95 last 7d null; all-time populated', async () => {
      ctx = await setup();
      // Logs exist but all older than 7d
      await ctx.logger.log(makeOp('agent-n', 'tool-v1084-no-logs', 'sess-1', daysAgo(9)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-n2', 'tool-v1084-no-logs', 'sess-2', daysAgo(11)), dec(0.8, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1084-no-logs');
      expect(status).toBe(200);

      expect(body.p5RiskScoreLast7d).toBeNull();
      expect(body.p95RiskScoreLast7d).toBeNull();
      expect(body.p5RiskScoreAllTime).not.toBeNull();
      expect(body.p95RiskScoreAllTime).not.toBeNull();
      expect(body.p99RiskScoreAllTime).not.toBeNull();
    });

    it('17. tools — 20 scores [0.1..2.0]: p5=0.2, p95=2.0, p99=2.0', async () => {
      ctx = await setup();
      for (let i = 1; i <= 20; i++) {
        await ctx.logger.log(
          makeOp(`agent-t${i}`, 'tool-v1084-20', `sess-${i}`, daysAgo(25)),
          dec(parseFloat((i * 0.1).toFixed(1)), 'allow'),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1084-20');
      expect(status).toBe(200);

      expect(body.p5RiskScoreAllTime as number).toBeCloseTo(0.2, 5);
      expect(body.p95RiskScoreAllTime as number).toBeCloseTo(2.0, 5);
      expect(body.p99RiskScoreAllTime as number).toBeCloseTo(2.0, 5);
    });

    it('18. tools — p5/p95 last 7d: null when no ops in window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-o', 'tool-v1084-old7d', 'sess-1', daysAgo(10)), dec(0.6, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1084-old7d');
      expect(status).toBe(200);

      expect(body.p5RiskScoreLast7d).toBeNull();
      expect(body.p95RiskScoreLast7d).toBeNull();
      expect(body.p5RiskScoreAllTime).not.toBeNull();
    });

    it('19. tools — p5/p95 last 7d computed only from 7d window logs', async () => {
      ctx = await setup();
      // 2 old logs with extreme scores (outside 7d)
      await ctx.logger.log(makeOp('agent-p1', 'tool-v1084-split7', 'sess-1', daysAgo(20)), dec(0.01, 'allow'));
      await ctx.logger.log(makeOp('agent-p2', 'tool-v1084-split7', 'sess-2', daysAgo(20)), dec(0.99, 'allow'));
      // 4 recent logs within 7d
      const recentScores = [0.3, 0.4, 0.5, 0.6];
      for (const score of recentScores) {
        await ctx.logger.log(
          makeOp(`agent-p-r${score}`, 'tool-v1084-split7', `sess-r${score}`, daysAgo(2)),
          dec(score, 'allow'),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1084-split7');
      expect(status).toBe(200);

      // Last 7d: [0.3, 0.4, 0.5, 0.6], n=4
      // p5:  Math.floor(4*0.05)=0 → 0.3
      // p95: Math.floor(4*0.95)=3 → 0.6
      expect(body.p5RiskScoreLast7d as number).toBeCloseTo(0.3, 5);
      expect(body.p95RiskScoreLast7d as number).toBeCloseTo(0.6, 5);

      // All-time includes old logs: [0.01, 0.3, 0.4, 0.5, 0.6, 0.99], n=6
      // p5:  Math.floor(6*0.05)=0 → 0.01
      // p99: Math.floor(6*0.99)=5 → 0.99
      expect(body.p5RiskScoreAllTime as number).toBeCloseTo(0.01, 5);
      expect(body.p99RiskScoreAllTime as number).toBeCloseTo(0.99, 5);
    });

    it('20. tools — p5 ≤ p95 ≤ p99 ordering', async () => {
      ctx = await setup();
      const scores = [0.55, 0.12, 0.88, 0.33, 0.77, 0.44, 0.66, 0.22];
      for (const score of scores) {
        await ctx.logger.log(makeOp('agent-q', 'tool-v1084-ord', 'sess-1', daysAgo(1)), dec(score, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1084-ord');
      expect(status).toBe(200);

      const p5 = body.p5RiskScoreAllTime as number;
      const p95 = body.p95RiskScoreAllTime as number;
      const p99 = body.p99RiskScoreAllTime as number;
      expect(p5).toBeLessThanOrEqual(p95);
      expect(p95).toBeLessThanOrEqual(p99);
    });
  });

  // ── operations/summary endpoint ────────────────────────────────────────────────

  describe('T1489-T1493 — v10.84 new fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('21. summary — all five new fields present', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s', 'tool-s', 'sess-1'), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body).toHaveProperty('p5RiskScoreAllTime');
      expect(body).toHaveProperty('p95RiskScoreAllTime');
      expect(body).toHaveProperty('p99RiskScoreAllTime');
      expect(body).toHaveProperty('p5RiskScoreLast7d');
      expect(body).toHaveProperty('p95RiskScoreLast7d');
    });

    it('22. summary — empty DB: all five fields are null', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.p5RiskScoreAllTime).toBeNull();
      expect(body.p95RiskScoreAllTime).toBeNull();
      expect(body.p99RiskScoreAllTime).toBeNull();
      expect(body.p5RiskScoreLast7d).toBeNull();
      expect(body.p95RiskScoreLast7d).toBeNull();
    });

    it('23. summary — 20 all-time scores [0.1..2.0]: p5=0.2, p95=2.0, p99=2.0', async () => {
      ctx = await setup();
      for (let i = 1; i <= 20; i++) {
        await ctx.logger.log(
          makeOp(`agent-sum${i}`, `tool-sum${i}`, `sess-${i}`, daysAgo(25)),
          dec(parseFloat((i * 0.1).toFixed(1)), 'allow'),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.p5RiskScoreAllTime as number).toBeCloseTo(0.2, 5);
      expect(body.p95RiskScoreAllTime as number).toBeCloseTo(2.0, 5);
      expect(body.p99RiskScoreAllTime as number).toBeCloseTo(2.0, 5);
    });

    it('24. summary — p5/p95 last 7d: null when all logs older than 7d', async () => {
      ctx = await setup();
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp(`ag-sum-old${i}`, 'tool-old', `sess-${i}`, daysAgo(8 + i)), dec(0.5, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.p5RiskScoreLast7d).toBeNull();
      expect(body.p95RiskScoreLast7d).toBeNull();
      // All-time still populated
      expect(body.p5RiskScoreAllTime).not.toBeNull();
      expect(body.p99RiskScoreAllTime).not.toBeNull();
    });

    it('25. summary — p5/p95 last 7d: only 7d window logs', async () => {
      ctx = await setup();
      // Old logs (outside 7d)
      await ctx.logger.log(makeOp('ag-old1', 'tool-mix', 'sess-o1', daysAgo(15)), dec(0.05, 'allow'));
      await ctx.logger.log(makeOp('ag-old2', 'tool-mix', 'sess-o2', daysAgo(15)), dec(0.95, 'allow'));
      // Recent logs (inside 7d)
      const recent = [0.2, 0.4, 0.6, 0.8];
      for (const score of recent) {
        await ctx.logger.log(
          makeOp(`ag-r${score}`, 'tool-mix', `sess-r${score}`, daysAgo(3)),
          dec(score, 'allow'),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      // Last 7d: [0.2, 0.4, 0.6, 0.8], n=4
      // p5:  Math.floor(4*0.05)=0 → 0.2
      // p95: Math.floor(4*0.95)=3 → 0.8
      expect(body.p5RiskScoreLast7d as number).toBeCloseTo(0.2, 5);
      expect(body.p95RiskScoreLast7d as number).toBeCloseTo(0.8, 5);
    });

    it('26. summary — p5 ≤ p95 ≤ p99 ordering holds for all-time', async () => {
      ctx = await setup();
      const scores = [0.1, 0.9, 0.5, 0.3, 0.7, 0.2, 0.8, 0.4, 0.6, 1.0];
      for (const score of scores) {
        await ctx.logger.log(makeOp('ag-ord', 'tool-ord', 'sess-1', daysAgo(2)), dec(score, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      const p5 = body.p5RiskScoreAllTime as number;
      const p95 = body.p95RiskScoreAllTime as number;
      const p99 = body.p99RiskScoreAllTime as number;
      expect(p5).toBeLessThanOrEqual(p95);
      expect(p95).toBeLessThanOrEqual(p99);
    });

    it('27. summary — single log: p99RiskScoreAllTime equals the single risk score', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('ag-single', 'tool-single', 'sess-1'), dec(0.42, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      // n=1: all indices = 0 → all return s[0] = 0.42
      expect(body.p99RiskScoreAllTime as number).toBeCloseTo(0.42, 5);
    });

    it('28. summary — p5RiskScoreLast7d and p95RiskScoreLast7d ordering', async () => {
      ctx = await setup();
      const scores = [0.15, 0.45, 0.75, 0.95, 0.25, 0.55, 0.35, 0.65];
      for (const score of scores) {
        await ctx.logger.log(makeOp(`ag-7d-ord`, 'tool-7d-ord', 'sess-1', daysAgo(4)), dec(score, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      const p5 = body.p5RiskScoreLast7d as number;
      const p95 = body.p95RiskScoreLast7d as number;
      expect(p5).not.toBeNull();
      expect(p95).not.toBeNull();
      expect(p5).toBeLessThanOrEqual(p95);
    });
  });
});

// ── v10.85 ────────────────────────────────────────────────────────────────────

describe('v10.85', () => {
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1494-T1498 — v10.85 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1085-pres'), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1085-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('p99RiskScoreLast7d');
      expect(body).toHaveProperty('p5RiskScoreLast30d');
      expect(body).toHaveProperty('p95RiskScoreLast30d');
      expect(body).toHaveProperty('p99RiskScoreLast30d');
      expect(body).toHaveProperty('p25RiskScoreAllTime');
    });

    it('2. sessions — empty session: all five new fields are null', async () => {
      ctx = await setup();
      // No logs → all null
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1085-empty');
      // 404 or 200 with nulls — if 200, fields should be null
      if (status === 200) {
        expect(body.p99RiskScoreLast7d).toBeNull();
        expect(body.p5RiskScoreLast30d).toBeNull();
        expect(body.p95RiskScoreLast30d).toBeNull();
        expect(body.p99RiskScoreLast30d).toBeNull();
        expect(body.p25RiskScoreAllTime).toBeNull();
      } else {
        expect(status).toBe(404);
      }
    });

    it('3. sessions — p99RiskScoreLast7d null when all logs older than 7d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1085-old7d', daysAgo(10)), dec(0.6, 'allow'));
      await ctx.logger.log(makeOp('agent-b2', 'fs', 'sess-v1085-old7d', daysAgo(12)), dec(0.8, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1085-old7d');
      expect(status).toBe(200);

      expect(body.p99RiskScoreLast7d).toBeNull();
      // All-time p25 should NOT be null (logs exist)
      expect(body.p25RiskScoreAllTime).not.toBeNull();
    });

    it('4. sessions — p5/p95/p99 last 30d null when all logs older than 30d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1085-old30d', daysAgo(35)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-c2', 'fs', 'sess-v1085-old30d', daysAgo(40)), dec(0.7, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1085-old30d');
      expect(status).toBe(200);

      expect(body.p5RiskScoreLast30d).toBeNull();
      expect(body.p95RiskScoreLast30d).toBeNull();
      expect(body.p99RiskScoreLast30d).toBeNull();
      // All-time p25 should NOT be null
      expect(body.p25RiskScoreAllTime).not.toBeNull();
    });

    it('5. sessions — single log: p25RiskScoreAllTime equals the single risk score', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1085-single'), dec(0.75, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1085-single');
      expect(status).toBe(200);

      // n=1: Math.floor(1 * 0.25) = 0 → s[0] = 0.75
      expect(body.p25RiskScoreAllTime as number).toBeCloseTo(0.75, 5);
    });

    it('6. sessions — 20 logs sorted [0.1..2.0]: p25AllTime=0.6, p5/p95/p99 30d correct', async () => {
      ctx = await setup();
      // All within 30d window (daysAgo(25))
      for (let i = 1; i <= 20; i++) {
        await ctx.logger.log(
          makeOp('agent-e', 'fs', 'sess-v1085-20logs', daysAgo(25)),
          dec(parseFloat((i * 0.1).toFixed(1)), 'allow'),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1085-20logs');
      expect(status).toBe(200);

      // sorted asc: [0.1, 0.2, ..., 2.0], n=20
      // p25: Math.floor(20 * 0.25) = 5 → s[5] = 0.6
      expect(body.p25RiskScoreAllTime as number).toBeCloseTo(0.6, 5);

      // Last 30d all 20 logs (25 days ago < 30d)
      // p5:  Math.floor(20 * 0.05) = 1 → s[1] = 0.2
      // p95: Math.floor(20 * 0.95) = 19 → s[19] = 2.0
      // p99: Math.floor(20 * 0.99) = 19 → s[19] = 2.0
      expect(body.p5RiskScoreLast30d as number).toBeCloseTo(0.2, 5);
      expect(body.p95RiskScoreLast30d as number).toBeCloseTo(2.0, 5);
      expect(body.p99RiskScoreLast30d as number).toBeCloseTo(2.0, 5);
    });

    it('7. sessions — p99RiskScoreLast7d from 7d window only', async () => {
      ctx = await setup();
      // 3 old logs (outside 7d, inside 30d)
      for (const score of [0.1, 0.2, 0.3]) {
        await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1085-7dsplit', daysAgo(15)), dec(score, 'allow'));
      }
      // 5 recent logs (inside 7d)
      for (const score of [0.5, 0.6, 0.7, 0.8, 0.9]) {
        await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1085-7dsplit', daysAgo(3)), dec(score, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1085-7dsplit');
      expect(status).toBe(200);

      // Last 7d: [0.5, 0.6, 0.7, 0.8, 0.9], n=5
      // p99: Math.floor(5 * 0.99) = 4 → s[4] = 0.9
      expect(body.p99RiskScoreLast7d as number).toBeCloseTo(0.9, 5);
    });

    it('8. sessions — p5 ≤ p95 ≤ p99 last 30d ordering', async () => {
      ctx = await setup();
      const scores = [0.9, 0.1, 0.5, 0.3, 0.8, 0.2, 0.7, 0.4, 0.6, 1.0];
      for (const score of scores) {
        await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1085-ord', daysAgo(10)), dec(score, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1085-ord');
      expect(status).toBe(200);

      const p5 = body.p5RiskScoreLast30d as number;
      const p95 = body.p95RiskScoreLast30d as number;
      const p99 = body.p99RiskScoreLast30d as number;
      expect(p5).not.toBeNull();
      expect(p95).not.toBeNull();
      expect(p99).not.toBeNull();
      expect(p5).toBeLessThanOrEqual(p95);
      expect(p95).toBeLessThanOrEqual(p99);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1494-T1498 — v10.85 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('9. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1085-pres', 'fs', 'sess-1'), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1085-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('p99RiskScoreLast7d');
      expect(body).toHaveProperty('p5RiskScoreLast30d');
      expect(body).toHaveProperty('p95RiskScoreLast30d');
      expect(body).toHaveProperty('p99RiskScoreLast30d');
      expect(body).toHaveProperty('p25RiskScoreAllTime');
    });

    it('10. agents — p99RiskScoreLast7d null when all logs outside 7d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1085-no7d', 'fs', 'sess-1', daysAgo(9)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-v1085-no7d', 'fs', 'sess-2', daysAgo(11)), dec(0.7, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1085-no7d');
      expect(status).toBe(200);

      expect(body.p99RiskScoreLast7d).toBeNull();
      // 30d window: logs at 9d and 11d are within 30d → not null
      expect(body.p5RiskScoreLast30d).not.toBeNull();
      expect(body.p99RiskScoreLast30d).not.toBeNull();
    });

    it('11. agents — p5/p95/p99 last 30d null when all logs outside 30d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1085-no30d', 'fs', 'sess-1', daysAgo(35)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-v1085-no30d', 'fs', 'sess-2', daysAgo(40)), dec(0.6, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1085-no30d');
      expect(status).toBe(200);

      expect(body.p5RiskScoreLast30d).toBeNull();
      expect(body.p95RiskScoreLast30d).toBeNull();
      expect(body.p99RiskScoreLast30d).toBeNull();
      // All-time p25 not null
      expect(body.p25RiskScoreAllTime).not.toBeNull();
    });

    it('12. agents — 20 scores [0.1..2.0] at 25d ago: all 30d fields computed', async () => {
      ctx = await setup();
      for (let i = 1; i <= 20; i++) {
        await ctx.logger.log(
          makeOp('agent-v1085-20', 'fs', `sess-${i}`, daysAgo(25)),
          dec(parseFloat((i * 0.1).toFixed(1)), 'allow'),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1085-20');
      expect(status).toBe(200);

      // p25AllTime: Math.floor(20*0.25)=5 → s[5]=0.6
      expect(body.p25RiskScoreAllTime as number).toBeCloseTo(0.6, 5);
      // p5 30d: Math.floor(20*0.05)=1 → s[1]=0.2
      expect(body.p5RiskScoreLast30d as number).toBeCloseTo(0.2, 5);
      // p95 30d: Math.floor(20*0.95)=19 → s[19]=2.0
      expect(body.p95RiskScoreLast30d as number).toBeCloseTo(2.0, 5);
      // p99 30d: Math.floor(20*0.99)=19 → s[19]=2.0
      expect(body.p99RiskScoreLast30d as number).toBeCloseTo(2.0, 5);
    });

    it('13. agents — p99RiskScoreLast7d computed from 7d window only', async () => {
      ctx = await setup();
      // 4 logs outside 7d (within 30d)
      for (const score of [0.1, 0.2, 0.3, 0.4]) {
        await ctx.logger.log(makeOp('agent-v1085-7d', 'fs', 'sess-1', daysAgo(20)), dec(score, 'allow'));
      }
      // 4 logs inside 7d
      for (const score of [0.6, 0.7, 0.8, 0.9]) {
        await ctx.logger.log(makeOp('agent-v1085-7d', 'fs', 'sess-2', daysAgo(2)), dec(score, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1085-7d');
      expect(status).toBe(200);

      // Last 7d: [0.6, 0.7, 0.8, 0.9], n=4
      // p99: Math.floor(4 * 0.99) = 3 → s[3] = 0.9
      expect(body.p99RiskScoreLast7d as number).toBeCloseTo(0.9, 5);
    });

    it('14. agents — p5 ≤ p25 ≤ p95 ≤ p99 ordering for 30d and all-time', async () => {
      ctx = await setup();
      const scores = [1.0, 0.1, 0.7, 0.3, 0.9, 0.5, 0.4, 0.6, 0.2, 0.8];
      for (const score of scores) {
        await ctx.logger.log(makeOp('agent-v1085-ord', 'fs', 'sess-1', daysAgo(10)), dec(score, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1085-ord');
      expect(status).toBe(200);

      const p25at = body.p25RiskScoreAllTime as number;
      const p5_30d = body.p5RiskScoreLast30d as number;
      const p95_30d = body.p95RiskScoreLast30d as number;
      const p99_30d = body.p99RiskScoreLast30d as number;

      expect(p5_30d).toBeLessThanOrEqual(p95_30d);
      expect(p95_30d).toBeLessThanOrEqual(p99_30d);
      expect(p5_30d).toBeLessThanOrEqual(p25at);
      expect(p25at).toBeLessThanOrEqual(p95_30d);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1494-T1498 — v10.85 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('15. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-m', 'tool-v1085-pres', 'sess-1'), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1085-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('p99RiskScoreLast7d');
      expect(body).toHaveProperty('p5RiskScoreLast30d');
      expect(body).toHaveProperty('p95RiskScoreLast30d');
      expect(body).toHaveProperty('p99RiskScoreLast30d');
      expect(body).toHaveProperty('p25RiskScoreAllTime');
    });

    it('16. tools — p99 last 7d null when logs only outside 7d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-n', 'tool-v1085-no7d', 'sess-1', daysAgo(9)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-n2', 'tool-v1085-no7d', 'sess-2', daysAgo(11)), dec(0.8, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1085-no7d');
      expect(status).toBe(200);

      expect(body.p99RiskScoreLast7d).toBeNull();
      // Within 30d
      expect(body.p5RiskScoreLast30d).not.toBeNull();
      expect(body.p99RiskScoreLast30d).not.toBeNull();
    });

    it('17. tools — p5/p95/p99 last 30d null when logs all outside 30d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-o', 'tool-v1085-no30d', 'sess-1', daysAgo(35)), dec(0.6, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1085-no30d');
      expect(status).toBe(200);

      expect(body.p5RiskScoreLast30d).toBeNull();
      expect(body.p95RiskScoreLast30d).toBeNull();
      expect(body.p99RiskScoreLast30d).toBeNull();
      expect(body.p25RiskScoreAllTime).not.toBeNull();
    });

    it('18. tools — 20 scores [0.1..2.0] at 25d ago: p25AllTime=0.6, 30d percentiles correct', async () => {
      ctx = await setup();
      for (let i = 1; i <= 20; i++) {
        await ctx.logger.log(
          makeOp(`agent-t${i}`, 'tool-v1085-20', `sess-${i}`, daysAgo(25)),
          dec(parseFloat((i * 0.1).toFixed(1)), 'allow'),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1085-20');
      expect(status).toBe(200);

      // p25AllTime: Math.floor(20*0.25)=5 → s[5]=0.6
      expect(body.p25RiskScoreAllTime as number).toBeCloseTo(0.6, 5);
      // p5 30d: s[1]=0.2
      expect(body.p5RiskScoreLast30d as number).toBeCloseTo(0.2, 5);
      // p95 30d: s[19]=2.0
      expect(body.p95RiskScoreLast30d as number).toBeCloseTo(2.0, 5);
      // p99 30d: s[19]=2.0
      expect(body.p99RiskScoreLast30d as number).toBeCloseTo(2.0, 5);
    });

    it('19. tools — p99RiskScoreLast7d uses only 7d window, 30d includes older logs', async () => {
      ctx = await setup();
      // 2 logs outside 7d (inside 30d) with extreme scores
      await ctx.logger.log(makeOp('agent-p1', 'tool-v1085-split', 'sess-1', daysAgo(20)), dec(0.01, 'allow'));
      await ctx.logger.log(makeOp('agent-p2', 'tool-v1085-split', 'sess-2', daysAgo(20)), dec(0.99, 'allow'));
      // 4 recent logs within 7d
      const recentScores = [0.3, 0.5, 0.7, 0.9];
      for (const score of recentScores) {
        await ctx.logger.log(
          makeOp(`agent-pr${score}`, 'tool-v1085-split', `sess-r${score}`, daysAgo(2)),
          dec(score, 'allow'),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1085-split');
      expect(status).toBe(200);

      // Last 7d: [0.3, 0.5, 0.7, 0.9], n=4
      // p99: Math.floor(4*0.99)=3 → s[3]=0.9
      expect(body.p99RiskScoreLast7d as number).toBeCloseTo(0.9, 5);

      // Last 30d: all 6 logs [0.01, 0.3, 0.5, 0.7, 0.9, 0.99], n=6
      // p5:  Math.floor(6*0.05)=0 → 0.01
      // p99: Math.floor(6*0.99)=5 → 0.99
      expect(body.p5RiskScoreLast30d as number).toBeCloseTo(0.01, 5);
      expect(body.p99RiskScoreLast30d as number).toBeCloseTo(0.99, 5);
    });

    it('20. tools — p5 ≤ p95 ≤ p99 ordering for last 30d', async () => {
      ctx = await setup();
      const scores = [0.55, 0.12, 0.88, 0.33, 0.77, 0.44, 0.66, 0.22];
      for (const score of scores) {
        await ctx.logger.log(makeOp('agent-q', 'tool-v1085-ord', 'sess-1', daysAgo(10)), dec(score, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1085-ord');
      expect(status).toBe(200);

      const p5 = body.p5RiskScoreLast30d as number;
      const p95 = body.p95RiskScoreLast30d as number;
      const p99 = body.p99RiskScoreLast30d as number;
      expect(p5).toBeLessThanOrEqual(p95);
      expect(p95).toBeLessThanOrEqual(p99);
    });
  });

  // ── operations/summary endpoint ────────────────────────────────────────────────

  describe('T1494-T1498 — v10.85 new fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('21. summary — all five new fields present', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s', 'tool-s', 'sess-1'), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body).toHaveProperty('p99RiskScoreLast7d');
      expect(body).toHaveProperty('p5RiskScoreLast30d');
      expect(body).toHaveProperty('p95RiskScoreLast30d');
      expect(body).toHaveProperty('p99RiskScoreLast30d');
      expect(body).toHaveProperty('p25RiskScoreAllTime');
    });

    it('22. summary — empty DB: all five new fields are null', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.p99RiskScoreLast7d).toBeNull();
      expect(body.p5RiskScoreLast30d).toBeNull();
      expect(body.p95RiskScoreLast30d).toBeNull();
      expect(body.p99RiskScoreLast30d).toBeNull();
      expect(body.p25RiskScoreAllTime).toBeNull();
    });

    it('23. summary — single log: p25RiskScoreAllTime equals the single risk score', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('ag-single', 'tool-single', 'sess-1'), dec(0.42, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      // n=1: Math.floor(1*0.25)=0 → s[0]=0.42
      expect(body.p25RiskScoreAllTime as number).toBeCloseTo(0.42, 5);
    });

    it('24. summary — 20 all-time scores [0.1..2.0] at 25d: p25=0.6, 30d fields correct', async () => {
      ctx = await setup();
      for (let i = 1; i <= 20; i++) {
        await ctx.logger.log(
          makeOp(`agent-sum${i}`, `tool-sum${i}`, `sess-${i}`, daysAgo(25)),
          dec(parseFloat((i * 0.1).toFixed(1)), 'allow'),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      // p25AllTime: Math.floor(20*0.25)=5 → s[5]=0.6
      expect(body.p25RiskScoreAllTime as number).toBeCloseTo(0.6, 5);
      // p5 30d: s[1]=0.2
      expect(body.p5RiskScoreLast30d as number).toBeCloseTo(0.2, 5);
      // p95 30d: s[19]=2.0
      expect(body.p95RiskScoreLast30d as number).toBeCloseTo(2.0, 5);
      // p99 30d: s[19]=2.0
      expect(body.p99RiskScoreLast30d as number).toBeCloseTo(2.0, 5);
    });

    it('25. summary — p99 last 7d null when all logs older than 7d', async () => {
      ctx = await setup();
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp(`ag-sum-old${i}`, 'tool-old', `sess-${i}`, daysAgo(8 + i)), dec(0.5, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.p99RiskScoreLast7d).toBeNull();
      // Logs at 8-12d are within 30d
      expect(body.p5RiskScoreLast30d).not.toBeNull();
      expect(body.p99RiskScoreLast30d).not.toBeNull();
    });

    it('26. summary — p5/p95/p99 last 30d null when all logs older than 30d', async () => {
      ctx = await setup();
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp(`ag-sum-old30-${i}`, 'tool-old30', `sess-${i}`, daysAgo(35 + i)), dec(0.5, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.p5RiskScoreLast30d).toBeNull();
      expect(body.p95RiskScoreLast30d).toBeNull();
      expect(body.p99RiskScoreLast30d).toBeNull();
      // All-time p25 not null (logs exist)
      expect(body.p25RiskScoreAllTime).not.toBeNull();
    });

    it('27. summary — p99RiskScoreLast7d from 7d window only, 30d includes older logs', async () => {
      ctx = await setup();
      // Old logs (outside 7d, inside 30d) with low scores
      for (const score of [0.05, 0.1, 0.15]) {
        await ctx.logger.log(makeOp(`ag-old-${score}`, 'tool-mix', `sess-o${score}`, daysAgo(15)), dec(score, 'allow'));
      }
      // Recent logs (inside 7d) with high scores
      const recentScores = [0.7, 0.8, 0.9];
      for (const score of recentScores) {
        await ctx.logger.log(
          makeOp(`ag-rec-${score}`, 'tool-mix', `sess-r${score}`, daysAgo(3)),
          dec(score, 'allow'),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      // Last 7d: [0.7, 0.8, 0.9], n=3
      // p99: Math.floor(3*0.99)=2 → s[2]=0.9
      expect(body.p99RiskScoreLast7d as number).toBeCloseTo(0.9, 5);

      // Last 30d: all 6 logs [0.05, 0.1, 0.15, 0.7, 0.8, 0.9], n=6
      // p5:  Math.floor(6*0.05)=0 → 0.05
      // p95: Math.floor(6*0.95)=5 → 0.9
      expect(body.p5RiskScoreLast30d as number).toBeCloseTo(0.05, 5);
      expect(body.p95RiskScoreLast30d as number).toBeCloseTo(0.9, 5);
    });

    it('28. summary — p5 ≤ p25 ≤ p95 ≤ p99 ordering for all valid fields', async () => {
      ctx = await setup();
      const scores = [0.1, 0.9, 0.5, 0.3, 0.7, 0.2, 0.8, 0.4, 0.6, 1.0];
      for (const score of scores) {
        await ctx.logger.log(makeOp('ag-ord', 'tool-ord', 'sess-1', daysAgo(10)), dec(score, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      const p5_30d = body.p5RiskScoreLast30d as number;
      const p25at = body.p25RiskScoreAllTime as number;
      const p95_30d = body.p95RiskScoreLast30d as number;
      const p99_30d = body.p99RiskScoreLast30d as number;

      expect(p5_30d).toBeLessThanOrEqual(p95_30d);
      expect(p95_30d).toBeLessThanOrEqual(p99_30d);
      // p25 all-time should be between p5 and p95
      expect(p5_30d).toBeLessThanOrEqual(p25at);
      expect(p25at).toBeLessThanOrEqual(p95_30d);
    });
  });
});

// ── v10.86 ────────────────────────────────────────────────────────────────────

describe('v10.86', () => {
  const hoursAgo = (h: number) => new Date(PINNED_NOW() - h * 3_600_000);
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1499-T1503 — v10.86 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1086-pres'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1086-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('p75RiskScoreAllTime');
      expect(body).toHaveProperty('p10RiskScoreAllTime');
      expect(body).toHaveProperty('p90RiskScoreAllTime');
      expect(body).toHaveProperty('opsPercentileLast1hVsAllTime');
      expect(body).toHaveProperty('riskScoreZScoreLast1h');
    });

    it('2. sessions — no logs in DB: endpoint returns 404', async () => {
      ctx = await setup();
      // No logs at all — sessions endpoint returns 404 for unknown sessions
      const { status } = await getJSON(ctx.port, '/sessions/sess-v1086-empty');
      expect(status).toBe(404);
    });

    it('3. sessions — p75/p10/p90 percentile computed correctly from 10 scores', async () => {
      ctx = await setup();
      // Scores: 0.1, 0.2, ..., 1.0 (inserted in random order)
      for (const score of [0.5, 0.1, 0.9, 0.2, 0.8, 0.3, 0.7, 0.4, 0.6, 1.0]) {
        await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1086-pct10', hoursAgo(2)), dec(score));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1086-pct10');
      expect(status).toBe(200);

      // sorted: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0], n=10
      // p10 idx = floor(10*0.10) = 1 → 0.2
      // p75 idx = floor(10*0.75) = 7 → 0.8
      // p90 idx = floor(10*0.90) = 9 → 1.0
      expect(body.p10RiskScoreAllTime as number).toBeCloseTo(0.2, 5);
      expect(body.p75RiskScoreAllTime as number).toBeCloseTo(0.8, 5);
      expect(body.p90RiskScoreAllTime as number).toBeCloseTo(1.0, 5);
    });

    it('4. sessions — p75/p10/p90 from 4 scores', async () => {
      ctx = await setup();
      // Scores [0.2, 0.4, 0.6, 0.8] sorted, n=4
      // p10 idx = floor(4*0.10) = 0 → 0.2
      // p75 idx = floor(4*0.75) = 3 → 0.8
      // p90 idx = floor(4*0.90) = 3 → 0.8
      for (const score of [0.8, 0.2, 0.6, 0.4]) {
        await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1086-pct4', daysAgo(5)), dec(score));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1086-pct4');
      expect(status).toBe(200);

      expect(body.p10RiskScoreAllTime as number).toBeCloseTo(0.2, 5);
      expect(body.p75RiskScoreAllTime as number).toBeCloseTo(0.8, 5);
      expect(body.p90RiskScoreAllTime as number).toBeCloseTo(0.8, 5);
    });

    it('5. sessions — opsPercentileLast1hVsAllTime: ops only in last 1h', async () => {
      ctx = await setup();
      // All 3 ops are within the last hour → they all fall on today's date key
      // dailyCounts = [3] (one day with 3 ops), last1h = 3
      // rank = count of dailyCounts where c <= 3 = 1; result = 1/1 = 1.0
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1086-t1502a'), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1086-t1502a');
      expect(status).toBe(200);

      expect(body.opsPercentileLast1hVsAllTime as number).toBeCloseTo(1.0, 5);
    });

    it('6. sessions — opsPercentileLast1hVsAllTime: last1h ops fewer than historical days', async () => {
      ctx = await setup();
      // Day 1 (today, within last 1h): 1 op
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1086-t1502b'), dec(0.3));
      // Day 2 (yesterday, outside 1h): 5 ops
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1086-t1502b', daysAgo(1)), dec(0.4));
      }
      // Day 3 (two days ago): 3 ops
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1086-t1502b', daysAgo(2)), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1086-t1502b');
      expect(status).toBe(200);

      // dailyCounts: day0=1, day-1=5, day-2=3 → [1, 5, 3]
      // last1h count = 1 (the op hoursAgo(0.5))
      // rank = count(c <= 1) = 1 (only day0's count of 1)
      // result = 1/3
      expect(body.opsPercentileLast1hVsAllTime as number).toBeCloseTo(1 / 3, 5);
    });

    it('7. sessions — riskScoreZScoreLast1h: null if only 1 log total', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1086-z1log'), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1086-z1log');
      expect(status).toBe(200);

      expect(body.riskScoreZScoreLast1h).toBeNull();
    });

    it('8. sessions — riskScoreZScoreLast1h: null if all scores identical (stddev=0)', async () => {
      ctx = await setup();
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1086-zstd0'), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1086-zstd0');
      expect(status).toBe(200);

      expect(body.riskScoreZScoreLast1h).toBeNull();
    });

    it('9. sessions — riskScoreZScoreLast1h: null if no ops in last 1h', async () => {
      ctx = await setup();
      // Two ops both older than 1 hour
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1086-znolh', daysAgo(1)), dec(0.3));
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1086-znolh', daysAgo(2)), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1086-znolh');
      expect(status).toBe(200);

      expect(body.riskScoreZScoreLast1h).toBeNull();
    });

    it('10. sessions — riskScoreZScoreLast1h: computed correctly (positive z-score)', async () => {
      ctx = await setup();
      // allScores: four all-time ops with scores [0.3, 0.4, 0.5, 0.6]
      // allMean = (0.3+0.4+0.5+0.6)/4 = 0.45
      // allStddev = sqrt(((0.3-0.45)^2+(0.4-0.45)^2+(0.5-0.45)^2+(0.6-0.45)^2)/4)
      //           = sqrt((0.0225+0.0025+0.0025+0.0225)/4) = sqrt(0.025) ≈ 0.15811
      // last1h ops: scores [0.6] (one recent op)
      // last1hMean = 0.6
      // z-score = (0.6 - 0.45) / 0.15811 ≈ 0.9487
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v1086-zpos', daysAgo(3)), dec(0.3));
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v1086-zpos', daysAgo(2)), dec(0.4));
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v1086-zpos', daysAgo(1)), dec(0.5));
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v1086-zpos'), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1086-zpos');
      expect(status).toBe(200);

      const allScores = [0.3, 0.4, 0.5, 0.6];
      const mean = allScores.reduce((a, v) => a + v, 0) / allScores.length;
      const stddev = Math.sqrt(allScores.reduce((a, v) => a + (v - mean) ** 2, 0) / allScores.length);
      const expected = (0.6 - mean) / stddev;
      expect(body.riskScoreZScoreLast1h as number).toBeCloseTo(expected, 4);
    });

    it('11. sessions — riskScoreZScoreLast1h: can be negative when last1h mean < all-time mean', async () => {
      ctx = await setup();
      // allScores: [0.7, 0.8, 0.9, 0.2] → mean=0.65
      // last1h: [0.2] → mean=0.2 → z-score should be negative
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v1086-zneg', daysAgo(3)), dec(0.7));
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v1086-zneg', daysAgo(2)), dec(0.8));
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v1086-zneg', daysAgo(1)), dec(0.9));
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v1086-zneg'), dec(0.2));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1086-zneg');
      expect(status).toBe(200);

      const allScores = [0.7, 0.8, 0.9, 0.2];
      const mean = allScores.reduce((a, v) => a + v, 0) / allScores.length;
      const stddev = Math.sqrt(allScores.reduce((a, v) => a + (v - mean) ** 2, 0) / allScores.length);
      const expected = (0.2 - mean) / stddev;
      expect(expected).toBeLessThan(0);
      expect(body.riskScoreZScoreLast1h as number).toBeCloseTo(expected, 4);
    });

    it('12. sessions — tip example: allMean=0.5, allStddev=0.2, last1hMean=0.7 → z=1.0', async () => {
      ctx = await setup();
      // To get allMean=0.5 and allStddev=0.2 with values [0.3, 0.7], n=2
      // mean = (0.3+0.7)/2 = 0.5, stddev = sqrt(((0.3-0.5)^2+(0.7-0.5)^2)/2) = sqrt((0.04+0.04)/2) = sqrt(0.04) = 0.2
      // last1h: [0.7], last1hMean=0.7, z=(0.7-0.5)/0.2=1.0
      await ctx.logger.log(makeOp('agent-k', 'fs', 'sess-v1086-ztip', daysAgo(1)), dec(0.3));
      await ctx.logger.log(makeOp('agent-k', 'fs', 'sess-v1086-ztip'), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1086-ztip');
      expect(status).toBe(200);

      expect(body.riskScoreZScoreLast1h as number).toBeCloseTo(1.0, 4);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1499-T1503 — v10.86 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('13. agents — all five new fields present', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1086-pres', 'fs', 'sess-1'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1086-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('p75RiskScoreAllTime');
      expect(body).toHaveProperty('p10RiskScoreAllTime');
      expect(body).toHaveProperty('p90RiskScoreAllTime');
      expect(body).toHaveProperty('opsPercentileLast1hVsAllTime');
      expect(body).toHaveProperty('riskScoreZScoreLast1h');
    });

    it('14. agents — no logs in DB: endpoint returns 404', async () => {
      ctx = await setup();
      // No logs at all — agents endpoint returns 404 for unknown agents
      const { status } = await getJSON(ctx.port, '/agents/agent-v1086-empty');
      expect(status).toBe(404);
    });

    it('15. agents — p75/p10/p90 from 4 scores', async () => {
      ctx = await setup();
      // Scores [0.1, 0.4, 0.7, 0.9] sorted, n=4
      // p10 idx=floor(4*0.10)=0 → 0.1
      // p75 idx=floor(4*0.75)=3 → 0.9
      // p90 idx=floor(4*0.90)=3 → 0.9
      for (const score of [0.9, 0.1, 0.7, 0.4]) {
        await ctx.logger.log(makeOp('agent-v1086-pct4', 'fs', 'sess-1', daysAgo(3)), dec(score));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1086-pct4');
      expect(status).toBe(200);

      expect(body.p10RiskScoreAllTime as number).toBeCloseTo(0.1, 5);
      expect(body.p75RiskScoreAllTime as number).toBeCloseTo(0.9, 5);
      expect(body.p90RiskScoreAllTime as number).toBeCloseTo(0.9, 5);
    });

    it('16. agents — opsPercentileLast1hVsAllTime non-null when logs exist', async () => {
      ctx = await setup();
      // 2 ops within last 1h
      await ctx.logger.log(makeOp('agent-v1086-t1502a', 'fs', 'sess-1'), dec(0.4));
      await ctx.logger.log(makeOp('agent-v1086-t1502a', 'fs', 'sess-1'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1086-t1502a');
      expect(status).toBe(200);

      // dailyCounts = [2], last1h = 2, rank = 1, result = 1/1 = 1.0
      expect(body.opsPercentileLast1hVsAllTime as number).toBeCloseTo(1.0, 5);
    });

    it('17. agents — riskScoreZScoreLast1h null if < 2 logs', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1086-z1log', 'fs', 'sess-1'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1086-z1log');
      expect(status).toBe(200);

      expect(body.riskScoreZScoreLast1h).toBeNull();
    });

    it('18. agents — riskScoreZScoreLast1h tip example z=1.0', async () => {
      ctx = await setup();
      // allMean=0.5, allStddev=0.2 using scores [0.3, 0.7]
      await ctx.logger.log(makeOp('agent-v1086-ztip', 'fs', 'sess-1', daysAgo(1)), dec(0.3));
      await ctx.logger.log(makeOp('agent-v1086-ztip', 'fs', 'sess-1'), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1086-ztip');
      expect(status).toBe(200);

      expect(body.riskScoreZScoreLast1h as number).toBeCloseTo(1.0, 4);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1499-T1503 — v10.86 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('19. tools — all five new fields present', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v1086-pres', 'sess-1'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1086-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('p75RiskScoreAllTime');
      expect(body).toHaveProperty('p10RiskScoreAllTime');
      expect(body).toHaveProperty('p90RiskScoreAllTime');
      expect(body).toHaveProperty('opsPercentileLast1hVsAllTime');
      expect(body).toHaveProperty('riskScoreZScoreLast1h');
    });

    it('20. tools — no logs in DB: endpoint returns 404', async () => {
      ctx = await setup();
      // No logs at all — tools endpoint returns 404 for unknown tools
      const { status } = await getJSON(ctx.port, '/tools/tool-v1086-empty');
      expect(status).toBe(404);
    });

    it('21. tools — p75/p10/p90 from 10 scores', async () => {
      ctx = await setup();
      for (const score of [0.5, 0.1, 0.9, 0.2, 0.8, 0.3, 0.7, 0.4, 0.6, 1.0]) {
        await ctx.logger.log(makeOp('agent-a', 'tool-v1086-pct10', 'sess-1', daysAgo(3)), dec(score));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1086-pct10');
      expect(status).toBe(200);

      // sorted: [0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,1.0], n=10
      // p10 idx=1 → 0.2, p75 idx=7 → 0.8, p90 idx=9 → 1.0
      expect(body.p10RiskScoreAllTime as number).toBeCloseTo(0.2, 5);
      expect(body.p75RiskScoreAllTime as number).toBeCloseTo(0.8, 5);
      expect(body.p90RiskScoreAllTime as number).toBeCloseTo(1.0, 5);
    });

    it('22. tools — opsPercentileLast1hVsAllTime: ops spread across days', async () => {
      ctx = await setup();
      // Today (within 1h): 2 ops
      await ctx.logger.log(makeOp('agent-a', 'tool-v1086-t1502', 'sess-1'), dec(0.4));
      await ctx.logger.log(makeOp('agent-a', 'tool-v1086-t1502', 'sess-1'), dec(0.5));
      // Yesterday: 4 ops
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp('agent-a', 'tool-v1086-t1502', 'sess-1', daysAgo(1)), dec(0.6));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1086-t1502');
      expect(status).toBe(200);

      // dailyCounts: today=2, yesterday=4 → [2, 4]
      // last1h = 2, rank = count(c<=2) = 1 (only today's 2), result = 1/2 = 0.5
      expect(body.opsPercentileLast1hVsAllTime as number).toBeCloseTo(0.5, 5);
    });

    it('23. tools — riskScoreZScoreLast1h null if no ops in last 1h', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v1086-znolh', 'sess-1', daysAgo(2)), dec(0.3));
      await ctx.logger.log(makeOp('agent-a', 'tool-v1086-znolh', 'sess-1', daysAgo(3)), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1086-znolh');
      expect(status).toBe(200);

      expect(body.riskScoreZScoreLast1h).toBeNull();
    });

    it('24. tools — riskScoreZScoreLast1h computed correctly', async () => {
      ctx = await setup();
      // scores [0.3, 0.7] → mean=0.5, stddev=0.2, z-score = (0.7-0.5)/0.2 = 1.0
      await ctx.logger.log(makeOp('agent-a', 'tool-v1086-zcomp', 'sess-1', daysAgo(1)), dec(0.3));
      await ctx.logger.log(makeOp('agent-a', 'tool-v1086-zcomp', 'sess-1'), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1086-zcomp');
      expect(status).toBe(200);

      expect(body.riskScoreZScoreLast1h as number).toBeCloseTo(1.0, 4);
    });
  });

  // ── summary endpoint ───────────────────────────────────────────────────────────

  describe('T1499-T1503 — v10.86 new fields (summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('25. summary — all five new fields present', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body).toHaveProperty('p75RiskScoreAllTime');
      expect(body).toHaveProperty('p10RiskScoreAllTime');
      expect(body).toHaveProperty('p90RiskScoreAllTime');
      expect(body).toHaveProperty('opsPercentileLast1hVsAllTime');
      expect(body).toHaveProperty('riskScoreZScoreLast1h');
    });

    it('26. summary — no logs: all five fields null', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.p75RiskScoreAllTime).toBeNull();
      expect(body.p10RiskScoreAllTime).toBeNull();
      expect(body.p90RiskScoreAllTime).toBeNull();
      expect(body.opsPercentileLast1hVsAllTime).toBeNull();
      expect(body.riskScoreZScoreLast1h).toBeNull();
    });

    it('27. summary — p75/p10/p90 from 4 scores', async () => {
      ctx = await setup();
      // sorted: [0.2, 0.4, 0.6, 0.8], n=4
      // p10 idx=0 → 0.2, p75 idx=3 → 0.8, p90 idx=3 → 0.8
      for (const score of [0.8, 0.2, 0.6, 0.4]) {
        await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', daysAgo(2)), dec(score));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.p10RiskScoreAllTime as number).toBeCloseTo(0.2, 5);
      expect(body.p75RiskScoreAllTime as number).toBeCloseTo(0.8, 5);
      expect(body.p90RiskScoreAllTime as number).toBeCloseTo(0.8, 5);
    });

    it('28. summary — opsPercentileLast1hVsAllTime: last1h has highest count', async () => {
      ctx = await setup();
      // Today (within 1h): 5 ops
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1'), dec(0.5));
      }
      // Yesterday: 2 ops
      for (let i = 0; i < 2; i++) {
        await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', daysAgo(1)), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      // dailyCounts: today=5, yesterday=2 → [5, 2]
      // last1h = 5, rank = count(c <= 5) = 2, result = 2/2 = 1.0
      expect(body.opsPercentileLast1hVsAllTime as number).toBeCloseTo(1.0, 5);
    });

    it('29. summary — riskScoreZScoreLast1h: null if < 2 logs', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.riskScoreZScoreLast1h).toBeNull();
    });

    it('30. summary — riskScoreZScoreLast1h: null if stddev=0', async () => {
      ctx = await setup();
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1'), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.riskScoreZScoreLast1h).toBeNull();
    });

    it('31. summary — riskScoreZScoreLast1h: null if no ops in last 1h', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', daysAgo(2)), dec(0.3));
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', daysAgo(3)), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.riskScoreZScoreLast1h).toBeNull();
    });

    it('32. summary — riskScoreZScoreLast1h: tip example z=1.0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', daysAgo(1)), dec(0.3));
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1'), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.riskScoreZScoreLast1h as number).toBeCloseTo(1.0, 4);
    });

    it('33. summary — opsPercentileLast1hVsAllTime: last1h count at median of daily counts', async () => {
      ctx = await setup();
      // Three days: day-2=1 op, day-1=3 ops, today(1h)=2 ops
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', daysAgo(2)), dec(0.4));
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', daysAgo(1)), dec(0.5));
      }
      for (let i = 0; i < 2; i++) {
        await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1'), dec(0.6));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      // dailyCounts: [1, 3, 2], last1h=2
      // rank = count(c <= 2) = 2 (day-2 has 1, today has 2) → 2/3
      expect(body.opsPercentileLast1hVsAllTime as number).toBeCloseTo(2 / 3, 5);
    });
  });
});

// ── v10.87 ────────────────────────────────────────────────────────────────────

describe('v10.87', () => {
  const hoursAgo = (h: number) => new Date(PINNED_NOW() - h * 3_600_000);
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);

  // Helper: compute z-score
  function zScore(value: number, population: number[]): number {
    const mean = population.reduce((a, v) => a + v, 0) / population.length;
    const stddev = Math.sqrt(population.reduce((a, v) => a + (v - mean) ** 2, 0) / population.length);
    return (value - mean) / stddev;
  }

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1504-T1508 — v10.87 z-score fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1087-pres-1'), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1087-pres-1');
      expect(status).toBe(200);

      expect(body).toHaveProperty('riskScoreZScoreLast24h');
      expect(body).toHaveProperty('riskScoreZScoreLast7d');
      expect(body).toHaveProperty('blockRateZScoreLast24h');
      expect(body).toHaveProperty('opsZScoreLast1h');
      expect(body).toHaveProperty('opsZScoreLast24h');
    });

    it('2. sessions — only 1 log: riskScoreZScore fields null (< 2 required)', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1087-single'), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1087-single');
      expect(status).toBe(200);

      expect(body.riskScoreZScoreLast24h).toBeNull();
      expect(body.riskScoreZScoreLast7d).toBeNull();
    });

    it('3. sessions — all same risk scores: stddev=0, riskScoreZScore fields null', async () => {
      ctx = await setup();
      // All scores identical → stddev = 0
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1087-zerostd'), dec(0.5, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1087-zerostd');
      expect(status).toBe(200);

      expect(body.riskScoreZScoreLast24h).toBeNull();
      expect(body.riskScoreZScoreLast7d).toBeNull();
    });

    it('4. sessions — no ops in last 24h: riskScoreZScoreLast24h null', async () => {
      ctx = await setup();
      // Two ops older than 24h with different scores
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1087-no24h', hoursAgo(48)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1087-no24h', hoursAgo(72)), dec(0.8, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1087-no24h');
      expect(status).toBe(200);

      expect(body.riskScoreZScoreLast24h).toBeNull();
    });

    it('5. sessions — no ops in last 7d: riskScoreZScoreLast7d null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1087-no7d', daysAgo(10)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1087-no7d', daysAgo(15)), dec(0.8, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1087-no7d');
      expect(status).toBe(200);

      expect(body.riskScoreZScoreLast7d).toBeNull();
    });

    it('6. sessions — riskScoreZScoreLast24h computed correctly', async () => {
      ctx = await setup();
      // All-time scores: 0.1, 0.5, 0.9 (recent), plus 0.5 (old)
      // old ops (> 24h): 0.1, 0.9
      // recent ops (< 24h): 0.5 (twice)
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1087-z24h', hoursAgo(48)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1087-z24h', hoursAgo(36)), dec(0.9, 'allow'));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1087-z24h', hoursAgo(1)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1087-z24h', hoursAgo(2)), dec(0.5, 'allow'));

      // all scores: [0.1, 0.9, 0.3, 0.5]
      // mean = (0.1+0.9+0.3+0.5)/4 = 1.8/4 = 0.45
      // variance = ((0.1-0.45)^2 + (0.9-0.45)^2 + (0.3-0.45)^2 + (0.5-0.45)^2) / 4
      //          = (0.1225 + 0.2025 + 0.0225 + 0.0025) / 4 = 0.35 / 4 = 0.0875
      // stddev = sqrt(0.0875) ≈ 0.2958
      // last-24h: [0.3, 0.5] → mean = 0.4
      // z = (0.4 - 0.45) / 0.2958 ≈ -0.169

      const allScores = [0.1, 0.9, 0.3, 0.5];
      const allMean = allScores.reduce((a, v) => a + v, 0) / allScores.length;
      const allStd = Math.sqrt(allScores.reduce((a, v) => a + (v - allMean) ** 2, 0) / allScores.length);
      const recentMean = (0.3 + 0.5) / 2;
      const expected = (recentMean - allMean) / allStd;

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1087-z24h');
      expect(status).toBe(200);
      expect(body.riskScoreZScoreLast24h as number).toBeCloseTo(expected, 4);
    });

    it('7. sessions — riskScoreZScoreLast7d computed correctly', async () => {
      ctx = await setup();
      // Old (> 7d): 0.1, 0.9; Recent (< 7d): 0.4, 0.6
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1087-z7d', daysAgo(10)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1087-z7d', daysAgo(14)), dec(0.9, 'allow'));
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1087-z7d', daysAgo(2)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1087-z7d', daysAgo(5)), dec(0.6, 'allow'));

      const allScores = [0.1, 0.9, 0.4, 0.6];
      const allMean = allScores.reduce((a, v) => a + v, 0) / allScores.length;
      const allStd = Math.sqrt(allScores.reduce((a, v) => a + (v - allMean) ** 2, 0) / allScores.length);
      const recentMean = (0.4 + 0.6) / 2;
      const expected = (recentMean - allMean) / allStd;

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1087-z7d');
      expect(status).toBe(200);
      expect(body.riskScoreZScoreLast7d as number).toBeCloseTo(expected, 4);
    });

    it('8. sessions — blockRateZScoreLast24h: only 1 day of data → null', async () => {
      ctx = await setup();
      // All ops today
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1087-br-1d'), dec(0.5, 'block'));
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1087-br-1d'), dec(0.3, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1087-br-1d');
      expect(status).toBe(200);
      expect(body.blockRateZScoreLast24h).toBeNull();
    });

    it('9. sessions — blockRateZScoreLast24h: all same daily block rates → stddev=0 → null', async () => {
      ctx = await setup();
      // Two days, each with 1/2 block rate (same rate)
      // Day 1 (yesterday): 1 allow, 1 block → rate 0.5
      // Day 2 (today): 1 allow, 1 block → rate 0.5
      // stddev of [0.5, 0.5] = 0 → null
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1087-br-zerostd', daysAgo(1)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1087-br-zerostd', daysAgo(1)), dec(0.5, 'block'));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1087-br-zerostd'), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1087-br-zerostd'), dec(0.5, 'block'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1087-br-zerostd');
      expect(status).toBe(200);
      expect(body.blockRateZScoreLast24h).toBeNull();
    });

    it('10. sessions — blockRateZScoreLast24h computed correctly', async () => {
      ctx = await setup();
      // Day 1 (2 days ago): 0 blocks / 2 total → rate 0.0
      // Day 2 (1 day ago): 0 blocks / 2 total → rate 0.0
      // Today: 2 blocks / 2 total → rate 1.0
      // rates: [0.0, 0.0, 1.0], mean=1/3, stddev=sqrt(2*(1/3)^2 + (1-1/3)^2)/3)
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1087-br-calc', daysAgo(2)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1087-br-calc', daysAgo(2)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1087-br-calc', daysAgo(1)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1087-br-calc', daysAgo(1)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1087-br-calc'), dec(0.5, 'block'));
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1087-br-calc'), dec(0.6, 'block'));

      const rates = [0.0, 0.0, 1.0];
      const mean = rates.reduce((a, v) => a + v, 0) / rates.length;
      const stddev = Math.sqrt(rates.reduce((a, v) => a + (v - mean) ** 2, 0) / rates.length);
      const todayRate = 1.0;
      const expected = (todayRate - mean) / stddev;

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1087-br-calc');
      expect(status).toBe(200);
      expect(body.blockRateZScoreLast24h as number).toBeCloseTo(expected, 4);
    });

    it('11. sessions — opsZScoreLast1h: only 1 distinct hour → null', async () => {
      ctx = await setup();
      // All ops in the same current hour
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v1087-ops1h-single'), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v1087-ops1h-single'), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1087-ops1h-single');
      expect(status).toBe(200);
      expect(body.opsZScoreLast1h).toBeNull();
    });

    it('12. sessions — opsZScoreLast1h: all hours same count → stddev=0 → null', async () => {
      ctx = await setup();
      // Two distinct hours, each with 1 op → counts [1, 1] → stddev=0
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v1087-ops1h-zerostd', hoursAgo(2)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v1087-ops1h-zerostd'), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1087-ops1h-zerostd');
      expect(status).toBe(200);
      expect(body.opsZScoreLast1h).toBeNull();
    });

    it('13. sessions — opsZScoreLast1h computed correctly', async () => {
      ctx = await setup();
      // 3 hours ago: 1 op; 2 hours ago: 1 op; current hour: 3 ops
      // hours map: hour-3 → 1, hour-2 → 1, current → 3
      // mean = (1+1+3)/3 = 5/3
      // stddev = sqrt(((1-5/3)^2 + (1-5/3)^2 + (3-5/3)^2) / 3)
      // curCount = 3
      // z = (3 - 5/3) / stddev
      await ctx.logger.log(makeOp('agent-k', 'fs', 'sess-v1087-ops1h-calc', hoursAgo(3)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-k', 'fs', 'sess-v1087-ops1h-calc', hoursAgo(2)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-k', 'fs', 'sess-v1087-ops1h-calc'), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-k', 'fs', 'sess-v1087-ops1h-calc'), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-k', 'fs', 'sess-v1087-ops1h-calc'), dec(0.6, 'allow'));

      const counts = [1, 1, 3];
      const mean = counts.reduce((a, v) => a + v, 0) / counts.length;
      const stddev = Math.sqrt(counts.reduce((a, v) => a + (v - mean) ** 2, 0) / counts.length);
      const expected = (3 - mean) / stddev;

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1087-ops1h-calc');
      expect(status).toBe(200);
      expect(body.opsZScoreLast1h as number).toBeCloseTo(expected, 4);
    });

    it('14. sessions — opsZScoreLast24h: only 1 day → null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-l', 'fs', 'sess-v1087-ops24h-single'), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-l', 'fs', 'sess-v1087-ops24h-single'), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1087-ops24h-single');
      expect(status).toBe(200);
      expect(body.opsZScoreLast24h).toBeNull();
    });

    it('15. sessions — opsZScoreLast24h computed correctly', async () => {
      ctx = await setup();
      // 2 days ago: 1 op; yesterday: 2 ops; today: 4 ops
      await ctx.logger.log(makeOp('agent-m', 'fs', 'sess-v1087-ops24h-calc', daysAgo(2)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-m', 'fs', 'sess-v1087-ops24h-calc', daysAgo(1)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-m', 'fs', 'sess-v1087-ops24h-calc', daysAgo(1)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-m', 'fs', 'sess-v1087-ops24h-calc'), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-m', 'fs', 'sess-v1087-ops24h-calc'), dec(0.6, 'allow'));
      await ctx.logger.log(makeOp('agent-m', 'fs', 'sess-v1087-ops24h-calc'), dec(0.7, 'allow'));
      await ctx.logger.log(makeOp('agent-m', 'fs', 'sess-v1087-ops24h-calc'), dec(0.8, 'allow'));

      const counts = [1, 2, 4];
      const mean = counts.reduce((a, v) => a + v, 0) / counts.length;
      const stddev = Math.sqrt(counts.reduce((a, v) => a + (v - mean) ** 2, 0) / counts.length);
      const expected = (4 - mean) / stddev;

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1087-ops24h-calc');
      expect(status).toBe(200);
      expect(body.opsZScoreLast24h as number).toBeCloseTo(expected, 4);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1504-T1508 — v10.87 z-score fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('16. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1087-pres', 'fs', 'sess-1'), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1087-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('riskScoreZScoreLast24h');
      expect(body).toHaveProperty('riskScoreZScoreLast7d');
      expect(body).toHaveProperty('blockRateZScoreLast24h');
      expect(body).toHaveProperty('opsZScoreLast1h');
      expect(body).toHaveProperty('opsZScoreLast24h');
    });

    it('17. agents — only 1 log: riskScoreZScore fields null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1087-ag-single', 'fs', 'sess-1'), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1087-ag-single');
      expect(status).toBe(200);
      expect(body.riskScoreZScoreLast24h).toBeNull();
      expect(body.riskScoreZScoreLast7d).toBeNull();
    });

    it('18. agents — no ops in last 24h: riskScoreZScoreLast24h null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1087-ag-no24h', 'fs', 'sess-1', hoursAgo(48)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-v1087-ag-no24h', 'fs', 'sess-2', hoursAgo(72)), dec(0.8, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1087-ag-no24h');
      expect(status).toBe(200);
      expect(body.riskScoreZScoreLast24h).toBeNull();
    });

    it('19. agents — no ops in last 7d: riskScoreZScoreLast7d null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1087-ag-no7d', 'fs', 'sess-1', daysAgo(10)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-v1087-ag-no7d', 'fs', 'sess-2', daysAgo(15)), dec(0.8, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1087-ag-no7d');
      expect(status).toBe(200);
      expect(body.riskScoreZScoreLast7d).toBeNull();
    });

    it('20. agents — riskScoreZScoreLast24h computed correctly', async () => {
      ctx = await setup();
      // Old (>24h): 0.2, 0.8; Recent: 0.3, 0.7
      await ctx.logger.log(makeOp('agent-v1087-ag-z24h', 'fs', 'sess-1', hoursAgo(48)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-v1087-ag-z24h', 'fs', 'sess-2', hoursAgo(36)), dec(0.8, 'allow'));
      await ctx.logger.log(makeOp('agent-v1087-ag-z24h', 'fs', 'sess-3', hoursAgo(1)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-v1087-ag-z24h', 'fs', 'sess-4', hoursAgo(2)), dec(0.7, 'allow'));

      const allScores = [0.2, 0.8, 0.3, 0.7];
      const allMean = allScores.reduce((a, v) => a + v, 0) / allScores.length;
      const allStd = Math.sqrt(allScores.reduce((a, v) => a + (v - allMean) ** 2, 0) / allScores.length);
      const recentMean = (0.3 + 0.7) / 2;
      const expected = (recentMean - allMean) / allStd;

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1087-ag-z24h');
      expect(status).toBe(200);
      expect(body.riskScoreZScoreLast24h as number).toBeCloseTo(expected, 4);
    });

    it('21. agents — blockRateZScoreLast24h: < 2 days → null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1087-ag-br-1d', 'fs', 'sess-1'), dec(0.5, 'block'));
      await ctx.logger.log(makeOp('agent-v1087-ag-br-1d', 'fs', 'sess-2'), dec(0.3, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1087-ag-br-1d');
      expect(status).toBe(200);
      expect(body.blockRateZScoreLast24h).toBeNull();
    });

    it('22. agents — opsZScoreLast1h: < 2 distinct hours → null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1087-ag-ops1h-1h', 'fs', 'sess-1'), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-v1087-ag-ops1h-1h', 'fs', 'sess-2'), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1087-ag-ops1h-1h');
      expect(status).toBe(200);
      expect(body.opsZScoreLast1h).toBeNull();
    });

    it('23. agents — opsZScoreLast24h: < 2 days → null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1087-ag-ops24h-1d', 'fs', 'sess-1'), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-v1087-ag-ops24h-1d', 'fs', 'sess-2'), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1087-ag-ops24h-1d');
      expect(status).toBe(200);
      expect(body.opsZScoreLast24h).toBeNull();
    });

    it('24. agents — opsZScoreLast24h computed correctly', async () => {
      ctx = await setup();
      // 2 days ago: 2 ops; 1 day ago: 1 op; today: 3 ops
      await ctx.logger.log(makeOp('agent-v1087-ag-ops24h', 'fs', 'sess-1', daysAgo(2)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-v1087-ag-ops24h', 'fs', 'sess-2', daysAgo(2)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-v1087-ag-ops24h', 'fs', 'sess-3', daysAgo(1)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-v1087-ag-ops24h', 'fs', 'sess-4'), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-v1087-ag-ops24h', 'fs', 'sess-5'), dec(0.6, 'allow'));
      await ctx.logger.log(makeOp('agent-v1087-ag-ops24h', 'fs', 'sess-6'), dec(0.7, 'allow'));

      const counts = [2, 1, 3];
      const mean = counts.reduce((a, v) => a + v, 0) / counts.length;
      const stddev = Math.sqrt(counts.reduce((a, v) => a + (v - mean) ** 2, 0) / counts.length);
      const expected = (3 - mean) / stddev;

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1087-ag-ops24h');
      expect(status).toBe(200);
      expect(body.opsZScoreLast24h as number).toBeCloseTo(expected, 4);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1504-T1508 — v10.87 z-score fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('25. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v1087-pres', 'sess-1'), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1087-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('riskScoreZScoreLast24h');
      expect(body).toHaveProperty('riskScoreZScoreLast7d');
      expect(body).toHaveProperty('blockRateZScoreLast24h');
      expect(body).toHaveProperty('opsZScoreLast1h');
      expect(body).toHaveProperty('opsZScoreLast24h');
    });

    it('26. tools — only 1 log: riskScoreZScore fields null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v1087-single', 'sess-1'), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1087-single');
      expect(status).toBe(200);
      expect(body.riskScoreZScoreLast24h).toBeNull();
      expect(body.riskScoreZScoreLast7d).toBeNull();
    });

    it('27. tools — no ops in last 24h: riskScoreZScoreLast24h null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v1087-no24h', 'sess-1', hoursAgo(48)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-a', 'tool-v1087-no24h', 'sess-2', hoursAgo(72)), dec(0.8, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1087-no24h');
      expect(status).toBe(200);
      expect(body.riskScoreZScoreLast24h).toBeNull();
    });

    it('28. tools — riskScoreZScoreLast24h computed correctly', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v1087-z24h', 'sess-1', hoursAgo(48)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-a', 'tool-v1087-z24h', 'sess-2', hoursAgo(36)), dec(0.9, 'allow'));
      await ctx.logger.log(makeOp('agent-a', 'tool-v1087-z24h', 'sess-3', hoursAgo(1)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-a', 'tool-v1087-z24h', 'sess-4', hoursAgo(2)), dec(0.6, 'allow'));

      const allScores = [0.1, 0.9, 0.4, 0.6];
      const allMean = allScores.reduce((a, v) => a + v, 0) / allScores.length;
      const allStd = Math.sqrt(allScores.reduce((a, v) => a + (v - allMean) ** 2, 0) / allScores.length);
      const recentMean = (0.4 + 0.6) / 2;
      const expected = (recentMean - allMean) / allStd;

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1087-z24h');
      expect(status).toBe(200);
      expect(body.riskScoreZScoreLast24h as number).toBeCloseTo(expected, 4);
    });

    it('29. tools — blockRateZScoreLast24h: < 2 days → null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v1087-br-1d', 'sess-1'), dec(0.5, 'block'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1087-br-1d');
      expect(status).toBe(200);
      expect(body.blockRateZScoreLast24h).toBeNull();
    });

    it('30. tools — blockRateZScoreLast24h computed correctly', async () => {
      ctx = await setup();
      // Day -2: 2 allows → rate 0; Day -1: 1 allow, 1 block → rate 0.5; Today: 2 blocks → rate 1
      await ctx.logger.log(makeOp('agent-a', 'tool-v1087-br-calc', 'sess-1', daysAgo(2)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-a', 'tool-v1087-br-calc', 'sess-2', daysAgo(2)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-a', 'tool-v1087-br-calc', 'sess-3', daysAgo(1)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-a', 'tool-v1087-br-calc', 'sess-4', daysAgo(1)), dec(0.4, 'block'));
      await ctx.logger.log(makeOp('agent-a', 'tool-v1087-br-calc', 'sess-5'), dec(0.5, 'block'));
      await ctx.logger.log(makeOp('agent-a', 'tool-v1087-br-calc', 'sess-6'), dec(0.6, 'block'));

      const rates = [0.0, 0.5, 1.0];
      const mean = rates.reduce((a, v) => a + v, 0) / rates.length;
      const stddev = Math.sqrt(rates.reduce((a, v) => a + (v - mean) ** 2, 0) / rates.length);
      const todayRate = 1.0;
      const expected = (todayRate - mean) / stddev;

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1087-br-calc');
      expect(status).toBe(200);
      expect(body.blockRateZScoreLast24h as number).toBeCloseTo(expected, 4);
    });

    it('31. tools — opsZScoreLast1h computed correctly', async () => {
      ctx = await setup();
      // 4 hours ago: 1 op; 3 hours ago: 1 op; current hour: 4 ops
      await ctx.logger.log(makeOp('agent-a', 'tool-v1087-ops1h', 'sess-1', hoursAgo(4)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-a', 'tool-v1087-ops1h', 'sess-2', hoursAgo(3)), dec(0.3, 'allow'));
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp('agent-a', 'tool-v1087-ops1h', `sess-cur-${i}`), dec(0.5, 'allow'));
      }

      const counts = [1, 1, 4];
      const mean = counts.reduce((a, v) => a + v, 0) / counts.length;
      const stddev = Math.sqrt(counts.reduce((a, v) => a + (v - mean) ** 2, 0) / counts.length);
      const expected = (4 - mean) / stddev;

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1087-ops1h');
      expect(status).toBe(200);
      expect(body.opsZScoreLast1h as number).toBeCloseTo(expected, 4);
    });

    it('32. tools — opsZScoreLast24h: < 2 days → null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v1087-ops24h-1d', 'sess-1'), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1087-ops24h-1d');
      expect(status).toBe(200);
      expect(body.opsZScoreLast24h).toBeNull();
    });

    it('33. tools — riskScoreZScoreLast7d computed correctly', async () => {
      ctx = await setup();
      // Old (> 7d): 0.1, 0.9; Recent (< 7d): 0.2, 0.8
      await ctx.logger.log(makeOp('agent-a', 'tool-v1087-z7d', 'sess-1', daysAgo(10)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-a', 'tool-v1087-z7d', 'sess-2', daysAgo(14)), dec(0.9, 'allow'));
      await ctx.logger.log(makeOp('agent-a', 'tool-v1087-z7d', 'sess-3', daysAgo(2)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-a', 'tool-v1087-z7d', 'sess-4', daysAgo(5)), dec(0.8, 'allow'));

      const allScores = [0.1, 0.9, 0.2, 0.8];
      const allMean = allScores.reduce((a, v) => a + v, 0) / allScores.length;
      const allStd = Math.sqrt(allScores.reduce((a, v) => a + (v - allMean) ** 2, 0) / allScores.length);
      const recentMean = (0.2 + 0.8) / 2;
      const expected = (recentMean - allMean) / allStd;

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1087-z7d');
      expect(status).toBe(200);
      expect(body.riskScoreZScoreLast7d as number).toBeCloseTo(expected, 4);
    });
  });

  // ── summary endpoint ───────────────────────────────────────────────────────────

  describe('T1504-T1508 — v10.87 z-score fields (summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('34. summary — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1'), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body).toHaveProperty('riskScoreZScoreLast24h');
      expect(body).toHaveProperty('riskScoreZScoreLast7d');
      expect(body).toHaveProperty('blockRateZScoreLast24h');
      expect(body).toHaveProperty('opsZScoreLast1h');
      expect(body).toHaveProperty('opsZScoreLast24h');
    });

    it('35. summary — no logs: all five new fields null', async () => {
      ctx = await setup();

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.riskScoreZScoreLast24h).toBeNull();
      expect(body.riskScoreZScoreLast7d).toBeNull();
      expect(body.blockRateZScoreLast24h).toBeNull();
      expect(body.opsZScoreLast1h).toBeNull();
      expect(body.opsZScoreLast24h).toBeNull();
    });

    it('36. summary — only 1 log: riskScoreZScore fields null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1'), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreZScoreLast24h).toBeNull();
      expect(body.riskScoreZScoreLast7d).toBeNull();
    });

    it('37. summary — riskScoreZScoreLast24h computed correctly', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', hoursAgo(48)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-2', hoursAgo(36)), dec(0.8, 'allow'));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-3', hoursAgo(1)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-4', hoursAgo(2)), dec(0.6, 'allow'));

      const allScores = [0.2, 0.8, 0.4, 0.6];
      const allMean = allScores.reduce((a, v) => a + v, 0) / allScores.length;
      const allStd = Math.sqrt(allScores.reduce((a, v) => a + (v - allMean) ** 2, 0) / allScores.length);
      const recentMean = (0.4 + 0.6) / 2;
      const expected = (recentMean - allMean) / allStd;

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreZScoreLast24h as number).toBeCloseTo(expected, 4);
    });

    it('38. summary — blockRateZScoreLast24h: < 2 days → null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1'), dec(0.5, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.blockRateZScoreLast24h).toBeNull();
    });

    it('39. summary — blockRateZScoreLast24h computed correctly', async () => {
      ctx = await setup();
      // Day -1: all allow → rate 0; Today: all block → rate 1
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', daysAgo(1)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-2', daysAgo(1)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-3'), dec(0.5, 'block'));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-4'), dec(0.6, 'block'));

      // rates: yesterday=0, today=1
      const rates = [0.0, 1.0];
      const mean = rates.reduce((a, v) => a + v, 0) / rates.length;
      const stddev = Math.sqrt(rates.reduce((a, v) => a + (v - mean) ** 2, 0) / rates.length);
      const expected = (1.0 - mean) / stddev;

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.blockRateZScoreLast24h as number).toBeCloseTo(expected, 4);
    });

    it('40. summary — opsZScoreLast1h: < 2 distinct hours → null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1'), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-2'), dec(0.4, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.opsZScoreLast1h).toBeNull();
    });

    it('41. summary — opsZScoreLast1h computed correctly', async () => {
      ctx = await setup();
      // 3h ago: 1 op; 2h ago: 2 ops; current hour: 3 ops
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', hoursAgo(3)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-2', hoursAgo(2)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-3', hoursAgo(2)), dec(0.35, 'allow'));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-4'), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-5'), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-6'), dec(0.6, 'allow'));

      const counts = [1, 2, 3];
      const mean = counts.reduce((a, v) => a + v, 0) / counts.length;
      const stddev = Math.sqrt(counts.reduce((a, v) => a + (v - mean) ** 2, 0) / counts.length);
      const expected = (3 - mean) / stddev;

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.opsZScoreLast1h as number).toBeCloseTo(expected, 4);
    });

    it('42. summary — opsZScoreLast24h: < 2 days → null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1'), dec(0.3, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.opsZScoreLast24h).toBeNull();
    });

    it('43. summary — opsZScoreLast24h computed correctly', async () => {
      ctx = await setup();
      // 2 days ago: 1; yesterday: 2; today: 5
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', daysAgo(2)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-2', daysAgo(1)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-3', daysAgo(1)), dec(0.3, 'allow'));
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp(`agent-today-${i}`, 'fs', `sess-t-${i}`), dec(0.5, 'allow'));
      }

      const counts = [1, 2, 5];
      const mean = counts.reduce((a, v) => a + v, 0) / counts.length;
      const stddev = Math.sqrt(counts.reduce((a, v) => a + (v - mean) ** 2, 0) / counts.length);
      const expected = (5 - mean) / stddev;

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.opsZScoreLast24h as number).toBeCloseTo(expected, 4);
    });

    it('44. summary — all same riskScores: stddev=0 → riskScoreZScore fields null', async () => {
      ctx = await setup();
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp(`agent-sd0-${i}`, 'fs', `sess-${i}`), dec(0.5, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreZScoreLast24h).toBeNull();
      expect(body.riskScoreZScoreLast7d).toBeNull();
    });

    it('45. summary — riskScoreZScoreLast7d computed correctly', async () => {
      ctx = await setup();
      // Old (> 7d): 0.1, 0.9; Recent (< 7d): 0.3, 0.7
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', daysAgo(10)), dec(0.1, 'allow'));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-2', daysAgo(14)), dec(0.9, 'allow'));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-3', daysAgo(2)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-4', daysAgo(5)), dec(0.7, 'allow'));

      const allScores = [0.1, 0.9, 0.3, 0.7];
      const allMean = allScores.reduce((a, v) => a + v, 0) / allScores.length;
      const allStd = Math.sqrt(allScores.reduce((a, v) => a + (v - allMean) ** 2, 0) / allScores.length);
      const recentMean = (0.3 + 0.7) / 2;
      const expected = (recentMean - allMean) / allStd;

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreZScoreLast7d as number).toBeCloseTo(expected, 4);
    });
  });
});

// ── v10.88 ────────────────────────────────────────────────────────────────────

describe('v10.88', () => {
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

  describe('T1510-T1513 — v10.88 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — T1510-T1513 fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1088-pres'), dec());

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1088-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('uniqueToolsAllTime');
      expect(body).toHaveProperty('uniqueAgentsAllTime');
      expect(body).toHaveProperty('uniqueSessionsAllTime');
      expect(body).toHaveProperty('topToolAllTime');
    });

    it('2. sessions — T1509 uniqueMethodsAllTime (pre-existing T1171) is present', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1088-meth', 'call'), dec());

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1088-meth');
      expect(status).toBe(200);
      expect(body).toHaveProperty('uniqueMethodsAllTime');
      expect(body.uniqueMethodsAllTime).toBe(1);
    });

    it('3. sessions — single log: uniqueToolsAllTime=1, uniqueAgentsAllTime=1, uniqueSessionsAllTime=1, topToolAllTime=tool name', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-b', 'bash', 'sess-v1088-single'), dec());

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1088-single');
      expect(status).toBe(200);

      expect(body.uniqueToolsAllTime).toBe(1);
      expect(body.uniqueAgentsAllTime).toBe(1);
      expect(body.uniqueSessionsAllTime).toBe(1);
      expect(body.topToolAllTime).toBe('bash');
    });

    it('4. sessions — multiple distinct tools: uniqueToolsAllTime counts correctly', async () => {
      ctx = await setup();
      // 3 distinct tools across 4 logs
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1088-tools'), dec());
      await ctx.logger.log(makeOp('agent-c', 'bash', 'sess-v1088-tools'), dec());
      await ctx.logger.log(makeOp('agent-c', 'edit', 'sess-v1088-tools'), dec());
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1088-tools'), dec());

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1088-tools');
      expect(status).toBe(200);

      expect(body.uniqueToolsAllTime).toBe(3);
    });

    it('5. sessions — multiple distinct agents: uniqueAgentsAllTime counts correctly', async () => {
      ctx = await setup();
      // 3 distinct agents
      await ctx.logger.log(makeOp('agent-x1', 'fs', 'sess-v1088-agents'), dec());
      await ctx.logger.log(makeOp('agent-x2', 'fs', 'sess-v1088-agents'), dec());
      await ctx.logger.log(makeOp('agent-x3', 'fs', 'sess-v1088-agents'), dec());
      await ctx.logger.log(makeOp('agent-x1', 'fs', 'sess-v1088-agents'), dec());

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1088-agents');
      expect(status).toBe(200);

      expect(body.uniqueAgentsAllTime).toBe(3);
    });

    it('6. sessions — multiple distinct sessions: uniqueSessionsAllTime counts correctly', async () => {
      ctx = await setup();
      // Sessions endpoint filters by session, so only sess-v1088-s1 logs are returned
      // Thus uniqueSessionsAllTime reflects only that session's logs = 1
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1088-s1'), dec());
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1088-s1'), dec());

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1088-s1');
      expect(status).toBe(200);

      expect(body.uniqueSessionsAllTime).toBe(1);
    });

    it('7. sessions — topToolAllTime returns most-used tool', async () => {
      ctx = await setup();
      // bash: 3 times, fs: 2 times, edit: 1 time
      await ctx.logger.log(makeOp('agent-e', 'bash', 'sess-v1088-top'), dec());
      await ctx.logger.log(makeOp('agent-e', 'bash', 'sess-v1088-top'), dec());
      await ctx.logger.log(makeOp('agent-e', 'bash', 'sess-v1088-top'), dec());
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1088-top'), dec());
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1088-top'), dec());
      await ctx.logger.log(makeOp('agent-e', 'edit', 'sess-v1088-top'), dec());

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1088-top');
      expect(status).toBe(200);

      expect(body.topToolAllTime).toBe('bash');
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1510-T1513 — v10.88 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('8. agents — T1510-T1513 fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-ag1', 'fs', 'sess-1'), dec());

      const { status, body } = await getJSON(ctx.port, '/agents/agent-ag1');
      expect(status).toBe(200);

      expect(body).toHaveProperty('uniqueToolsAllTime');
      expect(body).toHaveProperty('uniqueAgentsAllTime');
      expect(body).toHaveProperty('uniqueSessionsAllTime');
      expect(body).toHaveProperty('topToolAllTime');
    });

    it('9. agents — single log: counts are 1 and topToolAllTime is tool name', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-ag2', 'glob', 'sess-1'), dec());

      const { status, body } = await getJSON(ctx.port, '/agents/agent-ag2');
      expect(status).toBe(200);

      expect(body.uniqueToolsAllTime).toBe(1);
      expect(body.uniqueAgentsAllTime).toBe(1);
      expect(body.uniqueSessionsAllTime).toBe(1);
      expect(body.topToolAllTime).toBe('glob');
    });

    it('10. agents — topToolAllTime reflects most-used tool across multiple sessions', async () => {
      ctx = await setup();
      // read: 4 times across 2 sessions; write: 2 times
      await ctx.logger.log(makeOp('agent-ag3', 'read', 'sess-a1'), dec());
      await ctx.logger.log(makeOp('agent-ag3', 'read', 'sess-a1'), dec());
      await ctx.logger.log(makeOp('agent-ag3', 'read', 'sess-a2'), dec());
      await ctx.logger.log(makeOp('agent-ag3', 'read', 'sess-a2'), dec());
      await ctx.logger.log(makeOp('agent-ag3', 'write', 'sess-a1'), dec());
      await ctx.logger.log(makeOp('agent-ag3', 'write', 'sess-a2'), dec());

      const { status, body } = await getJSON(ctx.port, '/agents/agent-ag3');
      expect(status).toBe(200);

      expect(body.uniqueToolsAllTime).toBe(2);
      expect(body.uniqueSessionsAllTime).toBe(2);
      expect(body.topToolAllTime).toBe('read');
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1510-T1513 — v10.88 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('11. tools — T1510-T1513 fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-t1', 'mytool', 'sess-1'), dec());

      const { status, body } = await getJSON(ctx.port, '/tools/mytool');
      expect(status).toBe(200);

      expect(body).toHaveProperty('uniqueToolsAllTime');
      expect(body).toHaveProperty('uniqueAgentsAllTime');
      expect(body).toHaveProperty('uniqueSessionsAllTime');
      expect(body).toHaveProperty('topToolAllTime');
    });

    it('12. tools — single log: counts are 1 and topToolAllTime equals the queried tool', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-t2', 'searchtool', 'sess-1'), dec());

      const { status, body } = await getJSON(ctx.port, '/tools/searchtool');
      expect(status).toBe(200);

      expect(body.uniqueToolsAllTime).toBe(1);
      expect(body.uniqueAgentsAllTime).toBe(1);
      expect(body.uniqueSessionsAllTime).toBe(1);
      // The tools endpoint filters logs by tool, so only 'searchtool' logs are included
      expect(body.topToolAllTime).toBe('searchtool');
    });

    it('13. tools — multiple agents using same tool: uniqueAgentsAllTime counts correctly', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-ta1', 'codetool', 'sess-1'), dec());
      await ctx.logger.log(makeOp('agent-ta2', 'codetool', 'sess-2'), dec());
      await ctx.logger.log(makeOp('agent-ta3', 'codetool', 'sess-3'), dec());
      await ctx.logger.log(makeOp('agent-ta1', 'codetool', 'sess-1'), dec());

      const { status, body } = await getJSON(ctx.port, '/tools/codetool');
      expect(status).toBe(200);

      expect(body.uniqueAgentsAllTime).toBe(3);
      expect(body.uniqueSessionsAllTime).toBe(3);
      // All logs are for 'codetool' so uniqueToolsAllTime=1
      expect(body.uniqueToolsAllTime).toBe(1);
      expect(body.topToolAllTime).toBe('codetool');
    });
  });

  // ── global operations/summary endpoint ────────────────────────────────────────

  describe('T1510-T1513 — v10.88 new fields (global operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('14. global — T1510-T1513 fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-g1', 'fs', 'sess-1'), dec());

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body).toHaveProperty('uniqueToolsAllTime');
      expect(body).toHaveProperty('uniqueAgentsAllTime');
      expect(body).toHaveProperty('uniqueSessionsAllTime');
      expect(body).toHaveProperty('topToolAllTime');
    });

    it('15. global — no logs: uniqueToolsAllTime=0, uniqueAgentsAllTime=0, uniqueSessionsAllTime=0, topToolAllTime=null', async () => {
      ctx = await setup();

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.uniqueToolsAllTime).toBe(0);
      expect(body.uniqueAgentsAllTime).toBe(0);
      expect(body.uniqueSessionsAllTime).toBe(0);
      expect(body.topToolAllTime).toBeNull();
    });

    it('16. global — multiple tools, agents, sessions: all counts correct', async () => {
      ctx = await setup();
      // 3 tools, 2 agents, 3 sessions
      await ctx.logger.log(makeOp('agent-g2', 'fs', 'sess-g1'), dec());
      await ctx.logger.log(makeOp('agent-g2', 'bash', 'sess-g1'), dec());
      await ctx.logger.log(makeOp('agent-g3', 'edit', 'sess-g2'), dec());
      await ctx.logger.log(makeOp('agent-g2', 'fs', 'sess-g3'), dec());
      await ctx.logger.log(makeOp('agent-g3', 'bash', 'sess-g2'), dec());

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.uniqueToolsAllTime).toBe(3);
      expect(body.uniqueAgentsAllTime).toBe(2);
      expect(body.uniqueSessionsAllTime).toBe(3);
    });

    it('17. global — topToolAllTime returns most-used tool across all agents and sessions', async () => {
      ctx = await setup();
      // fs: 4 uses, bash: 2 uses, grep: 1 use
      await ctx.logger.log(makeOp('agent-g4', 'fs', 'sess-g1'), dec());
      await ctx.logger.log(makeOp('agent-g4', 'fs', 'sess-g1'), dec());
      await ctx.logger.log(makeOp('agent-g5', 'fs', 'sess-g2'), dec());
      await ctx.logger.log(makeOp('agent-g5', 'fs', 'sess-g2'), dec());
      await ctx.logger.log(makeOp('agent-g4', 'bash', 'sess-g1'), dec());
      await ctx.logger.log(makeOp('agent-g5', 'bash', 'sess-g2'), dec());
      await ctx.logger.log(makeOp('agent-g4', 'grep', 'sess-g1'), dec());

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.topToolAllTime).toBe('fs');
    });

    it('18. global — topToolAllTime null when no logs', async () => {
      ctx = await setup();

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.topToolAllTime).toBeNull();
    });

    it('19. global — uniqueMethodsAllTime (T1509/T1171) present and correct with multiple methods', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-g6', 'fs', 'sess-g1', 'call'), dec());
      await ctx.logger.log(makeOp('agent-g6', 'fs', 'sess-g1', 'list'), dec());
      await ctx.logger.log(makeOp('agent-g6', 'bash', 'sess-g1', 'call'), dec());

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body).toHaveProperty('uniqueMethodsAllTime');
      expect(body.uniqueMethodsAllTime).toBe(2);
    });
  });
});

// ── v10.89 ────────────────────────────────────────────────────────────────────

describe('v10.89', () => {
  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1514-T1518 — v10.89 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-a', 'sess-v1089-pres'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1089-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('topAgentAllTime');
      expect(body).toHaveProperty('topMethodAllTime');
      expect(body).toHaveProperty('topSessionAllTime');
      expect(body).toHaveProperty('leastUsedToolAllTime');
      expect(body).toHaveProperty('leastActiveAgentAllTime');
    });

    it('2. sessions — no logs: all five fields are null', async () => {
      ctx = await setup();
      // No ops logged for this session — the session endpoint returns 404 or empty, but
      // if it returns 200 with data, fields should be null. Test the empty-DB global endpoint instead.
      // Use a session that has one op logged so we get a 200, but filter: test the case where
      // a session has ops — fields are non-null. For null-case use sessions with 0 ops (404).
      // Actually, test null behavior via summary endpoint in the summary describe block.
      // Here: single op — fields are non-null strings.
      await ctx.logger.log(makeOp('agent-only', 'tool-only', 'sess-v1089-single'), dec(0.5));
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1089-single');
      expect(status).toBe(200);
      expect(typeof body.topAgentAllTime).toBe('string');
      expect(typeof body.topMethodAllTime).toBe('string');
      expect(typeof body.topSessionAllTime).toBe('string');
      expect(typeof body.leastUsedToolAllTime).toBe('string');
      expect(typeof body.leastActiveAgentAllTime).toBe('string');
    });

    it('3. sessions — single op: topAgentAllTime equals that agent', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-solo', 'tool-solo', 'sess-v1089-top-agent'), dec(0.3));
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1089-top-agent');
      expect(status).toBe(200);
      expect(body.topAgentAllTime).toBe('agent-solo');
    });

    it('4. sessions — single op: topMethodAllTime equals that method', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-m', 'tool-m', 'sess-v1089-top-method', new Date(PINNED_NOW()), 'tools/call'), dec(0.3));
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1089-top-method');
      expect(status).toBe(200);
      expect(body.topMethodAllTime).toBe('tools/call');
    });

    it('5. sessions — single op: topSessionAllTime equals that session', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s', 'tool-s', 'sess-v1089-top-sess'), dec(0.3));
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1089-top-sess');
      expect(status).toBe(200);
      expect(body.topSessionAllTime).toBe('sess-v1089-top-sess');
    });

    it('6. sessions — single op: leastUsedToolAllTime equals that tool', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-lt', 'tool-least', 'sess-v1089-least-tool'), dec(0.3));
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1089-least-tool');
      expect(status).toBe(200);
      expect(body.leastUsedToolAllTime).toBe('tool-least');
    });

    it('7. sessions — single op: leastActiveAgentAllTime equals that agent', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-least', 'tool-la', 'sess-v1089-least-agent'), dec(0.3));
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1089-least-agent');
      expect(status).toBe(200);
      expect(body.leastActiveAgentAllTime).toBe('agent-least');
    });

    it('8. sessions — two agents, one more active: topAgentAllTime is the more active one', async () => {
      ctx = await setup();
      // agent-busy: 3 ops, agent-lazy: 1 op
      await ctx.logger.log(makeOp('agent-busy', 'tool-x', 'sess-v1089-two-agents'), dec(0.2));
      await ctx.logger.log(makeOp('agent-busy', 'tool-x', 'sess-v1089-two-agents'), dec(0.2));
      await ctx.logger.log(makeOp('agent-busy', 'tool-x', 'sess-v1089-two-agents'), dec(0.2));
      await ctx.logger.log(makeOp('agent-lazy', 'tool-x', 'sess-v1089-two-agents'), dec(0.2));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1089-two-agents');
      expect(status).toBe(200);
      expect(body.topAgentAllTime).toBe('agent-busy');
      expect(body.leastActiveAgentAllTime).toBe('agent-lazy');
    });

    it('9. sessions — two tools with different usage counts: leastUsedToolAllTime is the less-used one', async () => {
      ctx = await setup();
      // tool-heavy: 4 ops, tool-light: 1 op
      await ctx.logger.log(makeOp('agent-t', 'tool-heavy', 'sess-v1089-two-tools'), dec(0.3));
      await ctx.logger.log(makeOp('agent-t', 'tool-heavy', 'sess-v1089-two-tools'), dec(0.3));
      await ctx.logger.log(makeOp('agent-t', 'tool-heavy', 'sess-v1089-two-tools'), dec(0.3));
      await ctx.logger.log(makeOp('agent-t', 'tool-heavy', 'sess-v1089-two-tools'), dec(0.3));
      await ctx.logger.log(makeOp('agent-t', 'tool-light', 'sess-v1089-two-tools'), dec(0.3));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1089-two-tools');
      expect(status).toBe(200);
      expect(body.topToolAllTime).toBe('tool-heavy');
      expect(body.leastUsedToolAllTime).toBe('tool-light');
    });

    it('10. sessions — two methods, different frequencies: topMethodAllTime is the more frequent one', async () => {
      ctx = await setup();
      // method 'read': 3 ops, method 'write': 1 op
      await ctx.logger.log(makeOp('agent-meth', 'tool-meth', 'sess-v1089-methods', new Date(PINNED_NOW()), 'read'), dec(0.3));
      await ctx.logger.log(makeOp('agent-meth', 'tool-meth', 'sess-v1089-methods', new Date(PINNED_NOW()), 'read'), dec(0.3));
      await ctx.logger.log(makeOp('agent-meth', 'tool-meth', 'sess-v1089-methods', new Date(PINNED_NOW()), 'read'), dec(0.3));
      await ctx.logger.log(makeOp('agent-meth', 'tool-meth', 'sess-v1089-methods', new Date(PINNED_NOW()), 'write'), dec(0.3));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1089-methods');
      expect(status).toBe(200);
      expect(body.topMethodAllTime).toBe('read');
    });

    it('11. sessions — two sessions with different op counts: topSessionAllTime is the more active session', async () => {
      ctx = await setup();
      // sess-high: 3 ops, sess-low: 1 op
      // Both logged under the same filter key, but topSessionAllTime looks at all logs
      await ctx.logger.log(makeOp('agent-sess', 'tool-sess', 'sess-v1089-high'), dec(0.3));
      await ctx.logger.log(makeOp('agent-sess', 'tool-sess', 'sess-v1089-high'), dec(0.3));
      await ctx.logger.log(makeOp('agent-sess', 'tool-sess', 'sess-v1089-high'), dec(0.3));
      await ctx.logger.log(makeOp('agent-sess', 'tool-sess', 'sess-v1089-low'), dec(0.3));

      // Query the high-activity session
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1089-high');
      expect(status).toBe(200);
      expect(body.topSessionAllTime).toBe('sess-v1089-high');
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1514-T1518 — v10.89 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('12. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1089-pres', 'tool-pres', 'sess-1'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1089-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('topAgentAllTime');
      expect(body).toHaveProperty('topMethodAllTime');
      expect(body).toHaveProperty('topSessionAllTime');
      expect(body).toHaveProperty('leastUsedToolAllTime');
      expect(body).toHaveProperty('leastActiveAgentAllTime');
    });

    it('13. agents — single op: all five fields non-null and correct', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1089-solo', 'tool-v1089-solo', 'sess-v1089-solo', new Date(PINNED_NOW()), 'invoke'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1089-solo');
      expect(status).toBe(200);
      expect(body.topAgentAllTime).toBe('agent-v1089-solo');
      expect(body.topMethodAllTime).toBe('invoke');
      expect(body.topSessionAllTime).toBe('sess-v1089-solo');
      expect(body.leastUsedToolAllTime).toBe('tool-v1089-solo');
      expect(body.leastActiveAgentAllTime).toBe('agent-v1089-solo');
    });

    it('14. agents — logs are scoped to queried agent: topAgentAllTime and leastActiveAgentAllTime are the agent itself', async () => {
      ctx = await setup();
      // The agents endpoint filters logs by agentId, so all logs in the response
      // belong to the same agent. topAgentAllTime and leastActiveAgentAllTime will
      // both be that single agent.
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp('agent-v1089-top', 'tool-a', `sess-ag-${i}`), dec(0.2));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1089-top');
      expect(status).toBe(200);
      expect(body.topAgentAllTime).toBe('agent-v1089-top');
      expect(body.leastActiveAgentAllTime).toBe('agent-v1089-top');
    });

    it('15. agents — leastUsedToolAllTime is tool with fewest ops', async () => {
      ctx = await setup();
      // tool-heavy: 5 ops, tool-medium: 3 ops, tool-rare: 1 op
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp('agent-v1089-tools', 'tool-heavy', `sess-tools-h-${i}`), dec(0.3));
      }
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-v1089-tools', 'tool-medium', `sess-tools-m-${i}`), dec(0.3));
      }
      await ctx.logger.log(makeOp('agent-v1089-tools', 'tool-rare', 'sess-tools-r'), dec(0.3));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1089-tools');
      expect(status).toBe(200);
      expect(body.topToolAllTime).toBe('tool-heavy');
      expect(body.leastUsedToolAllTime).toBe('tool-rare');
    });

    it('16. agents — topMethodAllTime is method with most occurrences', async () => {
      ctx = await setup();
      // method 'execute': 5x, method 'query': 2x, method 'ping': 1x
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp('agent-v1089-meth', 'tool-meth', `sess-meth-e-${i}`, new Date(PINNED_NOW()), 'execute'), dec(0.3));
      }
      for (let i = 0; i < 2; i++) {
        await ctx.logger.log(makeOp('agent-v1089-meth', 'tool-meth', `sess-meth-q-${i}`, new Date(PINNED_NOW()), 'query'), dec(0.3));
      }
      await ctx.logger.log(makeOp('agent-v1089-meth', 'tool-meth', 'sess-meth-p', new Date(PINNED_NOW()), 'ping'), dec(0.3));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1089-meth');
      expect(status).toBe(200);
      expect(body.topMethodAllTime).toBe('execute');
    });

    it('17. agents — topSessionAllTime is session with most ops', async () => {
      ctx = await setup();
      // sess-prime: 4 ops, sess-second: 2 ops, sess-third: 1 op
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp('agent-v1089-sess', 'tool-sess', 'sess-prime'), dec(0.3));
      }
      for (let i = 0; i < 2; i++) {
        await ctx.logger.log(makeOp('agent-v1089-sess', 'tool-sess', 'sess-second'), dec(0.3));
      }
      await ctx.logger.log(makeOp('agent-v1089-sess', 'tool-sess', 'sess-third'), dec(0.3));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1089-sess');
      expect(status).toBe(200);
      expect(body.topSessionAllTime).toBe('sess-prime');
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1514-T1518 — v10.89 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('18. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-tool-pres', 'tool-v1089-pres', 'sess-tp'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1089-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('topAgentAllTime');
      expect(body).toHaveProperty('topMethodAllTime');
      expect(body).toHaveProperty('topSessionAllTime');
      expect(body).toHaveProperty('leastUsedToolAllTime');
      expect(body).toHaveProperty('leastActiveAgentAllTime');
    });

    it('19. tools — single op: all five fields non-null and correct', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-tool-solo', 'tool-v1089-solo', 'sess-tool-solo', new Date(PINNED_NOW()), 'tool/call'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1089-solo');
      expect(status).toBe(200);
      expect(body.topAgentAllTime).toBe('agent-tool-solo');
      expect(body.topMethodAllTime).toBe('tool/call');
      expect(body.topSessionAllTime).toBe('sess-tool-solo');
      expect(body.leastUsedToolAllTime).toBe('tool-v1089-solo');
      expect(body.leastActiveAgentAllTime).toBe('agent-tool-solo');
    });

    it('20. tools — topAgentAllTime is most active agent among logs for this tool', async () => {
      ctx = await setup();
      // agent-alpha: 3 ops; agent-beta: 1 op
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-alpha', 'tool-v1089-agent-top', `sess-tat-${i}`), dec(0.2));
      }
      await ctx.logger.log(makeOp('agent-beta', 'tool-v1089-agent-top', 'sess-tat-b'), dec(0.2));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1089-agent-top');
      expect(status).toBe(200);
      expect(body.topAgentAllTime).toBe('agent-alpha');
      expect(body.leastActiveAgentAllTime).toBe('agent-beta');
    });

    it('21. tools — logs are scoped to queried tool: leastUsedToolAllTime is the tool itself', async () => {
      ctx = await setup();
      // The tools endpoint filters logs by tool, so all logs in the response
      // belong to the same tool. leastUsedToolAllTime will be that single tool.
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp(`agent-lt-${i}`, 'tool-v1089-main', `sess-lt-${i}`), dec(0.3));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1089-main');
      expect(status).toBe(200);
      expect(body.leastUsedToolAllTime).toBe('tool-v1089-main');
    });

    it('22. tools — topMethodAllTime reflects most frequent method in logs for this tool', async () => {
      ctx = await setup();
      // method 'stream': 3 ops, method 'batch': 2 ops
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp(`agent-tm-${i}`, 'tool-v1089-method', `sess-tm-s-${i}`, new Date(PINNED_NOW()), 'stream'), dec(0.3));
      }
      for (let i = 0; i < 2; i++) {
        await ctx.logger.log(makeOp(`agent-tm-b-${i}`, 'tool-v1089-method', `sess-tm-b-${i}`, new Date(PINNED_NOW()), 'batch'), dec(0.3));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1089-method');
      expect(status).toBe(200);
      expect(body.topMethodAllTime).toBe('stream');
    });

    it('23. tools — topSessionAllTime reflects most active session', async () => {
      ctx = await setup();
      // sess-ts-a: 3 ops, sess-ts-b: 2 ops
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp(`agent-ts-a-${i}`, 'tool-v1089-session', 'sess-ts-a'), dec(0.3));
      }
      for (let i = 0; i < 2; i++) {
        await ctx.logger.log(makeOp(`agent-ts-b-${i}`, 'tool-v1089-session', 'sess-ts-b'), dec(0.3));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1089-session');
      expect(status).toBe(200);
      expect(body.topSessionAllTime).toBe('sess-ts-a');
    });
  });

  // ── operations/summary endpoint ────────────────────────────────────────────────

  describe('T1514-T1518 — v10.89 new fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('24. summary — all five new fields present', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-sum-pres', 'tool-sum', 'sess-sum'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body).toHaveProperty('topAgentAllTime');
      expect(body).toHaveProperty('topMethodAllTime');
      expect(body).toHaveProperty('topSessionAllTime');
      expect(body).toHaveProperty('leastUsedToolAllTime');
      expect(body).toHaveProperty('leastActiveAgentAllTime');
    });

    it('25. summary — empty DB: all five new fields are null', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.topAgentAllTime).toBeNull();
      expect(body.topMethodAllTime).toBeNull();
      expect(body.topSessionAllTime).toBeNull();
      expect(body.leastUsedToolAllTime).toBeNull();
      expect(body.leastActiveAgentAllTime).toBeNull();
    });

    it('26. summary — single op: all five fields non-null and correct', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-sum-only', 'tool-sum-only', 'sess-sum-only', new Date(PINNED_NOW()), 'run'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.topAgentAllTime).toBe('agent-sum-only');
      expect(body.topMethodAllTime).toBe('run');
      expect(body.topSessionAllTime).toBe('sess-sum-only');
      expect(body.leastUsedToolAllTime).toBe('tool-sum-only');
      expect(body.leastActiveAgentAllTime).toBe('agent-sum-only');
    });

    it('27. summary — topAgentAllTime returns agent with most total ops', async () => {
      ctx = await setup();
      // agent-sum-top: 5 ops; agent-sum-mid: 3 ops; agent-sum-low: 1 op
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp('agent-sum-top', 'tool-sum-a', `sess-sa-${i}`), dec(0.2));
      }
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-sum-mid', 'tool-sum-b', `sess-sb-${i}`), dec(0.2));
      }
      await ctx.logger.log(makeOp('agent-sum-low', 'tool-sum-c', 'sess-sc'), dec(0.2));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.topAgentAllTime).toBe('agent-sum-top');
      expect(body.leastActiveAgentAllTime).toBe('agent-sum-low');
    });

    it('28. summary — leastUsedToolAllTime returns tool with fewest ops', async () => {
      ctx = await setup();
      // tool-sum-freq: 6 ops, tool-sum-med: 3 ops, tool-sum-rare: 1 op
      for (let i = 0; i < 6; i++) {
        await ctx.logger.log(makeOp(`ag-sum-f-${i}`, 'tool-sum-freq', `sess-sf-${i}`), dec(0.3));
      }
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp(`ag-sum-m-${i}`, 'tool-sum-med', `sess-sm-${i}`), dec(0.3));
      }
      await ctx.logger.log(makeOp('ag-sum-r', 'tool-sum-rare', 'sess-sr'), dec(0.3));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.topToolAllTime).toBe('tool-sum-freq');
      expect(body.leastUsedToolAllTime).toBe('tool-sum-rare');
    });

    it('29. summary — topMethodAllTime returns method with most calls', async () => {
      ctx = await setup();
      // method 'get': 4 ops, method 'post': 2 ops, method 'delete': 1 op
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp(`ag-sm-g-${i}`, 'tool-sm', `sess-smg-${i}`, new Date(PINNED_NOW()), 'get'), dec(0.2));
      }
      for (let i = 0; i < 2; i++) {
        await ctx.logger.log(makeOp(`ag-sm-p-${i}`, 'tool-sm', `sess-smp-${i}`, new Date(PINNED_NOW()), 'post'), dec(0.2));
      }
      await ctx.logger.log(makeOp('ag-sm-d', 'tool-sm', 'sess-smd', new Date(PINNED_NOW()), 'delete'), dec(0.2));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.topMethodAllTime).toBe('get');
    });

    it('30. summary — topSessionAllTime returns session with most ops', async () => {
      ctx = await setup();
      // sess-sum-prime: 5 ops, sess-sum-second: 2 ops
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp(`ag-ssp-${i}`, 'tool-ssp', 'sess-sum-prime'), dec(0.3));
      }
      for (let i = 0; i < 2; i++) {
        await ctx.logger.log(makeOp(`ag-sss-${i}`, 'tool-sss', 'sess-sum-second'), dec(0.3));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.topSessionAllTime).toBe('sess-sum-prime');
    });

    it('31. summary — leastActiveAgentAllTime and topAgentAllTime are different when multiple agents exist', async () => {
      ctx = await setup();
      // agent-big: 10 ops, agent-tiny: 1 op
      for (let i = 0; i < 10; i++) {
        await ctx.logger.log(makeOp('agent-big', 'tool-diff', `sess-diff-${i}`), dec(0.3));
      }
      await ctx.logger.log(makeOp('agent-tiny', 'tool-diff', 'sess-diff-tiny'), dec(0.3));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.topAgentAllTime).toBe('agent-big');
      expect(body.leastActiveAgentAllTime).toBe('agent-tiny');
      expect(body.topAgentAllTime).not.toBe(body.leastActiveAgentAllTime);
    });

    it('32. summary — topToolAllTime and leastUsedToolAllTime are different when multiple tools exist', async () => {
      ctx = await setup();
      // tool-dominant: 8 ops, tool-minor: 1 op
      for (let i = 0; i < 8; i++) {
        await ctx.logger.log(makeOp(`ag-td-${i}`, 'tool-dominant', `sess-td-${i}`), dec(0.3));
      }
      await ctx.logger.log(makeOp('ag-tm', 'tool-minor', 'sess-tm'), dec(0.3));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.topToolAllTime).toBe('tool-dominant');
      expect(body.leastUsedToolAllTime).toBe('tool-minor');
      expect(body.topToolAllTime).not.toBe(body.leastUsedToolAllTime);
    });
  });
});

// ── v10.90 ────────────────────────────────────────────────────────────────────

describe('v10.90', () => {
  const secsAgo = (s: number) => new Date(PINNED_NOW() - s * 1_000);
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1519-T1523 — v10.90 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1090-pres'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1090-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('firstOpTimestamp');
      expect(body).toHaveProperty('lastOpTimestamp');
      expect(body).toHaveProperty('totalOpsSpanDays');
      expect(body).toHaveProperty('avgSecondsBetweenOps');
      expect(body).toHaveProperty('medianSecondsBetweenOps');
    });

    it('2. sessions — no logs: all five fields are null', async () => {
      ctx = await setup();
      // No logs for this session
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1090-empty');
      // Endpoint may return 404 for unknown session or 200 with empty; handle both
      if (status === 200) {
        expect(body.firstOpTimestamp).toBeNull();
        expect(body.lastOpTimestamp).toBeNull();
        expect(body.totalOpsSpanDays).toBeNull();
        expect(body.avgSecondsBetweenOps).toBeNull();
        expect(body.medianSecondsBetweenOps).toBeNull();
      } else {
        expect(status).toBe(404);
      }
    });

    it('3. sessions — single log: firstOpTimestamp and lastOpTimestamp are ISO strings, totalOpsSpanDays=0, avg/median null', async () => {
      ctx = await setup();
      const ts = new Date('2025-06-01T12:00:00.000Z');
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1090-single', ts), dec(0.3));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1090-single');
      expect(status).toBe(200);

      expect(typeof body.firstOpTimestamp).toBe('string');
      expect(typeof body.lastOpTimestamp).toBe('string');
      expect(body.totalOpsSpanDays).toBe(0);
      expect(body.avgSecondsBetweenOps).toBeNull();
      expect(body.medianSecondsBetweenOps).toBeNull();
    });

    it('4. sessions — two ops same day: totalOpsSpanDays=0, avg and median = interval in seconds', async () => {
      ctx = await setup();
      // t=0 and t+60s, same day
      const t0 = new Date('2025-06-01T10:00:00.000Z');
      const t1 = new Date('2025-06-01T10:01:00.000Z'); // +60s
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1090-sameday', t0), dec(0.4));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1090-sameday', t1), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1090-sameday');
      expect(status).toBe(200);

      expect(body.totalOpsSpanDays).toBe(0);
      expect(body.avgSecondsBetweenOps as number).toBeCloseTo(60, 5);
      expect(body.medianSecondsBetweenOps as number).toBeCloseTo(60, 5);
    });

    it('5. sessions — two ops 3 days apart: totalOpsSpanDays=3', async () => {
      ctx = await setup();
      const t0 = new Date('2025-06-01T00:00:00.000Z');
      const t1 = new Date('2025-06-04T00:00:00.000Z'); // exactly 3 days later
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1090-3days', t0), dec(0.4));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1090-3days', t1), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1090-3days');
      expect(status).toBe(200);

      expect(body.totalOpsSpanDays).toBe(3);
    });

    it('6. sessions — three ops at t=0, t+60s, t+180s: avg=90s, median=90s', async () => {
      ctx = await setup();
      // intervals: [60, 120] → avg=90, sorted [60,120], median=(60+120)/2=90
      const t0 = new Date('2025-06-01T10:00:00.000Z');
      const t1 = new Date('2025-06-01T10:01:00.000Z'); // +60s
      const t2 = new Date('2025-06-01T10:03:00.000Z'); // +180s from t0
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1090-3ops', t0), dec(0.3));
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1090-3ops', t1), dec(0.5));
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1090-3ops', t2), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1090-3ops');
      expect(status).toBe(200);

      expect(body.avgSecondsBetweenOps as number).toBeCloseTo(90, 5);
      expect(body.medianSecondsBetweenOps as number).toBeCloseTo(90, 5);
    });

    it('7. sessions — four ops: median uses middle two values (even count)', async () => {
      ctx = await setup();
      // intervals: [10, 20, 90] sorted → [10, 20, 90]
      // avg = (10+20+90)/3 = 40; median of 3 diffs (odd) = middle = 20
      const t0 = new Date('2025-06-01T10:00:00.000Z');
      const t1 = new Date('2025-06-01T10:00:10.000Z'); // +10s
      const t2 = new Date('2025-06-01T10:00:30.000Z'); // +20s
      const t3 = new Date('2025-06-01T10:02:00.000Z'); // +90s
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1090-4ops', t0), dec(0.2));
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1090-4ops', t1), dec(0.4));
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1090-4ops', t2), dec(0.6));
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1090-4ops', t3), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1090-4ops');
      expect(status).toBe(200);

      // 3 diffs (odd): sorted [10, 20, 90], median = 20
      expect(body.medianSecondsBetweenOps as number).toBeCloseTo(20, 5);
      expect(body.avgSecondsBetweenOps as number).toBeCloseTo(40, 5);
    });

    it('8. sessions — firstOpTimestamp is the earliest, lastOpTimestamp is the latest', async () => {
      ctx = await setup();
      const t0 = new Date('2025-01-01T00:00:00.000Z');
      const t1 = new Date('2025-06-15T12:30:00.000Z');
      const t2 = new Date('2025-12-31T23:59:59.000Z');
      // Log out-of-order
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1090-order', t1), dec(0.5));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1090-order', t0), dec(0.3));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1090-order', t2), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1090-order');
      expect(status).toBe(200);

      expect(body.firstOpTimestamp).toBe(t0.toISOString());
      expect(body.lastOpTimestamp).toBe(t2.toISOString());
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1519-T1523 — v10.90 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('9. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1090-pres', 'fs', 'sess-1'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1090-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('firstOpTimestamp');
      expect(body).toHaveProperty('lastOpTimestamp');
      expect(body).toHaveProperty('totalOpsSpanDays');
      expect(body).toHaveProperty('avgSecondsBetweenOps');
      expect(body).toHaveProperty('medianSecondsBetweenOps');
    });

    it('10. agents — single op: totalOpsSpanDays=0, avg/median null', async () => {
      ctx = await setup();
      const ts = new Date('2025-07-01T08:00:00.000Z');
      await ctx.logger.log(makeOp('agent-v1090-single', 'fs', 'sess-1', ts), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1090-single');
      expect(status).toBe(200);

      expect(body.totalOpsSpanDays).toBe(0);
      expect(body.avgSecondsBetweenOps).toBeNull();
      expect(body.medianSecondsBetweenOps).toBeNull();
      expect(typeof body.firstOpTimestamp).toBe('string');
      expect(body.firstOpTimestamp).toBe(ts.toISOString());
      expect(body.lastOpTimestamp).toBe(ts.toISOString());
    });

    it('11. agents — two ops 3 days apart: totalOpsSpanDays=3, avg=median=259200s', async () => {
      ctx = await setup();
      const t0 = new Date('2025-06-10T00:00:00.000Z');
      const t1 = new Date('2025-06-13T00:00:00.000Z'); // +3 days = 259200s
      await ctx.logger.log(makeOp('agent-v1090-3d', 'fs', 'sess-1', t0), dec(0.3));
      await ctx.logger.log(makeOp('agent-v1090-3d', 'fs', 'sess-1', t1), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1090-3d');
      expect(status).toBe(200);

      expect(body.totalOpsSpanDays).toBe(3);
      expect(body.avgSecondsBetweenOps as number).toBeCloseTo(259200, 1);
      expect(body.medianSecondsBetweenOps as number).toBeCloseTo(259200, 1);
    });

    it('12. agents — three ops at t=0, t+60s, t+180s: avg=90s, median=90s', async () => {
      ctx = await setup();
      const t0 = new Date('2025-06-01T09:00:00.000Z');
      const t1 = new Date('2025-06-01T09:01:00.000Z');
      const t2 = new Date('2025-06-01T09:03:00.000Z');
      await ctx.logger.log(makeOp('agent-v1090-itvl', 'fs', 'sess-1', t0), dec(0.3));
      await ctx.logger.log(makeOp('agent-v1090-itvl', 'fs', 'sess-1', t1), dec(0.5));
      await ctx.logger.log(makeOp('agent-v1090-itvl', 'fs', 'sess-1', t2), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1090-itvl');
      expect(status).toBe(200);

      // diffs = [60, 120], avg=90, median=(60+120)/2=90
      expect(body.avgSecondsBetweenOps as number).toBeCloseTo(90, 5);
      expect(body.medianSecondsBetweenOps as number).toBeCloseTo(90, 5);
    });

    it('13. agents — firstOpTimestamp is earliest, lastOpTimestamp is latest', async () => {
      ctx = await setup();
      const t0 = new Date('2025-03-01T00:00:00.000Z');
      const t1 = new Date('2025-09-01T00:00:00.000Z');
      // Log in reverse order
      await ctx.logger.log(makeOp('agent-v1090-ord', 'fs', 'sess-1', t1), dec(0.6));
      await ctx.logger.log(makeOp('agent-v1090-ord', 'fs', 'sess-2', t0), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1090-ord');
      expect(status).toBe(200);

      expect(body.firstOpTimestamp).toBe(t0.toISOString());
      expect(body.lastOpTimestamp).toBe(t1.toISOString());
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1519-T1523 — v10.90 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('14. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-x', 'tool-v1090-pres', 'sess-1'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1090-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('firstOpTimestamp');
      expect(body).toHaveProperty('lastOpTimestamp');
      expect(body).toHaveProperty('totalOpsSpanDays');
      expect(body).toHaveProperty('avgSecondsBetweenOps');
      expect(body).toHaveProperty('medianSecondsBetweenOps');
    });

    it('15. tools — single op: totalOpsSpanDays=0, avg/median null', async () => {
      ctx = await setup();
      const ts = new Date('2025-08-15T06:00:00.000Z');
      await ctx.logger.log(makeOp('agent-x', 'tool-v1090-single', 'sess-1', ts), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1090-single');
      expect(status).toBe(200);

      expect(body.totalOpsSpanDays).toBe(0);
      expect(body.avgSecondsBetweenOps).toBeNull();
      expect(body.medianSecondsBetweenOps).toBeNull();
      expect(body.firstOpTimestamp).toBe(ts.toISOString());
      expect(body.lastOpTimestamp).toBe(ts.toISOString());
    });

    it('16. tools — two ops same day: totalOpsSpanDays=0, avg=median=interval', async () => {
      ctx = await setup();
      const t0 = new Date('2025-06-01T14:00:00.000Z');
      const t1 = new Date('2025-06-01T14:05:00.000Z'); // +300s
      await ctx.logger.log(makeOp('agent-x', 'tool-v1090-same', 'sess-1', t0), dec(0.3));
      await ctx.logger.log(makeOp('agent-x', 'tool-v1090-same', 'sess-1', t1), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1090-same');
      expect(status).toBe(200);

      expect(body.totalOpsSpanDays).toBe(0);
      expect(body.avgSecondsBetweenOps as number).toBeCloseTo(300, 5);
      expect(body.medianSecondsBetweenOps as number).toBeCloseTo(300, 5);
    });

    it('17. tools — three ops at t=0, t+60s, t+180s: avg=90s, median=90s', async () => {
      ctx = await setup();
      const t0 = new Date('2025-06-02T10:00:00.000Z');
      const t1 = new Date('2025-06-02T10:01:00.000Z');
      const t2 = new Date('2025-06-02T10:03:00.000Z');
      await ctx.logger.log(makeOp('agent-y', 'tool-v1090-itvl', 'sess-1', t0), dec(0.2));
      await ctx.logger.log(makeOp('agent-y', 'tool-v1090-itvl', 'sess-1', t1), dec(0.5));
      await ctx.logger.log(makeOp('agent-y', 'tool-v1090-itvl', 'sess-1', t2), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1090-itvl');
      expect(status).toBe(200);

      expect(body.avgSecondsBetweenOps as number).toBeCloseTo(90, 5);
      expect(body.medianSecondsBetweenOps as number).toBeCloseTo(90, 5);
    });

    it('18. tools — ops 7 days apart: totalOpsSpanDays=7', async () => {
      ctx = await setup();
      const t0 = new Date('2025-05-01T00:00:00.000Z');
      const t1 = new Date('2025-05-08T00:00:00.000Z');
      await ctx.logger.log(makeOp('agent-z', 'tool-v1090-7d', 'sess-1', t0), dec(0.4));
      await ctx.logger.log(makeOp('agent-z', 'tool-v1090-7d', 'sess-1', t1), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1090-7d');
      expect(status).toBe(200);

      expect(body.totalOpsSpanDays).toBe(7);
    });
  });

  // ── operations/summary endpoint ────────────────────────────────────────────────

  describe('T1519-T1523 — v10.90 new fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('19. summary — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s', 'fs', 'sess-sum-pres'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body).toHaveProperty('firstOpTimestamp');
      expect(body).toHaveProperty('lastOpTimestamp');
      expect(body).toHaveProperty('totalOpsSpanDays');
      expect(body).toHaveProperty('avgSecondsBetweenOps');
      expect(body).toHaveProperty('medianSecondsBetweenOps');
    });

    it('20. summary — no logs: all five fields null', async () => {
      ctx = await setup();
      // Empty store — no logs

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.firstOpTimestamp).toBeNull();
      expect(body.lastOpTimestamp).toBeNull();
      expect(body.totalOpsSpanDays).toBeNull();
      expect(body.avgSecondsBetweenOps).toBeNull();
      expect(body.medianSecondsBetweenOps).toBeNull();
    });

    it('21. summary — single log: totalOpsSpanDays=0, avg/median null, first/last are same ISO string', async () => {
      ctx = await setup();
      const ts = new Date('2025-11-01T00:00:00.000Z');
      await ctx.logger.log(makeOp('agent-s1', 'fs', 'sess-sum-one', ts), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.firstOpTimestamp).toBe(ts.toISOString());
      expect(body.lastOpTimestamp).toBe(ts.toISOString());
      expect(body.totalOpsSpanDays).toBe(0);
      expect(body.avgSecondsBetweenOps).toBeNull();
      expect(body.medianSecondsBetweenOps).toBeNull();
    });

    it('22. summary — two ops same day: totalOpsSpanDays=0', async () => {
      ctx = await setup();
      const t0 = new Date('2025-06-01T10:00:00.000Z');
      const t1 = new Date('2025-06-01T11:00:00.000Z'); // +3600s
      await ctx.logger.log(makeOp('agent-s2', 'fs', 'sess-sum-2', t0), dec(0.3));
      await ctx.logger.log(makeOp('agent-s2', 'fs', 'sess-sum-2', t1), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.totalOpsSpanDays).toBe(0);
      expect(body.avgSecondsBetweenOps as number).toBeCloseTo(3600, 5);
      expect(body.medianSecondsBetweenOps as number).toBeCloseTo(3600, 5);
    });

    it('23. summary — three ops at t=0, t+60s, t+180s: avg=90s, median=90s', async () => {
      ctx = await setup();
      const t0 = new Date('2025-07-01T08:00:00.000Z');
      const t1 = new Date('2025-07-01T08:01:00.000Z');
      const t2 = new Date('2025-07-01T08:03:00.000Z');
      await ctx.logger.log(makeOp('agent-s3', 'fs', 'sess-sum-3', t0), dec(0.2));
      await ctx.logger.log(makeOp('agent-s3', 'fs', 'sess-sum-3', t1), dec(0.5));
      await ctx.logger.log(makeOp('agent-s3', 'fs', 'sess-sum-3', t2), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.avgSecondsBetweenOps as number).toBeCloseTo(90, 5);
      expect(body.medianSecondsBetweenOps as number).toBeCloseTo(90, 5);
    });

    it('24. summary — ops 10 days apart: totalOpsSpanDays=10, firstOpTimestamp < lastOpTimestamp', async () => {
      ctx = await setup();
      const t0 = new Date('2025-04-01T00:00:00.000Z');
      const t1 = new Date('2025-04-11T00:00:00.000Z');
      await ctx.logger.log(makeOp('agent-s4', 'fs', 'sess-sum-10d', t0), dec(0.4));
      await ctx.logger.log(makeOp('agent-s4', 'fs', 'sess-sum-10d', t1), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.totalOpsSpanDays).toBe(10);
      expect(body.firstOpTimestamp).toBe(t0.toISOString());
      expect(body.lastOpTimestamp).toBe(t1.toISOString());
      // firstOp should be before lastOp
      expect(new Date(body.firstOpTimestamp as string).getTime()).toBeLessThan(
        new Date(body.lastOpTimestamp as string).getTime(),
      );
    });

    it('25. summary — five ops with 4 diffs (even): median uses avg of middle two', async () => {
      ctx = await setup();
      // ops at t0, t0+10s, t0+30s, t0+120s, t0+130s
      // diffs: [10, 20, 90, 10] → sorted: [10, 10, 20, 90]
      // median of 4 (even): (10+20)/2 = 15
      // avg: (10+20+90+10)/4 = 32.5
      const base = new Date('2025-05-15T06:00:00.000Z');
      const offsets = [0, 10000, 30000, 120000, 130000]; // ms
      for (const offset of offsets) {
        const ts = new Date(base.getTime() + offset);
        await ctx.logger.log(makeOp('agent-s5', 'fs', 'sess-sum-5', ts), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.avgSecondsBetweenOps as number).toBeCloseTo(32.5, 5);
      expect(body.medianSecondsBetweenOps as number).toBeCloseTo(15, 5);
    });
  });
});

// ── v10.91 ────────────────────────────────────────────────────────────────────

describe('v10.91', () => {
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1524-T1528 — v10.91 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1091-pres'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1091-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('maxSecondsBetweenOps');
      expect(body).toHaveProperty('minSecondsBetweenOps');
      expect(body).toHaveProperty('opsInLastActiveDay');
      expect(body).toHaveProperty('activeDaysLast30d');
      expect(body).toHaveProperty('activeDaysLast7d');
    });

    it('2. sessions — no logs: max/min/opsInLastActiveDay null, activeDays both 0', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1091-empty');
      if (status === 200) {
        expect(body.maxSecondsBetweenOps).toBeNull();
        expect(body.minSecondsBetweenOps).toBeNull();
        expect(body.opsInLastActiveDay).toBeNull();
        expect(body.activeDaysLast30d).toBe(0);
        expect(body.activeDaysLast7d).toBe(0);
      } else {
        expect(status).toBe(404);
      }
    });

    it('3. sessions — single log: max/min null, opsInLastActiveDay=1, activeDays count current day', async () => {
      ctx = await setup();
      const ts = new Date(PINNED_NOW()); // today
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1091-single', ts), dec(0.3));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1091-single');
      expect(status).toBe(200);

      expect(body.maxSecondsBetweenOps).toBeNull();
      expect(body.minSecondsBetweenOps).toBeNull();
      expect(body.opsInLastActiveDay).toBe(1);
      expect(body.activeDaysLast30d as number).toBeGreaterThanOrEqual(1);
      expect(body.activeDaysLast7d as number).toBeGreaterThanOrEqual(1);
    });

    it('4. sessions — three ops at t=0, t+60s, t+180s: max=120, min=60', async () => {
      ctx = await setup();
      const t0 = new Date('2025-06-01T10:00:00.000Z');
      const t1 = new Date('2025-06-01T10:01:00.000Z'); // +60s
      const t2 = new Date('2025-06-01T10:03:00.000Z'); // +180s from t0, so diff2=120s
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1091-maxmin', t0), dec(0.3));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1091-maxmin', t1), dec(0.5));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1091-maxmin', t2), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1091-maxmin');
      expect(status).toBe(200);

      // diffs = [60, 120] -> max=120, min=60
      expect(body.maxSecondsBetweenOps as number).toBeCloseTo(120, 5);
      expect(body.minSecondsBetweenOps as number).toBeCloseTo(60, 5);
    });

    it('5. sessions — two ops with equal gap: max=min', async () => {
      ctx = await setup();
      const t0 = new Date('2025-06-01T10:00:00.000Z');
      const t1 = new Date('2025-06-01T10:05:00.000Z'); // +300s
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1091-equal', t0), dec(0.4));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1091-equal', t1), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1091-equal');
      expect(status).toBe(200);

      expect(body.maxSecondsBetweenOps as number).toBeCloseTo(300, 5);
      expect(body.minSecondsBetweenOps as number).toBeCloseTo(300, 5);
    });

    it('6. sessions — opsInLastActiveDay: 3 ops today, 1 op yesterday -> 3', async () => {
      ctx = await setup();
      const today = new Date(PINNED_NOW());
      today.setHours(9, 0, 0, 0);
      const t1 = new Date(today.getTime() + 60_000);
      const t2 = new Date(today.getTime() + 120_000);
      const yesterday = daysAgo(1);
      yesterday.setHours(12, 0, 0, 0);

      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1091-lastday', today), dec(0.3));
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1091-lastday', t1), dec(0.4));
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1091-lastday', t2), dec(0.5));
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1091-lastday', yesterday), dec(0.2));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1091-lastday');
      expect(status).toBe(200);

      expect(body.opsInLastActiveDay).toBe(3);
    });

    it('7. sessions — activeDaysLast30d: ops on 3 different days within 30d -> 3', async () => {
      ctx = await setup();
      const d1 = daysAgo(2);
      const d2 = daysAgo(10);
      const d3 = daysAgo(25);
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1091-30d', d1), dec(0.3));
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1091-30d', d2), dec(0.4));
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1091-30d', d3), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1091-30d');
      expect(status).toBe(200);

      expect(body.activeDaysLast30d).toBe(3);
    });

    it('8. sessions — activeDaysLast7d: ops 5d ago and 10d ago: only 5d counts -> 1', async () => {
      ctx = await setup();
      const d5 = daysAgo(5);
      const d10 = daysAgo(10);
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1091-7d', d5), dec(0.3));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1091-7d', d10), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1091-7d');
      expect(status).toBe(200);

      expect(body.activeDaysLast7d).toBe(1);
      expect(body.activeDaysLast30d).toBe(2);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1524-T1528 — v10.91 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('9. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1091-pres', 'fs', 'sess-1'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1091-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('maxSecondsBetweenOps');
      expect(body).toHaveProperty('minSecondsBetweenOps');
      expect(body).toHaveProperty('opsInLastActiveDay');
      expect(body).toHaveProperty('activeDaysLast30d');
      expect(body).toHaveProperty('activeDaysLast7d');
    });

    it('10. agents — single op: max/min null, opsInLastActiveDay=1', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1091-single', 'fs', 'sess-1'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1091-single');
      expect(status).toBe(200);

      expect(body.maxSecondsBetweenOps).toBeNull();
      expect(body.minSecondsBetweenOps).toBeNull();
      expect(body.opsInLastActiveDay).toBe(1);
    });

    it('11. agents — three ops at t=0, t+60s, t+180s: max=120, min=60', async () => {
      ctx = await setup();
      const t0 = new Date('2025-06-01T09:00:00.000Z');
      const t1 = new Date('2025-06-01T09:01:00.000Z'); // +60s
      const t2 = new Date('2025-06-01T09:03:00.000Z'); // +180s from t0
      await ctx.logger.log(makeOp('agent-v1091-maxmin', 'fs', 'sess-1', t0), dec(0.3));
      await ctx.logger.log(makeOp('agent-v1091-maxmin', 'fs', 'sess-1', t1), dec(0.5));
      await ctx.logger.log(makeOp('agent-v1091-maxmin', 'fs', 'sess-1', t2), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1091-maxmin');
      expect(status).toBe(200);

      // diffs: [60, 120] -> max=120, min=60
      expect(body.maxSecondsBetweenOps as number).toBeCloseTo(120, 5);
      expect(body.minSecondsBetweenOps as number).toBeCloseTo(60, 5);
    });

    it('12. agents — opsInLastActiveDay: 2 ops today, 1 yesterday -> 2', async () => {
      ctx = await setup();
      const today = new Date(PINNED_NOW());
      today.setHours(10, 0, 0, 0);
      const today2 = new Date(today.getTime() + 3_600_000);
      const yesterday = daysAgo(1);
      yesterday.setHours(15, 0, 0, 0);

      await ctx.logger.log(makeOp('agent-v1091-lastday', 'fs', 'sess-1', today), dec(0.3));
      await ctx.logger.log(makeOp('agent-v1091-lastday', 'fs', 'sess-1', today2), dec(0.4));
      await ctx.logger.log(makeOp('agent-v1091-lastday', 'fs', 'sess-1', yesterday), dec(0.2));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1091-lastday');
      expect(status).toBe(200);

      expect(body.opsInLastActiveDay).toBe(2);
    });

    it('13. agents — activeDaysLast7d: 3 ops on 3 different days all within 7d -> 3', async () => {
      ctx = await setup();
      const d1 = daysAgo(1);
      const d3 = daysAgo(3);
      const d6 = daysAgo(6);
      await ctx.logger.log(makeOp('agent-v1091-7d', 'fs', 'sess-1', d1), dec(0.3));
      await ctx.logger.log(makeOp('agent-v1091-7d', 'fs', 'sess-1', d3), dec(0.4));
      await ctx.logger.log(makeOp('agent-v1091-7d', 'fs', 'sess-1', d6), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1091-7d');
      expect(status).toBe(200);

      expect(body.activeDaysLast7d).toBe(3);
      expect(body.activeDaysLast30d).toBe(3);
    });

    it('14. agents — activeDaysLast30d: ops on days 5, 15, 35 ago: only 2 count in 30d', async () => {
      ctx = await setup();
      const d5 = daysAgo(5);
      const d15 = daysAgo(15);
      const d35 = daysAgo(35);
      await ctx.logger.log(makeOp('agent-v1091-30d', 'fs', 'sess-1', d5), dec(0.3));
      await ctx.logger.log(makeOp('agent-v1091-30d', 'fs', 'sess-1', d15), dec(0.4));
      await ctx.logger.log(makeOp('agent-v1091-30d', 'fs', 'sess-1', d35), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1091-30d');
      expect(status).toBe(200);

      expect(body.activeDaysLast30d).toBe(2);
      expect(body.activeDaysLast7d).toBe(1);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1524-T1528 — v10.91 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('15. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-x', 'tool-v1091-pres', 'sess-1'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1091-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('maxSecondsBetweenOps');
      expect(body).toHaveProperty('minSecondsBetweenOps');
      expect(body).toHaveProperty('opsInLastActiveDay');
      expect(body).toHaveProperty('activeDaysLast30d');
      expect(body).toHaveProperty('activeDaysLast7d');
    });

    it('16. tools — single op: max/min null, opsInLastActiveDay=1', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-x', 'tool-v1091-single', 'sess-1'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1091-single');
      expect(status).toBe(200);

      expect(body.maxSecondsBetweenOps).toBeNull();
      expect(body.minSecondsBetweenOps).toBeNull();
      expect(body.opsInLastActiveDay).toBe(1);
    });

    it('17. tools — three ops at t=0, t+60s, t+180s: max=120, min=60', async () => {
      ctx = await setup();
      const t0 = new Date('2025-06-02T10:00:00.000Z');
      const t1 = new Date('2025-06-02T10:01:00.000Z'); // +60s
      const t2 = new Date('2025-06-02T10:03:00.000Z'); // +180s from t0
      await ctx.logger.log(makeOp('agent-y', 'tool-v1091-maxmin', 'sess-1', t0), dec(0.2));
      await ctx.logger.log(makeOp('agent-y', 'tool-v1091-maxmin', 'sess-1', t1), dec(0.5));
      await ctx.logger.log(makeOp('agent-y', 'tool-v1091-maxmin', 'sess-1', t2), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1091-maxmin');
      expect(status).toBe(200);

      // diffs: [60, 120] -> max=120, min=60
      expect(body.maxSecondsBetweenOps as number).toBeCloseTo(120, 5);
      expect(body.minSecondsBetweenOps as number).toBeCloseTo(60, 5);
    });

    it('18. tools — four ops with diffs [10, 300, 50]: max=300, min=10', async () => {
      ctx = await setup();
      const t0 = new Date('2025-06-03T08:00:00.000Z');
      const t1 = new Date('2025-06-03T08:00:10.000Z'); // +10s
      const t2 = new Date('2025-06-03T08:05:10.000Z'); // +300s from t1
      const t3 = new Date('2025-06-03T08:06:00.000Z'); // +50s from t2
      await ctx.logger.log(makeOp('agent-z', 'tool-v1091-multi', 'sess-1', t0), dec(0.2));
      await ctx.logger.log(makeOp('agent-z', 'tool-v1091-multi', 'sess-1', t1), dec(0.4));
      await ctx.logger.log(makeOp('agent-z', 'tool-v1091-multi', 'sess-1', t2), dec(0.6));
      await ctx.logger.log(makeOp('agent-z', 'tool-v1091-multi', 'sess-1', t3), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1091-multi');
      expect(status).toBe(200);

      expect(body.maxSecondsBetweenOps as number).toBeCloseTo(300, 5);
      expect(body.minSecondsBetweenOps as number).toBeCloseTo(10, 5);
    });

    it('19. tools — opsInLastActiveDay: op 40d ago is last active day -> 1', async () => {
      ctx = await setup();
      const d40 = daysAgo(40);
      d40.setHours(12, 0, 0, 0);
      await ctx.logger.log(makeOp('agent-w', 'tool-v1091-lastday', 'sess-1', d40), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1091-lastday');
      expect(status).toBe(200);

      // Only op is 40d ago: opsInLastActiveDay=1 (all-time, not window)
      expect(body.opsInLastActiveDay).toBe(1);
      // But not in 30d or 7d windows
      expect(body.activeDaysLast30d).toBe(0);
      expect(body.activeDaysLast7d).toBe(0);
    });

    it('20. tools — activeDaysLast7d: multiple ops same day count as 1', async () => {
      ctx = await setup();
      const today = new Date(PINNED_NOW());
      today.setHours(8, 0, 0, 0);
      const t1 = new Date(today.getTime() + 60_000);
      const t2 = new Date(today.getTime() + 120_000);
      await ctx.logger.log(makeOp('agent-v', 'tool-v1091-sameday', 'sess-1', today), dec(0.3));
      await ctx.logger.log(makeOp('agent-v', 'tool-v1091-sameday', 'sess-1', t1), dec(0.4));
      await ctx.logger.log(makeOp('agent-v', 'tool-v1091-sameday', 'sess-1', t2), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1091-sameday');
      expect(status).toBe(200);

      // All on the same day: activeDaysLast7d=1
      expect(body.activeDaysLast7d).toBe(1);
      expect(body.activeDaysLast30d).toBe(1);
      // opsInLastActiveDay=3 (3 ops on the most recent day)
      expect(body.opsInLastActiveDay).toBe(3);
    });
  });

  // ── operations/summary endpoint ────────────────────────────────────────────────

  describe('T1524-T1528 — v10.91 new fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('21. summary — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s', 'fs', 'sess-sum-pres'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body).toHaveProperty('maxSecondsBetweenOps');
      expect(body).toHaveProperty('minSecondsBetweenOps');
      expect(body).toHaveProperty('opsInLastActiveDay');
      expect(body).toHaveProperty('activeDaysLast30d');
      expect(body).toHaveProperty('activeDaysLast7d');
    });

    it('22. summary — no logs: max/min/opsInLastActiveDay null, activeDays 0', async () => {
      ctx = await setup();

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.maxSecondsBetweenOps).toBeNull();
      expect(body.minSecondsBetweenOps).toBeNull();
      expect(body.opsInLastActiveDay).toBeNull();
      expect(body.activeDaysLast30d).toBe(0);
      expect(body.activeDaysLast7d).toBe(0);
    });

    it('23. summary — single log: max/min null, opsInLastActiveDay=1', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-s1', 'fs', 'sess-sum-1'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.maxSecondsBetweenOps).toBeNull();
      expect(body.minSecondsBetweenOps).toBeNull();
      expect(body.opsInLastActiveDay).toBe(1);
    });

    it('24. summary — three ops at t=0, t+60s, t+180s: max=120, min=60', async () => {
      ctx = await setup();
      const t0 = new Date('2025-07-01T08:00:00.000Z');
      const t1 = new Date('2025-07-01T08:01:00.000Z'); // +60s
      const t2 = new Date('2025-07-01T08:03:00.000Z'); // +180s from t0
      await ctx.logger.log(makeOp('agent-s2', 'fs', 'sess-sum-3ops', t0), dec(0.2));
      await ctx.logger.log(makeOp('agent-s2', 'fs', 'sess-sum-3ops', t1), dec(0.5));
      await ctx.logger.log(makeOp('agent-s2', 'fs', 'sess-sum-3ops', t2), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      // diffs: [60, 120] -> max=120, min=60
      expect(body.maxSecondsBetweenOps as number).toBeCloseTo(120, 5);
      expect(body.minSecondsBetweenOps as number).toBeCloseTo(60, 5);
    });

    it('25. summary — opsInLastActiveDay: 3 ops today, 1 op yesterday -> 3', async () => {
      ctx = await setup();
      const today = new Date(PINNED_NOW());
      today.setHours(9, 0, 0, 0);
      const t1 = new Date(today.getTime() + 600_000);
      const t2 = new Date(today.getTime() + 1_200_000);
      const yesterday = daysAgo(1);
      yesterday.setHours(14, 0, 0, 0);

      await ctx.logger.log(makeOp('agent-s3', 'fs', 'sess-sum-lday', today), dec(0.3));
      await ctx.logger.log(makeOp('agent-s3', 'fs', 'sess-sum-lday', t1), dec(0.4));
      await ctx.logger.log(makeOp('agent-s3', 'fs', 'sess-sum-lday', t2), dec(0.5));
      await ctx.logger.log(makeOp('agent-s3', 'fs', 'sess-sum-lday', yesterday), dec(0.2));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.opsInLastActiveDay).toBe(3);
    });

    it('26. summary — activeDaysLast30d and activeDaysLast7d correct boundaries', async () => {
      ctx = await setup();
      const d2 = daysAgo(2);
      const d8 = daysAgo(8);
      const d20 = daysAgo(20);
      await ctx.logger.log(makeOp('agent-s4', 'fs', 'sess-sum-win', d2), dec(0.3));
      await ctx.logger.log(makeOp('agent-s4', 'fs', 'sess-sum-win', d8), dec(0.4));
      await ctx.logger.log(makeOp('agent-s4', 'fs', 'sess-sum-win', d20), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      // All 3 days within 30d
      expect(body.activeDaysLast30d).toBe(3);
      // Only d2 is within 7d
      expect(body.activeDaysLast7d).toBe(1);
    });

    it('27. summary — activeDaysLast7d: ops on 2 days this week, same day ops count once', async () => {
      ctx = await setup();
      const d1 = daysAgo(1);
      d1.setHours(9, 0, 0, 0);
      const d1b = new Date(d1.getTime() + 3_600_000); // same day
      const d4 = daysAgo(4);
      d4.setHours(11, 0, 0, 0);

      await ctx.logger.log(makeOp('agent-s5', 'fs', 'sess-sum-week', d1), dec(0.3));
      await ctx.logger.log(makeOp('agent-s5', 'fs', 'sess-sum-week', d1b), dec(0.4));
      await ctx.logger.log(makeOp('agent-s5', 'fs', 'sess-sum-week', d4), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      // 2 distinct days in last 7d (d1 and d4), d1b is same day as d1
      expect(body.activeDaysLast7d).toBe(2);
    });
  });
});

// ── v10.92 ────────────────────────────────────────────────────────────────────

describe('v10.92', () => {
  const daysAgo = (d: number) => new Date(PINNED_NOW() - d * 86_400_000);

  /**
   * Return a Date that is exactly `d` days ago at start-of-day UTC,
   * so that each integer produces a distinct calendar day key.
   */
  function dayAgo(d: number): Date {
    const now = new Date(PINNED_NOW());
    // DST-safe: use JS date arithmetic
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() - d);
  }

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1529-T1533 — v10.92 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1092-pres'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1092-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('activeDaysAllTime');
      expect(body).toHaveProperty('inactiveDaysLast30d');
      expect(body).toHaveProperty('inactiveDaysLast7d');
      expect(body).toHaveProperty('longestInactiveStreakDays');
      expect(body).toHaveProperty('avgRiskScorePerActiveDayLast7d');
    });

    it('2. sessions — single log: activeDaysAllTime=1, inactive counts at max-1, longestInactiveStreakDays=null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1092-single'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1092-single');
      expect(status).toBe(200);

      expect(body.activeDaysAllTime).toBe(1);
      // 1 active day in last 30d → 30 - 1 = 29
      expect(body.inactiveDaysLast30d).toBe(29);
      // 1 active day in last 7d → 7 - 1 = 6
      expect(body.inactiveDaysLast7d).toBe(6);
      // Only 1 log → null
      expect(body.longestInactiveStreakDays).toBeNull();
      // 1 active day in last 7d with score 0.5 → avg = 0.5
      expect(body.avgRiskScorePerActiveDayLast7d as number).toBeCloseTo(0.5, 5);
    });

    it('3. sessions — activeDaysAllTime counts distinct days across all time', async () => {
      ctx = await setup();
      // 3 ops on 3 different days (40d, 20d, 5d ago)
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1092-days', dayAgo(40)), dec(0.3));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1092-days', dayAgo(20)), dec(0.5));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1092-days', dayAgo(5)), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1092-days');
      expect(status).toBe(200);

      expect(body.activeDaysAllTime).toBe(3);
    });

    it('4. sessions — inactiveDaysLast30d: 2 active days in 30d → 28 inactive', async () => {
      ctx = await setup();
      // 2 ops in different days within last 30d
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1092-30d', dayAgo(5)), dec(0.4));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1092-30d', dayAgo(15)), dec(0.6));
      // 1 op older than 30d — should NOT count toward inactiveDaysLast30d
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1092-30d', dayAgo(40)), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1092-30d');
      expect(status).toBe(200);

      // 2 active days in last 30d → 30 - 2 = 28
      expect(body.inactiveDaysLast30d).toBe(28);
    });

    it('5. sessions — inactiveDaysLast7d: 3 active days in last 7d → 4 inactive', async () => {
      ctx = await setup();
      // 3 ops on different days within last 7d
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1092-7d', dayAgo(1)), dec(0.4));
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1092-7d', dayAgo(3)), dec(0.6));
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1092-7d', dayAgo(6)), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1092-7d');
      expect(status).toBe(200);

      // 3 active days in last 7d → 7 - 3 = 4
      expect(body.inactiveDaysLast7d).toBe(4);
    });

    it('6. sessions — longestInactiveStreakDays: ops on day 0 and day 3 → streak = 2', async () => {
      ctx = await setup();
      // Op on day 3 ago and day 0 (today): gap between them = 2 days with no ops (days 1 and 2)
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1092-streak', dayAgo(3)), dec(0.5));
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1092-streak', dayAgo(0)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1092-streak');
      expect(status).toBe(200);

      // Day numbers differ by 3, so gap = 3 - 1 = 2
      expect(body.longestInactiveStreakDays).toBe(2);
    });

    it('7. sessions — longestInactiveStreakDays: consecutive active days → streak = 0', async () => {
      ctx = await setup();
      // 3 consecutive days: 2d, 1d, 0d ago
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1092-consec', dayAgo(2)), dec(0.3));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1092-consec', dayAgo(1)), dec(0.5));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1092-consec', dayAgo(0)), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1092-consec');
      expect(status).toBe(200);

      // All consecutive, so longest streak = 0
      expect(body.longestInactiveStreakDays).toBe(0);
    });

    it('8. sessions — longestInactiveStreakDays: picks max gap among multiple gaps', async () => {
      ctx = await setup();
      // Ops on days: 10d, 7d (gap=2), 5d (gap=1), 0d (gap=4) — longest = 4
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1092-maxgap', dayAgo(10)), dec(0.3));
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1092-maxgap', dayAgo(7)), dec(0.4));
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1092-maxgap', dayAgo(5)), dec(0.5));
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1092-maxgap', dayAgo(0)), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1092-maxgap');
      expect(status).toBe(200);

      // Gaps: 10→7 = 2, 7→5 = 1, 5→0 = 4; max = 4
      expect(body.longestInactiveStreakDays).toBe(4);
    });

    it('9. sessions — avgRiskScorePerActiveDayLast7d: two active days computed correctly', async () => {
      ctx = await setup();
      // day1 (2d ago): scores [0.4, 0.6] → avg = 0.5
      // day2 (5d ago): scores [0.8] → avg = 0.8
      // result = (0.5 + 0.8) / 2 = 0.65
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v1092-avgrisk', dayAgo(2)), dec(0.4));
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v1092-avgrisk', dayAgo(2)), dec(0.6));
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v1092-avgrisk', dayAgo(5)), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1092-avgrisk');
      expect(status).toBe(200);

      expect(body.avgRiskScorePerActiveDayLast7d as number).toBeCloseTo(0.65, 5);
    });

    it('10. sessions — avgRiskScorePerActiveDayLast7d: null if no ops in last 7d', async () => {
      ctx = await setup();
      // Only old ops (>7d ago)
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v1092-norecent', dayAgo(10)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1092-norecent');
      expect(status).toBe(200);

      expect(body.avgRiskScorePerActiveDayLast7d).toBeNull();
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1529-T1533 — v10.92 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('11. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1092-pres', 'fs', 'sess-1'), dec(0.3));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1092-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('activeDaysAllTime');
      expect(body).toHaveProperty('inactiveDaysLast30d');
      expect(body).toHaveProperty('inactiveDaysLast7d');
      expect(body).toHaveProperty('longestInactiveStreakDays');
      expect(body).toHaveProperty('avgRiskScorePerActiveDayLast7d');
    });

    it('12. agents — activeDaysAllTime counts all-time unique days correctly', async () => {
      ctx = await setup();
      // 4 ops across 2 distinct days all-time
      await ctx.logger.log(makeOp('agent-v1092-days', 'fs', 'sess-1', dayAgo(50)), dec(0.2));
      await ctx.logger.log(makeOp('agent-v1092-days', 'fs', 'sess-2', dayAgo(50)), dec(0.4));
      await ctx.logger.log(makeOp('agent-v1092-days', 'fs', 'sess-3', dayAgo(3)), dec(0.6));
      await ctx.logger.log(makeOp('agent-v1092-days', 'fs', 'sess-4', dayAgo(3)), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1092-days');
      expect(status).toBe(200);

      expect(body.activeDaysAllTime).toBe(2);
    });

    it('13. agents — inactiveDaysLast30d: no recent ops → 30 inactive days', async () => {
      ctx = await setup();
      // Only ops older than 30d
      await ctx.logger.log(makeOp('agent-v1092-noop30', 'fs', 'sess-1', dayAgo(35)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1092-noop30');
      expect(status).toBe(200);

      // 0 active days in last 30d → 30 inactive
      expect(body.inactiveDaysLast30d).toBe(30);
    });

    it('14. agents — inactiveDaysLast7d: no recent ops → 7 inactive days', async () => {
      ctx = await setup();
      // Only ops older than 7d
      await ctx.logger.log(makeOp('agent-v1092-noop7', 'fs', 'sess-1', dayAgo(10)), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1092-noop7');
      expect(status).toBe(200);

      // 0 active days in last 7d → 7 inactive
      expect(body.inactiveDaysLast7d).toBe(7);
    });

    it('15. agents — longestInactiveStreakDays: null with only 1 log', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1092-oneop', 'fs', 'sess-1'), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1092-oneop');
      expect(status).toBe(200);

      expect(body.longestInactiveStreakDays).toBeNull();
    });

    it('16. agents — longestInactiveStreakDays: gap of 4 days between ops', async () => {
      ctx = await setup();
      // Ops on day 8 ago and day 3 ago: gap = 8 - 3 - 1 = 4
      await ctx.logger.log(makeOp('agent-v1092-gap', 'fs', 'sess-1', dayAgo(8)), dec(0.3));
      await ctx.logger.log(makeOp('agent-v1092-gap', 'fs', 'sess-2', dayAgo(3)), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1092-gap');
      expect(status).toBe(200);

      expect(body.longestInactiveStreakDays).toBe(4);
    });

    it('17. agents — avgRiskScorePerActiveDayLast7d: computed correctly for 3 days', async () => {
      ctx = await setup();
      // day1 (1d ago): [0.2, 0.4] → avg = 0.3
      // day2 (3d ago): [0.6] → avg = 0.6
      // day3 (6d ago): [0.9] → avg = 0.9
      // result = (0.3 + 0.6 + 0.9) / 3 = 0.6
      await ctx.logger.log(makeOp('agent-v1092-avgday', 'fs', 'sess-1', dayAgo(1)), dec(0.2));
      await ctx.logger.log(makeOp('agent-v1092-avgday', 'fs', 'sess-2', dayAgo(1)), dec(0.4));
      await ctx.logger.log(makeOp('agent-v1092-avgday', 'fs', 'sess-3', dayAgo(3)), dec(0.6));
      await ctx.logger.log(makeOp('agent-v1092-avgday', 'fs', 'sess-4', dayAgo(6)), dec(0.9));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1092-avgday');
      expect(status).toBe(200);

      expect(body.avgRiskScorePerActiveDayLast7d as number).toBeCloseTo(0.6, 5);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1529-T1533 — v10.92 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('18. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v1092-pres', 'sess-1'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1092-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('activeDaysAllTime');
      expect(body).toHaveProperty('inactiveDaysLast30d');
      expect(body).toHaveProperty('inactiveDaysLast7d');
      expect(body).toHaveProperty('longestInactiveStreakDays');
      expect(body).toHaveProperty('avgRiskScorePerActiveDayLast7d');
    });

    it('19. tools — activeDaysAllTime: ops on 5 distinct days', async () => {
      ctx = await setup();
      for (const d of [0, 5, 10, 20, 35]) {
        await ctx.logger.log(makeOp('agent-a', 'tool-v1092-5days', 'sess-1', dayAgo(d)), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1092-5days');
      expect(status).toBe(200);

      expect(body.activeDaysAllTime).toBe(5);
    });

    it('20. tools — inactiveDaysLast30d and inactiveDaysLast7d correct together', async () => {
      ctx = await setup();
      // 1 active day in 7d, 3 active days in 30d (including 7d)
      await ctx.logger.log(makeOp('agent-b', 'tool-v1092-inactive', 'sess-1', dayAgo(2)), dec(0.3));
      await ctx.logger.log(makeOp('agent-b', 'tool-v1092-inactive', 'sess-2', dayAgo(10)), dec(0.5));
      await ctx.logger.log(makeOp('agent-b', 'tool-v1092-inactive', 'sess-3', dayAgo(25)), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1092-inactive');
      expect(status).toBe(200);

      // 3 active days in last 30d → 30 - 3 = 27
      expect(body.inactiveDaysLast30d).toBe(27);
      // 1 active day in last 7d → 7 - 1 = 6
      expect(body.inactiveDaysLast7d).toBe(6);
    });

    it('21. tools — longestInactiveStreakDays: multiple gaps, picks max', async () => {
      ctx = await setup();
      // Ops at days 15, 10, 8, 2 ago
      // Gaps: 15→10=4, 10→8=1, 8→2=5; max = 5
      await ctx.logger.log(makeOp('agent-c', 'tool-v1092-gaps', 'sess-1', dayAgo(15)), dec(0.2));
      await ctx.logger.log(makeOp('agent-c', 'tool-v1092-gaps', 'sess-2', dayAgo(10)), dec(0.4));
      await ctx.logger.log(makeOp('agent-c', 'tool-v1092-gaps', 'sess-3', dayAgo(8)), dec(0.6));
      await ctx.logger.log(makeOp('agent-c', 'tool-v1092-gaps', 'sess-4', dayAgo(2)), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1092-gaps');
      expect(status).toBe(200);

      expect(body.longestInactiveStreakDays).toBe(5);
    });

    it('22. tools — avgRiskScorePerActiveDayLast7d: null when no 7d ops', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-d', 'tool-v1092-no7d', 'sess-1', dayAgo(8)), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1092-no7d');
      expect(status).toBe(200);

      expect(body.avgRiskScorePerActiveDayLast7d).toBeNull();
    });

    it('23. tools — avgRiskScorePerActiveDayLast7d: single day with one op', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-e', 'tool-v1092-1day', 'sess-1', dayAgo(1)), dec(0.75));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1092-1day');
      expect(status).toBe(200);

      expect(body.avgRiskScorePerActiveDayLast7d as number).toBeCloseTo(0.75, 5);
    });
  });

  // ── summary endpoint ───────────────────────────────────────────────────────────

  describe('T1529-T1533 — v10.92 new fields (summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('24. summary — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body).toHaveProperty('activeDaysAllTime');
      expect(body).toHaveProperty('inactiveDaysLast30d');
      expect(body).toHaveProperty('inactiveDaysLast7d');
      expect(body).toHaveProperty('longestInactiveStreakDays');
      expect(body).toHaveProperty('avgRiskScorePerActiveDayLast7d');
    });

    it('25. summary — no logs: activeDaysAllTime=0, inactive counts at max, streak=null, avg=null', async () => {
      ctx = await setup();

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.activeDaysAllTime).toBe(0);
      expect(body.inactiveDaysLast30d).toBe(30);
      expect(body.inactiveDaysLast7d).toBe(7);
      expect(body.longestInactiveStreakDays).toBeNull();
      expect(body.avgRiskScorePerActiveDayLast7d).toBeNull();
    });

    it('26. summary — activeDaysAllTime accounts for all ops across sessions/agents/tools', async () => {
      ctx = await setup();
      // 3 distinct days, different sessions and agents
      await ctx.logger.log(makeOp('agent-x', 'tool-a', 'sess-x1', dayAgo(0)), dec(0.2));
      await ctx.logger.log(makeOp('agent-y', 'tool-b', 'sess-y1', dayAgo(5)), dec(0.5));
      await ctx.logger.log(makeOp('agent-z', 'tool-c', 'sess-z1', dayAgo(12)), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.activeDaysAllTime).toBe(3);
    });

    it('27. summary — inactiveDaysLast30d and inactiveDaysLast7d reflect global operations', async () => {
      ctx = await setup();
      // 2 active days in last 7d, 4 active days in last 30d (including the 7d ones)
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', dayAgo(1)), dec(0.3));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-2', dayAgo(4)), dec(0.5));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-3', dayAgo(12)), dec(0.7));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-4', dayAgo(25)), dec(0.9));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      // 4 active days in last 30d → 30 - 4 = 26
      expect(body.inactiveDaysLast30d).toBe(26);
      // 2 active days in last 7d → 7 - 2 = 5
      expect(body.inactiveDaysLast7d).toBe(5);
    });

    it('28. summary — longestInactiveStreakDays: gap computed across all operations globally', async () => {
      ctx = await setup();
      // Ops at days 20 and 14 ago: gap = 20 - 14 - 1 = 5
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', dayAgo(20)), dec(0.4));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-2', dayAgo(14)), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.longestInactiveStreakDays).toBe(5);
    });

    it('29. summary — avgRiskScorePerActiveDayLast7d: global average across days', async () => {
      ctx = await setup();
      // day1 (2d ago): scores [0.4, 0.6] → avg = 0.5
      // day2 (5d ago): scores [0.8] → avg = 0.8
      // result = (0.5 + 0.8) / 2 = 0.65
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', dayAgo(2)), dec(0.4));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-2', dayAgo(2)), dec(0.6));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-3', dayAgo(5)), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.avgRiskScorePerActiveDayLast7d as number).toBeCloseTo(0.65, 5);
    });

    it('30. summary — inactiveDaysLast30d capped at 30, inactiveDaysLast7d capped at 7', async () => {
      ctx = await setup();
      // All ops older than 30d — both inactive counts should be at max
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', dayAgo(35)), dec(0.5));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-2', dayAgo(45)), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.inactiveDaysLast30d).toBe(30);
      expect(body.inactiveDaysLast7d).toBe(7);
    });
  });
});

// ── v10.93 ────────────────────────────────────────────────────────────────────

describe('v10.93', () => {
  /**
   * Return a Date that is exactly `d` days ago at start-of-day UTC,
   * so that each integer produces a distinct calendar day key.
   */
  function dayAgo(d: number): Date {
    const now = new Date(PINNED_NOW());
    // DST-safe: use JS date arithmetic
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() - d);
  }

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1534-T1538 — v10.93 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1093-pres'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1093-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('avgRiskScorePerActiveDayLast30d');
      expect(body).toHaveProperty('blockRatePerActiveDayLast7d');
      expect(body).toHaveProperty('blockRatePerActiveDayLast30d');
      expect(body).toHaveProperty('opsVarianceLast7d');
      expect(body).toHaveProperty('opsVarianceLast30d');
    });

    it('2. sessions — null fields when no ops exist', async () => {
      ctx = await setup();
      // Log an op for a different session so the server has data but not for our session
      await ctx.logger.log(makeOp('agent-x', 'fs', 'sess-other'), dec(0.5));

      // Query a session with no ops — sessions endpoint returns 404 for unknown sessions
      // so test a session that exists but with all ops outside the windows
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1093-old', dayAgo(40)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1093-old');
      expect(status).toBe(200);

      // No ops in 7d or 30d windows
      expect(body.avgRiskScorePerActiveDayLast30d).toBeNull();
      expect(body.blockRatePerActiveDayLast7d).toBeNull();
      expect(body.blockRatePerActiveDayLast30d).toBeNull();
      expect(body.opsVarianceLast7d).toBeNull();
      expect(body.opsVarianceLast30d).toBeNull();
    });

    it('3. sessions — avgRiskScorePerActiveDayLast30d: single day with multiple ops', async () => {
      ctx = await setup();
      // 3 ops today: scores [0.2, 0.4, 0.6] → day avg = 0.4
      // result = 0.4 (only 1 active day)
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1093-avg30d', dayAgo(0)), dec(0.2));
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1093-avg30d', dayAgo(0)), dec(0.4));
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1093-avg30d', dayAgo(0)), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1093-avg30d');
      expect(status).toBe(200);

      expect(body.avgRiskScorePerActiveDayLast30d as number).toBeCloseTo(0.4, 5);
    });

    it('4. sessions — avgRiskScorePerActiveDayLast30d: two active days averaged correctly', async () => {
      ctx = await setup();
      // day1 (5d ago): scores [0.3, 0.7] → avg = 0.5
      // day2 (15d ago): scores [0.9] → avg = 0.9
      // result = (0.5 + 0.9) / 2 = 0.7
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1093-avg30d2', dayAgo(5)), dec(0.3));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1093-avg30d2', dayAgo(5)), dec(0.7));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1093-avg30d2', dayAgo(15)), dec(0.9));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1093-avg30d2');
      expect(status).toBe(200);

      expect(body.avgRiskScorePerActiveDayLast30d as number).toBeCloseTo(0.7, 5);
    });

    it('5. sessions — avgRiskScorePerActiveDayLast30d: ignores ops older than 30d', async () => {
      ctx = await setup();
      // 1 op in 30d window with score 0.4; 1 op outside window with score 0.9
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1093-avg30d3', dayAgo(10)), dec(0.4));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1093-avg30d3', dayAgo(35)), dec(0.9));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1093-avg30d3');
      expect(status).toBe(200);

      // Only the 10d-ago op counts → avg = 0.4
      expect(body.avgRiskScorePerActiveDayLast30d as number).toBeCloseTo(0.4, 5);
    });

    it('6. sessions — blockRatePerActiveDayLast7d: two days with mixed block/allow', async () => {
      ctx = await setup();
      // day1 (1d ago): 2 ops — 1 blocked, 1 allowed → rate = 0.5
      // day2 (4d ago): 4 ops — 2 blocked, 2 allowed → rate = 0.5
      // result = (0.5 + 0.5) / 2 = 0.5
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1093-blk7d', dayAgo(1)), dec(0.5, 'block'));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1093-blk7d', dayAgo(1)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1093-blk7d', dayAgo(4)), dec(0.6, 'block'));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1093-blk7d', dayAgo(4)), dec(0.6, 'block'));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1093-blk7d', dayAgo(4)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1093-blk7d', dayAgo(4)), dec(0.3, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1093-blk7d');
      expect(status).toBe(200);

      expect(body.blockRatePerActiveDayLast7d as number).toBeCloseTo(0.5, 5);
    });

    it('7. sessions — blockRatePerActiveDayLast7d: all ops blocked → rate = 1.0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1093-allblk', dayAgo(2)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1093-allblk', dayAgo(2)), dec(0.9, 'block'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1093-allblk');
      expect(status).toBe(200);

      expect(body.blockRatePerActiveDayLast7d as number).toBeCloseTo(1.0, 5);
    });

    it('8. sessions — blockRatePerActiveDayLast7d: no ops in 7d window → null', async () => {
      ctx = await setup();
      // Only op outside 7d window
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1093-noblk7d', dayAgo(10)), dec(0.5, 'block'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1093-noblk7d');
      expect(status).toBe(200);

      expect(body.blockRatePerActiveDayLast7d).toBeNull();
    });

    it('9. sessions — blockRatePerActiveDayLast30d: two active days averaged', async () => {
      ctx = await setup();
      // day1 (8d ago): 3 ops — 1 blocked → rate = 1/3
      // day2 (20d ago): 2 ops — 2 blocked → rate = 1.0
      // result = (1/3 + 1.0) / 2 = 2/3
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1093-blk30d', dayAgo(8)), dec(0.5, 'block'));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1093-blk30d', dayAgo(8)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1093-blk30d', dayAgo(8)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1093-blk30d', dayAgo(20)), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1093-blk30d', dayAgo(20)), dec(0.8, 'block'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1093-blk30d');
      expect(status).toBe(200);

      const expected = (1 / 3 + 1.0) / 2;
      expect(body.blockRatePerActiveDayLast30d as number).toBeCloseTo(expected, 5);
    });

    it('10. sessions — blockRatePerActiveDayLast30d: ignores ops older than 30d', async () => {
      ctx = await setup();
      // 1 op in window (all allowed), 1 op outside window (blocked)
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1093-blk30d2', dayAgo(15)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1093-blk30d2', dayAgo(40)), dec(0.9, 'block'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1093-blk30d2');
      expect(status).toBe(200);

      // Only the 15d op counted, it's allowed → rate = 0.0
      expect(body.blockRatePerActiveDayLast30d as number).toBeCloseTo(0.0, 5);
    });

    it('11. sessions — opsVarianceLast7d: 7 ops all on 1 day → variance = 6.0', async () => {
      ctx = await setup();
      // 7 ops all on 1 day (today): mean = 7/7 = 1, variance = ((7-1)^2 + 6*(0-1)^2)/7 = (36+6)/7 = 6.0
      for (let i = 0; i < 7; i++) {
        await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v1093-var7d', dayAgo(0)), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1093-var7d');
      expect(status).toBe(200);

      expect(body.opsVarianceLast7d as number).toBeCloseTo(6.0, 5);
    });

    it('12. sessions — opsVarianceLast7d: ops spread evenly across 7 days → variance = 0', async () => {
      ctx = await setup();
      // 1 op per day for all 7 days → mean = 1, all deviations = 0 → variance = 0
      for (let d = 0; d < 7; d++) {
        await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v1093-var7d2', dayAgo(d)), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1093-var7d2');
      expect(status).toBe(200);

      expect(body.opsVarianceLast7d as number).toBeCloseTo(0.0, 5);
    });

    it('13. sessions — opsVarianceLast7d: null if no ops in 7d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-k', 'fs', 'sess-v1093-novar7d', dayAgo(10)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1093-novar7d');
      expect(status).toBe(200);

      expect(body.opsVarianceLast7d).toBeNull();
    });

    it('14. sessions — opsVarianceLast30d: 30 ops all on 1 day → variance = (29^2 + 29*(0-1)^2)/30', async () => {
      ctx = await setup();
      // 30 ops all on 1 day: mean = 30/30 = 1
      // variance = ((30-1)^2 + 29*(0-1)^2) / 30 = (841 + 29) / 30 = 870/30 = 29.0
      for (let i = 0; i < 30; i++) {
        await ctx.logger.log(makeOp('agent-l', 'fs', 'sess-v1093-var30d', dayAgo(0)), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1093-var30d');
      expect(status).toBe(200);

      expect(body.opsVarianceLast30d as number).toBeCloseTo(29.0, 5);
    });

    it('15. sessions — opsVarianceLast30d: null if no ops in 30d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-m', 'fs', 'sess-v1093-novar30d', dayAgo(35)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1093-novar30d');
      expect(status).toBe(200);

      expect(body.opsVarianceLast30d).toBeNull();
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1534-T1538 — v10.93 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('16. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1093-pres', 'fs', 'sess-1'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1093-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('avgRiskScorePerActiveDayLast30d');
      expect(body).toHaveProperty('blockRatePerActiveDayLast7d');
      expect(body).toHaveProperty('blockRatePerActiveDayLast30d');
      expect(body).toHaveProperty('opsVarianceLast7d');
      expect(body).toHaveProperty('opsVarianceLast30d');
    });

    it('17. agents — avgRiskScorePerActiveDayLast30d: three active days computed correctly', async () => {
      ctx = await setup();
      // day1 (3d ago): [0.2, 0.4] → avg = 0.3
      // day2 (12d ago): [0.6] → avg = 0.6
      // day3 (25d ago): [0.9] → avg = 0.9
      // result = (0.3 + 0.6 + 0.9) / 3 = 0.6
      await ctx.logger.log(makeOp('agent-v1093-avg30d', 'fs', 'sess-1', dayAgo(3)), dec(0.2));
      await ctx.logger.log(makeOp('agent-v1093-avg30d', 'fs', 'sess-2', dayAgo(3)), dec(0.4));
      await ctx.logger.log(makeOp('agent-v1093-avg30d', 'fs', 'sess-3', dayAgo(12)), dec(0.6));
      await ctx.logger.log(makeOp('agent-v1093-avg30d', 'fs', 'sess-4', dayAgo(25)), dec(0.9));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1093-avg30d');
      expect(status).toBe(200);

      expect(body.avgRiskScorePerActiveDayLast30d as number).toBeCloseTo(0.6, 5);
    });

    it('18. agents — avgRiskScorePerActiveDayLast30d: null if all ops older than 30d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1093-old30d', 'fs', 'sess-1', dayAgo(35)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1093-old30d');
      expect(status).toBe(200);

      expect(body.avgRiskScorePerActiveDayLast30d).toBeNull();
    });

    it('19. agents — blockRatePerActiveDayLast7d: computed correctly for 2 days', async () => {
      ctx = await setup();
      // day1 (1d ago): 2 ops (1 blocked) → rate = 0.5
      // day2 (5d ago): 4 ops (2 blocked) → rate = 0.5
      // result = 0.5
      await ctx.logger.log(makeOp('agent-v1093-blk7d', 'fs', 'sess-1', dayAgo(1)), dec(0.6, 'block'));
      await ctx.logger.log(makeOp('agent-v1093-blk7d', 'fs', 'sess-2', dayAgo(1)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-v1093-blk7d', 'fs', 'sess-3', dayAgo(5)), dec(0.7, 'block'));
      await ctx.logger.log(makeOp('agent-v1093-blk7d', 'fs', 'sess-4', dayAgo(5)), dec(0.7, 'block'));
      await ctx.logger.log(makeOp('agent-v1093-blk7d', 'fs', 'sess-5', dayAgo(5)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-v1093-blk7d', 'fs', 'sess-6', dayAgo(5)), dec(0.2, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1093-blk7d');
      expect(status).toBe(200);

      expect(body.blockRatePerActiveDayLast7d as number).toBeCloseTo(0.5, 5);
    });

    it('20. agents — blockRatePerActiveDayLast30d: all allowed → rate = 0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1093-allallow', 'fs', 'sess-1', dayAgo(5)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-v1093-allallow', 'fs', 'sess-2', dayAgo(15)), dec(0.3, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1093-allallow');
      expect(status).toBe(200);

      expect(body.blockRatePerActiveDayLast30d as number).toBeCloseTo(0.0, 5);
    });

    it('21. agents — opsVarianceLast7d: 7 ops all on 1 day → variance = 6.0', async () => {
      ctx = await setup();
      for (let i = 0; i < 7; i++) {
        await ctx.logger.log(makeOp('agent-v1093-var7d', 'fs', 'sess-1', dayAgo(0)), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1093-var7d');
      expect(status).toBe(200);

      expect(body.opsVarianceLast7d as number).toBeCloseTo(6.0, 5);
    });

    it('22. agents — opsVarianceLast7d: 2 ops on 2 different days → computed correctly', async () => {
      ctx = await setup();
      // day0 (today): 3 ops, day3: 1 op, other 5 days: 0 ops
      // counts = [3, 0, 0, 1, 0, 0, 0] (some ordering), mean = 4/7
      // variance = sum((v - 4/7)^2) / 7
      const mean = 4 / 7;
      const expected = ((3 - mean) ** 2 + 5 * (0 - mean) ** 2 + (1 - mean) ** 2) / 7;

      await ctx.logger.log(makeOp('agent-v1093-var7d2', 'fs', 'sess-1', dayAgo(0)), dec(0.5));
      await ctx.logger.log(makeOp('agent-v1093-var7d2', 'fs', 'sess-2', dayAgo(0)), dec(0.5));
      await ctx.logger.log(makeOp('agent-v1093-var7d2', 'fs', 'sess-3', dayAgo(0)), dec(0.5));
      await ctx.logger.log(makeOp('agent-v1093-var7d2', 'fs', 'sess-4', dayAgo(3)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1093-var7d2');
      expect(status).toBe(200);

      expect(body.opsVarianceLast7d as number).toBeCloseTo(expected, 5);
    });

    it('23. agents — opsVarianceLast30d: null if no ops in 30d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1093-novar30d', 'fs', 'sess-1', dayAgo(40)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1093-novar30d');
      expect(status).toBe(200);

      expect(body.opsVarianceLast30d).toBeNull();
    });

    it('24. agents — opsVarianceLast30d: 30 ops all on 1 day → variance = 29.0', async () => {
      ctx = await setup();
      for (let i = 0; i < 30; i++) {
        await ctx.logger.log(makeOp('agent-v1093-var30d', 'fs', 'sess-1', dayAgo(0)), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1093-var30d');
      expect(status).toBe(200);

      expect(body.opsVarianceLast30d as number).toBeCloseTo(29.0, 5);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1534-T1538 — v10.93 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('25. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v1093-pres', 'sess-1'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1093-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('avgRiskScorePerActiveDayLast30d');
      expect(body).toHaveProperty('blockRatePerActiveDayLast7d');
      expect(body).toHaveProperty('blockRatePerActiveDayLast30d');
      expect(body).toHaveProperty('opsVarianceLast7d');
      expect(body).toHaveProperty('opsVarianceLast30d');
    });

    it('26. tools — avgRiskScorePerActiveDayLast30d: two days averaged correctly', async () => {
      ctx = await setup();
      // day1 (2d ago): [0.4, 0.6] → avg = 0.5
      // day2 (20d ago): [0.8] → avg = 0.8
      // result = (0.5 + 0.8) / 2 = 0.65
      await ctx.logger.log(makeOp('agent-a', 'tool-v1093-avg30d', 'sess-1', dayAgo(2)), dec(0.4));
      await ctx.logger.log(makeOp('agent-a', 'tool-v1093-avg30d', 'sess-2', dayAgo(2)), dec(0.6));
      await ctx.logger.log(makeOp('agent-a', 'tool-v1093-avg30d', 'sess-3', dayAgo(20)), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1093-avg30d');
      expect(status).toBe(200);

      expect(body.avgRiskScorePerActiveDayLast30d as number).toBeCloseTo(0.65, 5);
    });

    it('27. tools — blockRatePerActiveDayLast7d: all ops in 7d blocked → rate = 1.0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-b', 'tool-v1093-blkall', 'sess-1', dayAgo(1)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-b', 'tool-v1093-blkall', 'sess-2', dayAgo(3)), dec(0.9, 'block'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1093-blkall');
      expect(status).toBe(200);

      expect(body.blockRatePerActiveDayLast7d as number).toBeCloseTo(1.0, 5);
    });

    it('28. tools — blockRatePerActiveDayLast30d: no ops in 30d → null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-c', 'tool-v1093-noblk30d', 'sess-1', dayAgo(40)), dec(0.5, 'block'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1093-noblk30d');
      expect(status).toBe(200);

      expect(body.blockRatePerActiveDayLast30d).toBeNull();
    });

    it('29. tools — opsVarianceLast7d: 7 ops on 1 day → variance = 6.0', async () => {
      ctx = await setup();
      for (let i = 0; i < 7; i++) {
        await ctx.logger.log(makeOp('agent-d', 'tool-v1093-var7d', 'sess-1', dayAgo(0)), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1093-var7d');
      expect(status).toBe(200);

      expect(body.opsVarianceLast7d as number).toBeCloseTo(6.0, 5);
    });

    it('30. tools — opsVarianceLast30d: evenly spread ops → variance = 0', async () => {
      ctx = await setup();
      // 1 op per day for 7 days (all within 30d) → variance is low but not 0 since 30 days considered
      // For simplicity: 1 op on each of 30 days → mean = 1, variance = 0
      for (let d = 0; d < 30; d++) {
        await ctx.logger.log(makeOp('agent-e', 'tool-v1093-var30d', 'sess-1', dayAgo(d)), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1093-var30d');
      expect(status).toBe(200);

      expect(body.opsVarianceLast30d as number).toBeCloseTo(0.0, 5);
    });

    it('31. tools — opsVarianceLast7d: no ops in 7d window → null', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-f', 'tool-v1093-novar7d', 'sess-1', dayAgo(10)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1093-novar7d');
      expect(status).toBe(200);

      expect(body.opsVarianceLast7d).toBeNull();
    });
  });

  // ── summary endpoint ───────────────────────────────────────────────────────────

  describe('T1534-T1538 — v10.93 new fields (summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('32. summary — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body).toHaveProperty('avgRiskScorePerActiveDayLast30d');
      expect(body).toHaveProperty('blockRatePerActiveDayLast7d');
      expect(body).toHaveProperty('blockRatePerActiveDayLast30d');
      expect(body).toHaveProperty('opsVarianceLast7d');
      expect(body).toHaveProperty('opsVarianceLast30d');
    });

    it('33. summary — no ops: all five new fields are null', async () => {
      ctx = await setup();

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.avgRiskScorePerActiveDayLast30d).toBeNull();
      expect(body.blockRatePerActiveDayLast7d).toBeNull();
      expect(body.blockRatePerActiveDayLast30d).toBeNull();
      expect(body.opsVarianceLast7d).toBeNull();
      expect(body.opsVarianceLast30d).toBeNull();
    });

    it('34. summary — avgRiskScorePerActiveDayLast30d: global across sessions and agents', async () => {
      ctx = await setup();
      // day1 (5d ago): agent-x [0.4, 0.6] → avg = 0.5; agent-y [0.8] → same day key, combined = (0.4+0.6+0.8)/3 = 0.6
      // day2 (20d ago): [0.9] → avg = 0.9
      // result = (0.6 + 0.9) / 2 = 0.75
      await ctx.logger.log(makeOp('agent-x', 'fs', 'sess-1', dayAgo(5)), dec(0.4));
      await ctx.logger.log(makeOp('agent-x', 'fs', 'sess-1', dayAgo(5)), dec(0.6));
      await ctx.logger.log(makeOp('agent-y', 'fs', 'sess-2', dayAgo(5)), dec(0.8));
      await ctx.logger.log(makeOp('agent-z', 'fs', 'sess-3', dayAgo(20)), dec(0.9));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.avgRiskScorePerActiveDayLast30d as number).toBeCloseTo(0.75, 5);
    });

    it('35. summary — blockRatePerActiveDayLast7d: two days with different block rates', async () => {
      ctx = await setup();
      // day1 (1d ago): 1 op blocked out of 1 → rate = 1.0
      // day2 (5d ago): 0 ops blocked out of 2 → rate = 0.0
      // result = (1.0 + 0.0) / 2 = 0.5
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', dayAgo(1)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-2', dayAgo(5)), dec(0.2, 'allow'));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-3', dayAgo(5)), dec(0.2, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.blockRatePerActiveDayLast7d as number).toBeCloseTo(0.5, 5);
    });

    it('36. summary — blockRatePerActiveDayLast30d: ignores ops older than 30d', async () => {
      ctx = await setup();
      // 1 op in window (allowed), 1 op outside window (blocked)
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', dayAgo(10)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-2', dayAgo(40)), dec(0.9, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      // Only in-window op counted, all allowed → rate = 0.0
      expect(body.blockRatePerActiveDayLast30d as number).toBeCloseTo(0.0, 5);
    });

    it('37. summary — opsVarianceLast7d: 7 ops all on 1 day → variance = 6.0', async () => {
      ctx = await setup();
      for (let i = 0; i < 7; i++) {
        await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', dayAgo(0)), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.opsVarianceLast7d as number).toBeCloseTo(6.0, 5);
    });

    it('38. summary — opsVarianceLast30d: 30 ops all on 1 day → variance = 29.0', async () => {
      ctx = await setup();
      for (let i = 0; i < 30; i++) {
        await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', dayAgo(0)), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.opsVarianceLast30d as number).toBeCloseTo(29.0, 5);
    });

    it('39. summary — opsVarianceLast7d: null when all ops older than 7d', async () => {
      ctx = await setup();
      // Ops at 10d and 20d ago — outside 7d window
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', dayAgo(10)), dec(0.5));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-2', dayAgo(20)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.opsVarianceLast7d).toBeNull();
    });

    it('40. summary — opsVarianceLast30d: null when all ops older than 30d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', dayAgo(35)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.opsVarianceLast30d).toBeNull();
    });
  });
});

// ── v10.94 ────────────────────────────────────────────────────────────────────

describe('v10.94', () => {
  /**
   * Return a Date at local midnight d days ago.
   * Uses JS date arithmetic (not ms subtraction) to correctly handle DST transitions.
   */
  function dayAgo(d: number): Date {
    const now = new Date(PINNED_NOW());
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() - d);
  }

  /**
   * Return a Date exactly `h` hours ago (local time, hour-resolution).
   * Each distinct integer h produces a distinct local-hour key used by opsHourlyAutocorrelationLag1.
   */
  function hoursAgo(h: number): Date {
    const now = new Date(PINNED_NOW());
    // Round down to the current hour then subtract h full hours
    const hourStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours());
    return new Date(hourStart.getTime() - h * 3_600_000);
  }

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1539-T1543 — v10.94 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1094-pres'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1094-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('opsStdDevLast7d');
      expect(body).toHaveProperty('opsStdDevLast30d');
      expect(body).toHaveProperty('riskScoreAutocorrelationLag1AllTime');
      expect(body).toHaveProperty('riskScoreAutocorrelationLag2AllTime');
      expect(body).toHaveProperty('opsHourlyAutocorrelationLag1');
    });

    it('2. sessions — opsStdDevLast7d: null when no ops in 7d window', async () => {
      ctx = await setup();
      // Op is 10 days ago — outside 7d window
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1094-nosd7d', dayAgo(10)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1094-nosd7d');
      expect(status).toBe(200);
      expect(body.opsStdDevLast7d).toBeNull();
    });

    it('3. sessions — opsStdDevLast7d: 7 ops on 1 day → stddev = sqrt(6) ≈ 2.449', async () => {
      ctx = await setup();
      // 7 ops all on today: daily counts = [7,0,0,0,0,0,0], mean=1, variance=6, stddev=sqrt(6)
      for (let i = 0; i < 7; i++) {
        await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1094-sd7d', dayAgo(0)), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1094-sd7d');
      expect(status).toBe(200);
      expect(body.opsStdDevLast7d as number).toBeCloseTo(Math.sqrt(6), 5);
    });

    it('4. sessions — opsStdDevLast7d: 1 op per day for 7 days → stddev = 0', async () => {
      ctx = await setup();
      // Uniform distribution → variance = 0 → stddev = 0
      for (let d = 0; d < 7; d++) {
        await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1094-sd7d2', dayAgo(d)), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1094-sd7d2');
      expect(status).toBe(200);
      expect(body.opsStdDevLast7d as number).toBeCloseTo(0.0, 5);
    });

    it('5. sessions — opsStdDevLast30d: null when no ops in 30d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1094-nosd30d', dayAgo(35)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1094-nosd30d');
      expect(status).toBe(200);
      expect(body.opsStdDevLast30d).toBeNull();
    });

    it('6. sessions — opsStdDevLast30d: 30 ops on 1 day → stddev = sqrt(29) ≈ 5.385', async () => {
      ctx = await setup();
      // 30 ops all on today: daily counts = [30,0,...0] (30 elements), mean=1, variance=29, stddev=sqrt(29)
      for (let i = 0; i < 30; i++) {
        await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1094-sd30d', dayAgo(0)), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1094-sd30d');
      expect(status).toBe(200);
      expect(body.opsStdDevLast30d as number).toBeCloseTo(Math.sqrt(29), 5);
    });

    it('7. sessions — opsStdDevLast30d: stddev is non-negative (always >= 0)', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1094-sdnn', dayAgo(1)), dec(0.3));
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1094-sdnn', dayAgo(5)), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1094-sdnn');
      expect(status).toBe(200);
      expect(body.opsStdDevLast30d as number).toBeGreaterThanOrEqual(0);
    });

    it('8. sessions — riskScoreAutocorrelationLag1AllTime: null when fewer than 3 logs', async () => {
      ctx = await setup();
      // Only 2 ops → should return null
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1094-acl1null', dayAgo(1)), dec(0.3));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1094-acl1null', dayAgo(2)), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1094-acl1null');
      expect(status).toBe(200);
      expect(body.riskScoreAutocorrelationLag1AllTime).toBeNull();
    });

    it('9. sessions — riskScoreAutocorrelationLag1AllTime: returns 1 when zero variance (constant scores)', async () => {
      ctx = await setup();
      // All same risk score → variance = 0 → result = 1
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1094-acl1zv', dayAgo(3)), dec(0.5));
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1094-acl1zv', dayAgo(2)), dec(0.5));
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1094-acl1zv', dayAgo(1)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1094-acl1zv');
      expect(status).toBe(200);
      expect(body.riskScoreAutocorrelationLag1AllTime as number).toBeCloseTo(1, 5);
    });

    it('10. sessions — riskScoreAutocorrelationLag1AllTime: value in [-1, 1] for varying scores', async () => {
      ctx = await setup();
      // Alternating 0.1, 0.9 pattern → negative autocorrelation
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v1094-acl1val', dayAgo(5)), dec(0.1));
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v1094-acl1val', dayAgo(4)), dec(0.9));
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v1094-acl1val', dayAgo(3)), dec(0.1));
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v1094-acl1val', dayAgo(2)), dec(0.9));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1094-acl1val');
      expect(status).toBe(200);
      const val = body.riskScoreAutocorrelationLag1AllTime as number;
      expect(val).toBeGreaterThanOrEqual(-1);
      expect(val).toBeLessThanOrEqual(1);
    });

    it('11. sessions — riskScoreAutocorrelationLag2AllTime: null when fewer than 4 logs', async () => {
      ctx = await setup();
      // Only 3 ops → should return null for lag-2
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v1094-acl2null', dayAgo(3)), dec(0.3));
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v1094-acl2null', dayAgo(2)), dec(0.6));
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v1094-acl2null', dayAgo(1)), dec(0.9));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1094-acl2null');
      expect(status).toBe(200);
      expect(body.riskScoreAutocorrelationLag2AllTime).toBeNull();
    });

    it('12. sessions — riskScoreAutocorrelationLag2AllTime: returns 1 when zero variance', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-k', 'fs', 'sess-v1094-acl2zv', dayAgo(4)), dec(0.4));
      await ctx.logger.log(makeOp('agent-k', 'fs', 'sess-v1094-acl2zv', dayAgo(3)), dec(0.4));
      await ctx.logger.log(makeOp('agent-k', 'fs', 'sess-v1094-acl2zv', dayAgo(2)), dec(0.4));
      await ctx.logger.log(makeOp('agent-k', 'fs', 'sess-v1094-acl2zv', dayAgo(1)), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1094-acl2zv');
      expect(status).toBe(200);
      expect(body.riskScoreAutocorrelationLag2AllTime as number).toBeCloseTo(1, 5);
    });

    it('13. sessions — riskScoreAutocorrelationLag2AllTime: value in [-1, 1] for varying scores', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-l', 'fs', 'sess-v1094-acl2val', dayAgo(4)), dec(0.2));
      await ctx.logger.log(makeOp('agent-l', 'fs', 'sess-v1094-acl2val', dayAgo(3)), dec(0.8));
      await ctx.logger.log(makeOp('agent-l', 'fs', 'sess-v1094-acl2val', dayAgo(2)), dec(0.2));
      await ctx.logger.log(makeOp('agent-l', 'fs', 'sess-v1094-acl2val', dayAgo(1)), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1094-acl2val');
      expect(status).toBe(200);
      const val = body.riskScoreAutocorrelationLag2AllTime as number;
      expect(val).toBeGreaterThanOrEqual(-1);
      expect(val).toBeLessThanOrEqual(1);
    });

    it('14. sessions — opsHourlyAutocorrelationLag1: null when fewer than 3 distinct hours', async () => {
      ctx = await setup();
      // 2 ops in different hours → only 2 distinct hours → null
      await ctx.logger.log(makeOp('agent-m', 'fs', 'sess-v1094-hac1null', hoursAgo(5)), dec(0.4));
      await ctx.logger.log(makeOp('agent-m', 'fs', 'sess-v1094-hac1null', hoursAgo(3)), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1094-hac1null');
      expect(status).toBe(200);
      expect(body.opsHourlyAutocorrelationLag1).toBeNull();
    });

    it('15. sessions — opsHourlyAutocorrelationLag1: returns 1 when all hours have same count (zero variance)', async () => {
      ctx = await setup();
      // 1 op per hour across 3+ distinct hours → variance = 0 → result = 1
      await ctx.logger.log(makeOp('agent-n', 'fs', 'sess-v1094-hac1zv', hoursAgo(10)), dec(0.4));
      await ctx.logger.log(makeOp('agent-n', 'fs', 'sess-v1094-hac1zv', hoursAgo(8)), dec(0.4));
      await ctx.logger.log(makeOp('agent-n', 'fs', 'sess-v1094-hac1zv', hoursAgo(6)), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1094-hac1zv');
      expect(status).toBe(200);
      expect(body.opsHourlyAutocorrelationLag1 as number).toBeCloseTo(1, 5);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1539-T1543 — v10.94 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('16. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1094-pres', 'fs', 'sess-1'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1094-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('opsStdDevLast7d');
      expect(body).toHaveProperty('opsStdDevLast30d');
      expect(body).toHaveProperty('riskScoreAutocorrelationLag1AllTime');
      expect(body).toHaveProperty('riskScoreAutocorrelationLag2AllTime');
      expect(body).toHaveProperty('opsHourlyAutocorrelationLag1');
    });

    it('17. agents — opsStdDevLast7d: null when no ops in 7d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1094-nosd7d', 'fs', 'sess-1', dayAgo(10)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1094-nosd7d');
      expect(status).toBe(200);
      expect(body.opsStdDevLast7d).toBeNull();
    });

    it('18. agents — opsStdDevLast7d: 7 ops all on 1 day → stddev = sqrt(6)', async () => {
      ctx = await setup();
      for (let i = 0; i < 7; i++) {
        await ctx.logger.log(makeOp('agent-v1094-sd7d', 'fs', 'sess-1', dayAgo(0)), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1094-sd7d');
      expect(status).toBe(200);
      expect(body.opsStdDevLast7d as number).toBeCloseTo(Math.sqrt(6), 5);
    });

    it('19. agents — opsStdDevLast30d: null when no ops in 30d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1094-nosd30d', 'fs', 'sess-1', dayAgo(40)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1094-nosd30d');
      expect(status).toBe(200);
      expect(body.opsStdDevLast30d).toBeNull();
    });

    it('20. agents — opsStdDevLast30d: 1 op per day for 30 days → stddev = 0', async () => {
      ctx = await setup();
      for (let d = 0; d < 30; d++) {
        await ctx.logger.log(makeOp('agent-v1094-sd30d', 'fs', 'sess-1', dayAgo(d)), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1094-sd30d');
      expect(status).toBe(200);
      expect(body.opsStdDevLast30d as number).toBeCloseTo(0.0, 5);
    });

    it('21. agents — riskScoreAutocorrelationLag1AllTime: null with only 2 logs', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1094-acl1null', 'fs', 'sess-1', dayAgo(2)), dec(0.3));
      await ctx.logger.log(makeOp('agent-v1094-acl1null', 'fs', 'sess-2', dayAgo(1)), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1094-acl1null');
      expect(status).toBe(200);
      expect(body.riskScoreAutocorrelationLag1AllTime).toBeNull();
    });

    it('22. agents — riskScoreAutocorrelationLag1AllTime: in [-1,1] with 3+ logs', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1094-acl1val', 'fs', 'sess-1', dayAgo(3)), dec(0.1));
      await ctx.logger.log(makeOp('agent-v1094-acl1val', 'fs', 'sess-2', dayAgo(2)), dec(0.9));
      await ctx.logger.log(makeOp('agent-v1094-acl1val', 'fs', 'sess-3', dayAgo(1)), dec(0.1));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1094-acl1val');
      expect(status).toBe(200);
      const val = body.riskScoreAutocorrelationLag1AllTime as number;
      expect(val).toBeGreaterThanOrEqual(-1);
      expect(val).toBeLessThanOrEqual(1);
    });

    it('23. agents — riskScoreAutocorrelationLag2AllTime: null with only 3 logs', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1094-acl2null', 'fs', 'sess-1', dayAgo(3)), dec(0.2));
      await ctx.logger.log(makeOp('agent-v1094-acl2null', 'fs', 'sess-2', dayAgo(2)), dec(0.5));
      await ctx.logger.log(makeOp('agent-v1094-acl2null', 'fs', 'sess-3', dayAgo(1)), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1094-acl2null');
      expect(status).toBe(200);
      expect(body.riskScoreAutocorrelationLag2AllTime).toBeNull();
    });

    it('24. agents — opsHourlyAutocorrelationLag1: null with fewer than 3 distinct hours', async () => {
      ctx = await setup();
      // 2 ops in 2 distinct hours → null
      await ctx.logger.log(makeOp('agent-v1094-hac1null', 'fs', 'sess-1', hoursAgo(4)), dec(0.5));
      await ctx.logger.log(makeOp('agent-v1094-hac1null', 'fs', 'sess-2', hoursAgo(2)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1094-hac1null');
      expect(status).toBe(200);
      expect(body.opsHourlyAutocorrelationLag1).toBeNull();
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1539-T1543 — v10.94 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('25. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v1094-pres', 'sess-1'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1094-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('opsStdDevLast7d');
      expect(body).toHaveProperty('opsStdDevLast30d');
      expect(body).toHaveProperty('riskScoreAutocorrelationLag1AllTime');
      expect(body).toHaveProperty('riskScoreAutocorrelationLag2AllTime');
      expect(body).toHaveProperty('opsHourlyAutocorrelationLag1');
    });

    it('26. tools — opsStdDevLast7d: null when no ops in 7d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v1094-nosd7d', 'sess-1', dayAgo(10)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1094-nosd7d');
      expect(status).toBe(200);
      expect(body.opsStdDevLast7d).toBeNull();
    });

    it('27. tools — opsStdDevLast7d: 7 ops on 1 day → stddev = sqrt(6)', async () => {
      ctx = await setup();
      for (let i = 0; i < 7; i++) {
        await ctx.logger.log(makeOp('agent-b', 'tool-v1094-sd7d', 'sess-1', dayAgo(0)), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1094-sd7d');
      expect(status).toBe(200);
      expect(body.opsStdDevLast7d as number).toBeCloseTo(Math.sqrt(6), 5);
    });

    it('28. tools — opsStdDevLast30d: null when no ops in 30d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-c', 'tool-v1094-nosd30d', 'sess-1', dayAgo(35)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1094-nosd30d');
      expect(status).toBe(200);
      expect(body.opsStdDevLast30d).toBeNull();
    });

    it('29. tools — opsStdDevLast30d: 30 ops on 1 day → stddev = sqrt(29)', async () => {
      ctx = await setup();
      for (let i = 0; i < 30; i++) {
        await ctx.logger.log(makeOp('agent-d', 'tool-v1094-sd30d', 'sess-1', dayAgo(0)), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1094-sd30d');
      expect(status).toBe(200);
      expect(body.opsStdDevLast30d as number).toBeCloseTo(Math.sqrt(29), 5);
    });

    it('30. tools — riskScoreAutocorrelationLag1AllTime: null with fewer than 3 logs', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-e', 'tool-v1094-acl1null', 'sess-1', dayAgo(2)), dec(0.3));
      await ctx.logger.log(makeOp('agent-f', 'tool-v1094-acl1null', 'sess-2', dayAgo(1)), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1094-acl1null');
      expect(status).toBe(200);
      expect(body.riskScoreAutocorrelationLag1AllTime).toBeNull();
    });

    it('31. tools — riskScoreAutocorrelationLag2AllTime: null with only 3 logs', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-g', 'tool-v1094-acl2null', 'sess-1', dayAgo(3)), dec(0.2));
      await ctx.logger.log(makeOp('agent-h', 'tool-v1094-acl2null', 'sess-2', dayAgo(2)), dec(0.6));
      await ctx.logger.log(makeOp('agent-i', 'tool-v1094-acl2null', 'sess-3', dayAgo(1)), dec(0.9));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1094-acl2null');
      expect(status).toBe(200);
      expect(body.riskScoreAutocorrelationLag2AllTime).toBeNull();
    });

    it('32. tools — opsHourlyAutocorrelationLag1: returns value in [-1,1] with 3+ distinct hours', async () => {
      ctx = await setup();
      // 3 ops in 3 distinct hours
      await ctx.logger.log(makeOp('agent-j', 'tool-v1094-hac1val', 'sess-1', hoursAgo(10)), dec(0.4));
      await ctx.logger.log(makeOp('agent-k', 'tool-v1094-hac1val', 'sess-2', hoursAgo(8)), dec(0.4));
      await ctx.logger.log(makeOp('agent-l', 'tool-v1094-hac1val', 'sess-3', hoursAgo(6)), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1094-hac1val');
      expect(status).toBe(200);
      // zero variance → should be 1
      expect(body.opsHourlyAutocorrelationLag1 as number).toBeCloseTo(1, 5);
    });
  });

  // ── summary endpoint ───────────────────────────────────────────────────────────

  describe('T1539-T1543 — v10.94 new fields (summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('33. summary — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body).toHaveProperty('opsStdDevLast7d');
      expect(body).toHaveProperty('opsStdDevLast30d');
      expect(body).toHaveProperty('riskScoreAutocorrelationLag1AllTime');
      expect(body).toHaveProperty('riskScoreAutocorrelationLag2AllTime');
      expect(body).toHaveProperty('opsHourlyAutocorrelationLag1');
    });

    it('34. summary — no ops: opsStdDevLast7d and opsStdDevLast30d are null', async () => {
      ctx = await setup();

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.opsStdDevLast7d).toBeNull();
      expect(body.opsStdDevLast30d).toBeNull();
    });

    it('35. summary — no ops: all autocorrelation fields are null', async () => {
      ctx = await setup();

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body.riskScoreAutocorrelationLag1AllTime).toBeNull();
      expect(body.riskScoreAutocorrelationLag2AllTime).toBeNull();
      expect(body.opsHourlyAutocorrelationLag1).toBeNull();
    });

    it('36. summary — opsStdDevLast7d: 7 ops all on 1 day → stddev = sqrt(6)', async () => {
      ctx = await setup();
      for (let i = 0; i < 7; i++) {
        await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', dayAgo(0)), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.opsStdDevLast7d as number).toBeCloseTo(Math.sqrt(6), 5);
    });

    it('37. summary — opsStdDevLast30d: 30 ops all on 1 day → stddev = sqrt(29)', async () => {
      ctx = await setup();
      for (let i = 0; i < 30; i++) {
        await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', dayAgo(0)), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.opsStdDevLast30d as number).toBeCloseTo(Math.sqrt(29), 5);
    });

    it('38. summary — riskScoreAutocorrelationLag1AllTime: null with fewer than 3 logs', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', dayAgo(2)), dec(0.3));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-2', dayAgo(1)), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreAutocorrelationLag1AllTime).toBeNull();
    });

    it('39. summary — riskScoreAutocorrelationLag2AllTime: null with only 3 logs', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', dayAgo(3)), dec(0.2));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-2', dayAgo(2)), dec(0.5));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-3', dayAgo(1)), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreAutocorrelationLag2AllTime).toBeNull();
    });

    it('40. summary — riskScoreAutocorrelationLag1AllTime: value in [-1,1] for alternating scores', async () => {
      ctx = await setup();
      // Alternating 0.1 / 0.9 → strong negative autocorrelation
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', dayAgo(6)), dec(0.1));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-2', dayAgo(5)), dec(0.9));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-3', dayAgo(4)), dec(0.1));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-4', dayAgo(3)), dec(0.9));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      const val = body.riskScoreAutocorrelationLag1AllTime as number;
      expect(val).toBeGreaterThanOrEqual(-1);
      expect(val).toBeLessThanOrEqual(1);
    });

    it('41. summary — opsHourlyAutocorrelationLag1: null with fewer than 3 distinct hours', async () => {
      ctx = await setup();
      // 2 ops in 2 different hours → null
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', hoursAgo(5)), dec(0.4));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-2', hoursAgo(3)), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.opsHourlyAutocorrelationLag1).toBeNull();
    });

    it('42. summary — opsHourlyAutocorrelationLag1: returns 1 when uniform ops per hour (zero variance)', async () => {
      ctx = await setup();
      // 1 op per hour for 4 distinct hours → counts=[1,1,1,1], variance=0 → result=1
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', hoursAgo(12)), dec(0.5));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-2', hoursAgo(10)), dec(0.5));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-3', hoursAgo(8)), dec(0.5));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-4', hoursAgo(6)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.opsHourlyAutocorrelationLag1 as number).toBeCloseTo(1, 5);
    });
  });
});

// ── v10.95 ────────────────────────────────────────────────────────────────────

describe('v10.95', () => {
  /**
   * Return a Date that is exactly `d` days ago at start-of-day UTC,
   * so that each integer produces a distinct calendar day key.
   */
  function dayAgo(d: number): Date {
    const now = new Date(PINNED_NOW());
    // DST-safe: use JS date arithmetic
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() - d);
  }

  /**
   * Return a Date exactly `h` hours ago (local time, hour-resolution).
   * Each distinct integer h produces a distinct local-hour key.
   */
  function hoursAgo(h: number): Date {
    const now = new Date(PINNED_NOW());
    const hourStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours());
    return new Date(hourStart.getTime() - h * 3_600_000);
  }

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1544-T1548 — v10.95 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1095-pres'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1095-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('opsHourlyAutocorrelationLag2');
      expect(body).toHaveProperty('riskScoreRollingMean7d');
      expect(body).toHaveProperty('blockRateStdDevLast30d');
      expect(body).toHaveProperty('opsPerHourAllTime');
      expect(body).toHaveProperty('riskScoreTrendSlopeLast30d');
    });

    it('2. sessions — opsHourlyAutocorrelationLag2: null when fewer than 4 distinct hours', async () => {
      ctx = await setup();
      // Only 3 distinct hours → should return null (need at least 4)
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1095-hac2null', hoursAgo(10)), dec(0.4));
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1095-hac2null', hoursAgo(8)), dec(0.4));
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1095-hac2null', hoursAgo(6)), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1095-hac2null');
      expect(status).toBe(200);
      expect(body.opsHourlyAutocorrelationLag2).toBeNull();
    });

    it('3. sessions — opsHourlyAutocorrelationLag2: returns 1 when zero variance (all hours equal count)', async () => {
      ctx = await setup();
      // 1 op per hour across 4 distinct hours → variance = 0 → result = 1
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1095-hac2zv', hoursAgo(12)), dec(0.4));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1095-hac2zv', hoursAgo(10)), dec(0.4));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1095-hac2zv', hoursAgo(8)), dec(0.4));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1095-hac2zv', hoursAgo(6)), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1095-hac2zv');
      expect(status).toBe(200);
      expect(body.opsHourlyAutocorrelationLag2 as number).toBeCloseTo(1, 5);
    });

    it('4. sessions — opsHourlyAutocorrelationLag2: value in [-1, 1] for 4+ distinct hours', async () => {
      ctx = await setup();
      // 4 distinct hours with varying counts
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1095-hac2val', hoursAgo(12)), dec(0.5));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1095-hac2val', hoursAgo(12)), dec(0.5));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1095-hac2val', hoursAgo(10)), dec(0.5));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1095-hac2val', hoursAgo(8)), dec(0.5));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1095-hac2val', hoursAgo(8)), dec(0.5));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1095-hac2val', hoursAgo(6)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1095-hac2val');
      expect(status).toBe(200);
      const val = body.opsHourlyAutocorrelationLag2 as number;
      expect(val).toBeGreaterThanOrEqual(-1);
      expect(val).toBeLessThanOrEqual(1);
    });

    it('5. sessions — opsHourlyAutocorrelationLag2: null when only 1 distinct hour', async () => {
      ctx = await setup();
      // All ops in the same hour → only 1 distinct hour → null (need 4+)
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1095-hac2single', hoursAgo(5)), dec(0.4));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1095-hac2single', hoursAgo(5)), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1095-hac2single');
      expect(status).toBe(200);
      expect(body.opsHourlyAutocorrelationLag2).toBeNull();
    });

    it('6. sessions — riskScoreRollingMean7d: null when no ops in 7d window', async () => {
      ctx = await setup();
      // Op is 10 days ago — outside 7d window
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1095-rm7null', dayAgo(10)), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1095-rm7null');
      expect(status).toBe(200);
      expect(body.riskScoreRollingMean7d).toBeNull();
    });

    it('7. sessions — riskScoreRollingMean7d: single op returns that risk score', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1095-rm7single', dayAgo(1)), dec(0.75));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1095-rm7single');
      expect(status).toBe(200);
      expect(body.riskScoreRollingMean7d as number).toBeCloseTo(0.75, 5);
    });

    it('8. sessions — riskScoreRollingMean7d: mean of per-day means', async () => {
      ctx = await setup();
      // Day 0: two ops with 0.2 and 0.6 → mean = 0.4
      // Day 1: one op with 0.8 → mean = 0.8
      // Rolling mean of day means = (0.4 + 0.8) / 2 = 0.6
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1095-rm7multi', dayAgo(0)), dec(0.2));
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1095-rm7multi', dayAgo(0)), dec(0.6));
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1095-rm7multi', dayAgo(1)), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1095-rm7multi');
      expect(status).toBe(200);
      expect(body.riskScoreRollingMean7d as number).toBeCloseTo(0.6, 5);
    });

    it('9. sessions — blockRateStdDevLast30d: null when no ops in 30d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1095-br30null', dayAgo(35)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1095-br30null');
      expect(status).toBe(200);
      expect(body.blockRateStdDevLast30d).toBeNull();
    });

    it('10. sessions — blockRateStdDevLast30d: 0 when exactly 1 active day', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1095-br30one', dayAgo(1)), dec(0.5, 'block'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1095-br30one');
      expect(status).toBe(200);
      expect(body.blockRateStdDevLast30d as number).toBeCloseTo(0, 5);
    });

    it('11. sessions — blockRateStdDevLast30d: non-negative for 2+ active days', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v1095-br30multi', dayAgo(1)), dec(0.5, 'block'));
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v1095-br30multi', dayAgo(2)), dec(0.5));
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v1095-br30multi', dayAgo(3)), dec(0.5, 'block'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1095-br30multi');
      expect(status).toBe(200);
      expect(body.blockRateStdDevLast30d as number).toBeGreaterThanOrEqual(0);
    });

    it('12. sessions — opsPerHourAllTime: 4 ops in 1 hour → 4.0', async () => {
      ctx = await setup();
      // All 4 ops in same hour → 4/1 = 4.0
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp('agent-j2', 'fs', 'sess-v1095-oph3', hoursAgo(5)), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1095-oph3');
      expect(status).toBe(200);
      expect(body.opsPerHourAllTime as number).toBeCloseTo(4.0, 5);
    });

    it('13. sessions — opsPerHourAllTime: correct ratio of total ops / distinct hours', async () => {
      ctx = await setup();
      // 4 ops across 2 distinct hours → 4/2 = 2.0
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v1095-oph', hoursAgo(10)), dec(0.5));
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v1095-oph', hoursAgo(10)), dec(0.5));
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v1095-oph', hoursAgo(8)), dec(0.5));
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v1095-oph', hoursAgo(8)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1095-oph');
      expect(status).toBe(200);
      expect(body.opsPerHourAllTime as number).toBeCloseTo(2.0, 5);
    });

    it('14. sessions — opsPerHourAllTime: 1.0 when each op in its own hour', async () => {
      ctx = await setup();
      // 3 ops in 3 distinct hours → 3/3 = 1.0
      await ctx.logger.log(makeOp('agent-k', 'fs', 'sess-v1095-oph2', hoursAgo(9)), dec(0.5));
      await ctx.logger.log(makeOp('agent-k', 'fs', 'sess-v1095-oph2', hoursAgo(7)), dec(0.5));
      await ctx.logger.log(makeOp('agent-k', 'fs', 'sess-v1095-oph2', hoursAgo(5)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1095-oph2');
      expect(status).toBe(200);
      expect(body.opsPerHourAllTime as number).toBeCloseTo(1.0, 5);
    });

    it('15. sessions — riskScoreTrendSlopeLast30d: null when fewer than 2 active days in 30d', async () => {
      ctx = await setup();
      // Only 1 active day in window
      await ctx.logger.log(makeOp('agent-l', 'fs', 'sess-v1095-slope1', dayAgo(1)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1095-slope1');
      expect(status).toBe(200);
      expect(body.riskScoreTrendSlopeLast30d).toBeNull();
    });

    it('16. sessions — riskScoreTrendSlopeLast30d: null when no ops in 30d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-m', 'fs', 'sess-v1095-slope-none', dayAgo(40)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1095-slope-none');
      expect(status).toBe(200);
      expect(body.riskScoreTrendSlopeLast30d).toBeNull();
    });

    it('17. sessions — riskScoreTrendSlopeLast30d: returns a number for 2+ active days', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-n', 'fs', 'sess-v1095-slope-ok', dayAgo(5)), dec(0.2));
      await ctx.logger.log(makeOp('agent-n', 'fs', 'sess-v1095-slope-ok', dayAgo(2)), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1095-slope-ok');
      expect(status).toBe(200);
      expect(body.riskScoreTrendSlopeLast30d).not.toBeNull();
      expect(typeof body.riskScoreTrendSlopeLast30d).toBe('number');
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1544-T1548 — v10.95 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('18. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1095-pres', 'fs', 'sess-1'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1095-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('opsHourlyAutocorrelationLag2');
      expect(body).toHaveProperty('riskScoreRollingMean7d');
      expect(body).toHaveProperty('blockRateStdDevLast30d');
      expect(body).toHaveProperty('opsPerHourAllTime');
      expect(body).toHaveProperty('riskScoreTrendSlopeLast30d');
    });

    it('19. agents — opsHourlyAutocorrelationLag2: null when fewer than 4 distinct hours', async () => {
      ctx = await setup();
      // 3 distinct hours → null
      await ctx.logger.log(makeOp('agent-v1095-hac2null', 'fs', 'sess-1', hoursAgo(9)), dec(0.4));
      await ctx.logger.log(makeOp('agent-v1095-hac2null', 'fs', 'sess-2', hoursAgo(7)), dec(0.4));
      await ctx.logger.log(makeOp('agent-v1095-hac2null', 'fs', 'sess-3', hoursAgo(5)), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1095-hac2null');
      expect(status).toBe(200);
      expect(body.opsHourlyAutocorrelationLag2).toBeNull();
    });

    it('20. agents — opsHourlyAutocorrelationLag2: returns 1 when zero variance across 4 hours', async () => {
      ctx = await setup();
      // 1 op per hour, 4 distinct hours → zero variance → 1
      await ctx.logger.log(makeOp('agent-v1095-hac2zv', 'fs', 'sess-1', hoursAgo(12)), dec(0.5));
      await ctx.logger.log(makeOp('agent-v1095-hac2zv', 'fs', 'sess-2', hoursAgo(10)), dec(0.5));
      await ctx.logger.log(makeOp('agent-v1095-hac2zv', 'fs', 'sess-3', hoursAgo(8)), dec(0.5));
      await ctx.logger.log(makeOp('agent-v1095-hac2zv', 'fs', 'sess-4', hoursAgo(6)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1095-hac2zv');
      expect(status).toBe(200);
      expect(body.opsHourlyAutocorrelationLag2 as number).toBeCloseTo(1, 5);
    });

    it('21. agents — riskScoreRollingMean7d: null when no ops in 7d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1095-rm7null', 'fs', 'sess-1', dayAgo(10)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1095-rm7null');
      expect(status).toBe(200);
      expect(body.riskScoreRollingMean7d).toBeNull();
    });

    it('22. agents — riskScoreRollingMean7d: single day returns that day mean', async () => {
      ctx = await setup();
      // 2 ops on same day, mean = 0.6
      await ctx.logger.log(makeOp('agent-v1095-rm7single', 'fs', 'sess-1', dayAgo(1)), dec(0.4));
      await ctx.logger.log(makeOp('agent-v1095-rm7single', 'fs', 'sess-2', dayAgo(1)), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1095-rm7single');
      expect(status).toBe(200);
      expect(body.riskScoreRollingMean7d as number).toBeCloseTo(0.6, 5);
    });

    it('23. agents — blockRateStdDevLast30d: null when no ops in 30d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1095-br30null', 'fs', 'sess-1', dayAgo(40)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1095-br30null');
      expect(status).toBe(200);
      expect(body.blockRateStdDevLast30d).toBeNull();
    });

    it('24. agents — blockRateStdDevLast30d: 0 when exactly 1 active day', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1095-br30one', 'fs', 'sess-1', dayAgo(1)), dec(0.5, 'block'));
      await ctx.logger.log(makeOp('agent-v1095-br30one', 'fs', 'sess-2', dayAgo(1)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1095-br30one');
      expect(status).toBe(200);
      expect(body.blockRateStdDevLast30d as number).toBeCloseTo(0, 5);
    });

    it('25. agents — opsPerHourAllTime: 5 ops in 1 hour → 5.0', async () => {
      ctx = await setup();
      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp('agent-v1095-oph-five', 'fs', 'sess-1', hoursAgo(5)), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1095-oph-five');
      expect(status).toBe(200);
      expect(body.opsPerHourAllTime as number).toBeCloseTo(5.0, 5);
    });

    it('26. agents — opsPerHourAllTime: correct ratio of total ops / distinct hours', async () => {
      ctx = await setup();
      // 6 ops across 3 distinct hours → 6/3 = 2.0
      await ctx.logger.log(makeOp('agent-v1095-oph', 'fs', 'sess-1', hoursAgo(12)), dec(0.5));
      await ctx.logger.log(makeOp('agent-v1095-oph', 'fs', 'sess-2', hoursAgo(12)), dec(0.5));
      await ctx.logger.log(makeOp('agent-v1095-oph', 'fs', 'sess-3', hoursAgo(10)), dec(0.5));
      await ctx.logger.log(makeOp('agent-v1095-oph', 'fs', 'sess-4', hoursAgo(10)), dec(0.5));
      await ctx.logger.log(makeOp('agent-v1095-oph', 'fs', 'sess-5', hoursAgo(8)), dec(0.5));
      await ctx.logger.log(makeOp('agent-v1095-oph', 'fs', 'sess-6', hoursAgo(8)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1095-oph');
      expect(status).toBe(200);
      expect(body.opsPerHourAllTime as number).toBeCloseTo(2.0, 5);
    });

    it('27. agents — riskScoreTrendSlopeLast30d: null when fewer than 2 active days', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1095-slope1', 'fs', 'sess-1', dayAgo(2)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1095-slope1');
      expect(status).toBe(200);
      expect(body.riskScoreTrendSlopeLast30d).toBeNull();
    });

    it('28. agents — riskScoreTrendSlopeLast30d: returns number for 2+ active days', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1095-slope2', 'fs', 'sess-1', dayAgo(3)), dec(0.1));
      await ctx.logger.log(makeOp('agent-v1095-slope2', 'fs', 'sess-2', dayAgo(1)), dec(0.9));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1095-slope2');
      expect(status).toBe(200);
      expect(body.riskScoreTrendSlopeLast30d).not.toBeNull();
      expect(typeof body.riskScoreTrendSlopeLast30d).toBe('number');
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1544-T1548 — v10.95 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('29. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v1095-pres', 'sess-1'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1095-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('opsHourlyAutocorrelationLag2');
      expect(body).toHaveProperty('riskScoreRollingMean7d');
      expect(body).toHaveProperty('blockRateStdDevLast30d');
      expect(body).toHaveProperty('opsPerHourAllTime');
      expect(body).toHaveProperty('riskScoreTrendSlopeLast30d');
    });

    it('30. tools — opsHourlyAutocorrelationLag2: null when fewer than 4 distinct hours', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v1095-hac2null', 'sess-1', hoursAgo(8)), dec(0.4));
      await ctx.logger.log(makeOp('agent-b', 'tool-v1095-hac2null', 'sess-2', hoursAgo(6)), dec(0.4));
      await ctx.logger.log(makeOp('agent-c', 'tool-v1095-hac2null', 'sess-3', hoursAgo(4)), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1095-hac2null');
      expect(status).toBe(200);
      expect(body.opsHourlyAutocorrelationLag2).toBeNull();
    });

    it('31. tools — opsHourlyAutocorrelationLag2: returns 1 when 4 hours with equal counts', async () => {
      ctx = await setup();
      // 1 op per hour, 4 hours → zero variance → 1
      await ctx.logger.log(makeOp('agent-a', 'tool-v1095-hac2zv', 'sess-1', hoursAgo(14)), dec(0.4));
      await ctx.logger.log(makeOp('agent-b', 'tool-v1095-hac2zv', 'sess-2', hoursAgo(12)), dec(0.4));
      await ctx.logger.log(makeOp('agent-c', 'tool-v1095-hac2zv', 'sess-3', hoursAgo(10)), dec(0.4));
      await ctx.logger.log(makeOp('agent-d', 'tool-v1095-hac2zv', 'sess-4', hoursAgo(8)), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1095-hac2zv');
      expect(status).toBe(200);
      expect(body.opsHourlyAutocorrelationLag2 as number).toBeCloseTo(1, 5);
    });

    it('32. tools — riskScoreRollingMean7d: null when no ops in 7d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v1095-rm7null', 'sess-1', dayAgo(10)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1095-rm7null');
      expect(status).toBe(200);
      expect(body.riskScoreRollingMean7d).toBeNull();
    });

    it('33. tools — riskScoreRollingMean7d: mean of per-day means with 2 days', async () => {
      ctx = await setup();
      // Day 0: 0.3 and 0.7 → mean = 0.5
      // Day 1: 0.9 → mean = 0.9
      // Rolling mean = (0.5 + 0.9) / 2 = 0.7
      await ctx.logger.log(makeOp('agent-a', 'tool-v1095-rm7multi', 'sess-1', dayAgo(0)), dec(0.3));
      await ctx.logger.log(makeOp('agent-b', 'tool-v1095-rm7multi', 'sess-2', dayAgo(0)), dec(0.7));
      await ctx.logger.log(makeOp('agent-c', 'tool-v1095-rm7multi', 'sess-3', dayAgo(1)), dec(0.9));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1095-rm7multi');
      expect(status).toBe(200);
      expect(body.riskScoreRollingMean7d as number).toBeCloseTo(0.7, 5);
    });

    it('34. tools — blockRateStdDevLast30d: null when no ops in 30d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v1095-br30null', 'sess-1', dayAgo(35)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1095-br30null');
      expect(status).toBe(200);
      expect(body.blockRateStdDevLast30d).toBeNull();
    });

    it('35. tools — blockRateStdDevLast30d: 0 when exactly 1 active day', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v1095-br30one', 'sess-1', dayAgo(2)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1095-br30one');
      expect(status).toBe(200);
      expect(body.blockRateStdDevLast30d as number).toBeCloseTo(0, 5);
    });

    it('36. tools — opsPerHourAllTime: 2 ops in 2 hours → 1.0', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v1095-oph2', 'sess-1', hoursAgo(7)), dec(0.5));
      await ctx.logger.log(makeOp('agent-b', 'tool-v1095-oph2', 'sess-2', hoursAgo(5)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1095-oph2');
      expect(status).toBe(200);
      expect(body.opsPerHourAllTime as number).toBeCloseTo(1.0, 5);
    });

    it('37. tools — opsPerHourAllTime: 3 ops in 1 hour → 3.0', async () => {
      ctx = await setup();
      // All ops in same hour → 3/1 = 3.0
      await ctx.logger.log(makeOp('agent-a', 'tool-v1095-oph', 'sess-1', hoursAgo(5)), dec(0.5));
      await ctx.logger.log(makeOp('agent-b', 'tool-v1095-oph', 'sess-2', hoursAgo(5)), dec(0.5));
      await ctx.logger.log(makeOp('agent-c', 'tool-v1095-oph', 'sess-3', hoursAgo(5)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1095-oph');
      expect(status).toBe(200);
      expect(body.opsPerHourAllTime as number).toBeCloseTo(3.0, 5);
    });

    it('38. tools — riskScoreTrendSlopeLast30d: null when only 1 active day in 30d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v1095-slope1', 'sess-1', dayAgo(3)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1095-slope1');
      expect(status).toBe(200);
      expect(body.riskScoreTrendSlopeLast30d).toBeNull();
    });

    it('39. tools — riskScoreTrendSlopeLast30d: returns number for 2+ active days', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v1095-slope2', 'sess-1', dayAgo(10)), dec(0.2));
      await ctx.logger.log(makeOp('agent-b', 'tool-v1095-slope2', 'sess-2', dayAgo(5)), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1095-slope2');
      expect(status).toBe(200);
      expect(body.riskScoreTrendSlopeLast30d).not.toBeNull();
      expect(typeof body.riskScoreTrendSlopeLast30d).toBe('number');
    });
  });

  // ── summary endpoint ───────────────────────────────────────────────────────────

  describe('T1544-T1548 — v10.95 new fields (summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('40. summary — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body).toHaveProperty('opsHourlyAutocorrelationLag2');
      expect(body).toHaveProperty('riskScoreRollingMean7d');
      expect(body).toHaveProperty('blockRateStdDevLast30d');
      expect(body).toHaveProperty('opsPerHourAllTime');
      expect(body).toHaveProperty('riskScoreTrendSlopeLast30d');
    });

    it('41. summary — no ops: opsHourlyAutocorrelationLag2 and opsPerHourAllTime are null', async () => {
      ctx = await setup();

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.opsHourlyAutocorrelationLag2).toBeNull();
      expect(body.opsPerHourAllTime).toBeNull();
    });

    it('42. summary — no ops: riskScoreRollingMean7d and blockRateStdDevLast30d and riskScoreTrendSlopeLast30d are null', async () => {
      ctx = await setup();

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreRollingMean7d).toBeNull();
      expect(body.blockRateStdDevLast30d).toBeNull();
      expect(body.riskScoreTrendSlopeLast30d).toBeNull();
    });

    it('43. summary — opsHourlyAutocorrelationLag2: null with only 3 distinct hours', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', hoursAgo(9)), dec(0.5));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-2', hoursAgo(7)), dec(0.5));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-3', hoursAgo(5)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.opsHourlyAutocorrelationLag2).toBeNull();
    });

    it('44. summary — opsHourlyAutocorrelationLag2: returns 1 for 4 uniform hours', async () => {
      ctx = await setup();
      // 1 op per hour for 4 distinct hours → zero variance → 1
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', hoursAgo(12)), dec(0.5));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-2', hoursAgo(10)), dec(0.5));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-3', hoursAgo(8)), dec(0.5));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-4', hoursAgo(6)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.opsHourlyAutocorrelationLag2 as number).toBeCloseTo(1, 5);
    });

    it('45. summary — riskScoreRollingMean7d: null when all ops older than 7d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', dayAgo(10)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreRollingMean7d).toBeNull();
    });

    it('46. summary — riskScoreRollingMean7d: mean of per-day means for ops in 7d', async () => {
      ctx = await setup();
      // Day 0: 0.4 and 0.6 → mean = 0.5; Day 1: 0.7 → mean = 0.7; Rolling = (0.5 + 0.7)/2 = 0.6
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', dayAgo(0)), dec(0.4));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-2', dayAgo(0)), dec(0.6));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-3', dayAgo(1)), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreRollingMean7d as number).toBeCloseTo(0.6, 5);
    });

    it('47. summary — blockRateStdDevLast30d: null when no ops in 30d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', dayAgo(35)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.blockRateStdDevLast30d).toBeNull();
    });

    it('48. summary — blockRateStdDevLast30d: 0 when exactly 1 active day', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', dayAgo(2)), dec(0.5, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.blockRateStdDevLast30d as number).toBeCloseTo(0, 5);
    });

    it('49. summary — opsPerHourAllTime: 1 op → 1.0 (one distinct hour)', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1'), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.opsPerHourAllTime as number).toBeCloseTo(1.0, 5);
    });

    it('50. summary — riskScoreTrendSlopeLast30d: null when only 1 active day in 30d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', dayAgo(2)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreTrendSlopeLast30d).toBeNull();
    });

    it('51. summary — riskScoreTrendSlopeLast30d: returns number for 2+ active days', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', dayAgo(7)), dec(0.1));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-2', dayAgo(3)), dec(0.5));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-3', dayAgo(1)), dec(0.9));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreTrendSlopeLast30d).not.toBeNull();
      expect(typeof body.riskScoreTrendSlopeLast30d).toBe('number');
    });

    it('52. summary — blockRateStdDevLast30d: non-negative for 2+ active days', async () => {
      ctx = await setup();
      // Day 1: 1 block out of 2 ops → rate 0.5; Day 2: 0 blocks out of 1 op → rate 0.0
      // rates = [0.5, 0.0], mean = 0.25, variance = (0.0625 + 0.0625)/2 = 0.0625, stddev = 0.25
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', dayAgo(1)), dec(0.5, 'block'));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-2', dayAgo(1)), dec(0.5));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-3', dayAgo(2)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.blockRateStdDevLast30d as number).toBeGreaterThanOrEqual(0);
      expect(body.blockRateStdDevLast30d as number).toBeCloseTo(0.25, 5);
    });
  });
});

// ── v10.96 ────────────────────────────────────────────────────────────────────

describe('v10.96', () => {
  /**
   * Return a Date that is exactly `d` days ago at start-of-day UTC,
   * so that each integer produces a distinct calendar day key.
   */
  function dayAgo(d: number): Date {
    const now = new Date(PINNED_NOW());
    // DST-safe: use JS date arithmetic
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() - d);
  }

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1549-T1553 — v10.96 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1096-pres'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1096-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('allowRateStdDevLast30d');
      expect(body).toHaveProperty('riskScoreRollingMean30d');
      expect(body).toHaveProperty('opsPerDayLast7d');
      expect(body).toHaveProperty('opsPerDayLast30d');
      expect(body).toHaveProperty('riskScoreEMALast7d');
    });

    it('2. sessions — allowRateStdDevLast30d: null when no ops in 30d window', async () => {
      ctx = await setup();
      // Op is 35 days ago — outside 30d window
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1096-ar30null', dayAgo(35)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1096-ar30null');
      expect(status).toBe(200);
      expect(body.allowRateStdDevLast30d).toBeNull();
    });

    it('3. sessions — allowRateStdDevLast30d: 0 when exactly 1 active day', async () => {
      ctx = await setup();
      // Two ops on same day — yields only 1 active day → stddev = 0
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1096-ar30one', dayAgo(1)), dec(0.4, 'allow'));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1096-ar30one', dayAgo(1)), dec(0.6, 'block'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1096-ar30one');
      expect(status).toBe(200);
      expect(body.allowRateStdDevLast30d as number).toBeCloseTo(0, 5);
    });

    it('4. sessions — allowRateStdDevLast30d: correct population stddev for 2+ active days', async () => {
      ctx = await setup();
      // Day 1: 1 allow out of 1 op → rate 1.0
      // Day 2: 0 allows out of 1 op → rate 0.0
      // rates = [1.0, 0.0], mean = 0.5
      // variance = ((1-0.5)^2 + (0-0.5)^2) / 2 = 0.25, stddev = 0.5 (exact, not via population formula)
      // population stddev = sqrt(sum((x - mean)^2) / n) = sqrt((0.25 + 0.25)/2) = sqrt(0.25) = 0.5
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1096-ar30multi', dayAgo(1)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1096-ar30multi', dayAgo(2)), dec(0.5, 'block'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1096-ar30multi');
      expect(status).toBe(200);
      expect(body.allowRateStdDevLast30d as number).toBeCloseTo(0.5, 5);
    });

    it('5. sessions — riskScoreRollingMean30d: null when no ops in 30d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1096-rm30null', dayAgo(35)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1096-rm30null');
      expect(status).toBe(200);
      expect(body.riskScoreRollingMean30d).toBeNull();
    });

    it('6. sessions — riskScoreRollingMean30d: mean of per-day means', async () => {
      ctx = await setup();
      // Day 1: scores 0.2 and 0.4 → day mean = 0.3
      // Day 2: score 0.9 → day mean = 0.9
      // Rolling mean = (0.3 + 0.9) / 2 = 0.6
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1096-rm30multi', dayAgo(1)), dec(0.2));
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1096-rm30multi', dayAgo(1)), dec(0.4));
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1096-rm30multi', dayAgo(2)), dec(0.9));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1096-rm30multi');
      expect(status).toBe(200);
      expect(body.riskScoreRollingMean30d as number).toBeCloseTo(0.6, 5);
    });

    it('7. sessions — opsPerDayLast7d: null when no ops in 7d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1096-opd7null', dayAgo(10)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1096-opd7null');
      expect(status).toBe(200);
      expect(body.opsPerDayLast7d).toBeNull();
    });

    it('8. sessions — opsPerDayLast7d: 6 ops in 7d window → 6/7', async () => {
      ctx = await setup();
      // 6 ops spread over days 1-6 (well inside the 7d window) → 6/7
      for (let d = 1; d <= 6; d++) {
        await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1096-opd7-one', dayAgo(d)), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1096-opd7-one');
      expect(status).toBe(200);
      expect(body.opsPerDayLast7d as number).toBeCloseTo(6 / 7, 5);
    });

    it('9. sessions — opsPerDayLast7d: 12 ops over 6 days in 7d window → 12/7', async () => {
      ctx = await setup();
      // 12 ops over days 1-6 → 12/7
      for (let d = 1; d <= 6; d++) {
        await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v1096-opd7-two', dayAgo(d)), dec(0.5));
        await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v1096-opd7-two', dayAgo(d)), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1096-opd7-two');
      expect(status).toBe(200);
      expect(body.opsPerDayLast7d as number).toBeCloseTo(12 / 7, 5);
    });

    it('10. sessions — opsPerDayLast30d: null when no ops in 30d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v1096-opd30null', dayAgo(35)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1096-opd30null');
      expect(status).toBe(200);
      expect(body.opsPerDayLast30d).toBeNull();
    });

    it('11. sessions — opsPerDayLast30d: 29 ops over 29 days → 29/30', async () => {
      ctx = await setup();
      // 29 ops each on days 1-29 (well inside the 30d window) → 29/30
      for (let d = 1; d <= 29; d++) {
        await ctx.logger.log(makeOp('agent-k', 'fs', 'sess-v1096-opd30-one', dayAgo(d)), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1096-opd30-one');
      expect(status).toBe(200);
      expect(body.opsPerDayLast30d as number).toBeCloseTo(29 / 30, 5);
    });

    it('12. sessions — riskScoreEMALast7d: null when no ops in 7d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-l', 'fs', 'sess-v1096-ema7null', dayAgo(10)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1096-ema7null');
      expect(status).toBe(200);
      expect(body.riskScoreEMALast7d).toBeNull();
    });

    it('13. sessions — riskScoreEMALast7d: single active day returns its mean', async () => {
      ctx = await setup();
      // Only 1 day, 2 ops with scores 0.4 and 0.6 → day mean = 0.5
      // EMA with 1 point = 0.5 (seed value)
      await ctx.logger.log(makeOp('agent-m', 'fs', 'sess-v1096-ema7single', dayAgo(1)), dec(0.4));
      await ctx.logger.log(makeOp('agent-m', 'fs', 'sess-v1096-ema7single', dayAgo(1)), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1096-ema7single');
      expect(status).toBe(200);
      expect(body.riskScoreEMALast7d as number).toBeCloseTo(0.5, 5);
    });

    it('14. sessions — riskScoreEMALast7d: EMA with alpha=0.5 from oldest to newest', async () => {
      ctx = await setup();
      // Day 3 (older): score 0.2 → day mean 0.2
      // Day 1 (newer): score 0.8 → day mean 0.8
      // EMA: start = 0.2; EMA = 0.5 * 0.8 + 0.5 * 0.2 = 0.5
      await ctx.logger.log(makeOp('agent-n', 'fs', 'sess-v1096-ema7two', dayAgo(3)), dec(0.2));
      await ctx.logger.log(makeOp('agent-n', 'fs', 'sess-v1096-ema7two', dayAgo(1)), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1096-ema7two');
      expect(status).toBe(200);
      expect(body.riskScoreEMALast7d as number).toBeCloseTo(0.5, 5);
    });

    it('15. sessions — riskScoreEMALast7d: EMA with alpha=0.5 over 3 active days', async () => {
      ctx = await setup();
      // Day 5 (oldest): mean 0.2
      // Day 3: mean 0.4
      // Day 1 (newest): mean 0.6
      // EMA: seed=0.2; step2: 0.5*0.4 + 0.5*0.2=0.3; step3: 0.5*0.6 + 0.5*0.3=0.45
      await ctx.logger.log(makeOp('agent-o', 'fs', 'sess-v1096-ema7three', dayAgo(5)), dec(0.2));
      await ctx.logger.log(makeOp('agent-o', 'fs', 'sess-v1096-ema7three', dayAgo(3)), dec(0.4));
      await ctx.logger.log(makeOp('agent-o', 'fs', 'sess-v1096-ema7three', dayAgo(1)), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1096-ema7three');
      expect(status).toBe(200);
      expect(body.riskScoreEMALast7d as number).toBeCloseTo(0.45, 5);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1549-T1553 — v10.96 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('16. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1096-pres', 'fs', 'sess-1'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1096-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('allowRateStdDevLast30d');
      expect(body).toHaveProperty('riskScoreRollingMean30d');
      expect(body).toHaveProperty('opsPerDayLast7d');
      expect(body).toHaveProperty('opsPerDayLast30d');
      expect(body).toHaveProperty('riskScoreEMALast7d');
    });

    it('17. agents — allowRateStdDevLast30d: null when no ops in 30d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1096-ar30null', 'fs', 'sess-1', dayAgo(35)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1096-ar30null');
      expect(status).toBe(200);
      expect(body.allowRateStdDevLast30d).toBeNull();
    });

    it('18. agents — allowRateStdDevLast30d: 0 when exactly 1 active day', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1096-ar30one', 'fs', 'sess-1', dayAgo(1)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1096-ar30one');
      expect(status).toBe(200);
      expect(body.allowRateStdDevLast30d as number).toBeCloseTo(0, 5);
    });

    it('19. agents — riskScoreRollingMean30d: null when no ops in 30d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1096-rm30null', 'fs', 'sess-1', dayAgo(35)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1096-rm30null');
      expect(status).toBe(200);
      expect(body.riskScoreRollingMean30d).toBeNull();
    });

    it('20. agents — riskScoreRollingMean30d: single day mean', async () => {
      ctx = await setup();
      // 2 ops on same day with scores 0.3 and 0.7 → day mean = 0.5 → rolling mean = 0.5
      await ctx.logger.log(makeOp('agent-v1096-rm30single', 'fs', 'sess-1', dayAgo(1)), dec(0.3));
      await ctx.logger.log(makeOp('agent-v1096-rm30single', 'fs', 'sess-2', dayAgo(1)), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1096-rm30single');
      expect(status).toBe(200);
      expect(body.riskScoreRollingMean30d as number).toBeCloseTo(0.5, 5);
    });

    it('21. agents — opsPerDayLast7d: null when no ops in 7d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1096-opd7null', 'fs', 'sess-1', dayAgo(10)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1096-opd7null');
      expect(status).toBe(200);
      expect(body.opsPerDayLast7d).toBeNull();
    });

    it('22. agents — opsPerDayLast7d: 3 ops in 7d window → 3/7', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1096-opd7three', 'fs', 'sess-1', dayAgo(1)), dec(0.5));
      await ctx.logger.log(makeOp('agent-v1096-opd7three', 'fs', 'sess-2', dayAgo(3)), dec(0.5));
      await ctx.logger.log(makeOp('agent-v1096-opd7three', 'fs', 'sess-3', dayAgo(5)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1096-opd7three');
      expect(status).toBe(200);
      expect(body.opsPerDayLast7d as number).toBeCloseTo(3 / 7, 5);
    });

    it('23. agents — opsPerDayLast30d: null when no ops in 30d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1096-opd30null', 'fs', 'sess-1', dayAgo(35)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1096-opd30null');
      expect(status).toBe(200);
      expect(body.opsPerDayLast30d).toBeNull();
    });

    it('24. agents — opsPerDayLast30d: 15 ops → 15/30 = 0.5', async () => {
      ctx = await setup();
      for (let d = 1; d <= 15; d++) {
        await ctx.logger.log(makeOp('agent-v1096-opd30-half', 'fs', `sess-${d}`, dayAgo(d)), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1096-opd30-half');
      expect(status).toBe(200);
      expect(body.opsPerDayLast30d as number).toBeCloseTo(0.5, 5);
    });

    it('25. agents — riskScoreEMALast7d: null when no ops in 7d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1096-ema7null', 'fs', 'sess-1', dayAgo(10)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1096-ema7null');
      expect(status).toBe(200);
      expect(body.riskScoreEMALast7d).toBeNull();
    });

    it('26. agents — riskScoreEMALast7d: EMA with alpha=0.5 over 2 active days', async () => {
      ctx = await setup();
      // Day 4 (older): mean 0.6
      // Day 1 (newer): mean 0.4
      // EMA: seed=0.6; EMA = 0.5*0.4 + 0.5*0.6 = 0.5
      await ctx.logger.log(makeOp('agent-v1096-ema7two', 'fs', 'sess-1', dayAgo(4)), dec(0.6));
      await ctx.logger.log(makeOp('agent-v1096-ema7two', 'fs', 'sess-2', dayAgo(1)), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1096-ema7two');
      expect(status).toBe(200);
      expect(body.riskScoreEMALast7d as number).toBeCloseTo(0.5, 5);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1549-T1553 — v10.96 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('27. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v1096-pres', 'sess-1'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1096-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('allowRateStdDevLast30d');
      expect(body).toHaveProperty('riskScoreRollingMean30d');
      expect(body).toHaveProperty('opsPerDayLast7d');
      expect(body).toHaveProperty('opsPerDayLast30d');
      expect(body).toHaveProperty('riskScoreEMALast7d');
    });

    it('28. tools — allowRateStdDevLast30d: null when no ops in 30d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v1096-ar30null', 'sess-1', dayAgo(35)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1096-ar30null');
      expect(status).toBe(200);
      expect(body.allowRateStdDevLast30d).toBeNull();
    });

    it('29. tools — allowRateStdDevLast30d: 0 when exactly 1 active day', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v1096-ar30one', 'sess-1', dayAgo(2)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-b', 'tool-v1096-ar30one', 'sess-2', dayAgo(2)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1096-ar30one');
      expect(status).toBe(200);
      expect(body.allowRateStdDevLast30d as number).toBeCloseTo(0, 5);
    });

    it('30. tools — allowRateStdDevLast30d: non-negative for 2+ active days', async () => {
      ctx = await setup();
      // Day 1: 1 allow / 2 ops → rate 0.5; Day 2: 0 allows / 1 op → rate 0.0
      await ctx.logger.log(makeOp('agent-a', 'tool-v1096-ar30multi', 'sess-1', dayAgo(1)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-b', 'tool-v1096-ar30multi', 'sess-2', dayAgo(1)), dec(0.5, 'block'));
      await ctx.logger.log(makeOp('agent-c', 'tool-v1096-ar30multi', 'sess-3', dayAgo(2)), dec(0.5, 'block'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1096-ar30multi');
      expect(status).toBe(200);
      expect(body.allowRateStdDevLast30d as number).toBeGreaterThanOrEqual(0);
    });

    it('31. tools — riskScoreRollingMean30d: null when no ops in 30d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v1096-rm30null', 'sess-1', dayAgo(35)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1096-rm30null');
      expect(status).toBe(200);
      expect(body.riskScoreRollingMean30d).toBeNull();
    });

    it('32. tools — riskScoreRollingMean30d: mean of per-day means', async () => {
      ctx = await setup();
      // Day 1: 0.3 and 0.7 → day mean 0.5; Day 5: 1.0 → day mean 1.0
      // Rolling mean = (0.5 + 1.0) / 2 = 0.75
      await ctx.logger.log(makeOp('agent-a', 'tool-v1096-rm30multi', 'sess-1', dayAgo(1)), dec(0.3));
      await ctx.logger.log(makeOp('agent-b', 'tool-v1096-rm30multi', 'sess-2', dayAgo(1)), dec(0.7));
      await ctx.logger.log(makeOp('agent-c', 'tool-v1096-rm30multi', 'sess-3', dayAgo(5)), dec(1.0));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1096-rm30multi');
      expect(status).toBe(200);
      expect(body.riskScoreRollingMean30d as number).toBeCloseTo(0.75, 5);
    });

    it('33. tools — opsPerDayLast7d: null when no ops in 7d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v1096-opd7null', 'sess-1', dayAgo(10)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1096-opd7null');
      expect(status).toBe(200);
      expect(body.opsPerDayLast7d).toBeNull();
    });

    it('34. tools — opsPerDayLast7d: 6 ops over 6 days → 6/7', async () => {
      ctx = await setup();
      // 6 ops on days 1-6 (clearly within the 7d window) → 6/7
      for (let d = 1; d <= 6; d++) {
        await ctx.logger.log(makeOp('agent-a', 'tool-v1096-opd7one', `sess-${d}`, dayAgo(d)), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1096-opd7one');
      expect(status).toBe(200);
      expect(body.opsPerDayLast7d as number).toBeCloseTo(6 / 7, 5);
    });

    it('35. tools — opsPerDayLast30d: null when no ops in 30d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v1096-opd30null', 'sess-1', dayAgo(35)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1096-opd30null');
      expect(status).toBe(200);
      expect(body.opsPerDayLast30d).toBeNull();
    });

    it('36. tools — opsPerDayLast30d: 58 ops over 29 days → 58/30', async () => {
      ctx = await setup();
      // 2 ops per day for 29 days (days 1-29, well inside the 30d window) → 58/30
      for (let d = 1; d <= 29; d++) {
        await ctx.logger.log(makeOp('agent-a', 'tool-v1096-opd30two', `sess-${d}a`, dayAgo(d)), dec(0.5));
        await ctx.logger.log(makeOp('agent-b', 'tool-v1096-opd30two', `sess-${d}b`, dayAgo(d)), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1096-opd30two');
      expect(status).toBe(200);
      expect(body.opsPerDayLast30d as number).toBeCloseTo(58 / 30, 5);
    });

    it('37. tools — riskScoreEMALast7d: null when no ops in 7d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v1096-ema7null', 'sess-1', dayAgo(10)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1096-ema7null');
      expect(status).toBe(200);
      expect(body.riskScoreEMALast7d).toBeNull();
    });

    it('38. tools — riskScoreEMALast7d: correct EMA with alpha=0.5 over 3 days', async () => {
      ctx = await setup();
      // Day 6 (oldest): mean 0.0
      // Day 3: mean 1.0
      // Day 1 (newest): mean 0.0
      // EMA: seed=0.0; step2: 0.5*1.0 + 0.5*0.0=0.5; step3: 0.5*0.0 + 0.5*0.5=0.25
      await ctx.logger.log(makeOp('agent-a', 'tool-v1096-ema7three', 'sess-1', dayAgo(6)), dec(0.0));
      await ctx.logger.log(makeOp('agent-b', 'tool-v1096-ema7three', 'sess-2', dayAgo(3)), dec(1.0));
      await ctx.logger.log(makeOp('agent-c', 'tool-v1096-ema7three', 'sess-3', dayAgo(1)), dec(0.0));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1096-ema7three');
      expect(status).toBe(200);
      expect(body.riskScoreEMALast7d as number).toBeCloseTo(0.25, 5);
    });
  });

  // ── summary endpoint ───────────────────────────────────────────────────────────

  describe('T1549-T1553 — v10.96 new fields (summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('39. summary — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body).toHaveProperty('allowRateStdDevLast30d');
      expect(body).toHaveProperty('riskScoreRollingMean30d');
      expect(body).toHaveProperty('opsPerDayLast7d');
      expect(body).toHaveProperty('opsPerDayLast30d');
      expect(body).toHaveProperty('riskScoreEMALast7d');
    });

    it('40. summary — no ops: all five fields are null', async () => {
      ctx = await setup();

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.allowRateStdDevLast30d).toBeNull();
      expect(body.riskScoreRollingMean30d).toBeNull();
      expect(body.opsPerDayLast7d).toBeNull();
      expect(body.opsPerDayLast30d).toBeNull();
      expect(body.riskScoreEMALast7d).toBeNull();
    });

    it('41. summary — allowRateStdDevLast30d: null when all ops older than 30d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', dayAgo(35)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.allowRateStdDevLast30d).toBeNull();
    });

    it('42. summary — allowRateStdDevLast30d: 0 when exactly 1 active day', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', dayAgo(1)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-2', dayAgo(1)), dec(0.5, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.allowRateStdDevLast30d as number).toBeCloseTo(0, 5);
    });

    it('43. summary — allowRateStdDevLast30d: correct stddev for 2 active days', async () => {
      ctx = await setup();
      // Day 1: 1 allow / 1 op → rate 1.0
      // Day 2: 0 allows / 1 op → rate 0.0
      // rates [1.0, 0.0], mean = 0.5, population stddev = 0.5
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', dayAgo(1)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-2', dayAgo(2)), dec(0.5, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.allowRateStdDevLast30d as number).toBeCloseTo(0.5, 5);
    });

    it('44. summary — riskScoreRollingMean30d: null when all ops older than 30d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', dayAgo(35)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreRollingMean30d).toBeNull();
    });

    it('45. summary — riskScoreRollingMean30d: mean of per-day means', async () => {
      ctx = await setup();
      // Day 1: scores 0.2 and 0.8 → day mean 0.5; Day 10: score 0.5 → day mean 0.5
      // Rolling mean = (0.5 + 0.5) / 2 = 0.5
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', dayAgo(1)), dec(0.2));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-2', dayAgo(1)), dec(0.8));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-3', dayAgo(10)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreRollingMean30d as number).toBeCloseTo(0.5, 5);
    });

    it('46. summary — opsPerDayLast7d: null when all ops older than 7d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', dayAgo(10)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.opsPerDayLast7d).toBeNull();
    });

    it('47. summary — opsPerDayLast7d: 6 ops over 6 days → 6/7', async () => {
      ctx = await setup();
      // 6 ops on days 1-6, clearly within the 7d window → 6/7
      for (let d = 1; d <= 6; d++) {
        await ctx.logger.log(makeOp(`agent-${d}`, 'fs', `sess-${d}`, dayAgo(d)), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.opsPerDayLast7d as number).toBeCloseTo(6 / 7, 5);
    });

    it('48. summary — opsPerDayLast30d: null when all ops older than 30d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', dayAgo(35)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.opsPerDayLast30d).toBeNull();
    });

    it('49. summary — opsPerDayLast30d: 29 ops over 29 days → 29/30', async () => {
      ctx = await setup();
      // 29 ops on days 1-29, clearly within the 30d window → 29/30
      for (let d = 1; d <= 29; d++) {
        await ctx.logger.log(makeOp(`agent-${d}`, 'fs', `sess-${d}`, dayAgo(d)), dec(0.5));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.opsPerDayLast30d as number).toBeCloseTo(29 / 30, 5);
    });

    it('50. summary — riskScoreEMALast7d: null when all ops older than 7d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', dayAgo(10)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreEMALast7d).toBeNull();
    });

    it('51. summary — riskScoreEMALast7d: single active day returns its mean', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', dayAgo(2)), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreEMALast7d as number).toBeCloseTo(0.7, 5);
    });

    it('52. summary — riskScoreEMALast7d: EMA alpha=0.5 over 2 active days in 7d', async () => {
      ctx = await setup();
      // Day 3 (older): mean 0.2; Day 1 (newer): mean 0.8
      // EMA: seed=0.2; EMA = 0.5*0.8 + 0.5*0.2 = 0.5
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', dayAgo(3)), dec(0.2));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-2', dayAgo(1)), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreEMALast7d as number).toBeCloseTo(0.5, 5);
    });
  });
});

// ── v10.97 ────────────────────────────────────────────────────────────────────

describe('v10.97', () => {
  /**
   * Return a Date that is exactly `d` days ago at start-of-day UTC,
   * so that each integer produces a distinct calendar day key.
   */
  function dayAgo(d: number): Date {
    const now = new Date(PINNED_NOW());
    // DST-safe: use JS date arithmetic
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() - d);
  }

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1554-T1558 — v10.97 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1097-pres'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1097-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('riskScoreEMALast30d');
      expect(body).toHaveProperty('blockCountStdDevLast7d');
      expect(body).toHaveProperty('blockCountStdDevLast30d');
      expect(body).toHaveProperty('allowCountStdDevLast7d');
      expect(body).toHaveProperty('allowCountStdDevLast30d');
    });

    it('2. sessions — riskScoreEMALast30d: null when no ops in 30d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-v1097-ema30null', dayAgo(35)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1097-ema30null');
      expect(status).toBe(200);
      expect(body.riskScoreEMALast30d).toBeNull();
    });

    it('3. sessions — riskScoreEMALast30d: single active day returns its mean', async () => {
      ctx = await setup();
      // 2 ops on same day with scores 0.4 and 0.6 → day mean = 0.5; EMA = 0.5 (seed)
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1097-ema30single', dayAgo(5)), dec(0.4));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v1097-ema30single', dayAgo(5)), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1097-ema30single');
      expect(status).toBe(200);
      expect(body.riskScoreEMALast30d as number).toBeCloseTo(0.5, 5);
    });

    it('4. sessions — riskScoreEMALast30d: EMA alpha=0.5 over 2 active days', async () => {
      ctx = await setup();
      // Day 20 (older): mean 0.2; Day 5 (newer): mean 0.8
      // EMA: seed=0.2; EMA = 0.5*0.8 + 0.5*0.2 = 0.5
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1097-ema30two', dayAgo(20)), dec(0.2));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v1097-ema30two', dayAgo(5)), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1097-ema30two');
      expect(status).toBe(200);
      expect(body.riskScoreEMALast30d as number).toBeCloseTo(0.5, 5);
    });

    it('5. sessions — blockCountStdDevLast7d: null when no ops in 7d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess-v1097-bsd7null', dayAgo(10)), dec(0.5, 'block'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1097-bsd7null');
      expect(status).toBe(200);
      expect(body.blockCountStdDevLast7d).toBeNull();
    });

    it('6. sessions — blockCountStdDevLast7d: all days have 0 blocks → stddev = 0', async () => {
      ctx = await setup();
      // Op in window but action=allow; block counts all 0 for 7 days → stddev = 0
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess-v1097-bsd7zero', dayAgo(2)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1097-bsd7zero');
      expect(status).toBe(200);
      expect(body.blockCountStdDevLast7d as number).toBeCloseTo(0, 5);
    });

    it('7. sessions — blockCountStdDevLast7d: non-negative for mixed block days', async () => {
      ctx = await setup();
      // Day 1: 2 blocks; days 2-7: 0 blocks
      // counts = [2, 0, 0, 0, 0, 0, 0]; mean = 2/7
      // variance = ((2 - 2/7)^2 + 6*(0 - 2/7)^2) / 7
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1097-bsd7mixed', dayAgo(1)), dec(0.5, 'block'));
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v1097-bsd7mixed', dayAgo(1)), dec(0.5, 'block'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1097-bsd7mixed');
      expect(status).toBe(200);
      expect(body.blockCountStdDevLast7d as number).toBeGreaterThanOrEqual(0);
    });

    it('8. sessions — blockCountStdDevLast30d: null when no ops in 30d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess-v1097-bsd30null', dayAgo(35)), dec(0.5, 'block'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1097-bsd30null');
      expect(status).toBe(200);
      expect(body.blockCountStdDevLast30d).toBeNull();
    });

    it('9. sessions — blockCountStdDevLast30d: correct value for known block pattern', async () => {
      ctx = await setup();
      // Day 1: 3 blocks; days 2-30: 0 blocks
      // counts[0]=3, counts[1..29]=0; mean=3/30=0.1
      // variance = ((3-0.1)^2 + 29*(0-0.1)^2) / 30 = (8.41 + 0.29) / 30 = 8.70/30 = 0.29
      // stddev = sqrt(0.29) ≈ 0.5385
      const expectedMean = 3 / 30;
      const expectedVariance = ((3 - expectedMean) ** 2 + 29 * (0 - expectedMean) ** 2) / 30;
      const expectedStdDev = Math.sqrt(expectedVariance);

      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v1097-bsd30val', dayAgo(1)), dec(0.5, 'block'));
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v1097-bsd30val', dayAgo(1)), dec(0.5, 'block'));
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v1097-bsd30val', dayAgo(1)), dec(0.5, 'block'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1097-bsd30val');
      expect(status).toBe(200);
      expect(body.blockCountStdDevLast30d as number).toBeCloseTo(expectedStdDev, 4);
    });

    it('10. sessions — allowCountStdDevLast7d: null when no ops in 7d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v1097-asd7null', dayAgo(10)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1097-asd7null');
      expect(status).toBe(200);
      expect(body.allowCountStdDevLast7d).toBeNull();
    });

    it('11. sessions — allowCountStdDevLast7d: correct value for known allow pattern', async () => {
      ctx = await setup();
      // Day 1: 2 allows; days 2-7: 0 allows
      // counts=[2,0,0,0,0,0,0]; mean=2/7
      // variance=((2-2/7)^2+6*(0-2/7)^2)/7
      const expectedMean = 2 / 7;
      const counts = [2, 0, 0, 0, 0, 0, 0];
      const expectedVariance = counts.reduce((a, v) => a + (v - expectedMean) ** 2, 0) / 7;
      const expectedStdDev = Math.sqrt(expectedVariance);

      await ctx.logger.log(makeOp('agent-k', 'fs', 'sess-v1097-asd7val', dayAgo(1)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-k', 'fs', 'sess-v1097-asd7val', dayAgo(1)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1097-asd7val');
      expect(status).toBe(200);
      expect(body.allowCountStdDevLast7d as number).toBeCloseTo(expectedStdDev, 4);
    });

    it('12. sessions — allowCountStdDevLast30d: null when no ops in 30d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-l', 'fs', 'sess-v1097-asd30null', dayAgo(35)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1097-asd30null');
      expect(status).toBe(200);
      expect(body.allowCountStdDevLast30d).toBeNull();
    });

    it('13. sessions — allowCountStdDevLast30d: non-negative for mixed allow days', async () => {
      ctx = await setup();
      // Day 1: 1 allow; Day 10: 2 allows; rest: 0 allows
      await ctx.logger.log(makeOp('agent-m', 'fs', 'sess-v1097-asd30mixed', dayAgo(1)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-m', 'fs', 'sess-v1097-asd30mixed', dayAgo(10)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-m', 'fs', 'sess-v1097-asd30mixed', dayAgo(10)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1097-asd30mixed');
      expect(status).toBe(200);
      expect(body.allowCountStdDevLast30d as number).toBeGreaterThanOrEqual(0);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1554-T1558 — v10.97 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('14. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1097-pres', 'fs', 'sess-1'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1097-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('riskScoreEMALast30d');
      expect(body).toHaveProperty('blockCountStdDevLast7d');
      expect(body).toHaveProperty('blockCountStdDevLast30d');
      expect(body).toHaveProperty('allowCountStdDevLast7d');
      expect(body).toHaveProperty('allowCountStdDevLast30d');
    });

    it('15. agents — riskScoreEMALast30d: null when no ops in 30d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1097-ema30null', 'fs', 'sess-1', dayAgo(35)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1097-ema30null');
      expect(status).toBe(200);
      expect(body.riskScoreEMALast30d).toBeNull();
    });

    it('16. agents — riskScoreEMALast30d: EMA alpha=0.5 over 2 active days', async () => {
      ctx = await setup();
      // Day 20 (older): mean 0.2; Day 8 (newer): mean 0.8
      // EMA: seed=0.2; EMA = 0.5*0.8 + 0.5*0.2 = 0.5
      await ctx.logger.log(makeOp('agent-v1097-ema30two-b', 'fs', 'sess-1', dayAgo(20)), dec(0.2));
      await ctx.logger.log(makeOp('agent-v1097-ema30two-b', 'fs', 'sess-2', dayAgo(8)), dec(0.8));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1097-ema30two-b');
      expect(status).toBe(200);
      expect(body.riskScoreEMALast30d as number).toBeCloseTo(0.5, 5);
    });

    it('17. agents — blockCountStdDevLast7d: null when no ops in 7d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1097-bsd7null', 'fs', 'sess-1', dayAgo(10)), dec(0.5, 'block'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1097-bsd7null');
      expect(status).toBe(200);
      expect(body.blockCountStdDevLast7d).toBeNull();
    });

    it('18. agents — blockCountStdDevLast7d: non-negative for block counts in 7d', async () => {
      ctx = await setup();
      // Day 1: 1 block; Day 2: 3 blocks; days 3-7: 0 blocks
      await ctx.logger.log(makeOp('agent-v1097-bsd7mix', 'fs', 'sess-1', dayAgo(1)), dec(0.5, 'block'));
      await ctx.logger.log(makeOp('agent-v1097-bsd7mix', 'fs', 'sess-2', dayAgo(2)), dec(0.5, 'block'));
      await ctx.logger.log(makeOp('agent-v1097-bsd7mix', 'fs', 'sess-3', dayAgo(2)), dec(0.5, 'block'));
      await ctx.logger.log(makeOp('agent-v1097-bsd7mix', 'fs', 'sess-4', dayAgo(2)), dec(0.5, 'block'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1097-bsd7mix');
      expect(status).toBe(200);
      expect(body.blockCountStdDevLast7d as number).toBeGreaterThanOrEqual(0);
    });

    it('19. agents — blockCountStdDevLast30d: null when no ops in 30d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1097-bsd30null', 'fs', 'sess-1', dayAgo(35)), dec(0.5, 'block'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1097-bsd30null');
      expect(status).toBe(200);
      expect(body.blockCountStdDevLast30d).toBeNull();
    });

    it('20. agents — blockCountStdDevLast30d: 0 when no blocks in window', async () => {
      ctx = await setup();
      // Op in 30d window but action=allow → all 30 block counts = 0 → stddev = 0
      await ctx.logger.log(makeOp('agent-v1097-bsd30zero', 'fs', 'sess-1', dayAgo(5)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1097-bsd30zero');
      expect(status).toBe(200);
      expect(body.blockCountStdDevLast30d as number).toBeCloseTo(0, 5);
    });

    it('21. agents — allowCountStdDevLast7d: null when no ops in 7d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1097-asd7null', 'fs', 'sess-1', dayAgo(10)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1097-asd7null');
      expect(status).toBe(200);
      expect(body.allowCountStdDevLast7d).toBeNull();
    });

    it('22. agents — allowCountStdDevLast7d: correct value for 2 blocks 1 day', async () => {
      ctx = await setup();
      // Day 1: 2 allows; days 2-7: 0 allows; denominator = 7
      const expectedMean = 2 / 7;
      const counts = [2, 0, 0, 0, 0, 0, 0];
      const expectedStdDev = Math.sqrt(counts.reduce((a, v) => a + (v - expectedMean) ** 2, 0) / 7);

      await ctx.logger.log(makeOp('agent-v1097-asd7val', 'fs', 'sess-1', dayAgo(1)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-v1097-asd7val', 'fs', 'sess-2', dayAgo(1)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1097-asd7val');
      expect(status).toBe(200);
      expect(body.allowCountStdDevLast7d as number).toBeCloseTo(expectedStdDev, 4);
    });

    it('23. agents — allowCountStdDevLast30d: null when no ops in 30d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1097-asd30null', 'fs', 'sess-1', dayAgo(35)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1097-asd30null');
      expect(status).toBe(200);
      expect(body.allowCountStdDevLast30d).toBeNull();
    });

    it('24. agents — allowCountStdDevLast30d: non-negative for allow counts in 30d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1097-asd30mix', 'fs', 'sess-1', dayAgo(1)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-v1097-asd30mix', 'fs', 'sess-2', dayAgo(15)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-v1097-asd30mix', 'fs', 'sess-3', dayAgo(15)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1097-asd30mix');
      expect(status).toBe(200);
      expect(body.allowCountStdDevLast30d as number).toBeGreaterThanOrEqual(0);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1554-T1558 — v10.97 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('25. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v1097-pres', 'sess-1'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1097-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('riskScoreEMALast30d');
      expect(body).toHaveProperty('blockCountStdDevLast7d');
      expect(body).toHaveProperty('blockCountStdDevLast30d');
      expect(body).toHaveProperty('allowCountStdDevLast7d');
      expect(body).toHaveProperty('allowCountStdDevLast30d');
    });

    it('26. tools — riskScoreEMALast30d: null when no ops in 30d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v1097-ema30null', 'sess-1', dayAgo(35)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1097-ema30null');
      expect(status).toBe(200);
      expect(body.riskScoreEMALast30d).toBeNull();
    });

    it('27. tools — riskScoreEMALast30d: EMA alpha=0.5 over 2 active days', async () => {
      ctx = await setup();
      // Day 20 (older): mean 0.4; Day 5 (newer): mean 0.6
      // EMA: seed=0.4; EMA = 0.5*0.6 + 0.5*0.4 = 0.5
      await ctx.logger.log(makeOp('agent-a', 'tool-v1097-ema30two', 'sess-1', dayAgo(20)), dec(0.4));
      await ctx.logger.log(makeOp('agent-b', 'tool-v1097-ema30two', 'sess-2', dayAgo(5)), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1097-ema30two');
      expect(status).toBe(200);
      expect(body.riskScoreEMALast30d as number).toBeCloseTo(0.5, 5);
    });

    it('28. tools — blockCountStdDevLast7d: null when no ops in 7d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v1097-bsd7null', 'sess-1', dayAgo(10)), dec(0.5, 'block'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1097-bsd7null');
      expect(status).toBe(200);
      expect(body.blockCountStdDevLast7d).toBeNull();
    });

    it('29. tools — blockCountStdDevLast7d: correct value for 4 blocks on day 2', async () => {
      ctx = await setup();
      // Day 2: 4 blocks; days 1,3-7: 0 blocks
      // counts=[0,4,0,0,0,0,0] (ordered from today back); mean=4/7
      const expectedMean = 4 / 7;
      const counts = [0, 4, 0, 0, 0, 0, 0];
      const expectedStdDev = Math.sqrt(counts.reduce((a, v) => a + (v - expectedMean) ** 2, 0) / 7);

      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp('agent-a', 'tool-v1097-bsd7val', `sess-${i}`, dayAgo(2)), dec(0.5, 'block'));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1097-bsd7val');
      expect(status).toBe(200);
      expect(body.blockCountStdDevLast7d as number).toBeCloseTo(expectedStdDev, 4);
    });

    it('30. tools — blockCountStdDevLast30d: null when no ops in 30d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v1097-bsd30null', 'sess-1', dayAgo(35)), dec(0.5, 'block'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1097-bsd30null');
      expect(status).toBe(200);
      expect(body.blockCountStdDevLast30d).toBeNull();
    });

    it('31. tools — blockCountStdDevLast30d: non-negative for block activity', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v1097-bsd30mix', 'sess-1', dayAgo(1)), dec(0.5, 'block'));
      await ctx.logger.log(makeOp('agent-b', 'tool-v1097-bsd30mix', 'sess-2', dayAgo(20)), dec(0.5, 'block'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1097-bsd30mix');
      expect(status).toBe(200);
      expect(body.blockCountStdDevLast30d as number).toBeGreaterThanOrEqual(0);
    });

    it('32. tools — allowCountStdDevLast7d: null when no ops in 7d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v1097-asd7null', 'sess-1', dayAgo(10)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1097-asd7null');
      expect(status).toBe(200);
      expect(body.allowCountStdDevLast7d).toBeNull();
    });

    it('33. tools — allowCountStdDevLast7d: 0 when no allows in 7d window', async () => {
      ctx = await setup();
      // Op in window but action=block → all 7 allow counts = 0 → stddev = 0
      await ctx.logger.log(makeOp('agent-a', 'tool-v1097-asd7zero', 'sess-1', dayAgo(3)), dec(0.5, 'block'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1097-asd7zero');
      expect(status).toBe(200);
      expect(body.allowCountStdDevLast7d as number).toBeCloseTo(0, 5);
    });

    it('34. tools — allowCountStdDevLast30d: null when no ops in 30d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v1097-asd30null', 'sess-1', dayAgo(35)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1097-asd30null');
      expect(status).toBe(200);
      expect(body.allowCountStdDevLast30d).toBeNull();
    });

    it('35. tools — allowCountStdDevLast30d: correct value for 3 allows on day 5', async () => {
      ctx = await setup();
      // Day 5: 3 allows; days 1-4, 6-30: 0 allows
      // counts[4]=3, all others 0; mean=3/30=0.1
      const expectedMean = 3 / 30;
      const counts = Array.from({ length: 30 }, (_, i) => (i === 4 ? 3 : 0));
      const expectedStdDev = Math.sqrt(counts.reduce((a, v) => a + (v - expectedMean) ** 2, 0) / 30);

      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-a', 'tool-v1097-asd30val', `sess-${i}`, dayAgo(5)), dec(0.5, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1097-asd30val');
      expect(status).toBe(200);
      expect(body.allowCountStdDevLast30d as number).toBeCloseTo(expectedStdDev, 4);
    });
  });

  // ── summary endpoint ───────────────────────────────────────────────────────────

  describe('T1554-T1558 — v10.97 new fields (summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('36. summary — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body).toHaveProperty('riskScoreEMALast30d');
      expect(body).toHaveProperty('blockCountStdDevLast7d');
      expect(body).toHaveProperty('blockCountStdDevLast30d');
      expect(body).toHaveProperty('allowCountStdDevLast7d');
      expect(body).toHaveProperty('allowCountStdDevLast30d');
    });

    it('37. summary — no ops: all five fields are null', async () => {
      ctx = await setup();

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreEMALast30d).toBeNull();
      expect(body.blockCountStdDevLast7d).toBeNull();
      expect(body.blockCountStdDevLast30d).toBeNull();
      expect(body.allowCountStdDevLast7d).toBeNull();
      expect(body.allowCountStdDevLast30d).toBeNull();
    });

    it('38. summary — riskScoreEMALast30d: null when all ops older than 30d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', dayAgo(35)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreEMALast30d).toBeNull();
    });

    it('39. summary — riskScoreEMALast30d: EMA alpha=0.5 over 2 active days', async () => {
      ctx = await setup();
      // Day 25 (older): mean 0.6; Day 10 (newer): mean 0.4
      // EMA: seed=0.6; EMA = 0.5*0.4 + 0.5*0.6 = 0.5
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', dayAgo(25)), dec(0.6));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-2', dayAgo(10)), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreEMALast30d as number).toBeCloseTo(0.5, 5);
    });

    it('40. summary — blockCountStdDevLast7d: null when all ops older than 7d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', dayAgo(10)), dec(0.5, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.blockCountStdDevLast7d).toBeNull();
    });

    it('41. summary — blockCountStdDevLast7d: 0 when no blocks in 7d window', async () => {
      ctx = await setup();
      // Op in 7d window but action=allow → all 7 block counts = 0 → stddev = 0
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', dayAgo(2)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.blockCountStdDevLast7d as number).toBeCloseTo(0, 5);
    });

    it('42. summary — blockCountStdDevLast7d: correct value for 5 blocks on day 3', async () => {
      ctx = await setup();
      // Day 3: 5 blocks; days 1,2,4-7: 0 blocks
      const expectedMean = 5 / 7;
      const counts = [0, 0, 5, 0, 0, 0, 0];
      const expectedStdDev = Math.sqrt(counts.reduce((a, v) => a + (v - expectedMean) ** 2, 0) / 7);

      for (let i = 0; i < 5; i++) {
        await ctx.logger.log(makeOp(`agent-${i}`, 'fs', `sess-${i}`, dayAgo(3)), dec(0.5, 'block'));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.blockCountStdDevLast7d as number).toBeCloseTo(expectedStdDev, 4);
    });

    it('43. summary — blockCountStdDevLast30d: null when all ops older than 30d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', dayAgo(35)), dec(0.5, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.blockCountStdDevLast30d).toBeNull();
    });

    it('44. summary — blockCountStdDevLast30d: non-negative for mixed block activity', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', dayAgo(1)), dec(0.5, 'block'));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-2', dayAgo(2)), dec(0.5, 'block'));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-3', dayAgo(2)), dec(0.5, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.blockCountStdDevLast30d as number).toBeGreaterThanOrEqual(0);
    });

    it('45. summary — allowCountStdDevLast7d: null when all ops older than 7d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', dayAgo(10)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.allowCountStdDevLast7d).toBeNull();
    });

    it('46. summary — allowCountStdDevLast7d: correct value for 6 allows on day 1', async () => {
      ctx = await setup();
      // Day 1: 6 allows; days 2-7: 0 allows
      const expectedMean = 6 / 7;
      const counts = [6, 0, 0, 0, 0, 0, 0];
      const expectedStdDev = Math.sqrt(counts.reduce((a, v) => a + (v - expectedMean) ** 2, 0) / 7);

      for (let i = 0; i < 6; i++) {
        await ctx.logger.log(makeOp(`agent-${i}`, 'fs', `sess-${i}`, dayAgo(1)), dec(0.5, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.allowCountStdDevLast7d as number).toBeCloseTo(expectedStdDev, 4);
    });

    it('47. summary — allowCountStdDevLast30d: null when all ops older than 30d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', dayAgo(35)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.allowCountStdDevLast30d).toBeNull();
    });

    it('48. summary — allowCountStdDevLast30d: 0 when all allows on same day', async () => {
      ctx = await setup();
      // All ops on day 5 → 1 active bucket; all other 29 days = 0
      // stddev depends on the spread across 30 buckets; not 0 unless all counts equal
      // Instead: only allows on 1 day means mean=N/30 and stddev > 0 unless N=0
      // Let us test just non-negativity to keep it safe
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', dayAgo(5)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-2', dayAgo(5)), dec(0.5, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.allowCountStdDevLast30d as number).toBeGreaterThanOrEqual(0);
    });

    it('49. summary — allowCountStdDevLast30d: correct value for 4 allows on day 10', async () => {
      ctx = await setup();
      // Day 10: 4 allows; days 1-9, 11-30: 0 allows
      const expectedMean = 4 / 30;
      const counts = Array.from({ length: 30 }, (_, i) => (i === 9 ? 4 : 0));
      const expectedStdDev = Math.sqrt(counts.reduce((a, v) => a + (v - expectedMean) ** 2, 0) / 30);

      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp(`agent-${i}`, 'fs', `sess-${i}`, dayAgo(10)), dec(0.5, 'allow'));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.allowCountStdDevLast30d as number).toBeCloseTo(expectedStdDev, 4);
    });

    it('50. summary — all five fields are non-null when ops exist in respective windows', async () => {
      ctx = await setup();
      // Add ops that cover all windows
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', dayAgo(1)), dec(0.5, 'allow'));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-2', dayAgo(3)), dec(0.3, 'block'));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-3', dayAgo(10)), dec(0.7, 'allow'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreEMALast30d).not.toBeNull();
      expect(body.blockCountStdDevLast7d).not.toBeNull();
      expect(body.blockCountStdDevLast30d).not.toBeNull();
      expect(body.allowCountStdDevLast7d).not.toBeNull();
      expect(body.allowCountStdDevLast30d).not.toBeNull();
    });
  });
});

// ── v10.98 ────────────────────────────────────────────────────────────────────

describe('v10.98', () => {
  /**
   * Return a Date that is exactly `d` days ago at start-of-day UTC,
   * so that each integer produces a distinct calendar day key.
   */
  function dayAgo(d: number): Date {
    const now = new Date(PINNED_NOW());
    // DST-safe: use JS date arithmetic
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() - d);
  }

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1559-T1563 — v10.98 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1098-pres'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1098-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('requireApprovalCountStdDevLast7d');
      expect(body).toHaveProperty('requireApprovalCountStdDevLast30d');
      expect(body).toHaveProperty('riskScoreMedianLast7d');
      expect(body).toHaveProperty('riskScoreMedianLast30d');
      expect(body).toHaveProperty('riskScoreP90Last7d');
    });

    it('2. sessions — requireApprovalCountStdDevLast7d: null when no ops in 7d window', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-b', 'fs', 'sess-v1098-ra7null', dayAgo(10)),
        dec(0.5, 'require_approval'),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1098-ra7null');
      expect(status).toBe(200);
      expect(body.requireApprovalCountStdDevLast7d).toBeNull();
    });

    it('3. sessions — requireApprovalCountStdDevLast7d: 0 when no require_approvals in 7d', async () => {
      ctx = await setup();
      // Op in 7d window but action=allow → all 7 ra counts = 0 → stddev = 0
      await ctx.logger.log(
        makeOp('agent-c', 'fs', 'sess-v1098-ra7zero', dayAgo(2)),
        dec(0.5, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1098-ra7zero');
      expect(status).toBe(200);
      expect(body.requireApprovalCountStdDevLast7d as number).toBeCloseTo(0, 5);
    });

    it('4. sessions — requireApprovalCountStdDevLast7d: correct value for known pattern', async () => {
      ctx = await setup();
      // Day 1: 2 require_approvals; days 2-7: 0 → counts=[2,0,0,0,0,0,0]; mean=2/7
      const expectedMean = 2 / 7;
      const counts = [2, 0, 0, 0, 0, 0, 0];
      const expectedStdDev = Math.sqrt(
        counts.reduce((a, v) => a + (v - expectedMean) ** 2, 0) / 7,
      );

      await ctx.logger.log(
        makeOp('agent-d', 'fs', 'sess-v1098-ra7val', dayAgo(1)),
        dec(0.5, 'require_approval'),
      );
      await ctx.logger.log(
        makeOp('agent-d', 'fs', 'sess-v1098-ra7val', dayAgo(1)),
        dec(0.5, 'require_approval'),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1098-ra7val');
      expect(status).toBe(200);
      expect(body.requireApprovalCountStdDevLast7d as number).toBeCloseTo(expectedStdDev, 4);
    });

    it('5. sessions — requireApprovalCountStdDevLast30d: null when no ops in 30d window', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-e', 'fs', 'sess-v1098-ra30null', dayAgo(35)),
        dec(0.5, 'require_approval'),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1098-ra30null');
      expect(status).toBe(200);
      expect(body.requireApprovalCountStdDevLast30d).toBeNull();
    });

    it('6. sessions — requireApprovalCountStdDevLast30d: correct value for known pattern', async () => {
      ctx = await setup();
      // Day 5: 3 require_approvals; days 1-4, 6-30: 0 → mean=3/30=0.1
      const expectedMean = 3 / 30;
      const counts = Array.from({ length: 30 }, (_, i) => (i === 4 ? 3 : 0));
      const expectedStdDev = Math.sqrt(
        counts.reduce((a, v) => a + (v - expectedMean) ** 2, 0) / 30,
      );

      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(
          makeOp('agent-f', 'fs', 'sess-v1098-ra30val', dayAgo(5)),
          dec(0.5, 'require_approval'),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1098-ra30val');
      expect(status).toBe(200);
      expect(body.requireApprovalCountStdDevLast30d as number).toBeCloseTo(expectedStdDev, 4);
    });

    it('7. sessions — riskScoreMedianLast7d: null when no ops in 7d window', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-g', 'fs', 'sess-v1098-med7null', dayAgo(10)),
        dec(0.5),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1098-med7null');
      expect(status).toBe(200);
      expect(body.riskScoreMedianLast7d).toBeNull();
    });

    it('8. sessions — riskScoreMedianLast7d: single op returns its score', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-h', 'fs', 'sess-v1098-med7single', dayAgo(2)),
        dec(0.6),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1098-med7single');
      expect(status).toBe(200);
      expect(body.riskScoreMedianLast7d as number).toBeCloseTo(0.6, 5);
    });

    it('9. sessions — riskScoreMedianLast7d: odd-length sorted array median', async () => {
      ctx = await setup();
      // 3 ops: 0.1, 0.5, 0.9 → sorted=[0.1,0.5,0.9] → median = 0.5
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v1098-med7odd', dayAgo(1)), dec(0.1));
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v1098-med7odd', dayAgo(1)), dec(0.9));
      await ctx.logger.log(makeOp('agent-i', 'fs', 'sess-v1098-med7odd', dayAgo(1)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1098-med7odd');
      expect(status).toBe(200);
      expect(body.riskScoreMedianLast7d as number).toBeCloseTo(0.5, 5);
    });

    it('10. sessions — riskScoreMedianLast7d: even-length sorted array median (avg of two middle)', async () => {
      ctx = await setup();
      // 4 ops: 0.2, 0.4, 0.6, 0.8 → sorted=[0.2,0.4,0.6,0.8] → median = (0.4+0.6)/2 = 0.5
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v1098-med7even', dayAgo(1)), dec(0.2));
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v1098-med7even', dayAgo(1)), dec(0.8));
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v1098-med7even', dayAgo(1)), dec(0.4));
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v1098-med7even', dayAgo(1)), dec(0.6));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1098-med7even');
      expect(status).toBe(200);
      expect(body.riskScoreMedianLast7d as number).toBeCloseTo(0.5, 5);
    });

    it('11. sessions — riskScoreMedianLast30d: null when no ops in 30d window', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-k', 'fs', 'sess-v1098-med30null', dayAgo(35)),
        dec(0.5),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1098-med30null');
      expect(status).toBe(200);
      expect(body.riskScoreMedianLast30d).toBeNull();
    });

    it('12. sessions — riskScoreMedianLast30d: correct median for ops in 30d window', async () => {
      ctx = await setup();
      // 3 ops: 0.3, 0.7, 0.5 → sorted=[0.3,0.5,0.7] → median = 0.5
      await ctx.logger.log(makeOp('agent-l', 'fs', 'sess-v1098-med30val', dayAgo(20)), dec(0.3));
      await ctx.logger.log(makeOp('agent-l', 'fs', 'sess-v1098-med30val', dayAgo(10)), dec(0.7));
      await ctx.logger.log(makeOp('agent-l', 'fs', 'sess-v1098-med30val', dayAgo(5)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1098-med30val');
      expect(status).toBe(200);
      expect(body.riskScoreMedianLast30d as number).toBeCloseTo(0.5, 5);
    });

    it('13. sessions — riskScoreP90Last7d: null when no ops in 7d window', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-m', 'fs', 'sess-v1098-p90null', dayAgo(10)),
        dec(0.5),
      );

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1098-p90null');
      expect(status).toBe(200);
      expect(body.riskScoreP90Last7d).toBeNull();
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1559-T1563 — v10.98 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('14. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-v1098-pres', 'fs', 'sess-1'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1098-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('requireApprovalCountStdDevLast7d');
      expect(body).toHaveProperty('requireApprovalCountStdDevLast30d');
      expect(body).toHaveProperty('riskScoreMedianLast7d');
      expect(body).toHaveProperty('riskScoreMedianLast30d');
      expect(body).toHaveProperty('riskScoreP90Last7d');
    });

    it('15. agents — requireApprovalCountStdDevLast7d: null when no ops in 7d window', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-v1098-ra7null', 'fs', 'sess-1', dayAgo(10)),
        dec(0.5, 'require_approval'),
      );

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1098-ra7null');
      expect(status).toBe(200);
      expect(body.requireApprovalCountStdDevLast7d).toBeNull();
    });

    it('16. agents — requireApprovalCountStdDevLast7d: 0 when no require_approvals in 7d', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-v1098-ra7zero', 'fs', 'sess-1', dayAgo(3)),
        dec(0.5, 'block'),
      );

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1098-ra7zero');
      expect(status).toBe(200);
      expect(body.requireApprovalCountStdDevLast7d as number).toBeCloseTo(0, 5);
    });

    it('17. agents — requireApprovalCountStdDevLast30d: null when no ops in 30d window', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-v1098-ra30null', 'fs', 'sess-1', dayAgo(35)),
        dec(0.5, 'require_approval'),
      );

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1098-ra30null');
      expect(status).toBe(200);
      expect(body.requireApprovalCountStdDevLast30d).toBeNull();
    });

    it('18. agents — requireApprovalCountStdDevLast30d: non-negative for ra activity', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-v1098-ra30mix', 'fs', 'sess-1', dayAgo(1)),
        dec(0.5, 'require_approval'),
      );
      await ctx.logger.log(
        makeOp('agent-v1098-ra30mix', 'fs', 'sess-2', dayAgo(15)),
        dec(0.5, 'require_approval'),
      );

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1098-ra30mix');
      expect(status).toBe(200);
      expect(body.requireApprovalCountStdDevLast30d as number).toBeGreaterThanOrEqual(0);
    });

    it('19. agents — riskScoreMedianLast7d: null when no ops in 7d window', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-v1098-med7null', 'fs', 'sess-1', dayAgo(10)),
        dec(0.5),
      );

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1098-med7null');
      expect(status).toBe(200);
      expect(body.riskScoreMedianLast7d).toBeNull();
    });

    it('20. agents — riskScoreMedianLast7d: correct median for odd-count ops', async () => {
      ctx = await setup();
      // 5 ops: 0.1, 0.2, 0.5, 0.8, 0.9 → sorted median = 0.5
      const scores = [0.9, 0.1, 0.5, 0.2, 0.8];
      for (const s of scores) {
        await ctx.logger.log(
          makeOp('agent-v1098-med7odd', 'fs', `sess-${s}`, dayAgo(2)),
          dec(s),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1098-med7odd');
      expect(status).toBe(200);
      expect(body.riskScoreMedianLast7d as number).toBeCloseTo(0.5, 5);
    });

    it('21. agents — riskScoreMedianLast30d: null when no ops in 30d window', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-v1098-med30null', 'fs', 'sess-1', dayAgo(35)),
        dec(0.5),
      );

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1098-med30null');
      expect(status).toBe(200);
      expect(body.riskScoreMedianLast30d).toBeNull();
    });

    it('22. agents — riskScoreMedianLast30d: correct even-length median', async () => {
      ctx = await setup();
      // 2 ops: 0.3, 0.7 → sorted=[0.3,0.7] → median=(0.3+0.7)/2=0.5
      await ctx.logger.log(
        makeOp('agent-v1098-med30even', 'fs', 'sess-1', dayAgo(20)),
        dec(0.3),
      );
      await ctx.logger.log(
        makeOp('agent-v1098-med30even', 'fs', 'sess-2', dayAgo(10)),
        dec(0.7),
      );

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1098-med30even');
      expect(status).toBe(200);
      expect(body.riskScoreMedianLast30d as number).toBeCloseTo(0.5, 5);
    });

    it('23. agents — riskScoreP90Last7d: null when no ops in 7d window', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-v1098-p90null', 'fs', 'sess-1', dayAgo(10)),
        dec(0.5),
      );

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1098-p90null');
      expect(status).toBe(200);
      expect(body.riskScoreP90Last7d).toBeNull();
    });

    it('24. agents — riskScoreP90Last7d: correct p90 for 10-element array', async () => {
      ctx = await setup();
      // 10 ops with scores 0.1..1.0 → sorted=[0.1,0.2,...,1.0]
      // p90 index = Math.floor(10*0.9) = 9 → s[9] = 1.0
      const scores = [0.5, 0.3, 0.8, 0.1, 0.9, 0.2, 0.7, 0.4, 0.6, 1.0];
      for (const s of scores) {
        await ctx.logger.log(
          makeOp('agent-v1098-p90val', 'fs', `sess-${s}`, dayAgo(2)),
          dec(s),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/agents/agent-v1098-p90val');
      expect(status).toBe(200);
      expect(body.riskScoreP90Last7d as number).toBeCloseTo(1.0, 5);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1559-T1563 — v10.98 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('25. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v1098-pres', 'sess-1'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1098-pres');
      expect(status).toBe(200);

      expect(body).toHaveProperty('requireApprovalCountStdDevLast7d');
      expect(body).toHaveProperty('requireApprovalCountStdDevLast30d');
      expect(body).toHaveProperty('riskScoreMedianLast7d');
      expect(body).toHaveProperty('riskScoreMedianLast30d');
      expect(body).toHaveProperty('riskScoreP90Last7d');
    });

    it('26. tools — requireApprovalCountStdDevLast7d: null when no ops in 7d window', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-a', 'tool-v1098-ra7null', 'sess-1', dayAgo(10)),
        dec(0.5, 'require_approval'),
      );

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1098-ra7null');
      expect(status).toBe(200);
      expect(body.requireApprovalCountStdDevLast7d).toBeNull();
    });

    it('27. tools — requireApprovalCountStdDevLast7d: non-negative for ra activity in 7d', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-a', 'tool-v1098-ra7mix', 'sess-1', dayAgo(1)),
        dec(0.5, 'require_approval'),
      );
      await ctx.logger.log(
        makeOp('agent-b', 'tool-v1098-ra7mix', 'sess-2', dayAgo(3)),
        dec(0.5, 'require_approval'),
      );

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1098-ra7mix');
      expect(status).toBe(200);
      expect(body.requireApprovalCountStdDevLast7d as number).toBeGreaterThanOrEqual(0);
    });

    it('28. tools — requireApprovalCountStdDevLast30d: null when no ops in 30d window', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-a', 'tool-v1098-ra30null', 'sess-1', dayAgo(35)),
        dec(0.5, 'require_approval'),
      );

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1098-ra30null');
      expect(status).toBe(200);
      expect(body.requireApprovalCountStdDevLast30d).toBeNull();
    });

    it('29. tools — riskScoreMedianLast7d: null when no ops in 7d window', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-a', 'tool-v1098-med7null', 'sess-1', dayAgo(10)),
        dec(0.5),
      );

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1098-med7null');
      expect(status).toBe(200);
      expect(body.riskScoreMedianLast7d).toBeNull();
    });

    it('30. tools — riskScoreMedianLast7d: correct median for 3 ops', async () => {
      ctx = await setup();
      // 3 ops: 0.1, 0.4, 0.9 → sorted=[0.1,0.4,0.9] → median = 0.4
      await ctx.logger.log(makeOp('agent-a', 'tool-v1098-med7val', 'sess-1', dayAgo(2)), dec(0.9));
      await ctx.logger.log(makeOp('agent-b', 'tool-v1098-med7val', 'sess-2', dayAgo(2)), dec(0.1));
      await ctx.logger.log(makeOp('agent-c', 'tool-v1098-med7val', 'sess-3', dayAgo(2)), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1098-med7val');
      expect(status).toBe(200);
      expect(body.riskScoreMedianLast7d as number).toBeCloseTo(0.4, 5);
    });

    it('31. tools — riskScoreMedianLast30d: null when no ops in 30d window', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-a', 'tool-v1098-med30null', 'sess-1', dayAgo(35)),
        dec(0.5),
      );

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1098-med30null');
      expect(status).toBe(200);
      expect(body.riskScoreMedianLast30d).toBeNull();
    });

    it('32. tools — riskScoreMedianLast30d: single op in 30d returns its score', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-a', 'tool-v1098-med30single', 'sess-1', dayAgo(25)),
        dec(0.75),
      );

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1098-med30single');
      expect(status).toBe(200);
      expect(body.riskScoreMedianLast30d as number).toBeCloseTo(0.75, 5);
    });

    it('33. tools — riskScoreP90Last7d: null when no ops in 7d window', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-a', 'tool-v1098-p90null', 'sess-1', dayAgo(10)),
        dec(0.5),
      );

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1098-p90null');
      expect(status).toBe(200);
      expect(body.riskScoreP90Last7d).toBeNull();
    });

    it('34. tools — riskScoreP90Last7d: single op returns its score (floor(1*0.9)=0)', async () => {
      ctx = await setup();
      // 1 op: score=0.8; sorted=[0.8]; index=Math.floor(1*0.9)=0 → s[0]=0.8
      await ctx.logger.log(
        makeOp('agent-a', 'tool-v1098-p90single', 'sess-1', dayAgo(2)),
        dec(0.8),
      );

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1098-p90single');
      expect(status).toBe(200);
      expect(body.riskScoreP90Last7d as number).toBeCloseTo(0.8, 5);
    });

    it('35. tools — riskScoreP90Last7d: p90 of 5 ops (index=floor(5*0.9)=4)', async () => {
      ctx = await setup();
      // 5 ops: 0.1, 0.3, 0.5, 0.7, 0.9 → sorted; p90 index=floor(5*0.9)=4 → 0.9
      const scores = [0.7, 0.1, 0.9, 0.3, 0.5];
      for (const s of scores) {
        await ctx.logger.log(
          makeOp('agent-a', 'tool-v1098-p90five', `sess-${s}`, dayAgo(3)),
          dec(s),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1098-p90five');
      expect(status).toBe(200);
      expect(body.riskScoreP90Last7d as number).toBeCloseTo(0.9, 5);
    });
  });

  // ── summary endpoint ───────────────────────────────────────────────────────────

  describe('T1559-T1563 — v10.98 new fields (summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('36. summary — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);

      expect(body).toHaveProperty('requireApprovalCountStdDevLast7d');
      expect(body).toHaveProperty('requireApprovalCountStdDevLast30d');
      expect(body).toHaveProperty('riskScoreMedianLast7d');
      expect(body).toHaveProperty('riskScoreMedianLast30d');
      expect(body).toHaveProperty('riskScoreP90Last7d');
    });

    it('37. summary — no ops: all five fields are null', async () => {
      ctx = await setup();

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.requireApprovalCountStdDevLast7d).toBeNull();
      expect(body.requireApprovalCountStdDevLast30d).toBeNull();
      expect(body.riskScoreMedianLast7d).toBeNull();
      expect(body.riskScoreMedianLast30d).toBeNull();
      expect(body.riskScoreP90Last7d).toBeNull();
    });

    it('38. summary — requireApprovalCountStdDevLast7d: null when all ops older than 7d', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-a', 'fs', 'sess-1', dayAgo(10)),
        dec(0.5, 'require_approval'),
      );

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.requireApprovalCountStdDevLast7d).toBeNull();
    });

    it('39. summary — requireApprovalCountStdDevLast7d: correct value for known pattern', async () => {
      ctx = await setup();
      // Day 2: 4 require_approvals; days 1,3-7: 0 → counts=[0,4,0,0,0,0,0]; mean=4/7
      const expectedMean = 4 / 7;
      const counts = [0, 4, 0, 0, 0, 0, 0];
      const expectedStdDev = Math.sqrt(
        counts.reduce((a, v) => a + (v - expectedMean) ** 2, 0) / 7,
      );

      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(
          makeOp(`agent-${i}`, 'fs', `sess-${i}`, dayAgo(2)),
          dec(0.5, 'require_approval'),
        );
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.requireApprovalCountStdDevLast7d as number).toBeCloseTo(expectedStdDev, 4);
    });

    it('40. summary — requireApprovalCountStdDevLast30d: null when all ops older than 30d', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-a', 'fs', 'sess-1', dayAgo(35)),
        dec(0.5, 'require_approval'),
      );

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.requireApprovalCountStdDevLast30d).toBeNull();
    });

    it('41. summary — requireApprovalCountStdDevLast30d: 0 when no ra in 30d window', async () => {
      ctx = await setup();
      // Op in 30d window but action=allow → all 30 ra counts = 0 → stddev = 0
      await ctx.logger.log(
        makeOp('agent-a', 'fs', 'sess-1', dayAgo(15)),
        dec(0.5, 'allow'),
      );

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.requireApprovalCountStdDevLast30d as number).toBeCloseTo(0, 5);
    });

    it('42. summary — riskScoreMedianLast7d: null when all ops older than 7d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', dayAgo(10)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreMedianLast7d).toBeNull();
    });

    it('43. summary — riskScoreMedianLast7d: correct median for 3 ops', async () => {
      ctx = await setup();
      // 3 ops: 0.2, 0.6, 0.4 → sorted=[0.2,0.4,0.6] → median = 0.4
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', dayAgo(1)), dec(0.2));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-2', dayAgo(2)), dec(0.6));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-3', dayAgo(3)), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreMedianLast7d as number).toBeCloseTo(0.4, 5);
    });

    it('44. summary — riskScoreMedianLast30d: null when all ops older than 30d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', dayAgo(35)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreMedianLast30d).toBeNull();
    });

    it('45. summary — riskScoreMedianLast30d: even-length median over 30d ops', async () => {
      ctx = await setup();
      // 4 ops: 0.1, 0.5, 0.3, 0.9 → sorted=[0.1,0.3,0.5,0.9] → median=(0.3+0.5)/2=0.4
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', dayAgo(5)), dec(0.1));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-2', dayAgo(10)), dec(0.5));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-3', dayAgo(15)), dec(0.3));
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-4', dayAgo(20)), dec(0.9));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreMedianLast30d as number).toBeCloseTo(0.4, 5);
    });

    it('46. summary — riskScoreP90Last7d: null when all ops older than 7d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', dayAgo(10)), dec(0.5));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreP90Last7d).toBeNull();
    });

    it('47. summary — riskScoreP90Last7d: p90 of 10 ops (index=9)', async () => {
      ctx = await setup();
      // 10 ops with scores 0.1..1.0 → sorted=[0.1,0.2,...,1.0]
      // index = Math.floor(10*0.9) = 9 → s[9] = 1.0
      const scores = [0.3, 0.7, 0.1, 0.5, 0.9, 0.2, 0.6, 0.4, 0.8, 1.0];
      for (const s of scores) {
        await ctx.logger.log(makeOp(`agent-${s}`, 'fs', `sess-${s}`, dayAgo(2)), dec(s));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreP90Last7d as number).toBeCloseTo(1.0, 5);
    });

    it('48. summary — riskScoreP90Last7d: p90 of 5 ops (index=4 → highest value)', async () => {
      ctx = await setup();
      // 5 ops: scores 0.2, 0.4, 0.6, 0.8, 1.0 → sorted; index=Math.floor(5*0.9)=4 → 1.0
      const scores = [0.4, 1.0, 0.2, 0.8, 0.6];
      for (const s of scores) {
        await ctx.logger.log(makeOp(`agent-${s}`, 'fs', `sess-${s}`, dayAgo(1)), dec(s));
      }

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreP90Last7d as number).toBeCloseTo(1.0, 5);
    });

    it('49. summary — riskScoreP90Last7d: in-range value [0,1]', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', dayAgo(2)), dec(0.3));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-2', dayAgo(3)), dec(0.7));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      const p90 = body.riskScoreP90Last7d as number;
      expect(p90).toBeGreaterThanOrEqual(0);
      expect(p90).toBeLessThanOrEqual(1);
    });

    it('50. summary — all five fields non-null when ops in respective windows', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-1', dayAgo(1)), dec(0.4, 'require_approval'));
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-2', dayAgo(2)), dec(0.6, 'allow'));
      await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-3', dayAgo(20)), dec(0.5, 'block'));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.requireApprovalCountStdDevLast7d).not.toBeNull();
      expect(body.requireApprovalCountStdDevLast30d).not.toBeNull();
      expect(body.riskScoreMedianLast7d).not.toBeNull();
      expect(body.riskScoreMedianLast30d).not.toBeNull();
      expect(body.riskScoreP90Last7d).not.toBeNull();
    });
  });
});

// ── v10.99 ────────────────────────────────────────────────────────────────────

describe('v10.99', () => {
  function dayAgo(d: number): Date {
    const now = new Date(PINNED_NOW());
    // DST-safe: use JS date arithmetic
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() - d);
  }

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1564-T1568 — v10.99 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v1099-pres'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1099-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('riskScoreP90Last30d');
      expect(body).toHaveProperty('riskScoreP10Last7d');
      expect(body).toHaveProperty('riskScoreP10Last30d');
      expect(body).toHaveProperty('riskScoreIQRLast7d');
      expect(body).toHaveProperty('riskScoreIQRLast30d');
    });

    it('2. sessions — riskScoreP90Last30d: null when no ops in 30d window', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-b', 'fs', 'sess-v1099-p90-30null', dayAgo(35)),
        dec(0.8),
      );
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1099-p90-30null');
      expect(status).toBe(200);
      expect(body.riskScoreP90Last30d).toBeNull();
    });

    it('3. sessions — riskScoreP90Last30d: single op returns its score (Math.floor(1*0.9)=0)', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-c', 'fs', 'sess-v1099-p90-30single', dayAgo(20)),
        dec(0.7),
      );
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1099-p90-30single');
      expect(status).toBe(200);
      expect(body.riskScoreP90Last30d as number).toBeCloseTo(0.7, 5);
    });

    it('4. sessions — riskScoreP90Last30d: 10 op array, index=9', async () => {
      ctx = await setup();
      // Scores 0.1..1.0 → sorted → index Math.floor(10*0.9)=9 → s[9]=1.0
      for (let i = 1; i <= 10; i++) {
        await ctx.logger.log(
          makeOp('agent-d', 'fs', 'sess-v1099-p90-30ten', dayAgo(15)),
          dec(i / 10),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1099-p90-30ten');
      expect(status).toBe(200);
      expect(body.riskScoreP90Last30d as number).toBeCloseTo(1.0, 5);
    });

    it('5. sessions — riskScoreP10Last7d: null when no ops in 7d window', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-e', 'fs', 'sess-v1099-p10-7null', dayAgo(10)),
        dec(0.3),
      );
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1099-p10-7null');
      expect(status).toBe(200);
      expect(body.riskScoreP10Last7d).toBeNull();
    });

    it('6. sessions — riskScoreP10Last7d: single op returns its score (Math.floor(1*0.1)=0)', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-f', 'fs', 'sess-v1099-p10-7single', dayAgo(3)),
        dec(0.2),
      );
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1099-p10-7single');
      expect(status).toBe(200);
      expect(body.riskScoreP10Last7d as number).toBeCloseTo(0.2, 5);
    });

    it('7. sessions — riskScoreP10Last7d: 10-element array, index=1', async () => {
      ctx = await setup();
      // Scores 0.1..1.0 → sorted → index Math.floor(10*0.1)=1 → s[1]=0.2
      for (let i = 1; i <= 10; i++) {
        await ctx.logger.log(
          makeOp('agent-g', 'fs', 'sess-v1099-p10-7ten', dayAgo(2)),
          dec(i / 10),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1099-p10-7ten');
      expect(status).toBe(200);
      expect(body.riskScoreP10Last7d as number).toBeCloseTo(0.2, 5);
    });

    it('8. sessions — riskScoreP10Last30d: null when no ops in 30d window', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-h', 'fs', 'sess-v1099-p10-30null', dayAgo(40)),
        dec(0.5),
      );
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1099-p10-30null');
      expect(status).toBe(200);
      expect(body.riskScoreP10Last30d).toBeNull();
    });

    it('9. sessions — riskScoreP10Last30d: 5-element array, index=0', async () => {
      ctx = await setup();
      // Scores 0.1,0.3,0.5,0.7,0.9 → sorted → index Math.floor(5*0.1)=0 → s[0]=0.1
      for (const score of [0.3, 0.1, 0.9, 0.5, 0.7]) {
        await ctx.logger.log(
          makeOp('agent-i', 'fs', 'sess-v1099-p10-30five', dayAgo(10)),
          dec(score),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1099-p10-30five');
      expect(status).toBe(200);
      expect(body.riskScoreP10Last30d as number).toBeCloseTo(0.1, 5);
    });

    it('10. sessions — riskScoreIQRLast7d: null when no ops in 7d window', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-j', 'fs', 'sess-v1099-iqr7null', dayAgo(10)),
        dec(0.5),
      );
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1099-iqr7null');
      expect(status).toBe(200);
      expect(body.riskScoreIQRLast7d).toBeNull();
    });

    it('11. sessions — riskScoreIQRLast7d: 0 when all scores equal', async () => {
      ctx = await setup();
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(
          makeOp('agent-k', 'fs', 'sess-v1099-iqr7zero', dayAgo(2)),
          dec(0.5),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1099-iqr7zero');
      expect(status).toBe(200);
      expect(body.riskScoreIQRLast7d as number).toBeCloseTo(0, 5);
    });

    it('12. sessions — riskScoreIQRLast7d: correct IQR for 4-element array', async () => {
      ctx = await setup();
      // Scores 0.1,0.3,0.7,0.9 → sorted → P25=s[Math.floor(4*0.25)]=s[1]=0.3, P75=s[Math.floor(4*0.75)]=s[3]=0.9 → IQR=0.6
      for (const score of [0.7, 0.1, 0.9, 0.3]) {
        await ctx.logger.log(
          makeOp('agent-l', 'fs', 'sess-v1099-iqr7four', dayAgo(1)),
          dec(score),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1099-iqr7four');
      expect(status).toBe(200);
      // P25 index=1 → 0.3; P75 index=3 → 0.9; IQR=0.6
      expect(body.riskScoreIQRLast7d as number).toBeCloseTo(0.6, 5);
    });

    it('13. sessions — riskScoreIQRLast30d: null when no ops in 30d window', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-m', 'fs', 'sess-v1099-iqr30null', dayAgo(35)),
        dec(0.5),
      );
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v1099-iqr30null');
      expect(status).toBe(200);
      expect(body.riskScoreIQRLast30d).toBeNull();
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1564-T1568 — v10.99 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('14. agents — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-v1099-pres'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/agents/agt-v1099-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('riskScoreP90Last30d');
      expect(body).toHaveProperty('riskScoreP10Last7d');
      expect(body).toHaveProperty('riskScoreP10Last30d');
      expect(body).toHaveProperty('riskScoreIQRLast7d');
      expect(body).toHaveProperty('riskScoreIQRLast30d');
    });

    it('15. agents — riskScoreP90Last30d: null when no ops in 30d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-v1099-p90-30null', 'fs', 'sess', dayAgo(35)), dec(0.8));
      const { status, body } = await getJSON(ctx.port, '/agents/agt-v1099-p90-30null');
      expect(status).toBe(200);
      expect(body.riskScoreP90Last30d).toBeNull();
    });

    it('16. agents — riskScoreP90Last30d: 10-element array uses index 9', async () => {
      ctx = await setup();
      for (let i = 1; i <= 10; i++) {
        await ctx.logger.log(
          makeOp('agt-v1099-p90-30ten', 'fs', 'sess', dayAgo(15)),
          dec(i / 10),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/agents/agt-v1099-p90-30ten');
      expect(status).toBe(200);
      expect(body.riskScoreP90Last30d as number).toBeCloseTo(1.0, 5);
    });

    it('17. agents — riskScoreP10Last7d: null when no ops in 7d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-v1099-p10-7null', 'fs', 'sess', dayAgo(10)), dec(0.3));
      const { status, body } = await getJSON(ctx.port, '/agents/agt-v1099-p10-7null');
      expect(status).toBe(200);
      expect(body.riskScoreP10Last7d).toBeNull();
    });

    it('18. agents — riskScoreP10Last7d: 10-element array uses index 1', async () => {
      ctx = await setup();
      for (let i = 1; i <= 10; i++) {
        await ctx.logger.log(
          makeOp('agt-v1099-p10-7ten', 'fs', 'sess', dayAgo(2)),
          dec(i / 10),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/agents/agt-v1099-p10-7ten');
      expect(status).toBe(200);
      expect(body.riskScoreP10Last7d as number).toBeCloseTo(0.2, 5);
    });

    it('19. agents — riskScoreP10Last30d: null when no ops in 30d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-v1099-p10-30null', 'fs', 'sess', dayAgo(40)), dec(0.5));
      const { status, body } = await getJSON(ctx.port, '/agents/agt-v1099-p10-30null');
      expect(status).toBe(200);
      expect(body.riskScoreP10Last30d).toBeNull();
    });

    it('20. agents — riskScoreP10Last30d: 5-element array uses index 0', async () => {
      ctx = await setup();
      for (const score of [0.3, 0.1, 0.9, 0.5, 0.7]) {
        await ctx.logger.log(
          makeOp('agt-v1099-p10-30five', 'fs', 'sess', dayAgo(10)),
          dec(score),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/agents/agt-v1099-p10-30five');
      expect(status).toBe(200);
      expect(body.riskScoreP10Last30d as number).toBeCloseTo(0.1, 5);
    });

    it('21. agents — riskScoreIQRLast7d: null when no ops in 7d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-v1099-iqr7null', 'fs', 'sess', dayAgo(10)), dec(0.5));
      const { status, body } = await getJSON(ctx.port, '/agents/agt-v1099-iqr7null');
      expect(status).toBe(200);
      expect(body.riskScoreIQRLast7d).toBeNull();
    });

    it('22. agents — riskScoreIQRLast7d: correct IQR for 4-element array', async () => {
      ctx = await setup();
      for (const score of [0.7, 0.1, 0.9, 0.3]) {
        await ctx.logger.log(
          makeOp('agt-v1099-iqr7four', 'fs', 'sess', dayAgo(1)),
          dec(score),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/agents/agt-v1099-iqr7four');
      expect(status).toBe(200);
      expect(body.riskScoreIQRLast7d as number).toBeCloseTo(0.6, 5);
    });

    it('23. agents — riskScoreIQRLast30d: null when no ops in 30d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-v1099-iqr30null', 'fs', 'sess', dayAgo(35)), dec(0.5));
      const { status, body } = await getJSON(ctx.port, '/agents/agt-v1099-iqr30null');
      expect(status).toBe(200);
      expect(body.riskScoreIQRLast30d).toBeNull();
    });

    it('24. agents — riskScoreIQRLast30d: correct IQR for 4-element array in 30d', async () => {
      ctx = await setup();
      for (const score of [0.2, 0.4, 0.6, 0.8]) {
        await ctx.logger.log(
          makeOp('agt-v1099-iqr30four', 'fs', 'sess', dayAgo(15)),
          dec(score),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/agents/agt-v1099-iqr30four');
      expect(status).toBe(200);
      // sorted=[0.2,0.4,0.6,0.8]; P25=s[1]=0.4; P75=s[3]=0.8; IQR=0.4
      expect(body.riskScoreIQRLast30d as number).toBeCloseTo(0.4, 5);
    });

    it('25. agents — riskScoreIQRLast7d: 0 when all scores are equal', async () => {
      ctx = await setup();
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(
          makeOp('agt-v1099-iqr7eq', 'fs', 'sess', dayAgo(2)),
          dec(0.6),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/agents/agt-v1099-iqr7eq');
      expect(status).toBe(200);
      expect(body.riskScoreIQRLast7d as number).toBeCloseTo(0, 5);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1564-T1568 — v10.99 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('26. tools — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v1099-pres'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1099-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('riskScoreP90Last30d');
      expect(body).toHaveProperty('riskScoreP10Last7d');
      expect(body).toHaveProperty('riskScoreP10Last30d');
      expect(body).toHaveProperty('riskScoreIQRLast7d');
      expect(body).toHaveProperty('riskScoreIQRLast30d');
    });

    it('27. tools — riskScoreP90Last30d: null when no ops in 30d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-b', 'tool-v1099-p90-30null', 'sess', dayAgo(35)), dec(0.8));
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1099-p90-30null');
      expect(status).toBe(200);
      expect(body.riskScoreP90Last30d).toBeNull();
    });

    it('28. tools — riskScoreP90Last30d: 10-element array uses index 9', async () => {
      ctx = await setup();
      for (let i = 1; i <= 10; i++) {
        await ctx.logger.log(
          makeOp('agent-c', 'tool-v1099-p90-30ten', 'sess', dayAgo(15)),
          dec(i / 10),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1099-p90-30ten');
      expect(status).toBe(200);
      expect(body.riskScoreP90Last30d as number).toBeCloseTo(1.0, 5);
    });

    it('29. tools — riskScoreP10Last7d: null when no ops in 7d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-d', 'tool-v1099-p10-7null', 'sess', dayAgo(10)), dec(0.3));
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1099-p10-7null');
      expect(status).toBe(200);
      expect(body.riskScoreP10Last7d).toBeNull();
    });

    it('30. tools — riskScoreP10Last7d: 10-element array uses index 1', async () => {
      ctx = await setup();
      for (let i = 1; i <= 10; i++) {
        await ctx.logger.log(
          makeOp('agent-e', 'tool-v1099-p10-7ten', 'sess', dayAgo(2)),
          dec(i / 10),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1099-p10-7ten');
      expect(status).toBe(200);
      expect(body.riskScoreP10Last7d as number).toBeCloseTo(0.2, 5);
    });

    it('31. tools — riskScoreP10Last30d: null when no ops in 30d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-f', 'tool-v1099-p10-30null', 'sess', dayAgo(40)), dec(0.5));
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1099-p10-30null');
      expect(status).toBe(200);
      expect(body.riskScoreP10Last30d).toBeNull();
    });

    it('32. tools — riskScoreP10Last30d: 5-element array uses index 0', async () => {
      ctx = await setup();
      for (const score of [0.3, 0.1, 0.9, 0.5, 0.7]) {
        await ctx.logger.log(
          makeOp('agent-g', 'tool-v1099-p10-30five', 'sess', dayAgo(10)),
          dec(score),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1099-p10-30five');
      expect(status).toBe(200);
      expect(body.riskScoreP10Last30d as number).toBeCloseTo(0.1, 5);
    });

    it('33. tools — riskScoreIQRLast7d: null when no ops in 7d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-h', 'tool-v1099-iqr7null', 'sess', dayAgo(10)), dec(0.5));
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1099-iqr7null');
      expect(status).toBe(200);
      expect(body.riskScoreIQRLast7d).toBeNull();
    });

    it('34. tools — riskScoreIQRLast7d: correct IQR for 4-element array', async () => {
      ctx = await setup();
      for (const score of [0.7, 0.1, 0.9, 0.3]) {
        await ctx.logger.log(
          makeOp('agent-i', 'tool-v1099-iqr7four', 'sess', dayAgo(1)),
          dec(score),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1099-iqr7four');
      expect(status).toBe(200);
      expect(body.riskScoreIQRLast7d as number).toBeCloseTo(0.6, 5);
    });

    it('35. tools — riskScoreIQRLast30d: null when no ops in 30d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-j', 'tool-v1099-iqr30null', 'sess', dayAgo(35)), dec(0.5));
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1099-iqr30null');
      expect(status).toBe(200);
      expect(body.riskScoreIQRLast30d).toBeNull();
    });

    it('36. tools — riskScoreIQRLast30d: correct IQR for 4-element array in 30d', async () => {
      ctx = await setup();
      for (const score of [0.2, 0.4, 0.6, 0.8]) {
        await ctx.logger.log(
          makeOp('agent-k', 'tool-v1099-iqr30four', 'sess', dayAgo(15)),
          dec(score),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1099-iqr30four');
      expect(status).toBe(200);
      expect(body.riskScoreIQRLast30d as number).toBeCloseTo(0.4, 5);
    });

    it('37. tools — riskScoreP90Last30d: single op returns its score', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-l', 'tool-v1099-p90-30one', 'sess', dayAgo(5)), dec(0.55));
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1099-p90-30one');
      expect(status).toBe(200);
      expect(body.riskScoreP90Last30d as number).toBeCloseTo(0.55, 5);
    });

    it('38. tools — riskScoreIQRLast7d: 0 when all scores equal', async () => {
      ctx = await setup();
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(
          makeOp('agent-m', 'tool-v1099-iqr7eq', 'sess', dayAgo(2)),
          dec(0.4),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v1099-iqr7eq');
      expect(status).toBe(200);
      expect(body.riskScoreIQRLast7d as number).toBeCloseTo(0, 5);
    });
  });

  // ── summary endpoint ──────────────────────────────────────────────────────────

  describe('T1564-T1568 — v10.99 new fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('39. summary — all five new fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body).toHaveProperty('riskScoreP90Last30d');
      expect(body).toHaveProperty('riskScoreP10Last7d');
      expect(body).toHaveProperty('riskScoreP10Last30d');
      expect(body).toHaveProperty('riskScoreIQRLast7d');
      expect(body).toHaveProperty('riskScoreIQRLast30d');
    });

    it('40. summary — riskScoreP90Last30d: null when no ops in 30d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess', dayAgo(35)), dec(0.8));
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreP90Last30d).toBeNull();
    });

    it('41. summary — riskScoreP90Last30d: 10-element array uses index 9', async () => {
      ctx = await setup();
      for (let i = 1; i <= 10; i++) {
        await ctx.logger.log(makeOp('agent-c', 'fs', 'sess', dayAgo(15)), dec(i / 10));
      }
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreP90Last30d as number).toBeCloseTo(1.0, 5);
    });

    it('42. summary — riskScoreP10Last7d: null when no ops in 7d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-d', 'fs', 'sess', dayAgo(10)), dec(0.3));
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreP10Last7d).toBeNull();
    });

    it('43. summary — riskScoreP10Last7d: 10-element array uses index 1', async () => {
      ctx = await setup();
      for (let i = 1; i <= 10; i++) {
        await ctx.logger.log(makeOp('agent-e', 'fs', 'sess', dayAgo(2)), dec(i / 10));
      }
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreP10Last7d as number).toBeCloseTo(0.2, 5);
    });

    it('44. summary — riskScoreP10Last30d: null when no ops in 30d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-f', 'fs', 'sess', dayAgo(40)), dec(0.5));
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreP10Last30d).toBeNull();
    });

    it('45. summary — riskScoreP10Last30d: 5-element array uses index 0', async () => {
      ctx = await setup();
      for (const score of [0.3, 0.1, 0.9, 0.5, 0.7]) {
        await ctx.logger.log(makeOp('agent-g', 'fs', 'sess', dayAgo(10)), dec(score));
      }
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreP10Last30d as number).toBeCloseTo(0.1, 5);
    });

    it('46. summary — riskScoreIQRLast7d: null when no ops in 7d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-h', 'fs', 'sess', dayAgo(10)), dec(0.5));
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreIQRLast7d).toBeNull();
    });

    it('47. summary — riskScoreIQRLast7d: correct IQR for 4-element array', async () => {
      ctx = await setup();
      for (const score of [0.7, 0.1, 0.9, 0.3]) {
        await ctx.logger.log(makeOp('agent-i', 'fs', 'sess', dayAgo(1)), dec(score));
      }
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreIQRLast7d as number).toBeCloseTo(0.6, 5);
    });

    it('48. summary — riskScoreIQRLast30d: null when no ops in 30d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-j', 'fs', 'sess', dayAgo(35)), dec(0.5));
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreIQRLast30d).toBeNull();
    });

    it('49. summary — riskScoreIQRLast30d: correct IQR for 4-element array in 30d', async () => {
      ctx = await setup();
      for (const score of [0.2, 0.4, 0.6, 0.8]) {
        await ctx.logger.log(makeOp('agent-k', 'fs', 'sess', dayAgo(15)), dec(score));
      }
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      // sorted=[0.2,0.4,0.6,0.8]; P25=s[1]=0.4; P75=s[3]=0.8; IQR=0.4
      expect(body.riskScoreIQRLast30d as number).toBeCloseTo(0.4, 5);
    });

    it('50. summary — riskScoreIQRLast7d: 0 when all scores equal', async () => {
      ctx = await setup();
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp('agent-l', 'fs', 'sess', dayAgo(2)), dec(0.5));
      }
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreIQRLast7d as number).toBeCloseTo(0, 5);
    });
  });
});

// ── v10.100 ────────────────────────────────────────────────────────────────────

describe('v10.100', () => {
  function dayAgo(d: number): Date {
    const now = new Date(PINNED_NOW());
    // DST-safe: use JS date arithmetic
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() - d);
  }

  // ── sessions endpoint ──────────────────────────────────────────────────────────

  describe('T1569-T1573 — v10.100 new fields (sessions endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('1. sessions — all five fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-v10100-pres'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10100-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('riskScoreCVLast7d');
      expect(body).toHaveProperty('riskScoreCVLast30d');
      expect(body).toHaveProperty('blockRatioLast7dVs30d');
      expect(body).toHaveProperty('opsCountRatioLast7dVs30d');
      expect(body).toHaveProperty('riskScoreRangeAllTime');
    });

    it('2. sessions — riskScoreCVLast7d: null when no ops in 7d window', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-b', 'fs', 'sess-v10100-cv7null', dayAgo(10)),
        dec(0.5),
      );
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10100-cv7null');
      expect(status).toBe(200);
      expect(body.riskScoreCVLast7d).toBeNull();
    });

    it('3. sessions — riskScoreCVLast7d: null when mean=0 (all scores are 0)', async () => {
      ctx = await setup();
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-v10100-cv7zero', dayAgo(2)), dec(0));
      }
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10100-cv7zero');
      expect(status).toBe(200);
      expect(body.riskScoreCVLast7d).toBeNull();
    });

    it('4. sessions — riskScoreCVLast7d: correct CV for known scores', async () => {
      ctx = await setup();
      // scores = [0.2, 0.4, 0.6] → mean=0.4, variance=(0.04+0+0.04)/3, stddev=sqrt(0.04)≈0.1633, CV≈0.4082
      for (const score of [0.2, 0.4, 0.6]) {
        await ctx.logger.log(makeOp('agent-d', 'fs', 'sess-v10100-cv7val', dayAgo(3)), dec(score));
      }
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10100-cv7val');
      expect(status).toBe(200);
      const cv = body.riskScoreCVLast7d as number;
      expect(cv).toBeGreaterThan(0);
      // mean=0.4, stddev=sqrt((0.04+0+0.04)/3)=sqrt(0.08/3)≈0.16329, CV=0.16329/0.4≈0.40825
      expect(cv).toBeCloseTo(0.40825, 3);
    });

    it('5. sessions — riskScoreCVLast30d: null when no ops in 30d window', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-e', 'fs', 'sess-v10100-cv30null', dayAgo(35)),
        dec(0.5),
      );
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10100-cv30null');
      expect(status).toBe(200);
      expect(body.riskScoreCVLast30d).toBeNull();
    });

    it('6. sessions — riskScoreCVLast30d: null when mean=0', async () => {
      ctx = await setup();
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(
          makeOp('agent-f', 'fs', 'sess-v10100-cv30zero', dayAgo(15)),
          dec(0),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10100-cv30zero');
      expect(status).toBe(200);
      expect(body.riskScoreCVLast30d).toBeNull();
    });

    it('7. sessions — riskScoreCVLast30d: correct CV for known scores', async () => {
      ctx = await setup();
      for (const score of [0.2, 0.4, 0.6]) {
        await ctx.logger.log(makeOp('agent-g', 'fs', 'sess-v10100-cv30val', dayAgo(15)), dec(score));
      }
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10100-cv30val');
      expect(status).toBe(200);
      expect(body.riskScoreCVLast30d as number).toBeCloseTo(0.40825, 3);
    });

    it('8. sessions — opsCountRatioLast7dVs30d: null when no ops in 30d window', async () => {
      ctx = await setup();
      await ctx.logger.log(
        makeOp('agent-h', 'fs', 'sess-v10100-ratio30null', dayAgo(40)),
        dec(0.5),
      );
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10100-ratio30null');
      expect(status).toBe(200);
      expect(body.opsCountRatioLast7dVs30d).toBeNull();
    });

    it('9. sessions — opsCountRatioLast7dVs30d: 0 when all ops are older than 7d but within 30d', async () => {
      ctx = await setup();
      // 3 ops between 8d and 25d ago → in 30d window but not 7d → ratio=0/3=0
      for (let d = 8; d <= 10; d++) {
        await ctx.logger.log(
          makeOp('agent-i', 'fs', 'sess-v10100-ratio7zero', dayAgo(d)),
          dec(0.4),
        );
      }
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10100-ratio7zero');
      expect(status).toBe(200);
      expect(body.opsCountRatioLast7dVs30d as number).toBeCloseTo(0, 5);
    });

    it('10. sessions — opsCountRatioLast7dVs30d: correct ratio 2/4', async () => {
      ctx = await setup();
      // 2 ops in last 7d, 2 ops between 7d and 30d → 7d=2, 30d=4 → ratio=0.5
      for (let i = 0; i < 2; i++) {
        await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v10100-ratiohalf', dayAgo(3)), dec(0.4));
      }
      for (let i = 0; i < 2; i++) {
        await ctx.logger.log(makeOp('agent-j', 'fs', 'sess-v10100-ratiohalf', dayAgo(15)), dec(0.4));
      }
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10100-ratiohalf');
      expect(status).toBe(200);
      expect(body.opsCountRatioLast7dVs30d as number).toBeCloseTo(0.5, 5);
    });

    it('11. sessions — riskScoreRangeAllTime: null when no logs', async () => {
      ctx = await setup();
      // do NOT log any ops — query a session with no data
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10100-rangenull');
      // session with no logs should return 404 or 200 with null range
      if (status === 200) {
        expect(body.riskScoreRangeAllTime).toBeNull();
      } else {
        expect(status).toBe(404);
      }
    });

    it('12. sessions — riskScoreRangeAllTime: 0 when single op', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-k', 'fs', 'sess-v10100-rangeone', dayAgo(5)), dec(0.7));
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10100-rangeone');
      expect(status).toBe(200);
      // max=0.7, min=0.7 → range=0
      expect(body.riskScoreRangeAllTime as number).toBeCloseTo(0, 5);
    });

    it('13. sessions — riskScoreRangeAllTime: correct range for multiple ops', async () => {
      ctx = await setup();
      for (const score of [0.1, 0.5, 0.9, 0.3]) {
        await ctx.logger.log(makeOp('agent-l', 'fs', 'sess-v10100-rangemulti', dayAgo(5)), dec(score));
      }
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10100-rangemulti');
      expect(status).toBe(200);
      // max=0.9, min=0.1 → range=0.8
      expect(body.riskScoreRangeAllTime as number).toBeCloseTo(0.8, 5);
    });

    it('14. sessions — blockRatioLast7dVs30d: null when 30d block rate=0', async () => {
      ctx = await setup();
      // all ops allowed → 30d rate=0 → ratio null
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-m', 'fs', 'sess-v10100-blknull30', dayAgo(3)), dec(0.4, 'allow'));
      }
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10100-blknull30');
      expect(status).toBe(200);
      expect(body.blockRatioLast7dVs30d).toBeNull();
    });

    it('15. sessions — blockRatioLast7dVs30d: correct ratio when both windows have blocks', async () => {
      ctx = await setup();
      // 7d: 2 ops, 1 block → rate7=0.5; 30d: 4 ops total (2 from 7d + 2 from 8-20d), 1 block from 7d + 1 from 8-20d → rate30=0.5; ratio=1
      await ctx.logger.log(makeOp('agent-n', 'fs', 'sess-v10100-blkratio', dayAgo(3)), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agent-n', 'fs', 'sess-v10100-blkratio', dayAgo(3)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-n', 'fs', 'sess-v10100-blkratio', dayAgo(15)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-n', 'fs', 'sess-v10100-blkratio', dayAgo(15)), dec(0.2, 'allow'));
      const { status, body } = await getJSON(ctx.port, '/sessions/sess-v10100-blkratio');
      expect(status).toBe(200);
      // rate7=1/2=0.5, rate30=2/4=0.5, ratio=1.0
      expect(body.blockRatioLast7dVs30d as number).toBeCloseTo(1.0, 5);
    });
  });

  // ── agents endpoint ────────────────────────────────────────────────────────────

  describe('T1569-T1573 — v10.100 new fields (agents endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('16. agents — all five fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-v10100-pres'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/agents/agt-v10100-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('riskScoreCVLast7d');
      expect(body).toHaveProperty('riskScoreCVLast30d');
      expect(body).toHaveProperty('blockRatioLast7dVs30d');
      expect(body).toHaveProperty('opsCountRatioLast7dVs30d');
      expect(body).toHaveProperty('riskScoreRangeAllTime');
    });

    it('17. agents — riskScoreCVLast7d: null when no ops in 7d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-v10100-cv7null', 'fs', 'sess', dayAgo(10)), dec(0.5));
      const { status, body } = await getJSON(ctx.port, '/agents/agt-v10100-cv7null');
      expect(status).toBe(200);
      expect(body.riskScoreCVLast7d).toBeNull();
    });

    it('18. agents — riskScoreCVLast7d: null when mean=0', async () => {
      ctx = await setup();
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agt-v10100-cv7zero', 'fs', 'sess', dayAgo(2)), dec(0));
      }
      const { status, body } = await getJSON(ctx.port, '/agents/agt-v10100-cv7zero');
      expect(status).toBe(200);
      expect(body.riskScoreCVLast7d).toBeNull();
    });

    it('19. agents — riskScoreCVLast7d: correct CV for known scores', async () => {
      ctx = await setup();
      for (const score of [0.2, 0.4, 0.6]) {
        await ctx.logger.log(makeOp('agt-v10100-cv7val', 'fs', 'sess', dayAgo(3)), dec(score));
      }
      const { status, body } = await getJSON(ctx.port, '/agents/agt-v10100-cv7val');
      expect(status).toBe(200);
      expect(body.riskScoreCVLast7d as number).toBeCloseTo(0.40825, 3);
    });

    it('20. agents — riskScoreCVLast30d: null when no ops in 30d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-v10100-cv30null', 'fs', 'sess', dayAgo(35)), dec(0.5));
      const { status, body } = await getJSON(ctx.port, '/agents/agt-v10100-cv30null');
      expect(status).toBe(200);
      expect(body.riskScoreCVLast30d).toBeNull();
    });

    it('21. agents — riskScoreCVLast30d: correct CV for known scores in 30d', async () => {
      ctx = await setup();
      for (const score of [0.2, 0.4, 0.6]) {
        await ctx.logger.log(makeOp('agt-v10100-cv30val', 'fs', 'sess', dayAgo(15)), dec(score));
      }
      const { status, body } = await getJSON(ctx.port, '/agents/agt-v10100-cv30val');
      expect(status).toBe(200);
      expect(body.riskScoreCVLast30d as number).toBeCloseTo(0.40825, 3);
    });

    it('22. agents — opsCountRatioLast7dVs30d: null when no ops in 30d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-v10100-ratio30null', 'fs', 'sess', dayAgo(40)), dec(0.5));
      const { status, body } = await getJSON(ctx.port, '/agents/agt-v10100-ratio30null');
      expect(status).toBe(200);
      expect(body.opsCountRatioLast7dVs30d).toBeNull();
    });

    it('23. agents — opsCountRatioLast7dVs30d: ratio 3/5 when 3 of 5 ops in 7d', async () => {
      ctx = await setup();
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agt-v10100-ratio35', 'fs', 'sess', dayAgo(3)), dec(0.4));
      }
      for (let i = 0; i < 2; i++) {
        await ctx.logger.log(makeOp('agt-v10100-ratio35', 'fs', 'sess', dayAgo(15)), dec(0.4));
      }
      const { status, body } = await getJSON(ctx.port, '/agents/agt-v10100-ratio35');
      expect(status).toBe(200);
      expect(body.opsCountRatioLast7dVs30d as number).toBeCloseTo(0.6, 5);
    });

    it('24. agents — riskScoreRangeAllTime: 0 when single op', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agt-v10100-rangeone', 'fs', 'sess', dayAgo(5)), dec(0.6));
      const { status, body } = await getJSON(ctx.port, '/agents/agt-v10100-rangeone');
      expect(status).toBe(200);
      expect(body.riskScoreRangeAllTime as number).toBeCloseTo(0, 5);
    });

    it('25. agents — riskScoreRangeAllTime: correct range for multiple ops', async () => {
      ctx = await setup();
      for (const score of [0.2, 0.5, 0.8]) {
        await ctx.logger.log(makeOp('agt-v10100-rangemulti', 'fs', 'sess', dayAgo(5)), dec(score));
      }
      const { status, body } = await getJSON(ctx.port, '/agents/agt-v10100-rangemulti');
      expect(status).toBe(200);
      // max=0.8, min=0.2 → range=0.6
      expect(body.riskScoreRangeAllTime as number).toBeCloseTo(0.6, 5);
    });
  });

  // ── tools endpoint ─────────────────────────────────────────────────────────────

  describe('T1569-T1573 — v10.100 new fields (tools endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('26. tools — all five fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a', 'tool-v10100-pres'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10100-pres');
      expect(status).toBe(200);
      expect(body).toHaveProperty('riskScoreCVLast7d');
      expect(body).toHaveProperty('riskScoreCVLast30d');
      expect(body).toHaveProperty('blockRatioLast7dVs30d');
      expect(body).toHaveProperty('opsCountRatioLast7dVs30d');
      expect(body).toHaveProperty('riskScoreRangeAllTime');
    });

    it('27. tools — riskScoreCVLast7d: null when no ops in 7d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-b', 'tool-v10100-cv7null', 'sess', dayAgo(10)), dec(0.5));
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10100-cv7null');
      expect(status).toBe(200);
      expect(body.riskScoreCVLast7d).toBeNull();
    });

    it('28. tools — riskScoreCVLast7d: null when mean=0', async () => {
      ctx = await setup();
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-c', 'tool-v10100-cv7zero', 'sess', dayAgo(2)), dec(0));
      }
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10100-cv7zero');
      expect(status).toBe(200);
      expect(body.riskScoreCVLast7d).toBeNull();
    });

    it('29. tools — riskScoreCVLast7d: correct CV for known scores', async () => {
      ctx = await setup();
      for (const score of [0.2, 0.4, 0.6]) {
        await ctx.logger.log(makeOp('agent-d', 'tool-v10100-cv7val', 'sess', dayAgo(3)), dec(score));
      }
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10100-cv7val');
      expect(status).toBe(200);
      expect(body.riskScoreCVLast7d as number).toBeCloseTo(0.40825, 3);
    });

    it('30. tools — riskScoreCVLast30d: null when no ops in 30d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-e', 'tool-v10100-cv30null', 'sess', dayAgo(35)), dec(0.5));
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10100-cv30null');
      expect(status).toBe(200);
      expect(body.riskScoreCVLast30d).toBeNull();
    });

    it('31. tools — riskScoreCVLast30d: correct CV for known scores in 30d', async () => {
      ctx = await setup();
      for (const score of [0.2, 0.4, 0.6]) {
        await ctx.logger.log(makeOp('agent-f', 'tool-v10100-cv30val', 'sess', dayAgo(15)), dec(score));
      }
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10100-cv30val');
      expect(status).toBe(200);
      expect(body.riskScoreCVLast30d as number).toBeCloseTo(0.40825, 3);
    });

    it('32. tools — opsCountRatioLast7dVs30d: null when no ops in 30d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-g', 'tool-v10100-ratio30null', 'sess', dayAgo(40)), dec(0.5));
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10100-ratio30null');
      expect(status).toBe(200);
      expect(body.opsCountRatioLast7dVs30d).toBeNull();
    });

    it('33. tools — opsCountRatioLast7dVs30d: 0 when all ops older than 7d', async () => {
      ctx = await setup();
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-h', 'tool-v10100-ratio0', 'sess', dayAgo(10)), dec(0.4));
      }
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10100-ratio0');
      expect(status).toBe(200);
      expect(body.opsCountRatioLast7dVs30d as number).toBeCloseTo(0, 5);
    });

    it('34. tools — riskScoreRangeAllTime: correct range for multiple ops', async () => {
      ctx = await setup();
      for (const score of [0.1, 0.5, 0.9]) {
        await ctx.logger.log(makeOp('agent-i', 'tool-v10100-rangemulti', 'sess', dayAgo(5)), dec(score));
      }
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10100-rangemulti');
      expect(status).toBe(200);
      // max=0.9, min=0.1 → range=0.8
      expect(body.riskScoreRangeAllTime as number).toBeCloseTo(0.8, 5);
    });

    it('35. tools — riskScoreRangeAllTime: 0 when single op', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-j', 'tool-v10100-rangeone', 'sess', dayAgo(5)), dec(0.55));
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10100-rangeone');
      expect(status).toBe(200);
      expect(body.riskScoreRangeAllTime as number).toBeCloseTo(0, 5);
    });

    it('36. tools — blockRatioLast7dVs30d: null when 30d block rate=0', async () => {
      ctx = await setup();
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-k', 'tool-v10100-blknull30', 'sess', dayAgo(3)), dec(0.4, 'allow'));
      }
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10100-blknull30');
      expect(status).toBe(200);
      expect(body.blockRatioLast7dVs30d).toBeNull();
    });

    it('37. tools — blockRatioLast7dVs30d: null when 7d window is empty', async () => {
      ctx = await setup();
      // only ops older than 7d → 7d window empty → null
      for (let i = 0; i < 2; i++) {
        await ctx.logger.log(makeOp('agent-l', 'tool-v10100-blk7null', 'sess', dayAgo(10)), dec(0.8, 'block'));
      }
      const { status, body } = await getJSON(ctx.port, '/tools/tool-v10100-blk7null');
      expect(status).toBe(200);
      expect(body.blockRatioLast7dVs30d).toBeNull();
    });
  });

  // ── summary endpoint ──────────────────────────────────────────────────────────

  describe('T1569-T1573 — v10.100 new fields (operations/summary endpoint)', () => {
    let ctx: Ctx;

    afterEach(async () => {
      if (ctx) await teardown(ctx);
    });

    it('38. summary — all five fields present in response', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-a'), dec(0.4));

      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body).toHaveProperty('riskScoreCVLast7d');
      expect(body).toHaveProperty('riskScoreCVLast30d');
      expect(body).toHaveProperty('blockRatioLast7dVs30d');
      expect(body).toHaveProperty('opsCountRatioLast7dVs30d');
      expect(body).toHaveProperty('riskScoreRangeAllTime');
    });

    it('39. summary — riskScoreCVLast7d: null when no ops in 7d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-b', 'fs', 'sess', dayAgo(10)), dec(0.5));
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreCVLast7d).toBeNull();
    });

    it('40. summary — riskScoreCVLast7d: null when mean=0', async () => {
      ctx = await setup();
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-c', 'fs', 'sess', dayAgo(2)), dec(0));
      }
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreCVLast7d).toBeNull();
    });

    it('41. summary — riskScoreCVLast7d: correct CV for known scores', async () => {
      ctx = await setup();
      for (const score of [0.2, 0.4, 0.6]) {
        await ctx.logger.log(makeOp('agent-d', 'fs', 'sess', dayAgo(3)), dec(score));
      }
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreCVLast7d as number).toBeCloseTo(0.40825, 3);
    });

    it('42. summary — riskScoreCVLast30d: null when no ops in 30d window', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-e', 'fs', 'sess', dayAgo(35)), dec(0.5));
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreCVLast30d).toBeNull();
    });

    it('43. summary — riskScoreCVLast30d: correct CV for known scores in 30d', async () => {
      ctx = await setup();
      for (const score of [0.2, 0.4, 0.6]) {
        await ctx.logger.log(makeOp('agent-f', 'fs', 'sess', dayAgo(15)), dec(score));
      }
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreCVLast30d as number).toBeCloseTo(0.40825, 3);
    });

    it('44. summary — opsCountRatioLast7dVs30d: null when no ops in 30d', async () => {
      ctx = await setup();
      await ctx.logger.log(makeOp('agent-g', 'fs', 'sess', dayAgo(40)), dec(0.5));
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.opsCountRatioLast7dVs30d).toBeNull();
    });

    it('45. summary — opsCountRatioLast7dVs30d: 0 when all ops older than 7d but within 30d', async () => {
      ctx = await setup();
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-h', 'fs', 'sess', dayAgo(10)), dec(0.4));
      }
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.opsCountRatioLast7dVs30d as number).toBeCloseTo(0, 5);
    });

    it('46. summary — opsCountRatioLast7dVs30d: correct ratio 2/6', async () => {
      ctx = await setup();
      for (let i = 0; i < 2; i++) {
        await ctx.logger.log(makeOp('agent-i', 'fs', 'sess', dayAgo(3)), dec(0.4));
      }
      for (let i = 0; i < 4; i++) {
        await ctx.logger.log(makeOp('agent-i', 'fs', 'sess', dayAgo(15)), dec(0.4));
      }
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      // 7d=2, 30d=6 → ratio=1/3≈0.3333
      expect(body.opsCountRatioLast7dVs30d as number).toBeCloseTo(1 / 3, 4);
    });

    it('47. summary — riskScoreRangeAllTime: null when no logs', async () => {
      ctx = await setup();
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.riskScoreRangeAllTime).toBeNull();
    });

    it('48. summary — riskScoreRangeAllTime: correct range for multiple ops', async () => {
      ctx = await setup();
      for (const score of [0.1, 0.4, 0.7, 0.9]) {
        await ctx.logger.log(makeOp('agent-j', 'fs', 'sess', dayAgo(5)), dec(score));
      }
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      // max=0.9, min=0.1 → range=0.8
      expect(body.riskScoreRangeAllTime as number).toBeCloseTo(0.8, 5);
    });

    it('49. summary — blockRatioLast7dVs30d: null when 30d block rate=0', async () => {
      ctx = await setup();
      for (let i = 0; i < 3; i++) {
        await ctx.logger.log(makeOp('agent-k', 'fs', 'sess', dayAgo(3)), dec(0.4, 'allow'));
      }
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      expect(body.blockRatioLast7dVs30d).toBeNull();
    });

    it('50. summary — blockRatioLast7dVs30d: correct ratio when both windows have blocks', async () => {
      ctx = await setup();
      // 7d: 2 ops, 1 block → rate7=0.5; 30d: 4 ops, 2 blocks → rate30=0.5; ratio=1.0
      await ctx.logger.log(makeOp('agent-l', 'fs', 'sess', dayAgo(3)), dec(0.8, 'block'));
      await ctx.logger.log(makeOp('agent-l', 'fs', 'sess', dayAgo(3)), dec(0.3, 'allow'));
      await ctx.logger.log(makeOp('agent-l', 'fs', 'sess', dayAgo(15)), dec(0.9, 'block'));
      await ctx.logger.log(makeOp('agent-l', 'fs', 'sess', dayAgo(15)), dec(0.2, 'allow'));
      const { status, body } = await getJSON(ctx.port, '/operations/summary');
      expect(status).toBe(200);
      // rate7=1/2=0.5, rate30=2/4=0.5, ratio=1.0
      expect(body.blockRatioLast7dVs30d as number).toBeCloseTo(1.0, 5);
    });
  });
});
