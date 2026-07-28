import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FileShadowSystem } from '../../src/modules/m5-shadow/index.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'agentsgate-test-'));
}

async function rmWithRetry(targetPath: string, attempts = 5): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await fs.rm(targetPath, { recursive: true, force: true });
      return;
    } catch (error) {
      const isLastAttempt = attempt === attempts;
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EBUSY' || isLastAttempt) {
        throw error;
      }

      await new Promise(resolve => setTimeout(resolve, attempt * 150));
    }
  }
}

// ── toShadowRelPath unit tests (via snapshot path check) ──────────────────────

describe('shadow path normalisation', () => {
  it('snapshots and restores a file whose path contains spaces', async () => {
    const shadow = new FileShadowSystem();
    const shadowRepoDir = await mkTmpDir();
    const workDir = await mkTmpDir();
    try {
      await shadow.initialize(shadowRepoDir);

      // File in a path with a space
      const spacedDir = path.join(workDir, 'my dir');
      await fs.mkdir(spacedDir);
      const filePath = path.join(spacedDir, 'hello world.txt');
      await fs.writeFile(filePath, 'space test content');

      const snapshot = await shadow.snapshot(filePath);
      expect(snapshot.path).toBe(filePath);

      // Corrupt and restore
      await fs.writeFile(filePath, 'corrupted');
      await shadow.restore(snapshot);

      const restored = await fs.readFile(filePath, 'utf-8');
      expect(restored).toBe('space test content');
    } finally {
      await rmWithRetry(shadowRepoDir);
      await rmWithRetry(workDir);
    }
  }, 15000);
});

describe('FileShadowSystem', () => {
  let shadow: FileShadowSystem;
  let shadowRepoDir: string;
  let workDir: string;

  beforeEach(async () => {
    shadow = new FileShadowSystem();
    shadowRepoDir = await mkTmpDir();
    workDir = await mkTmpDir();
  });

  afterEach(async () => {
    await rmWithRetry(shadowRepoDir);
    await rmWithRetry(workDir);
  });

  it('should initialize a shadow git repository', async () => {
    await expect(shadow.initialize(shadowRepoDir)).resolves.toBeUndefined();
    // Verify it is a git repo by checking .git exists
    const gitDir = path.join(shadowRepoDir, '.git');
    await expect(fs.access(gitDir)).resolves.toBeUndefined();

    // Re-initializing should be idempotent
    await expect(shadow.initialize(shadowRepoDir)).resolves.toBeUndefined();
  });

  it('should set core.autocrlf=false to prevent CRLF corruption on Windows', async () => {
    await shadow.initialize(shadowRepoDir);
    const { exec } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execAsync = promisify(exec);
    const { stdout } = await execAsync('git config core.autocrlf', { cwd: shadowRepoDir });
    expect(stdout.trim()).toBe('false');
  });

  it('should snapshot a file and return FileSnapshot with hash and git SHA', async () => {
    await shadow.initialize(shadowRepoDir);

    const filePath = path.join(workDir, 'hello.txt');
    await fs.writeFile(filePath, 'hello world');

    const snapshot = await shadow.snapshot(filePath);

    expect(snapshot.path).toBe(filePath);
    expect(snapshot.gitCommitSha).toMatch(/^[0-9a-f]{40}$/);

    const expectedHash = createHash('sha256').update('hello world').digest('hex');
    expect(snapshot.contentHash).toBe(expectedHash);
  }, 15000);

  it('should snapshot multiple files', async () => {
    await shadow.initialize(shadowRepoDir);

    const file1 = path.join(workDir, 'a.txt');
    const file2 = path.join(workDir, 'b.txt');
    await fs.writeFile(file1, 'content-a');
    await fs.writeFile(file2, 'content-b');

    const snapshots = await shadow.snapshotMany([file1, file2]);

    expect(snapshots).toHaveLength(2);
    // All files in a single snapshotMany share the same commit
    expect(snapshots[0].gitCommitSha).toBe(snapshots[1].gitCommitSha);
    expect(snapshots[0].path).toBe(file1);
    expect(snapshots[1].path).toBe(file2);
  });

  it('should restore a file from a snapshot', async () => {
    await shadow.initialize(shadowRepoDir);

    const filePath = path.join(workDir, 'restore-me.txt');
    await fs.writeFile(filePath, 'original content');

    const snapshot = await shadow.snapshot(filePath);

    // Overwrite the file
    await fs.writeFile(filePath, 'corrupted content');
    const corrupted = await fs.readFile(filePath, 'utf-8');
    expect(corrupted).toBe('corrupted content');

    // Restore from snapshot
    await shadow.restore(snapshot);

    const restored = await fs.readFile(filePath, 'utf-8');
    expect(restored).toBe('original content');
  });

  it('should restore multiple files from snapshots', async () => {
    await shadow.initialize(shadowRepoDir);

    const file1 = path.join(workDir, 'x.txt');
    const file2 = path.join(workDir, 'y.txt');
    await fs.writeFile(file1, 'x-original');
    await fs.writeFile(file2, 'y-original');

    const snapshots = await shadow.snapshotMany([file1, file2]);

    // Corrupt both
    await fs.writeFile(file1, 'x-corrupted');
    await fs.writeFile(file2, 'y-corrupted');

    await shadow.restoreMany(snapshots);

    expect(await fs.readFile(file1, 'utf-8')).toBe('x-original');
    expect(await fs.readFile(file2, 'utf-8')).toBe('y-original');
  });
});
