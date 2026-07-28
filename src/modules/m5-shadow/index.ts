import path from 'node:path';
import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FileSnapshot } from '../../types/interfaces.js';

const execFileAsync = promisify(execFile);

/** Timeout for individual git operations in ms. Prevents hangs on locked repos. */
const GIT_TIMEOUT_MS = 15_000;

/**
 * Run a git command in a given directory with a consistent timeout.
 * Uses execFile (no shell) to prevent command injection via argument values.
 */
async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    // Ensure UTF-8 output on all platforms
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LANG: 'en_US.UTF-8' },
  });
  return stdout.trim();
}

/**
 * M5: File Shadow System
 * Maintains a shadow git repository to store point-in-time file snapshots.
 * Each snapshot is a git commit; restore replays a checkout of that commit.
 *
 * Windows hardening:
 * - core.autocrlf=false — file content stored verbatim (no CRLF corruption)
 * - core.safecrlf=false — no rejection of mixed line endings
 * - Per-file git add calls — avoids shell quoting issues with spaces/special chars
 * - 15 s timeout on all git operations — prevents hangs on locked files
 * - Paths normalized to forward-slash relative paths before passing to git
 */
export class FileShadowSystem {
  private shadowRepoPath: string | null = null;

  /** Initialise (or re-open) the shadow git repository at the given path. */
  async initialize(shadowRepoPath: string): Promise<void> {
    await fs.mkdir(shadowRepoPath, { recursive: true });

    // Only init once; subsequent calls are idempotent
    let isRepo = false;
    try {
      await git(['rev-parse', '--is-inside-work-tree'], shadowRepoPath);
      isRepo = true;
    } catch {
      /* not a repo yet */
    }

    if (!isRepo) {
      await git(['init'], shadowRepoPath);
      // Required identity for commits
      await git(['config', 'user.email', 'agentsgate@localhost'], shadowRepoPath);
      await git(['config', 'user.name', 'AgentsGate'], shadowRepoPath);
      // Critical on Windows: store file bytes verbatim, no CRLF translation
      await git(['config', 'core.autocrlf', 'false'], shadowRepoPath);
      await git(['config', 'core.safecrlf', 'false'], shadowRepoPath);
      // Silence advice about default branch name
      await git(['config', 'advice.defaultBranchName', 'false'], shadowRepoPath);
    }

    this.shadowRepoPath = shadowRepoPath;
  }

  /** Snapshot a single file. Convenience wrapper around snapshotMany. */
  async snapshot(filePath: string): Promise<FileSnapshot> {
    const results = await this.snapshotMany([filePath]);
    const snap = results[0];
    if (!snap) throw new Error(`Failed to snapshot file: ${filePath}`);
    return snap;
  }

  /**
   * Snapshot multiple files in a single git commit.
   * Returns one FileSnapshot per file, all sharing the same gitCommitSha.
   */
  async snapshotMany(filePaths: string[]): Promise<FileSnapshot[]> {
    this.assertInitialized();
    if (filePaths.length === 0) return [];

    const staging: Array<{ original: string; relPath: string; contentHash: string }> = [];

    for (const filePath of filePaths) {
      const content = await fs.readFile(filePath);
      const contentHash = createHash('sha256').update(content).digest('hex');
      const relPath = toShadowRelPath(filePath, this.shadowRepoPath!);
      const dest = path.join(this.shadowRepoPath!, relPath);

      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, content);
      staging.push({ original: filePath, relPath, contentHash });
    }

    // Stage each file individually — use -- separator to handle filenames that start with a dash
    for (const { relPath } of staging) {
      await git(['add', '--', relPath], this.shadowRepoPath!);
    }

    // Commit — include timestamp so repeated identical snapshots still produce a commit
    const msg = `snapshot: ${filePaths.length} file(s) at ${new Date().toISOString()}`;
    await git(['commit', '-m', msg], this.shadowRepoPath!);

    const gitCommitSha = await git(['rev-parse', 'HEAD'], this.shadowRepoPath!);

