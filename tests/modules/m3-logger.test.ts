import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OperationLogger, redactParams } from '../../src/modules/m3-logger/index.js';
import { StateStore } from '../../src/modules/m2-store/index.js';
import type { MCPOperation, ProxyDecision, ExecutionResult } from '../../src/types/interfaces.js';

function makeOperation(id = 'op-1'): MCPOperation {
  return {
    id,
    agentId: 'agent-1',
    tool: 'filesystem',
    method: 'write_file',
    params: { path: '/tmp/test.txt' },
    timestamp: new Date('2026-01-01T00:00:00Z'),
    sessionId: 'session-1',
  };
}

const allowDecision: ProxyDecision = {
  action: 'allow',
  riskScore: 0.1,
  reasons: ['low risk'],
};

const blockDecision: ProxyDecision = {
  action: 'block',
  riskScore: 0.95,
  reasons: ['destructive operation'],
};

const execResult: ExecutionResult = {
  success: true,
  output: { bytesWritten: 42 },
  durationMs: 12,
};

describe('OperationLogger', () => {
  let store: StateStore;
  let logger: OperationLogger;

  beforeEach(async () => {
    store = new StateStore(':memory:');
    await store.initialize();
    logger = new OperationLogger(store);
  });

  afterEach(async () => {
    await store.close();
  });

  it('should log an operation with decision and return an OperationLog', async () => {
    const log = await logger.log(makeOperation('op-1'), allowDecision);

    expect(log.operationId).toBe('op-1');
    expect(log.operation.tool).toBe('filesystem');
    expect(log.decision.action).toBe('allow');
    expect(log.executionResult).toBeUndefined();
    expect(log.createdAt).toBeInstanceOf(Date);
  });

  it('should retrieve a log by operationId', async () => {
    await logger.log(makeOperation('op-2'), blockDecision);

    const retrieved = await logger.getLog('op-2');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.decision.action).toBe('block');
    expect(retrieved!.decision.riskScore).toBe(0.95);

    const missing = await logger.getLog('does-not-exist');
    expect(missing).toBeNull();
  });

  it('should list logs with limit and offset', async () => {
    await logger.log(makeOperation('op-a'), allowDecision);
    await logger.log(makeOperation('op-b'), allowDecision);
    await logger.log(makeOperation('op-c'), blockDecision);

    const all = await logger.listLogs();
    expect(all).toHaveLength(3);

    const page = await logger.listLogs(2, 0);
    expect(page).toHaveLength(2);

    const rest = await logger.listLogs(10, 2);
    expect(rest).toHaveLength(1);
  });

  it('should log an operation with an execution result', async () => {
    const log = await logger.log(makeOperation('op-3'), allowDecision, execResult);

    expect(log.executionResult).toBeDefined();
    expect(log.executionResult!.success).toBe(true);
    expect(log.executionResult!.durationMs).toBe(12);

    // Verify persisted and round-tripped correctly
    const retrieved = await logger.getLog('op-3');
    expect(retrieved!.executionResult!.output).toEqual({ bytesWritten: 42 });
  });
});

describe('redactParams', () => {
  it('redacts password fields', () => {
    const result = redactParams({ path: '/tmp/x.txt', password: 'supersecret123' });
    expect(result.password).toBe('[REDACTED]');
    expect(result.path).toBe('/tmp/x.txt');
  });

  it('redacts api_key and apiKey fields', () => {
    expect(redactParams({ api_key: 'sk-abc123' }).api_key).toBe('[REDACTED]');
    expect(redactParams({ apiKey: 'sk-abc123' }).apiKey).toBe('[REDACTED]');
  });

  it('redacts auth_token and access_token', () => {
    expect(redactParams({ auth_token: 'tok-xxx' }).auth_token).toBe('[REDACTED]');
    expect(redactParams({ access_token: 'tok-yyy' }).access_token).toBe('[REDACTED]');
  });

  it('redacts secret fields', () => {
    expect(redactParams({ secret: 'my-secret' }).secret).toBe('[REDACTED]');
    expect(redactParams({ client_secret: 'abc' }).client_secret).toBe('[REDACTED]');
  });

  it('does not redact safe fields', () => {
    const result = redactParams({ path: '/tmp/file.txt', method: 'write', count: 5 });
    expect(result.path).toBe('/tmp/file.txt');
    expect(result.method).toBe('write');
    expect(result.count).toBe(5);
  });

  it('returns empty object for empty params', () => {
    expect(redactParams({})).toEqual({});
  });
});

describe('OperationLogger — param redaction', () => {
  let store: StateStore;

  beforeEach(async () => {
    store = new StateStore(':memory:');
    await store.initialize();
  });

  afterEach(async () => {
    await store.close();
  });

  it('redacts sensitive params by default before persisting', async () => {
    const logger = new OperationLogger(store);
    const op: import('../../src/types/interfaces.js').MCPOperation = {
      id: 'op-redact',
      agentId: 'agent-1',
      tool: 'api',
      method: 'call',
      params: { endpoint: '/auth', password: 'hunter2', apiKey: 'sk-secret' },
      timestamp: new Date(),
      sessionId: 'sess-1',
    };
    const log = await logger.log(op, { action: 'allow', riskScore: 0.1, reasons: [] });
    expect(log.operation.params.password).toBe('[REDACTED]');
    expect(log.operation.params.apiKey).toBe('[REDACTED]');
    expect(log.operation.params.endpoint).toBe('/auth');

    // Also verify what was actually stored
    const retrieved = await logger.getLog('op-redact');
    expect(retrieved!.operation.params.password).toBe('[REDACTED]');
  });

  it('does not redact when redact: false', async () => {
    const logger = new OperationLogger(store, undefined, { redact: false });
    const op: import('../../src/types/interfaces.js').MCPOperation = {
      id: 'op-no-redact',
      agentId: 'agent-1',
      tool: 'api',
      method: 'call',
      params: { password: 'hunter2' },
      timestamp: new Date(),
      sessionId: 'sess-1',
    };
    const log = await logger.log(op, { action: 'allow', riskScore: 0.1, reasons: [] });
    expect(log.operation.params.password).toBe('hunter2');
  });
});
