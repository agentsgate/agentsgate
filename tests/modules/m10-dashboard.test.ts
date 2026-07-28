import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DashboardAPI, ApprovalQueue } from '../../src/modules/m10-dashboard/index.js';
import { StateStore } from '../../src/modules/m2-store/index.js';
import { OperationLogger } from '../../src/modules/m3-logger/index.js';
import { CheckpointEngine } from '../../src/modules/m4-checkpoint/index.js';
import { FileShadowSystem } from '../../src/modules/m5-shadow/index.js';
import { RollbackEngine } from '../../src/modules/m8-rollback/index.js';
import { RiskIntelligenceEngine } from '../../src/modules/m11-intelligence/index.js';
import { TelemetryService } from '../../src/modules/m13-telemetry/index.js';
import type { MCPOperation, ProxyDecision, RiskAssessment } from '../../src/types/interfaces.js';

async function get(port: number, path: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path }, res => {
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

async function post(port: number, path: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path }, res => {
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

function makeOp(id: string): MCPOperation {
  return {
    id, agentId: 'agent-1', tool: 'filesystem', method: 'read_file',
    params: { path: '/tmp/x.txt' }, timestamp: new Date(), sessionId: 'session-1',
  };
}
const allowDecision: ProxyDecision = { action: 'allow', riskScore: 0.05, reasons: ['L1_READ_ONLY'] };

describe('DashboardAPI', () => {
  let store: StateStore;
  let logger: OperationLogger;
  let api: DashboardAPI;
  let port: number;

  beforeEach(async () => {
    store = new StateStore(':memory:');
    await store.initialize();
    logger = new OperationLogger(store);
    api = new DashboardAPI(store);
    await api.start(0);
    const addr = (api as unknown as { server: http.Server }).server.address() as { port: number };
    port = addr.port;
  });

  afterEach(async () => {
    await api.stop();
    await store.close();
  });

  it('should start HTTP server on the given port', async () => {
    const { status, body } = await get(port, '/health');
    expect(status).toBe(200);
    expect((body as { status: string }).status).toBe('ok');
  });

  it('GET /operations should return paginated operation logs', async () => {
    await logger.log(makeOp('op-a'), allowDecision);
    await logger.log(makeOp('op-b'), allowDecision);

    const { status, body } = await get(port, '/operations?limit=10&offset=0');
    expect(status).toBe(200);
    const resp = body as { data: unknown[]; count: number };
    expect(resp.count).toBe(2);
    expect(resp.data).toHaveLength(2);
  });

  it('GET /operations/:id should return a single operation', async () => {
    await logger.log(makeOp('op-single'), allowDecision);

    const found = await get(port, '/operations/op-single');
    expect(found.status).toBe(200);
    expect((found.body as { operationId: string }).operationId).toBe('op-single');

    const notFound = await get(port, '/operations/ghost');
    expect(notFound.status).toBe(404);
  });

  it('GET /risk should return recent risk assessments', async () => {
    const assessment: RiskAssessment = {
      operationId: 'op-risk',
      staticScore: 0.05,
      userHistoryScore: -1,
      communityScore: -1,
      finalScore: 0.05,
      triggeredRules: ['L1_READ_ONLY'],
      assessedAt: new Date(),
    };
    await store.saveRiskAssessment(assessment);

    const { status, body } = await get(port, '/risk/op-risk');
    expect(status).toBe(200);
    expect((body as { operationId: string }).operationId).toBe('op-risk');

    const missing = await get(port, '/risk/unknown');
    expect(missing.status).toBe(404);
  });

  it('GET /checkpoints should return recent checkpoints', async () => {
    const { status, body } = await get(port, '/checkpoints');
    expect(status).toBe(200);
    expect((body as { count: number }).count).toBe(0);
  });

  it('should stop the server cleanly', async () => {
    await expect(api.stop()).resolves.toBeUndefined();
    await expect(api.stop()).resolves.toBeUndefined(); // idempotent
  });

  it('GET /telemetry returns 503 when not configured', async () => {
    const { status } = await get(port, '/telemetry');
    expect(status).toBe(503);
  });

  it('GET /telemetry returns stats when telemetry service is wired', async () => {
    const telemetry = new TelemetryService();
    await api.stop();
    const telApi = new DashboardAPI(store, { telemetry });
    await telApi.start(0);
    const telPort = (telApi as unknown as { server: import('node:http').Server }).server.address() as { port: number };

    await telemetry.record(
      { id: 'op-tel', agentId: 'a', tool: 'filesystem', method: 'read_file', params: {}, timestamp: new Date(), sessionId: 's' },
      { action: 'allow', riskScore: 0.05, reasons: [] }
    );

    const { status, body } = await get(telPort.port, '/telemetry');
    expect(status).toBe(200);
    expect((body as { totalEvents: number }).totalEvents).toBe(1);
    await telApi.stop();
  });

  it('GET /sessions groups operations by sessionId', async () => {
    const opA: MCPOperation = {
      id: 'op-s1a', agentId: 'agent-1', tool: 'filesystem', method: 'read_file',
      params: {}, timestamp: new Date(), sessionId: 'session-A',
    };
    const opB: MCPOperation = {
      id: 'op-s1b', agentId: 'agent-1', tool: 'filesystem', method: 'delete_file',
      params: {}, timestamp: new Date(), sessionId: 'session-A',
    };
    const opC: MCPOperation = {
      id: 'op-s2', agentId: 'agent-2', tool: 'github', method: 'read_file',
      params: {}, timestamp: new Date(), sessionId: 'session-B',
    };
    await logger.log(opA, allowDecision);
    await logger.log(opB, { action: 'block', riskScore: 0.9, reasons: [] });
    await logger.log(opC, allowDecision);

    const { status, body } = await get(port, '/sessions');
    expect(status).toBe(200);
    const resp = body as { data: Array<{ sessionId: string; operationCount: number; blocked: number }>; count: number };
    expect(resp.count).toBe(2);
    const sessA = resp.data.find(s => s.sessionId === 'session-A')!;
    expect(sessA.operationCount).toBe(2);
    expect(sessA.blocked).toBe(1);
  });
});

describe('DashboardAPI — approvals queue', () => {
  let store: StateStore;
  let queue: ApprovalQueue;
  let intelligence: RiskIntelligenceEngine;
  let api: DashboardAPI;
  let port: number;

  beforeEach(async () => {
    store = new StateStore(':memory:');
    await store.initialize();
    queue = new ApprovalQueue();
    intelligence = new RiskIntelligenceEngine();
    api = new DashboardAPI(store, { queue, intelligenceEngine: intelligence });
    await api.start(0);
    const addr = (api as unknown as { server: http.Server }).server.address() as { port: number };
    port = addr.port;
  });

  afterEach(async () => {
    await api.stop();
    await store.close();
  });

  it('GET /approvals/pending returns empty list initially', async () => {
    const { status, body } = await get(port, '/approvals/pending');
    expect(status).toBe(200);
    expect((body as { count: number }).count).toBe(0);
  });

  it('GET /approvals/pending lists queued operations', async () => {
    queue.enqueue(makeOp('op-pending'), 0.65, 'cp-123');
    const { status, body } = await get(port, '/approvals/pending');
    expect(status).toBe(200);
    const resp = body as { data: Array<{ id: string; checkpointId?: string }>; count: number };
    expect(resp.count).toBe(1);
    expect(resp.data[0].id).toBe('op-pending');
    expect(resp.data[0].checkpointId).toBe('cp-123');
  });

  it('restores queued approvals from the state store on initialize', async () => {
    await store.savePendingApproval({
      id: 'op-restored',
      operation: makeOp('op-restored'),
      riskScore: 0.55,
      checkpointId: 'cp-restored',
      queuedAt: new Date(),
    });

    const restoredQueue = new ApprovalQueue({ store });
    await restoredQueue.initialize();

    expect(restoredQueue.size).toBe(1);
    const { status, body } = await get(port, '/approvals/pending');
    expect(status).toBe(200);
    expect((body as { count: number }).count).toBe(0);

    await api.stop();
    api = new DashboardAPI(store, { queue: restoredQueue, intelligenceEngine: intelligence });
    await api.start(0);
    const addr = (api as unknown as { server: http.Server }).server.address() as { port: number };
    port = addr.port;

    const restored = await get(port, '/approvals/pending');
    expect(restored.status).toBe(200);
    expect((restored.body as { count: number }).count).toBe(1);
  });

  it('expires stale approvals during initialization and list access', async () => {
    await store.savePendingApproval({
      id: 'op-expired',
      operation: makeOp('op-expired'),
      riskScore: 0.5,
      checkpointId: 'cp-expired',
      queuedAt: new Date(Date.now() - 10_000),
    });

    const expiringQueue = new ApprovalQueue({ store, maxAgeMs: 1_000 });
    await expiringQueue.initialize();
    expect(expiringQueue.size).toBe(0);

    // Allow async store deletion to settle.
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(await store.listPendingApprovals()).toHaveLength(0);

    expiringQueue.enqueue(makeOp('op-fresh'), 0.65);
    expect(expiringQueue.size).toBe(1);

    await new Promise(resolve => setTimeout(resolve, 20));
    const shortLivedQueue = new ApprovalQueue({ maxAgeMs: 5 });
    shortLivedQueue.enqueue(makeOp('op-short-lived'), 0.65);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(shortLivedQueue.getPending()).toHaveLength(0);
  });

  it('POST /approvals/:id/approve resolves the approval and records outcome', async () => {
    queue.enqueue(makeOp('op-approve'), 0.65, 'cp-456');
    const { status, body } = await post(port, '/approvals/op-approve/approve');
    expect(status).toBe(200);
    expect((body as { verdict: string }).verdict).toBe('approved');
    // Removed from queue
    expect(queue.size).toBe(0);
    // Outcome recorded — too few for L2 score but count increments
    expect(intelligence.getOutcomeCount('agent-1', 'filesystem')).toBe(1);
    expect(await store.listPendingApprovals()).toHaveLength(0);
  });

  it('POST /approvals/:id/deny resolves the approval as denied', async () => {
    queue.enqueue(makeOp('op-deny'), 0.5);
    const { status, body } = await post(port, '/approvals/op-deny/deny');
    expect(status).toBe(200);
    expect((body as { verdict: string }).verdict).toBe('denied');
    expect(queue.size).toBe(0);
  });

  it('POST /approvals/:id/approve returns 404 for unknown ID', async () => {
    const { status } = await post(port, '/approvals/ghost/approve');
    expect(status).toBe(404);
  });
});

describe('ApprovalQueue webhook', () => {
  let webhookServer: http.Server;
  let capturedPayload: unknown;
  let webhookPort: number;

  async function startWebhook(): Promise<void> {
    return new Promise(resolve => {
      webhookServer = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          capturedPayload = JSON.parse(Buffer.concat(chunks).toString()) as unknown;
          res.writeHead(200);
          res.end();
        });
      });
      webhookServer.listen(0, () => {
        webhookPort = (webhookServer.address() as { port: number }).port;
        resolve();
      });
    });
  }

  afterEach(() => {
    webhookServer?.close();
  });

  it('fires a webhook POST when an operation is enqueued', async () => {
    await startWebhook();
    const queue = new ApprovalQueue({
      webhookUrl: `http://127.0.0.1:${webhookPort}/hook`,
      dashboardBaseUrl: 'http://localhost:4001',
      allowPrivateWebhookUrls: true,
    });

    queue.enqueue(makeOp('op-webhook'), 0.65, 'cp-webhook');

    // Wait up to 1s for the async webhook to arrive
    for (let i = 0; i < 20 && !capturedPayload; i++) {
      await new Promise(r => setTimeout(r, 50));
    }

    const p = capturedPayload as {
      event: string; id: string; riskScore: number;
      approveUrl: string; denyUrl: string;
    };
    expect(p.event).toBe('approval_required');
    expect(p.id).toBe('op-webhook');
    expect(p.riskScore).toBe(0.65);
    expect(p.approveUrl).toBe('http://localhost:4001/approvals/op-webhook/approve');
    expect(p.denyUrl).toBe('http://localhost:4001/approvals/op-webhook/deny');
  });

  it('does not throw when webhook URL is unreachable', async () => {
    const queue = new ApprovalQueue({ webhookUrl: 'http://127.0.0.1:19998/hook', allowPrivateWebhookUrls: true });
    // Should not throw — webhook failure is non-fatal
    expect(() => queue.enqueue(makeOp('op-safe'), 0.3)).not.toThrow();
    // Small delay to let the failed fetch settle
    await new Promise(r => setTimeout(r, 100));
  });
});

