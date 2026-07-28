/**
 * T162 — Dashboard time-range filter tests.
 * Tests GET /operations?from=ISO&to=ISO filtering.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DashboardAPI } from '../../src/modules/m10-dashboard/index.js';
import { StateStore } from '../../src/modules/m2-store/index.js';
import { OperationLogger } from '../../src/modules/m3-logger/index.js';
import type { MCPOperation, ProxyDecision } from '../../src/types/interfaces.js';

async function get(port: number, p: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: p }, res => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString()) });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

function makeOp(id: string): MCPOperation {
  return { id, agentId: 'agent-1', tool: 'filesystem', method: 'read_file', params: {}, timestamp: new Date(), sessionId: 'sess-1' };
}
const allowDec: ProxyDecision = { action: 'allow', riskScore: 0.1, reasons: [] };

describe('GET /operations with time-range filters', () => {
  let tmpDir: string;
  let store: StateStore;
  let logger: OperationLogger;
  let api: DashboardAPI;
  let port: number;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'as-tr-'));
    store = new StateStore(path.join(tmpDir, 'test.db'));
    await store.initialize();
    logger = new OperationLogger(store, undefined, { redact: false });
    api = new DashboardAPI(store);
    await api.start(0);
    port = ((api as unknown as { server: http.Server }).server.address() as { port: number }).port;
  });

  afterEach(async () => {
    await api.stop();
    await store.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns all ops when no time filter is set', async () => {
    await logger.log(makeOp('op-1'), allowDec);
    await logger.log(makeOp('op-2'), allowDec);

    const r = await get(port, '/operations?limit=50');
    const body = r.body as { count: number };
    expect(r.status).toBe(200);
    expect(body.count).toBe(2);
  });

  it('filters with ?from= to exclude older ops', async () => {
    await logger.log(makeOp('op-old'), allowDec);
    const futureFrom = new Date(Date.now() + 5000).toISOString();
    await logger.log(makeOp('op-new'), allowDec);

    // from=future → only ops created after that time (none in this test since both logged before)
    const r = await get(port, `/operations?limit=50&from=${encodeURIComponent(futureFrom)}`);
    const body = r.body as { count: number };
    expect(r.status).toBe(200);
    expect(body.count).toBe(0); // both ops are before the future cutoff
  });

  it('filters with ?to= to exclude newer ops', async () => {
    const pastTo = new Date(Date.now() - 5000).toISOString();
    await logger.log(makeOp('op-now'), allowDec);

    // to=past → ops created before 5s ago (none — op was just created)
    const r = await get(port, `/operations?limit=50&to=${encodeURIComponent(pastTo)}`);
    const body = r.body as { count: number };
    expect(r.status).toBe(200);
    expect(body.count).toBe(0);
  });

  it('returns ops within a valid from/to range', async () => {
    const before = new Date(Date.now() - 1000).toISOString();
    await logger.log(makeOp('op-in-range'), allowDec);
    const after = new Date(Date.now() + 1000).toISOString();

    const url = `/operations?limit=50&from=${encodeURIComponent(before)}&to=${encodeURIComponent(after)}`;
    const r = await get(port, url);
    const body = r.body as { count: number };
    expect(r.status).toBe(200);
    expect(body.count).toBe(1);
  });

  it('ignores invalid date strings gracefully', async () => {
    await logger.log(makeOp('op-x'), allowDec);
    // Invalid ISO → should be ignored, returns all
    const r = await get(port, '/operations?limit=50&from=not-a-date');
    const body = r.body as { count: number };
    expect(r.status).toBe(200);
    expect(body.count).toBe(1);
  });
});
