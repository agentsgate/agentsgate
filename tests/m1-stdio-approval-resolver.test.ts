/**
 * The resolver that `agentsgate proxy` hands to the stdio gate.
 *
 * It writes the pending approval into the shared database and waits for a
 * verdict to appear there. The dashboard — a different process — is what puts
 * it there, so the only channel is the file both of them open.
 *
 * Every path that is not an explicit approval has to end with the operation
 * unrun: a denial, a timeout, a database that cannot be reached.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StateStore } from '../src/modules/m2-store/index.js';
import { createApprovalResolver } from '../src/cli/approval-resolver.js';
import type { MCPOperation, ProxyDecision } from '../src/types/interfaces.js';

let dir: string;
let store: StateStore;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ag-resolver-'));
  store = new StateStore(path.join(dir, 'shared.db'));
  await store.initialize();
});

afterEach(async () => {
  await store.close();
  await fs.rm(dir, { recursive: true, force: true });
});

const op = (id = 'op-1'): MCPOperation => ({
  id, agentId: 'claude', tool: 'filesystem', method: 'write_file',
  params: {}, timestamp: new Date(), sessionId: 's',
} as MCPOperation);

const decision: ProxyDecision = {
  operationId: 'op-1', action: 'require_approval', riskScore: 0.5,
  reasons: ['test'], timestamp: new Date(),
};

describe('waiting for a verdict', () => {
  it('returns approved once the verdict lands in the database', async () => {
    const resolve = createApprovalResolver({ store, timeoutMs: 3000, pollMs: 20 });
    const verdict = resolve(op(), decision);

    // Stand-in for the dashboard settling it from the other process.
    await new Promise(r => setTimeout(r, 60));
    expect(await store.resolvePendingApproval('op-1', 'approved')).toBe(true);

    expect(await verdict).toBe('approved');
  });

  it('returns denied the same way', async () => {
    const resolve = createApprovalResolver({ store, timeoutMs: 3000, pollMs: 20 });
    const verdict = resolve(op(), decision);
    await new Promise(r => setTimeout(r, 60));
    await store.resolvePendingApproval('op-1', 'denied');
    expect(await verdict).toBe('denied');
  });

  it('queues the operation so an approver can find it', async () => {
    const resolve = createApprovalResolver({ store, timeoutMs: 400, pollMs: 20 });
    const verdict = resolve(op(), decision);

    await new Promise(r => setTimeout(r, 60));
    const pending = await store.listPendingApprovals();
    expect(pending.map(p => p.id)).toContain('op-1');
    expect(pending[0]?.riskScore).toBe(0.5);

    await verdict;   // let it time out
  });
});

describe('failing closed', () => {
  it('denies when nobody answers in time', async () => {
    const resolve = createApprovalResolver({ store, timeoutMs: 150, pollMs: 20 });
    expect(await resolve(op(), decision)).toBe('denied');
  });

  it('settles the abandoned approval rather than leaving it pending forever', async () => {
    const resolve = createApprovalResolver({ store, timeoutMs: 150, pollMs: 20 });
    await resolve(op(), decision);

    expect(await store.listPendingApprovals()).toHaveLength(0);
    expect((await store.getPendingApproval('op-1'))?.verdict).toBe('denied');
  });

  it('denies when the database cannot be written', async () => {
    await store.close();   // the proxy outliving its database
    const resolve = createApprovalResolver({ store, timeoutMs: 3000, pollMs: 20 });
    expect(await resolve(op(), decision)).toBe('denied');
  });

  it('does not treat a verdict arriving after the timeout as approval', async () => {
    const resolve = createApprovalResolver({ store, timeoutMs: 120, pollMs: 20 });
    const verdict = await resolve(op(), decision);
    expect(verdict).toBe('denied');

    // Too late — the call has already been refused, so this must not flip it.
    expect(await store.resolvePendingApproval('op-1', 'approved')).toBe(false);
  });
});

describe('notifying the operator', () => {
  it('writes what is waiting, and how to answer it, to stderr', async () => {
    const lines: string[] = [];
    const resolve = createApprovalResolver({
      store, timeoutMs: 150, pollMs: 20, notify: line => lines.push(line),
    });
    await resolve(op(), decision);

    const text = lines.join('\n');
    expect(text).toContain('op-1');
    expect(text).toMatch(/agentsgate approve/);
    expect(text).toMatch(/denied|timed out/i);
  });
});
