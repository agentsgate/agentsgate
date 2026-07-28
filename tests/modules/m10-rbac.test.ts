/**
 * T415 — DashboardAPI RBAC role-based access control tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { DashboardAPI } from '../../src/modules/m10-dashboard/index.js';
import { StateStore } from '../../src/modules/m2-store/index.js';

let store: StateStore;
let api: DashboardAPI;
let port: number;

async function req(
  path: string,
  opts: { key?: string; method?: string } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (opts.key) headers['x-api-key'] = opts.key;
    const r = http.request(
      { hostname: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers },
      res => {
        let body = '';
        res.on('data', (c: Buffer) => { body += c.toString(); });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    r.on('error', reject);
    r.end();
  });
}

// ── RBAC mode (roles map configured) ────────────────────────────────────────

describe('DashboardAPI — RBAC roles map', () => {
  beforeEach(async () => {
    store = new StateStore(':memory:');
    await store.initialize();
    api = new DashboardAPI(store, {
      roles: {
        'viewer-key': 'viewer',
        'approver-key': 'approver',
        'admin-key': 'admin',
      },
    });
    await api.start(0);
    const addr = (api as unknown as { server: http.Server }).server.address() as { port: number };
    port = addr.port;
  });

  afterEach(async () => {
    await api.stop();
    await store.close();
  });

  // Test 1
  it('viewer key can GET /operations (200)', async () => {
    const { status } = await req('/operations', { key: 'viewer-key' });
    expect(status).toBe(200);
  });

  // Test 2
  it('viewer key cannot POST /approvals/:id/approve — 403 with approver role message', async () => {
    const { status, body } = await req('/approvals/some-id/approve', {
      key: 'viewer-key',
      method: 'POST',
    });
    expect(status).toBe(403);
    expect(body).toContain('approver role required');
  });

  // Test 3
  it('viewer key cannot POST /rollback/:id — 403 with admin role message', async () => {
    const { status, body } = await req('/rollback/some-id', {
      key: 'viewer-key',
      method: 'POST',
    });
    expect(status).toBe(403);
    expect(body).toContain('admin role required');
  });

  // Test 4
  it('viewer key cannot POST /sessions/:id/expire — 403', async () => {
    const { status } = await req('/sessions/some-session/expire', {
      key: 'viewer-key',
      method: 'POST',
    });
    expect(status).toBe(403);
  });

  // Test 5
  it('approver key can POST /approvals/:id/approve (no pending → non-403)', async () => {
    const { status } = await req('/approvals/nonexistent/approve', {
      key: 'approver-key',
      method: 'POST',
    });
    // RBAC check passes; business-logic may return 404/200/etc but NOT 403
    expect(status).not.toBe(403);
    expect(status).not.toBe(401);
  });

  // Test 6
  it('approver key cannot POST /rollback/:id — 403', async () => {
    const { status, body } = await req('/rollback/some-id', {
      key: 'approver-key',
      method: 'POST',
    });
    expect(status).toBe(403);
    expect(body).toContain('admin role required');
  });

  // Test 7
  it('admin key can POST /rollback/:id — passes RBAC (503 with no engine, not 403)', async () => {
    const { status } = await req('/rollback/some-id', {
      key: 'admin-key',
      method: 'POST',
    });
    // Admin passes auth; no rollback engine configured → 503 or 404, never 403
    expect(status).not.toBe(403);
    expect(status).not.toBe(401);
  });

  // Test 8
  it('unknown API key returns 401 when roles map is set', async () => {
    const { status, body } = await req('/operations', { key: 'unknown-key' });
    expect(status).toBe(401);
    expect(body).toContain('Unauthorized');
  });

  // Test 11
  it('admin key can GET /operations (viewer-level read access still works)', async () => {
    const { status } = await req('/operations', { key: 'admin-key' });
    expect(status).toBe(200);
  });

  // Additional: missing key returns 401
  it('request with no key returns 401 when roles map is configured', async () => {
    const { status } = await req('/operations');
    expect(status).toBe(401);
  });

  // Additional: approver key cannot POST /sessions/:id/expire — 403
  it('approver key cannot POST /sessions/:id/expire — 403', async () => {
    const { status } = await req('/sessions/some-session/expire', {
      key: 'approver-key',
      method: 'POST',
    });
    expect(status).toBe(403);
  });

  // Additional: admin key can POST /sessions/:id/expire — passes RBAC
  it('admin key can POST /sessions/:id/expire — passes RBAC (not 403/401)', async () => {
    const { status } = await req('/sessions/some-session/expire', {
      key: 'admin-key',
      method: 'POST',
    });
    expect(status).not.toBe(403);
    expect(status).not.toBe(401);
  });

  // Additional: GET /health is always public even in RBAC mode
  it('GET /health is public — no key required even in RBAC mode', async () => {
    const { status } = await req('/health');
    expect(status).toBe(200);
  });
});

// ── Legacy single-key mode (no roles map) ────────────────────────────────────

describe('DashboardAPI — legacy apiKey (no roles map)', () => {
  const LEGACY_KEY = 'legacy-secret-xyz';

  beforeEach(async () => {
    store = new StateStore(':memory:');
    await store.initialize();
    api = new DashboardAPI(store, { apiKey: LEGACY_KEY });
    await api.start(0);
    const addr = (api as unknown as { server: http.Server }).server.address() as { port: number };
    port = addr.port;
  });

  afterEach(async () => {
    await api.stop();
    await store.close();
  });

  // Test 9a
  it('wrong key returns 401', async () => {
    const { status } = await req('/operations', { key: 'wrong-key' });
    expect(status).toBe(401);
  });

  // Test 9b
  it('correct key returns 200', async () => {
    const { status } = await req('/operations', { key: LEGACY_KEY });
    expect(status).toBe(200);
  });
});

// ── No auth config ────────────────────────────────────────────────────────────

describe('DashboardAPI — no auth config', () => {
  beforeEach(async () => {
    store = new StateStore(':memory:');
    await store.initialize();
    api = new DashboardAPI(store);
    await api.start(0);
    const addr = (api as unknown as { server: http.Server }).server.address() as { port: number };
    port = addr.port;
  });

  afterEach(async () => {
    await api.stop();
    await store.close();
  });

  // Test 10
  it('all requests allowed without any key — GET /health and GET /operations return 200', async () => {
    const { status: s1 } = await req('/health');
    expect(s1).toBe(200);
    const { status: s2 } = await req('/operations');
    expect(s2).toBe(200);
  });

  it('POST /rollback/:id allowed without any key (no auth, no rollback engine → non-401/403)', async () => {
    const { status } = await req('/rollback/any-id', { method: 'POST' });
    expect(status).not.toBe(401);
    expect(status).not.toBe(403);
  });
});
