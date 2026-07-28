/**
 * T167 — WebSocket gateway for live proxy decision streaming.
 *
 * Exposes an HTTP server that upgrades connections to WebSocket.
 * Every time a proxy decision is made, the caller pushes it via `broadcast()`,
 * and all connected clients receive the event as a JSON text frame.
 *
 * Message format (sent to clients):
 *   {
 *     type: 'operation',
 *     operation: { id, agentId, tool, method, sessionId, timestamp },
 *     decision: { action, riskScore, reasons, dryRun? },
 *     timestamp: ISO string
 *   }
 *
 * Clients may also receive:
 *   { type: 'connected', message: string }     — on initial connection
 *   { type: 'ping' }                           — keepalive (optional)
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { MCPOperation, ProxyDecision } from '../types/interfaces.js';

/** Constant-time string comparison to prevent timing attacks. */
function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export interface WSGatewayOptions {
  /** TCP port to listen on. */
  port: number;
  /** Network interface to bind to. Defaults to `127.0.0.1` (loopback only). */
  host?: string;
  /**
   * Optional API key. When set, connecting clients must supply it via the
   * `X-API-Key` header in the Upgrade request.
   * Connections without a matching key are rejected with HTTP 401.
   * Query-parameter delivery is intentionally not supported to prevent
   * key leakage via server logs, browser history, and Referer headers.
   */
  apiKey?: string;
}

/** Minimal frame parser/builder for RFC 6455 WebSocket text frames. */
function buildTextFrame(data: string): Buffer {
  const payload = Buffer.from(data, 'utf-8');
  const len = payload.length;
  let header: Buffer;
  if (len <= 125) {
    header = Buffer.alloc(2);
    header[0] = 0x81; // FIN + text opcode
    header[1] = len;
  } else if (len <= 65535) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

/** Parse incoming WebSocket frames enough to detect close/ping frames. */
function parseFrameOpcode(buf: Buffer): number {
  if (buf.length < 2) return -1;
  return buf[0]! & 0x0f;
}

function buildCloseFrame(): Buffer {
  const frame = Buffer.alloc(2);
  frame[0] = 0x88; // FIN + close opcode
  frame[1] = 0;
  return frame;
}

function buildPongFrame(mask: boolean, maskingKey?: Buffer, payload?: Buffer): Buffer {
  const data = payload ?? Buffer.alloc(0);
  let unmasked = data;
  if (mask && maskingKey && data.length > 0) {
    unmasked = Buffer.alloc(data.length);
    for (let i = 0; i < data.length; i++) {
      unmasked[i] = data[i]! ^ maskingKey[i % 4]!;
    }
  }
  const frame = Buffer.alloc(2 + unmasked.length);
  frame[0] = 0x8a; // FIN + pong opcode
  frame[1] = unmasked.length;
  unmasked.copy(frame, 2);
  return frame;
}

/**
 * WebSocket gateway that broadcasts proxy decision events to all connected clients.
 */
export class WSGateway extends EventEmitter {
  private readonly options: WSGatewayOptions;
  private server: http.Server | null = null;
  private readonly sockets = new Set<import('node:net').Socket>();

  constructor(options: WSGatewayOptions) {
    super();
    this.options = options;
  }

  /**
   * Start the WebSocket server on the configured port.
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((_req, res) => {
        // Non-upgrade requests get a 426 Upgrade Required
        res.writeHead(426, { 'Content-Type': 'text/plain' });
        res.end('Use WebSocket');
      });

      this.server.on('upgrade', (req, socket, head) => {
        this._handleUpgrade(req, socket as import('node:net').Socket, head);
      });

      this.server.once('error', reject);
      this.server.listen(this.options.port, this.options.host ?? '127.0.0.1', () => resolve());
    });
  }

  /** Returns the actual port the server is listening on (useful after start() with port 0). */
  getPort(): number {
    const addr = this.server?.address();
    if (!addr || typeof addr !== 'object') throw new Error('Server is not listening');
    return (addr as import('node:net').AddressInfo).port;
  }

  /**
   * Stop the WebSocket server and close all connections.
   */
  async stop(): Promise<void> {
    // Close all connected sockets
    for (const socket of this.sockets) {
      try {
        socket.write(buildCloseFrame());
        socket.destroy();
      } catch { /* ignore */ }
    }
    this.sockets.clear();

    return new Promise((resolve, reject) => {
      if (!this.server) { resolve(); return; }
      this.server.close(err => {
        this.server = null;
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Broadcast a proxy decision to all connected WebSocket clients.
   */
  broadcast(operation: MCPOperation, decision: ProxyDecision): void {
    if (this.sockets.size === 0) return;

    const msg = JSON.stringify({
      type: 'operation',
      operation: {
        id: operation.id,
        agentId: operation.agentId,
        tool: operation.tool,
        method: operation.method,
        sessionId: operation.sessionId,
        timestamp: operation.timestamp instanceof Date
          ? operation.timestamp.toISOString()
          : operation.timestamp,
      },
      decision: {
        action: decision.action,
        riskScore: decision.riskScore,
        reasons: decision.reasons,
        ...(decision.dryRun !== undefined ? { dryRun: decision.dryRun } : {}),
      },
      timestamp: new Date().toISOString(),
    });

    const frame = buildTextFrame(msg);
    for (const socket of this.sockets) {
      try { socket.write(frame); } catch { /* client disconnected */ }
    }
  }

  /** Number of currently connected clients. */
  get clientCount(): number {
    return this.sockets.size;
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  private _handleUpgrade(
    req: http.IncomingMessage,
    socket: import('node:net').Socket,
    head: Buffer
  ): void {
    // API key check — only the X-API-Key header is accepted.
    // Query-parameter delivery is intentionally rejected to prevent key leakage
    // via server access logs, browser history, and Referer headers.
    if (this.options.apiKey) {
      const headerKey = req.headers['x-api-key'];
      const provided = Array.isArray(headerKey) ? headerKey[0] : headerKey;
      if (!provided || !safeCompare(provided, this.options.apiKey)) {
        socket.write(
          'HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'
        );
        socket.destroy();
        return;
      }
    }

    // Validate WebSocket upgrade headers
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.write('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    // Compute accept key per RFC 6455
    const acceptKey = crypto.createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');

    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\n` +
      `Upgrade: websocket\r\n` +
      `Connection: Upgrade\r\n` +
      `Sec-WebSocket-Accept: ${acceptKey}\r\n\r\n`
    );

    this.sockets.add(socket);
    this.emit('connection', socket);

    // Send welcome frame
    socket.write(buildTextFrame(JSON.stringify({ type: 'connected', message: 'AgentsGate WebSocket gateway' })));

    // Handle incoming frames (close, ping) and disconnection
    socket.on('data', (buf: Buffer) => {
      const opcode = parseFrameOpcode(buf);
      if (opcode === 0x8) {
        // Close frame
        socket.write(buildCloseFrame());
        socket.destroy();
      } else if (opcode === 0x9) {
        // Ping — respond with pong
        const masked = (buf[1]! & 0x80) !== 0;
        const payloadLen = buf[1]! & 0x7f;
        const maskingKey = masked ? buf.slice(2, 6) : undefined;
        const payload = masked ? buf.slice(6, 6 + payloadLen) : buf.slice(2, 2 + payloadLen);
        socket.write(buildPongFrame(masked, maskingKey, payload));
      }
    });

    socket.on('close', () => { this.sockets.delete(socket); });
    socket.on('error', () => { this.sockets.delete(socket); socket.destroy(); });
  }
}
