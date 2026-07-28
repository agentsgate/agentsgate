/**
 * T204 — GET /rate-limits endpoint and agentsgate rate-limits CLI.
 */
import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { StateStore } from '../src/modules/m2-store/index.js';
import { DashboardAPI } from '../src/modules/m10-dashboard/index.js';
import { AgentRateLimiter } from '../src/utils/rate-limiter.js';

// Ports come from start(0). A hand-picked base sits inside the OS ephemeral
// range (49152-65535 on macOS), so any concurrent listen(0) can be handed the
// same number and this suite loses the race with EADDRINUSE.
const cleanups: Array<() => Promise<void>> = [];

async function makeServer(rl?: AgentRateLimiter): Promise<{ port: number }> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'as-rl-'));
  const store = new StateStore(path.join(tmpDir, 'test.db'));
  await store.initialize();
  const dash = new DashboardAPI(store, { rateLimiter: rl });
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

describe('GET /rate-limits endpoint', () => {
  it('returns 503 when rate limiter not configured', async () => {
    const { port } = await makeServer();
    const { status } = await get(port, '/rate-limits');
    expect(status).toBe(503);
  });

  it('returns empty agents when no checks performed', async () => {
    const rl = new AgentRateLimiter(10);
    const { port } = await makeServer(rl);
    const { status, body } = await get(port, '/rate-limits');
    expect(status).toBe(200);
    expect((body as { count: number }).count).toBe(0);
  });

  it('returns agent stats after check', async () => {
    const rl = new AgentRateLimiter(5);
    rl.check('agent-a');
    rl.check('agent-a');
    const { port } = await makeServer(rl);
    const { body } = await get(port, '/rate-limits');
    const b = body as { agents: Array<{ agentId: string; count: number; limit: number; limited: boolean }> };
    const a = b.agents.find(x => x.agentId === 'agent-a');
    expect(a).toBeDefined();
    expect(a!.count).toBe(2);
    expect(a!.limit).toBe(5);
    expect(a!.limited).toBe(false);
  });

  it('marks agent as limited when count >= limit', async () => {
    const rl = new AgentRateLimiter(2);
    rl.check('agent-b');
    rl.check('agent-b');
    rl.check('agent-b'); // exceeds limit
    const { port } = await makeServer(rl);
    const { body } = await get(port, '/rate-limits');
    const agents = (body as { agents: Array<{ agentId: string; limited: boolean }> }).agents;
    const b = agents.find(x => x.agentId === 'agent-b');
    expect(b?.limited).toBe(true);
  });

  it('getAll enumerates multiple agents', () => {
    const rl = new AgentRateLimiter(10);
    rl.check('a1');
    rl.check('a2');
    rl.check('a2');
    const all = rl.getAll();
    expect(all.length).toBe(2);
    const a2 = all.find(x => x.agentId === 'a2');
    expect(a2?.count).toBe(2);
  });
});
