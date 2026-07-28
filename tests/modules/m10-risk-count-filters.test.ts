/**
 * Sprint v0.38 — T306, T308, T300 tests
 *
 * T306: GET /risk?agentId=<id> — filters risk list by agentId.
 *       GET /risk?tool=<tool>  — filters risk list by tool.
 *       Returns empty data array (not 404) when no matching ops exist.
 *
 * T308: GET /operations/count?tags=tag1,tag2 — count ops that have ALL specified tags.
 *       GET /operations/count?parentId=<id>   — count ops with that parentId.
 *
 * T300: GET /operations/count still accepts agentId, tool, action filters.
 *       GET /operations/count?action=block returns count of blocked ops.
 *       GET /operations/count?agentId=X  returns count for that agent.
 */
import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { StateStore } from '../../src/modules/m2-store/index.js';
import { DashboardAPI } from '../../src/modules/m10-dashboard/index.js';
import type { OperationLog } from '../../src/types/interfaces.js';

// Ports come from start(0). A hand-picked base sits inside the OS ephemeral
// range (49152-65535), so a concurrent listen(0) can be handed the same number
// and this suite loses the race with EADDRINUSE.

// ── helpers ───────────────────────────────────────────────────────────────────

interface SetupResult {
  dash: DashboardAPI;
  port: number;
  store: StateStore;
  tmpDir: string;
}

async function setup(options: Record<string, unknown> = {}): Promise<SetupResult> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'as-rcf-'));
  const store = new StateStore(':memory:');
  await store.initialize();
  const dash = new DashboardAPI(store, options);
  await dash.start(0);
  const port = dash.getPort();
  return { dash, port, store, tmpDir };
}

async function teardown(ctx: SetupResult): Promise<void> {
  await ctx.dash.stop();
  await ctx.store.close();
  await fs.rm(ctx.tmpDir, { recursive: true, force: true });
}

