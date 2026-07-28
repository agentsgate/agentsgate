/**
 * T140 — Audit trail HMAC signing.
 *
 * Signs OperationLog entries with HMAC-SHA256 using a shared secret stored in
 * `config.audit.signingSecret` (or passed directly).  The canonical message is
 * a deterministic JSON serialisation of the log's stable fields:
 *   { operationId, operation, decision, createdAt }
 *
 * The `executionResult` and `hmac` fields are excluded from the signature so
 * that a result can be added after signing without invalidating it.
 */

import { createHmac } from 'node:crypto';
import type { OperationLog } from '../types/interfaces.js';

/** Fields that enter the HMAC canonical message. */
type SignableFields = Pick<OperationLog, 'operationId' | 'operation' | 'decision' | 'createdAt'>;

function canonical(log: SignableFields): string {
  return JSON.stringify({
    operationId: log.operationId,
    operation:   log.operation,
    decision:    log.decision,
    createdAt:   log.createdAt instanceof Date ? log.createdAt.toISOString() : log.createdAt,
  });
}

/**
 * Compute HMAC-SHA256 over the canonical representation of `log`.
 * Returns the hex digest.
 */
export function signLog(log: SignableFields, secret: string): string {
  return createHmac('sha256', secret).update(canonical(log)).digest('hex');
}

/**
 * Verify that `log.hmac` matches the expected signature for the given secret.
 *
 * Returns `true` when the signature is valid.
 * Returns `false` when the signature is wrong or missing.
 */
export function verifyLog(log: OperationLog, secret: string): boolean {
  if (!log.hmac) return false;
  const expected = signLog(log, secret);
  // Constant-time comparison to prevent timing attacks
  if (expected.length !== log.hmac.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ log.hmac.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Return a copy of `log` with the `hmac` field set.
 */
export function stampLog(log: OperationLog, secret: string): OperationLog {
  return { ...log, hmac: signLog(log, secret) };
}

/**
 * Verify all logs in the array.  Returns the IDs of any logs whose signature
 * is missing or invalid.
 */
export function auditLogs(
  logs: OperationLog[],
  secret: string
): { valid: OperationLog[]; invalid: OperationLog[] } {
  const valid: OperationLog[] = [];
  const invalid: OperationLog[] = [];
  for (const log of logs) {
    (verifyLog(log, secret) ? valid : invalid).push(log);
  }
  return { valid, invalid };
}
