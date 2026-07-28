import { randomUUID } from 'node:crypto';
import type { MCPOperation, ProxyDecision, ExecutionResult, OperationLog } from '../../types/interfaces.js';
import type { StateStore } from '../m2-store/index.js';
import { stampLog, GENESIS_HMAC } from '../../utils/audit-hmac.js';

/**
 * Parameter key patterns whose values should be redacted before persisting.
 * Matches common secret/PII field names (case-insensitive).
 */
const REDACT_KEY_PATTERNS = [
  /password/i,
  /passwd/i,
  /passphrase/i,
  /\bpwd\b/i,
  /secret/i,
  /api[_-]?key/i,
  /access[_-]?key/i,
  /secret[_-]?key/i,
  /token/i,            // auth_token, access_token, refresh_token, sessionToken, idToken, ...
  /bearer/i,
  /authorization/i,
  /private[_-]?key/i,
  /client[_-]?secret/i,
  /credential/i,
  /connection[_-]?string/i,
  /ssn/i,
  /social[_-]?security/i,
  /credit[_-]?card/i,
  /card[_-]?number/i,
  /cvv/i,
];

/** Depth cap so a maliciously deep params object can't blow the stack. */
const MAX_REDACT_DEPTH = 16;

function keyIsSensitive(key: string, extraKeys: string[]): boolean {
  return REDACT_KEY_PATTERNS.some(re => re.test(key)) || extraKeys.includes(key);
}

function redactValue(value: unknown, extraKeys: string[], depth: number, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_REDACT_DEPTH) return '[TRUNCATED]';
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map(v => redactValue(v, extraKeys, depth + 1, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    // Never copy prototype-polluting keys into the persisted record.
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    out[key] = keyIsSensitive(key, extraKeys)
      ? '[REDACTED]'
      : redactValue(v, extraKeys, depth + 1, seen);
  }
  return out;
}

/**
 * Return a deep copy of params with sensitive values replaced by "[REDACTED]".
 * Recurses through nested objects and arrays (a top-level-only check would leak
 * e.g. `{ headers: { Authorization: "Bearer ..." } }`), caps recursion depth,
 * and drops prototype-polluting keys.
 * @param extraKeys - additional key names to redact (from policy rule `redact` field)
 */
export function redactParams(
  params: Record<string, unknown>,
  extraKeys: string[] = []
): Record<string, unknown> {
  return redactValue(params, extraKeys, 0, new WeakSet()) as Record<string, unknown>;
}

/**
 * M3: Operation Logger
 * Persists all proxy events (operation + decision + optional result) as OperationLog
 * records in the StateStore. Acts as the audit trail for everything AgentsGate
 * intercepts.
 *
 * When constructed with a `signingSecret`, every log entry is HMAC-SHA256 signed
 * before being saved (field: `hmac`).  Verify with `verifyLog()` from audit-hmac.
 *
 * When `redact` is true (default: true), sensitive parameter values are stripped
 * before persisting (e.g. passwords, API keys, tokens).
 */
export class OperationLogger {
  private readonly redact: boolean;

  constructor(
    private readonly store: StateStore,
    private readonly signingSecret?: string,
    options: { redact?: boolean } = {}
  ) {
    this.redact = options.redact ?? true;
  }

  /**
   * Create and persist an OperationLog for an intercepted event.
   * Returns the saved log record (including its generated ID and timestamp).
   */
  async log(
    operation: MCPOperation,
    decision: ProxyDecision,
    executionResult?: ExecutionResult,
    extraRedactKeys: string[] = []
  ): Promise<OperationLog> {
    // Redact sensitive params before persisting
    const safeOperation = this.redact
      ? { ...operation, params: redactParams(operation.params, extraRedactKeys) }
      : operation;

    const entry: OperationLog = {
      operationId: operation.id,
      operation: safeOperation,
      decision,
      executionResult,
      createdAt: new Date(),
    };

    if (!this.signingSecret) {
      await this.store.saveOperationLog(entry);
      return entry;
    }

    // Signing chains each record onto the one before it, so reading the tip and
    // appending must not interleave with another log() call — two writers
    // reading the same tip would fork the chain and every later record would
    // fail verification. Serialised through a promise chain rather than a lock:
    // the whole path is async and single-process.
    const signed = this.appendChained(entry);
    this.chainTail = signed.then(() => undefined, () => undefined);
    return signed;
  }

  /** Serialisation point for chained writes. See log(). */
  private chainTail: Promise<void> = Promise.resolve();

  private async appendChained(entry: OperationLog): Promise<OperationLog> {
    await this.chainTail;
    const prev = (await this.store.getLastLogHmac()) ?? GENESIS_HMAC;
    const signed = stampLog(entry, this.signingSecret!, prev);
    await this.store.saveOperationLog(signed);
    return signed;
  }

  /** Retrieve a single log entry by operation ID. Returns null if not found. */
  async getLog(operationId: string): Promise<OperationLog | null> {
    return this.store.getOperationLog(operationId);
  }

  /** List log entries ordered by most recent first, with pagination. */
  async listLogs(limit = 100, offset = 0): Promise<OperationLog[]> {
    return this.store.listOperationLogs(limit, offset);
  }
}
