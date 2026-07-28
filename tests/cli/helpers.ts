/**
 * Harness for exercising the `src/cli/` command modules.
 *
 * The commands are thin: they read `~/.agentsgate/state.json` to find the
 * running dashboard, call it over HTTP, and print a formatted table. So the
 * harness stands up a real DashboardAPI over a real SQLite store, points a
 * real state file at it, and captures stdout — no mocking of the layers under
 * test, only of `process.exit`.
 *
 * `STATE_DIR` is resolved from `os.homedir()` when `src/cli/shared.ts` is first
 * imported, so every test file must redirect HOME *before* importing any CLI
 * module. See `redirectHome()`.
 */
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../../src/modules/m2-store/index.js';
import { OperationLogger } from '../../src/modules/m3-logger/index.js';
import { DashboardAPI } from '../../src/modules/m10-dashboard/index.js';
import { TelemetryService } from '../../src/modules/m13-telemetry/index.js';
import type { MCPOperation, ProxyDecision } from '../../src/types/interfaces.js';

/**
 * Point HOME at a fresh directory and return it. Call this at the top of a test
 * file, as a top-level statement, before `await import()`ing any CLI module —
 * a static import would be hoisted above it and bake in the real home directory.
 */
export function redirectHome(): string {
  const home = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ag-cli-home-'));
  process.env['HOME'] = home;
  process.env['USERPROFILE'] = home;      // Windows
  return home;
}

export interface CliContext {
  dash: DashboardAPI;
  store: StateStore;
  logger: OperationLogger;
  telemetry: TelemetryService;
  dashboardPort: number;
  home: string;
  tmpDir: string;
  /** Log an operation and mirror it into telemetry, as the proxy pipeline does. */
  log: (op: MCPOperation, decision: ProxyDecision) => Promise<void>;
}

/** Stand up a dashboard and write a state file pointing at it. */
export async function startCli(home: string): Promise<CliContext> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ag-cli-'));
  const store = new StateStore(path.join(tmpDir, 'test.db'));
  await store.initialize();
  const logger = new OperationLogger(store);
  // Telemetry is what backs /telemetry and /telemetry/sessions, which the
  // sessions and top commands read. A proxy started without it answers 503.
  const telemetry = new TelemetryService();
  const dash = new DashboardAPI(store, { telemetry });
  await dash.start(0);
  const dashboardPort = dash.getPort();

  await writeState(home, { pid: process.pid, port: dashboardPort - 1, dashboardPort });

  const log = async (op: MCPOperation, decision: ProxyDecision): Promise<void> => {
    await logger.log(op, decision);
    await telemetry.record(op, decision);
  };

  return { dash, store, logger, telemetry, dashboardPort, home, tmpDir, log };
}

export async function stopCli(ctx: CliContext): Promise<void> {
  await ctx.dash.stop();
  await ctx.store.close();
  await fs.rm(ctx.tmpDir, { recursive: true, force: true });
}

/** Write `~/.agentsgate/state.json`. */
export async function writeState(
  home: string,
  state: { pid: number; port: number; dashboardPort: number; startedAt?: string },
): Promise<void> {
  const dir = path.join(home, '.agentsgate');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'state.json'),
    JSON.stringify({ startedAt: new Date().toISOString(), ...state }),
  );
}

/** Remove the state file, so commands take their "not running" branch. */
export async function clearState(home: string): Promise<void> {
  await fs.rm(path.join(home, '.agentsgate', 'state.json'), { force: true });
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

export function makeOp(
  overrides: Partial<MCPOperation> & { id?: string } = {},
): MCPOperation {
  return {
    id: overrides.id ?? `op-${Math.abs(hash(JSON.stringify(overrides)))}`,
    agentId: 'agent-a',
    tool: 'filesystem',
    method: 'write_file',
    params: { path: '/tmp/x.txt' },
    timestamp: new Date(),
    sessionId: 'sess-1',
    ...overrides,
  };
}

export function dec(
  riskScore: number,
  action: ProxyDecision['action'] = 'allow',
  reasons: string[] = [],
): ProxyDecision {
  return { action, riskScore, reasons };
}

/** Deterministic id source — avoids Math.random in fixtures. */
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

// ── Output capture ───────────────────────────────────────────────────────────

export interface Captured {
  stdout: string;
  stderr: string;
  /** Exit code if the command called process.exit, else undefined. */
  exitCode?: number;
}

/** Sentinel thrown in place of process.exit so the command unwinds. */
class ExitCalled extends Error {
  constructor(readonly code: number) { super(`process.exit(${code})`); }
}

/**
 * Run a command with console output captured and `process.exit` neutralised.
 * Commands call `process.exit(1)` on error paths; letting that run would kill
 * the test worker, so it throws instead and the code is reported back.
 */
export async function capture(fn: () => Promise<void> | void): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];

  const origLog = console.log;
  const origErr = console.error;
  const origWarn = console.warn;
  const origExit = process.exit;
  const origWrite = process.stdout.write;

  console.log = (...a: unknown[]) => { out.push(a.map(String).join(' ')); };
  console.error = (...a: unknown[]) => { err.push(a.map(String).join(' ')); };
  console.warn = (...a: unknown[]) => { err.push(a.map(String).join(' ')); };
  // Some commands stream straight to stdout rather than through console.
  process.stdout.write = ((chunk: unknown) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write;
  (process as { exit: unknown }).exit = (code?: number) => { throw new ExitCalled(code ?? 0); };

  let exitCode: number | undefined;
  try {
    await fn();
  } catch (e) {
    if (e instanceof ExitCalled) exitCode = e.code;
    else throw e;
  } finally {
    console.log = origLog;
    console.error = origErr;
    console.warn = origWarn;
    process.stdout.write = origWrite;
    (process as { exit: unknown }).exit = origExit;
  }

  return { stdout: out.join('\n'), stderr: err.join('\n'), exitCode };
}
