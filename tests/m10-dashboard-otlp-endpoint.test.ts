/**
 * T438 — HTTP integration tests for POST /telemetry/export-otlp
 *
 * Port base: 63400
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DashboardAPI } from '../src/modules/m10-dashboard/index.js';
import { StateStore } from '../src/modules/m2-store/index.js';
import { TelemetryService } from '../src/modules/m13-telemetry/index.js';

// Ports come from start(0). A hand-picked base sits inside the OS ephemeral
// range (49152-65535 on macOS), so any concurrent listen(0) can be handed the
// same number and this suite loses the race with EADDRINUSE.

// ── fake OTLP collector ────────────────────────────────────────────────────────

interface FakeCollector {
  server: http.Server;
  port: number;
  responseStatus: number;
}

async function startCollector(responseStatus = 200): Promise<FakeCollector> {
  const collector: FakeCollector = {
    server: null as unknown as http.Server,
    port: 0,
    responseStatus,
  };
  await new Promise<void>((resolve) => {
    collector.server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => { body += c.toString(); });
      req.on('end', () => {
        res.writeHead(collector.responseStatus, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        void body; // consumed
      });
    });
    collector.server.listen(0, '127.0.0.1', () => {
      const addr = collector.server.address() as { port: number };
      collector.port = addr.port;
      resolve();
    });
  });
  return collector;
}

function stopCollector(c: FakeCollector): Promise<void> {
  return new Promise((resolve) => c.server.close(() => resolve()));
}

// ── helpers ────────────────────────────────────────────────────────────────────

interface Ctx {
  dash: DashboardAPI;
  port: number;
  store: StateStore;
  tmpDir: string;
}

async function setup(options: Record<string, unknown> = {}): Promise<Ctx> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'as-t438-'));
  const store = new StateStore(':memory:');
  await store.initialize();
  let port = 0;const dash = new DashboardAPI(store, options);
  await dash.start(0);
  port = dash.getPort();
  return { dash, port, store, tmpDir };
}

async function teardown(ctx: Ctx): Promise<void> {
  await ctx.dash.stop();
  await ctx.store.close();
  await fs.rm(ctx.tmpDir, { recursive: true, force: true });
}

async function postJSON(
  port: number,
  urlPath: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  let responseBody: unknown;
  try { responseBody = await res.json(); } catch { responseBody = null; }
  return { status: res.status, body: responseBody };
}

// ── tests ──────────────────────────────────────────────────────────────────────

describe('T438 — POST /telemetry/export-otlp', () => {
  let ctx: Ctx;
  let collector: FakeCollector;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
    if (collector) await stopCollector(collector);
  });

  it('1. returns 200 when telemetry configured and collector responds OK', async () => {
    collector = await startCollector(200);
    const telemetry = new TelemetryService();
    ctx = await setup({
      telemetry,
      roles: { 'admin-key': 'admin' },
    });
    const { status, body } = await postJSON(
      ctx.port,
      '/telemetry/export-otlp',
      { endpoint: `http://127.0.0.1:${collector.port}` },
      { 'X-API-Key': 'admin-key' },
    );
    expect(status).toBe(200);
    const b = body as { ok: boolean };
    expect(b.ok).toBe(true);
  });

  it('2. returns 503 when telemetry is not configured on DashboardAPI', async () => {
    ctx = await setup({
      roles: { 'admin-key': 'admin' },
    });
    const { status } = await postJSON(
      ctx.port,
      '/telemetry/export-otlp',
      { endpoint: 'http://127.0.0.1:9999' },
      { 'X-API-Key': 'admin-key' },
    );
    expect(status).toBe(503);
  });

  it('3. returns 400 when endpoint field is missing from body', async () => {
    const telemetry = new TelemetryService();
    ctx = await setup({
      telemetry,
      roles: { 'admin-key': 'admin' },
    });
    const { status } = await postJSON(
      ctx.port,
      '/telemetry/export-otlp',
      {},
      { 'X-API-Key': 'admin-key' },
    );
    expect(status).toBe(400);
  });

  it('4. returns 400 on invalid JSON body', async () => {
    const telemetry = new TelemetryService();
    ctx = await setup({
      telemetry,
      roles: { 'admin-key': 'admin' },
    });
    // Send raw non-JSON body
    const res = await fetch(`http://127.0.0.1:${ctx.port}/telemetry/export-otlp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'admin-key' },
      body: 'this is not json {{{',
    });
    expect(res.status).toBe(400);
  });

  it('5. returns 403 for viewer role (endpoint is admin-only)', async () => {
    const telemetry = new TelemetryService();
    ctx = await setup({
      telemetry,
      roles: { 'admin-key': 'admin', 'viewer-key': 'viewer' },
    });
    const { status } = await postJSON(
      ctx.port,
      '/telemetry/export-otlp',
      { endpoint: 'http://127.0.0.1:9999' },
      { 'X-API-Key': 'viewer-key' },
    );
    expect(status).toBe(403);
  });

  it('6. returns 502 when OTLP collector returns error status', async () => {
    collector = await startCollector(503);
    const telemetry = new TelemetryService();
    ctx = await setup({
      telemetry,
      roles: { 'admin-key': 'admin' },
    });
    const { status, body } = await postJSON(
      ctx.port,
      '/telemetry/export-otlp',
      { endpoint: `http://127.0.0.1:${collector.port}` },
      { 'X-API-Key': 'admin-key' },
    );
    expect(status).toBe(502);
    const b = body as { ok: boolean };
    expect(b.ok).toBe(false);
  });

  it('7. returns 400 when endpoint field is present but empty string', async () => {
    const telemetry = new TelemetryService();
    ctx = await setup({
      telemetry,
      roles: { 'admin-key': 'admin' },
    });
    const { status } = await postJSON(
      ctx.port,
      '/telemetry/export-otlp',
      { endpoint: '' },
      { 'X-API-Key': 'admin-key' },
    );
    expect(status).toBe(400);
  });

  it('8. response body contains statusCode from collector on success', async () => {
    collector = await startCollector(200);
    const telemetry = new TelemetryService();
    ctx = await setup({
      telemetry,
      roles: { 'admin-key': 'admin' },
    });
    const { body } = await postJSON(
      ctx.port,
      '/telemetry/export-otlp',
      { endpoint: `http://127.0.0.1:${collector.port}` },
      { 'X-API-Key': 'admin-key' },
    );
    const b = body as { ok: boolean; statusCode?: number };
    expect(b.statusCode).toBe(200);
  });
});
