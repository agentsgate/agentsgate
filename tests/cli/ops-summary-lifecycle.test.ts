/**
 * src/cli/ops-summary.ts and the read-only halves of src/cli/lifecycle.ts.
 *
 * cmdStart spawns a live proxy and cmdProxy attaches to stdio, so neither is
 * reachable from a unit test; status / config / stop / doctor are.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { redirectHome, startCli, stopCli, writeState, clearState, capture, makeOp, dec, type CliContext } from './helpers.js';

const HOME = redirectHome();

const { cmdOpsSummary } = await import('../../src/cli/ops-summary.js');
const { cmdStatus, cmdStop, cmdConfig, cmdDoctor } = await import('../../src/cli/lifecycle.js');

let ctx: CliContext;

beforeAll(async () => {
  ctx = await startCli(HOME);
  await ctx.log(makeOp({ id: 's1', agentId: 'agent-a', tool: 'filesystem', method: 'read_file' }), dec(0.1, 'allow'));
  await ctx.log(makeOp({ id: 's2', agentId: 'agent-a', tool: 'database', method: 'execute' }), dec(0.5, 'require_approval'));
  await ctx.log(makeOp({ id: 's3', agentId: 'agent-b', tool: 'database', method: 'execute_ddl' }), dec(0.95, 'block'));
});

afterAll(async () => { await stopCli(ctx); });

beforeEach(async () => {
  await writeState(HOME, { pid: process.pid, port: ctx.dashboardPort - 1, dashboardPort: ctx.dashboardPort });
});

describe('cmdOpsSummary', () => {
  it('renders the aggregate view', async () => {
    const r = await capture(() => cmdOpsSummary([]));
    expect(r.exitCode).toBeUndefined();
    expect(r.stdout.length).toBeGreaterThan(100);
  });

  it('includes the operation total and the action breakdown', async () => {
    const r = await capture(() => cmdOpsSummary([]));
    expect(r.stdout.toLowerCase()).toMatch(/total|operations/);
    expect(r.stdout.toLowerCase()).toMatch(/block/);
  });

  it('exits 1 when the proxy is not running', async () => {
    await clearState(HOME);
    const r = await capture(() => cmdOpsSummary([]));
    expect(r.exitCode).toBe(1);
  });
});

describe('cmdStatus', () => {
  it('reports the running proxy with its ports', async () => {
    const r = await capture(() => cmdStatus([]));
    expect(r.exitCode).toBeUndefined();
    expect(r.stdout).toContain('AgentsGate is RUNNING');
    expect(r.stdout).toContain(String(ctx.dashboardPort));
  });

  it('reports that nothing is running when there is no state file', async () => {
    await clearState(HOME);
    const r = await capture(() => cmdStatus([]));
    expect(r.stdout + r.stderr).toContain('AgentsGate is STOPPED');
  });

  it('treats a state file with a dead pid as not running', async () => {
    await writeState(HOME, { pid: 999_999_999, port: 1, dashboardPort: 2 });
    const r = await capture(() => cmdStatus([]));
    expect(r.stdout + r.stderr).toMatch(/STOPPED|not running|stale/i);
  });
});

describe('cmdStop', () => {
  it('reports that nothing is running when there is no state file', async () => {
    await clearState(HOME);
    const r = await capture(() => cmdStop());
    expect(r.stdout + r.stderr).toMatch(/not running/i);
  });

  it('does not throw on a stale pid', async () => {
    await writeState(HOME, { pid: 999_999_999, port: 1, dashboardPort: 2 });
    const r = await capture(() => cmdStop());
    expect(r.stdout.length + r.stderr.length).toBeGreaterThan(0);
  });
});

describe('cmdConfig', () => {
  it('prints the effective configuration', async () => {
    const r = await capture(() => cmdConfig([]));
    expect(r.exitCode).toBeUndefined();
    expect(r.stdout).toContain('proxy');
  });

  it('reads an explicit --config file', async () => {
    const cfgPath = path.join(ctx.tmpDir, 'custom-config.json');
    await fs.writeFile(cfgPath, JSON.stringify({ proxy: { port: 4567, host: '127.0.0.1' } }));
    const r = await capture(() => cmdConfig([`--config=${cfgPath}`]));
    expect(r.exitCode).toBeUndefined();
    expect(r.stdout).toContain('4567');
  });

  it('redacts secrets rather than printing them', async () => {
    const cfgPath = path.join(ctx.tmpDir, 'secret-config.json');
    await fs.writeFile(cfgPath, JSON.stringify({
      proxy: { port: 4000 },
      dashboard: { apiKey: 'super-secret-key-value' },
      audit: { signingSecret: 'super-secret-signing' },
    }));
    const r = await capture(() => cmdConfig([`--config=${cfgPath}`, 'show']));
    expect(r.stdout).not.toContain('super-secret-key-value');
    expect(r.stdout).not.toContain('super-secret-signing');
  });
});

describe('cmdDoctor', () => {
  it('runs its checks and reports on each', async () => {
    const r = await capture(() => cmdDoctor([]));
    // Doctor exits non-zero when a check fails, which is legitimate here.
    expect(r.stdout.length + r.stderr.length).toBeGreaterThan(0);
    expect((r.stdout + r.stderr).toLowerCase()).toMatch(/node|database|config|proxy/);
  });
});
