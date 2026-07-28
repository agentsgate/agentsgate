/**
 * src/cli/ops.ts — log listing, stats, get, count, tail, export, dispatch.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import { redirectHome, startCli, stopCli, writeState, clearState, capture, makeOp, dec, type CliContext } from './helpers.js';

const HOME = redirectHome();

const { cmdLogs, cmdOpsStats, cmdOpsGet, cmdOpsCount, cmdOps, cmdOpsTail, cmdOpsExport } =
  await import('../../src/cli/ops.js');
const { StateStore } = await import('../../src/modules/m2-store/index.js');
const { OperationLogger } = await import('../../src/modules/m3-logger/index.js');

let ctx: CliContext;

beforeAll(async () => {
  ctx = await startCli(HOME);
  await ctx.log(
    makeOp({ id: 'op-alpha', agentId: 'agent-a', tool: 'filesystem', method: 'write_file' }),
    dec(0.2, 'allow'),
  );
  await ctx.log(
    makeOp({ id: 'op-beta', agentId: 'agent-b', tool: 'database', method: 'execute_ddl' }),
    dec(0.95, 'block', ['Triggered rule: L1_DROP_TABLE']),
  );
  await ctx.log(
    makeOp({ id: 'op-gamma', agentId: 'agent-a', tool: 'database', method: 'execute' }),
    dec(0.55, 'require_approval'),
  );
});

afterAll(async () => { await stopCli(ctx); });

beforeEach(async () => {
  // Most tests want the "proxy is running" branch — our own pid is always live.
  await writeState(HOME, { pid: process.pid, port: ctx.dashboardPort - 1, dashboardPort: ctx.dashboardPort });
});

describe('cmdLogs — live proxy', () => {
  it('lists operations with action, risk, agent and tool', async () => {
    const r = await capture(() => cmdLogs([]));
    expect(r.exitCode).toBeUndefined();
    expect(r.stdout).toContain('3 operation(s):');
    expect(r.stdout).toContain('agent-a/filesystem.write_file');
    expect(r.stdout).toContain('agent-b/database.execute_ddl');
    expect(r.stdout).toContain('block');
    expect(r.stdout).toMatch(/\b95%/);
  });

  it('honours a positional limit', async () => {
    const r = await capture(() => cmdLogs(['1']));
    // The header reports the total matching count while the rows are the
    // limited page, so "3 operation(s)" above a single row is expected here.
    const rows = r.stdout.split('\n').filter(l => l.startsWith('  ') && l.includes('/'));
    expect(rows).toHaveLength(1);
  });

  it('filters by action', async () => {
    const r = await capture(() => cmdLogs(['--action=block']));
    expect(r.stdout).toContain('agent-b/database.execute_ddl');
    expect(r.stdout).not.toContain('agent-a/filesystem.write_file');
  });

  it('filters by tool', async () => {
    const r = await capture(() => cmdLogs(['--tool=database']));
    expect(r.stdout).toContain('2 operation(s):');
  });

  it('filters by agentId', async () => {
    const r = await capture(() => cmdLogs(['--agentId=agent-b']));
    expect(r.stdout).toContain('1 operation(s):');
    expect(r.stdout).toContain('agent-b');
  });

  it('reports an empty result set rather than an empty table', async () => {
    const r = await capture(() => cmdLogs(['--agentId=nobody']));
    expect(r.stdout).toBe('No operations found.');
  });
});

describe('cmdLogs — offline (stdio) mode', () => {
  // With no live pid the command falls back to reading the SQLite file
  // directly, which is the path used when only `agentsgate inject` is active.
  it('reads from the local database and labels the output as offline', async () => {
    const dbPath = path.join(HOME, '.agentsgate', 'agentsgate.db');
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    const store = new StateStore(dbPath);
    await store.initialize();
    const logger = new OperationLogger(store);
    await logger.log(makeOp({ id: 'op-offline', agentId: 'agent-off', tool: 'fs', method: 'read' }), dec(0.1));
    await store.close();

    await writeState(HOME, { pid: 999_999_999, port: 1, dashboardPort: 1 });   // dead pid
    const r = await capture(() => cmdLogs([]));

    expect(r.stdout).toContain('offline — stdio proxy mode');
    expect(r.stdout).toContain('agent-off/fs.read');
  });
});

describe('cmdOpsGet', () => {
  it('prints the full detail of one operation', async () => {
    const r = await capture(() => cmdOpsGet(['op-beta']));
    expect(r.exitCode).toBeUndefined();
    expect(r.stdout).toContain('Operation: op-beta');
    expect(r.stdout).toContain('Agent:   agent-b');
    expect(r.stdout).toContain('Tool:    database.execute_ddl');
    expect(r.stdout).toContain('Action:  block');
    expect(r.stdout).toContain('Risk:    95.0%');
    expect(r.stdout).toContain('Params:');
  });

  it('exits 1 with usage when no id is given', async () => {
    const r = await capture(() => cmdOpsGet([]));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('Usage: agentsgate ops get <operationId>');
  });

  it('exits 1 for an unknown id', async () => {
    const r = await capture(() => cmdOpsGet(['op-does-not-exist']));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('not found');
  });

  it('exits 1 when the proxy is not running', async () => {
    await clearState(HOME);
    const r = await capture(() => cmdOpsGet(['op-alpha']));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('AgentsGate is not running.');
  });
});

describe('cmdOpsCount', () => {
  it('prints the total with no filters', async () => {
    const r = await capture(() => cmdOpsCount([]));
    expect(r.stdout.trim()).toBe('3');
  });

  it('applies an action filter', async () => {
    const r = await capture(() => cmdOpsCount(['--action=block']));
    expect(r.stdout.trim()).toBe('1');
  });

  it('applies a tool filter', async () => {
    const r = await capture(() => cmdOpsCount(['--tool=database']));
    expect(r.stdout.trim()).toBe('2');
  });

  it('combines filters', async () => {
    const r = await capture(() => cmdOpsCount(['--tool=database', '--agent=agent-a']));
    expect(r.stdout.trim()).toBe('1');
  });

  it('exits 1 when the proxy is not running', async () => {
    await clearState(HOME);
    const r = await capture(() => cmdOpsCount([]));
    expect(r.exitCode).toBe(1);
  });
});

describe('cmdOpsStats', () => {
  it('summarises the operations held in the local database', async () => {
    const r = await capture(() => cmdOpsStats([]));
    expect(r.exitCode).toBeUndefined();
    expect(r.stdout.length).toBeGreaterThan(0);
  });

  it('reports an empty database rather than dividing by zero', async () => {
    const r = await capture(() => cmdOpsStats(['--agentId=nobody-at-all']));
    expect(r.stdout).toContain('No operations found.');
  });
});

describe('cmdOpsTail', () => {
  it('renders a table of recent operations', async () => {
    const r = await capture(() => cmdOpsTail(['--limit=10']));
    expect(r.exitCode).toBeUndefined();
    expect(r.stdout).toContain('agent-a');
  });

  it('exits 1 when the proxy is not running', async () => {
    await clearState(HOME);
    const r = await capture(() => cmdOpsTail([]));
    expect(r.exitCode).toBe(1);
  });
});

describe('cmdOpsExport', () => {
  // The output path is positional; anything starting with -- is a filter.
  it('writes CSV with a header row to the named file', async () => {
    const out = path.join(ctx.tmpDir, 'ops.csv');
    const r = await capture(() => cmdOpsExport([out]));
    expect(r.exitCode).toBeUndefined();
    expect(r.stdout).toContain(`Exported to ${out}`);

    const csv = await fs.readFile(out, 'utf8');
    // RFC 4180 line endings — split on either so the assertion is not platform bound.
    const [header, ...rows] = csv.trim().split(/\r?\n/);
    expect(header).toBe('id,agentId,tool,method,action,riskScore,sessionId,timestamp');
    expect(rows).toHaveLength(3);
    expect(csv).toContain('op-beta');
  });

  it('applies filters to the export', async () => {
    const out = path.join(ctx.tmpDir, 'ops-blocked.csv');
    await capture(() => cmdOpsExport([out, '--action=block']));
    const csv = await fs.readFile(out, 'utf8');
    expect(csv.trim().split(/\r?\n/)).toHaveLength(2);      // header + 1 row
    expect(csv).toContain('op-beta');
    expect(csv).not.toContain('op-alpha');
  });

  it('streams to stdout when no file is named', async () => {
    const r = await capture(() => cmdOpsExport([]));
    expect(r.exitCode).toBeUndefined();
    expect(r.stdout).not.toContain('Exported to');
  });

  it('exits 1 when the proxy is not running', async () => {
    await clearState(HOME);
    const r = await capture(() => cmdOpsExport([path.join(ctx.tmpDir, 'never.csv')]));
    expect(r.exitCode).toBe(1);
  });
});

describe('cmdOps — subcommand dispatch', () => {
  it('routes "get" to the detail view', async () => {
    const r = await capture(() => cmdOps(['get', 'op-alpha']));
    expect(r.stdout).toContain('Operation: op-alpha');
  });

  it('routes "count" to the counter', async () => {
    const r = await capture(() => cmdOps(['count']));
    expect(r.stdout.trim()).toBe('3');
  });

  it('rejects an unknown subcommand', async () => {
    const r = await capture(() => cmdOps(['not-a-subcommand']));
    expect(r.exitCode).toBe(1);
  });
});