    return staging.map(s => ({
      path: s.original,
      contentHash: s.contentHash,
      gitCommitSha,
    }));
  }

  /** Restore a single file from its snapshot. */
  async restore(snapshot: FileSnapshot): Promise<void> {
    return this.restoreMany([snapshot]);
  }

  /**
   * Read the content of a file as it was at checkpoint time.
   * Returns the raw Buffer, or null if the snapshot cannot be read.
   */
  async readSnapshot(snapshot: FileSnapshot): Promise<Buffer | null> {
    this.assertInitialized();
    const relPath = toShadowRelPath(snapshot.path, this.shadowRepoPath!);
    try {
      // git show outputs raw file content to stdout
      const { stdout } = await execFileAsync(
        'git',
        ['show', `${snapshot.gitCommitSha}:${relPath}`],
        { cwd: this.shadowRepoPath!, timeout: GIT_TIMEOUT_MS, encoding: 'buffer' }
      );
      return Buffer.from(stdout as unknown as string);
    } catch {
      return null;
    }
  }

  /**
   * Restore multiple files from their snapshots.
   * Each snapshot may reference a different git commit SHA.
   */
  async restoreMany(snapshots: FileSnapshot[]): Promise<void> {
    this.assertInitialized();

    for (const snapshot of snapshots) {
      const relPath = toShadowRelPath(snapshot.path, this.shadowRepoPath!);
      // Checkout the exact snapshot commit for this file into the shadow working tree
      await git(
        ['checkout', snapshot.gitCommitSha, '--', relPath],
        this.shadowRepoPath!
      );
      const shadowFilePath = path.join(this.shadowRepoPath!, relPath);
      const content = await fs.readFile(shadowFilePath);
      await fs.mkdir(path.dirname(snapshot.path), { recursive: true });
      await fs.writeFile(snapshot.path, content);
    }
  }

  private assertInitialized(): void {
    if (!this.shadowRepoPath) {
      throw new Error('FileShadowSystem not initialized. Call initialize() first.');
    }
  }
}

// ── Path helpers ─────────────────────────────────────────────────────────────

/**
 * Convert an absolute file path to a forward-slash relative path inside the
 * shadow repo. Safe for git commands on both Windows and Unix.
 *
 * Windows:  C:\Users\foo\bar.txt  →  files/c/Users/foo/bar.txt
 *           \\?\C:\very\long      →  files/c/very/long  (strips UNC \\?\ prefix)
 * Unix:     /tmp/bar.txt          →  files/tmp/bar.txt
 *
 * T430: After computing the relative path, validates that the resolved path
 * stays within the shadow repo to prevent symlink traversal attacks.
 */
function toShadowRelPath(absolutePath: string, shadowRepoPath: string): string {
  // Normalize backslashes to forward slashes
  let p = absolutePath.replace(/\\/g, '/');

  // Strip Windows extended-length UNC prefix: \\?\
  p = p.replace(/^\/\/\?\//, '');

  // Strip Windows drive letter (C: → c)
  p = p.replace(/^([A-Za-z]):/, (_, d: string) => d.toLowerCase());

  // Ensure there is a leading slash
  if (!p.startsWith('/')) p = `/${p}`;

  // Normalize the path (resolves ./ and ../ segments)
  const normalized = path.posix.normalize(p);

  // Reject any path that still escapes the root after normalization.
  // path.posix.normalize('/a/../../../etc/passwd') → '/../etc/passwd'
  // which still starts with '..' after stripping the leading slash.
  const withoutLeadingSlash = normalized.startsWith('/') ? normalized.slice(1) : normalized;
  if (withoutLeadingSlash.startsWith('..') || withoutLeadingSlash.includes('/../')) {
    throw new Error(`Path traversal rejected: ${absolutePath}`);
  }

  const relPath = `files${normalized}`;

  // T430: Symlink traversal check — ensure the resolved path stays within the shadow repo
  try {
    const resolvedFull = realpathSync(path.join(shadowRepoPath, relPath));
    const resolvedBase = realpathSync(shadowRepoPath);
    if (!resolvedFull.startsWith(resolvedBase + path.sep) && resolvedFull !== resolvedBase) {
      throw new Error(`Symlink escape detected: ${absolutePath}`);
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    // File doesn't exist yet — new file being shadowed, symlink check not needed
  }

  return relPath;
}
