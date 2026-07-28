/**
 * src/cli/agents.ts and src/cli/tools.ts — the per-entity report views.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { redirectHome, startCli, stopCli, writeState, clearState, capture, makeOp, dec, type CliContext } from './helpers.js';

const HOME = redirectHome();

const { cmdAgents } = await import('../../src/cli/agents.js');
const { cmdTools } = await import('../../src/cli/tools.js');

let ctx: CliContext;

beforeAll(async () => {
  ctx = await startCli(HOME);
  // agent-a: mixed risk across two tools. agent-b: a single blocked op.
  await ctx.log(makeOp({ id: 'a1', agentId: 'agent-a', tool: 'filesystem', method: 'read_file' }), dec(0.1, 'allow'));
  await ctx.log(makeOp({ id: 'a2', agentId: 'agent-a', tool: 'filesystem', method: 'write_file' }), dec(0.4, 'allow'));
  await ctx.log(makeOp({ id: 'a3', agentId: 'agent-a', tool: 'database', method: 'execute' }), dec(0.6, 'require_approval'));
  await ctx.log(makeOp({ id: 'b1', agentId: 'agent-b', tool: 'database', method: 'execute_ddl' }), dec(0.95, 'block'));
});

afterAll(async () => { await stopCli(ctx); });

beforeEach(async () => {
  await writeState(HOME, { pid: process.pid, port: ctx.dashboardPort - 1, dashboardPort: ctx.dashboardPort });
});

describe('cmdAgents — list', () => {
  it('lists every agent seen', async () => {
    const r = await capture(() => cmdAgents([]));
    expect(r.exitCode).toBeUndefined();
    expect(r.stdout).toContain('agent-a');
    expect(r.stdout).toContain('agent-b');
  });

  it('exits 1 when the proxy is not running', async () => {
    await clearState(HOME);
    const r = await capture(() => cmdAgents([]));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('AgentsGate is not running.');
  });
});

describe('cmdAgents — detail', () => {
  it('summarises one agent with its action breakdown', async () => {
    const r = await capture(() => cmdAgents(['agent-a']));
    expect(r.exitCode).toBeUndefined();
    expect(r.stdout).toContain('Agent: agent-a');
    expect(r.stdout).toContain('Total ops:');
    expect(r.stdout).toContain('allow 2');
    expect(r.stdout).toContain('approval 1');
    expect(r.stdout).toContain('Avg risk:');
  });

  it('exits 1 for an unknown agent', async () => {
    const r = await capture(() => cmdAgents(['no-such-agent']));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('Agent not found');
  });
});

describe('cmdAgents — tools breakdown', () => {
  it('prints a per-tool table for the agent', async () => {
    const r = await capture(() => cmdAgents(['agent-a', 'tools']));
    expect(r.exitCode).toBeUndefined();
    expect(r.stdout).toContain('per-tool breakdown');
    expect(r.stdout).toContain('TOOL');
    expect(r.stdout).toContain('BLOCK RATE');
    expect(r.stdout).toContain('filesystem');
    expect(r.stdout).toContain('database');
  });

  it('exits 1 for an unknown agent', async () => {
    const r = await capture(() => cmdAgents(['no-such-agent', 'tools']));
    expect(r.exitCode).toBe(1);
  });
});

describe('cmdAgents — risk profile', () => {
  it('prints the distribution with a bar per bucket', async () => {
    const r = await capture(() => cmdAgents(['agent-a', 'risk']));
    expect(r.exitCode).toBeUndefined();
    expect(r.stdout).toContain('Agent Risk Profile: agent-a');
    expect(r.stdout).toContain('Total ops:');
    expect(r.stdout).toContain('Risk distribution:');
  });

  it('exits 1 for an agent with no operations', async () => {
    const r = await capture(() => cmdAgents(['ghost', 'risk']));
    expect(r.exitCode).toBe(1);
  });
});

describe('cmdTools — list', () => {
  it('lists every tool seen', async () => {
    const r = await capture(() => cmdTools([]));
    expect(r.exitCode).toBeUndefined();
    expect(r.stdout).toContain('filesystem');
    expect(r.stdout).toContain('database');
  });

  it('exits 1 when the proxy is not running', async () => {
    await clearState(HOME);
    const r = await capture(() => cmdTools([]));
    expect(r.exitCode).toBe(1);
  });
});

describe('cmdTools — detail', () => {
  it('summarises one tool', async () => {
    const r = await capture(() => cmdTools(['database']));
    expect(r.exitCode).toBeUndefined();
    expect(r.stdout).toContain('database');
    expect(r.stdout.length).toBeGreaterThan(20);
  });

  it('exits 1 for an unknown tool', async () => {
    const r = await capture(() => cmdTools(['no-such-tool']));
    expect(r.exitCode).toBe(1);
  });
});
