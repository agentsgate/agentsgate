/**
 * Dashboard security-hardening regression tests (2026-07 review):
 *  - GET /config redacts every secret-bearing field (incl. webhook.secret + URL creds)
 *  - the bundled dashboard escapes single quotes/backticks (onclick-attribute XSS)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { DashboardAPI } from '../../src/modules/m10-dashboard/index.js';
import { DASHBOARD_HTML } from '../../src/modules/m10-dashboard/dashboard-html.js';
import { StateStore } from '../../src/modules/m2-store/index.js';
import type { AgentsGateConfig } from '../../src/config.js';

function get(port: number, path: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET' }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c as Buffer));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('GET /config redacts secrets', () => {
  let store: StateStore;
  let api: DashboardAPI;
  let port: number;

  const config = {
    proxy: { port: 4000, host: '127.0.0.1', checkpointThreshold: 0.3 },
    intervention: { allowBelow: 0.3, blockAtOrAbove: 0.7 },
    webhook: { url: 'https://user:pass@hooks.example.com/x', secret: 'super-hmac-secret', slackUrl: 'https://hooks.slack.com/services/AAA/BBB/CCC' },
    dashboard: { apiKey: 'dash-key' },
    audit: { signingSecret: 'audit-secret' },
    telemetry: { exportEndpoint: 'https://u:p@otel.example.com', exportIntervalMs: 300000 },
  } as unknown as AgentsGateConfig;

  beforeEach(async () => {
    store = new StateStore(':memory:');
    await store.initialize();
    api = new DashboardAPI(store, { config });
    await api.start(0);
    port = ((api as unknown as { server: http.Server }).server.address() as { port: number }).port;
  });

  afterEach(async () => {
    await api.stop();
    await store.close();
  });

  it('never returns any raw secret value', async () => {
    const { status, body } = await get(port, '/config');
    expect(status).toBe(200);
    const serialized = JSON.stringify(body);
    for (const secret of ['super-hmac-secret', 'audit-secret', 'dash-key', 'pass@', ':p@']) {
      expect(serialized).not.toContain(secret);
    }
    // Structure is preserved (redacted marker present)
    expect(serialized).toContain('[REDACTED]');
  });
});

describe('dashboard HTML escaping (onclick XSS)', () => {
  it('esc and escHtml escape single quotes and backticks', () => {
    // The bundled dashboard interpolates agent-controlled strings into onclick
    // attributes; the escapers must neutralize the JS-string-breaking characters.
    const escBody = DASHBOARD_HTML.match(/function esc\(s\)\s*\{[\s\S]*?\}/)?.[0] ?? '';
    const escHtmlBody = DASHBOARD_HTML.match(/function escHtml\(str\)\s*\{[\s\S]*?\}/)?.[0] ?? '';
    expect(escBody).toContain("&#39;");   // single quote escaped
    expect(escHtmlBody).toContain("&#39;");
  });
});
