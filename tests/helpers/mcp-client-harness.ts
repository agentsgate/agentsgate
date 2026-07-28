/**
 * McpClientHarness — full-transport MCP client for Vitest E2E tests.
 *
 * Implements the MCP stdio transport (JSON-RPC 2.0 over NDJSON) using
 * in-memory Node.js PassThrough streams for the client↔proxy link, so no
 * external process is needed on the client side.  The downstream MCP server
 * is a real spawned Node.js process (fake-mcp-server.mjs), exercising the
 * full process-spawn and pipe path inside MCPStdioProxy.
 *
 * Wire diagram
 * ────────────
 *   McpClientHarness (test code)
 *     │  clientToProxy  PassThrough   harness.write() → proxy reads as stdin
 *     │  proxyToClient  PassThrough   proxy writes as stdout → harness readline
 *     ▼
 *   MCPStdioProxy  (production code under test)
 *     │  spawns child process via Node.js child_process.spawn()
 *     ▼
 *   fake-mcp-server.mjs  (fake downstream MCP server, real process)
 *
 * Typical usage
 * ─────────────
 *   const h = new McpClientHarness();
 *   await h.start({ evaluateRisk: myEvaluator });
 *   const result = await h.callTool('echo', { message: 'hi' });
 *   expect(h.lastIntercept?.decision.action).toBe('allow');
 *   await h.stop();
 */
import { PassThrough, Writable } from 'node:stream';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MCPStdioProxy } from '../../src/modules/m1-proxy/stdio.js';
import type { StdioProxyOptions } from '../../src/modules/m1-proxy/stdio.js';
import type { MCPOperation, ProxyDecision } from '../../src/types/interfaces.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to the bundled fake MCP server script. */
export const FAKE_MCP_SERVER_PATH = path.join(__dirname, 'fake-mcp-server.mjs');

// ── Public types ──────────────────────────────────────────────────────────────

export interface McpResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** One intercepted operation + the proxy decision attached to it. */
export interface InterceptRecord {
  operation: MCPOperation;
  decision: ProxyDecision;
}

/** Thrown by callTool() when the JSON-RPC response contains an error object. */
export class McpToolError extends Error {
  constructor(
    message: string,
    public readonly code: number,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = 'McpToolError';
  }
}

export interface HarnessOptions {
  /**
   * Override the downstream server command.
   * Default: `['node', FAKE_MCP_SERVER_PATH]`
   */
  serverCommand?: string[];
  /**
   * Per-request timeout in milliseconds.
   * Default: 5000
   */
  requestTimeout?: number;
}

/** Options forwarded to MCPStdioProxy on start() (minus transport streams). */
export type ProxyStartOptions =
  Pick<StdioProxyOptions, 'evaluateRisk'> &
  Partial<Omit<StdioProxyOptions, 'command' | 'stdin' | 'stdout' | 'stderr'>>;

// ── Internal ──────────────────────────────────────────────────────────────────

interface Pending {
  resolve: (r: McpResponse) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** A Writable that silently discards all data — used to swallow child stderr. */
const DEV_NULL = new Writable({ write(_chunk, _enc, cb) { cb(); } });

// ── McpClientHarness ─────────────────────────────────────────────────────────

export class McpClientHarness {
  // Transport streams shared between the harness and MCPStdioProxy.
  private readonly clientToProxy = new PassThrough(); // harness writes → proxy stdin
  private readonly proxyToClient = new PassThrough(); // proxy stdout → harness reads

  private proxy: MCPStdioProxy | null = null;
  private proxyDone: Promise<void> | null = null;
  private rl: ReturnType<typeof createInterface> | null = null;

  // Pending request registry — keyed by JSON-RPC message id.
  private readonly pending = new Map<string | number, Pending>();

  // Ordered list of all intercepted (operation, decision) pairs.
  private readonly intercepted: InterceptRecord[] = [];

  // Auto-incrementing message id counter.
  private msgId = 1;

  private readonly requestTimeout: number;
  private readonly serverCommand: string[];

