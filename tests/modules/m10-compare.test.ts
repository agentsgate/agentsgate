/**
 * T113 — Dashboard multi-session comparison view.
 * Verifies that the /sessions endpoint returns data that supports
 * side-by-side comparison (per-session counts) and that the dashboard
 * HTML includes the comparison section markup.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { DashboardAPI } from '../../src/modules/m10-dashboard/index.js';
import { StateStore } from '../../src/modules/m2-store/index.js';
import { OperationLogger } from '../../src/modules/m3-logger/index.js';
import type { MCPOperation, ProxyDecision } from '../../src/types/interfaces.js';

async function get(port: number, path: string): Promise<{ status: number; body: unknown; text?: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path }, res => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        const ct  = res.headers['content-type'] ?? '';
        if (ct.includes('text/html')) {
          resolve({ status: res.statusCode ?? 0, body: {}, text: raw });
        } else {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: {}, text: raw });
          }
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

function makeOp(id: string, sessionId: string, agentId: string): MCPOperation {
  return {
    id, agentId, tool: 'filesystem', method: 'read_file',
    params: { path: '/tmp/x.txt' }, timestamp: new Date(), sessionId,
  };
}

describe('Dashboard comparison view', () => {
  let store: StateStore;
  let logger: OperationLogger;
  let api: DashboardAPI;
  let port: number;

  beforeEach(async () => {
    store  = new StateStore(':memory:');
    await store.initialize();
    logger = new OperationLogger(store);
    api    = new DashboardAPI(store);
    await api.start(0);
    const addr = (api as unknown as { server: http.Server }).server.address() as { port: number };
    port = addr.port;
  });

  afterEach(async () => {
    await api.stop();
    await store.close();
  });

  it('/sessions returns per-session counts for two sessions', async () => {
    const allow: ProxyDecision  = { action: 'allow', riskScore: 0.1, reasons: [] };
    const block: ProxyDecision  = { action: 'block', riskScore: 0.9, reasons: [] };

    // Session A: 3 ops, 2 allow + 1 block
    await logger.log(makeOp('op-a1', 'sess-A', 'agent-1'), allow);
    await logger.log(makeOp('op-a2', 'sess-A', 'agent-1'), allow);
    await logger.log(makeOp('op-a3', 'sess-A', 'agent-1'), block);

    // Session B: 2 ops, 1 allow + 1 block
    await logger.log(makeOp('op-b1', 'sess-B', 'agent-2'), allow);
    await logger.log(makeOp('op-b2', 'sess-B', 'agent-2'), block);

    const { status, body } = await get(port, '/sessions');
    expect(status).toBe(200);
    const sessions = (body as { data: Array<{
      sessionId: string; agentId: string;
      operationCount: number; approved: number; blocked: number;
    }> }).data;

    const sA = sessions.find(s => s.sessionId === 'sess-A');
    const sB = sessions.find(s => s.sessionId === 'sess-B');

    expect(sA).toBeDefined();
    expect(sA!.operationCount).toBe(3);
    expect(sA!.approved).toBe(2);
    expect(sA!.blocked).toBe(1);

    expect(sB).toBeDefined();
    expect(sB!.operationCount).toBe(2);
    expect(sB!.approved).toBe(1);
    expect(sB!.blocked).toBe(1);
  });

  it('dashboard HTML contains compare-grid markup', async () => {
    const { status, text } = await get(port, '/');
    expect(status).toBe(200);
    expect(text).toContain('compare-toolbar');
    expect(text).toContain('compare-grid');
    expect(text).toContain('cmp-a');
    expect(text).toContain('cmp-b');
    expect(text).toContain('renderComparison');
  });

  it('/sessions returns requireApproval count', async () => {
    const pending: ProxyDecision = { action: 'require_approval', riskScore: 0.6, reasons: [] };
    await logger.log(makeOp('op-p1', 'sess-C', 'agent-3'), pending);
    await logger.log(makeOp('op-p2', 'sess-C', 'agent-3'), pending);

    const { body } = await get(port, '/sessions');
    const sessions = (body as { data: Array<{ sessionId: string; requireApproval: number }> }).data;
    const sC = sessions.find(s => s.sessionId === 'sess-C');
    expect(sC).toBeDefined();
    expect(sC!.requireApproval).toBe(2);
  });
});
