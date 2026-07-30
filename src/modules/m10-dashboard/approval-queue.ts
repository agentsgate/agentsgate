import type { MCPOperation } from '../../types/interfaces.js';
import type { StateStore, PendingApprovalRecord } from '../m2-store/index.js';
import { assertSafeOutboundUrl } from '../../utils/url-safety.js';

// ── ApprovalQueue ────────────────────────────────────────────────────────────

export interface PendingApproval {
  id: string;
  operation: MCPOperation;
  riskScore: number;
  checkpointId?: string;
  queuedAt: Date;
}

export interface ApprovalQueueOptions {
  /**
   * If set, a POST request with the approval details is sent to this URL
   * whenever an operation is enqueued (fire-and-forget, non-blocking).
   */
  webhookUrl?: string;
  /**
   * Base URL of this dashboard server (e.g. "http://localhost:4001").
   * Used to build approve/deny URLs included in the webhook payload.
   */
  dashboardBaseUrl?: string;
  /** Optional persistence layer so queued approvals survive restarts. */
  store?: StateStore;
  /** Maximum age of queued approvals before they are auto-expired. Defaults to 24 hours. */
  maxAgeMs?: number;
  /**
   * If set (in milliseconds), an escalation webhook re-fires for any approval
   * still pending after this delay. Requires `webhookUrl` to be set.
   */
  escalateAfterMs?: number;
  /**
   * Called when a queued approval is removed due to TTL expiry (T273).
   * Use to push SSE events or other notifications.
   */
  onExpire?: (approval: PendingApproval) => void;
  /**
   * Bypass the T425 SSRF private-IP denylist. For use in tests only.
   * Do NOT set this in production.
   */
  allowPrivateWebhookUrls?: boolean;
  /** Optional HMAC-SHA256 secret for signing outbound webhook payloads (X-AgentsGate-Signature header). */
  webhookSecret?: string;
  /**
   * Base delay for the exponential webhook retry backoff. Defaults to 1000ms.
   * Tests can set 0 to retry immediately instead of mixing fake timers with real fetch.
   */
  webhookRetryBackoffMs?: number;
}

const DEFAULT_APPROVAL_MAX_AGE_MS = 86_400_000;

/**
 * In-memory queue for operations awaiting human approval.
 * Populated by createPipeline() when an operation scores `require_approval`.
 */
export class ApprovalQueue {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly webhookUrl?: string;
  private readonly webhookSecret?: string;
  private readonly dashboardBaseUrl?: string;
  private readonly store?: StateStore;
  private readonly maxAgeMs: number;
  private readonly escalateAfterMs?: number;
  private readonly onExpire?: (approval: PendingApproval) => void;
  private readonly allowPrivateWebhookUrls: boolean;
  private readonly webhookRetryBackoffMs: number;
  /** Fire-and-forget webhook deliveries still in flight — awaited by whenIdle() */
  private readonly inFlightWebhooks = new Set<Promise<void>>();
  /** Timer handles for pending escalations, keyed by approval ID */
  private readonly escalationTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** IDs that have already had escalation fired — prevents double-fire on race condition (T427) */
  private readonly escalatedIds = new Set<string>();

  constructor(options: ApprovalQueueOptions = {}) {
    this.webhookUrl = options.webhookUrl;
    this.webhookSecret = options.webhookSecret;
    this.dashboardBaseUrl = options.dashboardBaseUrl;
    this.store = options.store;
    this.allowPrivateWebhookUrls = options.allowPrivateWebhookUrls ?? false;
    this.webhookRetryBackoffMs = options.webhookRetryBackoffMs ?? 1000;
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_APPROVAL_MAX_AGE_MS;
    this.escalateAfterMs = options.escalateAfterMs;
    this.onExpire = options.onExpire;
  }

  async initialize(): Promise<void> {
    if (!this.store) return;

    const approvals = await this.store.listPendingApprovals();
    this.pending.clear();
    for (const item of approvals) {
      this.pending.set(item.id, toPendingApproval(item));
    }

    this.pruneExpired();
  }

  enqueue(operation: MCPOperation, riskScore: number, checkpointId?: string): PendingApproval {
    this.pruneExpired();

    const item: PendingApproval = {
      id: operation.id,
      operation,
      riskScore,
      checkpointId,
      queuedAt: new Date(),
    };
    this.pending.set(operation.id, item);

    if (this.store) {
      void this.store.savePendingApproval(item);
    }

    if (this.webhookUrl) {
      this.trackWebhook(this.fireWebhook(item));

      if (this.escalateAfterMs) {
        const timer = setTimeout(() => {
          this.escalationTimers.delete(item.id);
          // T427: check escalatedIds atomically to prevent double-fire on race condition
          if (this.pending.has(item.id) && !this.escalatedIds.has(item.id)) {
            this.escalatedIds.add(item.id);
            this.trackWebhook(this.fireEscalation(item));
          }
        }, this.escalateAfterMs);
        this.escalationTimers.set(item.id, timer);
      }
    }

    return item;
  }

