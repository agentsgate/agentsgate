/**
 * T192 — agentsgate circuit-breakers CLI integration with DashboardAPI.
 * Tests the REST round-trip via fetch (same path the CLI uses).
 */
import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { StateStore } from '../src/modules/m2-store/index.js';
import { DashboardAPI } from '../src/modules/m10-dashboard/index.js';
import { AgentCircuitBreaker } from '../src/utils/circuit-breaker.js';

// Ports come from start(0). A hand-picked base sits inside the OS ephemeral
// range (49152-65535 on macOS), so any concurrent listen(0) can be handed the
// same number and this suite loses the race with EADDRINUSE.
const cleanups: Array<() => Promise<void>> = [];

async function makeServer(cb?: AgentCircuitBreaker): Promise<{ port: number }> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'as-cbcli-'));
  const store = new StateStore(path.join(tmpDir, 'test.db'));
  await store.initialize();
  const dash = new DashboardAPI(store, { circuitBreaker: cb });
  await dash.start(0);
  const port = dash.getPort();
  cleanups.push(async () => { await dash.stop(); await store.close(); await fs.rm(tmpDir, { recursive: true, force: true }); });
  return { port };
}

afterEach(async () => { for (const fn of cleanups.splice(0)) await fn(); });

async function get(port: number, p: string) {
  const r = await fetch(`http://127.0.0.1:${port}${p}`);
  return r.json();
}
async function post(port: number, p: string) {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST' });
  return r.json();
}

describe('agentsgate circuit-breakers CLI — REST integration', () => {
  it('list returns empty when no agents tracked', async () => {
    const cb = new AgentCircuitBreaker({ threshold: 3 });
    const { port } = await makeServer(cb);
    const body = await get(port, '/circuit-breakers') as { count: number };
    expect(body.count).toBe(0);
  });

  it('list returns open agents after blocks', async () => {
    const cb = new AgentCircuitBreaker({ threshold: 2 });
    cb.recordBlock('alpha');
    cb.recordBlock('alpha');
    const { port } = await makeServer(cb);
    const body = await get(port, '/circuit-breakers') as { agents: Array<{ agentId: string; isOpen: boolean }> };
    const alpha = body.agents.find((a) => a.agentId === 'alpha');
    expect(alpha?.isOpen).toBe(true);
  });

  it('reset endpoint closes the circuit', async () => {
    const cb = new AgentCircuitBreaker({ threshold: 1 });
    cb.recordBlock('beta');
    expect(cb.isOpen('beta')).toBe(true);
    const { port } = await makeServer(cb);
    const result = await post(port, '/circuit-breakers/beta/reset') as { ok: boolean };
    expect(result.ok).toBe(true);
    expect(cb.isOpen('beta')).toBe(false);
  });

  it('list shows trippedAt timestamp when circuit is open', async () => {
    const cb = new AgentCircuitBreaker({ threshold: 1, resetAfterMs: 0 });
    cb.recordBlock('gamma');
    const { port } = await makeServer(cb);
    const body = await get(port, '/circuit-breakers') as { agents: Array<{ agentId: string; trippedAt?: number }> };
    const gamma = body.agents.find((a) => a.agentId === 'gamma');
    expect(gamma?.trippedAt).toBeDefined();
    expect(typeof gamma!.trippedAt).toBe('number');
  });

  it('multiple agents tracked independently', async () => {
    const cb = new AgentCircuitBreaker({ threshold: 1 });
    cb.recordBlock('a1');
    cb.recordBlock('a2');
    const { port } = await makeServer(cb);
    const body = await get(port, '/circuit-breakers') as { count: number };
    expect(body.count).toBe(2);
  });
});