describe('DashboardAPI — rollback endpoints', () => {
  let store: StateStore;
  let shadow: FileShadowSystem;
  let checkpoints: CheckpointEngine;
  let rollback: RollbackEngine;
  let api: DashboardAPI;
  let port: number;
  let shadowDir: string;
  let workDir: string;

  beforeEach(async () => {
    shadowDir = await fs.mkdtemp(path.join(os.tmpdir(), 'as-dash-rb-'));
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'as-dash-wk-'));
    store = new StateStore(':memory:');
    await store.initialize();
    shadow = new FileShadowSystem();
    await shadow.initialize(shadowDir);
    checkpoints = new CheckpointEngine(store, shadow);
    rollback = new RollbackEngine(checkpoints, shadow);
    api = new DashboardAPI(store, { rollbackEngine: rollback });
    await api.start(0);
    const addr = (api as unknown as { server: http.Server }).server.address() as { port: number };
    port = addr.port;
  });

  afterEach(async () => {
    await api.stop();
    await store.close();
    await fs.rm(shadowDir, { recursive: true, force: true });
    await fs.rm(workDir, { recursive: true, force: true });
  });

  it('POST /rollback/:id returns 404 for unknown checkpoint', async () => {
    const { status } = await post(port, '/rollback/no-such-cp');
    expect(status).toBe(500); // success:false maps to 500
  });

  it('POST /rollback/:id rolls back a real file checkpoint', async () => {
    const filePath = path.join(workDir, 'test.txt');
    await fs.writeFile(filePath, 'original');

    const op: MCPOperation = {
      id: 'op-rbdash', agentId: 'agent-1', tool: 'filesystem', method: 'write_file',
      params: { path: filePath }, timestamp: new Date(), sessionId: 's1',
    };
    const cp = await checkpoints.create(op);

    // Simulate agent damage
    await fs.writeFile(filePath, 'damaged');

    const { status, body } = await post(port, `/rollback/${cp.id}`);
    expect(status).toBe(200);
    expect((body as { success: boolean }).success).toBe(true);
    expect(await fs.readFile(filePath, 'utf-8')).toBe('original');
  });

  it('GET /rollback/:id/preview returns file list without restoring', async () => {
    const filePath = path.join(workDir, 'preview.txt');
    await fs.writeFile(filePath, 'before');

    const op: MCPOperation = {
      id: 'op-preview', agentId: 'agent-1', tool: 'filesystem', method: 'write_file',
      params: { path: filePath }, timestamp: new Date(), sessionId: 's1',
    };
    const cp = await checkpoints.create(op);
    await fs.writeFile(filePath, 'after');

    const { status, body } = await get(port, `/rollback/${cp.id}/preview`);
    expect(status).toBe(200);
    expect((body as { restoredFiles: string[] }).restoredFiles).toContain(filePath);
    // File unchanged (preview only)
    expect(await fs.readFile(filePath, 'utf-8')).toBe('after');
  });
});
