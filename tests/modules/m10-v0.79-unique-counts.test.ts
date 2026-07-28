/**
 * v0.79 tests — unique count fields
 *
 * T512 — uniqueAgents in GET /tools/:tool
 *   Create ops for the same tool from 3 different agents.
 *   Verify uniqueAgents === 3.
 *
 * T513 — uniqueAgents / uniqueTools in GET /sessions/:sessionId
 *   Create a session with ops from 2 different agents using 3 different tools.
 *   Verify uniqueAgents === 2 and uniqueTools === 3.
 *
 * T514 — uniqueTools in GET /agents/:agentId
 *   Create an agent that uses 4 different tools.
 *   Verify uniqueTools === 4.
 *
 * T515 — uniqueMethods in GET /operations/summary
 *   Create ops using 2 different methods.
 *   Verify uniqueMethods === 2.
 *
 * Store:  StateStore ':memory:'
 * Server: http.createServer / port 0
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { StateStore } from '../../src/modules/m2-store/index.js';
import { DashboardAPI } from '../../src/modules/m10-dashboard/index.js';
import type { MCPOperation, OperationLog, ProxyDecision } from '../../src/types/interfaces.js';

// ── helpers ────────────────────────────────────────────────────────────────────

function makeOp(overrides: Partial<MCPOperation> = {}): MCPOperation {
  return {
    id: crypto.randomUUID(),
    agentId: 'agent-default',
    tool: 'tool-default',
    method: 'call',
    params: {},
    timestamp: new Date(),
    sessionId: 'sess-default',
    ...overrides,
  };
}

function dec(
  action: ProxyDecision['action'] = 'allow',
  riskScore = 0.1,
): ProxyDecision {
  return { action, riskScore, reasons: [] };
}

interface Ctx {
  store: StateStore;
  dash: DashboardAPI;
  port: number;
}

async function setup(): Promise<Ctx> {
  const store = new StateStore(':memory:');
  await store.initialize();
  const dash = new DashboardAPI(store, {});
  await dash.start(0);
  const port = (
    (dash as unknown as { server: http.Server }).server.address() as { port: number }
  ).port;
  return { store, dash, port };
}

async function teardown(ctx: Ctx): Promise<void> {
  await ctx.dash.stop();
  await ctx.store.close();
}

async function getJSON(
  port: number,
  path: string,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, body: await res.json() };
}

async function saveLog(
  store: StateStore,
  op: MCPOperation,
  decision: ProxyDecision,
  createdAtMs: number,
): Promise<void> {
  const log: OperationLog = {
    operationId: op.id,
    operation: op,
    decision,
    createdAt: new Date(createdAtMs),
  };
  await store.saveOperationLog(log);
}

// ── T512 — uniqueAgents in GET /tools/:tool ────────────────────────────────────

describe('T512 — uniqueAgents in GET /tools/:tool', () => {
  let ctx: Ctx;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('1. uniqueAgents === 3 when 3 different agents each call the same tool', async () => {
    ctx = await setup();

    const tool = 'tool-512-agents';
    const BASE = 1_900_000_000_000;

    const agents = ['agent-512-a', 'agent-512-b', 'agent-512-c'];
    for (let i = 0; i < agents.length; i++) {
      const createdAtMs = BASE + i * 1_000;
      const op = makeOp({
        agentId: agents[i],
        tool,
        method: 'call',
        sessionId: 'sess-512',
        timestamp: new Date(createdAtMs),
      });
      await saveLog(ctx.store, op, dec('allow', 0.2), createdAtMs);
    }

    const { status, body } = await getJSON(ctx.port, `/tools/${tool}`);
    expect(status).toBe(200);
    const b = body as { uniqueAgents: number };
    expect(b.uniqueAgents).toBe(3);
  });

  it('2. uniqueAgents field is present and numeric in the tool detail response', async () => {
    ctx = await setup();

    const tool = 'tool-512-present';
    const BASE = 1_900_100_000_000;

    const op = makeOp({
      agentId: 'agent-512-present',
      tool,
      method: 'call',
      sessionId: 'sess-512p',
      timestamp: new Date(BASE),
    });
    await saveLog(ctx.store, op, dec('allow', 0.1), BASE);

    const { status, body } = await getJSON(ctx.port, `/tools/${tool}`);
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect('uniqueAgents' in b).toBe(true);
    expect(typeof b['uniqueAgents']).toBe('number');
  });

  it('3. uniqueAgents === 1 when all ops come from the same agent', async () => {
    ctx = await setup();

    const tool = 'tool-512-single';
    const BASE = 1_900_200_000_000;

    for (let i = 0; i < 3; i++) {
      const createdAtMs = BASE + i * 1_000;
      const op = makeOp({
        agentId: 'agent-512-only',
        tool,
        method: 'call',
        sessionId: 'sess-512s',
        timestamp: new Date(createdAtMs),
      });
      await saveLog(ctx.store, op, dec('allow', 0.1), createdAtMs);
    }

    const { status, body } = await getJSON(ctx.port, `/tools/${tool}`);
    expect(status).toBe(200);
    const b = body as { uniqueAgents: number };
    expect(b.uniqueAgents).toBe(1);
  });

  it('4. uniqueAgents counts each agent once even when same agent has multiple ops', async () => {
    ctx = await setup();

    const tool = 'tool-512-dedup';
    const BASE = 1_900_300_000_000;

    // agent-A calls 3 times, agent-B calls 2 times — expect uniqueAgents === 2
    for (let i = 0; i < 3; i++) {
      const createdAtMs = BASE + i * 1_000;
      const op = makeOp({ agentId: 'agent-512-A', tool, method: 'write', sessionId: 'sess-512d', timestamp: new Date(createdAtMs) });
      await saveLog(ctx.store, op, dec('allow', 0.2), createdAtMs);
    }
    for (let i = 0; i < 2; i++) {
      const createdAtMs = BASE + 10_000 + i * 1_000;
      const op = makeOp({ agentId: 'agent-512-B', tool, method: 'read', sessionId: 'sess-512d', timestamp: new Date(createdAtMs) });
      await saveLog(ctx.store, op, dec('allow', 0.1), createdAtMs);
    }

    const { status, body } = await getJSON(ctx.port, `/tools/${tool}`);
    expect(status).toBe(200);
    const b = body as { uniqueAgents: number };
    expect(b.uniqueAgents).toBe(2);
  });
});

// ── T513 — uniqueAgents / uniqueTools in GET /sessions/:sessionId ──────────────

describe('T513 — uniqueAgents and uniqueTools in GET /sessions/:sessionId', () => {
  let ctx: Ctx;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('5. uniqueAgents === 2 and uniqueTools === 3 for a session with 2 agents and 3 tools', async () => {
    ctx = await setup();

    const sessionId = 'sess-513-main';
    const BASE = 1_901_000_000_000;

    // agent-A uses tool-1 and tool-2
    const opsA = [
      makeOp({ agentId: 'agent-513-A', tool: 'tool-513-1', method: 'call', sessionId, timestamp: new Date(BASE) }),
      makeOp({ agentId: 'agent-513-A', tool: 'tool-513-2', method: 'call', sessionId, timestamp: new Date(BASE + 1_000) }),
    ];
    // agent-B uses tool-3
    const opsB = [
      makeOp({ agentId: 'agent-513-B', tool: 'tool-513-3', method: 'call', sessionId, timestamp: new Date(BASE + 2_000) }),
    ];

    for (let i = 0; i < opsA.length; i++) {
      await saveLog(ctx.store, opsA[i]!, dec('allow', 0.2), BASE + i * 1_000);
    }
    await saveLog(ctx.store, opsB[0]!, dec('allow', 0.1), BASE + 2_000);

    const { status, body } = await getJSON(ctx.port, `/sessions/${sessionId}`);
    expect(status).toBe(200);
    const b = body as { uniqueAgents: number; uniqueTools: number };
    expect(b.uniqueAgents).toBe(2);
    expect(b.uniqueTools).toBe(3);
  });

  it('6. uniqueAgents field is present and numeric in the session detail response', async () => {
    ctx = await setup();

    const sessionId = 'sess-513-present';
    const BASE = 1_901_100_000_000;

    const op = makeOp({ agentId: 'agent-513-p', tool: 'tool-p', method: 'call', sessionId, timestamp: new Date(BASE) });
    await saveLog(ctx.store, op, dec('allow', 0.1), BASE);

    const { status, body } = await getJSON(ctx.port, `/sessions/${sessionId}`);
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect('uniqueAgents' in b).toBe(true);
    expect(typeof b['uniqueAgents']).toBe('number');
  });

  it('7. uniqueTools field is present and numeric in the session detail response', async () => {
    ctx = await setup();

    const sessionId = 'sess-513-tools-present';
    const BASE = 1_901_200_000_000;

    const op = makeOp({ agentId: 'agent-513-q', tool: 'tool-q', method: 'call', sessionId, timestamp: new Date(BASE) });
    await saveLog(ctx.store, op, dec('allow', 0.1), BASE);

    const { status, body } = await getJSON(ctx.port, `/sessions/${sessionId}`);
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect('uniqueTools' in b).toBe(true);
    expect(typeof b['uniqueTools']).toBe('number');
  });

  it('8. uniqueAgents and uniqueTools are each 1 when session has one agent and one tool', async () => {
    ctx = await setup();

    const sessionId = 'sess-513-single';
    const BASE = 1_901_300_000_000;

    for (let i = 0; i < 4; i++) {
      const createdAtMs = BASE + i * 1_000;
      const op = makeOp({ agentId: 'agent-513-only', tool: 'tool-513-only', method: 'call', sessionId, timestamp: new Date(createdAtMs) });
      await saveLog(ctx.store, op, dec('allow', 0.1), createdAtMs);
    }

    const { status, body } = await getJSON(ctx.port, `/sessions/${sessionId}`);
    expect(status).toBe(200);
    const b = body as { uniqueAgents: number; uniqueTools: number };
    expect(b.uniqueAgents).toBe(1);
    expect(b.uniqueTools).toBe(1);
  });

  it('9. uniqueTools counts each tool once even when the same tool is used multiple times', async () => {
    ctx = await setup();

    const sessionId = 'sess-513-dedup';
    const BASE = 1_901_400_000_000;

    // tool-1 used 3 times, tool-2 used 2 times — uniqueTools should be 2
    const tools = ['tool-513-X', 'tool-513-X', 'tool-513-X', 'tool-513-Y', 'tool-513-Y'];
    for (let i = 0; i < tools.length; i++) {
      const createdAtMs = BASE + i * 1_000;
      const op = makeOp({ agentId: 'agent-513-dedup', tool: tools[i], method: 'call', sessionId, timestamp: new Date(createdAtMs) });
      await saveLog(ctx.store, op, dec('allow', 0.1), createdAtMs);
    }

    const { status, body } = await getJSON(ctx.port, `/sessions/${sessionId}`);
    expect(status).toBe(200);
    const b = body as { uniqueTools: number };
    expect(b.uniqueTools).toBe(2);
  });
});

// ── T514 — uniqueTools in GET /agents/:agentId ────────────────────────────────

describe('T514 — uniqueTools in GET /agents/:agentId', () => {
  let ctx: Ctx;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('10. uniqueTools === 4 when agent uses 4 different tools', async () => {
    ctx = await setup();

    const agentId = 'agent-514-four';
    const BASE = 1_902_000_000_000;

    const tools = ['tool-514-1', 'tool-514-2', 'tool-514-3', 'tool-514-4'];
    for (let i = 0; i < tools.length; i++) {
      const createdAtMs = BASE + i * 1_000;
      const op = makeOp({ agentId, tool: tools[i], method: 'call', sessionId: 'sess-514', timestamp: new Date(createdAtMs) });
      await saveLog(ctx.store, op, dec('allow', 0.2), createdAtMs);
    }

    const { status, body } = await getJSON(ctx.port, `/agents/${agentId}`);
    expect(status).toBe(200);
    const b = body as { uniqueTools: number };
    expect(b.uniqueTools).toBe(4);
  });

  it('11. uniqueTools field is present and numeric in the agent detail response', async () => {
    ctx = await setup();

    const agentId = 'agent-514-present';
    const BASE = 1_902_100_000_000;

    const op = makeOp({ agentId, tool: 'tool-514-p', method: 'call', sessionId: 'sess-514p', timestamp: new Date(BASE) });
    await saveLog(ctx.store, op, dec('allow', 0.1), BASE);

    const { status, body } = await getJSON(ctx.port, `/agents/${agentId}`);
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect('uniqueTools' in b).toBe(true);
    expect(typeof b['uniqueTools']).toBe('number');
  });

  it('12. uniqueTools === 1 when agent only uses one tool across many ops', async () => {
    ctx = await setup();

    const agentId = 'agent-514-single';
    const BASE = 1_902_200_000_000;

    for (let i = 0; i < 5; i++) {
      const createdAtMs = BASE + i * 1_000;
      const op = makeOp({ agentId, tool: 'tool-514-only', method: 'call', sessionId: 'sess-514s', timestamp: new Date(createdAtMs) });
      await saveLog(ctx.store, op, dec('allow', 0.1), createdAtMs);
    }

    const { status, body } = await getJSON(ctx.port, `/agents/${agentId}`);
    expect(status).toBe(200);
    const b = body as { uniqueTools: number };
    expect(b.uniqueTools).toBe(1);
  });

  it('13. uniqueTools counts each tool once even when a tool is called multiple times', async () => {
    ctx = await setup();

    const agentId = 'agent-514-dedup';
    const BASE = 1_902_300_000_000;

    // tool-A called 4 times, tool-B called 3 times — uniqueTools should be 2
    const toolCalls = [
      'tool-514-A', 'tool-514-A', 'tool-514-A', 'tool-514-A',
      'tool-514-B', 'tool-514-B', 'tool-514-B',
    ];
    for (let i = 0; i < toolCalls.length; i++) {
      const createdAtMs = BASE + i * 1_000;
      const op = makeOp({ agentId, tool: toolCalls[i], method: 'write', sessionId: 'sess-514d', timestamp: new Date(createdAtMs) });
      await saveLog(ctx.store, op, dec('allow', 0.2), createdAtMs);
    }

    const { status, body } = await getJSON(ctx.port, `/agents/${agentId}`);
    expect(status).toBe(200);
    const b = body as { uniqueTools: number };
    expect(b.uniqueTools).toBe(2);
  });

  it('14. uniqueTools spans tools used across different sessions of the same agent', async () => {
    ctx = await setup();

    const agentId = 'agent-514-sessions';
    const BASE = 1_902_400_000_000;

    // Session 1: tool-1, tool-2
    const session1Ops = [
      makeOp({ agentId, tool: 'tool-514-s1', method: 'call', sessionId: 'sess-514-x1', timestamp: new Date(BASE) }),
      makeOp({ agentId, tool: 'tool-514-s2', method: 'call', sessionId: 'sess-514-x1', timestamp: new Date(BASE + 1_000) }),
    ];
    // Session 2: tool-3, tool-4
    const session2Ops = [
      makeOp({ agentId, tool: 'tool-514-s3', method: 'call', sessionId: 'sess-514-x2', timestamp: new Date(BASE + 2_000) }),
      makeOp({ agentId, tool: 'tool-514-s4', method: 'call', sessionId: 'sess-514-x2', timestamp: new Date(BASE + 3_000) }),
    ];

    for (let i = 0; i < session1Ops.length; i++) {
      await saveLog(ctx.store, session1Ops[i]!, dec('allow', 0.1), BASE + i * 1_000);
    }
    for (let i = 0; i < session2Ops.length; i++) {
      await saveLog(ctx.store, session2Ops[i]!, dec('allow', 0.1), BASE + 2_000 + i * 1_000);
    }

    const { status, body } = await getJSON(ctx.port, `/agents/${agentId}`);
    expect(status).toBe(200);
    const b = body as { uniqueTools: number };
    expect(b.uniqueTools).toBe(4);
  });
});

// ── T515 — uniqueMethods in GET /operations/summary ───────────────────────────

describe('T515 — uniqueMethods in GET /operations/summary', () => {
  let ctx: Ctx;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('15. uniqueMethods === 2 when ops use 2 different methods', async () => {
    ctx = await setup();

    const BASE = 1_903_000_000_000;

    // method-1 used twice, method-2 used once
    const methods = ['write_file', 'write_file', 'read_file'];
    for (let i = 0; i < methods.length; i++) {
      const createdAtMs = BASE + i * 1_000;
      const op = makeOp({ agentId: 'agent-515', tool: 'fs', method: methods[i], sessionId: 'sess-515', timestamp: new Date(createdAtMs) });
      await saveLog(ctx.store, op, dec('allow', 0.2), createdAtMs);
    }

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);
    const b = body as { uniqueMethods: number };
    expect(b.uniqueMethods).toBe(2);
  });

  it('16. uniqueMethods field is present and numeric in the operations summary response', async () => {
    ctx = await setup();

    const BASE = 1_903_100_000_000;

    const op = makeOp({ agentId: 'agent-515-p', tool: 'fs', method: 'list', sessionId: 'sess-515p', timestamp: new Date(BASE) });
    await saveLog(ctx.store, op, dec('allow', 0.1), BASE);

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect('uniqueMethods' in b).toBe(true);
    expect(typeof b['uniqueMethods']).toBe('number');
  });

  it('17. uniqueMethods === 1 when all ops use the same method', async () => {
    ctx = await setup();

    const BASE = 1_903_200_000_000;

    for (let i = 0; i < 4; i++) {
      const createdAtMs = BASE + i * 1_000;
      const op = makeOp({ agentId: 'agent-515-s', tool: 'fs', method: 'write_file', sessionId: 'sess-515s', timestamp: new Date(createdAtMs) });
      await saveLog(ctx.store, op, dec('allow', 0.2), createdAtMs);
    }

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);
    const b = body as { uniqueMethods: number };
    expect(b.uniqueMethods).toBe(1);
  });

  it('18. uniqueMethods counts each method name once regardless of which tool or agent used it', async () => {
    ctx = await setup();

    const BASE = 1_903_300_000_000;

    // Different agents and tools all using the same 2 method names
    const ops = [
      makeOp({ agentId: 'agent-515-A', tool: 'fs', method: 'write_file', sessionId: 'sess-515m', timestamp: new Date(BASE) }),
      makeOp({ agentId: 'agent-515-B', tool: 'db', method: 'delete_record', sessionId: 'sess-515m', timestamp: new Date(BASE + 1_000) }),
      makeOp({ agentId: 'agent-515-A', tool: 'db', method: 'write_file', sessionId: 'sess-515m', timestamp: new Date(BASE + 2_000) }),
      makeOp({ agentId: 'agent-515-B', tool: 'fs', method: 'delete_record', sessionId: 'sess-515m', timestamp: new Date(BASE + 3_000) }),
    ];

    for (let i = 0; i < ops.length; i++) {
      await saveLog(ctx.store, ops[i]!, dec('allow', 0.2), BASE + i * 1_000);
    }

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);
    const b = body as { uniqueMethods: number };
    expect(b.uniqueMethods).toBe(2);
  });

  it('19. uniqueMethods is 0 when there are no operations', async () => {
    ctx = await setup();

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);
    const b = body as { uniqueMethods: number };
    expect(b.uniqueMethods).toBe(0);
  });
});
