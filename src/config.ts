/**
 * AgentsGate configuration loader.
 * Reads ~/.agentsgate/config.json and merges with defaults.
 *
 * Example config.json:
 * {
 *   "proxy": { "port": 4000, "checkpointThreshold": 0.3 },
 *   "intervention": { "allowBelow": 0.3, "blockAtOrAbove": 0.7 },
 *   "webhook": { "url": "https://hooks.slack.com/..." },
 *   "approvals": { "maxAgeMs": 86400000 },
 *   "telemetry": { "exportEndpoint": "https://...", "exportIntervalMs": 300000 },
 *   "intelligence": { "communityEndpoint": "https://..." },
 *   "rateLimit": { "enabled": false, "maxOpsPerMinute": 60 }
 * }
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { DEFAULT_PROTECTION_LEVEL } from './protection-levels.js';

const DEFAULT_APPROVAL_MAX_AGE_MS = 86_400_000;

export interface AgentsGateConfig {
  proxy: {
    /** Proxy listen port (default: 4000). Dashboard runs on port+1. */
    port: number;
    /**
     * Network interface the proxy, dashboard, and WS gateway bind to.
     * Defaults to `127.0.0.1` (loopback only). The M1 proxy transport has no
     * built-in authentication, so binding to a non-loopback address exposes
     * unauthenticated operation forwarding — only set a routable address when a
     * trusted reverse proxy in front provides authentication.
     */
    host: string;
    /** Risk score threshold above which a pre-operation checkpoint is created (default: 0.3). */
    checkpointThreshold: number;
  };
  intervention: {
    /** Risk score below this → allow (default: 0.3). */
    allowBelow: number;
    /** Risk score at or above this → block (default: 0.7). */
    blockAtOrAbove: number;
  };
  webhook?: {
    /** URL to POST when an operation requires approval. */
    url: string;
    /** Optional HMAC-SHA256 signing secret. When set, every webhook POST will include
     *  an `X-AgentsGate-Signature: sha256=<hex>` header computed over the raw JSON body.
     *  Receivers can verify: HMAC-SHA256(secret, body) === signature.
     */
    secret?: string;
    /** Slack Incoming Webhook URL — notified on block and require_approval events. */
    slackUrl?: string;
  };
  approvals?: {
    /** Maximum age of a queued approval before it is auto-expired (default: 86400000 = 24h). */
    maxAgeMs: number;
    /**
     * How long `agentsgate proxy` holds a require_approval operation while it
     * waits for someone to answer, before denying it (default: 60000 = 60s).
     *
     * The MCP client is blocked for this whole time and has a timeout of its
     * own. Waiting longer than the client does is worse than useless: it gives
     * up, and an approval arriving afterwards would run the tool with nobody
     * left to receive the result.
     */
    waitTimeoutMs?: number;
    /**
     * How long a one-shot approval grant stays spendable (default: 300000 = 5min).
     *
     * Approving an operation whose caller has already been answered leaves a
     * grant; asking the agent to try again spends it. Kept short because the
     * retry runs against whatever the state is then, so a long-lived grant
     * means what was reviewed and what runs can drift apart.
     */
    grantTtlMs?: number;
    /**
     * Hold the caller on the HTTP proxy while an operator answers, instead of
     * replying "needs approval" immediately (default: false).
     *
     * Off by default because it keeps an HTTP request open for up to
     * `waitTimeoutMs`, which reverse proxies and load balancers may cut. The
     * stdio proxy always holds — it owns the transport and nothing in between
     * can time it out.
     */
    holdHttpRequests?: boolean;
  };
  telemetry?: {
    /** HTTP endpoint for periodic telemetry export. */
    exportEndpoint: string;
    /** How often to export telemetry in ms (default: 300000 = 5 min). */
    exportIntervalMs: number;
    /**
     * Webhook URL for anomaly alerts.  When set, the proxy checks for
     * z-score spikes at every export interval and POSTs any alerts here.
     */
    anomalyWebhookUrl?: string;
    /** z-score threshold for anomaly detection (default: 2.0). */
    anomalyZScoreThreshold?: number;
    /** OTLP HTTP endpoint for periodic OpenTelemetry metric export (e.g. http://collector:4318/v1/metrics). */
    otlpEndpoint?: string;
    /** How often to export OTLP telemetry in ms (default: same as exportIntervalMs or 300000). */
    otlpExportIntervalMs?: number;
  };
  intelligence?: {
    /** Community risk score HTTP endpoint (opt-in L3). */
    communityEndpoint: string;
  };
  rateLimit?: {
    /** Enable per-agent rate limiting (default: false). */
    enabled: boolean;
    /** Maximum operations per agent per minute before blocking (default: 60). */
    maxOpsPerMinute: number;
  };
  logs?: {
    /** Number of days to retain operation logs before pruning (default: 30). */
    retentionDays: number;
  };
  dashboard?: {
    /**
     * When set, all dashboard API requests (except GET /health) must include
     * an `X-API-Key: <key>` header. Query-parameter auth is not supported
     * (prevents API keys from appearing in server logs).
     */
    apiKey?: string;
    /**
     * Per-key roles. When set, every `X-API-Key` must appear here or the
     * request is rejected:
     *   viewer   — read-only (all GET endpoints)
     *   approver — viewer, plus approve/reject of pending approvals
     *   admin    — full access, including rollback and session expiry
     * An `apiKey` set alongside this is treated as an admin key.
     */
    roles?: Record<string, 'viewer' | 'approver' | 'admin'>;
    /**
     * Hostnames the dashboard will answer to, checked against the Host header
     * as DNS rebinding defence. Defaults to localhost, 127.0.0.1, ::1 and
     * `proxy.host`. Set this when reaching the dashboard through a reverse
     * proxy or under another name.
     */
    allowedHosts?: string[];
  };
  audit?: {
    /**
     * When set, every OperationLog is HMAC-SHA256 signed with this secret
     * before being persisted.  Use `agentsgate audit --verify` to check integrity.
     */
    signingSecret?: string;
  };
  /**
   * How much to stop, expressed as a kind of operation rather than a number.
   *
   *   minimal   only wholesale destruction — DROP, TRUNCATE, DELETE with no WHERE
   *   balanced  the above, plus credentials blocked and deletions held (default)
   *   strict    plus personal-data reads and outbound sends held
   *
   * Policy rules are applied after the level and still win.
   */
  protection?: {
    level?: 'minimal' | 'balanced' | 'strict';
  };
  /** Namespace identifier — controls which DB file is used (data-{team}.db). */
  team?: string;
}

