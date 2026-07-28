import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { RiskIntelligenceEngine } from '../../src/modules/m11-intelligence/index.js';
import { StateStore } from '../../src/modules/m2-store/index.js';
import type { MCPOperation } from '../../src/types/interfaces.js';

const AGENT = 'agent-test';
const TOOL = 'filesystem';

function makeOp(): MCPOperation {
  return {
    id: 'op-1', agentId: AGENT, tool: TOOL, method: 'write_file',
    params: {}, timestamp: new Date(), sessionId: 's',
  };
}

describe('RiskIntelligenceEngine', () => {
  it('should return -1 for agents with fewer than 10 historical operations', async () => {
    const engine = new RiskIntelligenceEngine();
    // Record 9 outcomes — one short of threshold
    for (let i = 0; i < 9; i++) {
      await engine.recordOutcome(`op-${i}`, true, AGENT, TOOL);
    }
    const score = await engine.getUserHistoryScore(AGENT, TOOL);
    expect(score).toBe(-1);
  });

  it('should return a score between 0 and 1 for agents with sufficient history', async () => {
    const engine = new RiskIntelligenceEngine();
    // Record 10 mixed outcomes
    for (let i = 0; i < 10; i++) {
      await engine.recordOutcome(`op-${i}`, i % 2 === 0, AGENT, TOOL);
    }
    const score = await engine.getUserHistoryScore(AGENT, TOOL);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('should return higher score for agents with many blocked operations', async () => {
    const engine = new RiskIntelligenceEngine();
    const agentRisky = 'agent-risky';
    const agentSafe = 'agent-safe';

    // agentRisky: all 10 operations were NOT approved (blocked/rejected)
    for (let i = 0; i < 10; i++) {
      await engine.recordOutcome(`op-r${i}`, false, agentRisky, TOOL);
    }
    // agentSafe: all 10 operations were approved
    for (let i = 0; i < 10; i++) {
      await engine.recordOutcome(`op-s${i}`, true, agentSafe, TOOL);
    }

    const riskyScore = await engine.getUserHistoryScore(agentRisky, TOOL);
    const safeScore = await engine.getUserHistoryScore(agentSafe, TOOL);

    expect(riskyScore).toBeGreaterThan(safeScore);
    expect(riskyScore).toBe(1.0);  // 0% approved → max risk
    expect(safeScore).toBe(0.0);   // 100% approved → min risk
  });

  it('should return -1 for community score when opt-in is disabled', async () => {
    const engine = new RiskIntelligenceEngine();
    const score = await engine.getCommunityScore(makeOp());
    expect(score).toBe(-1);
  });

  it('should update user history after recording an outcome', async () => {
    const engine = new RiskIntelligenceEngine();
    expect(engine.getOutcomeCount(AGENT, TOOL)).toBe(0);

    await engine.recordOutcome('op-x', true, AGENT, TOOL);
    expect(engine.getOutcomeCount(AGENT, TOOL)).toBe(1);

    // Score should still be -1 (only 1 outcome, need 10)
    expect(await engine.getUserHistoryScore(AGENT, TOOL)).toBe(-1);
  });
});

describe('RiskIntelligenceEngine — SQLite persistence', () => {
  let store: StateStore;

  beforeEach(async () => {
    store = new StateStore(':memory:');
    await store.initialize();
  });

  afterEach(async () => {
    await store.close();
  });

  it('persists outcomes to SQLite and reads them back on a new engine instance', async () => {
    const engine1 = new RiskIntelligenceEngine({ store });
    // Record 10 outcomes — all approved
    for (let i = 0; i < 10; i++) {
      await engine1.recordOutcome(`op-${i}`, true, AGENT, TOOL);
    }
    expect(await engine1.getUserHistoryScore(AGENT, TOOL)).toBe(0.0);

    // New engine instance with same store — should load history from DB
    const engine2 = new RiskIntelligenceEngine({ store });
    const score = await engine2.getUserHistoryScore(AGENT, TOOL);
    expect(score).toBe(0.0); // history preserved
  });

  it('in-memory count tracks session outcomes independently of DB', async () => {
    const engine = new RiskIntelligenceEngine({ store });
    await engine.recordOutcome('op-a', false, AGENT, TOOL);
    expect(engine.getOutcomeCount(AGENT, TOOL)).toBe(1); // in-memory
  });
});

describe('RiskIntelligenceEngine — L3 community score', () => {
  let server: http.Server;
  let serverPort: number;
  let lastBody: unknown;

  afterEach(() => { server?.close(); });

  async function startCommunityServer(score: number): Promise<void> {
    return new Promise(resolve => {
      server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          lastBody = JSON.parse(Buffer.concat(chunks).toString()) as unknown;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ score }));
        });
      });
      server.listen(0, () => {
        serverPort = (server.address() as { port: number }).port;
        resolve();
      });
    });
  }

  it('returns -1 when communityEndpoint is not set', async () => {
    const engine = new RiskIntelligenceEngine();
    expect(await engine.getCommunityScore(makeOp())).toBe(-1);
  });

  it('fetches community score from the configured endpoint', async () => {
    await startCommunityServer(0.42);
    const engine = new RiskIntelligenceEngine({
      communityEndpoint: `http://127.0.0.1:${serverPort}/score`,
      allowPrivateCommunityUrl: true,
    });
    const score = await engine.getCommunityScore(makeOp());
    expect(score).toBeCloseTo(0.42, 2);
    expect((lastBody as { tool: string }).tool).toBe(TOOL);
  });

  it('returns -1 when the endpoint is unreachable', async () => {
    const engine = new RiskIntelligenceEngine({ communityEndpoint: 'http://127.0.0.1:19997/score',
      allowPrivateCommunityUrl: true });
    expect(await engine.getCommunityScore(makeOp())).toBe(-1);
  });

  it('returns -1 when the endpoint returns an invalid score', async () => {
    await startCommunityServer(-5); // out of range
    const engine = new RiskIntelligenceEngine({
      communityEndpoint: `http://127.0.0.1:${serverPort}/score`,
      allowPrivateCommunityUrl: true,
    });
    expect(await engine.getCommunityScore(makeOp())).toBe(-1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// L3 lives on the per-operation path: the proxy awaits it before deciding every
// tool call. These cover the properties that keep it off the network.
// ─────────────────────────────────────────────────────────────────────────────

describe('RiskIntelligenceEngine — L3 community score, per-operation cost', () => {
  let server: http.Server;
  let serverPort: number;
  let requestCount: number;

  afterEach(() => { server?.close(); });

  /** Community server that counts requests and can stall before responding. */
  async function startCountingServer(score: number, delayMs = 0): Promise<void> {
    requestCount = 0;
    return new Promise(resolve => {
      server = http.createServer((req, res) => {
        requestCount += 1;
        req.resume();
        req.on('end', () => {
          const reply = (): void => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ score }));
          };
          if (delayMs > 0) setTimeout(reply, delayMs); else reply();
        });
      });
      server.listen(0, '127.0.0.1', () => {
        serverPort = (server.address() as { port: number }).port;
        resolve();
      });
    });
  }

  function engineFor(extra: Record<string, unknown> = {}): RiskIntelligenceEngine {
    return new RiskIntelligenceEngine({
      communityEndpoint: `http://127.0.0.1:${serverPort}/score`,
      allowPrivateCommunityUrl: true,
      ...extra,
    });
  }

  function opFor(tool: string, method: string): MCPOperation {
    return { id: 'op', agentId: AGENT, tool, method, params: {}, timestamp: new Date(), sessionId: 's' };
  }

  it('repeated operations on the same tool+method hit the endpoint once', async () => {
    await startCountingServer(0.42);
    const engine = engineFor();

    for (let i = 0; i < 25; i++) {
      expect(await engine.getCommunityScore(makeOp())).toBeCloseTo(0.42, 5);
    }
    expect(requestCount).toBe(1);
  });

  it('caches per tool+method rather than globally', async () => {
    await startCountingServer(0.42);
    const engine = engineFor();

    await engine.getCommunityScore(opFor('fs', 'read'));
    await engine.getCommunityScore(opFor('fs', 'write'));   // same tool, other method
    await engine.getCommunityScore(opFor('db', 'read'));    // other tool, same method
    await engine.getCommunityScore(opFor('fs', 'read'));    // repeat → cached

    expect(requestCount).toBe(3);
    expect(engine.getCommunityCacheSize()).toBe(3);
  });

  it('collapses concurrent lookups for the same key into one request', async () => {
    await startCountingServer(0.7, 50);
    const engine = engineFor();

    const scores = await Promise.all(
      Array.from({ length: 20 }, () => engine.getCommunityScore(makeOp())),
    );

    expect(scores.every(s => Math.abs(s - 0.7) < 1e-9)).toBe(true);
    expect(requestCount).toBe(1);
  });

  it('a stalled endpoint degrades to -1 within the timeout instead of hanging', async () => {
    await startCountingServer(0.5, 10_000);   // far longer than the timeout below
    const engine = engineFor({ communityTimeoutMs: 150 });

    const started = Date.now();
    const score = await engine.getCommunityScore(makeOp());
    const elapsed = Date.now() - started;

    expect(score).toBe(-1);
    expect(elapsed).toBeLessThan(3_000);
  });

  it('a failure is cached too, so a dead endpoint is not dialled per operation', async () => {
    const engine = new RiskIntelligenceEngine({
      communityEndpoint: 'http://127.0.0.1:19997/score',   // nothing listening
      allowPrivateCommunityUrl: true,
    });

    for (let i = 0; i < 5; i++) {
      expect(await engine.getCommunityScore(makeOp())).toBe(-1);
    }
    expect(engine.getCommunityCacheSize()).toBe(1);
  });

  it('expired entries are refetched', async () => {
    await startCountingServer(0.42);
    const engine = engineFor({ communityCacheTtlMs: 1 });   // effectively immediate

    await engine.getCommunityScore(makeOp());
    await new Promise(r => setTimeout(r, 20));
    await engine.getCommunityScore(makeOp());

    expect(requestCount).toBe(2);
  });

  it('rejects a loopback endpoint unless private URLs are explicitly allowed', async () => {
    await startCountingServer(0.42);
    const engine = new RiskIntelligenceEngine({
      communityEndpoint: `http://127.0.0.1:${serverPort}/score`,
      // allowPrivateCommunityUrl intentionally omitted — production default
    });

    expect(await engine.getCommunityScore(makeOp())).toBe(-1);
    expect(requestCount).toBe(0);
  });
});
