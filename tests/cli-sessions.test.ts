/**
 * T194 — agentsgate sessions rollup CLI integration with DashboardAPI.
 * Tests the REST round-trip via fetch (same path the CLI uses).
 */
import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { StateStore } from '../src/modules/m2-store/index.js';
import { DashboardAPI } from '../src/modules/m10-dashboard/index.js';
import { TelemetryService } from '../src/modules/m13-telemetry/index.js';

// Ports come from start(0). A hand-picked base sits inside the OS ephemeral
// range (49152-65535 on macOS), so any concurrent listen(0) can be handed the
// same number and this suite loses the race with EADDRINUSE.
const cleanups: Array<() => Promise<void>> = [];

async function makeServer(telemetry?: TelemetryService): Promise<{ port: number }> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'as-sess-'));
  const store = new StateStore(path.join(tmpDir, 'test.db'));
  await store.initialize();
  const dash = new DashboardAPI(store, { telemetry });
  await dash.start(0);
  const port = dash.getPort();
  cleanups.push(async () => {
    await dash.stop();
    await store.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
  return { port };
}

afterEach(async () => { for (const fn of cleanups.splice(0)) await fn(); });

async function get(port: number, p: string) {
  const r = await fetch(`http://127.0.0.1:${port}${p}`);
  return { status: r.status, body: await r.json() };
}

function makeOp(sessionId: string, id = crypto.randomUUID()) {
  return {
    id,
    agentId: 'agent-1',
    tool: 'filesystem',
    method: 'read_file',
    params: {},
    timestamp: new Date(),
    sessionId,
  };
}

describe('agentsgate sessions CLI — REST integration', () => {
  it('GET /telemetry/sessions returns empty array when no events recorded', async () => {
    const tel = new TelemetryService();
    const { port } = await makeServer(tel);
    const { status, body } = await get(port, '/telemetry/sessions');
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect((body as unknown[]).length).toBe(0);
  });

  it('GET /telemetry/sessions returns one session after events', async () => {
    const tel = new TelemetryService();
    const op = makeOp('sess-A');
    tel.record(op, { action: 'allow', riskScore: 0.2, reasons: [] });
    tel.record(makeOp('sess-A'), { action: 'block', riskScore: 0.9, reasons: [] });
    const { port } = await makeServer(tel);
    const { status, body } = await get(port, '/telemetry/sessions');
    expect(status).toBe(200);
    const sessions = body as Array<{ sessionId: string; totalEvents: number }>;
    expect(sessions.length).toBe(1);
    expect(sessions[0].sessionId).toBe('sess-A');
    expect(sessions[0].totalEvents).toBe(2);
  });

  it('GET /telemetry/sessions/:id returns detail for a known session', async () => {
    const tel = new TelemetryService();
    tel.record(makeOp('sess-B'), { action: 'allow', riskScore: 0.3, reasons: [] });
    const { port } = await makeServer(tel);
    const { status, body } = await get(port, '/telemetry/sessions/sess-B');
    expect(status).toBe(200);
    const s = body as { sessionId: string; avgRiskScore: number; byTool: Record<string, number> };
    expect(s.sessionId).toBe('sess-B');
    expect(s.avgRiskScore).toBeCloseTo(0.3);
    expect(s.byTool['filesystem']).toBe(1);
  });

  it('GET /telemetry/sessions/:id returns 404 for unknown session', async () => {
    const tel = new TelemetryService();
    const { port } = await makeServer(tel);
    const { status } = await get(port, '/telemetry/sessions/nonexistent');
    expect(status).toBe(404);
  });

  it('GET /telemetry/sessions returns 503 when telemetry not configured', async () => {
    const { port } = await makeServer(); // no telemetry
    const { status } = await get(port, '/telemetry/sessions');
    expect(status).toBe(503);
  });
});
