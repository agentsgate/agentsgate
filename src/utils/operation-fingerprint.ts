/**
 * A stable identity for "the same operation, asked again".
 *
 * Approving a held call releases that call. Approving an HTTP operation cannot,
 * because the caller has already been answered — so approval instead leaves a
 * one-shot grant that the agent's retry can consume. The retry arrives as a new
 * operation with a new id, so the grant has to key on what the operation *is*
 * rather than which request carried it.
 *
 * Parameter order must not matter: `{a, b}` and `{b, a}` are the same request,
 * and JSON.stringify would disagree.
 */
import { createHash } from 'node:crypto';
import type { MCPOperation } from '../types/interfaces.js';

/** JSON with object keys in sorted order, all the way down. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

/**
 * Identity of an operation for grant matching: who is asking, of what, with
 * which arguments. Deliberately excludes the operation id, the timestamp and
 * the session — a retry differs in all three and is still the same request.
 */
export function operationFingerprint(op: MCPOperation): string {
  return createHash('sha256')
    .update(canonical({
      agentId: op.agentId,
      tool: op.tool,
      method: op.method,
      params: op.params ?? {},
    }))
    .digest('hex');
}
