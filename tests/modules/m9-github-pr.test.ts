/**
 * T115 — Plugin adapter: GitHub PR rollback.
 *
 * Uses a lightweight in-process HTTP stub server so no real GitHub calls
 * are made. The stub is configurable per-test.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { GitHubPRRollbackAdapter } from '../../src/modules/m9-plugin-sdk/index.js';
import type { MCPOperation, StateSnapshot } from '../../src/types/interfaces.js';

// ── Tiny HTTP stub for GitHub API ────────────────────────────────────────────

type StubConfig = {
  getStatus: number;
  patchStatus: number;
  patchBody: string;
};

let stubServer: http.Server;
let stubPort: number;
let stubCfg: StubConfig;

async function startStub(): Promise<number> {
  return new Promise((resolve) => {
    stubServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => { body += c.toString(); });
      req.on('end', () => {
        if (req.method === 'GET') {
          res.writeHead(stubCfg.getStatus, { 'Content-Type': 'application/json' });
          res.end(stubCfg.getStatus === 200 ? '{"number":42,"state":"open"}' : '{"message":"Not Found"}');
        } else if (req.method === 'PATCH') {
          void body; // consume
          res.writeHead(stubCfg.patchStatus, { 'Content-Type': 'application/json' });
          res.end(stubCfg.patchBody);
        } else {
          res.writeHead(405).end();
        }
      });
    });
    stubServer.listen(0, '127.0.0.1', () => {
      const addr = stubServer.address() as { port: number };
      resolve(addr.port);
    });
  });
}

function makeOp(pullNumber?: number): MCPOperation {
  return {
    id: 'op-123',
    agentId: 'agent-1',
    tool: 'github',
    method: 'create_pull_request',
    params: { owner: 'acme', repo: 'widget', pullNumber },
    timestamp: new Date(),
    sessionId: 'sess-1',
  };
}

function makeAdapter() {
  return new GitHubPRRollbackAdapter({
    token: 'test-token',
    baseUrl: `http://127.0.0.1:${stubPort}`,
  });
}

beforeEach(async () => {
  stubCfg  = { getStatus: 404, patchStatus: 200, patchBody: '{"state":"closed"}' };
  stubPort = await startStub();
});

afterEach(() => { stubServer.close(); });

// ── canRollback ───────────────────────────────────────────────────────────────

describe('GitHubPRRollbackAdapter.canRollback', () => {
  it('returns true when owner, repo, and pullNumber are all present', async () => {
    const adapter = makeAdapter();
    const cap = await adapter.canRollback(makeOp(42));
    expect(cap.canRollback).toBe(true);
    expect(cap.confidence).toBeGreaterThan(0);
  });

  it('returns false when pullNumber is missing', async () => {
    const adapter = makeAdapter();
    const cap = await adapter.canRollback(makeOp(undefined));
    expect(cap.canRollback).toBe(false);
    expect(cap.limitations![0]).toMatch(/pullNumber/i);
  });

  it('returns false when owner is missing', async () => {
    const adapter = makeAdapter();
    const op: MCPOperation = {
      id: 'x', agentId: 'a', tool: 'github', method: 'create_pull_request',
      params: { repo: 'widget', pullNumber: 1 }, timestamp: new Date(), sessionId: 's',
    };
    const cap = await adapter.canRollback(op);
    expect(cap.canRollback).toBe(false);
  });
});

// ── captureState ─────────────────────────────────────────────────────────────

describe('GitHubPRRollbackAdapter.captureState', () => {
  it('records prExistedBefore=false when GET returns 404', async () => {
    stubCfg.getStatus = 404;
    const adapter = makeAdapter();
    const snap = await adapter.captureState(makeOp(42));
    expect(snap.data['owner']).toBe('acme');
    expect(snap.data['repo']).toBe('widget');
    expect(snap.data['pullNumber']).toBe(42);
    expect(snap.data['prExistedBefore']).toBe(false);
  });

  it('records prExistedBefore=true when GET returns 200', async () => {
    stubCfg.getStatus = 200;
    const adapter = makeAdapter();
    const snap = await adapter.captureState(makeOp(42));
    expect(snap.data['prExistedBefore']).toBe(true);
  });

  it('records null pullNumber when param is absent', async () => {
    const adapter = makeAdapter();
    const snap = await adapter.captureState(makeOp(undefined));
    expect(snap.data['pullNumber']).toBeNull();
  });
});

// ── rollback ─────────────────────────────────────────────────────────────────

describe('GitHubPRRollbackAdapter.rollback', () => {
  function makeSnap(pullNumber: number | null, prExistedBefore: boolean): StateSnapshot {
    return {
      adapterId: 'github-pr',
      operationId: 'op-123',
      data: { owner: 'acme', repo: 'widget', pullNumber, prExistedBefore },
      capturedAt: new Date(),
    };
  }

  it('closes the PR when it was NOT present before (success path)', async () => {
    stubCfg.patchStatus = 200;
    const adapter = makeAdapter();
    const result = await adapter.rollback(makeSnap(42, false));
    expect(result.success).toBe(true);
    expect(result.restoredFiles).toContain('acme/widget#42');
  });

  it('fails when PR existed before the operation (safety guard)', async () => {
    const adapter = makeAdapter();
    const result = await adapter.rollback(makeSnap(42, true));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/existed before/i);
  });

  it('fails when PATCH returns non-2xx', async () => {
    stubCfg.patchStatus = 422;
    stubCfg.patchBody   = '{"message":"PR is already closed"}';
    const adapter = makeAdapter();
    const result = await adapter.rollback(makeSnap(42, false));
    expect(result.success).toBe(false);
    expect(result.failedFiles).toContain('acme/widget#42');
  });

  it('fails gracefully when pullNumber is null', async () => {
    const adapter = makeAdapter();
    const result = await adapter.rollback(makeSnap(null, false));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/pullNumber/i);
  });
});

// ── previewRollback ───────────────────────────────────────────────────────────

describe('GitHubPRRollbackAdapter.previewRollback', () => {
  function makeSnap(pullNumber: number | null, prExistedBefore: boolean): StateSnapshot {
    return {
      adapterId: 'github-pr', operationId: 'op-1',
      data: { owner: 'acme', repo: 'widget', pullNumber, prExistedBefore },
      capturedAt: new Date(),
    };
  }

  it('shows close action for a PR we created', async () => {
    const adapter = makeAdapter();
    const preview = await adapter.previewRollback(makeSnap(7, false));
    expect(preview.willRestore).toContain('close PR acme/widget#7');
    expect(preview.cannotRestore).toHaveLength(0);
  });

  it('shows cannotRestore for a pre-existing PR', async () => {
    const adapter = makeAdapter();
    const preview = await adapter.previewRollback(makeSnap(7, true));
    expect(preview.willRestore).toHaveLength(0);
    expect(preview.cannotRestore).toContain('acme/widget#7');
  });
});

// ── adapter metadata ──────────────────────────────────────────────────────────

describe('GitHubPRRollbackAdapter metadata', () => {
  it('has correct adapterId, version, and supportedTools', () => {
    const adapter = makeAdapter();
    expect(adapter.adapterId).toBe('github-pr');
    expect(adapter.version).toBe('1.0.0');
    expect(adapter.supportedTools).toContain('github');
  });
});
