/**
 * T167 — WebSocket gateway tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WSGateway } from '../../src/utils/ws-gateway.js';
import type { MCPOperation, ProxyDecision } from '../../src/types/interfaces.js';
import net from 'node:net';
import crypto from 'node:crypto';

function makeOp(): MCPOperation {
  return { id: 'op-1', agentId: 'agent-1', tool: 'filesystem', method: 'read_file', params: {}, timestamp: new Date(), sessionId: 's1' };
}

function makeDecision(action: ProxyDecision['action'] = 'allow'): ProxyDecision {
  return { action, riskScore: 0.2, reasons: ['test'] };
}

/** Perform a raw WebSocket handshake and return the socket + receive buffer helper. */
function wsConnect(port: number, headers: Record<string, string> = {}): Promise<{
  socket: net.Socket;
  receive: () => Promise<string>;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(port, '127.0.0.1');
    const key = crypto.randomBytes(16).toString('base64');
    let handshakeDone = false;
    let rawBuf = Buffer.alloc(0);
    const messageQueue: string[] = [];
    let resolver: ((s: string) => void) | null = null;

    const extraHeaders = Object.entries(headers)
      .map(([k, v]) => `${k}: ${v}\r\n`).join('');

    socket.on('connect', () => {
      socket.write(
        `GET / HTTP/1.1\r\n` +
        `Host: localhost:${port}\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\n` +
        `Sec-WebSocket-Version: 13\r\n` +
        extraHeaders +
        `\r\n`
      );
    });

    socket.on('data', (data: Buffer) => {
      rawBuf = Buffer.concat([rawBuf, data]);

      if (!handshakeDone) {
        const sep = rawBuf.indexOf('\r\n\r\n');
        if (sep === -1) return;
        const responseHead = rawBuf.slice(0, sep).toString();
        if (!responseHead.includes('101')) {
          reject(new Error(`Handshake failed: ${responseHead.slice(0, 100)}`));
          socket.destroy();
          return;
        }
        handshakeDone = true;
        rawBuf = rawBuf.slice(sep + 4);
      }

      // Parse text frames — handles base (<=125), 126 (2-byte len), 127 (8-byte len)
      while (rawBuf.length >= 2) {
        const opcode = rawBuf[0] & 0x0f;
        const baselen = rawBuf[1] & 0x7f;
        let headerLen = 2;
        let payloadLen = baselen;
        if (baselen === 126) {
          if (rawBuf.length < 4) break;
          payloadLen = rawBuf.readUInt16BE(2);
          headerLen = 4;
        } else if (baselen === 127) {
          if (rawBuf.length < 10) break;
          payloadLen = Number(rawBuf.readBigUInt64BE(2));
          headerLen = 10;
        }
        if (rawBuf.length < headerLen + payloadLen) break;
        if (opcode === 0x1) {
          const text = rawBuf.slice(headerLen, headerLen + payloadLen).toString('utf-8');
          if (resolver) { resolver(text); resolver = null; }
          else messageQueue.push(text);
        }
        rawBuf = rawBuf.slice(headerLen + payloadLen);
      }
    });

    socket.on('error', reject);

    // Give the handshake a moment to complete (500ms for slower Windows CI)
    setTimeout(() => {
      if (!handshakeDone) { reject(new Error('Handshake timeout')); return; }
      resolve({
        socket,
        receive: () => {
          if (messageQueue.length > 0) return Promise.resolve(messageQueue.shift()!);
          return new Promise(res => { resolver = res; });
        },
        close: () => {
          // Send a masked WebSocket close frame so the server actively removes us
          const frame = Buffer.alloc(6);
          frame[0] = 0x88; // FIN + close opcode
          frame[1] = 0x80; // MASK bit set, payload length 0
          // masking key = 4 zero bytes (no-op mask)
          try { socket.write(frame); } catch { /* ignore */ }
          setTimeout(() => socket.destroy(), 20);
        },
      });
    }, 500);
  });
}

