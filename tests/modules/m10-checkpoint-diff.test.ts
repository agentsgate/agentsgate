/**
 * T145 — Checkpoint diff endpoint tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DashboardAPI } from '../../src/modules/m10-dashboard/index.js';
import { StateStore } from '../../src/modules/m2-store/index.js';
import type { Checkpoint, FileSnapshot } from '../../src/types/interfaces.js';

async function get(port: number, p: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: p }, res => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString()) });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

describe('GET /checkpoints/:id/diff', () => {
  let tmpDir: string;
  let dbPath: string;
  let store: StateStore;
  let api: DashboardAPI;
  let port: number;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'as-diff-'));
    dbPath = path.join(tmpDir, 'test.db');
    store = new StateStore(dbPath);
    await store.initialize();
    api = new DashboardAPI(store);
    await api.start(0);
    port = (api as unknown as { server: http.Server }).server.address() as unknown as number;
    if (typeof port !== 'number') {
      port = ((api as unknown as { server: http.Server }).server.address() as { port: number }).port;
    }
  });

  afterEach(async () => {
    await api.stop();
    await store.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns 404 for unknown checkpoint', async () => {
    const r = await get(port, '/checkpoints/nonexistent/diff');
    expect(r.status).toBe(404);
  });

  it('returns unchanged status for unmodified file', async () => {
    // Create a real file and compute its hash
    const filePath = path.join(tmpDir, 'sample.txt');
    const content = 'hello checkpoint diff';
    await fs.writeFile(filePath, content);
    const contentHash = crypto.createHash('sha256').update(content).digest('hex');

    const snap: FileSnapshot = { path: filePath, contentHash, gitCommitSha: 'abc123' };
    const cp: Checkpoint = {
      id: 'cp-unchanged',
      operationId: 'op-1',
      type: 'pre_operation',
      fileSnapshots: [snap],
      createdAt: new Date(),
    };
    await store.saveCheckpoint(cp);

    const r = await get(port, `/checkpoints/cp-unchanged/diff`);
    expect(r.status).toBe(200);
    const body = r.body as { files: Array<{ path: string; status: string; snapshotHash: string; currentHash: string }>; summary: { unchanged: number; modified: number; missing: number } };
    expect(body.files).toHaveLength(1);
    expect(body.files[0].status).toBe('unchanged');
    expect(body.files[0].currentHash).toBe(contentHash);
    expect(body.summary.unchanged).toBe(1);
    expect(body.summary.modified).toBe(0);
    expect(body.summary.missing).toBe(0);
  });

  it('returns modified status for changed file', async () => {
    const filePath = path.join(tmpDir, 'modified.txt');
    await fs.writeFile(filePath, 'original content');
    const originalHash = crypto.createHash('sha256').update('original content').digest('hex');

    const snap: FileSnapshot = { path: filePath, contentHash: originalHash, gitCommitSha: 'def456' };
    const cp: Checkpoint = {
      id: 'cp-modified',
      operationId: 'op-2',
      type: 'pre_operation',
      fileSnapshots: [snap],
      createdAt: new Date(),
    };
    await store.saveCheckpoint(cp);

    // Modify the file after checkpoint
    await fs.writeFile(filePath, 'modified content');

    const r = await get(port, `/checkpoints/cp-modified/diff`);
    expect(r.status).toBe(200);
    const body = r.body as { files: Array<{ status: string; currentHash: string }>; summary: { modified: number } };
    expect(body.files[0].status).toBe('modified');
    const newHash = crypto.createHash('sha256').update('modified content').digest('hex');
    expect(body.files[0].currentHash).toBe(newHash);
    expect(body.summary.modified).toBe(1);
  });

  it('returns missing status for deleted file', async () => {
    const filePath = path.join(tmpDir, 'deleted.txt');
    const snap: FileSnapshot = { path: filePath, contentHash: 'deadbeef', gitCommitSha: 'ghi789' };
    const cp: Checkpoint = {
      id: 'cp-missing',
      operationId: 'op-3',
      type: 'pre_operation',
      fileSnapshots: [snap],
      createdAt: new Date(),
    };
    await store.saveCheckpoint(cp);
    // File never created — should be missing

    const r = await get(port, `/checkpoints/cp-missing/diff`);
    expect(r.status).toBe(200);
    const body = r.body as { files: Array<{ status: string; currentHash?: string }>; summary: { missing: number } };
    expect(body.files[0].status).toBe('missing');
    expect(body.files[0].currentHash).toBeUndefined();
    expect(body.summary.missing).toBe(1);
  });

  it('returns correct summary with mixed file statuses', async () => {
    const f1 = path.join(tmpDir, 'a.txt');
    const f2 = path.join(tmpDir, 'b.txt');
    const f3 = path.join(tmpDir, 'c.txt');
    await fs.writeFile(f1, 'aaa');
    await fs.writeFile(f2, 'bbb');
    const hash1 = crypto.createHash('sha256').update('aaa').digest('hex');
    const hash2 = crypto.createHash('sha256').update('bbb').digest('hex');

    const cp: Checkpoint = {
      id: 'cp-mixed',
      operationId: 'op-4',
      type: 'pre_operation',
      fileSnapshots: [
        { path: f1, contentHash: hash1, gitCommitSha: 's1' },
        { path: f2, contentHash: 'old-hash', gitCommitSha: 's2' },
        { path: f3, contentHash: 'deadbeef', gitCommitSha: 's3' },
      ],
      createdAt: new Date(),
    };
    await store.saveCheckpoint(cp);

    const r = await get(port, `/checkpoints/cp-mixed/diff`);
    expect(r.status).toBe(200);
    const body = r.body as { summary: { total: number; unchanged: number; modified: number; missing: number } };
    expect(body.summary.total).toBe(3);
    expect(body.summary.unchanged).toBe(1);
    expect(body.summary.modified).toBe(1);
    expect(body.summary.missing).toBe(1);
  });

  it('returns checkpoint metadata alongside diff', async () => {
    const cp: Checkpoint = {
      id: 'cp-meta',
      operationId: 'op-meta-1',
      type: 'pre_operation',
      fileSnapshots: [],
      createdAt: new Date(),
    };
    await store.saveCheckpoint(cp);

    const r = await get(port, `/checkpoints/cp-meta/diff`);
    expect(r.status).toBe(200);
    const body = r.body as { checkpointId: string; operationId: string; files: unknown[] };
    expect(body.checkpointId).toBe('cp-meta');
    expect(body.operationId).toBe('op-meta-1');
    expect(body.files).toHaveLength(0);
  });
});
