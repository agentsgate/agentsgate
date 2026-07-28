/**
 * T173 — agentsgate snapshot CLI: list/inspect/delete via StateStore.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { StateStore } from '../src/modules/m2-store/index.js';
import type { Checkpoint } from '../src/types/interfaces.js';

function makeCheckpoint(id: string, operationId = 'op-1'): Checkpoint {
  return {
    id,
    operationId,
    type: 'pre_operation',
    fileSnapshots: [
      { path: '/tmp/test.txt', contentHash: 'abc123def456abc123def456abc123de', sha1: 'sha1hash', size: 42, committedAt: new Date() },
    ],
    createdAt: new Date(),
  };
}

describe('agentsgate snapshot — StateStore operations', () => {
  let store: StateStore;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'as-snap-'));
    store = new StateStore(path.join(tmpDir, 'test.db'));
    await store.initialize();
  });

  afterEach(async () => {
    await store.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('listCheckpoints returns empty array when none saved', async () => {
    const list = await store.listCheckpoints();
    expect(list).toHaveLength(0);
  });

  it('saveCheckpoint and listCheckpoints returns saved checkpoints', async () => {
    await store.saveCheckpoint(makeCheckpoint('cp-1'));
    await store.saveCheckpoint(makeCheckpoint('cp-2'));
    const list = await store.listCheckpoints();
    expect(list.length).toBeGreaterThanOrEqual(2);
    const ids = list.map(c => c.id);
    expect(ids).toContain('cp-1');
    expect(ids).toContain('cp-2');
  });

  it('getCheckpoint returns the correct checkpoint by ID', async () => {
    const cp = makeCheckpoint('cp-inspect', 'op-x');
    await store.saveCheckpoint(cp);
    const fetched = await store.getCheckpoint('cp-inspect');
    expect(fetched).not.toBeNull();
    expect(fetched!.operationId).toBe('op-x');
    expect(fetched!.fileSnapshots).toHaveLength(1);
    expect(fetched!.fileSnapshots[0].path).toBe('/tmp/test.txt');
  });

  it('getCheckpoint returns null for unknown ID', async () => {
    const result = await store.getCheckpoint('no-such-id');
    expect(result).toBeNull();
  });

  it('deleteCheckpoint removes the checkpoint', async () => {
    await store.saveCheckpoint(makeCheckpoint('cp-del'));
    await store.deleteCheckpoint('cp-del');
    const result = await store.getCheckpoint('cp-del');
    expect(result).toBeNull();
  });

  it('listCheckpoints can be filtered by operationId', async () => {
    await store.saveCheckpoint(makeCheckpoint('cp-a', 'op-alpha'));
    await store.saveCheckpoint(makeCheckpoint('cp-b', 'op-beta'));
    const all = await store.listCheckpoints('op-alpha');
    expect(all.every(c => c.operationId === 'op-alpha')).toBe(true);
  });
});
