/**
 * T140 — Audit trail HMAC signing, chained.
 *
 * Signs OperationLog entries with HMAC-SHA256 using a shared secret stored in
 * `config.audit.signingSecret` (or passed directly). The canonical message is a
 * deterministic JSON serialisation of the log's stable fields, together with
 * the signature of the record before it:
 *   { prevHmac, operationId, operation, decision, createdAt }
 *
 * Including `prevHmac` is what makes the log a chain rather than a set of
 * independent stamps. Per-record signatures alone detect a record being
 * *edited*, but not one being *deleted*: an attacker with write access to the
 * database could simply drop the rows describing what they did, and every
 * remaining signature would still verify. With each record committing to its
 * predecessor, removing one breaks the link at that point, and `verifyChain`
 * reports where.
 *
 * The `executionResult` and `hmac` fields are excluded from the signature so
 * that a result can be added after signing without invalidating it.
 */

import { createHmac } from 'node:crypto';
import type { OperationLog } from '../types/interfaces.js';

/** `prevHmac` for the first record in a chain. */
export const GENESIS_HMAC = '';

/** Fields that enter the HMAC canonical message. */
type SignableFields = Pick<OperationLog, 'operationId' | 'operation' | 'decision' | 'createdAt'>;

function canonical(log: SignableFields, prevHmac: string): string {
  return JSON.stringify({
    prevHmac,
    operationId: log.operationId,
    operation:   log.operation,
    decision:    log.decision,
    createdAt:   log.createdAt instanceof Date ? log.createdAt.toISOString() : log.createdAt,
  });
}

/**
 * Compute HMAC-SHA256 over the canonical representation of `log`, bound to the
 * signature of the preceding record. Returns the hex digest.
 */
export function signLog(log: SignableFields, secret: string, prevHmac: string = GENESIS_HMAC): string {
  return createHmac('sha256', secret).update(canonical(log, prevHmac)).digest('hex');
}

/** Return a copy of `log` carrying its signature. */
export function stampLog(log: OperationLog, secret: string, prevHmac: string = GENESIS_HMAC): OperationLog {
  return { ...log, prevHmac, hmac: signLog(log, secret, prevHmac) };
}

/** Constant-time comparison of two hex digests. */
function digestsEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verify one record against the signature of its predecessor.
 *
 * Returns `true` when the signature is valid.
 * Returns `false` when it is wrong or missing.
 */
export function verifyLog(log: OperationLog, secret: string, prevHmac?: string): boolean {
  if (!log.hmac) return false;
  // Default to the predecessor recorded on the entry, so a lone record can be
  // checked without its neighbours.
  const prev = prevHmac ?? log.prevHmac ?? GENESIS_HMAC;
  return digestsEqual(signLog(log, secret, prev), log.hmac);
}

export interface ChainVerification {
  /** Records whose signature matched, in the order given. */
  valid: OperationLog[];
  /** Records whose signature did not match, or which are missing one. */
  invalid: OperationLog[];
  /**
   * Index of the first record that failed, or -1 when the whole chain is
   * intact. Everything from here on is unverifiable: once a link is broken the
   * expected predecessor for the rest of the chain is unknown.
   */
  brokenAt: number;
  /** True when every record verified and the chain is unbroken. */
  intact: boolean;
}

/**
 * Verify a chain of logs given in insertion order, oldest first.
 *
 * Order matters: each record is checked against the signature of the one
 * before it, so passing records newest-first (the order the dashboard and CLI
 * list them in) will not verify. Callers must sort ascending.
 */
export function verifyChain(logs: OperationLog[], secret: string): ChainVerification {
  const valid: OperationLog[] = [];
  const invalid: OperationLog[] = [];
  let prev = GENESIS_HMAC;
  let brokenAt = -1;

  for (let i = 0; i < logs.length; i++) {
    const log = logs[i]!;
    if (brokenAt === -1 && verifyLog(log, secret, prev)) {
      valid.push(log);
      prev = log.hmac!;
      continue;
    }
    // Past the break, the expected predecessor is unknown, so no later record
    // can be attested to either way — they are reported as unverified.
    if (brokenAt === -1) brokenAt = i;
    invalid.push(log);
  }

  return { valid, invalid, brokenAt, intact: brokenAt === -1 && logs.length === valid.length };
}

/**
 * Verify logs as an unordered set, ignoring the chain.
 *
 * Kept for callers that hold an arbitrary subset — a filtered view, a single
 * agent's history — where the predecessor of each record is not available.
 * This detects edits but, by design, not deletions; use `verifyChain` when the
 * full log in insertion order is available.
 */
export function auditLogs(
  logs: OperationLog[],
  secret: string
): { valid: OperationLog[]; invalid: OperationLog[] } {
  const valid: OperationLog[] = [];
  const invalid: OperationLog[] = [];
  for (const log of logs) {
    // Each record carries the predecessor it was signed against, so order and
    // completeness of the input do not matter here.
    (verifyLog(log, secret) ? valid : invalid).push(log);
  }
  return { valid, invalid };
}
