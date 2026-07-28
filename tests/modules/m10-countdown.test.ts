/**
 * T121 — Dashboard approval countdown timer + auto-expire UX.
 * Verifies that /approvals/pending includes expiresAt and that the
 * dashboard HTML contains the countdown markup.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { DashboardAPI, ApprovalQueue } from '../../src/modules/m10-dashboard/index.js';
import { StateStore } from '../../src/modules/m2-store/index.js';
import type { MCPOperation } from '../../src/types/interfaces.js';

async function get(port: number, path: string): Promise<{ status: number; body: unknown; text?: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path }, res => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        const ct = res.headers['content-type'] ?? '';
        if (ct.includes('text/html')) {
          resolve({ status: res.statusCode ?? 0, body: {}, text: raw });
        } else {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) });
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

function makeOp(id: string): MCPOperation {
  return {
    id, agentId: 'agent-1', tool: 'filesystem', method: 'write_file',
    params: { path: '/tmp/x.txt' }, timestamp: new Date(), sessionId: 'sess-1',
  };
}

describe('Dashboard approval countdown API', () => {
  let store: StateStore;
  let queue: ApprovalQueue;
  let api: DashboardAPI;
  let port: number;

  beforeEach(async () => {
    store = new StateStore(':memory:');
    await store.initialize();
    queue = new ApprovalQueue({ maxAgeMs: 60_000 }); // 1-minute TTL
    api   = new DashboardAPI(store, { queue });
    await api.start(0);
    const addr = (api as unknown as { server: http.Server }).server.address() as { port: number };
    port = addr.port;
  });

  afterEach(async () => {
    await api.stop();
    await store.close();
  });

  it('/approvals/pending includes expiresAt for each item', async () => {
    queue.enqueue(makeOp('op-1'), 0.8);

    const { status, body } = await get(port, '/approvals/pending');
    expect(status).toBe(200);
    const resp = body as { data: Array<{ id: string; expiresAt: string }>; ttlMs: number };
    expect(resp.data).toHaveLength(1);
    expect(resp.data[0].expiresAt).toBeDefined();

    // expiresAt should be ~1 minute in the future
    const expMs = new Date(resp.data[0].expiresAt).getTime() - Date.now();
    expect(expMs).toBeGreaterThan(55_000);
    expect(expMs).toBeLessThan(65_000);

    // ttlMs is returned at the response level
    expect(resp.ttlMs).toBe(60_000);
  });

  it('/approvals/pending returns ttlMs = 24h default when no custom maxAgeMs', async () => {
    const defaultQueue = new ApprovalQueue(); // uses 24h default
    const defaultApi   = new DashboardAPI(store, { queue: defaultQueue });
    await defaultApi.start(0);
    const addr2 = (defaultApi as unknown as { server: http.Server }).server.address() as { port: number };

    try {
      const { body } = await get(addr2.port, '/approvals/pending');
      const resp = body as { ttlMs: number };
      expect(resp.ttlMs).toBe(86_400_000);
    } finally {
      await defaultApi.stop();
    }
  });

  it('dashboard HTML contains countdown markup', async () => {
    const { status, text } = await get(port, '/');
    expect(status).toBe(200);
    expect(text).toContain('countdown');
    expect(text).toContain('data-expires');
    expect(text).toContain('fmtCountdown');
    expect(text).toContain('startCountdownTick');
    expect(text).toContain('Expires');
  });
});
