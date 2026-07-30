/**
 * M1 extension: MCP JSON-RPC stdio proxy mode.
 *
 * Sits between an MCP client (e.g. Claude Desktop) and a real MCP server
 * by acting as a transparent pass-through that intercepts tool calls.
 *
 * Wire diagram:
 *   MCP client (Claude Desktop)
 *     │ stdin/stdout JSON-RPC 2.0 (newline-delimited)
 *     ▼
 *   MCPStdioProxy          ← AgentsGate intercept point
 *     │ stdin/stdout JSON-RPC 2.0
 *     ▼
 *   Real MCP server (child process)
 *
 * Only `tools/call` requests are risk-assessed.
 * All other request types (initialize, tools/list, resources/*, etc.)
 * are forwarded transparently with zero latency penalty.
 *
 * Blocking behaviour:
 *   allow            → forwarded, response relayed as-is
 *   require_approval → held. `awaitApproval` decides; approved forwards, denied
 *                      returns an error, and with no resolver configured the
 *                      request is refused. The child is not called until then.
 *   block            → error response returned immediately, child NOT called
 *
 * `require_approval` used to be forwarded like `allow`, on the reasoning that
 * approval could be handled asynchronously. An approval that arrives after the
 * tool has run is a notification, not a gate — and this is the path
 * `agentsgate inject` configures, so with the default thresholds every
 * operation scoring 0.3–0.7 executed unchecked.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import type { MCPOperation, ProxyDecision } from '../../types/interfaces.js';

/** JSON-RPC 2.0 message shapes (minimal, only what we need). */
interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface StdioProxyOptions {
  /** The MCP server command to spawn (e.g. ["npx", "@mcp/server-filesystem", "/path"]) */
  command: string[];
  /** Risk evaluation function — same as MCPProxy.evaluateRisk */
  evaluateRisk: (op: MCPOperation) => Promise<ProxyDecision>;
  /**
   * Tool/server name used as op.tool in intercepted operations.
   * If omitted, inferred from the command (e.g. "server-filesystem" → "filesystem").
   * Falls back to "mcp" when inference fails.
   */
  toolName?: string;
  /** Agent identifier attached to intercepted operations (default: "stdio-client") */
  agentId?: string;
  /** Session ID for grouping operations (default: random UUID) */
  sessionId?: string;
  /** Called for each intercepted operation and its decision — useful for logging */
  onIntercept?: (op: MCPOperation, decision: ProxyDecision) => void;
  /**
   * Decides a `require_approval` operation. The request is held — the child is
   * not called — until this resolves.
   *
   * Omit it and such operations are refused: the proxy sits synchronously in
   * the request path, so "forward and ask later" would mean the side effect has
   * already happened by the time anyone is asked. Anything that throws, or that
   * never answers, must leave the operation unrun.
   */
  awaitApproval?: (op: MCPOperation, decision: ProxyDecision) => Promise<'approved' | 'denied'>;
  /**
   * Called when the child MCP server sends a progress / partial-result
   * notification that is associated with a tracked `tools/call` request.
   * `requestId` is the JSON-RPC request id of the original `tools/call`.
   * `partial` is the parsed notification params object.
   */
  onPartialResult?: (requestId: string | number, partial: unknown) => void;
  /** stdin stream to read from (default: process.stdin) */
  stdin?: NodeJS.ReadableStream;
  /** stdout stream to write to (default: process.stdout) */
  stdout?: NodeJS.WritableStream;
  /** stderr stream to write errors to (default: process.stderr) */
  stderr?: NodeJS.WritableStream;
}

/**
 * Attempt to derive a short tool/server name from the spawn command.
 * Looks for "server-<name>" patterns in path segments and package names.
 * Returns "mcp" when no recognisable pattern is found.
 */
function inferToolName(command: string[]): string {
  for (const arg of command) {
    // Pattern 1: server-filesystem, @scope/server-filesystem → "filesystem"
    let m = arg.match(/server[_-]([a-z0-9_-]+)/i);
    if (m) return m[1]!.toLowerCase().replace(/-extended$/, '');
    // Pattern 2: mcp-servers/filesystem-extended → "filesystem"
    m = arg.match(/mcp-servers[/\\]([a-z0-9_-]+)/i);
    if (m) return m[1]!.toLowerCase().replace(/-extended$/, '');
  }
  return 'mcp';
}

