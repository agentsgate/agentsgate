/**
 * `agentsgate start` has to tell you where the dashboard is.
 *
 * Starting in the background, the parent forwarded the child's first chunk of
 * output and then destroyed the pipes, so a user saw one line —
 * "AgentsGate v0.1.3 started" — and never the dashboard URL, the ports, or how
 * to stop it. Six of the seven lines were thrown away. Running with
 * `--foreground` showed all of them, which is why it went unnoticed.
 *
 * This is the first thing anyone sees, so it is worth a test that spawns the
 * real binary rather than reasoning about the pipe handling.
 */
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';
import { describe, it, expect, afterEach } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'dist', 'cli.js');
const isBuilt = fsSync.existsSync(cli);

const homes: string[] = [];

function run(home: string, args: string[]): string {
  const res = spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home },
    timeout: 30_000,
  });
  return (res.stdout ?? '') + (res.stderr ?? '');
}

afterEach(() => {
  for (const home of homes.splice(0)) {
    try {
      execFileSync(process.execPath, [cli, 'stop'], {
        env: { ...process.env, HOME: home, USERPROFILE: home },
        timeout: 15_000, stdio: 'ignore',
      });
    } catch { /* already stopped */ }
    fsSync.rmSync(home, { recursive: true, force: true });
  }
});

// The binary has to exist; CI builds before testing.
describe.skipIf(!isBuilt)('agentsgate start', () => {
  it('prints where the dashboard is, not just that it started', () => {
    const home = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ag-start-'));
    homes.push(home);

    const out = run(home, ['start', '4712']);

    expect(out).toMatch(/AgentsGate v\d+\.\d+\.\d+ started/);
    expect(out, 'dashboard URL missing — the reader has nowhere to go').toContain('http://localhost:4713');
    expect(out, 'proxy port missing').toContain('http://localhost:4712');
    expect(out, 'no way to stop it').toMatch(/agentsgate stop/);
  });

  it('says which protection level is in force', () => {
    // Someone whose first operation is refused should be able to see why from
    // the thing they just ran.
    const home = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ag-start-'));
    homes.push(home);

    expect(run(home, ['start', '4714'])).toMatch(/Protection:\s+balanced/);
  });

  it('returns to the shell rather than staying attached', () => {
    const home = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ag-start-'));
    homes.push(home);

    const started = Date.now();
    run(home, ['start', '4716']);
    // The daemon keeps running; the command itself must come back promptly.
    expect(Date.now() - started).toBeLessThan(20_000);
  });
});
