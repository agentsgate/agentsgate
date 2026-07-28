import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { MCPOperation, ProxyDecision, ExecutionResult } from '../../types/interfaces.js';

export interface StreamableHttpProxyOptions {
  /** Risk evaluation pipeline — same as MCPProxy.evaluateRisk */
  evaluateRisk: (op: MCPOperation) => Promise<ProxyDecision>;
  /**
   * Forward allowed operations to the real tool.
   * Defaults to a no-op that returns success.
   */
  forwardToTool?: (op: MCPOperation) => Promise<ExecutionResult>;
  /**
   * Called after every operation is evaluated (for observability).
   */
  onOperation?: (op: MCPOperation, decision: ProxyDecision) => void;
}

/**
 * MCP StreamableHTTP proxy server.
 * Exposes the AgentsGate risk pipeline as a proper MCP server over HTTP.
 * Remote AI agents connect to this server instead of using stdio.
 */
export class MCPStreamableHttpProxy {
  private server: http.Server | null = null;
  private readonly evaluateRisk: (op: MCPOperation) => Promise<ProxyDecision>;
  private readonly forwardToTool: (op: MCPOperation) => Promise<ExecutionResult>;
  private readonly onOperation?: (op: MCPOperation, decision: ProxyDecision) => void;

  constructor(options: StreamableHttpProxyOptions) {
    this.evaluateRisk = options.evaluateRisk;
    this.forwardToTool = options.forwardToTool ?? (() => Promise.resolve({ success: true, output: null, durationMs: 0 }));
    this.onOperation = options.onOperation;
  }

  async start(port: number, host = '127.0.0.1'): Promise<void> {
    // Stateless transport — new session per request (no session state to manage)
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    const mcpServer = new McpServer({
      name: 'agentsgate-proxy',
      version: '1.0.0',
    });

    const self = this;

    mcpServer.tool(
      'invoke',
      'Route a tool call through the AgentsGate risk pipeline',
      {
        tool: z.string().describe('Downstream MCP tool name'),
        method: z.string().describe('Tool method to call'),
        params: z.record(z.string(), z.unknown()).optional().describe('Tool parameters'),
        agent_id: z.string().optional().describe('Agent identifier for risk scoring'),
        session_id: z.string().optional().describe('Session identifier'),
      },
      async ({ tool, method, params, agent_id, session_id }) => {
        const operation: MCPOperation = {
          id: randomUUID(),
          agentId: agent_id ?? 'remote-agent',
          tool,
          method,
          params: (params ?? {}) as Record<string, unknown>,
          timestamp: new Date(),
          sessionId: session_id ?? 'http-session',
        };

        const decision = await self.evaluateRisk(operation);
        if (self.onOperation) self.onOperation(operation, decision);

        if (decision.action === 'block') {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                blocked: true,
                riskScore: decision.riskScore,
                reasons: decision.reasons,
              }),
            }],
            isError: true,
          };
        }

        if (decision.action === 'require_approval') {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                requireApproval: true,
                riskScore: decision.riskScore,
                reasons: decision.reasons,
              }),
            }],
          };
        }

        // action === 'allow'
        const result = await self.forwardToTool(operation);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              allowed: true,
              riskScore: decision.riskScore,
              result: result.output,
              success: result.success,
              durationMs: result.durationMs,
            }),
          }],
          isError: !result.success,
        };
      },
    );

    await mcpServer.connect(transport);

    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        try {
          await transport.handleRequest(req, res);
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal server error' }));
        }
      });
      this.server.once('error', reject);
      this.server.listen(port, host, () => resolve());
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) { resolve(); return; }
      this.server.close(err => {
        this.server = null;
        if (err) reject(err);
        else resolve();
      });
    });
  }

  getPort(): number {
    const addr = this.server?.address();
    if (!addr || typeof addr !== 'object') throw new Error('Server is not listening');
    return (addr as import('net').AddressInfo).port;
  }
}