  constructor(opts: HarnessOptions = {}) {
    this.requestTimeout = opts.requestTimeout ?? 5000;
    this.serverCommand = opts.serverCommand ?? ['node', FAKE_MCP_SERVER_PATH];
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Start the MCPStdioProxy with the given risk evaluator and perform the MCP
   * `initialize` handshake before returning.  Must be called before any other
   * method.
   */
  async start(opts: ProxyStartOptions): Promise<void> {
    this.proxy = new MCPStdioProxy({
      // Proxy-level defaults for tests.
      agentId: 'test-agent',
      sessionId: `test-session-${this.msgId}`,
      // Collect every intercept so tests can assert on them.
      onIntercept: (op, decision) => { this.intercepted.push({ operation: op, decision }); },
      // Caller-supplied options (may override agentId / sessionId / onIntercept).
      ...opts,
      // Transport streams — always injected by the harness.
      command: this.serverCommand,
      stdin: this.clientToProxy,
      stdout: this.proxyToClient,
      stderr: DEV_NULL, // keep test output clean; flip to process.stderr to debug
    });

    // Attach our readline to proxyToClient BEFORE calling proxy.start() so we
    // don't miss any lines written during the initialize exchange.
    this.rl = createInterface({ input: this.proxyToClient, crlfDelay: Infinity });
    this.rl.on('line', line => { this.dispatchLine(line); });

    // Start proxy non-blocking — resolves when the child process exits.
    this.proxyDone = this.proxy.start();

    // Perform MCP initialize handshake (required before any tool calls).
    await this.doInitialize();
  }

  /**
   * Stop the proxy, clean up streams, and reject any outstanding requests.
   * Safe to call multiple times.
   */
  async stop(): Promise<void> {
    this.proxy?.stop();
    this.rl?.close();
    this.clientToProxy.destroy();

    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('McpClientHarness: stopped before response arrived'));
    }
    this.pending.clear();

    // Wait for the child process to exit so ports/handles are released.
    if (this.proxyDone) await this.proxyDone.catch(() => { /* killed — expected */ });
    this.proxyDone = null;
  }

  // ── Transport API ─────────────────────────────────────────────────────────

  /**
   * Send a JSON-RPC 2.0 request and wait for the response.
   * Uses an auto-incremented integer message id.
   */
  async request(method: string, params?: Record<string, unknown>): Promise<McpResponse> {
    const id = this.msgId++;
    const msg: Record<string, unknown> = { jsonrpc: '2.0', id, method };
    if (params !== undefined) msg['params'] = params;

    return new Promise<McpResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(
          `McpClientHarness: request timed out after ${this.requestTimeout}ms `
          + `— method="${method}" id=${id}`,
        ));
      }, this.requestTimeout);

      this.pending.set(id, { resolve, reject, timer });
      this.clientToProxy.write(JSON.stringify(msg) + '\n');
    });
  }

  /**
   * Send a JSON-RPC 2.0 notification (no response expected or awaited).
   */
  notify(method: string, params?: Record<string, unknown>): void {
    const msg: Record<string, unknown> = { jsonrpc: '2.0', method };
    if (params !== undefined) msg['params'] = params;
    this.clientToProxy.write(JSON.stringify(msg) + '\n');
  }

  // ── Convenience helpers ───────────────────────────────────────────────────

  /**
   * Send a `tools/call` request and return the unwrapped result.
   * Throws `McpToolError` if the response contains a JSON-RPC error object.
   */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const resp = await this.request('tools/call', { name, arguments: args });
    if (resp.error) throw new McpToolError(resp.error.message, resp.error.code, resp.error.data);
    return resp.result;
  }

  /**
   * Send a `tools/list` request and return the tools array.
   * Throws `McpToolError` if the response contains a JSON-RPC error object.
   */
  async listTools(): Promise<unknown[]> {
    const resp = await this.request('tools/list');
    if (resp.error) throw new McpToolError(resp.error.message, resp.error.code);
    return (resp.result as { tools: unknown[] }).tools;
  }

  // ── Introspection ─────────────────────────────────────────────────────────

  /** All intercepted (operation, decision) pairs in call order. */
  get intercepts(): ReadonlyArray<InterceptRecord> {
    return this.intercepted;
  }

  /** The most recently intercepted record, or `undefined` if none. */
  get lastIntercept(): InterceptRecord | undefined {
    return this.intercepted.at(-1);
  }

  /**
   * Number of tool calls the underlying proxy is currently tracking as
   * in-flight (i.e. forwarded to the child but not yet responded to).
   * Useful for asserting cancel behaviour.
   */
  pendingProxyCallCount(): number {
    return this.proxy?.getPendingCallCount() ?? 0;
  }

  // ── Private ───────────────────────────────────────────────────────────────

  /** Dispatch one NDJSON line received from the proxy stdout. */
  private dispatchLine(line: string): void {
    if (!line.trim()) return;
    let msg: McpResponse;
    try {
      msg = JSON.parse(line) as McpResponse;
    } catch {
      return; // Non-JSON line — ignore.
    }

    // Notifications (no id, or null id) are not tracked in `pending`.
    if (msg.id === null || msg.id === undefined) return;

    const p = this.pending.get(msg.id);
    if (!p) return; // Unsolicited or already-timed-out response — ignore.

    clearTimeout(p.timer);
    this.pending.delete(msg.id);
    p.resolve(msg);
  }

  /** Perform the MCP initialize handshake. */
  private async doInitialize(): Promise<void> {
    const resp = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'mcp-test-harness', version: '1.0.0' },
    });
    if (resp.error) {
      throw new Error(`MCP initialize failed (code ${resp.error.code}): ${resp.error.message}`);
    }
    // Notify the server that initialization is complete (required by the MCP spec).
    this.notify('notifications/initialized');
  }
}
