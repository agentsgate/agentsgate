/**
 * Fake downstream MCP server for E2E testing.
 *
 * Speaks JSON-RPC 2.0 over stdio (newline-delimited JSON) — the exact wire
 * format used by the MCP stdio transport.  Spawned as a real child process by
 * MCPStdioProxy so the full process-spawning, pipe, and readline paths are
 * exercised in tests.
 *
 * Available tools:
 *   echo            – returns the `message` argument as a text content item
 *   fail            – returns a JSON-RPC error (code -32000, intentional)
 *   slow            – waits `delay` ms (default 100) then returns "slow response"
 *   inspect_request – returns the raw tools/call params JSON so tests can verify
 *                     that MCPStdioProxy injected _agentsgate metadata correctly
 */
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

const TOOLS = [
  {
    name: 'echo',
    description: 'Echoes the message argument back as a text content item.',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
    },
  },
  {
    name: 'fail',
    description: 'Always returns a JSON-RPC application error (code -32000).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'slow',
    description: 'Waits `delay` milliseconds before responding.',
    inputSchema: {
      type: 'object',
      properties: { delay: { type: 'number', default: 100 } },
    },
  },
  {
    name: 'inspect_request',
    description: 'Returns the raw tools/call params as JSON text — useful for '
      + 'verifying that proxy middleware (e.g. _agentsgate) was injected.',
    inputSchema: { type: 'object', properties: {} },
  },
];

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

rl.on('line', async (line) => {
  if (!line.trim()) return;

  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  // Notifications have no id (or id === null/undefined) — silently ignore.
  if (msg.id === undefined || msg.id === null) return;

  const { method, id, params } = msg;

  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-mcp-server', version: '1.0.0' },
      },
    });

  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });

  } else if (method === 'tools/call') {
    const toolName = params?.name;
    const args = params?.arguments ?? {};

    if (toolName === 'echo') {
      send({
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: String(args.message ?? '') }] },
      });

    } else if (toolName === 'fail') {
      send({
        jsonrpc: '2.0', id,
        error: { code: -32000, message: 'Tool execution failed', data: { reason: 'intentional' } },
      });

    } else if (toolName === 'slow') {
      const delay = Math.min(Number(args.delay ?? 100), 10_000);
      await new Promise(r => setTimeout(r, delay));
      send({
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: 'slow response' }] },
      });

    } else if (toolName === 'inspect_request') {
      // Return the full tools/call params — includes _agentsgate if proxy injected it.
      send({
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: JSON.stringify(params) }] },
      });

    } else {
      send({
        jsonrpc: '2.0', id,
        error: { code: -32601, message: `Unknown tool: ${toolName}` },
      });
    }

  } else {
    send({
      jsonrpc: '2.0', id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  }
});

// Clean exit when the parent closes our stdin.
process.stdin.on('end', () => process.exit(0));
