/**
 * T181 — Dashboard circuit-breaker panel endpoints.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:path';
import path from 'node:path';
import fs from 'node:fs/promises';
import { StateStore } from '../../src/modules/m2-store/index.js';
import { DashboardAPI } from '../../src/modules/m10-dashboard/index.js';
import { AgentCircuitBreaker } from '../../src/utils/circuit-breaker.js';

const BASE = 49500;
let portOff = 0;

async function startDash(cb?: AgentCircuitBreaker): Promise<{ dash: DashboardAPI; port: number; store: StateStore; tmpDir: string }> {
  const tmpDir = await fs.mkdtemp(path.join(require('os').tmpdir(), 'as-cbdash-'));
  const store = new StateStore(path.join(tmpDir, 'test.db'));
  await store.initialize();
  const port = BASE + portOff++;
  const dash = new DashboardAPI(store, { circuitBreaker: cb });
  await dash.start(port);
  return { dash, port, store, tmpDir };
}

async function get(port: number, p: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${p}`);
  return { status: res.status, body: await res.json() };
}
async function post(port: number, p: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST' });
  return { status: res.status, body: await res.json() };
}

describe('DashboardAPI — circuit-breaker endpoints', () => {
  it('GET /circuit-breakers returns 503 when not configured', async () => {
    const { dash, port, store, tmpDir } = await startDash();
    try {
      const { status, body } = await get(port, '/circuit-breakers');
      expect(status).toBe(503);
      expect((body as { error: string }).error).toContain('not configured');
    } finally {
      await dash.stop(); await store.close();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('GET /circuit-breakers returns empty list when no agents tracked', async () => {
    const cb = new AgentCircuitBreaker({ threshold: 3 });
    const { dash, port, store, tmpDir } = await startDash(cb);
    try {
      const { status, body } = await get(port, '/circuit-breakers');
      expect(status).toBe(200);
      const b = body as { agents: unknown[]; count: number };
      expect(b.count).toBe(0);
      expect(b.agents).toHaveLength(0);
    } finally {
      await dash.stop(); await store.close();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('GET /circuit-breakers lists tripped agent', async () => {
    const cb = new AgentCircuitBreaker({ threshold: 1 });
    cb.recordBlock('agent-x');
    const { dash, port, store, tmpDir } = await startDash(cb);
    try {
      const { status, body } = await get(port, '/circuit-breakers');
      expect(status).toBe(200);
      const b = body as { agents: Array<{ agentId: string; isOpen: boolean }> };
      const entry = b.agents.find(a => a.agentId === 'agent-x');
      expect(entry).toBeDefined();
      expect(entry!.isOpen).toBe(true);
    } finally {
      await dash.stop(); await store.close();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('POST /circuit-breakers/:agentId/reset closes the circuit', async () => {
    const cb = new AgentCircuitBreaker({ threshold: 1 });
    cb.recordBlock('agent-y');
    expect(cb.isOpen('agent-y')).toBe(true);
    const { dash, port, store, tmpDir } = await startDash(cb);
    try {
      const { status, body } = await post(port, '/circuit-breakers/agent-y/reset');
      expect(status).toBe(200);
      expect((body as { ok: boolean }).ok).toBe(true);
      expect(cb.isOpen('agent-y')).toBe(false);
    } finally {
      await dash.stop(); await store.close();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('POST /circuit-breakers reset returns 503 when not configured', async () => {
    const { dash, port, store, tmpDir } = await startDash();
    try {
      const { status } = await post(port, '/circuit-breakers/agent-z/reset');
      expect(status).toBe(503);
    } finally {
      await dash.stop(); await store.close();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