/** Tracks an in-flight tools/call so progress notifications can be correlated. */
interface PendingCall {
  operation: MCPOperation;
  decision: ProxyDecision;
}

/**
 * Newline-delimited JSON-RPC 2.0 proxy that intercepts MCP `tools/call` requests.
 *
 * Streaming support:
 *  - In-flight tool calls are tracked in `pendingCalls` (keyed by JSON-RPC id).
 *  - Progress notifications from the child (`notifications/progress`,
 *    `notifications/message`) whose `progressToken` / `relatedRequestId`
 *    matches a pending call trigger the `onPartialResult` callback and are
 *    relayed to the client unchanged.
 *  - `$/cancelRequest` from the client removes the pending entry and is
 *    forwarded to the child unchanged.
 */
export class MCPStdioProxy {
  private child: ChildProcess | null = null;
  // `awaitApproval` stays optional after normalisation: its absence is
  // meaningful — it is what makes the proxy refuse a require_approval
  // operation rather than silently letting it through.
  private readonly options: Required<Omit<StdioProxyOptions, 'awaitApproval'>>
    & Pick<StdioProxyOptions, 'awaitApproval'>;
  private readonly resolvedToolName: string;
  /** In-flight tools/call requests keyed by their JSON-RPC id (stringified). */
  private readonly pendingCalls = new Map<string, PendingCall>();

  constructor(options: StdioProxyOptions) {
    this.options = {
      agentId: 'stdio-client',
      sessionId: randomUUID(),
      toolName: '',
      onIntercept: () => { /* no-op */ },
      onPartialResult: () => { /* no-op */ },
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      ...options,
    };
    this.resolvedToolName = this.options.toolName || inferToolName(options.command);
  }

