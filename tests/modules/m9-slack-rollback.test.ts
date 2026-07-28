/**
 * T469 — RB6: SlackRollbackAdapter
 *
 * Uses a real in-process Node.js HTTP server (port 0) as a mock Slack API
 * to verify canRollback, captureState, rollback, and previewRollback.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import { SlackRollbackAdapter } from '../../src/modules/m9-adapters/slack-rollback-adapter.js';
import type { MCPOperation, StateSnapshot } from '../../src/types/interfaces.js';

// ── Mock Slack HTTP server ────────────────────────────────────────────────────

type MockConfig = {
  /** HTTP status to return (default 200) */
  status?: number;
  /** JSON body to return */
  body?: object;
  /** If true, the server closes the connection to simulate a network error */
  closeImmediately?: boolean;
};

let mockServer: http.Server;
let mockPort: number;
let mockCfg: MockConfig = {};

// Track last request details for assertions
let lastRequestAuth: string | undefined;
let lastRequestBody: string;

beforeAll(async () => {
  await new Promise<void>(resolve => {
    mockServer = http.createServer((req, res) => {
      if (mockCfg.closeImmediately) {
        req.socket.destroy();
        return;
      }
      lastRequestAuth = req.headers['authorization'];
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        lastRequestBody = body;
        const status = mockCfg.status ?? 200;
        const responseBody = mockCfg.body ?? { ok: true };
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(responseBody));
      });
    });
    mockServer.listen(0, '127.0.0.1', () => {
      const addr = mockServer.address() as { port: number };
      mockPort = addr.port;
      resolve();
    });
  });
});

afterAll(() => {
  mockServer.close();
});

beforeEach(() => {
  mockCfg = {};
  lastRequestAuth = undefined;
  lastRequestBody = '';
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeAdapter() {
  return new SlackRollbackAdapter(`xoxb-test-token`, `http://127.0.0.1:${mockPort}`, true);
}

function makeSlackOp(tool = 'slack', method = 'send_message', channel = 'C12345'): MCPOperation {
  return {
    id: 'op-slack-1',
    agentId: 'agent-slack',
    tool,
    method,
    params: { channel, text: 'hello world' },
    timestamp: new Date(),
    sessionId: 'sess-slack',
  };
}

function makeSnapshot(channel?: string, messageTs?: string): StateSnapshot {
  return {
    adapterId: 'agentsgate-slack',
    operationId: 'op-slack-1',
    data: { channel, messageTs },
    capturedAt: new Date(),
  };
}

// ── canRollback ───────────────────────────────────────────────────────────────

describe('SlackRollbackAdapter.canRollback', () => {
  it('returns canRollback=true for tool=slack, method=send_message', async () => {
    const adapter = makeAdapter();
    const cap = await adapter.canRollback(makeSlackOp('slack', 'send_message'));
    expect(cap.canRollback).toBe(true);
  });

  it('returns canRollback=false for a non-slack tool', async () => {
    const adapter = makeAdapter();
    const cap = await adapter.canRollback(makeSlackOp('github', 'send_message'));
    expect(cap.canRollback).toBe(false);
  });

  it('returns canRollback=false for slack tool but non-send method (list_channels)', async () => {
    const adapter = makeAdapter();
    const cap = await adapter.canRollback(makeSlackOp('slack', 'list_channels'));
    expect(cap.canRollback).toBe(false);
  });
});

// ── captureState ──────────────────────────────────────────────────────────────

describe('SlackRollbackAdapter.captureState', () => {
  it('includes channel from operation params in snapshot data', async () => {
    const adapter = makeAdapter();
    const snapshot = await adapter.captureState(makeSlackOp('slack', 'send_message', 'C99999'));
    expect((snapshot.data as { channel: string }).channel).toBe('C99999');
  });
});

// ── rollback ─────────────────────────────────────────────────────────────────

describe('SlackRollbackAdapter.rollback', () => {
  it('returns error when messageTs is missing from snapshot', async () => {
    const adapter = makeAdapter();
    const result = await adapter.rollback(makeSnapshot('C12345', undefined));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Missing channel or messageTs/);
  });

  it('returns error when channel is missing from snapshot', async () => {
    const adapter = makeAdapter();
    const result = await adapter.rollback(makeSnapshot(undefined, '1234567890.123456'));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Missing channel or messageTs/);
  });

  it('calls Slack chat.delete with correct Authorization header and body', async () => {
    mockCfg = { status: 200, body: { ok: true } };
    const adapter = makeAdapter();
    const result = await adapter.rollback(makeSnapshot('C12345', '1234567890.123456'));

    expect(result.success).toBe(true);
    expect(result.restoredFiles).toContain('slack:C12345:1234567890.123456');
    expect(lastRequestAuth).toBe('Bearer xoxb-test-token');
    const parsedBody = JSON.parse(lastRequestBody) as { channel: string; ts: string };
    expect(parsedBody.channel).toBe('C12345');
    expect(parsedBody.ts).toBe('1234567890.123456');
  });

  it('handles Slack API { ok: false, error: "message_not_found" } gracefully', async () => {
    mockCfg = { status: 200, body: { ok: false, error: 'message_not_found' } };
    const adapter = makeAdapter();
    const result = await adapter.rollback(makeSnapshot('C12345', '1234567890.123456'));

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/message_not_found/);
    expect(result.failedFiles).toContain('slack:C12345:1234567890.123456');
  });

  it('handles HTTP error (non-200 status) gracefully', async () => {
    mockCfg = { status: 429, body: { ok: false, error: 'ratelimited' } };
    const adapter = makeAdapter();
    const result = await adapter.rollback(makeSnapshot('C12345', '1234567890.123456'));

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/HTTP 429/);
    expect(result.failedFiles).toContain('slack:C12345:1234567890.123456');
  });

  it('handles network errors (fetch throws) gracefully', async () => {
    // Point adapter at a port where nothing is listening
    const deadAdapter = new SlackRollbackAdapter('xoxb-test-token', 'http://127.0.0.1:1', true);
    const result = await deadAdapter.rollback(makeSnapshot('C12345', '1234567890.123456'));

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.failedFiles).toContain('slack:C12345:1234567890.123456');
  });
});

// ── previewRollback ───────────────────────────────────────────────────────────

describe('SlackRollbackAdapter.previewRollback', () => {
  it('returns correct description with channel and ts when both are present', async () => {
    const adapter = makeAdapter();
    const preview = await adapter.previewRollback(makeSnapshot('C12345', '1234567890.123456'));

    expect(preview.willRestore).toHaveLength(1);
    expect(preview.willRestore[0]).toContain('C12345');
    expect(preview.willRestore[0]).toContain('1234567890.123456');
  });

  it('returns empty willRestore when snapshot data is missing', async () => {
    const adapter = makeAdapter();
    const preview = await adapter.previewRollback(makeSnapshot(undefined, undefined));

    expect(preview.willRestore).toHaveLength(0);
  });
});
