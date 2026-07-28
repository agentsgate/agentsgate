/**
 * src/cli/sessions.ts and src/cli/reports.ts — session views and reporting.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { redirectHome, startCli, stopCli, writeState, clearState, capture, makeOp, dec, type CliContext } from './helpers.js';

const HOME = redirectHome();

const { cmdSessions, cmdTop } = await import('../../src/cli/sessions.js');
const { cmdReport, cmdTree, cmdExplain } = await import('../../src/cli/reports.js');
const { cmdSessionsOps } = await import('../../src/cli/sessions-ops.js');

let ctx: CliContext;

beforeAll(async () => {
  ctx = await startCli(HOME);
  await ctx.log(
    makeOp({ id: 'p1', agentId: 'agent-a', tool: 'filesystem', method: 'write_file', sessionId: 'sess-1' }),
    dec(0.2, 'allow'),
  );
  await ctx.log(
    makeOp({ id: 'c1', agentId: 'agent-a', tool: 'database', method: 'execute', sessionId: 'sess-1', parentId: 'p1' }),
    dec(0.55, 'require_approval'),
  );
  await ctx.log(
    makeOp({ id: 'x1', agentId: 'agent-b', tool: 'database', method: 'execute_ddl', sessionId: 'sess-2' }),
    dec(0.95, 'block', ['Triggered rule: L1_DROP_TABLE']),
  );
});

afterAll(async () => { await stopCli(ctx); });

beforeEach(async () => {
  await writeState(HOME, { pid: process.pid, port: ctx.dashboardPort - 1, dashboardPort: ctx.dashboardPort });
});

describe('cmdSessions', () => {
  it('lists sessions with their operation counts', async () => {
    const r = await capture(() => cmdSessions([]));
    expect(r.exitCode).toBeUndefined();
    expect(r.stdout).toContain('sess-1');
    expect(r.stdout).toContain('sess-2');
  });

  it('treats a non-"list" first argument as a session id, not a filter', async () => {
    // There is no --agentId filter here: anything that is not "list" is taken
    // as a session id. The README used to claim otherwise.
    const r = await capture(() => cmdSessions(['sess-2']));
    expect(r.stdout + r.stderr).toContain('sess-2');
  });

  it('exits 1 when the proxy is not running', async () => {
    await clearState(HOME);
    const r = await capture(() => cmdSessions([]));
    expect(r.exitCode).toBe(1);
  });
});

describe('cmdSessionsOps', () => {
  it('shows the operation-derived detail for a session', async () => {
    const r = await capture(() => cmdSessionsOps(['sess-1']));
    expect(r.stdout.length + r.stderr.length).toBeGreaterThan(0);
  });

  it('exits 1 when the proxy is not running', async () => {
    await clearState(HOME);
    const r = await capture(() => cmdSessionsOps(['sess-1']));
    expect(r.exitCode).toBe(1);
  });
});

describe('cmdTop', () => {
  // cmdTop is a live TUI: it hides the cursor and redraws until SIGINT, with
  // no single-shot mode. Only the pre-loop guard is reachable from a test.
  it('exits 1 before entering the redraw loop when the proxy is not running', async () => {
    await clearState(HOME);
    const r = await capture(() => cmdTop([]));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('AgentsGate is not running.');
  });
});

describe('cmdTree', () => {
  it('renders the causality tree for a parent operation', async () => {
    const r = await capture(() => cmdTree(['p1']));
    expect(r.stdout.length + r.stderr.length).toBeGreaterThan(0);
  });

  it('exits 1 when the proxy is not running', async () => {
    await clearState(HOME);
    const r = await capture(() => cmdTree(['p1']));
    expect(r.exitCode).toBe(1);
  });
});

describe('cmdExplain', () => {
  it('explains why an operation was scored as it was', async () => {
    const r = await capture(() => cmdExplain(['x1']));
    expect(r.stdout.length + r.stderr.length).toBeGreaterThan(0);
  });

  it('exits 1 for an unknown operation', async () => {
    const r = await capture(() => cmdExplain(['no-such-op']));
    expect(r.exitCode).toBe(1);
  });
});

describe('cmdReport', () => {
  it('produces a report on stdout', async () => {
    const r = await capture(() => cmdReport([]));
    expect(r.exitCode).toBeUndefined();
    expect(r.stdout.length).toBeGreaterThan(0);
  });

  it('produces JSON when asked', async () => {
    const r = await capture(() => cmdReport(['--format=json']));
    expect(r.exitCode).toBeUndefined();
    // Should parse as JSON somewhere in the output.
    const start = r.stdout.indexOf('{');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(() => JSON.parse(r.stdout.slice(start))).not.toThrow();
  });

  it('writes to the file named by --output', async () => {
    const out = path.join(ctx.tmpDir, 'report.json');
    const r = await capture(() => cmdReport(['--format=json', `--output=${out}`]));
    expect(r.exitCode).toBeUndefined();
    const written = await fs.readFile(out, 'utf8');
    expect(() => JSON.parse(written)).not.toThrow();
  });

  it('refuses an invalid --team name', async () => {
    const r = await capture(() => cmdReport(['--team=../escape']));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('Invalid --team name');
  });

  it('works without a running proxy — it reads the database directly', async () => {
    await clearState(HOME);
    const r = await capture(() => cmdReport([]));
    expect(r.exitCode).toBeUndefined();
  });
});
