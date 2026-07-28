/**
 * T164 — Per-agent daily operation quota enforcement.
 *
 * Each agent can be assigned a maximum number of operations per day (UTC calendar day).
 * When the quota is exceeded, operations are blocked immediately.
 *
 * Quotas reset at midnight UTC. A global default quota can be set; per-agent quotas override it.
 */

export interface AgentQuotaOptions {
  /** Default daily operation quota for agents without a specific quota. */
  defaultQuota?: number;
  /** Per-agent daily quotas keyed by agentId. */
  agentQuotas?: Record<string, number>;
}

interface QuotaEntry {
  count: number;
  /** UTC date string (YYYY-MM-DD) for the current tracked day. */
  day: string;
}

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

export class AgentQuotaManager {
  private readonly defaultQuota?: number;
  private readonly agentQuotas: Map<string, number>;
  private readonly counters = new Map<string, QuotaEntry>();

  constructor(options: AgentQuotaOptions = {}) {
    this.defaultQuota = options.defaultQuota;
    this.agentQuotas = new Map(Object.entries(options.agentQuotas ?? {}));
  }

  /**
   * Record an operation for agentId and return true if within quota, false if exceeded.
   * If no quota is defined for the agent (and no default), always returns true.
   */
  check(agentId: string): boolean {
    const quota = this.agentQuotas.get(agentId) ?? this.defaultQuota;
    if (quota === undefined) return true; // no quota configured

    const today = todayUTC();
    const entry = this.counters.get(agentId);

    if (!entry || entry.day !== today) {
      // New day or first check — reset counter
      this.counters.set(agentId, { count: 1, day: today });
      return 1 <= quota;
    }

    entry.count++;
    return entry.count <= quota;
  }

  /** Return today's operation count for an agent. */
  getCount(agentId: string): number {
    const today = todayUTC();
    const entry = this.counters.get(agentId);
    if (!entry || entry.day !== today) return 0;
    return entry.count;
  }

  /** Return the quota for an agent (own or default). */
  getQuota(agentId: string): number | undefined {
    return this.agentQuotas.get(agentId) ?? this.defaultQuota;
  }

  /**
   * List all agents currently tracked in the quota counters.
   * Returns an array of { agentId, used, quota, remaining } for all known agents.
   */
  listAll(): Array<{ agentId: string; used: number; quota: number | undefined; remaining: number | undefined; percentUsed: number | undefined }> {
    const today = todayUTC();
    const result = [];
    for (const [agentId, entry] of this.counters) {
      const used = entry.day === today ? entry.count : 0;
      const quota = this.getQuota(agentId);
      result.push({
        agentId,
        used,
        quota,
        remaining: quota !== undefined ? Math.max(0, quota - used) : undefined,
        percentUsed: quota !== undefined && quota > 0 ? Math.min(100, (used / quota) * 100) : undefined,
      });
    }
    return result;
  }

  /** Clear all counters (useful for testing). */
  reset(): void {
    this.counters.clear();
  }
}
