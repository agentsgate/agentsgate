/**
 * Dashboard authentication and DNS rebinding defences.
 *
 * Both of these guard the same asset: the operation log holds full tool
 * arguments and results, which routinely contain file contents, database rows
 * and credentials. Reaching it without a key is a disclosure of everything the
 * monitored agent touched.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { DashboardAPI } from '../../src/modules/m10-dashboard/index.js';
import { StateStore } from '../../src/modules/m2-store/index.js';
import { OperationLogger } from '../../src/modules/m3-logger/index.js';

/**
 * Raw request with an arbitrary Host header.
 *
 * fetch() cannot do this: Host is a forbidden header name, so undici silently
 * replaces it with the connected authority — which is exactly the header an
 * attacker's browser would *not* be sending.
 */
function rawRequest(
  port: number,
  host: string,
  path = '/operations',
  method = 'GET',
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method, headers: { Host: host } },
      res => {
        let body = '';
        res.on('data', c => { body += String(c); });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function seeded(): Promise<{ store: StateStore }> {
  const store = new StateStore(':memory:');
  await store.initialize();
  const logger = new OperationLogger(store);
  await logger.log(
    {
      id: 'op-1', agentId: 'agent-a', tool: 'filesystem', method: 'read_file',
      params: { path: '/tmp/x' }, timestamp: new Date(), sessionId: 's',
    },
    { action: 'allow', riskScore: 0.1, reasons: [] },
  );
  return { store };
}

// ── RBAC key lookup ──────────────────────────────────────────────────────────

describe('RBAC key lookup cannot reach Object.prototype', () => {
  let store: StateStore;
  let dash: DashboardAPI;
  let port: number;

  beforeAll(async () => {
    ({ store } = await seeded());
    dash = new DashboardAPI(store, { roles: { 'viewer-key': 'viewer', 'admin-key': 'admin' } });
    await dash.start(0);
    port = dash.getPort();
  });

  afterAll(async () => { await dash.stop(); await store.close(); });

  const get = (key: string) =>
    fetch(`http://127.0.0.1:${port}/operations`, { headers: { 'X-API-Key': key } });

  it('accepts a configured key', async () => {
    expect((await get('viewer-key')).status).toBe(200);
  });

  it('rejects an unknown key', async () => {
    expect((await get('nope')).status).toBe(401);
  });

  it('rejects an empty key', async () => {
    expect((await fetch(`http://127.0.0.1:${port}/operations`)).status).toBe(401);
  });

  // Each of these used to return a truthy value from a plain-object index and
  // pass the "is this a known key" check, granting read access with no key.
  for (const payload of [
    'constructor', 'toString', 'valueOf', 'hasOwnProperty',
    '__proto__', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString',
  ]) {
    it(`rejects the prototype member "${payload}"`, async () => {
      const res = await get(payload);
      expect(res.status).toBe(401);
      // And nothing leaked in the body.
      expect(await res.text()).not.toContain('agent-a');
    });
  }

  it('still enforces role separation for real keys', async () => {
    const asViewer = await fetch(`http://127.0.0.1:${port}/rollback/does-not-exist`, {
      method: 'POST', headers: { 'X-API-Key': 'viewer-key' },
    });
    expect(asViewer.status).toBe(403);
  });

  it('treats a literal "__proto__" entry as an ordinary key, not a prototype write', async () => {
    const s2 = await seeded();
    const d2 = new DashboardAPI(s2.store, {
      roles: JSON.parse('{"__proto__":"admin","real":"viewer"}') as Record<string, 'admin' | 'viewer'>,
    });
    await d2.start(0);
    try {
      const p = d2.getPort();
      // The literal key works...
      expect((await fetch(`http://127.0.0.1:${p}/operations`, { headers: { 'X-API-Key': '__proto__' } })).status).toBe(200);
      // ...and has not become a role for everyone else.
      expect((await fetch(`http://127.0.0.1:${p}/operations`, { headers: { 'X-API-Key': 'constructor' } })).status).toBe(401);
      expect(({} as Record<string, unknown>)['real']).toBeUndefined();
    } finally {
      await d2.stop();
      await s2.store.close();
    }
  });
});

// ── DNS rebinding ────────────────────────────────────────────────────────────

describe('Host header allowlist', () => {
  let store: StateStore;
  let dash: DashboardAPI;
  let port: number;

  beforeAll(async () => {
    ({ store } = await seeded());
    // No apiKey and no roles — the default deployment, where an accepted
    // request is treated as admin.
    dash = new DashboardAPI(store, {});
    await dash.start(0);
    port = dash.getPort();
  });

  afterAll(async () => { await dash.stop(); await store.close(); });

  const withHost = (host: string, path = '/operations') => rawRequest(port, host, path);

  it('accepts the loopback address it is bound to', async () => {
    expect((await withHost(`127.0.0.1:${port}`)).status).toBe(200);
  });

  it('accepts localhost', async () => {
    expect((await withHost(`localhost:${port}`)).status).toBe(200);
  });

  it('accepts a bracketed IPv6 loopback', async () => {
    expect((await withHost(`[::1]:${port}`)).status).toBe(200);
  });

  it('accepts a host with no port', async () => {
    expect((await withHost('localhost')).status).toBe(200);
  });

  it('refuses an attacker-controlled hostname resolving to loopback', async () => {
    const res = await withHost(`rebind.attacker.example:${port}`);
    expect(res.status).toBe(403);
    expect(res.body).not.toContain('agent-a');
  });

  it('refuses rebinding on the admin surface too, not just reads', async () => {
    const res = await rawRequest(port, 'rebind.attacker.example', '/rollback/x', 'POST');
    expect(res.status).toBe(403);
  });

  it('refuses a hostname that merely contains an allowed one', async () => {
    expect((await withHost('localhost.attacker.example')).status).toBe(403);
    expect((await withHost('notlocalhost')).status).toBe(403);
  });

  it('still serves /health, which is the liveness probe', async () => {
    expect((await withHost(`127.0.0.1:${port}`, '/health')).status).toBe(200);
  });

  it('refuses a bad host on /health as well — the check precedes routing', async () => {
    expect((await withHost('rebind.attacker.example', '/health')).status).toBe(403);
  });
});

describe('Host header allowlist — explicit configuration', () => {
  it('accepts the names an operator lists, and no others', async () => {
    const { store } = await seeded();
    const dash = new DashboardAPI(store, { allowedHosts: ['agentsgate.internal'] });
    await dash.start(0);
    try {
      const port = dash.getPort();
      const call = (host: string) => rawRequest(port, host);

      expect((await call('agentsgate.internal')).status).toBe(200);
      expect((await call('AGENTSGATE.INTERNAL')).status).toBe(200);   // case-insensitive
      // An explicit list replaces the defaults rather than extending them.
      expect((await call('localhost')).status).toBe(403);
    } finally {
      await dash.stop();
      await store.close();
    }
  });
});
