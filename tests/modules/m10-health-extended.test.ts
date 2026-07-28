/**
 * T223 — Extended GET /health response
 * Ports 51600–51699
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { StateStore } from '../../src/modules/m2-store/index.js';
import { DashboardAPI } from '../../src/modules/m10-dashboard/index.js';
import { AgentCircuitBreaker } from '../../src/utils/circuit-breaker.js';

// Ports come from start(0). A hand-picked base sits inside the OS ephemeral
// range (49152-65535), so a concurrent listen(0) can be handed the same number
// and this suite loses the race with EADDRINUSE.

async function startDash(options?: { circuitBreaker?: AgentCircuitBreaker }): Promise<{
  store: StateStore;
  dashboard: DashboardAPI;
  port: number;
}> {
  const store = new StateStore(':memory:');
  await store.initialize();
  const dashboard = new DashboardAPI(store, options ?? {});
  await dashboard.start(0);
  const port = dashboard.getPort();
  return { store, dashboard, port };
}

async function getJson(port: number, path: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path }, res => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString())));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

function makeLog(id = randomUUID()) {
  return {
    operationId: id,
    operation: {
      id,
      agentId: 'agent-test',
      tool: 'filesystem',
      method: 'read_file',
      params: {},
      timestamp: new Date(),
      sessionId: 'sess-1',
    },
    decision: { action: 'allow' as const, riskScore: 0.1, reasons: [] },
    createdAt: new Date(),
  };
}

describe('DashboardAPI GET /health — extended fields (T223)', () => {
  let store: StateStore;
  let dashboard: DashboardAPI;
  let port: number;

  beforeEach(async () => {
    ({ store, dashboard, port } = await startDash());
  });

  afterEach(async () => {
    await dashboard.stop();
    await store.close();
  });

  it('includes opCount: 0 when DB is empty', async () => {
    const health = await getJson(port, '/health') as Record<string, unknown>;
    expect(health.status).toBe('ok');
    expect(health.opCount).toBe(0);
  });

  it('opCount equals 2 after inserting 2 operation logs', async () => {
    await store.saveOperationLog(makeLog());
    await store.saveOperationLog(makeLog());
    const health = await getJson(port, '/health') as Record<string, unknown>;
    expect(health.opCount).toBe(2);
  });

  it('circuitBreakersOpen is absent when circuitBreaker not configured', async () => {
    const health = await getJson(port, '/health') as Record<string, unknown>;
    expect('circuitBreakersOpen' in health).toBe(false);
  });

  it('returns HTTP 200 with status ok', async () => {
    const health = await getJson(port, '/health') as Record<string, unknown>;
    expect(health.status).toBe('ok');
  });
});

describe('DashboardAPI GET /health — circuitBreakersOpen field (T223)', () => {
  it('circuitBreakersOpen is present and equals 0 when no circuits are open', async () => {
    const cb = new AgentCircuitBreaker({ threshold: 5 });
    const { store, dashboard, port } = await startDash({ circuitBreaker: cb });
    try {
      const health = await getJson(port, '/health') as Record<string, unknown>;
      expect('circuitBreakersOpen' in health).toBe(true);
      expect(health.circuitBreakersOpen).toBe(0);
    } finally {
      await dashboard.stop();
      await store.close();
    }
  });

  it('circuitBreakersOpen counts open circuits', async () => {
    const cb = new AgentCircuitBreaker({ threshold: 1 });
    cb.recordBlock('agent-a');
    cb.recordBlock('agent-b');
    const { store, dashboard, port } = await startDash({ circuitBreaker: cb });
    try {
      const health = await getJson(port, '/health') as Record<string, unknown>;
      expect(health.circuitBreakersOpen).toBe(2);
    } finally {
      await dashboard.stop();
      await store.close();
    }
  });
});
