/**
 * T130 — Dashboard API key authentication.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { DashboardAPI } from '../../src/modules/m10-dashboard/index.js';
import { StateStore } from '../../src/modules/m2-store/index.js';

let store: StateStore;
let api: DashboardAPI;
let port: number;

async function req(path: string, opts: { key?: string; method?: string } = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (opts.key) headers['x-api-key'] = opts.key;
    const r = http.request({ hostname: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers }, res => {
      let body = '';
      res.on('data', (c: Buffer) => { body += c.toString(); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    r.on('error', reject);
    r.end();
  });
}

beforeEach(async () => {
  store = new StateStore(':memory:');
  await store.initialize();
});

afterEach(async () => {
  await api.stop();
  await store.close();
});

describe('DashboardAPI — no apiKey configured', () => {
  beforeEach(async () => {
    api = new DashboardAPI(store);
    await api.start(0);
    const addr = (api as unknown as { server: http.Server }).server.address() as { port: number };
    port = addr.port;
  });

  it('allows all requests without any key', async () => {
    const { status } = await req('/health');
    expect(status).toBe(200);
    const { status: s2 } = await req('/operations');
    expect(s2).toBe(200);
  });
});

describe('DashboardAPI — apiKey configured', () => {
  const KEY = 'test-secret-key-abc';

  beforeEach(async () => {
    api = new DashboardAPI(store, { apiKey: KEY });
    await api.start(0);
    const addr = (api as unknown as { server: http.Server }).server.address() as { port: number };
    port = addr.port;
  });

  it('GET /health is always public (no key required)', async () => {
    const { status } = await req('/health');
    expect(status).toBe(200);
  });

  it('rejects requests without API key with 401', async () => {
    const { status, body } = await req('/operations');
    expect(status).toBe(401);
    expect(body).toContain('Unauthorized');
  });

  it('rejects requests with wrong API key', async () => {
    const { status } = await req('/operations', { key: 'wrong-key' });
    expect(status).toBe(401);
  });

  it('accepts requests with correct X-API-Key header', async () => {
    const { status } = await req('/operations', { key: KEY });
    expect(status).toBe(200);
  });

  it('rejects correct key supplied via ?apiKey= query param (header-only for security)', async () => {
    // Query-param auth was removed: keys in URLs end up in server logs, browser
    // history, and Referer headers. The only accepted method is X-API-Key header.
    const { status } = await req(`/operations?apiKey=${KEY}`);
    expect(status).toBe(401);
  });

  it('protects POST routes too', async () => {
    const { status } = await req('/approvals/nonexistent/approve', { method: 'POST' });
    expect(status).toBe(401);
  });

  it('does NOT expose key mismatch detail in error body', async () => {
    const { body } = await req('/operations', { key: 'bad' });
    expect(body).not.toContain(KEY);
  });
});
