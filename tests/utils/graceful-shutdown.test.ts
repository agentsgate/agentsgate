/**
 * T120 — Graceful shutdown: flush pending approvals + close DB on SIGINT/SIGTERM.
 *
 * Tests the GracefulShutdown utility class in isolation — we mock process.exit
 * and signal handlers to verify ordering and timeout behaviour.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GracefulShutdown } from '../../src/utils/graceful-shutdown.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeShutdown(overrides: Partial<Parameters<typeof GracefulShutdown['prototype']['constructor']>[0]> = {}) {
  const calls: string[] = [];

  const sd = new GracefulShutdown({
    stopProxy:    async () => { calls.push('stopProxy'); },
    stopDashboard: async () => { calls.push('stopDashboard'); },
    flushTelemetry: async () => { calls.push('flushTelemetry'); },
    getPendingApprovalCount: async () => { calls.push('getPending'); return 0; },
    closeStore:   async () => { calls.push('closeStore'); },
    removeStateFile: async () => { calls.push('removeState'); },
    clearTimers:  () => { calls.push('clearTimers'); },
    log: () => { /* suppress */ },
    timeoutMs: 1_000,
    ...overrides,
  });

  return { sd, calls };
}

// Mock process.exit so tests don't actually terminate
let exitCode: number | undefined;
let originalExit: typeof process.exit;

beforeEach(() => {
  exitCode = undefined;
  originalExit = process.exit;
  // @ts-expect-error -- override for testing
  process.exit = (code: number) => { exitCode = code; };
});

afterEach(() => {
  process.exit = originalExit;
});

describe('GracefulShutdown', () => {
  it('calls all shutdown steps in order on clean exit', async () => {
    const { sd, calls } = makeShutdown();
    await sd.shutdown();
    expect(calls).toEqual([
      'clearTimers',
      'getPending',
      'stopProxy',
      'stopDashboard',
      'flushTelemetry',
      'closeStore',
      'removeState',
    ]);
    expect(exitCode).toBe(0);
  });

  it('is idempotent — second call does nothing', async () => {
    const { sd, calls } = makeShutdown();
    await sd.shutdown();
    const firstCount = calls.length;
    await sd.shutdown();
    expect(calls.length).toBe(firstCount);
  });

  it('logs pending approval count when > 0', async () => {
    const logs: string[] = [];
    const { sd } = makeShutdown({
      getPendingApprovalCount: async () => 3,
      log: (m) => logs.push(m),
    });
    await sd.shutdown();
    expect(logs.some(l => l.includes('3'))).toBe(true);
    expect(logs.some(l => l.includes('pending approval'))).toBe(true);
  });

  it('does NOT log pending approval message when count is 0', async () => {
    const logs: string[] = [];
    const { sd } = makeShutdown({
      getPendingApprovalCount: async () => 0,
      log: (m) => logs.push(m),
    });
    await sd.shutdown();
    expect(logs.some(l => l.includes('pending approval'))).toBe(false);
  });

  it('continues shutdown even when individual steps throw', async () => {
    const { sd, calls } = makeShutdown({
      stopProxy: async () => { calls.push('stopProxy'); throw new Error('proxy err'); },
    });
    await sd.shutdown();
    // Despite proxy error, remaining steps still run
    expect(calls).toContain('stopDashboard');
    expect(calls).toContain('closeStore');
  });

  it('register() wires both SIGINT and SIGTERM', async () => {
    const { sd } = makeShutdown();
    const spyOnce = vi.spyOn(process, 'once');
    sd.register();
    const events = spyOnce.mock.calls.map(c => c[0]);
    expect(events).toContain('SIGINT');
    expect(events).toContain('SIGTERM');
    spyOnce.mockRestore();
  });
});
