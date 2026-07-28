/**
 * T144 — Slack notification adapter.
 *
 * Posts a message to a Slack Incoming Webhook URL when an operation is blocked
 * or requires approval.  Network failures are swallowed — the proxy must not
 * stall because Slack is unreachable.
 *
 * Config: set `config.webhook.slackUrl` (reuses the existing webhook config key
 * with an additional `slackUrl` field, or use it standalone).
 */

import type { MCPOperation, ProxyDecision } from '../types/interfaces.js';
import { assertSafeOutboundUrl } from './url-safety.js';

export interface SlackNotifierOptions {
  /** Incoming Webhook URL (starts with https://hooks.slack.com/...). */
  webhookUrl: string;
  /**
   * Only send notifications for these actions.
   * Defaults to ['block', 'require_approval'].
   */
  notifyOn?: Array<ProxyDecision['action']>;
  /** Optional display name override (default: "AgentsGate"). */
  username?: string;
  /**
   * Skip the SSRF denylist. Slack is always an external host, so production
   * should never set this; tests point the notifier at a loopback server.
   */
  allowPrivateUrl?: boolean;
}

export class SlackNotifier {
  private readonly webhookUrl: string;
  private readonly notifyOn: Set<string>;
  private readonly username: string;
  private readonly allowPrivateUrl: boolean;

  constructor(options: SlackNotifierOptions) {
    this.webhookUrl = options.webhookUrl;
    this.notifyOn   = new Set(options.notifyOn ?? ['block', 'require_approval']);
    this.username   = options.username ?? 'AgentsGate';
    this.allowPrivateUrl = options.allowPrivateUrl ?? false;
  }

  /**
   * Send a Slack notification if the decision action is in `notifyOn`.
   * Returns true if a message was sent (even if the POST failed).
   */
  async notify(operation: MCPOperation, decision: ProxyDecision): Promise<boolean> {
    if (!this.notifyOn.has(decision.action)) return false;

    const emoji   = decision.action === 'block' ? ':no_entry:' : ':hourglass_flowing_sand:';
    const colour  = decision.action === 'block' ? '#ef4444' : '#f59e0b';
    const title   = decision.action === 'block'
      ? `Operation BLOCKED (risk ${decision.riskScore.toFixed(2)})`
      : `Approval REQUIRED (risk ${decision.riskScore.toFixed(2)})`;

    const payload = {
      username: this.username,
      attachments: [{
        color: colour,
        fallback: `${emoji} ${title} — ${operation.agentId} / ${operation.tool}.${operation.method}`,
        title,
        fields: [
          { title: 'Agent',   value: operation.agentId,  short: true },
          { title: 'Tool',    value: `${operation.tool}.${operation.method}`, short: true },
          { title: 'Risk',    value: String(decision.riskScore.toFixed(3)), short: true },
          { title: 'Session', value: operation.sessionId, short: true },
          ...(decision.reasons?.length
            ? [{ title: 'Reasons', value: decision.reasons.slice(0, 3).join('\n'), short: false }]
            : []),
        ],
        ts: Math.floor(operation.timestamp.getTime() / 1000),
      }],
    };

    try {
      // Slack Incoming Webhooks are always external hosts, so a URL that
      // resolves to a private/loopback/metadata address is a misconfiguration
      // and is refused rather than dialled.
      await assertSafeOutboundUrl(this.webhookUrl, { allowPrivate: this.allowPrivateUrl });
    } catch (err) {
      console.warn(`[slack] webhook URL rejected: ${err instanceof Error ? err.message : String(err)}`);
      return true;
    }

    try {
      await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch {
      // Network failure — swallow so the proxy is not affected
    }

    return true;
  }
}
