/**
 * T135 — Dashboard CSV export endpoint (GET /operations/export).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { DashboardAPI } from '../../src/modules/m10-dashboard/index.js';
import { StateStore } from '../../src/modules/m2-store/index.js';
import { OperationLogger } from '../../src/modules/m3-logger/index.js';
import type { MCPOperation, ProxyDecision } from '../../src/types/interfaces.js';

let store: StateStore;
let logger: OperationLogger;
let api: DashboardAPI;
let port: number;

async function get(path: string): Promise<{ status: number; body: string; contentType: string; disposition: string }> {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${path}`, res => {
      let body = '';
      res.on('data', (c: Buffer) => { body += c.toString(); });
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        body,
        contentType: res.headers['content-type'] ?? '',
        disposition: res.headers['content-disposition'] ?? '',
      }));
    }).on('error', reject);
  });
}

function makeOp(id: string, tool: string, agentId = 'agent-1', method = 'write'): MCPOperation {
  return { id, agentId, tool, method, params: {}, timestamp: new Date(), sessionId: 'sess-1' };
}

function dec(action: ProxyDecision['action'] = 'allow', riskScore = 0.2): ProxyDecision {
  return { action, riskScore, reasons: [] };
}

beforeEach(async () => {
  store = new StateStore(':memory:');
  await store.initialize();
  logger = new OperationLogger(store);
  api = new DashboardAPI(store);
  await api.start(0);
  const addr = (api as unknown as { server: http.Server }).server.address() as { port: number };
  port = addr.port;
});

afterEach(async () => {
  await api.stop();
  await store.close();
});

describe('GET /operations/export', () => {
  it('returns 200 with CSV content-type', async () => {
    const { status, contentType } = await get('/operations/export');
    expect(status).toBe(200);
    expect(contentType).toContain('text/csv');
  });

  it('includes Content-Disposition attachment header', async () => {
    const { disposition } = await get('/operations/export');
    expect(disposition).toContain('attachment');
    expect(disposition).toContain('.csv');
  });

  it('returns header row when no data', async () => {
    const { body } = await get('/operations/export');
    const lines = body.split('\r\n').filter(Boolean);
    expect(lines[0]).toContain('id');
    expect(lines[0]).toContain('agentId');
    expect(lines[0]).toContain('riskScore');
    expect(lines).toHaveLength(1); // header only
  });

  it('exports all operations as CSV rows', async () => {
    await logger.log(makeOp('op-1', 'filesystem'), dec('allow', 0.1));
    await logger.log(makeOp('op-2', 'shell', 'agent-2'), dec('block', 0.9));

    const { body } = await get('/operations/export');
    const lines = body.split('\r\n').filter(Boolean);
    expect(lines).toHaveLength(3); // header + 2 rows
    expect(lines[0]).toContain('id');
    expect(lines.some(l => l.includes('op-1'))).toBe(true);
    expect(lines.some(l => l.includes('op-2'))).toBe(true);
  });

  it('filters by action query param', async () => {
    await logger.log(makeOp('op-allow', 'filesystem'), dec('allow', 0.1));
    await logger.log(makeOp('op-block', 'shell'), dec('block', 0.9));

    const { body } = await get('/operations/export?action=block');
    expect(body).toContain('op-block');
    expect(body).not.toContain('op-allow');
  });

  it('filters by tool query param', async () => {
    await logger.log(makeOp('op-fs', 'filesystem'), dec());
    await logger.log(makeOp('op-sh', 'shell'), dec());

    const { body } = await get('/operations/export?tool=shell');
    expect(body).toContain('op-sh');
    expect(body).not.toContain('op-fs');
  });

  it('escapes commas in fields', async () => {
    const op = makeOp('op-1', 'filesystem');
    op.agentId = 'agent,with,commas';
    await logger.log(op, dec());

    const { body } = await get('/operations/export');
    expect(body).toContain('"agent,with,commas"');
  });
});
