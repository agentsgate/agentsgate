/**
 * T244 — Dashboard GET /policy/rules endpoint.
 * Tests for the policy rules route returning rules, count, and thresholds.
 * Ports: 51950–51999
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../../src/modules/m2-store/index.js';
import { DashboardAPI } from '../../src/modules/m10-dashboard/index.js';
import type { AgentsGatePolicy } from '../../src/policy.js';

// ── HTTP helper ───────────────────────────────────────────────────────────────

async function get(port: number, p: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: p }, res => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString()) });
        } catch (e) {
          reject(e);
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Setup / teardown helpers ──────────────────────────────────────────────────

interface Ctx {
  store: StateStore;
  dash: DashboardAPI;
  port: number;
  tmpDir: string;
}

async function setup(policy?: AgentsGatePolicy): Promise<Ctx> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'as-pr-'));
  const store = new StateStore(path.join(tmpDir, 'test.db'));
  await store.initialize();
  const dash = new DashboardAPI(store, policy ? { policy } : {});
  await dash.start(0);
  const port = ((dash as unknown as { server: http.Server }).server.address() as { port: number }).port;
  return { store, dash, port, tmpDir };
}

async function teardown(ctx: Ctx): Promise<void> {
  await ctx.dash.stop();
  await ctx.store.close();
  await fs.rm(ctx.tmpDir, { recursive: true, force: true });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

type RulesBody = {
  rules: Array<{ id: string; [key: string]: unknown }>;
  count: number;
  thresholds: { allowBelow?: number; blockAtOrAbove?: number } | null;
};

describe('DashboardAPI — GET /policy/rules (T244)', () => {
  let ctx: Ctx;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('1. no policy configured → { rules: [], count: 0, thresholds: null }', async () => {
    ctx = await setup(); // no policy option
    const { status, body } = await get(ctx.port, '/policy/rules');
    expect(status).toBe(200);
    const b = body as RulesBody;
    expect(b.rules).toEqual([]);
    expect(b.count).toBe(0);
    expect(b.thresholds).toBeNull();
  });

  it('2. policy with 2 rules → count=2, rules array has correct rule IDs', async () => {
    const policy: AgentsGatePolicy = {
      rules: [
        { id: 'rule-1', match: { tool: 'shell' }, action: 'block' },
        { id: 'rule-2', match: { tool: 'fs' }, score: 0.5 },
      ],
    };
    ctx = await setup(policy);
    const { status, body } = await get(ctx.port, '/policy/rules');
    expect(status).toBe(200);
    const b = body as RulesBody;
    expect(b.count).toBe(2);
    expect(b.rules).toHaveLength(2);
    const ids = b.rules.map(r => r.id);
    expect(ids).toContain('rule-1');
    expect(ids).toContain('rule-2');
  });

  it('3. policy with thresholds → thresholds object present in response', async () => {
    const policy: AgentsGatePolicy = {
      rules: [
        { id: 'rule-thresh', match: { tool: 'database' }, action: 'block' },
      ],
      thresholds: { allowBelow: 0.2, blockAtOrAbove: 0.8 },
    };
    ctx = await setup(policy);
    const { status, body } = await get(ctx.port, '/policy/rules');
    expect(status).toBe(200);
    const b = body as RulesBody;
    expect(b.thresholds).not.toBeNull();
    expect(b.thresholds!.allowBelow).toBe(0.2);
    expect(b.thresholds!.blockAtOrAbove).toBe(0.8);
  });

  it('4. GET /policy/rules returns status 200', async () => {
    const policy: AgentsGatePolicy = {
      rules: [{ id: 'rule-status', match: { tool: 'any' } }],
    };
    ctx = await setup(policy);
    const { status } = await get(ctx.port, '/policy/rules');
    expect(status).toBe(200);
  });
});
