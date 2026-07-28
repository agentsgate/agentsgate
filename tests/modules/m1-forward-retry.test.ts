/**
 * T469 — P3: Forward retry with exponential back-off for MCPProxy.
 *
 * Tests forwardWithRetry behaviour using a mock forwardToTool that counts
 * calls and can be configured to throw on the first N attempts.
 */
import { describe, it, expect, vi } from 'vitest';
import { MCPProxy } from '../../src/modules/m1-proxy/index.js';
import type { MCPOperation, ExecutionResult } from '../../src/types/interfaces.js';

function makeOperation(id = 'op-retry'): MCPOperation {
  return {
    id,
    agentId: 'agent-retry',
    tool: 'filesystem',
    method: 'write_file',
    params: { path: '/tmp/test.txt', content: 'hello' },
    timestamp: new Date(),
    sessionId: 'session-retry',
  };
}

const SUCCESS_RESULT: ExecutionResult = { success: true, durationMs: 1 };

describe('MCPProxy forwardWithRetry — P3', () => {
  it('retries up to maxAttempts and succeeds on the 3rd attempt', async () => {
    let calls = 0;
    const forwardToTool = vi.fn<[MCPOperation], Promise<ExecutionResult>>().mockImplementation(async () => {
      calls++;
      if (calls < 3) throw new Error(`transient error #${calls}`);
      return SUCCESS_RESULT;
    });

    const proxy = new MCPProxy({
      forwardToTool,
      forwardRetry: { maxAttempts: 3, initialDelayMs: 1, backoffMultiplier: 2 },
    });

    const decision = await proxy.intercept(makeOperation());

    expect(decision.action).toBe('allow');
    expect(forwardToTool).toHaveBeenCalledTimes(3);
  });

  it('re-throws after maxAttempts when forwardToTool always throws', async () => {
    const forwardToTool = vi.fn<[MCPOperation], Promise<ExecutionResult>>().mockRejectedValue(
      new Error('persistent error'),
    );

    const proxy = new MCPProxy({
      forwardToTool,
      forwardRetry: { maxAttempts: 3, initialDelayMs: 1, backoffMultiplier: 2 },
    });

    await expect(proxy.intercept(makeOperation())).rejects.toThrow('persistent error');
    expect(forwardToTool).toHaveBeenCalledTimes(3);
  });

  it('propagates the error immediately (no retry) when forwardRetry is not configured', async () => {
    const forwardToTool = vi.fn<[MCPOperation], Promise<ExecutionResult>>().mockRejectedValue(
      new Error('single failure'),
    );

    const proxy = new MCPProxy({ forwardToTool });

    await expect(proxy.intercept(makeOperation())).rejects.toThrow('single failure');
    expect(forwardToTool).toHaveBeenCalledTimes(1);
  });

  it('calls forwardToTool exactly once when the first attempt succeeds', async () => {
    const forwardToTool = vi.fn<[MCPOperation], Promise<ExecutionResult>>().mockResolvedValue(SUCCESS_RESULT);

    const proxy = new MCPProxy({
      forwardToTool,
      forwardRetry: { maxAttempts: 3, initialDelayMs: 1, backoffMultiplier: 2 },
    });

    const decision = await proxy.intercept(makeOperation());

    expect(decision.action).toBe('allow');
    expect(forwardToTool).toHaveBeenCalledTimes(1);
  });

  it('maxAttempts: 1 means no retries — throws immediately on first error', async () => {
    let calls = 0;
    const forwardToTool = vi.fn<[MCPOperation], Promise<ExecutionResult>>().mockImplementation(async () => {
      calls++;
      throw new Error('fail immediately');
    });

    const proxy = new MCPProxy({
      forwardToTool,
      forwardRetry: { maxAttempts: 1, initialDelayMs: 1, backoffMultiplier: 2 },
    });

    await expect(proxy.intercept(makeOperation())).rejects.toThrow('fail immediately');
    expect(calls).toBe(1);
    expect(forwardToTool).toHaveBeenCalledTimes(1);
  });
});
