/**
 * T124 — Dashboard agent × tool risk heatmap.
 * Verifies that the dashboard HTML contains heatmap markup and that
 * the /operations endpoint provides the data needed to render it.
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
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) });
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

function makeOp(id: string, tool: string, agentId: string): MCPOperation {
  return {
    id, agentId, tool, method: 'read_file',
    params: {}, timestamp: new Date(), sessionId: 'sess-1',
  };
}

describe('Dashboard heatmap', () => {
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

  it('dashboard HTML contains heatmap section markup', async () => {
    const { status, text } = await get(port, '/');
    expect(status).toBe(200);
    expect(text).toContain('heatmap-body');
    expect(text).toContain('heatmap-table');
    expect(text).toContain('renderHeatmap');
    expect(text).toContain('badge-heatmap');
    expect(text).toContain('Agent × Tool Risk Heatmap');
  });

  it('/operations returns agentId + tool + riskScore for heatmap rendering', async () => {
    const allow: ProxyDecision = { action: 'allow', riskScore: 0.1, reasons: [] };
    const block: ProxyDecision = { action: 'block', riskScore: 0.9, reasons: [] };

    await logger.log(makeOp('op-1', 'filesystem', 'agent-a'), allow);
    await logger.log(makeOp('op-2', 'github',     'agent-a'), block);
    await logger.log(makeOp('op-3', 'filesystem', 'agent-b'), allow);

    const { status, body } = await get(port, '/operations?limit=10');
    expect(status).toBe(200);
    const ops = (body as { data: Array<{ operation: { agentId: string; tool: string }; decision: { riskScore: number } }> }).data;
    expect(ops.length).toBe(3);

    // Verify all heatmap-relevant fields are present
    for (const o of ops) {
      expect(o.operation.agentId).toBeDefined();
      expect(o.operation.tool).toBeDefined();
      expect(typeof o.decision.riskScore).toBe('number');
    }

    // Verify distinct agents and tools
    const agents = [...new Set(ops.map(o => o.operation.agentId))];
    const tools  = [...new Set(ops.map(o => o.operation.tool))];
    expect(agents).toContain('agent-a');
    expect(agents).toContain('agent-b');
    expect(tools).toContain('filesystem');
    expect(tools).toContain('github');
  });
});
