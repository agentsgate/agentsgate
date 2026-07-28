/**
 * T436 — HTTP integration tests for the 4 new REST endpoints on DashboardAPI
 *
 * Tests:
 *   POST   /policy/rules          — create rule (201), duplicate (409)
 *   PUT    /policy/rules/:id      — update rule (200), unknown id (404)
 *   DELETE /policy/rules/:id      — delete rule (204), unknown id (404)
 *   POST   /policy/rules/test     — matched:true / matched:false, no auth required
 *   Auth   admin vs viewer role   — write ops require admin (403 for viewer)
 *   GET    /policy/rules          — backward compat after CRUD ops
 *
 * Port range: 59000+
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it, expect, beforeEach } from 'vitest';
import { DashboardAPI } from '../src/modules/m10-dashboard/index.js';
import { StateStore } from '../src/modules/m2-store/index.js';
import type { AgentsGatePolicy, PolicyRule } from '../src/policy.js';

// Ports come from `start(0)` — never a fixed counter. A hand-picked base like
// 59000 sits inside the OS ephemeral range (49152-65535 on macOS), so a
// `listen(0)` in any concurrently running suite can be handed the same number
// and this file loses the race with EADDRINUSE.

// ── helpers ────────────────────────────────────────────────────────────────────

interface Ctx {
  dash: DashboardAPI;
  port: number;
  store: StateStore;
  policyPath: string;
  tmpDir: string;
  policy: AgentsGatePolicy;
}

async function setup(initialRules: PolicyRule[] = []): Promise<Ctx> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'as-t436-'));
  const policyPath = path.join(tmpDir, 'policy.json');
  const policy: AgentsGatePolicy = { rules: [...initialRules] };
  await fs.writeFile(policyPath, JSON.stringify(policy, null, 2));

  const store = new StateStore(path.join(tmpDir, 'test.db'));
  await store.initialize();

  const dash = new DashboardAPI(store, {
    policy,
    policyPath,
    roles: { 'admin-key': 'admin', 'viewer-key': 'viewer' },
  });
  await dash.start(0);
  return { dash, port: dash.getPort(), store, policyPath, tmpDir, policy };
}

async function teardown(ctx: Ctx): Promise<void> {
  await ctx.dash.stop();
  await ctx.store.close();
  await fs.rm(ctx.tmpDir, { recursive: true, force: true });
}

async function req(
  port: number,
  method: string,
  pathname: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: unknown }> {
  const init: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, init);
  let responseBody: unknown;
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    responseBody = await res.json();
  } else if (res.status === 204) {
    responseBody = null;
  } else {
    responseBody = await res.text();
  }
  return { status: res.status, body: responseBody };
}

function adminReq(port: number, method: string, pathname: string, body?: unknown) {
  return req(port, method, pathname, body, { 'X-API-Key': 'admin-key' });
}

function viewerReq(port: number, method: string, pathname: string, body?: unknown) {
  return req(port, method, pathname, body, { 'X-API-Key': 'viewer-key' });
}

const sampleRule: PolicyRule = {
  id: 'BLOCK_PROD_DB',
  description: 'Block prod DB deletes',
  match: { tool: 'database', method: '/delete|drop/i' },
  action: 'block',
};

// ── POST /policy/rules ─────────────────────────────────────────────────────────

describe('T436 — POST /policy/rules', () => {
  let ctx: Ctx;

  beforeEach(async () => { ctx = await setup(); });
  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('1. POST /policy/rules creates a new rule and returns 201', async () => {
    const { status, body } = await adminReq(ctx.port, 'POST', '/policy/rules', sampleRule);
    expect(status).toBe(201);
    const b = body as Record<string, unknown>;
    expect(b['id']).toBe('BLOCK_PROD_DB');
    expect(b['action']).toBe('block');
  });

  it('2. POST /policy/rules persists the rule to the policy file', async () => {
    await adminReq(ctx.port, 'POST', '/policy/rules', sampleRule);
    // Small delay to allow async write
    await new Promise(r => setTimeout(r, 50));
    const saved = JSON.parse(await fs.readFile(ctx.policyPath, 'utf-8')) as AgentsGatePolicy;
    expect(saved.rules.some(r => r.id === 'BLOCK_PROD_DB')).toBe(true);
  });

  it('3. POST /policy/rules returns 409 if rule id already exists', async () => {
    await adminReq(ctx.port, 'POST', '/policy/rules', sampleRule);
    const { status, body } = await adminReq(ctx.port, 'POST', '/policy/rules', sampleRule);
    expect(status).toBe(409);
    const b = body as Record<string, unknown>;
    expect(typeof b['error']).toBe('string');
  });

  it('4. POST /policy/rules returns 400 if rule id is missing', async () => {
    const { status } = await adminReq(ctx.port, 'POST', '/policy/rules', { match: {} });
    expect(status).toBe(400);
  });

  it('5. POST /policy/rules returns 403 for viewer role', async () => {
    const { status } = await viewerReq(ctx.port, 'POST', '/policy/rules', sampleRule);
    expect(status).toBe(403);
  });
});

// ── PUT /policy/rules/:id ──────────────────────────────────────────────────────

describe('T436 — PUT /policy/rules/:id', () => {
  let ctx: Ctx;

  beforeEach(async () => { ctx = await setup([sampleRule]); });
  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('6. PUT /policy/rules/:id updates an existing rule and returns 200', async () => {
    const updated = { ...sampleRule, description: 'Updated description', action: 'require_approval' as const };
    const { status, body } = await adminReq(ctx.port, 'PUT', `/policy/rules/${sampleRule.id}`, updated);
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['description']).toBe('Updated description');
    expect(b['action']).toBe('require_approval');
    // id must remain the same
    expect(b['id']).toBe(sampleRule.id);
  });

  it('7. PUT /policy/rules/:id returns 404 for unknown id', async () => {
    const { status } = await adminReq(ctx.port, 'PUT', '/policy/rules/NONEXISTENT', sampleRule);
    expect(status).toBe(404);
  });

  it('8. PUT /policy/rules/:id persists the update to disk', async () => {
    const updated = { ...sampleRule, description: 'Persisted update' };
    await adminReq(ctx.port, 'PUT', `/policy/rules/${sampleRule.id}`, updated);
    await new Promise(r => setTimeout(r, 50));
    const saved = JSON.parse(await fs.readFile(ctx.policyPath, 'utf-8')) as AgentsGatePolicy;
    const savedRule = saved.rules.find(r => r.id === sampleRule.id);
    expect(savedRule?.description).toBe('Persisted update');
  });

  it('9. PUT /policy/rules/:id returns 403 for viewer role', async () => {
    const { status } = await viewerReq(ctx.port, 'PUT', `/policy/rules/${sampleRule.id}`, sampleRule);
    expect(status).toBe(403);
  });
});

// ── DELETE /policy/rules/:id ───────────────────────────────────────────────────

describe('T436 — DELETE /policy/rules/:id', () => {
  let ctx: Ctx;

  beforeEach(async () => { ctx = await setup([sampleRule]); });
  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('10. DELETE /policy/rules/:id removes the rule and returns 204', async () => {
    const { status } = await adminReq(ctx.port, 'DELETE', `/policy/rules/${sampleRule.id}`);
    expect(status).toBe(204);
  });

  it('11. DELETE /policy/rules/:id removes rule from in-memory policy (GET confirms removal)', async () => {
    await adminReq(ctx.port, 'DELETE', `/policy/rules/${sampleRule.id}`);
    const { status, body } = await adminReq(ctx.port, 'GET', '/policy/rules');
    expect(status).toBe(200);
    const b = body as { rules: PolicyRule[] };
    expect(b.rules.some(r => r.id === sampleRule.id)).toBe(false);
  });

  it('12. DELETE /policy/rules/:id returns 404 for unknown id', async () => {
    const { status } = await adminReq(ctx.port, 'DELETE', '/policy/rules/NONEXISTENT');
    expect(status).toBe(404);
  });

  it('13. DELETE /policy/rules/:id returns 403 for viewer role', async () => {
    const { status } = await viewerReq(ctx.port, 'DELETE', `/policy/rules/${sampleRule.id}`);
    expect(status).toBe(403);
  });
});

// ── POST /policy/rules/test ────────────────────────────────────────────────────
// NOTE: /policy/rules/test requires no admin role, but in RBAC mode a valid API
// key is still required for all non-health endpoints. Tests 14-19 use admin key.
// Test 16 ("no auth required") verifies behavior in non-RBAC mode (no roles set).

describe('T436 — POST /policy/rules/test', () => {
  let ctx: Ctx;
  // Separate no-RBAC context for the "no auth" test
  let ctxNoAuth: Ctx;

  beforeEach(async () => {
    ctx = await setup();
    // No-auth setup: neither roles nor apiKey set → all requests pass auth gate
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'as-t436-noauth-'));
    const policyPath = path.join(tmpDir, 'policy.json');
    const policy: AgentsGatePolicy = { rules: [] };
    await fs.writeFile(policyPath, JSON.stringify(policy, null, 2));
    const store = new StateStore(path.join(tmpDir, 'test.db'));
    await store.initialize();
    const dash = new DashboardAPI(store, { policy, policyPath });
    await dash.start(0);
    ctxNoAuth = { dash, port: dash.getPort(), store, policyPath, tmpDir, policy };
  });

  afterEach(async () => {
    if (ctx) await teardown(ctx);
    if (ctxNoAuth) await teardown(ctxNoAuth);
  });

  it('14. POST /policy/rules/test returns matched:true when rule matches operation', async () => {
    const rule: PolicyRule = {
      id: 'TEST_RULE',
      match: { tool: 'slack', method: 'send_message' },
      score: 0.8,
    };
    const { status, body } = await adminReq(ctx.port, 'POST', '/policy/rules/test', {
      rule,
      operation: { tool: 'slack', method: 'send_message', agentId: 'agent-1', params: {} },
    });
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['matched']).toBe(true);
  });

  it('15. POST /policy/rules/test returns matched:false when rule does not match operation', async () => {
    const rule: PolicyRule = {
      id: 'TEST_RULE',
      match: { tool: 'slack', method: 'send_message' },
      score: 0.8,
    };
    const { status, body } = await adminReq(ctx.port, 'POST', '/policy/rules/test', {
      rule,
      operation: { tool: 'email', method: 'send', agentId: 'agent-1', params: {} },
    });
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['matched']).toBe(false);
  });

  it('16. POST /policy/rules/test works without any auth when no RBAC is configured', async () => {
    // In non-RBAC mode (no roles, no apiKey), /policy/rules/test requires no key.
    const rule: PolicyRule = {
      id: 'NO_AUTH_RULE',
      match: { tool: 'any-tool' },
    };
    const res = await fetch(`http://127.0.0.1:${ctxNoAuth.port}/policy/rules/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rule,
        operation: { tool: 'any-tool', method: 'call', agentId: 'anon', params: {} },
      }),
    });
    expect(res.status).toBe(200);
  });

  it('17. POST /policy/rules/test returns score and action when rule has them', async () => {
    const rule: PolicyRule = {
      id: 'SCORE_ACTION_RULE',
      match: { tool: 'db' },
      score: 0.9,
      action: 'block',
    };
    const { status, body } = await adminReq(ctx.port, 'POST', '/policy/rules/test', {
      rule,
      operation: { tool: 'db', method: 'delete', agentId: 'agent-x', params: {} },
    });
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['matched']).toBe(true);
    expect(b['score']).toBe(0.9);
    expect(b['action']).toBe('block');
  });

  it('18. POST /policy/rules/test includes reasons array in response', async () => {
    const rule: PolicyRule = {
      id: 'REASONS_RULE',
      match: { tool: 'fs' },
    };
    const { status, body } = await adminReq(ctx.port, 'POST', '/policy/rules/test', {
      rule,
      operation: { tool: 'fs', method: 'read', agentId: 'agent-1', params: {} },
    });
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(Array.isArray(b['reasons'])).toBe(true);
  });

  it('19. POST /policy/rules/test with paramsMatch — matched:true when params match', async () => {
    const rule: PolicyRule = {
      id: 'PARAMS_MATCH_RULE',
      match: { tool: 'slack', paramsMatch: { channel: '/^D[A-Z0-9]+/' } },
      score: 0.7,
    };
    const { status, body } = await adminReq(ctx.port, 'POST', '/policy/rules/test', {
      rule,
      operation: { tool: 'slack', method: 'send_message', agentId: 'agent-1', params: { channel: 'DABC123' } },
    });
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['matched']).toBe(true);
  });

  it('20. POST /policy/rules/test returns 400 when body is missing operation field', async () => {
    const { status } = await adminReq(ctx.port, 'POST', '/policy/rules/test', { rule: sampleRule });
    expect(status).toBe(400);
  });
});

// ── GET /policy/rules — backward compatibility ─────────────────────────────────

describe('T436 — GET /policy/rules backward compatibility', () => {
  let ctx: Ctx;

  beforeEach(async () => { ctx = await setup([sampleRule]); });
  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('21. GET /policy/rules returns initial rules', async () => {
    const { status, body } = await adminReq(ctx.port, 'GET', '/policy/rules');
    expect(status).toBe(200);
    const b = body as { rules: PolicyRule[]; count: number };
    expect(b.rules.length).toBeGreaterThan(0);
    expect(b.rules.some(r => r.id === sampleRule.id)).toBe(true);
    expect(b.count).toBeGreaterThan(0);
  });

  it('22. GET /policy/rules reflects added rule after POST', async () => {
    const newRule: PolicyRule = {
      id: 'NEW_RULE',
      match: { tool: 'filesystem' },
      action: 'allow',
    };
    await adminReq(ctx.port, 'POST', '/policy/rules', newRule);
    const { status, body } = await adminReq(ctx.port, 'GET', '/policy/rules');
    expect(status).toBe(200);
    const b = body as { rules: PolicyRule[] };
    expect(b.rules.some(r => r.id === 'NEW_RULE')).toBe(true);
  });

  it('23. GET /policy/rules reflects updated rule after PUT', async () => {
    await adminReq(ctx.port, 'PUT', `/policy/rules/${sampleRule.id}`, { ...sampleRule, description: 'Updated' });
    const { body } = await adminReq(ctx.port, 'GET', '/policy/rules');
    const b = body as { rules: PolicyRule[] };
    const found = b.rules.find(r => r.id === sampleRule.id);
    expect(found?.description).toBe('Updated');
  });

  it('24. GET /policy/rules reflects deletion after DELETE', async () => {
    await adminReq(ctx.port, 'DELETE', `/policy/rules/${sampleRule.id}`);
    const { body } = await adminReq(ctx.port, 'GET', '/policy/rules');
    const b = body as { rules: PolicyRule[] };
    expect(b.rules.some(r => r.id === sampleRule.id)).toBe(false);
  });

  it('25. GET /policy/rules returns viewer-accessible (no special role needed)', async () => {
    const { status } = await viewerReq(ctx.port, 'GET', '/policy/rules');
    expect(status).toBe(200);
  });
});
