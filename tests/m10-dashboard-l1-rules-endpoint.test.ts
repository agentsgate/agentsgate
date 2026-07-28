/**
 * T437 — HTTP tests for GET /policy/l1-rules
 *
 * Verifies that the endpoint:
 *   - Returns 200 with { rules: [...] }
 *   - rules array is non-empty
 *   - Each rule has id (string), score (number 0..1), description (string)
 *   - Accessible without an API key (no auth required)
 *   - Accessible with a viewer role API key
 *   - score values are numbers between 0 and 1
 *
 * Port base: 63300
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { afterEach, describe, it, expect } from 'vitest';
import { DashboardAPI } from '../src/modules/m10-dashboard/index.js';
import { StateStore } from '../src/modules/m2-store/index.js';

// Ports come from start(0). A hand-picked base sits inside the OS ephemeral
// range (49152-65535 on macOS), so any concurrent listen(0) can be handed the
// same number and this suite loses the race with EADDRINUSE.

// ── helpers ────────────────────────────────────────────────────────────────────

interface Ctx {
  dash: DashboardAPI;
  port: number;
  store: StateStore;
  tmpDir: string;
}

async function setup(options: Record<string, unknown> = {}): Promise<Ctx> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'as-l1rules-'));
  const store = new StateStore(':memory:');
  await store.initialize();
  let port = 0;const dash = new DashboardAPI(store, options);
  await dash.start(0);
  port = dash.getPort();
  return { dash, port, store, tmpDir };
}

async function teardown(ctx: Ctx): Promise<void> {
  await ctx.dash.stop();
  await ctx.store.close();
  await fs.rm(ctx.tmpDir, { recursive: true, force: true });
}

async function getJSON(
  port: number,
  urlPath: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, { headers });
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
}

// ── tests ──────────────────────────────────────────────────────────────────────

describe('T437 — GET /policy/l1-rules endpoint', () => {
  let ctx: Ctx;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('1. returns HTTP 200', async () => {
    ctx = await setup();
    const { status } = await getJSON(ctx.port, '/policy/l1-rules');
    expect(status).toBe(200);
  });

  it('2. response body has a `rules` array', async () => {
    ctx = await setup();
    const { body } = await getJSON(ctx.port, '/policy/l1-rules');
    expect(body).toHaveProperty('rules');
    expect(Array.isArray(body['rules'])).toBe(true);
  });

  it('3. rules array is non-empty', async () => {
    ctx = await setup();
    const { body } = await getJSON(ctx.port, '/policy/l1-rules');
    const rules = body['rules'] as unknown[];
    expect(rules.length).toBeGreaterThan(0);
  });

  it('4. each rule has id, score, description fields', async () => {
    ctx = await setup();
    const { body } = await getJSON(ctx.port, '/policy/l1-rules');
    const rules = body['rules'] as Record<string, unknown>[];
    for (const rule of rules) {
      expect(rule).toHaveProperty('id');
      expect(rule).toHaveProperty('score');
      expect(rule).toHaveProperty('description');
    }
  });

  it('5. score values are numbers between 0 and 1 inclusive', async () => {
    ctx = await setup();
    const { body } = await getJSON(ctx.port, '/policy/l1-rules');
    const rules = body['rules'] as Record<string, unknown>[];
    for (const rule of rules) {
      const score = rule['score'] as number;
      expect(typeof score).toBe('number');
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });

  it('6. id is a non-empty string for each rule', async () => {
    ctx = await setup();
    const { body } = await getJSON(ctx.port, '/policy/l1-rules');
    const rules = body['rules'] as Record<string, unknown>[];
    for (const rule of rules) {
      expect(typeof rule['id']).toBe('string');
      expect((rule['id'] as string).length).toBeGreaterThan(0);
    }
  });

  it('7. description is a non-empty string for each rule', async () => {
    ctx = await setup();
    const { body } = await getJSON(ctx.port, '/policy/l1-rules');
    const rules = body['rules'] as Record<string, unknown>[];
    for (const rule of rules) {
      expect(typeof rule['description']).toBe('string');
      expect((rule['description'] as string).length).toBeGreaterThan(0);
    }
  });

  it('8. endpoint accessible without an API key when no apiKey is configured', async () => {
    // DashboardAPI with no apiKey — /policy/l1-rules is accessible unauthenticated
    ctx = await setup();
    // No x-api-key header sent — should succeed since no key is configured
    const { status } = await getJSON(ctx.port, '/policy/l1-rules');
    expect(status).toBe(200);
  });

  it('9. endpoint accessible with a viewer role API key', async () => {
    const viewerKey = 'viewer-key-test';
    ctx = await setup({
      apiKey: 'admin-key',
      roles: { [viewerKey]: 'viewer' },
    });
    const { status, body } = await getJSON(ctx.port, '/policy/l1-rules', {
      'x-api-key': viewerKey,
    });
    expect(status).toBe(200);
    expect(Array.isArray((body as Record<string, unknown>)['rules'])).toBe(true);
  });

  it('10. endpoint accessible with admin API key', async () => {
    const adminKey = 'admin-key-test';
    ctx = await setup({ apiKey: adminKey });
    const { status, body } = await getJSON(ctx.port, '/policy/l1-rules', {
      'x-api-key': adminKey,
    });
    expect(status).toBe(200);
    expect(Array.isArray((body as Record<string, unknown>)['rules'])).toBe(true);
  });

  it('11. known rule L1_DELETE_FILE is present in the response', async () => {
    ctx = await setup();
    const { body } = await getJSON(ctx.port, '/policy/l1-rules');
    const rules = body['rules'] as Record<string, unknown>[];
    const ids = rules.map(r => r['id']);
    expect(ids).toContain('L1_DELETE_FILE');
  });

  it('12. known rule L1_GMAIL_SEND is present in the response', async () => {
    ctx = await setup();
    const { body } = await getJSON(ctx.port, '/policy/l1-rules');
    const rules = body['rules'] as Record<string, unknown>[];
    const ids = rules.map(r => r['id']);
    expect(ids).toContain('L1_GMAIL_SEND');
  });

  it('13. known rule L1_SLACK_SEND is present in the response', async () => {
    ctx = await setup();
    const { body } = await getJSON(ctx.port, '/policy/l1-rules');
    const rules = body['rules'] as Record<string, unknown>[];
    const ids = rules.map(r => r['id']);
    expect(ids).toContain('L1_SLACK_SEND');
  });

  it('14. no `matches` function present in any rule object (serializable)', async () => {
    ctx = await setup();
    const { body } = await getJSON(ctx.port, '/policy/l1-rules');
    const rules = body['rules'] as Record<string, unknown>[];
    for (const rule of rules) {
      expect(rule['matches']).toBeUndefined();
    }
  });

  it('15. response is valid JSON with Content-Type application/json', async () => {
    ctx = await setup();
    const res = await fetch(`http://127.0.0.1:${ctx.port}/policy/l1-rules`);
    expect(res.status).toBe(200);
    const ct = res.headers.get('content-type') ?? '';
    expect(ct).toMatch(/application\/json/);
  });

  it('16. repeated calls return the same number of rules (stable snapshot)', async () => {
    ctx = await setup();
    const { body: body1 } = await getJSON(ctx.port, '/policy/l1-rules');
    const { body: body2 } = await getJSON(ctx.port, '/policy/l1-rules');
    const rules1 = body1['rules'] as unknown[];
    const rules2 = body2['rules'] as unknown[];
    expect(rules1.length).toBe(rules2.length);
  });
});
