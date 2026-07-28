/**
 * T210 — agentsgate diff <checkpointId>
 * Tests FileShadowSystem.readSnapshot() and the diff comparison logic.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { FileShadowSystem } from '../src/modules/m5-shadow/index.js';
import { StateStore } from '../src/modules/m2-store/index.js';
import { CheckpointEngine } from '../src/modules/m4-checkpoint/index.js';
import type { MCPOperation } from '../src/types/interfaces.js';

let tmpDir: string;
let shadow: FileShadowSystem;
let store: StateStore;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'as-diff-'));
  shadow = new FileShadowSystem();
  await shadow.initialize(path.join(tmpDir, 'shadow'));
  store = new StateStore(path.join(tmpDir, 'test.db'));
  await store.initialize();
});

afterEach(async () => {
  await store.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeOp(): MCPOperation {
  return {
    id: crypto.randomUUID(),
    agentId: 'test-agent',
    tool: 'filesystem',
    method: 'write_file',
    params: {},
    timestamp: new Date(),
    sessionId: 'sess-1',
  };
}

describe('FileShadowSystem.readSnapshot', () => {
  it('reads file content as it was at snapshot time', async () => {
    const filePath = path.join(tmpDir, 'test.txt');
    await fs.writeFile(filePath, 'original content\n');

    const checkpointEngine = new CheckpointEngine(store, shadow);
    const op = { ...makeOp(), params: { path: filePath } };
    const cp = await checkpointEngine.create(op);

    // Modify file after checkpoint
    await fs.writeFile(filePath, 'modified content\n');

    // readSnapshot should return original content
    const snap = cp.fileSnapshots.find(s => s.path === filePath);
    expect(snap).toBeDefined();
    const content = await shadow.readSnapshot(snap!);
    expect(content).not.toBeNull();
    expect(content!.toString()).toBe('original content\n');
  });

  it('returns null for non-existent commit SHA', async () => {
    const fakeSnap = {
      path: '/nonexistent/file.txt',
      contentHash: 'abc',
      gitCommitSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    };
    const result = await shadow.readSnapshot(fakeSnap);
    expect(result).toBeNull();
  });

  it('detects unchanged file correctly', async () => {
    const filePath = path.join(tmpDir, 'unchanged.txt');
    await fs.writeFile(filePath, 'same content\n');

    const checkpointEngine = new CheckpointEngine(store, shadow);
    const op = { ...makeOp(), params: { path: filePath } };
    const cp = await checkpointEngine.create(op);

    const snap = cp.fileSnapshots[0];
    const snapContent = await shadow.readSnapshot(snap);
    const currentContent = await fs.readFile(filePath);

    expect(snapContent).not.toBeNull();
    expect(snapContent!.equals(currentContent)).toBe(true);
  });

  it('detects modified file correctly', async () => {
    const filePath = path.join(tmpDir, 'changed.txt');
    await fs.writeFile(filePath, 'before\n');

    const checkpointEngine = new CheckpointEngine(store, shadow);
    const op = { ...makeOp(), params: { path: filePath } };
    const cp = await checkpointEngine.create(op);

    await fs.writeFile(filePath, 'after\n');

    const snap = cp.fileSnapshots[0];
    const snapContent = await shadow.readSnapshot(snap);
    const currentContent = await fs.readFile(filePath);

    expect(snapContent).not.toBeNull();
    expect(snapContent!.equals(currentContent)).toBe(false);
  });
});
