/**
 * T242 — GET /operations sort control.
 * Tests ?sort=riskScore|timestamp&order=asc|desc query parameters.
 * Ports: 51900–51949
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

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeOp(id: string, timestampOverride?: Date): MCPOperation {
  return {
    id,
    agentId: 'agent-sort',
    tool: 'filesystem',
    method: 'read_file',
    params: { path: `/tmp/${id}.txt` },
    timestamp: timestampOverride ?? new Date(),
    sessionId: 'sess-sort',
  };
}

function makeDecision(riskScore: number): ProxyDecision {
  return { action: 'allow', riskScore, reasons: ['test'] };
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('GET /operations — sort control (T242)', () => {
  let tmpDir: string;
  let store: StateStore;
  let logger: OperationLogger;
  let api: DashboardAPI;
  let port: number;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'as-sort-'));
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

  it('1. default (no params) → newest first (timestamp desc)', async () => {
    const oldTs = new Date(Date.now() - 5000);
    const newTs = new Date();

    await logger.log(makeOp('op-old', oldTs), makeDecision(0.3));
    await logger.log(makeOp('op-new', newTs), makeDecision(0.3));

    const { status, body } = await get(port, '/operations?limit=50');
    expect(status).toBe(200);
    const resp = body as { data: Array<{ operationId: string }> };
    // Store sorts by created_at DESC; op-new was saved last → appears first
    expect(resp.data[0].operationId).toBe('op-new');
    expect(resp.data[1].operationId).toBe('op-old');
  });

  it('2. sort=riskScore&order=desc → highest risk first', async () => {
    await logger.log(makeOp('op-low'), makeDecision(0.1));
    await logger.log(makeOp('op-mid'), makeDecision(0.5));
    await logger.log(makeOp('op-high'), makeDecision(0.9));

    const { status, body } = await get(port, '/operations?sort=riskScore&order=desc&limit=50');
    expect(status).toBe(200);
    const resp = body as { data: Array<{ operationId: string; decision: { riskScore: number } }> };
    expect(resp.data[0].operationId).toBe('op-high');
    expect(resp.data[1].operationId).toBe('op-mid');
    expect(resp.data[2].operationId).toBe('op-low');
    // Verify descending order numerically
    expect(resp.data[0].decision.riskScore).toBeGreaterThan(resp.data[1].decision.riskScore);
    expect(resp.data[1].decision.riskScore).toBeGreaterThan(resp.data[2].decision.riskScore);
  });

  it('3. sort=riskScore&order=asc → lowest risk first', async () => {
    await logger.log(makeOp('op-high2'), makeDecision(0.9));
    await logger.log(makeOp('op-low2'), makeDecision(0.1));
    await logger.log(makeOp('op-mid2'), makeDecision(0.5));

    const { status, body } = await get(port, '/operations?sort=riskScore&order=asc&limit=50');
    expect(status).toBe(200);
    const resp = body as { data: Array<{ operationId: string; decision: { riskScore: number } }> };
    expect(resp.data[0].operationId).toBe('op-low2');
    expect(resp.data[1].operationId).toBe('op-mid2');
    expect(resp.data[2].operationId).toBe('op-high2');
    // Verify ascending order numerically
    expect(resp.data[0].decision.riskScore).toBeLessThan(resp.data[1].decision.riskScore);
    expect(resp.data[1].decision.riskScore).toBeLessThan(resp.data[2].decision.riskScore);
  });

  it('4. sort=timestamp&order=asc → oldest first', async () => {
    const oldest = new Date(Date.now() - 10000);
    const middle = new Date(Date.now() - 5000);
    const newest = new Date();

    // Insert in random order to confirm sort is applied
    await logger.log(makeOp('op-newest', newest), makeDecision(0.2));
    await logger.log(makeOp('op-oldest', oldest), makeDecision(0.2));
    await logger.log(makeOp('op-middle', middle), makeDecision(0.2));

    const { status, body } = await get(port, '/operations?sort=timestamp&order=asc&limit=50');
    expect(status).toBe(200);
    const resp = body as { data: Array<{ operationId: string; operation: { timestamp: string } }> };
    expect(resp.data[0].operationId).toBe('op-oldest');
    expect(resp.data[1].operationId).toBe('op-middle');
    expect(resp.data[2].operationId).toBe('op-newest');
    // Verify ascending timestamp order
    const t0 = new Date(resp.data[0].operation.timestamp).getTime();
    const t1 = new Date(resp.data[1].operation.timestamp).getTime();
    const t2 = new Date(resp.data[2].operation.timestamp).getTime();
    expect(t0).toBeLessThanOrEqual(t1);
    expect(t1).toBeLessThanOrEqual(t2);
  });

  it('5. empty DB → data: [] regardless of sort params', async () => {
    const cases = [
      '/operations',
      '/operations?sort=riskScore&order=desc',
      '/operations?sort=riskScore&order=asc',
      '/operations?sort=timestamp&order=asc',
    ];
    for (const url of cases) {
      const { status, body } = await get(port, url);
      expect(status).toBe(200);
      const resp = body as { data: unknown[] };
      expect(resp.data).toEqual([]);
    }
  });
});