  /** Start the child MCP server and begin proxying. Resolves when the child exits. */
  async start(): Promise<void> {
    const { command, stdin, stdout, stderr } = this.options;
    const [cmd, ...args] = command;

    this.child = spawn(cmd!, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (this.child.stderr) {
      this.child.stderr.on('data', (data: Buffer) => {
        stderr.write(data);
      });
    }

    // Client → Proxy → Child
    const clientLines = createInterface({ input: stdin as NodeJS.ReadableStream, crlfDelay: Infinity });
    clientLines.on('line', (line: string) => {
      void this.handleClientLine(line);
    });

    // Child → Proxy → Client
    const childOut = this.child.stdout;
    if (!childOut) throw new Error('child stdout is null');
    const childLines = createInterface({ input: childOut, crlfDelay: Infinity });
    childLines.on('line', (line: string) => {
      this.handleChildLine(line);
    });

    return new Promise<void>((resolve) => {
      this.child!.on('exit', () => {
        clientLines.close();
        resolve();
      });
    });
  }

  /** Stop the child process. */
  /**
   * Ask the configured resolver, failing closed on every path that is not an
   * explicit approval: no resolver, a throw, a rejected promise.
   */
  private async resolveApproval(
    operation: MCPOperation,
    decision: ProxyDecision
  ): Promise<'approved' | 'denied' | 'unavailable'> {
    const gate = this.options.awaitApproval;
    if (!gate) return 'unavailable';
    try {
      return await gate(operation, decision);
    } catch (err) {
      this.options.stderr.write(`[agentsgate] approval could not be obtained: ${(err as Error).message}\n`);
      return 'unavailable';
    }
  }

  stop(): void {
    this.child?.kill();
  }

  /** Return the number of currently tracked in-flight tool calls (for testing). */
  getPendingCallCount(): number {
    return this.pendingCalls.size;
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  /**
   * Process a line received from the child MCP server.
   * Relays progress/message notifications to `onPartialResult` when they
   * match a tracked tools/call, then forwards the line to the client.
   * On final tools/call response, the pending entry is removed.
   */
  private handleChildLine(line: string): void {
    if (!line.trim()) { this.writeToClient(line); return; }

    try {
      const msg = JSON.parse(line) as JsonRpcResponse & { method?: string; params?: unknown };

      // Notification (no id field or id is null, has method)
      if (msg.method) {
        const params = msg.params as Record<string, unknown> | undefined;
        // MCP progress: params.progressToken or params.relatedRequestId
        if (params) {
          const token = params['progressToken'] ?? params['relatedRequestId'];
          if (token !== undefined) {
            const key = String(token);
            if (this.pendingCalls.has(key)) {
              this.options.onPartialResult(
                token as string | number,
                params
              );
            }
          }
        }
      } else if (msg.id !== null && msg.id !== undefined) {
        // Final response — remove from pending
        this.pendingCalls.delete(String(msg.id));
      }
    } catch {
      // Not JSON — relay as-is
    }

    this.writeToClient(line);
  }

  private async handleClientLine(line: string): Promise<void> {
    if (!line.trim()) return;

    let msg: JsonRpcRequest;
    try {
      msg = JSON.parse(line) as JsonRpcRequest;
    } catch {
      // Not valid JSON — pass through as-is
      this.writeToChild(line);
      return;
    }

    // Handle cancel: remove from pending and forward
    if (msg.method === '$/cancelRequest' && msg.params) {
      const cancelId = String((msg.params as Record<string, unknown>)['id'] ?? '');
      this.pendingCalls.delete(cancelId);
      this.writeToChild(line);
      return;
    }

    // Only intercept tools/call; pass everything else through
    if (msg.method !== 'tools/call' || !msg.params) {
      this.writeToChild(line);
      return;
    }

    const toolName = String(msg.params['name'] ?? 'unknown');
    const toolArgs = (msg.params['arguments'] ?? {}) as Record<string, unknown>;

    const operation: MCPOperation = {
      id: randomUUID(),
      agentId: this.options.agentId,
      tool: this.resolvedToolName,
      method: toolName,
      params: toolArgs,
      timestamp: new Date(),
      sessionId: this.options.sessionId,
    };

    const decision = await this.options.evaluateRisk(operation);
    this.options.onIntercept(operation, decision);

    if (decision.action === 'block') {
      // Return a JSON-RPC error to the client — do NOT forward to child
      const errorResponse: JsonRpcResponse = {
        jsonrpc: '2.0',
        id: msg.id,
        error: {
          code: -32600,
          message: `AgentsGate blocked: ${decision.reasons[0] ?? 'high risk score'}`,
          data: {
            riskScore: decision.riskScore,
            reasons: decision.reasons,
          },
        },
      };
      this.writeToClient(JSON.stringify(errorResponse));
      return;
    }

    if (decision.action === 'require_approval') {
      const verdict = await this.resolveApproval(operation, decision);
      if (verdict !== 'approved') {
        this.writeToClient(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          error: {
            code: -32600,
            message: verdict === 'denied'
              ? `AgentsGate: approval denied — ${decision.reasons[0] ?? 'operation requires approval'}`
              : `AgentsGate: operation requires approval and no approver is available — ${decision.reasons[0] ?? ''}`.trim(),
            data: { riskScore: decision.riskScore, reasons: decision.reasons, verdict },
          },
        } satisfies JsonRpcResponse));
        return;
      }
    }

    // allow, or an approved require_approval — forward to child with riskScore
    // injected into params so downstream tooling can observe the score if needed
    if (decision.riskScore > 0) {
      msg = {
        ...msg,
        params: {
          ...msg.params,
          _agentsgate: { riskScore: decision.riskScore, action: decision.action },
        },
      };
    }

    // Track this call so progress notifications can be correlated
    if (msg.id !== null && msg.id !== undefined) {
      this.pendingCalls.set(String(msg.id), { operation, decision });
    }

    this.writeToChild(JSON.stringify(msg));
  }

  private writeToChild(line: string): void {
    this.child?.stdin?.write(line + '\n');
  }

  private writeToClient(line: string): void {
    this.options.stdout.write(line + '\n');
  }
}
