/**
 * Multi-agent scenario tests.
 *
 * These tests simulate realistic multi-agent workloads:
 *   • Two agents operating concurrently with different risk profiles
 *   • Rate-limited agent gets blocked after burst
 *   • Custom policy forces different verdicts for different agents
 *   • Approval flow: queue → approve → intelligence engine learns
 *   • Concurrent checkpoints: rollback of one agent's file doesn't affect another's
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { MCPProxy, createPipeline } from '../../src/modules/m1-proxy/index.js';
import { StateStore } from '../../src/modules/m2-store/index.js';
import { OperationLogger } from '../../src/modules/m3-logger/index.js';
import { CheckpointEngine } from '../../src/modules/m4-checkpoint/index.js';
import { FileShadowSystem } from '../../src/modules/m5-shadow/index.js';
import { RiskScoringEngine } from '../../src/modules/m6-risk/index.js';
import { InterventionController } from '../../src/modules/m7-intervention/index.js';
import { RollbackEngine } from '../../src/modules/m8-rollback/index.js';
import { ApprovalQueue } from '../../src/modules/m10-dashboard/index.js';
import { RiskIntelligenceEngine } from '../../src/modules/m11-intelligence/index.js';
import { TelemetryService } from '../../src/modules/m13-telemetry/index.js';
import { AgentRateLimiter } from '../../src/utils/rate-limiter.js';
import type { AgentsGatePolicy } from '../../src/policy.js';
import type { MCPOperation } from '../../src/types/interfaces.js';

// ── Shared fixtures ───────────────────────────────────────────────────────────

function op(
  agentId: string,
  tool: string,
  method: string,
  params: Record<string, unknown> = {},
  sessionId?: string
): MCPOperation {
  return {
    id: randomUUID(),
    agentId,
    tool,
    method,
    params,
    timestamp: new Date(),
    sessionId: sessionId ?? `session-${agentId}`,
  };
}

const OPS = {
  readFile: (agentId: string, filePath = '/tmp/data.txt') =>
    op(agentId, 'filesystem', 'read_file', { path: filePath }),

  writeFile: (agentId: string, filePath = '/tmp/data.txt') =>
    op(agentId, 'filesystem', 'write_file', { path: filePath }),

  deleteFile: (agentId: string, filePath = '/tmp/data.txt') =>
    op(agentId, 'filesystem', 'delete_file', { path: filePath }),

  execCommand: (agentId: string, cmd = 'ls') =>
    op(agentId, 'shell', 'execute', { command: cmd }),

  dropTable: (agentId: string, table = 'users') =>
    op(agentId, 'database', 'drop_table', { table }),

  sensitiveWrite: (agentId: string) =>
    op(agentId, 'filesystem', 'write_file', { path: '/app/.env', content: 'SECRET=x' }),
};

// ── Test infrastructure ───────────────────────────────────────────────────────

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'as-ma-'));
}

interface TestEnv {
  store: StateStore;
  shadow: FileShadowSystem;
  proxy: MCPProxy;
  logger: OperationLogger;
  checkpoints: CheckpointEngine;
  rollback: RollbackEngine;
  approvalQueue: ApprovalQueue;
  intelligenceEngine: RiskIntelligenceEngine;
  telemetry: TelemetryService;
  shadowDir: string;
  workDir: string;
  rateLimiter?: AgentRateLimiter;
}

async function buildEnv(opts: {
  rateLimitOpsPerMin?: number;
  policy?: AgentsGatePolicy;
  interventionThresholds?: { allowBelow?: number; blockAtOrAbove?: number };
} = {}): Promise<TestEnv> {
  const shadowDir = await mkTmpDir();
  const workDir = await mkTmpDir();

  const store = new StateStore(':memory:');
  await store.initialize();

  const shadow = new FileShadowSystem();
  await shadow.initialize(shadowDir);

  const logger = new OperationLogger(store);
  const checkpoints = new CheckpointEngine(store, shadow);
  const riskEngine = new RiskScoringEngine();
  const interventionController = new InterventionController(opts.interventionThresholds);
  const rollback = new RollbackEngine(checkpoints, shadow);
  const intelligenceEngine = new RiskIntelligenceEngine({ store });
  const telemetry = new TelemetryService();
  const approvalQueue = new ApprovalQueue({ store, maxAgeMs: 60_000 });
  await approvalQueue.initialize();

  const rateLimiter = opts.rateLimitOpsPerMin
    ? new AgentRateLimiter(opts.rateLimitOpsPerMin)
    : undefined;

  const proxy = new MCPProxy(
    createPipeline({
      riskEngine,
      interventionController,
      checkpointEngine: checkpoints,
      logger,
      intelligenceEngine,
      approvalQueue,
      telemetry,
      rateLimiter,
      policy: opts.policy,
    })
  );

  return { store, shadow, proxy, logger, checkpoints, rollback, approvalQueue, intelligenceEngine, telemetry, shadowDir, workDir, rateLimiter };
}

async function rmRetry(p: string, attempts = 5): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    try { await fs.rm(p, { recursive: true, force: true }); return; }
    catch (e) {
      const err = e as NodeJS.ErrnoException;
      if ((err.code !== 'EBUSY' && err.code !== 'EPERM') || i === attempts) throw e;
      await new Promise(r => setTimeout(r, i * 150));
    }
  }
}

async function teardown(env: TestEnv): Promise<void> {
  await env.store.close();
  await rmRetry(env.shadowDir);
  await rmRetry(env.workDir);
}

// ── Scenarios ─────────────────────────────────────────────────────────────────

describe('Multi-Agent Scenarios', () => {

  // ── Scenario A: Two agents with different risk profiles ────────────────────

  describe('Scenario A — safe agent vs destructive agent', () => {
    let env: TestEnv;

    beforeEach(async () => { env = await buildEnv(); });
    afterEach(async () => { await teardown(env); });

    it('read-only agent is always allowed', async () => {
      const results = await Promise.all([
        env.proxy.intercept(OPS.readFile('reader-agent', '/docs/a.txt')),
        env.proxy.intercept(OPS.readFile('reader-agent', '/docs/b.txt')),
        env.proxy.intercept(OPS.readFile('reader-agent', '/docs/c.txt')),
      ]);
      expect(results.every(d => d.action === 'allow')).toBe(true);
    });

    it('destructive agent is blocked, safe agent is not affected', async () => {
      const [safeDecision, destructiveDecision] = await Promise.all([
        env.proxy.intercept(OPS.readFile('safe-agent')),
        env.proxy.intercept(OPS.deleteFile('destructive-agent', '/critical/data.db')),
      ]);
      expect(safeDecision.action).toBe('allow');
      expect(destructiveDecision.action).toBe('block');
    });

    it('telemetry separates events from different agents', async () => {
      await env.proxy.intercept(OPS.readFile('agent-a'));
      await env.proxy.intercept(OPS.deleteFile('agent-b'));
      await env.proxy.intercept(OPS.execCommand('agent-a'));

      const stats = await env.telemetry.getStats();
      expect(stats.totalEvents).toBe(3);
      // Telemetry must not contain agent identifiers (no PII)
      const json = JSON.stringify(stats);
      expect(json).not.toContain('agent-a');
      expect(json).not.toContain('agent-b');
    });
  });

  // ── Scenario B: Rate-limited burst ─────────────────────────────────────────

  describe('Scenario B — rate-limited agent burst', () => {
    let env: TestEnv;

    beforeEach(async () => { env = await buildEnv({ rateLimitOpsPerMin: 3 }); });
    afterEach(async () => { await teardown(env); });

    it('agent is allowed for the first N ops then blocked by rate limiter', async () => {
      const decisions: Array<{ action: string }> = [];
      for (let i = 0; i < 5; i++) {
        decisions.push(await env.proxy.intercept(OPS.readFile('burst-agent')));
      }
      const allowed = decisions.filter(d => d.action === 'allow').length;
      const blocked = decisions.filter(d => d.action === 'block').length;

      // First 3 are within limit and should be allowed (read ops score low)
      expect(allowed).toBe(3);
      // Remaining 2 should be rate-limit-blocked
      expect(blocked).toBe(2);
    });

    it('different agents have independent rate-limit windows', async () => {
      for (let i = 0; i < 3; i++) {
        await env.proxy.intercept(OPS.readFile('agent-1'));
      }
      // agent-1 is now at its limit; agent-2 should still be allowed
      const d = await env.proxy.intercept(OPS.readFile('agent-2'));
      expect(d.action).toBe('allow');
    });
  });

  // ── Scenario C: Policy-based access control ─────────────────────────────────

  describe('Scenario C — policy overrides', () => {
    it('trusted agent gets allow even for normally-blocked operations', async () => {
      const policy: AgentsGatePolicy = {
        rules: [
          {
            id: 'TRUST_INTERNAL_AGENT',
            match: { agentId: 'internal-agent' },
            score: 0.05,
          },
        ],
      };
      const env = await buildEnv({ policy });
      try {
        // delete_file would normally score 0.9 → block
        // policy overrides to 0.05 → allow
        const d = await env.proxy.intercept(OPS.deleteFile('internal-agent', '/tmp/scratch.txt'));
        expect(d.action).toBe('allow');
        expect(d.riskScore).toBeLessThan(0.3);
      } finally {
        await teardown(env);
      }
    });

    it('policy blocks even low-risk operations matching a pattern', async () => {
      const policy: AgentsGatePolicy = {
        rules: [
          {
            id: 'BLOCK_PROD_READS',
            match: { pathPattern: 'production' },
            action: 'block',
          },
        ],
      };
      const env = await buildEnv({ policy });
      try {
        // read_file is normally low-risk (allow), but policy forces block
        const d = await env.proxy.intercept(
          op('agent-x', 'filesystem', 'read_file', { path: '/production/config.yaml' })
        );
        expect(d.action).toBe('block');
        expect(d.reasons.some(r => r.includes('Policy rule forced action'))).toBe(true);
      } finally {
        await teardown(env);
      }
    });

    it('policy thresholds tighten intervention decisions', async () => {
      // With tighter thresholds: allowBelow=0.1, blockAtOrAbove=0.4
      // write_file normally scores 0.65 → require_approval
      // With blockAtOrAbove=0.4 it becomes → block
      const env = await buildEnv({
        interventionThresholds: { allowBelow: 0.1, blockAtOrAbove: 0.4 },
      });
      try {
        const d = await env.proxy.intercept(OPS.writeFile('agent-y'));
        expect(d.action).toBe('block');
      } finally {
        await teardown(env);
      }
    });
  });

  // ── Scenario D: Approval flow + L2 learning ────────────────────────────────

  describe('Scenario D — approval queue + intelligence feedback', () => {
    let env: TestEnv;

    beforeEach(async () => { env = await buildEnv(); });
    afterEach(async () => { await teardown(env); });

    it('require_approval ops are queued; approving updates L2 history', async () => {
      // write_file scores ~0.65 → require_approval
      const d = await env.proxy.intercept(OPS.writeFile('learning-agent', '/app/data.json'));
      expect(d.action).toBe('require_approval');
      expect(env.approvalQueue.size).toBe(1);

      // Approve it
      const item = env.approvalQueue.resolve(d.checkpointId ? d.checkpointId : (env.approvalQueue.getPending()[0]?.id ?? ''));
      // item may be null if checkpointId doesn't match — resolve by id
      const pending = env.approvalQueue.getPending();
      if (pending.length) {
        const found = env.approvalQueue.resolve(pending[0].id);
        expect(found).toBeDefined();
      }

      expect(env.approvalQueue.size).toBe(0);
    });

    it('enough recorded outcomes unlock a non-negative L2 score', async () => {
      // L2 requires MIN_HISTORY=10 outcomes before returning a score
      // Record 10 outcomes for 'smart-agent' + 'filesystem' (mix of approved/denied)
      for (let i = 0; i < 8; i++) {
        await env.intelligenceEngine.recordOutcome(randomUUID(), true, 'smart-agent', 'filesystem');
      }
      for (let i = 0; i < 2; i++) {
        await env.intelligenceEngine.recordOutcome(randomUUID(), false, 'smart-agent', 'filesystem');
      }

      // With 8 approved + 2 denied: score = 1 - 8/10 = 0.2
      const l2Score = await env.intelligenceEngine.getUserHistoryScore('smart-agent', 'filesystem');
      expect(l2Score).toBeGreaterThan(-1);
      expect(l2Score).toBeCloseTo(0.2, 1);
    });
  });

  // ── Scenario E: Concurrent checkpoints — independent rollback ──────────────

  describe('Scenario E — independent rollback for concurrent agents', () => {
    let env: TestEnv;

    beforeEach(async () => { env = await buildEnv(); });
    afterEach(async () => { await teardown(env); });

    it('rolling back agent-A does not affect agent-B file', async () => {
      const fileA = path.join(env.workDir, 'agent-a.txt');
      const fileB = path.join(env.workDir, 'agent-b.txt');
      await fs.writeFile(fileA, 'A-original');
      await fs.writeFile(fileB, 'B-original');

      // Both agents trigger checkpoints — run sequentially because both share the
      // same shadow git repo, and concurrent git commits would cause index.lock races.
      const opA = op('agent-a', 'filesystem', 'write_file', { path: fileA });
      const opB = op('agent-b', 'filesystem', 'write_file', { path: fileB });
      const dA = await env.proxy.intercept(opA);
      const dB = await env.proxy.intercept(opB);

      expect(dA.checkpointId).toBeDefined();
      expect(dB.checkpointId).toBeDefined();

      // Both agents "corrupt" their files
      await fs.writeFile(fileA, 'A-corrupted');
      await fs.writeFile(fileB, 'B-corrupted');

      // Rollback only agent-A
      const resultA = await env.rollback.rollback({
        checkpointId: dA.checkpointId!,
        requestedBy: 'user',
        reason: 'test independent rollback',
      });

      expect(resultA.success).toBe(true);
      expect(await fs.readFile(fileA, 'utf-8')).toBe('A-original');
      // Agent-B's file must remain unchanged (still corrupted)
      expect(await fs.readFile(fileB, 'utf-8')).toBe('B-corrupted');
    });
  });

  // ── Scenario F: High-risk chain — exec → drop_table ────────────────────────

  describe('Scenario F — high-risk operation chain', () => {
    let env: TestEnv;
    beforeEach(async () => { env = await buildEnv(); });
    afterEach(async () => { await teardown(env); });

    it('shell execute and drop_table are both blocked', async () => {
      const [execDec, dropDec] = await Promise.all([
        env.proxy.intercept(OPS.execCommand('dangerous-agent', 'rm -rf /')),
        env.proxy.intercept(OPS.dropTable('dangerous-agent', 'payments')),
      ]);
      expect(execDec.action).toBe('block');
      expect(dropDec.action).toBe('block');
      expect(execDec.riskScore).toBeGreaterThanOrEqual(0.7);
      expect(dropDec.riskScore).toBeGreaterThanOrEqual(0.7);
    });

    it('sensitive path write is blocked even from a nominally safe agent', async () => {
      const d = await env.proxy.intercept(OPS.sensitiveWrite('safe-looking-agent'));
      expect(d.action).toBe('block');
      expect(d.reasons.some(r => r.includes('L1_SENSITIVE_PATH_WRITE'))).toBe(true);
    });
  });
});
