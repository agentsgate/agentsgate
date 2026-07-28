import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StateStore } from '../../src/modules/m2-store/index.js';
import type { OperationLog, Checkpoint, RiskAssessment } from '../../src/types/interfaces.js';

// Helpers

function makeLog(id: string): OperationLog {
  return {
    operationId: id,
    operation: {
      id,
      agentId: 'agent-1',
      tool: 'filesystem',
      method: 'write_file',
      params: { path: '/tmp/test.txt', content: 'hello' },
      timestamp: new Date('2026-01-01T00:00:00Z'),
      sessionId: 'session-1',
    },
    decision: {
      action: 'allow',
      riskScore: 0.1,
      reasons: ['low risk'],
    },
    createdAt: new Date('2026-01-01T00:00:00Z'),
  };
}

function makeCheckpoint(id: string, operationId: string): Checkpoint {
  return {
    id,
    operationId,
    type: 'pre_operation',
    fileSnapshots: [
      { path: '/tmp/test.txt', contentHash: 'abc123', gitCommitSha: 'sha1abc' },
    ],
    createdAt: new Date('2026-01-01T00:01:00Z'),
  };
}

function makeAssessment(operationId: string): RiskAssessment {
  return {
    operationId,
    staticScore: 0.2,
    userHistoryScore: 0.1,
    communityScore: -1,
    finalScore: 0.15,
    triggeredRules: ['write_file'],
    assessedAt: new Date('2026-01-01T00:00:01Z'),
  };
}

// Tests

