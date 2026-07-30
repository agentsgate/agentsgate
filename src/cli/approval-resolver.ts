/**
 * The approval gate used by `agentsgate proxy`.
 *
 * The stdio proxy holds a `require_approval` operation until someone answers.
 * The someone is in another process — the dashboard under `agentsgate start`,
 * or `agentsgate approve` talking to it — and the only thing the two share is
 * the SQLite file. So the resolver writes the pending approval there and polls
 * for a verdict to come back.
 *
 * Everything that is not an explicit approval leaves the operation unrun: a
 * denial, a timeout, an unreachable database. The proxy sits synchronously in
 * the request path, and an operation it lets through has happened.
 */
import type { StateStore } from '../modules/m2-store/index.js';
import type { MCPOperation, ProxyDecision } from '../types/interfaces.js';

export interface ApprovalResolverOptions {
  /** The database the dashboard also has open. */
  store: StateStore;
  /**
   * How long to hold the operation before giving up and denying.
   *
   * The MCP client is blocked for this whole time, and its own timeout may well
   * be shorter. Waiting longer than the client does is worse than useless: the
   * client gives up, and an approval arriving afterwards would run the tool
   * with nobody left to receive the result.
   */
  timeoutMs: number;
  /** How often to look for a verdict. */
  pollMs?: number;
  /** Where to tell the operator what is waiting. Defaults to stderr. */
  notify?: (line: string) => void;
}

const DEFAULT_POLL_MS = 500;

export type ApprovalVerdict = 'approved' | 'denied';

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

export function createApprovalResolver(
  options: ApprovalResolverOptions
): (op: MCPOperation, decision: ProxyDecision) => Promise<ApprovalVerdict> {
  const { store, timeoutMs } = options;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const notify = options.notify ?? ((line: string) => process.stderr.write(line + '\n'));

  return async (operation, decision) => {
    try {
      await store.savePendingApproval({
        id: operation.id,
        operation,
        riskScore: decision.riskScore,
        queuedAt: new Date(),
      });
    } catch (err) {
      // Nowhere to queue it means nobody can approve it.
      notify(`[agentsgate] could not queue approval: ${(err as Error).message}`);
      return 'denied';
    }

    notify(
      `[agentsgate] APPROVAL NEEDED  ${operation.tool}.${operation.method}  ` +
      `risk ${(decision.riskScore * 100).toFixed(0)}%  id=${operation.id}`
    );
    notify(
      `[agentsgate]   agentsgate approve ${operation.id}   |   ` +
      `agentsgate deny ${operation.id}   (waiting ${Math.round(timeoutMs / 1000)}s)`
    );

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(pollMs);
      try {
        const record = await store.getPendingApproval(operation.id);
        if (record?.verdict) {
          notify(`[agentsgate] ${record.verdict.toUpperCase()}  id=${operation.id}`);
          return record.verdict;
        }
      } catch (err) {
        notify(`[agentsgate] could not read approval state: ${(err as Error).message}`);
        return 'denied';
      }
    }

    // Settle it ourselves on the way out. Left pending it would sit in the
    // operator's queue as though it still mattered, and an approval arriving
    // later must not be able to release a call that has already been refused.
    try {
      await store.resolvePendingApproval(operation.id, 'denied');
    } catch { /* the denial stands either way */ }
    notify(`[agentsgate] DENIED (timed out after ${Math.round(timeoutMs / 1000)}s)  id=${operation.id}`);
    return 'denied';
  };
}