/** Try connecting and return the HTTP status line (for rejected connections). */
function rawHttpConnect(port: number, headers: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.createConnection(port, '127.0.0.1');
    const key = crypto.randomBytes(16).toString('base64');
    const extraHeaders = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('');
    socket.on('connect', () => {
      socket.write(
        `GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n${extraHeaders}\r\n`
      );
    });
    let buf = '';
    socket.on('data', d => { buf += d.toString(); socket.destroy(); });
    socket.on('close', () => resolve(buf.slice(0, buf.indexOf('\r\n'))));
    socket.on('error', () => resolve(''));
  });
}

describe('WSGateway', () => {
  let gw: WSGateway;
  let port: number;

  beforeEach(async () => {
    port = 0;
    gw = new WSGateway({ port });
    await gw.start();
    port = gw.getPort();
  });

  afterEach(async () => {
    await gw.stop();
  });

  it('accepts WebSocket connections and sends welcome frame', async () => {
    const client = await wsConnect(port);
    const msg = JSON.parse(await client.receive());
    expect(msg.type).toBe('connected');
    client.close();
  });

  it('broadcasts operation+decision to connected clients', async () => {
    const client = await wsConnect(port);
    await client.receive(); // consume welcome

    gw.broadcast(makeOp(), makeDecision('block'));
    const msg = JSON.parse(await client.receive());
    expect(msg.type).toBe('operation');
    expect(msg.decision.action).toBe('block');
    expect(msg.operation.tool).toBe('filesystem');
    client.close();
  });

  it('clientCount reflects connected clients', async () => {
    expect(gw.clientCount).toBe(0);
    const c1 = await wsConnect(port);
    const c2 = await wsConnect(port);
    await c1.receive(); await c2.receive(); // welcome frames
    expect(gw.clientCount).toBe(2);
    c1.close();
    // Poll until the server removes the disconnected socket (max 2s)
    const deadline = Date.now() + 2000;
    while (gw.clientCount !== 1 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 30));
    }
    expect(gw.clientCount).toBe(1);
    c2.close();
  });

  it('does not error when broadcasting with no clients', () => {
    expect(() => gw.broadcast(makeOp(), makeDecision())).not.toThrow();
  });

  it('rejects connections without valid API key when apiKey is configured', async () => {
    await gw.stop();
    gw = new WSGateway({ port, apiKey: 'secret' });
    await gw.start();

    const noKeyStatus = await rawHttpConnect(port);
    expect(noKeyStatus).toContain('401');

    const badKeyStatus = await rawHttpConnect(port, { 'X-API-Key': 'wrong' });
    expect(badKeyStatus).toContain('401');
  });

  it('rejects connections that supply the API key via query parameter', async () => {
    await gw.stop();
    gw = new WSGateway({ port, apiKey: 'secret' });
    await gw.start();

    // Supply the correct key as a query param (not a header) — must be rejected
    const socket = net.createConnection(port, '127.0.0.1');
    const key = crypto.randomBytes(16).toString('base64');
    const statusLine = await new Promise<string>((resolve) => {
      socket.on('connect', () => {
        socket.write(
          `GET /?apiKey=secret HTTP/1.1\r\n` +
          `Host: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
        );
      });
      let buf = '';
      socket.on('data', d => { buf += d.toString(); socket.destroy(); });
      socket.on('close', () => resolve(buf.slice(0, buf.indexOf('\r\n'))));
      socket.on('error', () => resolve(''));
    });
    expect(statusLine).toContain('401');
  });

  it('accepts connections with correct API key header', async () => {
    await gw.stop();
    gw = new WSGateway({ port, apiKey: 'secret' });
    await gw.start();

    const client = await wsConnect(port, { 'X-API-Key': 'secret' });
    const msg = JSON.parse(await client.receive());
    expect(msg.type).toBe('connected');
    client.close();
  });

  it('includes dryRun flag in broadcast when decision is dry-run', async () => {
    const client = await wsConnect(port);
    await client.receive(); // welcome

    const dryDecision: ProxyDecision = { action: 'allow', riskScore: 0.0, reasons: ['[DRY-RUN]'], dryRun: true };
    gw.broadcast(makeOp(), dryDecision);
    const msg = JSON.parse(await client.receive());
    expect(msg.decision.dryRun).toBe(true);
    client.close();
  });
});
