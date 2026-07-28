import type { MCPOperation } from '../../types/interfaces.js';
import type { StateStore } from '../m2-store/index.js';
import { assertSafeOutboundUrl } from '../../utils/url-safety.js';

/** Minimum number of recorded outcomes before a meaningful score can be computed. */
const MIN_HISTORY = 10;

/** How long a successful community score stays usable. */
const COMMUNITY_CACHE_TTL_MS = 300_000;
/**
 * How long a failure is remembered. Deliberately much shorter than a success:
 * long enough to stop a dead endpoint from being dialled once per operation,
 * short enough that a recovering endpoint is picked up quickly.
 */
const COMMUNITY_FAILURE_TTL_MS = 30_000;
/** Upper bound on distinct tool+method entries retained. */
const COMMUNITY_CACHE_MAX = 500;
/** Per-request ceiling. This call sits on the per-operation path. */
const COMMUNITY_TIMEOUT_MS = 3_000;

interface CachedScore {
  score: number;
  expiresAt: number;
}

/** In-memory record of an operation outcome. */
interface OutcomeRecord {
  agentId: string;
  tool: string;
  wasApproved: boolean;
}

export interface IntelligenceOptions {
  /**
   * When provided, outcome records are persisted to SQLite so L2 scoring
   * survives proxy restarts and accumulates history across sessions.
   */
  store?: StateStore;
  /**
   * HTTP endpoint for L3 community risk scores (opt-in).
   * POST { tool, method } → expects { score: number } (0.0–1.0).
   * Returns -1 on network error, missing score, or unconfigured.
   */
  communityEndpoint?: string;
  /** Lifetime of a cached successful score. Defaults to 5 minutes. */
  communityCacheTtlMs?: number;
  /** Per-request timeout for the community endpoint. Defaults to 3 seconds. */
  communityTimeoutMs?: number;
  /**
   * Skip the SSRF denylist for the community endpoint. Tests point this at a
   * loopback server; production should never set it.
   */
  allowPrivateCommunityUrl?: boolean;
}

/**
 * M11: Risk Intelligence Engine
 *
 * L2 — User history score (Bayesian estimate based on past outcomes per agent+tool).
 *       Persisted to SQLite when a StateStore is provided.
 * L3 — Community collaborative score via configurable HTTP endpoint (opt-in).
 */
export class RiskIntelligenceEngine {
  /** In-memory write-through cache, keyed by `agentId:tool`. */
  private readonly outcomes = new Map<string, OutcomeRecord[]>();
  private readonly store?: StateStore;
  private readonly communityEndpoint?: string;
  private readonly communityCacheTtlMs: number;
  private readonly communityTimeoutMs: number;
  private readonly allowPrivateCommunityUrl: boolean;
  /** Cached scores keyed by tool+method. Insertion-ordered, so the oldest key evicts first. */
  private readonly communityCache = new Map<string, CachedScore>();
  /** Lookups currently in flight, so concurrent operations share one request. */
  private readonly communityInflight = new Map<string, Promise<number>>();

  constructor(options: IntelligenceOptions = {}) {
    this.store = options.store;
    this.communityEndpoint = options.communityEndpoint;
    this.communityCacheTtlMs = options.communityCacheTtlMs ?? COMMUNITY_CACHE_TTL_MS;
    this.communityTimeoutMs = options.communityTimeoutMs ?? COMMUNITY_TIMEOUT_MS;
    this.allowPrivateCommunityUrl = options.allowPrivateCommunityUrl ?? false;
  }

  /**
   * L2: Return a user-history-based risk score for the given agent + tool combination.
   * When a StateStore is available, queries the DB (includes cross-session history).
   * Returns -1 if there is insufficient history (< MIN_HISTORY outcomes).
   */
  async getUserHistoryScore(agentId: string, tool: string): Promise<number> {
    let history: Array<{ wasApproved: boolean }>;

    if (this.store) {
      history = await this.store.listOutcomeRecords(agentId, tool);
    } else {
      history = this.outcomes.get(outcomeKey(agentId, tool)) ?? [];
    }

    if (history.length < MIN_HISTORY) return -1;

    const approved = history.filter(o => o.wasApproved).length;
    return 1 - approved / history.length;
  }

