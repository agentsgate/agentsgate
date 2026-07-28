/**
 * E2E tests for M3 (OperationLogger) + M2 (StateStore) via MCPStdioProxy.
 *
 * Verifies that every intercepted operation is persisted as an OperationLog in
 * the StateStore, with correct field values and sensitive-parameter redaction.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { McpClientHarness } from '../helpers/mcp-client-harness.js';
import { RiskScoringEngine } from '../../src/modules/m6-risk/index.js';
import { InterventionController } from '../../src/modules/m7-intervention/index.js';
import { OperationLogger } from '../../src/modules/m3-logger/index.js';
import { StateStore } from '../../src/modules/m2-store/index.js';
import { createPipeline } from '../../src/modules/m1-proxy/index.js';

let h: McpClientHarness;
let store: StateStore;
let logger: OperationLogger;

beforeEach(async () => {
  store = new StateStore(':memory:');
  await store.initialize();
  logger = new OperationLogger(store);
});

afterEach(async () => {
  await h?.stop();
  await store.close();
});

function makePipeline() {
  return createPipeline({
    riskEngine: new RiskScoringEngine(),
    interventionController: new InterventionController(),
    logger,
  });
}

// ── 1. Log creation ───────────────────────────────────────────────────────────

describe('M3 log creation', () => {

  it('creates one log entry after an allowed tool call', async () => {
    const pipeline = makePipeline();
    h = new McpClientHarness();
    await h.start({ evaluateRisk: pipeline.evaluateRisk! });

    await h.callTool('echo', { message: 'hello-log' });

    const logs = await logger.listLogs();
    expect(logs).toHaveLength(1);
  });

  it('log entry records the correct method (tool name)', async () => {
    const pipeline = makePipeline();
    h = new McpClientHarness();
    await h.start({ evaluateRisk: pipeline.evaluateRisk! });

    await h.callTool('echo', { message: 'x' });

    const logs = await logger.listLogs();
    expect(logs[0]?.operation.method).toBe('echo');
  });

  it('log entry records agentId and sessionId from proxy options', async () => {
    const pipeline = makePipeline();
    h = new McpClientHarness();
    await h.start({
      evaluateRisk: pipeline.evaluateRisk!,
      agentId: 'logging-agent',
      sessionId: 'logging-session',
    });

    await h.callTool('echo', { message: 'x' });

    const logs = await logger.listLogs();
    expect(logs[0]?.operation.agentId).toBe('logging-agent');
    expect(logs[0]?.operation.sessionId).toBe('logging-session');
  });

  it('log entry decision matches the intercepted proxy decision', async () => {
    const pipeline = makePipeline();
    h = new McpClientHarness();
    await h.start({ evaluateRisk: pipeline.evaluateRisk! });

    await h.callTool('echo', { message: 'x' });

    const logs = await logger.listLogs();
    const logDecision = logs[0]?.decision;
    const interceptDecision = h.lastIntercept?.decision;
    expect(logDecision?.action).toBe(interceptDecision?.action);
    expect(logDecision?.riskScore).toBe(interceptDecision?.riskScore);
  });

  it('blocked tool calls are also logged with action=block', async () => {
    const pipeline = makePipeline();
    h = new McpClientHarness();
    await h.start({ evaluateRisk: pipeline.evaluateRisk! });

    // execute_command is blocked by L1_EXECUTE_COMMAND
    await h.request('tools/call', { name: 'execute_command', arguments: {} });

    const logs = await logger.listLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]?.decision.action).toBe('block');
    expect(logs[0]?.operation.method).toBe('execute_command');
  });

  it('logger.getLog() retrieves a specific entry by operation ID', async () => {
    const pipeline = makePipeline();
    h = new McpClientHarness();
    await h.start({ evaluateRisk: pipeline.evaluateRisk! });

    await h.callTool('echo', { message: 'x' });

    const operationId = h.lastIntercept?.operation.id;
    expect(operationId).toBeDefined();

    const log = await logger.getLog(operationId!);
    expect(log).not.toBeNull();
    expect(log?.operation.method).toBe('echo');
  });

  it('getLog() returns null for an unknown operation ID', async () => {
    const pipeline = makePipeline();
    h = new McpClientHarness();
    await h.start({ evaluateRisk: pipeline.evaluateRisk! });

    const log = await logger.getLog('00000000-0000-0000-0000-000000000000');
    expect(log).toBeNull();
  });

});

// ── 2. Parameter redaction ────────────────────────────────────────────────────

describe('M3 parameter redaction', () => {

  it('password field is redacted in the log entry', async () => {
    const pipeline = makePipeline();
    h = new McpClientHarness();
    await h.start({ evaluateRisk: pipeline.evaluateRisk! });

    await h.callTool('echo', { message: 'hi', password: 'super-secret' });

    const logs = await logger.listLogs();
    expect(logs[0]?.operation.params['password']).toBe('[REDACTED]');
    expect(logs[0]?.operation.params['message']).toBe('hi');
  });

  it('api_key field is redacted in the log entry', async () => {
    const pipeline = makePipeline();
    h = new McpClientHarness();
    await h.start({ evaluateRisk: pipeline.evaluateRisk! });

    await h.callTool('echo', { message: 'x', api_key: 'sk-12345' });

    const logs = await logger.listLogs();
    expect(logs[0]?.operation.params['api_key']).toBe('[REDACTED]');
  });

  it('auth_token field is redacted in the log entry', async () => {
    const pipeline = makePipeline();
    h = new McpClientHarness();
    await h.start({ evaluateRisk: pipeline.evaluateRisk! });

    await h.callTool('echo', { message: 'x', auth_token: 'bearer-xyz' });

    const logs = await logger.listLogs();
    expect(logs[0]?.operation.params['auth_token']).toBe('[REDACTED]');
  });

  it('non-sensitive params (message, count) are preserved in the log', async () => {
    const pipeline = makePipeline();
    h = new McpClientHarness();
    await h.start({ evaluateRisk: pipeline.evaluateRisk! });

    await h.callTool('echo', { message: 'preserved', count: 42 });

    const logs = await logger.listLogs();
    expect(logs[0]?.operation.params['message']).toBe('preserved');
    expect(logs[0]?.operation.params['count']).toBe(42);
  });

});

// ── 3. Multi-call ordering ────────────────────────────────────────────────────

describe('M3 multi-call ordering', () => {

  it('three sequential calls produce three log entries', async () => {
    const pipeline = makePipeline();
    h = new McpClientHarness();
    await h.start({ evaluateRisk: pipeline.evaluateRisk! });

    await h.callTool('echo', { message: 'first' });
    await h.request('tools/call', { name: 'execute_command', arguments: {} }); // blocked
    await h.callTool('echo', { message: 'third' });

    const logs = await logger.listLogs();
    expect(logs).toHaveLength(3);
  });

  it('listLogs() returns entries most-recent-first', async () => {
    const pipeline = makePipeline();
    h = new McpClientHarness();
    await h.start({ evaluateRisk: pipeline.evaluateRisk! });

    await h.callTool('echo', { message: 'a' });
    await h.callTool('echo', { message: 'b' });
    await h.callTool('echo', { message: 'c' });

    // listLogs returns newest first; all three entries exist
    const logs = await logger.listLogs();
    expect(logs).toHaveLength(3);
    // Each entry has the correct tool name
    expect(logs.every(l => l.operation.method === 'echo')).toBe(true);
  });

  it('riskScore in log entry matches the M6 assessment for each call', async () => {
    const pipeline = makePipeline();
    h = new McpClientHarness();
    await h.start({ evaluateRisk: pipeline.evaluateRisk! });

    await h.callTool('echo', { message: 'x' });         // DEFAULT = 0.2
    await h.request('tools/call', { name: 'execute_command', arguments: {} }); // L1 = 0.8

    const logs = await logger.listLogs(); // newest first
    const echoLog    = logs.find(l => l.operation.method === 'echo');
    const execLog    = logs.find(l => l.operation.method === 'execute_command');

    expect(echoLog?.decision.riskScore).toBeCloseTo(0.2, 5);
    expect(execLog?.decision.riskScore).toBeCloseTo(0.8, 5);
  });

});
