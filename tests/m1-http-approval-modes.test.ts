/**
 * What approving does on the HTTP proxy.
 *
 * It cannot release a held request, because the caller was answered the moment
 * the operation scored `require_approval`. Two ways out, and the proxy supports
 * both:
 *
 *   default        approval leaves a one-shot grant; the agent's retry spends it
 *   holdHttpRequests   the caller is held instead, as the stdio proxy does
 *
 * Before either, approving did nothing at all: the operation was refused, the
 * queue entry was cleared, and the only route to getting the work done was to
 * lower the threshold — which permits it every time, not once.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MCPProxy, createPipeline } from '../src/modules/m1-proxy/index.js';
import { RiskScoringEngine } from '../src/modules/m6-risk/index.js';
import { InterventionController } from '../src/modules/m7-intervention/index.js';
import { StateStore } from '../src/modules/m2-store/index.js';
import { operationFingerprint } from '../src/utils/operation-fingerprint.js';
import type { MCPOperation, ExecutionResult } from '../src/types/interfaces.js';

let dir: string;
let store: StateStore;
let ran: string[];

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ag-http-appr-'));
  store = new StateStore(path.join(dir, 'g.db'));
  await store.initialize();
  ran = [];
});

afterEach(async () => {
  await store.close();
  await fs.rm(dir, { recursive: true, force: true });
});

const forwardToTool = async (op: MCPOperation): Promise<ExecutionResult> => {
  ran.push(op.id);
  return { success: true, output: 'done', durationMs: 1 };
};

/** Scores 0.65 → require_approval under the default thresholds. */
const op = (id: string): MCPOperation => ({
  id, agentId: 'claude', tool: 'filesystem', method: 'write_file',
  params: { path: '/srv/app/config.json', content: '{}' },
  timestamp: new Date(), sessionId: 's',
} as MCPOperation);

function makeProxy(extra: Record<string, unknown> = {}): MCPProxy {
  return new MCPProxy({
    ...createPipeline({
      riskEngine: new RiskScoringEngine(),
      interventionController: new InterventionController({ allowBelow: 0.3, blockAtOrAbove: 0.7 }),
      grantStore: store,
    }),
    forwardToTool,
    ...extra,
  });
}

describe('by default', () => {
  it('refuses the operation and does not run it', async () => {
    const decision = await makeProxy().intercept(op('op-1'));
    expect(decision.action).toBe('require_approval');
    expect(ran).toEqual([]);
  });

  it('lets the retry through once the operator has approved', async () => {
    const proxy = makeProxy();
    await proxy.intercept(op('op-1'));
    expect(ran).toEqual([]);

    // What POST /approvals/:id/approve leaves behind.
    await store.createApprovalGrant(
      operationFingerprint(op('op-1')), 'op-1', new Date(Date.now() + 300_000)
    );

    const retry = await proxy.intercept(op('op-2'));   // same request, new id
    expect(retry.action).toBe('allow');
    expect(retry.reasons.join(' ')).toMatch(/grant/i);
    expect(ran).toEqual(['op-2']);
  });

  it('permits one retry, not every retry', async () => {
    const proxy = makeProxy();
    await store.createApprovalGrant(
      operationFingerprint(op('x')), 'x', new Date(Date.now() + 300_000)
    );

    expect((await proxy.intercept(op('op-2'))).action).toBe('allow');
    expect((await proxy.intercept(op('op-3'))).action).toBe('require_approval');
    expect(ran).toEqual(['op-2']);
  });

  it('does not let a different request ride on the grant', async () => {
    const proxy = makeProxy();
    await store.createApprovalGrant(
      operationFingerprint(op('x')), 'x', new Date(Date.now() + 300_000)
    );

    const other = { ...op('op-9'), params: { path: '/etc/passwd', content: 'x' } } as MCPOperation;
    expect((await proxy.intercept(other)).action).not.toBe('allow');
    expect(ran).toEqual([]);
  });

  it('does not honour a grant that has lapsed', async () => {
    const proxy = makeProxy();
    await store.createApprovalGrant(
      operationFingerprint(op('x')), 'x', new Date(Date.now() - 1000)
    );
    expect((await proxy.intercept(op('op-2'))).action).toBe('require_approval');
    expect(ran).toEqual([]);
  });
});

describe('with holdHttpRequests', () => {
  it('runs the operation on the original call once approved', async () => {
    const proxy = makeProxy({ awaitApproval: async () => 'approved' });
    const decision = await proxy.intercept(op('op-1'));
    expect(decision.action).toBe('allow');
    expect(ran).toEqual(['op-1']);          // no retry needed
  });

  it('blocks it when the operator says no', async () => {
    const proxy = makeProxy({ awaitApproval: async () => 'denied' });
    expect((await proxy.intercept(op('op-1'))).action).toBe('block');
    expect(ran).toEqual([]);
  });

  it('blocks it when the wait cannot be resolved at all', async () => {
    const proxy = makeProxy({ awaitApproval: async () => { throw new Error('no dashboard'); } });
    expect((await proxy.intercept(op('op-1'))).action).toBe('block');
    expect(ran).toEqual([]);
  });

  it('leaves allow and block alone', async () => {
    let asked = 0;
    const proxy = makeProxy({ awaitApproval: async () => { asked++; return 'approved' as const; } });

    const read = { ...op('op-r'), method: 'read_file', params: { path: '/tmp/a' } } as MCPOperation;
    expect((await proxy.intercept(read)).action).toBe('allow');

    const drop = { ...op('op-d'), tool: 'shell', method: 'execute', params: { command: 'rm -rf /' } } as MCPOperation;
    expect((await proxy.intercept(drop)).action).toBe('block');

    expect(asked).toBe(0);
  });
});