describe('StateStore', () => {
  let store: StateStore;

  beforeEach(async () => {
    store = new StateStore(':memory:');
    await store.initialize();
  });

  afterEach(async () => {
    await store.close();
  });

  it('should initialize and create schema on first run', async () => {
    // initialize() runs in beforeEach — if we get here without throw, schema is created
    // Verify by doing a round-trip on each table
    const log = makeLog('op-init');
    await expect(store.saveOperationLog(log)).resolves.toBeUndefined();
  });

  it('should save and retrieve an OperationLog', async () => {
    const log = makeLog('op-1');
    await store.saveOperationLog(log);

    const retrieved = await store.getOperationLog('op-1');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.operationId).toBe('op-1');
    expect(retrieved!.operation.tool).toBe('filesystem');
    expect(retrieved!.operation.timestamp).toBeInstanceOf(Date);
    expect(retrieved!.createdAt).toBeInstanceOf(Date);
    expect(retrieved!.createdAt.toISOString()).toBe('2026-01-01T00:00:00.000Z');

    const missing = await store.getOperationLog('does-not-exist');
    expect(missing).toBeNull();
  });

  it('should list operation logs with pagination', async () => {
    await store.saveOperationLog(makeLog('op-a'));
    await store.saveOperationLog(makeLog('op-b'));
    await store.saveOperationLog(makeLog('op-c'));

    const all = await store.listOperationLogs();
    expect(all).toHaveLength(3);

    const page1 = await store.listOperationLogs(2, 0);
    expect(page1).toHaveLength(2);

    const page2 = await store.listOperationLogs(2, 2);
    expect(page2).toHaveLength(1);

    const empty = await store.listOperationLogs(10, 100);
    expect(empty).toHaveLength(0);
  });

  it('should save and retrieve a Checkpoint', async () => {
    const cp = makeCheckpoint('cp-1', 'op-1');
    await store.saveCheckpoint(cp);

    const retrieved = await store.getCheckpoint('cp-1');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe('cp-1');
    expect(retrieved!.operationId).toBe('op-1');
    expect(retrieved!.fileSnapshots).toHaveLength(1);
    expect(retrieved!.fileSnapshots[0].path).toBe('/tmp/test.txt');
    expect(retrieved!.createdAt).toBeInstanceOf(Date);

    const missing = await store.getCheckpoint('does-not-exist');
    expect(missing).toBeNull();
  });

  it('should save and retrieve a RiskAssessment', async () => {
    const assessment = makeAssessment('op-1');
    await store.saveRiskAssessment(assessment);

    const retrieved = await store.getRiskAssessment('op-1');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.operationId).toBe('op-1');
    expect(retrieved!.finalScore).toBe(0.15);
    expect(retrieved!.triggeredRules).toEqual(['write_file']);
    expect(retrieved!.assessedAt).toBeInstanceOf(Date);

    const missing = await store.getRiskAssessment('does-not-exist');
    expect(missing).toBeNull();
  });

  it('should close without error', async () => {
    await expect(store.close()).resolves.toBeUndefined();
    // Double close should also be safe
    await expect(store.close()).resolves.toBeUndefined();
  });

  it('should save and list outcome records for L2 persistence', async () => {
    await store.saveOutcomeRecord('op-1', 'agent-a', 'filesystem', true);
    await store.saveOutcomeRecord('op-2', 'agent-a', 'filesystem', false);
    await store.saveOutcomeRecord('op-3', 'agent-b', 'filesystem', true);

    const aRecords = await store.listOutcomeRecords('agent-a', 'filesystem');
    expect(aRecords).toHaveLength(2);
    expect(aRecords[0].wasApproved).toBe(true);
    expect(aRecords[1].wasApproved).toBe(false);

    // Different agent should be isolated
    const bRecords = await store.listOutcomeRecords('agent-b', 'filesystem');
    expect(bRecords).toHaveLength(1);
    expect(bRecords[0].operationId).toBe('op-3');

    // Unknown agent should return empty
    const cRecords = await store.listOutcomeRecords('agent-z', 'filesystem');
    expect(cRecords).toHaveLength(0);
  });

  it('listOperationLogs filters by action', async () => {
    const allowLog = makeLog('op-allow');
    const blockLog = { ...makeLog('op-block'), decision: { action: 'block' as const, riskScore: 0.9, reasons: [] } };
    await store.saveOperationLog(allowLog);
    await store.saveOperationLog(blockLog);

    const blocked = await store.listOperationLogs(10, 0, { action: 'block' });
    expect(blocked).toHaveLength(1);
    expect(blocked[0].operationId).toBe('op-block');

    const allowed = await store.listOperationLogs(10, 0, { action: 'allow' });
    expect(allowed).toHaveLength(1);
    expect(allowed[0].operationId).toBe('op-allow');
  });

  it('listOperationLogs filters by tool', async () => {
    await store.saveOperationLog(makeLog('op-fs'));
    const githubLog = { ...makeLog('op-gh'), operation: { ...makeLog('op-gh').operation, tool: 'github' } };
    await store.saveOperationLog(githubLog);

    const fsLogs = await store.listOperationLogs(10, 0, { tool: 'filesystem' });
    expect(fsLogs).toHaveLength(1);
    expect(fsLogs[0].operationId).toBe('op-fs');
  });

  it('outcome records are idempotent (same operationId replaces)', async () => {
    await store.saveOutcomeRecord('op-dup', 'agent-a', 'filesystem', true);
    await store.saveOutcomeRecord('op-dup', 'agent-a', 'filesystem', false); // replace
    const records = await store.listOutcomeRecords('agent-a', 'filesystem');
    expect(records).toHaveLength(1);
    expect(records[0].wasApproved).toBe(false);
  });

  it('should persist and remove pending approvals', async () => {
    await store.savePendingApproval({
      id: 'approval-1',
      operation: {
        id: 'op-approval-1',
        agentId: 'agent-1',
        tool: 'filesystem',
        method: 'write_file',
        params: { path: '/tmp/a.txt' },
        timestamp: new Date('2026-01-01T00:00:02Z'),
        sessionId: 'session-1',
      },
      riskScore: 0.65,
      checkpointId: 'cp-approval-1',
      queuedAt: new Date('2026-01-01T00:00:03Z'),
    });

    const approvals = await store.listPendingApprovals();
    expect(approvals).toHaveLength(1);
    expect(approvals[0].id).toBe('approval-1');
    expect(approvals[0].operation.timestamp).toBeInstanceOf(Date);
    expect(approvals[0].queuedAt).toBeInstanceOf(Date);

    await store.deletePendingApproval('approval-1');
    expect(await store.listPendingApprovals()).toHaveLength(0);
  });
});
