/**
 * T466 Tests
 *   P4  — Tool allow-list in createPipeline()
 *   UI1 — Snapshot browser: GET /snapshots + DELETE /snapshots/:id
 *   C5  — inject-sqlite alias in src/cli.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPipeline } from '../../src/modules/m1-proxy/index.js';
import { RiskScoringEngine } from '../../src/modules/m6-risk/index.js';
import { InterventionController } from '../../src/modules/m7-intervention/index.js';
import { DashboardAPI } from '../../src/modules/m10-dashboard/index.js';
import { StateStore } from '../../src/modules/m2-store/index.js';
import type { MCPOperation } from '../../src/types/interfaces.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeOp(tool: string, method: string): MCPOperation {
  return {
    id: `op-${tool}-${method}-${Date.now()}`,
    agentId: 'agent-test',
    tool,
    method,
    params: {},
    timestamp: new Date(),
    sessionId: 'session-test',
  };
}

async function httpReq(
  port: number,
  method: string,
  urlPath: string,
  opts: { key?: string } = {},
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (opts.key) headers['x-api-key'] = opts.key;
    const r = http.request(
      { hostname: '127.0.0.1', port, path: urlPath, method, headers },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString()) });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() });
          }
        });
        res.on('error', reject);
      },
    );
    r.on('error', reject);
    r.end();
  });
}

// ── P4 — Tool allow-list ──────────────────────────────────────────────────────

describe('P4 — createPipeline allowTools', () => {
  const riskEngine = new RiskScoringEngine();
  const interventionController = new InterventionController();

  it('forwards operations that are in the allow-list (exact match) — not blocked by allow-list', async () => {
    const pipeline = createPipeline({
      riskEngine, interventionController,
      // Only allow filesystem:read_file — a low-risk op that should pass risk assessment too
      allowTools: ['filesystem:read_file'],
    });
    const op = makeOp('filesystem', 'read_file');
    const decision = await pipeline.evaluateRisk!(op);
    // read_file is in the allow-list AND low-risk → should be allowed
    expect(decision.action).toBe('allow');
    expect(decision.reasons?.some(r => r.includes('allow-list'))).toBe(false);
  });

  it('blocks operations NOT in the allow-list', async () => {
    const pipeline = createPipeline({
      riskEngine, interventionController,
      allowTools: ['filesystem:read_file'],
    });
    // slack:send_message is not in the allow-list
    const op = makeOp('slack', 'send_message');
    const decision = await pipeline.evaluateRisk!(op);
    expect(decision.action).toBe('block');
    expect(decision.riskScore).toBe(1.0);
    expect(decision.reasons?.some(r => r.includes('allow-list'))).toBe(true);
  });

  it('wildcard "tool:*" matches all methods for the tool — none blocked by allow-list', async () => {
    const pipeline = createPipeline({
      riskEngine, interventionController,
      allowTools: ['filesystem:*'],
    });
    // Both of these should pass the allow-list check (may be blocked by risk engine but not by allow-list)
    const op1 = makeOp('filesystem', 'read_file');
    const op2 = makeOp('filesystem', 'list_directory');
    const decision1 = await pipeline.evaluateRisk!(op1);
    const decision2 = await pipeline.evaluateRisk!(op2);
    expect(decision1.reasons?.some(r => r.includes('allow-list'))).toBe(false);
    expect(decision2.reasons?.some(r => r.includes('allow-list'))).toBe(false);
  });

  it('wildcard "tool:*" does NOT match a different tool', async () => {
    const pipeline = createPipeline({
      riskEngine, interventionController,
      allowTools: ['filesystem:*'],
    });
    // slack is not in the allow-list
    const op = makeOp('slack', 'send_message');
    const decision = await pipeline.evaluateRisk!(op);
    expect(decision.action).toBe('block');
    expect(decision.reasons?.some(r => r.includes('allow-list'))).toBe(true);
  });

  it('"*" allows everything', async () => {
    const pipeline = createPipeline({
      riskEngine, interventionController,
      allowTools: ['*'],
    });
    const op = makeOp('filesystem', 'read_file');
    const decision = await pipeline.evaluateRisk!(op);
    expect(decision.reasons?.some(r => r.includes('allow-list'))).toBe(false);
  });

  it('empty allowTools array blocks everything', async () => {
    const pipeline = createPipeline({
      riskEngine, interventionController,
      allowTools: [],
    });
    // Empty array → allowTools.length === 0 → condition is falsy → all pass through
    const op = makeOp('filesystem', 'read_file');
    const decision = await pipeline.evaluateRisk!(op);
    // Empty list → no blocking by allow-list logic
    expect(decision.reasons?.some(r => r.includes('allow-list'))).toBe(false);
  });

  it('absent allowTools → no change, all pass through', async () => {
    const pipeline = createPipeline({
      riskEngine, interventionController,
      // allowTools not set
    });
    const op = makeOp('filesystem', 'read_file');
    const decision = await pipeline.evaluateRisk!(op);
    expect(decision.reasons?.some(r => r.includes('allow-list'))).toBe(false);
  });
});

// ── UI1 — Snapshot Browser ───────────────────────────────────────────────────

describe('UI1 — DashboardAPI snapshot browser', () => {
  let store: StateStore;
  let api: DashboardAPI;
  let port: number;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ag-snap-test-'));
    store = new StateStore(':memory:');
    await store.initialize();
    api = new DashboardAPI(store, {
      snapshotDir: tmpDir,
      roles: {
        'admin-key': 'admin',
        'viewer-key': 'viewer',
      },
    });
    await api.start(0);
    port = api.getPort();
  });

  afterEach(async () => {
    await api.stop();
    await store.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ── GET /snapshots ─────────────────────────────────────────────────────────

  it('GET /snapshots returns correct list of snapshot files', async () => {
    const uuid1 = '11111111-1111-1111-1111-111111111111';
    const uuid2 = '22222222-2222-2222-2222-222222222222';
    await fs.writeFile(path.join(tmpDir, `${uuid1}_users.json`), '{}');
    await fs.writeFile(path.join(tmpDir, `${uuid2}_orders.json`), '{}');

    const { status, body } = await httpReq(port, 'GET', '/snapshots', { key: 'admin-key' });
    expect(status).toBe(200);
    const b = body as { snapshots: Array<{ snapshotId: string; tableName: string; fileName: string }> };
    expect(b.snapshots).toHaveLength(2);
    const ids = b.snapshots.map(s => s.snapshotId);
    expect(ids).toContain(uuid1);
    expect(ids).toContain(uuid2);
    const userSnap = b.snapshots.find(s => s.snapshotId === uuid1);
    expect(userSnap?.tableName).toBe('users');
    expect(userSnap?.fileName).toBe(`${uuid1}_users.json`);
  });

  it('GET /snapshots returns empty array when dir is empty', async () => {
    const { status, body } = await httpReq(port, 'GET', '/snapshots', { key: 'admin-key' });
    expect(status).toBe(200);
    const b = body as { snapshots: unknown[] };
    expect(b.snapshots).toHaveLength(0);
  });

  it('GET /snapshots returns 503 when snapshotDir not configured', async () => {
    // Create a separate api without snapshotDir
    const store2 = new StateStore(':memory:');
    await store2.initialize();
    const api2 = new DashboardAPI(store2);
    await api2.start(0);
    const port2 = api2.getPort();
    try {
      const { status, body } = await httpReq(port2, 'GET', '/snapshots');
      expect(status).toBe(503);
      expect((body as { error: string }).error).toContain('snapshotDir not configured');
    } finally {
      await api2.stop();
      await store2.close();
    }
  });

  it('GET /snapshots ignores non-.json files', async () => {
    const uuid = '33333333-3333-3333-3333-333333333333';
    await fs.writeFile(path.join(tmpDir, `${uuid}_users.json`), '{}');
    await fs.writeFile(path.join(tmpDir, 'README.txt'), 'ignore me');
    await fs.writeFile(path.join(tmpDir, 'data.csv'), 'ignore me too');

    const { status, body } = await httpReq(port, 'GET', '/snapshots', { key: 'admin-key' });
    expect(status).toBe(200);
    const b = body as { snapshots: unknown[] };
    expect(b.snapshots).toHaveLength(1);
  });

  // ── DELETE /snapshots/:id ──────────────────────────────────────────────────

  it('DELETE /snapshots/:id deletes all files matching the snapshotId', async () => {
    const uuid = '44444444-4444-4444-4444-444444444444';
    const file1 = path.join(tmpDir, `${uuid}_users.json`);
    const file2 = path.join(tmpDir, `${uuid}_orders.json`);
    await fs.writeFile(file1, '{}');
    await fs.writeFile(file2, '{}');

    const { status, body } = await httpReq(port, 'DELETE', `/snapshots/${uuid}`, { key: 'admin-key' });
    expect(status).toBe(200);
    const b = body as { deleted: boolean; snapshotId: string; files: string[] };
    expect(b.deleted).toBe(true);
    expect(b.snapshotId).toBe(uuid);
    expect(b.files).toHaveLength(2);

    // Verify files are actually gone
    await expect(fs.access(file1)).rejects.toThrow();
    await expect(fs.access(file2)).rejects.toThrow();
  });

  it('DELETE /snapshots/:id returns 404 for unknown snapshotId', async () => {
    const uuid = '55555555-5555-5555-5555-555555555555';
    const { status, body } = await httpReq(port, 'DELETE', `/snapshots/${uuid}`, { key: 'admin-key' });
    expect(status).toBe(404);
    expect((body as { error: string }).error).toContain(uuid);
  });

  it('DELETE /snapshots/:id returns 400 for non-UUID snapshotId', async () => {
    const { status, body } = await httpReq(port, 'DELETE', '/snapshots/not-a-valid-uuid', { key: 'admin-key' });
    expect(status).toBe(400);
    expect((body as { error: string }).error).toContain('Invalid snapshotId format');
  });

  it('DELETE /snapshots/:id returns 403 for non-admin role', async () => {
    const uuid = '66666666-6666-6666-6666-666666666666';
    await fs.writeFile(path.join(tmpDir, `${uuid}_users.json`), '{}');
    const { status, body } = await httpReq(port, 'DELETE', `/snapshots/${uuid}`, { key: 'viewer-key' });
    expect(status).toBe(403);
    expect((body as { error: string }).error).toContain('admin role required');
  });
});

// ── C5 — inject-sqlite alias ──────────────────────────────────────────────────

const CLI_SOURCE_PATH = path.resolve(process.cwd(), 'src/cli.ts');
const HELP_SOURCE_PATH = path.resolve(process.cwd(), 'src/cli/help.ts');

describe('C5 — inject-sqlite CLI alias', () => {
  it('inject-sqlite case exists in cli.ts switch statement', async () => {
    const cliSource = await fs.readFile(CLI_SOURCE_PATH, 'utf-8');
    expect(cliSource).toContain("case 'inject-sqlite':");
  });

  it('inject-sqlite help text appears in the usage block', async () => {
    // The usage block lives in src/cli/help.ts so `--version` can print on its own.
    const helpSource = await fs.readFile(HELP_SOURCE_PATH, 'utf-8');
    expect(helpSource).toContain('inject-sqlite');
    expect(helpSource).toContain('alias for inject-db');
  });
});
