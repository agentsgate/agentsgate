import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { StateStore } from '../../src/modules/m2-store/index.js';
import { DashboardAPI } from '../../src/modules/m10-dashboard/index.js';
import { AGENTSGATE_VERSION } from '../../src/version.js';

async function dashGet(port: number, p: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: p }, res => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString())));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

describe('DashboardAPI /health (enhanced)', () => {
  let store: StateStore;
  let dashboard: DashboardAPI;
  let port: number;

  beforeEach(async () => {
    store = new StateStore(':memory:');
    await store.initialize();
    dashboard = new DashboardAPI(store);
    await dashboard.start(0);
    port = ((dashboard as unknown as { server: http.Server }).server.address() as { port: number }).port;
  });

  afterEach(async () => {
    await dashboard.stop();
    await store.close();
  });

  it('returns status ok with uptime, version, and db stats', async () => {
    const health = await dashGet(port, '/health') as {
      status: string;
      version: string;
      uptimeMs: number;
      startedAt: string;
      db: { operationLogs: number; checkpoints: number; pendingApprovals: number; outcomeRecords: number };
      pendingApprovals: number;
    };

    expect(health.status).toBe('ok');
    // Compared against the constant, not a literal: this assertion previously
    // pinned 0.4.0 and kept passing while the CLI reported 0.5.0.
    expect(health.version).toBe(AGENTSGATE_VERSION);
    expect(health.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(health.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(health.db.operationLogs).toBe(0);
    expect(health.db.checkpoints).toBe(0);
    expect(health.pendingApprovals).toBe(0);
  });

  it('db.operationLogs reflects actual records', async () => {
    const { randomUUID } = await import('node:crypto');
    await store.saveOperationLog({
      operationId: randomUUID(),
      operation: {
        id: randomUUID(), agentId: 'a', tool: 'fs', method: 'read',
        params: {}, timestamp: new Date(), sessionId: 's1',
      },
      decision: { action: 'allow', riskScore: 0.1, reasons: [] },
      createdAt: new Date(),
    });

    const health = await dashGet(port, '/health') as { db: { operationLogs: number } };
    expect(health.db.operationLogs).toBe(1);
  });
});