  private async postWithRetry(url: string, body: unknown, maxAttempts = 3): Promise<boolean> {
    // SSRF prevention: enforce http(s) and (unless explicitly allowed) reject any
    // URL that RESOLVES to a private/loopback/metadata address. Resolving DNS
    // closes the bypass where a public hostname's A record points at an internal
    // IP — a protocol/hostname-regex-only check cannot catch that.
    try {
      await assertSafeOutboundUrl(url, { allowPrivate: this.allowPrivateWebhookUrls });
    } catch (err) {
      console.warn(`[ApprovalQueue] Webhook URL rejected: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
    const jsonBody = JSON.stringify(body);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.webhookSecret) {
      const { createHmac } = await import('node:crypto');
      const sig = createHmac('sha256', this.webhookSecret).update(jsonBody).digest('hex');
      headers['X-AgentsGate-Signature'] = `sha256=${sig}`;
    }
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers,
          body: jsonBody,
          // Do not auto-follow redirects — a 3xx could point at an internal
          // target that bypassed the pre-flight SSRF check.
          redirect: 'manual',
        });
        if (res.ok) return true;
      } catch { /* network error — fall through to retry */ }
      if (attempt < maxAttempts - 1) {
        await new Promise(r => setTimeout(r, this.webhookRetryBackoffMs * 2 ** attempt));
      }
    }
    return false;
  }

  private trackWebhook(delivery: Promise<void>): void {
    this.inFlightWebhooks.add(delivery);
    void delivery.finally(() => this.inFlightWebhooks.delete(delivery));
  }

  /**
   * Track a fire-and-forget store write the same way, so `whenIdle()` covers
   * persistence too — a caller that resolves and then reads the verdict back
   * has something to await.
   */
  private trackWrite(write: Promise<unknown>): void {
    const settled = write.then(() => undefined, () => undefined);
    this.inFlightWebhooks.add(settled);
    void settled.finally(() => this.inFlightWebhooks.delete(settled));
  }

  /** Resolves once all fire-and-forget webhook deliveries and store writes have settled. */
  async whenIdle(): Promise<void> {
    while (this.inFlightWebhooks.size > 0) {
      await Promise.allSettled([...this.inFlightWebhooks]);
    }
  }

  private async fireWebhook(item: PendingApproval): Promise<void> {
    const base = this.dashboardBaseUrl ?? '';
    const payload = {
      event: 'approval_required',
      id: item.id,
      agentId: item.operation.agentId,
      tool: item.operation.tool,
      method: item.operation.method,
      riskScore: item.riskScore,
      checkpointId: item.checkpointId,
      approveUrl: `${base}/approvals/${item.id}/approve`,
      denyUrl: `${base}/approvals/${item.id}/deny`,
      queuedAt: item.queuedAt.toISOString(),
    };
    const ok = await this.postWithRetry(this.webhookUrl!, payload);
    if (!ok) {
      console.warn(`[ApprovalQueue] Webhook delivery failed after all attempts: ${this.webhookUrl}`);
    }
  }

  private async fireEscalation(item: PendingApproval): Promise<void> {
    const base = this.dashboardBaseUrl ?? '';
    const payload = {
      event: 'approval_escalation',
      id: item.id,
      agentId: item.operation.agentId,
      tool: item.operation.tool,
      method: item.operation.method,
      riskScore: item.riskScore,
      checkpointId: item.checkpointId,
      approveUrl: `${base}/approvals/${item.id}/approve`,
      denyUrl: `${base}/approvals/${item.id}/deny`,
      queuedAt: item.queuedAt.toISOString(),
    };
    const ok = await this.postWithRetry(this.webhookUrl!, payload);
    if (!ok) {
      console.warn(`[ApprovalQueue] Escalation webhook failed after all attempts: ${this.webhookUrl}`);
    }
  }

  getPending(): PendingApproval[] {
    this.pruneExpired();
    return [...this.pending.values()];
  }

  /**
   * Re-read the shared store, so approvals queued by another process — the
   * stdio proxy runs under the MCP client, not under `agentsgate start` —
   * become visible here. A no-op without a store.
   */
  async refresh(): Promise<PendingApproval[]> {
    if (this.store) {
      for (const item of await this.store.listPendingApprovals()) {
        if (!this.pending.has(item.id)) this.pending.set(item.id, toPendingApproval(item));
      }
    }
    return this.getPending();
  }

  /**
   * Settle an approval.
   *
   * The verdict is written to the store rather than the row being deleted:
   * whoever is holding the operation reads it back from there, and "the row is
   * gone" cannot tell approved from denied from expired. Defaults to
   * `approved` so callers written before the gate existed keep their meaning.
   *
   * Returns the item when this call settled it, including one queued by another
   * process, and undefined when there was nothing to settle.
   */
  resolve(id: string, verdict: 'approved' | 'denied' = 'approved'): PendingApproval | undefined {
    this.pruneExpired();

    // Cancel any pending escalation timer
    const timer = this.escalationTimers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.escalationTimers.delete(id);
    }
    // T427: clean up escalatedIds to prevent memory leak
    this.escalatedIds.delete(id);

    const item = this.pending.get(id);
    this.pending.delete(id);

    if (this.store) {
      this.trackWrite(this.store.resolvePendingApproval(id, verdict));
    }

    return item;
  }

  has(id: string): boolean {
    this.pruneExpired();
    return this.pending.has(id);
  }

  get size(): number {
    this.pruneExpired();
    return this.pending.size;
  }

  /** TTL for queued approvals in milliseconds. */
  get ttlMs(): number {
    return this.maxAgeMs;
  }

  private pruneExpired(): void {
    const expired: PendingApproval[] = [];
    const now = Date.now();

    for (const [id, item] of this.pending.entries()) {
      const ageMs = now - item.queuedAt.getTime();
      if (ageMs > this.maxAgeMs) {
        expired.push(item);
        this.pending.delete(id);
      }
    }

    if (this.store) {
      for (const item of expired) {
        void this.store.deletePendingApproval(item.id);
      }
    }

    // T273: notify caller of expired approvals (e.g. for SSE push)
    if (this.onExpire) {
      for (const item of expired) {
        this.onExpire(item);
      }
    }
  }
}

function toPendingApproval(item: PendingApprovalRecord): PendingApproval {
  return {
    id: item.id,
    operation: item.operation,
    riskScore: item.riskScore,
    checkpointId: item.checkpointId,
    queuedAt: item.queuedAt,
  };
}
