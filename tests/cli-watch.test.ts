/**
 * T200 — agentsgate watch live-tail via SSE.
 * Tests that the dashboard /events endpoint emits 'operation' events
 * and that the event payload matches what was notified.
 */
import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { StateStore } from '../src/modules/m2-store/index.js';
import { DashboardAPI } from '../src/modules/m10-dashboard/index.js';

// Ports come from start(0). A hand-picked base sits inside the OS ephemeral
// range (49152-65535 on macOS), so any concurrent listen(0) can be handed the
// same number and this suite loses the race with EADDRINUSE.
const cleanups: Array<() => Promise<void>> = [];

async function makeServer(): Promise<{ port: number; dash: DashboardAPI }> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'as-watch-'));
  const store = new StateStore(path.join(tmpDir, 'test.db'));
  await store.initialize();
  const dash = new DashboardAPI(store, {});
  await dash.start(0);
  const port = dash.getPort();
  cleanups.push(async () => {
    await dash.stop();
    await store.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
  return { port, dash };
}

afterEach(async () => { for (const fn of cleanups.splice(0)) await fn(); });

/**
 * Connect to SSE endpoint and collect events for `durationMs` ms.
 * Returns array of parsed { event, data } pairs.
 */
async function collectSSE(
  port: number,
  durationMs: number
): Promise<Array<{ event: string; data: string }>> {
  const events: Array<{ event: string; data: string }> = [];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), durationMs);

  try {
    const resp = await fetch(`http://127.0.0.1:${port}/events`, { signal: ctrl.signal });
    const reader = resp.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let curEvent = 'message';

    while (true) {
      let chunk: { done: boolean; value?: Uint8Array };
      try { chunk = await reader.read(); } catch { break; }
      if (chunk.done) break;
      buf += dec.decode(chunk.value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('event:')) curEvent = line.slice(6).trim();
        else if (line.startsWith('data:')) {
          events.push({ event: curEvent, data: line.slice(5).trim() });
          curEvent = 'message';
        }
      }
    }
  } catch { /* AbortError expected */ }

  clearTimeout(timer);
  return events;
}

describe('agentsgate watch — SSE integration', () => {
  it('GET /events sends connected event on subscribe', async () => {
    const { port } = await makeServer();
    const events = await collectSSE(port, 300);
    expect(events.some(e => e.event === 'connected')).toBe(true);
  });

  it('notify() pushes operation event to SSE clients', async () => {
    const { port, dash } = await makeServer();

    // Start collecting, then push an event after a short delay
    const collectPromise = collectSSE(port, 500);
    await new Promise(r => setTimeout(r, 100));

    dash.notify('operation', JSON.stringify({
      id: 'op-1', agentId: 'agent-x', tool: 'filesystem', method: 'write_file',
      action: 'block', riskScore: 0.9, sessionId: 'sess-1', timestamp: new Date(),
    }));

    const events = await collectPromise;
    const opEvent = events.find(e => e.event === 'operation');
    expect(opEvent).toBeDefined();
    const payload = JSON.parse(opEvent!.data) as { action: string; agentId: string };
    expect(payload.action).toBe('block');
    expect(payload.agentId).toBe('agent-x');
  });

  it('multiple notify() calls all arrive in order', async () => {
    const { port, dash } = await makeServer();
    const collectPromise = collectSSE(port, 600);
    await new Promise(r => setTimeout(r, 100));

    for (let i = 0; i < 3; i++) {
      dash.notify('operation', JSON.stringify({
        id: `op-${i}`, agentId: 'agent-y', tool: 'db', method: 'query',
        action: 'allow', riskScore: 0.1 * i, sessionId: 's1', timestamp: new Date(),
      }));
    }

    const events = await collectPromise;
    const opEvents = events.filter(e => e.event === 'operation');
    expect(opEvents.length).toBe(3);
    const ids = opEvents.map(e => (JSON.parse(e.data) as { id: string }).id);
    expect(ids).toEqual(['op-0', 'op-1', 'op-2']);
  });

  it('tags field is preserved in SSE payload', async () => {
    const { port, dash } = await makeServer();
    const collectPromise = collectSSE(port, 500);
    await new Promise(r => setTimeout(r, 100));

    dash.notify('operation', JSON.stringify({
      id: 'op-t', agentId: 'a', tool: 't', method: 'm',
      action: 'allow', riskScore: 0, sessionId: 's', timestamp: new Date(),
      tags: ['pci-scope', 'prod'],
    }));

    const events = await collectPromise;
    const opEvent = events.find(e => e.event === 'operation');
    const payload = JSON.parse(opEvent!.data) as { tags?: string[] };
    expect(payload.tags).toEqual(['pci-scope', 'prod']);
  });
});
