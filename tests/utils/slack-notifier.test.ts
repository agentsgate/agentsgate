/**
 * T144 — Slack notification adapter.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'node:http';
import { SlackNotifier } from '../../src/utils/slack-notifier.js';
import type { MCPOperation, ProxyDecision } from '../../src/types/interfaces.js';

function makeOp(tool = 'filesystem', agentId = 'agent-1'): MCPOperation {
  return { id: 'op-1', agentId, tool, method: 'write_file', params: {}, timestamp: new Date(), sessionId: 'sess-1' };
}
function dec(action: ProxyDecision['action'], score = 0.8): ProxyDecision {
  return { action, riskScore: score, reasons: ['Triggered rule: L1_DELETE_FILE'] };
}

/** Capture first POST body from a minimal HTTP server. */
function makeServer(): Promise<{ url: string; getBody: () => Promise<string>; close: () => Promise<void> }> {
  return new Promise(resolve => {
    let resolveBody: (v: string) => void;
    const bodyPromise = new Promise<string>(r => { resolveBody = r; });
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => { body += c.toString(); });
      req.on('end', () => { resolveBody(body); res.writeHead(200); res.end(); });
    });
    server.listen(0, () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        getBody: () => bodyPromise,
        close: () => new Promise((res, rej) => server.close(e => e ? rej(e) : res())),
      });
    });
  });
}

describe('SlackNotifier', () => {
  it('returns false and does not POST for allowed operations', async () => {
    const wh = await makeServer();
    try {
      const notifier = new SlackNotifier({ webhookUrl: wh.url, allowPrivateUrl: true });
      const sent = await notifier.notify(makeOp(), dec('allow', 0.1));
      expect(sent).toBe(false);
    } finally {
      await wh.close();
    }
  });

  it('returns true and POSTs for blocked operations', async () => {
    const wh = await makeServer();
    try {
      const notifier = new SlackNotifier({ webhookUrl: wh.url, allowPrivateUrl: true });
      const sent = await notifier.notify(makeOp(), dec('block'));
      expect(sent).toBe(true);

      const body = JSON.parse(await wh.getBody()) as {
        attachments: Array<{ color: string; title: string; fields: Array<{ title: string; value: string }> }>;
      };
      expect(body.attachments[0].color).toBe('#ef4444');
      expect(body.attachments[0].title).toContain('BLOCKED');
      const agentField = body.attachments[0].fields.find(f => f.title === 'Agent');
      expect(agentField?.value).toBe('agent-1');
    } finally {
      await wh.close();
    }
  });

  it('returns true and POSTs for require_approval operations', async () => {
    const wh = await makeServer();
    try {
      const notifier = new SlackNotifier({ webhookUrl: wh.url, allowPrivateUrl: true });
      const sent = await notifier.notify(makeOp(), dec('require_approval'));
      expect(sent).toBe(true);

      const body = JSON.parse(await wh.getBody()) as {
        attachments: Array<{ color: string; title: string }>;
      };
      expect(body.attachments[0].color).toBe('#f59e0b');
      expect(body.attachments[0].title).toContain('REQUIRED');
    } finally {
      await wh.close();
    }
  });

  it('respects custom notifyOn configuration', async () => {
    const wh = await makeServer();
    try {
      const notifier = new SlackNotifier({ webhookUrl: wh.url, notifyOn: ['block'], allowPrivateUrl: true });
      // require_approval should not trigger notification
      const sent = await notifier.notify(makeOp(), dec('require_approval'));
      expect(sent).toBe(false);
    } finally {
      await wh.close();
    }
  });

  it('silently swallows network errors', async () => {
    const notifier = new SlackNotifier({ webhookUrl: 'http://127.0.0.1:19997', allowPrivateUrl: true });
    await expect(notifier.notify(makeOp(), dec('block'))).resolves.toBe(true);
  });
});

describe('SlackNotifier — SSRF guard', () => {
  /** Resolves to the POST body, or to null if nothing arrives within `ms`. */
  function bodyOrNothing(p: Promise<string>, ms: number): Promise<string | null> {
    return Promise.race([p, new Promise<null>(r => setTimeout(() => r(null), ms))]);
  }

  it('refuses a webhook URL resolving to loopback when private URLs are not allowed', async () => {
    const wh = await makeServer();
    try {
      // allowPrivateUrl omitted — the production default
      const notifier = new SlackNotifier({ webhookUrl: wh.url });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const sent = await notifier.notify(makeOp(), dec('block'));

      // The caller-facing contract is unchanged, but nothing left the process.
      expect(sent).toBe(true);
      expect(await bodyOrNothing(wh.getBody(), 300)).toBeNull();
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    } finally {
      await wh.close();
    }
  });

  it('refuses a non-http(s) webhook URL', async () => {
    const notifier = new SlackNotifier({ webhookUrl: 'file:///etc/passwd' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await notifier.notify(makeOp(), dec('block'))).toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
