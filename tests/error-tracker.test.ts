/**
 * T334 — Error Tracking & Debug Mode
 *
 * Covers:
 *   1. ErrorTracker.track() — happy path with Error instance
 *   2. ErrorTracker.track() — non-Error value
 *   3. ErrorTracker.list() — most-recent-first ordering
 *   4. ErrorTracker.list() — respects limit parameter
 *   5. ErrorTracker ring buffer — evicts oldest entry when maxSize exceeded
 *   6. ErrorTracker.clear() — empties the buffer
 *   7. ErrorTracker.track() — stores operationId and context
 *   8. ErrorTracker debug mode — writes to stderr
 *   9. ErrorTracker — no stderr output when debug is false
 *  10. createPipeline — records error in errorTracker when pipeline throws
 *  11. createPipeline — re-throws the original error after tracking
 *  12. GET /errors — returns empty list with no errorTracker configured
 *  13. GET /errors — returns tracked errors via dashboard endpoint
 *  14. GET /errors — respects ?limit query param
 *  15. GET /errors — requires API key when one is configured
 *  16. src/index.ts re-exports ErrorTracker and ErrorEntry
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { ErrorTracker } from '../src/utils/error-tracker.js';
import type { ErrorEntry } from '../src/utils/error-tracker.js';
import { createPipeline } from '../src/modules/m1-proxy/index.js';
import { DashboardAPI } from '../src/modules/m10-dashboard/index.js';
import { StateStore } from '../src/modules/m2-store/index.js';
import type { MCPOperation } from '../src/types/interfaces.js';

// Ports come from start(0). A hand-picked base sits inside the OS ephemeral
// range (49152-65535 on macOS), so any concurrent listen(0) can be handed the
// same number and this suite loses the race with EADDRINUSE.

// ── helpers ──────────────────────────────────────────────────────────────────

function makeOp(id = 'op-test'): MCPOperation {
  return {
    id,
    agentId: 'agent-t334',
    tool: 'filesystem',
    method: 'write_file',
    params: { path: '/tmp/x.txt' },
    timestamp: new Date(),
    sessionId: 'sess-t334',
  };
}

async function getJSON(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
  const body = (await res.json()) as unknown;
  return { status: res.status, body };
}

// ── ErrorTracker unit tests ───────────────────────────────────────────────────

describe('ErrorTracker — track()', () => {
  it('1. track() with Error instance stores message and stack', () => {
    const tracker = new ErrorTracker({ debug: false });
    const err = new Error('boom');
    const entry = tracker.track('proxy', err);
    expect(entry.module).toBe('proxy');
    expect(entry.message).toBe('boom');
    expect(entry.stack).toBeDefined();
    expect(typeof entry.id).toBe('string');
    expect(entry.id.length).toBeGreaterThan(0);
    expect(entry.timestamp).toBeInstanceOf(Date);
  });

  it('2. track() with non-Error value converts to string', () => {
    const tracker = new ErrorTracker({ debug: false });
    const entry = tracker.track('cli', 42);
    expect(entry.message).toBe('42');
    expect(entry.stack).toBeUndefined();
  });

  it('7. track() stores optional operationId and context', () => {
    const tracker = new ErrorTracker({ debug: false });
    const ctx = { foo: 'bar', count: 3 };
    const entry = tracker.track('checkpoint', new Error('fail'), {
      operationId: 'op-abc',
      context: ctx,
    });
    expect(entry.operationId).toBe('op-abc');
    expect(entry.context).toEqual(ctx);
  });
});

describe('ErrorTracker — list()', () => {
  it('3. list() returns entries in most-recent-first order', () => {
    const tracker = new ErrorTracker({ debug: false });
    tracker.track('m1', new Error('first'));
    tracker.track('m2', new Error('second'));
    tracker.track('m3', new Error('third'));
    const list = tracker.list();
    expect(list[0]!.message).toBe('third');
    expect(list[1]!.message).toBe('second');
    expect(list[2]!.message).toBe('first');
  });

  it('4. list() respects the limit parameter', () => {
    const tracker = new ErrorTracker({ debug: false });
    for (let i = 0; i < 10; i++) {
      tracker.track('m', new Error(`err-${i}`));
    }
    const list = tracker.list(3);
    expect(list).toHaveLength(3);
    // Newest three: err-9, err-8, err-7
    expect(list[0]!.message).toBe('err-9');
    expect(list[1]!.message).toBe('err-8');
    expect(list[2]!.message).toBe('err-7');
  });
});

describe('ErrorTracker — ring buffer', () => {
  it('5. ring buffer evicts oldest entry when maxSize is exceeded', () => {
    const tracker = new ErrorTracker({ maxSize: 3, debug: false });
    tracker.track('m', new Error('a'));
    tracker.track('m', new Error('b'));
    tracker.track('m', new Error('c'));
    tracker.track('m', new Error('d')); // pushes 'a' out

    const list = tracker.list(10);
    expect(list).toHaveLength(3);
    const messages = list.map(e => e.message);
    expect(messages).not.toContain('a');
    expect(messages).toContain('b');
    expect(messages).toContain('c');
    expect(messages).toContain('d');
  });
});

describe('ErrorTracker — clear()', () => {
  it('6. clear() empties the buffer', () => {
    const tracker = new ErrorTracker({ debug: false });
    tracker.track('m', new Error('one'));
    tracker.track('m', new Error('two'));
    tracker.clear();
    expect(tracker.list()).toHaveLength(0);
  });
});

describe('ErrorTracker — debug mode', () => {
  it('8. debug mode writes to stderr when debug: true', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const tracker = new ErrorTracker({ debug: true });
      tracker.track('proxy', new Error('debug-test'));
      expect(stderrSpy).toHaveBeenCalled();
      const written = stderrSpy.mock.calls.map(c => String(c[0])).join('');
      expect(written).toContain('debug-test');
      expect(written).toContain('proxy');
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('9. no stderr output when debug is false', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const tracker = new ErrorTracker({ debug: false });
      tracker.track('proxy', new Error('silent'));
      expect(stderrSpy).not.toHaveBeenCalled();
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

// ── createPipeline integration ────────────────────────────────────────────────

describe('createPipeline — errorTracker integration', () => {
  it('10. records error in errorTracker when riskEngine.assess() throws', async () => {
    const errorTracker = new ErrorTracker({ debug: false });
    const failingRiskEngine = {
      assess: async (_op: MCPOperation) => {
        throw new Error('risk engine exploded');
      },
    };
    const interventionController = {
      decide: async () => ({ action: 'allow' as const, riskScore: 0, reasons: [] }),
    };

    const config = createPipeline({
      riskEngine: failingRiskEngine as never,
      interventionController: interventionController as never,
      errorTracker,
    });

    const op = makeOp('op-pipeline-1');
    await expect(config.evaluateRisk!(op)).rejects.toThrow('risk engine exploded');

    const entries = errorTracker.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.module).toBe('proxy');
    expect(entries[0]!.message).toBe('risk engine exploded');
    expect(entries[0]!.operationId).toBe('op-pipeline-1');
  });

  it('11. re-throws the original error after tracking', async () => {
    const errorTracker = new ErrorTracker({ debug: false });
    const originalError = new Error('original-error');
    const failingRiskEngine = {
      assess: async () => { throw originalError; },
    };
    const interventionController = {
      decide: async () => ({ action: 'allow' as const, riskScore: 0, reasons: [] }),
    };

    const config = createPipeline({
      riskEngine: failingRiskEngine as never,
      interventionController: interventionController as never,
      errorTracker,
    });

    const op = makeOp('op-rethrow');
    await expect(config.evaluateRisk!(op)).rejects.toThrow(originalError);
  });
});

// ── GET /errors dashboard endpoint ───────────────────────────────────────────

describe('DashboardAPI GET /errors — no errorTracker', () => {
  let store: StateStore;
  let dash: DashboardAPI;
  let port: number;

  beforeEach(async () => {
    store = new StateStore(':memory:');
    await store.initialize();
    dash = new DashboardAPI(store, {});
    await dash.start(0);
    port = dash.getPort();
  });

  afterEach(async () => {
    await dash.stop();
    await store.close();
  });

  it('12. returns empty errors list when no errorTracker configured', async () => {
    const { status, body } = await getJSON(port, '/errors');
    expect(status).toBe(200);
    const b = body as { errors: ErrorEntry[]; total: number };
    expect(b.errors).toEqual([]);
    expect(b.total).toBe(0);
  });
});

describe('DashboardAPI GET /errors — with errorTracker', () => {
  let store: StateStore;
  let dash: DashboardAPI;
  let errorTracker: ErrorTracker;
  let port: number;

  beforeEach(async () => {
    store = new StateStore(':memory:');
    await store.initialize();
    errorTracker = new ErrorTracker({ debug: false });
    dash = new DashboardAPI(store, { errorTracker });
    await dash.start(0);
    port = dash.getPort();
  });

  afterEach(async () => {
    await dash.stop();
    await store.close();
  });

  it('13. returns tracked errors via GET /errors', async () => {
    errorTracker.track('proxy', new Error('test-error-1'));
    errorTracker.track('dashboard', new Error('test-error-2'));

    const { status, body } = await getJSON(port, '/errors');
    expect(status).toBe(200);
    const b = body as { errors: ErrorEntry[]; total: number };
    expect(b.total).toBe(2);
    expect(b.errors).toHaveLength(2);
    // most-recent-first
    expect(b.errors[0]!.message).toBe('test-error-2');
    expect(b.errors[1]!.message).toBe('test-error-1');
  });

  it('14. GET /errors respects ?limit query param', async () => {
    for (let i = 0; i < 5; i++) {
      errorTracker.track('proxy', new Error(`err-${i}`));
    }
    const { status, body } = await getJSON(port, '/errors?limit=2');
    expect(status).toBe(200);
    const b = body as { errors: ErrorEntry[]; total: number };
    expect(b.errors).toHaveLength(2);
    expect(b.total).toBe(2);
    expect(b.errors[0]!.message).toBe('err-4');
    expect(b.errors[1]!.message).toBe('err-3');
  });
});

describe('DashboardAPI GET /errors — API key authentication', () => {
  let store: StateStore;
  let dash: DashboardAPI;
  let port: number;
  const API_KEY = 'test-key-t334';

  beforeEach(async () => {
    store = new StateStore(':memory:');
    await store.initialize();
    const errorTracker = new ErrorTracker({ debug: false });
    errorTracker.track('proxy', new Error('protected-error'));
    dash = new DashboardAPI(store, { apiKey: API_KEY, errorTracker });
    await dash.start(0);
    port = dash.getPort();
  });

  afterEach(async () => {
    await dash.stop();
    await store.close();
  });

  it('15a. GET /errors requires API key — returns 401 without key', async () => {
    const { status } = await getJSON(port, '/errors');
    expect(status).toBe(401);
  });

  it('15b. GET /errors succeeds with correct API key', async () => {
    const { status, body } = await getJSON(port, '/errors', { 'x-api-key': API_KEY });
    expect(status).toBe(200);
    const b = body as { errors: ErrorEntry[]; total: number };
    expect(b.total).toBe(1);
    expect(b.errors[0]!.module).toBe('proxy');
  });
});

// ── re-export from src/index.ts ───────────────────────────────────────────────

describe('src/index.ts re-exports', () => {
  it('16. ErrorTracker and ErrorEntry are re-exported from src/index.ts', async () => {
    const indexModule = await import('../src/index.js') as Record<string, unknown>;
    expect(typeof indexModule['ErrorTracker']).toBe('function');
    // ErrorEntry is a type export — verify ErrorTracker constructor works as proxy
    const tracker = new (indexModule['ErrorTracker'] as typeof ErrorTracker)({ debug: false });
    const entry = tracker.track('m', new Error('re-export test'));
    expect(entry.message).toBe('re-export test');
  });
});