  /**
   * L3: Community collaborative score.
   * Calls the configured communityEndpoint if set; returns -1 otherwise.
   *
   * This runs on the per-operation path — the proxy awaits it before deciding
   * every single tool call — so the network is kept off that path wherever
   * possible. The request body only carries `tool` and `method`, so the answer
   * is cacheable under exactly that key; concurrent callers for the same key
   * share one in-flight request; and every request is bounded by a timeout so
   * a slow or hanging endpoint degrades to "no L3 signal" instead of stalling
   * the agent.
   */
  async getCommunityScore(operation: MCPOperation): Promise<number> {
    if (!this.communityEndpoint) return -1;

    const key = communityKey(operation.tool, operation.method);

    const cached = this.communityCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.score;

    const inflight = this.communityInflight.get(key);
    if (inflight) return inflight;

    const lookup = this.fetchCommunityScore(operation)
      .catch((err: unknown) => {
        // Throttled by the failure TTL below, so a dead endpoint warns at most
        // once per COMMUNITY_FAILURE_TTL_MS per tool+method rather than per op.
        console.warn(
          `[intelligence] community score lookup failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return -1;
      })
      .then(score => {
        this.cacheCommunityScore(key, score);
        return score;
      })
      .finally(() => {
        this.communityInflight.delete(key);
      });

    this.communityInflight.set(key, lookup);
    return lookup;
  }

  /** Single community-endpoint request. Throws on rejection/network failure. */
  private async fetchCommunityScore(operation: MCPOperation): Promise<number> {
    const endpoint = this.communityEndpoint!;
    // Same SSRF treatment as the webhook and telemetry senders: resolve DNS and
    // reject private/loopback/metadata targets, so a public hostname pointing at
    // an internal address cannot be used to probe the host network.
    await assertSafeOutboundUrl(endpoint, { allowPrivate: this.allowPrivateCommunityUrl });

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: operation.tool, method: operation.method }),
      signal: AbortSignal.timeout(this.communityTimeoutMs),
    });
    if (!res.ok) return -1;
    const data = await res.json() as { score?: unknown };
    const score = data.score;
    if (typeof score !== 'number' || score < 0 || score > 1) return -1;
    return score;
  }

  /** Store a score, evicting the oldest entry once the cache is full. */
  private cacheCommunityScore(key: string, score: number): void {
    const ttl = score < 0 ? COMMUNITY_FAILURE_TTL_MS : this.communityCacheTtlMs;
    if (!this.communityCache.has(key) && this.communityCache.size >= COMMUNITY_CACHE_MAX) {
      const oldest = this.communityCache.keys().next().value;
      if (oldest !== undefined) this.communityCache.delete(oldest);
    }
    this.communityCache.set(key, { score, expiresAt: Date.now() + ttl });
  }

  /** Number of cached community scores (for testing). */
  getCommunityCacheSize(): number {
    return this.communityCache.size;
  }

  /**
   * Record the final human outcome of an operation so future scoring can learn.
   * Persists to SQLite when a StateStore is available.
   */
  async recordOutcome(
    operationId: string,
    wasApproved: boolean,
    agentId: string,
    tool: string
  ): Promise<void> {
    // Always update in-memory cache
    const key = outcomeKey(agentId, tool);
    const list = this.outcomes.get(key);
    const record: OutcomeRecord = { agentId, tool, wasApproved };
    if (list) {
      list.push(record);
    } else {
      this.outcomes.set(key, [record]);
    }

    // Persist to SQLite if available
    if (this.store) {
      await this.store.saveOutcomeRecord(operationId, agentId, tool, wasApproved);
    }
  }

  /** Return the number of in-memory outcomes for a given agent + tool (for testing). */
  getOutcomeCount(agentId: string, tool: string): number {
    return (this.outcomes.get(outcomeKey(agentId, tool)) ?? []).length;
  }

  /**
   * Return a per-tool risk breakdown for an agent — a map of tool name to its
   * individual history statistics and Bayesian risk score.
   *
   * Tools with fewer than MIN_HISTORY outcomes have score -1 (insufficient data).
   * When a StateStore is available, loads history from the DB first so cross-session
   * outcomes are included.
   */
  async getToolBreakdown(agentId: string): Promise<Record<string, ToolBreakdown>> {
    const result: Record<string, ToolBreakdown> = {};

    if (this.store) {
      // Fetch all distinct tools for this agent from the DB
      const allRecords = await this.store.listAllOutcomeRecords(agentId);
      const byTool = new Map<string, Array<{ wasApproved: boolean }>>();
      for (const r of allRecords) {
        const list = byTool.get(r.tool) ?? [];
        list.push({ wasApproved: r.wasApproved });
        byTool.set(r.tool, list);
      }
      for (const [tool, history] of byTool) {
        result[tool] = computeBreakdown(history);
      }
    } else {
      // Use in-memory outcomes, filter by agentId
      const prefix = `${agentId}:`;
      for (const [key, history] of this.outcomes) {
        if (key.startsWith(prefix)) {
          const tool = key.slice(prefix.length);
          result[tool] = computeBreakdown(history);
        }
      }
    }

    return result;
  }

  /**
   * Return L2 scores for all tools an agent has used, as a flat record.
   * Tools with insufficient history return -1.
   */
  async getAllToolScores(agentId: string): Promise<Record<string, number>> {
    const breakdown = await this.getToolBreakdown(agentId);
    const scores: Record<string, number> = {};
    for (const [tool, data] of Object.entries(breakdown)) {
      scores[tool] = data.score;
    }
    return scores;
  }
}

export interface ToolBreakdown {
  /** Number of recorded outcomes for this tool. */
  total: number;
  /** Number of outcomes where the operation was approved. */
  approvedCount: number;
  /** Number of outcomes where the operation was denied. */
  deniedCount: number;
  /**
   * Bayesian L2 risk score [0, 1], or -1 if fewer than MIN_HISTORY outcomes exist.
   * Higher = riskier (more denials relative to approvals).
   */
  score: number;
}

function computeBreakdown(history: Array<{ wasApproved: boolean }>): ToolBreakdown {
  const total = history.length;
  const approvedCount = history.filter(o => o.wasApproved).length;
  const deniedCount = total - approvedCount;
  const score = total < MIN_HISTORY ? -1 : 1 - approvedCount / total;
  return { total, approvedCount, deniedCount, score };
}

function outcomeKey(agentId: string, tool: string): string {
  return `${agentId}:${tool}`;
}

/** NUL separator so a tool name containing the delimiter cannot forge another key. */
function communityKey(tool: string, method: string): string {
  return `${tool}\u0000${method}`;
}
