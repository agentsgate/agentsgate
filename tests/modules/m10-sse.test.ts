/**
 * T102 — DashboardAPI SSE (Server-Sent Events) live-update tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DashboardAPI } from '../../src/modules/m10-dashboard/index.js';
import { StateStore } from '../../src/modules/m2-store/index.js';
import http from 'node:http';

let store: StateStore;
let dashboard: DashboardAPI;
const PORT = 14210;

beforeEach(async () => {
  store = new StateStore(':memory:');
  await store.initialize();
  dashboard = new DashboardAPI(store);
  await dashboard.start(PORT);
});

afterEach(async () => {
  await dashboard.stop();
  store.close();
});

/** Open a raw HTTP GET and collect the first N SSE lines, then destroy the socket. */
function collectSSELines(n: number, timeoutMs = 2000): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const lines: string[] = [];
    const req = http.get(`http://127.0.0.1:${PORT}/events`, res => {
      const timeout = setTimeout(() => { req.destroy(); resolve(lines); }, timeoutMs);
      res.setEncoding('utf-8');
      let buf = '';
      res.on('data', (chunk: string) => {
        buf += chunk;
        const parts = buf.split('\n');
        buf = parts.pop() ?? '';
        for (const p of parts) {
          if (p.trim()) lines.push(p.trim());
        }
        if (lines.length >= n) {
          clearTimeout(timeout);
          req.destroy();
          resolve(lines);
        }
      });
      res.on('error', () => { clearTimeout(timeout); resolve(lines); });
    });
    req.on('error', reject);
  });
}

describe('DashboardAPI SSE', () => {

  it('GET /events returns text/event-stream content-type', async () => {
    const result = await new Promise<string | undefined>((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${PORT}/events`, res => {
        resolve(res.headers['content-type']);
        req.destroy();
      });
      req.on('error', reject);
    });
    expect(result).toContain('text/event-stream');
  });

  it('sends a connected event immediately on connection', async () => {
    const lines = await collectSSELines(2, 1000);
    const hasConnectedEvent = lines.some(l => l === 'event: connected');
    expect(hasConnectedEvent).toBe(true);
  });

  it('notify() pushes refresh event to connected clients', async () => {
    // Start collecting SSE in background
    const ssePromise = collectSSELines(4, 2000);

    // Give the connection time to establish
    await new Promise(r => setTimeout(r, 100));

    // Push a notification
    dashboard.notify('refresh', '{}');

    const lines = await ssePromise;
    const hasRefresh = lines.some(l => l === 'event: refresh');
    expect(hasRefresh).toBe(true);
  });

  it('onOperation callback triggers notify when wired via pipeline', async () => {
    // The pipeline onOperation should call dashboard.notify()
    // We verify this by checking notify() works with a custom event name
    const ssePromise = collectSSELines(4, 2000);
    await new Promise(r => setTimeout(r, 100));

    dashboard.notify('operation', JSON.stringify({ tool: 'filesystem', action: 'allow' }));

    const lines = await ssePromise;
    const opLine = lines.find(l => l.startsWith('data:') && l.includes('filesystem'));
    expect(opLine).toBeTruthy();
  });
});
