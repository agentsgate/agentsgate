/**
 * T203 — agentsgate top live dashboard.
 * Tests the underlying REST data gathering from /operations and /telemetry endpoints.
 */
import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { StateStore } from '../src/modules/m2-store/index.js';
import { DashboardAPI } from '../src/modules/m10-dashboard/index.js';
import { OperationLogger } from '../src/modules/m3-logger/index.js';
import { TelemetryService } from '../src/modules/m13-telemetry/index.js';
import type { MCPOperation } from '../src/types/interfaces.js';

// Ports come from start(0). A hand-picked base sits inside the OS ephemeral
// range (49152-65535 on macOS), so any concurrent listen(0) can be handed the
// same number and this suite loses the race with EADDRINUSE.
const cleanups: Array<() => Promise<void>> = [];

async function makeServer(telemetry?: TelemetryService): Promise<{ port: number; store: StateStore; logger: OperationLogger }> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'as-top-'));
  const store = new StateStore(path.join(tmpDir, 'test.db'));
  await store.initialize();
  const logger = new OperationLogger(store);
  const dash = new DashboardAPI(store, { telemetry });
  await dash.start(0);
  const port = dash.getPort();
  cleanups.push(async () => {
    await dash.stop();
    await store.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
  return { port, store, logger };
}

afterEach(async () => { for (const fn of cleanups.splice(0)) await fn(); });

function makeOp(agentId: string, tool: string): MCPOperation {
  return {
    id: crypto.randomUUID(), agentId, tool, method: 'call',
    params: {}, timestamp: new Date(), sessionId: 'sess-1',
  };
}

async function get(port: number, p: string) {
  const r = await fetch(`http://127.0.0.1:${port}${p}`);
  return { status: r.status, body: await r.json() };
}

describe('agentsgate top — data gathering endpoints', () => {
  it('GET /operations returns logs ordered by most recent', async () => {
    const { port, logger } = await makeServer();
    await logger.log(makeOp('agent-a', 'filesystem'), { action: 'allow', riskScore: 0.1, reasons: [] });
    // Small delay to ensure distinct ISO timestamps in SQLite ORDER BY created_at DESC
    await new Promise(r => setTimeout(r, 5));
    await logger.log(makeOp('agent-b', 'database'), { action: 'block', riskScore: 0.9, reasons: [] });
    const { status, body } = await get(port, '/operations?limit=50');
    expect(status).toBe(200);
    const { data: logs } = body as { data: Array<{ operation: { agentId: string }; decision: { riskScore: number } }> };
    expect(logs.length).toBe(2);
    // Most recent first
    expect(logs[0].operation.agentId).toBe('agent-b');
  });

  it('top agent computed from logs has correct avg risk', async () => {
    const { port, logger } = await makeServer();
    await logger.log(makeOp('agent-x', 'shell'), { action: 'allow', riskScore: 0.2, reasons: [] });
    await logger.log(makeOp('agent-x', 'shell'), { action: 'block', riskScore: 0.8, reasons: [] });
    const { body } = await get(port, '/operations?limit=50');
    const { data: logs } = body as { data: Array<{ operation: { agentId: string }; decision: { riskScore: number } }> };
    const xLogs = logs.filter(l => l.operation.agentId === 'agent-x');
    const avg = xLogs.reduce((s, l) => s + l.decision.riskScore, 0) / xLogs.length;
    expect(avg).toBeCloseTo(0.5);
  });

  it('GET /telemetry returns byAction breakdown', async () => {
    const tel = new TelemetryService();
    const { port } = await makeServer(tel);
    tel.record(makeOp('a', 't'), { action: 'allow', riskScore: 0.1, reasons: [] });
    tel.record(makeOp('a', 't'), { action: 'block', riskScore: 0.9, reasons: [] });
    const { status, body } = await get(port, '/telemetry');
    expect(status).toBe(200);
    const t = body as { byAction: Record<string, number> };
    expect(t.byAction.allow).toBe(1);
    expect(t.byAction.block).toBe(1);
  });

  it('GET /telemetry returns 503 when no telemetry configured', async () => {
    const { port } = await makeServer(); // no telemetry
    const { status } = await get(port, '/telemetry');
    expect(status).toBe(503);
  });
});