async function getJSON(
  port: number,
  p: string
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${p}`);
  return { status: res.status, body: await res.json() };
}

/** Build a minimal valid OperationLog for testing. */
function makeLog(
  id: string,
  overrides: Partial<OperationLog> = {},
  agentId = 'agent-default'
): OperationLog {
  return {
    operationId: id,
    operation: {
      id,
      agentId,
      tool: 'filesystem',
      method: 'read_file',
      params: { path: '/tmp/test.txt' },
      timestamp: new Date('2026-01-01T00:00:00Z'),
      sessionId: 'session-1',
    },
    decision: {
      action: 'allow',
      riskScore: 0.2,
      reasons: ['low risk'],
    },
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

// ── T306: GET /risk?agentId=<id> ─────────────────────────────────────────────

describe('DashboardAPI — T306: GET /risk?agentId=<id>', () => {
  let ctx: SetupResult;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('1. returns only risk entries for the specified agentId', async () => {
    ctx = await setup();

    // Save ops for two different agents
    await ctx.store.saveOperationLog(makeLog('op-a1', {}, 'agent-alpha'));
    await ctx.store.saveOperationLog(makeLog('op-a2', {}, 'agent-alpha'));
    await ctx.store.saveOperationLog(makeLog('op-b1', {}, 'agent-beta'));

    const { status, body } = await getJSON(ctx.port, '/risk?agentId=agent-alpha');
    expect(status).toBe(200);

    const b = body as { data: Array<{ operationId: string; agentId: string }>; count: number };
    expect(b).toHaveProperty('data');
    expect(b).toHaveProperty('count');
    expect(b.count).toBe(2);
    expect(b.data.every(e => e.agentId === 'agent-alpha')).toBe(true);
    const ids = b.data.map(e => e.operationId);
    expect(ids).toContain('op-a1');
    expect(ids).toContain('op-a2');
    expect(ids).not.toContain('op-b1');
  });

  it('2. returns empty data array (not 404) when the specified agentId has no ops', async () => {
    ctx = await setup();

    // Populate with a different agent's ops so the DB is not entirely empty
    await ctx.store.saveOperationLog(makeLog('op-x1', {}, 'agent-existing'));

    const { status, body } = await getJSON(ctx.port, '/risk?agentId=agent-ghost');
    expect(status).toBe(200);

    const b = body as { data: unknown[]; count: number };
    expect(b.data).toEqual([]);
    expect(b.count).toBe(0);
  });
});

// ── T306: GET /risk?tool=<tool> ───────────────────────────────────────────────

describe('DashboardAPI — T306: GET /risk?tool=<tool>', () => {
  let ctx: SetupResult;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('3. returns only risk entries for the specified tool', async () => {
    ctx = await setup();

    const fsLog = makeLog('op-fs1', {
      operation: {
        id: 'op-fs1',
        agentId: 'agent-default',
        tool: 'filesystem',
        method: 'write_file',
        params: {},
        timestamp: new Date('2026-01-01T00:00:00Z'),
        sessionId: 'session-1',
      },
    });
    const ghLog = makeLog('op-gh1', {
      operation: {
        id: 'op-gh1',
        agentId: 'agent-default',
        tool: 'github',
        method: 'create_issue',
        params: {},
        timestamp: new Date('2026-01-01T00:00:00Z'),
        sessionId: 'session-1',
      },
    });
    await ctx.store.saveOperationLog(fsLog);
    await ctx.store.saveOperationLog(ghLog);

    const { status, body } = await getJSON(ctx.port, '/risk?tool=github');
    expect(status).toBe(200);

    const b = body as { data: Array<{ operationId: string; tool: string }>; count: number };
    expect(b.count).toBe(1);
    expect(b.data[0].operationId).toBe('op-gh1');
    expect(b.data[0].tool).toBe('github');
  });

  it('4. returns empty data array (not 404) when the specified tool has no ops', async () => {
    ctx = await setup();

    await ctx.store.saveOperationLog(makeLog('op-fs2', {
      operation: {
        id: 'op-fs2',
        agentId: 'agent-default',
        tool: 'filesystem',
        method: 'read_file',
        params: {},
        timestamp: new Date('2026-01-01T00:00:00Z'),
        sessionId: 'session-1',
      },
    }));

    const { status, body } = await getJSON(ctx.port, '/risk?tool=nonexistent-tool');
    expect(status).toBe(200);

    const b = body as { data: unknown[]; count: number };
    expect(b.data).toEqual([]);
    expect(b.count).toBe(0);
  });
});

// ── T308: GET /operations/count?tags=tag1,tag2 ────────────────────────────────

describe('DashboardAPI — T308: GET /operations/count?tags=...', () => {
  let ctx: SetupResult;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('5. returns count of ops that have ALL specified tags (AND semantics)', async () => {
    ctx = await setup();

    // op with both tags
    await ctx.store.saveOperationLog(makeLog('op-tags-both', {
      operation: {
        id: 'op-tags-both',
        agentId: 'agent-default',
        tool: 'filesystem',
        method: 'write_file',
        params: {},
        timestamp: new Date('2026-01-01T00:00:00Z'),
        sessionId: 'session-1',
        tags: ['pci-scope', 'high-value'],
      },
    }));

    // op with only one tag
    await ctx.store.saveOperationLog(makeLog('op-tags-one', {
      operation: {
        id: 'op-tags-one',
        agentId: 'agent-default',
        tool: 'filesystem',
        method: 'read_file',
        params: {},
        timestamp: new Date('2026-01-01T00:00:00Z'),
        sessionId: 'session-1',
        tags: ['pci-scope'],
      },
    }));

    // op with no tags
    await ctx.store.saveOperationLog(makeLog('op-tags-none', {
      operation: {
        id: 'op-tags-none',
        agentId: 'agent-default',
        tool: 'filesystem',
        method: 'read_file',
        params: {},
        timestamp: new Date('2026-01-01T00:00:00Z'),
        sessionId: 'session-1',
      },
    }));

    // Filter by both tags — should only return the op that has both
    const { status, body } = await getJSON(ctx.port, '/operations/count?tags=pci-scope,high-value');
    expect(status).toBe(200);
    const b = body as { count: number };
    expect(b.count).toBe(1);
  });

  it('6. returns count of ops matching a single tag', async () => {
    ctx = await setup();

    await ctx.store.saveOperationLog(makeLog('op-t-1', {
      operation: {
        id: 'op-t-1',
        agentId: 'agent-default',
        tool: 'filesystem',
        method: 'read_file',
        params: {},
        timestamp: new Date('2026-01-01T00:00:00Z'),
        sessionId: 'session-1',
        tags: ['compliance'],
      },
    }));
    await ctx.store.saveOperationLog(makeLog('op-t-2', {
      operation: {
        id: 'op-t-2',
        agentId: 'agent-default',
        tool: 'filesystem',
        method: 'write_file',
        params: {},
        timestamp: new Date('2026-01-01T00:00:00Z'),
        sessionId: 'session-1',
        tags: ['compliance', 'audit'],
      },
    }));
    await ctx.store.saveOperationLog(makeLog('op-t-3', {
      operation: {
        id: 'op-t-3',
        agentId: 'agent-default',
        tool: 'filesystem',
        method: 'delete_file',
        params: {},
        timestamp: new Date('2026-01-01T00:00:00Z'),
        sessionId: 'session-1',
        tags: ['other'],
      },
    }));

    const { status, body } = await getJSON(ctx.port, '/operations/count?tags=compliance');
    expect(status).toBe(200);
    const b = body as { count: number };
    expect(b.count).toBe(2);
  });

  it('7. returns 0 when no ops match the specified tags', async () => {
    ctx = await setup();

    await ctx.store.saveOperationLog(makeLog('op-notag-1', {
      operation: {
        id: 'op-notag-1',
        agentId: 'agent-default',
        tool: 'filesystem',
        method: 'read_file',
        params: {},
        timestamp: new Date('2026-01-01T00:00:00Z'),
        sessionId: 'session-1',
        tags: ['unrelated'],
      },
    }));

    const { status, body } = await getJSON(ctx.port, '/operations/count?tags=nonexistent-tag');
    expect(status).toBe(200);
    const b = body as { count: number };
    expect(b.count).toBe(0);
  });
});

// ── T308: GET /operations/count?parentId=<id> ────────────────────────────────

describe('DashboardAPI — T308: GET /operations/count?parentId=<id>', () => {
  let ctx: SetupResult;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('8. returns count of ops with the specified parentId', async () => {
    ctx = await setup();

    // Two child ops with parentId
    await ctx.store.saveOperationLog(makeLog('op-child-1', {
      operation: {
        id: 'op-child-1',
        agentId: 'agent-default',
        tool: 'filesystem',
        method: 'read_file',
        params: {},
        timestamp: new Date('2026-01-01T00:00:00Z'),
        sessionId: 'session-1',
        parentId: 'op-parent-root',
      },
    }));
    await ctx.store.saveOperationLog(makeLog('op-child-2', {
      operation: {
        id: 'op-child-2',
        agentId: 'agent-default',
        tool: 'filesystem',
        method: 'write_file',
        params: {},
        timestamp: new Date('2026-01-01T00:00:00Z'),
        sessionId: 'session-1',
        parentId: 'op-parent-root',
      },
    }));
    // One op with a different parentId
    await ctx.store.saveOperationLog(makeLog('op-child-other', {
      operation: {
        id: 'op-child-other',
        agentId: 'agent-default',
        tool: 'filesystem',
        method: 'read_file',
        params: {},
        timestamp: new Date('2026-01-01T00:00:00Z'),
        sessionId: 'session-1',
        parentId: 'op-other-parent',
      },
    }));
    // One op with no parentId
    await ctx.store.saveOperationLog(makeLog('op-root', {}));

    const { status, body } = await getJSON(ctx.port, '/operations/count?parentId=op-parent-root');
    expect(status).toBe(200);
    const b = body as { count: number };
    expect(b.count).toBe(2);
  });

  it('9. returns 0 when no ops match the specified parentId', async () => {
    ctx = await setup();

    await ctx.store.saveOperationLog(makeLog('op-solo', {}));

    const { status, body } = await getJSON(ctx.port, '/operations/count?parentId=nonexistent-parent');
    expect(status).toBe(200);
    const b = body as { count: number };
    expect(b.count).toBe(0);
  });
});

// ── T300: GET /operations/count still accepts agentId, tool, action filters ──

describe('DashboardAPI — T300: GET /operations/count filter parity', () => {
  let ctx: SetupResult;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('10. ?action=block returns count of only blocked ops', async () => {
    ctx = await setup();

    await ctx.store.saveOperationLog(makeLog('op-parity-allow-1', { decision: { action: 'allow', riskScore: 0.1, reasons: [] } }));
    await ctx.store.saveOperationLog(makeLog('op-parity-allow-2', { decision: { action: 'allow', riskScore: 0.2, reasons: [] } }));
    await ctx.store.saveOperationLog(makeLog('op-parity-block-1', { decision: { action: 'block', riskScore: 0.9, reasons: ['high risk'] } }));
    await ctx.store.saveOperationLog(makeLog('op-parity-block-2', { decision: { action: 'block', riskScore: 0.8, reasons: ['high risk'] } }));

    const { status, body } = await getJSON(ctx.port, '/operations/count?action=block');
    expect(status).toBe(200);
    const b = body as { count: number };
    expect(b.count).toBe(2);
  });

  it('11. ?agentId=X returns count only for that agent', async () => {
    ctx = await setup();

    await ctx.store.saveOperationLog(makeLog('op-pa1', {}, 'agent-one'));
    await ctx.store.saveOperationLog(makeLog('op-pa2', {}, 'agent-one'));
    await ctx.store.saveOperationLog(makeLog('op-pa3', {}, 'agent-one'));
    await ctx.store.saveOperationLog(makeLog('op-pb1', {}, 'agent-two'));

    const { status, body } = await getJSON(ctx.port, '/operations/count?agentId=agent-one');
    expect(status).toBe(200);
    const b = body as { count: number };
    expect(b.count).toBe(3);
  });

  it('12. ?tool=X returns count only for that tool', async () => {
    ctx = await setup();

    await ctx.store.saveOperationLog(makeLog('op-pt-fs1', {
      operation: {
        id: 'op-pt-fs1',
        agentId: 'agent-default',
        tool: 'filesystem',
        method: 'read_file',
        params: {},
        timestamp: new Date('2026-01-01T00:00:00Z'),
        sessionId: 'session-1',
      },
    }));
    await ctx.store.saveOperationLog(makeLog('op-pt-db1', {
      operation: {
        id: 'op-pt-db1',
        agentId: 'agent-default',
        tool: 'database',
        method: 'query',
        params: {},
        timestamp: new Date('2026-01-01T00:00:00Z'),
        sessionId: 'session-1',
      },
    }));
    await ctx.store.saveOperationLog(makeLog('op-pt-db2', {
      operation: {
        id: 'op-pt-db2',
        agentId: 'agent-default',
        tool: 'database',
        method: 'insert',
        params: {},
        timestamp: new Date('2026-01-01T00:00:00Z'),
        sessionId: 'session-1',
      },
    }));

    const { status, body } = await getJSON(ctx.port, '/operations/count?tool=database');
    expect(status).toBe(200);
    const b = body as { count: number };
    expect(b.count).toBe(2);
  });

  it('13. no filter returns total count of all ops', async () => {
    ctx = await setup();

    await ctx.store.saveOperationLog(makeLog('op-total-1', {}, 'agent-a'));
    await ctx.store.saveOperationLog(makeLog('op-total-2', {}, 'agent-b'));
    await ctx.store.saveOperationLog(makeLog('op-total-3', {}, 'agent-c'));

    const { status, body } = await getJSON(ctx.port, '/operations/count');
    expect(status).toBe(200);
    const b = body as { count: number };
    expect(b.count).toBe(3);
  });
});
