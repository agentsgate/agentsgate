/**
 * T191 — Dashboard /telemetry/sessions endpoints.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { StateStore } from '../../src/modules/m2-store/index.js';
import { DashboardAPI } from '../../src/modules/m10-dashboard/index.js';
import { TelemetryService } from '../../src/modules/m13-telemetry/index.js';
import type { MCPOperation, ProxyDecision } from '../../src/types/interfaces.js';

// Ports come from start(0). A hand-picked base sits inside the OS ephemeral
// range (49152-65535 on macOS), so any concurrent listen(0) can be handed the
// same number and this suite loses the race with EADDRINUSE.

function makeOp(sessionId: string, tool = 'fs'): MCPOperation {
  return { id: 'op-1', agentId: 'a', tool, method: 'call', params: {}, timestamp: new Date(), sessionId };
}
function dec(action: ProxyDecision['action'] = 'allow', riskScore = 0.2): ProxyDecision {
  return { action, riskScore, reasons: [] };
}

async function setup(telemetry?: TelemetryService): Promise<{ dash: DashboardAPI; port: number; store: StateStore; tmpDir: string }> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'as-telsess-'));
  const store = new StateStore(path.join(tmpDir, 'test.db'));
  await store.initialize();
  const dash = new DashboardAPI(store, { telemetry });
  await dash.start(0);
  const port = dash.getPort();
  return { dash, port, store, tmpDir };
}

async function getJSON(port: number, p: string) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`);
  return { status: res.status, body: await res.json() };
}

describe('DashboardAPI — /telemetry/sessions endpoints', () => {
  it('GET /telemetry/sessions returns 503 when telemetry not configured', async () => {
    const { dash, port, store, tmpDir } = await setup();
    try {
      const { status } = await getJSON(port, '/telemetry/sessions');
      expect(status).toBe(503);
    } finally {
      await dash.stop(); await store.close();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('GET /telemetry/sessions returns empty list when no events', async () => {
    const tel = new TelemetryService();
    const { dash, port, store, tmpDir } = await setup(tel);
    try {
      const { status, body } = await getJSON(port, '/telemetry/sessions');
      expect(status).toBe(200);
      expect(Array.isArray(body)).toBe(true);
      expect((body as unknown[]).length).toBe(0);
    } finally {
      await dash.stop(); await store.close();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('GET /telemetry/sessions lists recorded sessions', async () => {
    const tel = new TelemetryService();
    await tel.record(makeOp('sess-a'), dec());
    await tel.record(makeOp('sess-b'), dec());
    const { dash, port, store, tmpDir } = await setup(tel);
    try {
      const { status, body } = await getJSON(port, '/telemetry/sessions');
      expect(status).toBe(200);
      const sessions = body as Array<{ sessionId: string; totalEvents: number }>;
      expect(sessions.length).toBe(2);
      const ids = sessions.map(s => s.sessionId);
      expect(ids).toContain('sess-a');
      expect(ids).toContain('sess-b');
    } finally {
      await dash.stop(); await store.close();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('GET /telemetry/sessions/:id returns session rollup', async () => {
    const tel = new TelemetryService();
    await tel.record(makeOp('sess-x', 'shell'), dec('block', 0.9));
    await tel.record(makeOp('sess-x', 'fs'), dec('allow', 0.1));
    const { dash, port, store, tmpDir } = await setup(tel);
    try {
      const { status, body } = await getJSON(port, '/telemetry/sessions/sess-x');
      expect(status).toBe(200);
      const b = body as { sessionId: string; totalEvents: number; maxRiskScore: number };
      expect(b.sessionId).toBe('sess-x');
      expect(b.totalEvents).toBe(2);
      expect(b.maxRiskScore).toBe(0.9);
    } finally {
      await dash.stop(); await store.close();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('GET /telemetry/sessions/:id returns 404 for unknown session', async () => {
    const tel = new TelemetryService();
    const { dash, port, store, tmpDir } = await setup(tel);
    try {
      const { status } = await getJSON(port, '/telemetry/sessions/no-such-session');
      expect(status).toBe(404);
    } finally {
      await dash.stop(); await store.close();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