export const DEFAULT_CONFIG: AgentsGateConfig = {
  proxy: {
    port: 4000,
    host: '127.0.0.1',
    checkpointThreshold: 0.3,
  },
  intervention: {
    allowBelow: 0.3,
    blockAtOrAbove: 0.7,
  },
  protection: {
    level: DEFAULT_PROTECTION_LEVEL,
  },
  approvals: {
    maxAgeMs: DEFAULT_APPROVAL_MAX_AGE_MS,
  },
};

/**
 * Load configuration from disk, merging over defaults.
 * @param configPath — explicit path; falls back to ~/.agentsgate/config.json
 */
export async function loadConfig(configPath?: string): Promise<AgentsGateConfig> {
  const filePath = configPath ?? path.join(os.homedir(), '.agentsgate', 'config.json');
  let parsed: Partial<AgentsGateConfig> = {};

  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    parsed = JSON.parse(raw) as Partial<AgentsGateConfig>;
  } catch {
    // No config file — use defaults
  }

  // Everything the file declares, with defaults filled in underneath.
  //
  // This used to rebuild the object from a written-out list of sections, which
  // meant any section added later was read off disk and silently discarded:
  // `protection.level` never reached the proxy, so `agentsgate level strict`
  // wrote the file and changed nothing, and `approvals.waitTimeoutMs` and
  // `grantTtlMs` were inert. Spreading `parsed` means the next section added
  // works without anyone having to remember this function exists.
  return {
    ...parsed,
    proxy: { ...DEFAULT_CONFIG.proxy, ...parsed.proxy },
    intervention: { ...DEFAULT_CONFIG.intervention, ...parsed.intervention },
    approvals: {
      ...parsed.approvals,
      maxAgeMs: parsed.approvals?.maxAgeMs ?? DEFAULT_APPROVAL_MAX_AGE_MS,
    },
    protection: { ...DEFAULT_CONFIG.protection, ...parsed.protection },
  };
}

/**
 * Write a config file to disk (creates directory if needed).
 */
export async function saveConfig(
  config: AgentsGateConfig,
  configPath?: string
): Promise<void> {
  const filePath = configPath ?? path.join(os.homedir(), '.agentsgate', 'config.json');
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(config, null, 2));
}
