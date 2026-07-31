/**
 * One-shot approval grants.
 *
 * An HTTP caller that gets `requireApproval` has already been answered, so
 * approving cannot release anything — approving instead leaves a grant that the
 * agent's retry consumes. Without it, approving an HTTP operation does nothing
 * at all: the only way to get the work done is to lower the threshold, which
 * permits it forever rather than once.
 *
 * A grant is for one retry, of one request, for a short while.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StateStore } from '../src/modules/m2-store/index.js';
import { operationFingerprint } from '../src/utils/operation-fingerprint.js';
import type { MCPOperation } from '../src/types/interfaces.js';

let dir: string;
let store: StateStore;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ag-grant-'));
  store = new StateStore(path.join(dir, 'g.db'));
  await store.initialize();
});

afterEach(async () => {
  await store.close();
  await fs.rm(dir, { recursive: true, force: true });
});

const op = (over: Partial<MCPOperation> = {}): MCPOperation => ({
  id: 'op-1', agentId: 'claude', tool: 'filesystem', method: 'write_file',
  params: { path: '/srv/app/config.json', content: '{}' },
  timestamp: new Date(), sessionId: 's', ...over,
} as MCPOperation);

const soon = (): Date => new Date(Date.now() + 300_000);

describe('fingerprints', () => {
  it('ignore what differs between a request and its retry', () => {
    const first = op({ id: 'op-1', sessionId: 's1', timestamp: new Date(1) });
    const retry = op({ id: 'op-2', sessionId: 's2', timestamp: new Date(2) });
    expect(operationFingerprint(retry)).toBe(operationFingerprint(first));
  });

  it('ignore the order parameters happen to be written in', () => {
    const a = op({ params: { path: '/x', content: 'y' } });
    const b = op({ params: { content: 'y', path: '/x' } });
    expect(operationFingerprint(a)).toBe(operationFingerprint(b));
  });

  it('separate anything a reviewer would consider a different request', () => {
    const base = operationFingerprint(op());
    expect(operationFingerprint(op({ agentId: 'other' }))).not.toBe(base);
    expect(operationFingerprint(op({ tool: 'database' }))).not.toBe(base);
    expect(operationFingerprint(op({ method: 'delete_file' }))).not.toBe(base);
    expect(operationFingerprint(op({ params: { path: '/etc/passwd' } }))).not.toBe(base);
  });

  it('separate nested differences', () => {
    const a = op({ params: { filter: { status: 'pending' } } });
    const b = op({ params: { filter: { status: 'shipped' } } });
    expect(operationFingerprint(a)).not.toBe(operationFingerprint(b));
  });
});

describe('a granted retry', () => {
  it('is let through once', async () => {
    const fp = operationFingerprint(op());
    await store.createApprovalGrant(fp, 'op-1', soon());
    expect(await store.consumeApprovalGrant(fp)).toBe(true);
  });

  it('is not let through twice', async () => {
    const fp = operationFingerprint(op());
    await store.createApprovalGrant(fp, 'op-1', soon());
    expect(await store.consumeApprovalGrant(fp)).toBe(true);
    expect(await store.consumeApprovalGrant(fp)).toBe(false);
  });

  it('does not cover a different request', async () => {
    await store.createApprovalGrant(operationFingerprint(op()), 'op-1', soon());
    const other = operationFingerprint(op({ params: { path: '/etc/passwd' } }));
    expect(await store.consumeApprovalGrant(other)).toBe(false);
  });

  it('expires', async () => {
    const fp = operationFingerprint(op());
    await store.createApprovalGrant(fp, 'op-1', new Date(Date.now() - 1000));
    expect(await store.consumeApprovalGrant(fp)).toBe(false);
  });

  it('is absent until something grants it', async () => {
    expect(await store.consumeApprovalGrant(operationFingerprint(op()))).toBe(false);
  });
});

describe('housekeeping', () => {
  it('clears spent and expired grants, keeping live ones', async () => {
    await store.createApprovalGrant('spent', 'op-a', soon());
    await store.consumeApprovalGrant('spent');
    await store.createApprovalGrant('stale', 'op-b', new Date(Date.now() - 1000));
    await store.createApprovalGrant('live', 'op-c', soon());

    expect(await store.pruneApprovalGrants()).toBe(2);
    expect(await store.consumeApprovalGrant('live')).toBe(true);
  });

  it('re-granting the same request replaces the old grant', async () => {
    const fp = operationFingerprint(op());
    await store.createApprovalGrant(fp, 'op-1', new Date(Date.now() - 1000));   // expired
    await store.createApprovalGrant(fp, 'op-2', soon());                        // approved again
    expect(await store.consumeApprovalGrant(fp)).toBe(true);
  });
});
