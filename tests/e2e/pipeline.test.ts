/**
 * End-to-end integration tests for the full AgentsGate pipeline.
 *
 * These tests exercise the complete flow:
 *   MCPOperation → MCPProxy (with createPipeline) → RiskScoringEngine
 *     → InterventionController → CheckpointEngine → OperationLogger
 *     → RollbackEngine (file restore)
 *     → DashboardAPI (verify data surfaced)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { MCPProxy, createPipeline } from '../../src/modules/m1-proxy/index.js';
import { StateStore } from '../../src/modules/m2-store/index.js';
import { OperationLogger } from '../../src/modules/m3-logger/index.js';
import { CheckpointEngine } from '../../src/modules/m4-checkpoint/index.js';
import { FileShadowSystem } from '../../src/modules/m5-shadow/index.js';
import { RiskScoringEngine } from '../../src/modules/m6-risk/index.js';
import { InterventionController } from '../../src/modules/m7-intervention/index.js';
import { RollbackEngine } from '../../src/modules/m8-rollback/index.js';
import { DashboardAPI } from '../../src/modules/m10-dashboard/index.js';
import { TelemetryService } from '../../src/modules/m13-telemetry/index.js';
import type { MCPOperation, ProxyDecision } from '../../src/types/interfaces.js';
import { randomUUID } from 'node:crypto';

// ── Helpers ───────────────────────────────────────────────────────────────────

async function mkTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'as-e2e-'));
}

async function postOp(port: number, op: MCPOperation): Promise<ProxyDecision> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(op);
    const req = http.request(
      {
        host: '127.0.0.1', port, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString()) as ProxyDecision));
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

async function dashGet(port: number, p: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: p }, res => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString())));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

function makeOp(tool: string, method: string, params: Record<string, unknown> = {}): MCPOperation {
  return {
    id: randomUUID(),
    agentId: 'e2e-agent',
    tool,
    method,
    params,
    timestamp: new Date(),
    sessionId: 'e2e-session',
  };
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('AgentsGate E2E Pipeline', () => {
  let store: StateStore;
  let shadow: FileShadowSystem;
  let logger: OperationLogger;
  let checkpoints: CheckpointEngine;
  let riskEngine: RiskScoringEngine;
  let interventionController: InterventionController;
  let rollback: RollbackEngine;
  let telemetry: TelemetryService;
  let proxy: MCPProxy;
  let dashboard: DashboardAPI;
  let proxyPort: number;
  let dashPort: number;
  let shadowDir: string;
  let workDir: string;

  beforeEach(async () => {
    shadowDir = await mkTmpDir();
    workDir = await mkTmpDir();

    store = new StateStore(':memory:');
    await store.initialize();

    shadow = new FileShadowSystem();
    await shadow.initialize(shadowDir);

    logger = new OperationLogger(store);
    checkpoints = new CheckpointEngine(store, shadow);
    riskEngine = new RiskScoringEngine();
    interventionController = new InterventionController();
    rollback = new RollbackEngine(checkpoints, shadow);
    telemetry = new TelemetryService();

    // Wire the full pipeline (telemetry included)
    proxy = new MCPProxy(
      createPipeline({ riskEngine, interventionController, checkpointEngine: checkpoints, logger, telemetry })
    );
    await proxy.start(0);
    proxyPort = ((proxy as unknown as { server: http.Server }).server.address() as { port: number }).port;

    dashboard = new DashboardAPI(store);
    await dashboard.start(0);
    dashPort = ((dashboard as unknown as { server: http.Server }).server.address() as { port: number }).port;
  });

  afterEach(async () => {
    await proxy.stop();
    await dashboard.stop();
    await store.close();
    await fs.rm(shadowDir, { recursive: true, force: true });
    await fs.rm(workDir, { recursive: true, force: true });
  });

  // ── Scenario 1: Read operation is allowed ────────────────────────────────

  it('read_file operation is allowed through the full pipeline', async () => {
    const op = makeOp('filesystem', 'read_file', { path: '/tmp/notes.txt' });
    const decision = await postOp(proxyPort, op);

    expect(decision.action).toBe('allow');
    expect(decision.riskScore).toBeLessThan(0.3);
    expect(decision.reasons.some(r => r.includes('L1_READ_ONLY'))).toBe(true);
  });

  // ── Scenario 2: Delete operation is blocked ──────────────────────────────

  it('delete_file operation is blocked with risk score ≥ 0.7', async () => {
    const op = makeOp('filesystem', 'delete_file', { path: '/important/data.db' });
    const decision = await postOp(proxyPort, op);

    expect(decision.action).toBe('block');
    expect(decision.riskScore).toBeGreaterThanOrEqual(0.7);
    expect(decision.reasons.some(r => r.includes('L1_DELETE_FILE'))).toBe(true);
  });

  // ── Scenario 3: Sensitive path write is blocked ──────────────────────────

  it('write to .env file is blocked as sensitive path', async () => {
    const op = makeOp('filesystem', 'write_file', { path: '/app/.env', content: 'SECRET=x' });
    const decision = await postOp(proxyPort, op);

    expect(decision.action).toBe('block');
    expect(decision.reasons.some(r => r.includes('L1_SENSITIVE_PATH_WRITE'))).toBe(true);
  });

  // ── Scenario 4: Checkpoint is created for risky write + rollback works ───

  it('risky write triggers checkpoint; rollback restores file', async () => {
    const filePath = path.join(workDir, 'important.txt');
    await fs.writeFile(filePath, 'original content');

    // write_file scores ~0.65 (L1_OVERWRITE_FILE) → require_approval, score ≥ 0.3 triggers checkpoint
    const op = makeOp('filesystem', 'write_file', { path: filePath });
    const decision = await proxy.intercept(op);

    // Decision should be require_approval (score ~0.65) and a checkpoint ID should exist
    expect(decision.action).toBe('require_approval');
    expect(decision.checkpointId).toBeDefined();

    // Simulate the operation running and damaging the file
    await fs.writeFile(filePath, 'corrupted by agent');

    // Roll back to the checkpoint
    const result = await rollback.rollback({
      checkpointId: decision.checkpointId!,
      requestedBy: 'user',
      reason: 'e2e test rollback',
    });

    expect(result.success).toBe(true);
    expect(result.restoredFiles).toContain(filePath);
    expect(await fs.readFile(filePath, 'utf-8')).toBe('original content');
  });

  // ── Scenario 5: Operation logger + dashboard surfaces logged data ────────

  it('intercepted operations appear in the dashboard /operations endpoint', async () => {
    const op1 = makeOp('filesystem', 'read_file', { path: '/a.txt' });
    const op2 = makeOp('filesystem', 'delete_file', { path: '/b.txt' });
    await postOp(proxyPort, op1);
    await postOp(proxyPort, op2);

    const resp = await dashGet(dashPort, '/operations') as { data: unknown[]; count: number };
    expect(resp.count).toBe(2);
    expect(resp.data).toHaveLength(2);
  });

  // ── Scenario 6: Risk assessment stored and retrievable ───────────────────

  it('risk assessment is stored and accessible after an operation', async () => {
    const op = makeOp('database', 'drop_table', { table: 'users' });

    // Manually assess + persist so we can query it via dashboard
    const assessment = await riskEngine.assess(op);
    await store.saveRiskAssessment(assessment);

    const resp = await dashGet(dashPort, `/risk/${op.id}`) as { operationId: string; finalScore: number };
    expect(resp.operationId).toBe(op.id);
    expect(resp.finalScore).toBeGreaterThanOrEqual(0.9);
  });

  // ── Scenario 7: Telemetry aggregates pipeline events ────────────────────

  it('telemetry tracks events from the pipeline without PII', async () => {
    await postOp(proxyPort, makeOp('filesystem', 'read_file', { path: '/a.txt' }));
    await postOp(proxyPort, makeOp('filesystem', 'delete_file', { path: '/b.txt' }));

    const stats = await telemetry.getStats();
    expect(stats.totalEvents).toBe(2);
    expect(stats.byTool['filesystem']).toBe(2);
    expect(JSON.stringify(stats)).not.toContain('e2e-agent');
  });

  // ── Scenario 8: Rollback preview (dry-run) ───────────────────────────────

  it('rollback preview returns list of files without restoring them', async () => {
    const filePath = path.join(workDir, 'preview-file.txt');
    await fs.writeFile(filePath, 'before');

    const op = makeOp('filesystem', 'write_file', { path: filePath });
    const decision = await proxy.intercept(op);
    expect(decision.checkpointId).toBeDefined();

    await fs.writeFile(filePath, 'after');

    const preview = await rollback.preview({
      checkpointId: decision.checkpointId!,
      requestedBy: 'user',
      reason: 'preview',
    });

    expect(preview.restoredFiles).toContain(filePath);
    // File should still be 'after' — preview doesn't restore
    expect(await fs.readFile(filePath, 'utf-8')).toBe('after');
  });
});
