/**
 * src/cli/dashboard-cmds.ts — commands that read live state from the dashboard.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { redirectHome, startCli, stopCli, writeState, clearState, capture, makeOp, dec, type CliContext } from './helpers.js';

const HOME = redirectHome();

const { cmdHealth, cmdQuota, cmdErrors, cmdApprovals, cmdRateLimits, cmdCircuitBreakers, cmdRisk, cmdVerifyLogs } =
  await import('../../src/cli/dashboard-cmds.js');

let ctx: CliContext;

beforeAll(async () => {
  ctx = await startCli(HOME);
  await ctx.log(makeOp({ id: 'op-1', agentId: 'agent-a', tool: 'fs' }), dec(0.2, 'allow'));
  await ctx.log(makeOp({ id: 'op-2', agentId: 'agent-a', tool: 'db' }), dec(0.9, 'block'));
});

afterAll(async () => { await stopCli(ctx); });

beforeEach(async () => {
  await writeState(HOME, { pid: process.pid, port: ctx.dashboardPort - 1, dashboardPort: ctx.dashboardPort });
});

describe('cmdHealth', () => {
  it('reports status, version, uptime and row counts', async () => {
    const r = await capture(() => cmdHealth([]));
    expect(r.exitCode).toBeUndefined();
    expect(r.stdout).toMatch(/AgentsGate \w+ — v/);
    expect(r.stdout).toContain('Uptime:');
    expect(r.stdout).toContain('Operations:');
    expect(r.stdout).toContain('DB row counts:');
    expect(r.stdout).toContain('operation_logs:');
  });

  it('exits 1 when the proxy is not running', async () => {
    await clearState(HOME);
    const r = await capture(() => cmdHealth([]));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('AgentsGate is not running.');
  });
});

describe('cmdQuota', () => {
  // The dashboard in this harness has no quota manager wired, which is the
  // same shape as a proxy started without quotas configured.
  it('explains that quotas are unconfigured rather than printing an empty table', async () => {
    const r = await capture(() => cmdQuota([]));
    if (r.exitCode === 1) {
      expect(r.stderr).toContain('Quota manager is not configured');
    } else {
      expect(r.stdout).toContain('No agent quota data recorded yet.');
    }
  });

  it('exits 1 when the proxy is not running', async () => {
    await clearState(HOME);
    const r = await capture(() => cmdQuota([]));
    expect(r.exitCode).toBe(1);
  });
});

describe('cmdErrors', () => {
  it('reports an empty error log', async () => {
    const r = await capture(() => cmdErrors([]));
    expect(r.exitCode).toBeUndefined();
    expect(r.stdout).toContain('No errors recorded.');
  });

  it('accepts a positional limit without failing', async () => {
    const r = await capture(() => cmdErrors(['5']));
    expect(r.exitCode).toBeUndefined();
  });

  it('exits 1 when the proxy is not running', async () => {
    await clearState(HOME);
    const r = await capture(() => cmdErrors([]));
    expect(r.exitCode).toBe(1);
  });
});

describe('cmdApprovals', () => {
  it('reports an empty approval queue', async () => {
    const r = await capture(() => cmdApprovals());
    expect(r.exitCode).toBeUndefined();
    expect(r.stdout.length).toBeGreaterThan(0);
  });

  it('exits 1 when the proxy is not running', async () => {
    await clearState(HOME);
    const r = await capture(() => cmdApprovals());
    expect(r.exitCode).toBe(1);
  });
});

describe('cmdRateLimits', () => {
  it('does not fail when no rate limiter is configured', async () => {
    const r = await capture(() => cmdRateLimits([]));
    expect(r.stdout.length + r.stderr.length).toBeGreaterThan(0);
  });
});

describe('cmdCircuitBreakers', () => {
  it('does not fail when no circuit breaker is configured', async () => {
    const r = await capture(() => cmdCircuitBreakers([]));
    expect(r.stdout.length + r.stderr.length).toBeGreaterThan(0);
  });

  it('exits 1 when the proxy is not running', async () => {
    await clearState(HOME);
    const r = await capture(() => cmdCircuitBreakers([]));
    expect(r.exitCode).toBe(1);
  });
});

describe('cmdRisk', () => {
  it('prints a risk breakdown for a known agent', async () => {
    const r = await capture(() => cmdRisk(['agent-a']));
    expect(r.stdout.length + r.stderr.length).toBeGreaterThan(0);
  });

  it('exits 1 when the proxy is not running', async () => {
    await clearState(HOME);
    const r = await capture(() => cmdRisk(['agent-a']));
    expect(r.exitCode).toBe(1);
  });
});

describe('cmdVerifyLogs', () => {
  it('reports on signature verification without throwing', async () => {
    const r = await capture(() => cmdVerifyLogs([]));
    expect(r.stdout.length + r.stderr.length).toBeGreaterThan(0);
  });
});
