import type {
  MCPOperation,
  RollbackAdapter,
  RollbackCapability,
  StateSnapshot,
  RollbackResult,
  RollbackPreview,
} from '../../types/interfaces.js';
import { assertSafeOutboundUrl } from '../../utils/url-safety.js';

export class SlackRollbackAdapter implements RollbackAdapter {
  readonly adapterId = 'agentsgate-slack';
  readonly version = '1.0.0';
  readonly supportedTools: string[] = ['slack', 'agentsgate-slack'];

  constructor(
    /** Slack bot token with chat:write and chat:delete scopes */
    private readonly botToken: string,
    /** Slack API base URL — override for testing */
    private readonly apiBase = 'https://slack.com/api',
    /**
     * Skip the SSRF denylist. The real Slack API is external, so production
     * should never set this; tests point apiBase at a loopback server.
     */
    private readonly allowPrivateApiBase = false,
  ) {}

  async canRollback(operation: MCPOperation): Promise<RollbackCapability> {
    const toolMatch = this.supportedTools.includes(operation.tool);
    const isSend = operation.method === 'send_message' || operation.method === 'postMessage';
    return {
      canRollback: toolMatch && isSend,
      confidence: 0.8,
      limitations: ['Only send_message / postMessage operations can be rolled back by deleting the message'],
    };
  }

  async captureState(context: MCPOperation): Promise<StateSnapshot> {
    return {
      adapterId: this.adapterId,
      operationId: context.id,
      data: {
        channel: context.params['channel'] ?? null,
        messageTs: null, // populated from executionResult after the operation
      },
      capturedAt: new Date(),
    };
  }

  async rollback(snapshot: StateSnapshot): Promise<RollbackResult> {
    const data = snapshot.data as { channel?: string; messageTs?: string };
    const channel = data.channel;
    const messageTs = data.messageTs;

    if (!channel || !messageTs) {
      return {
        success: false,
        restoredFiles: [],
        failedFiles: [],
        error: 'Missing channel or messageTs in snapshot — cannot delete message',
      };
    }

    const deleteUrl = `${this.apiBase}/chat.delete`;
    try {
      await assertSafeOutboundUrl(deleteUrl, { allowPrivate: this.allowPrivateApiBase });
    } catch (err) {
      return {
        success: false,
        restoredFiles: [],
        failedFiles: [],
        error: `Slack API base rejected: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    try {
      const res = await fetch(deleteUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Authorization': `Bearer ${this.botToken}`,
        },
        body: JSON.stringify({ channel, ts: messageTs }),
      });

      if (!res.ok) {
        return {
          success: false,
          restoredFiles: [],
          failedFiles: [`slack:${channel}:${messageTs}`],
          error: `Slack API HTTP ${res.status}`,
        };
      }

      const body = await res.json() as { ok: boolean; error?: string };
      if (!body.ok) {
        return {
          success: false,
          restoredFiles: [],
          failedFiles: [`slack:${channel}:${messageTs}`],
          error: `Slack API error: ${body.error ?? 'unknown'}`,
        };
      }

      return {
        success: true,
        restoredFiles: [`slack:${channel}:${messageTs}`],
        failedFiles: [],
      };
    } catch (err) {
      return {
        success: false,
        restoredFiles: [],
        failedFiles: [`slack:${channel}:${messageTs}`],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async previewRollback(snapshot: StateSnapshot): Promise<RollbackPreview> {
    const data = snapshot.data as { channel?: string; messageTs?: string };
    return {
      willRestore: data.channel && data.messageTs
        ? [`delete slack message ts=${data.messageTs} in channel=${data.channel}`]
        : [],
      cannotRestore: [],
      warnings: [
        'Deleted Slack messages cannot be recovered',
        'The delete API requires the bot token to have the chat:write scope and the message must be sent by the bot',
      ],
    };
  }
}
