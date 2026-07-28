/**
 * T180 — agentsgate tree: causality tree traversal logic.
 */
import { describe, it, expect } from 'vitest';
import type { MCPOperation, ProxyDecision } from '../src/types/interfaces.js';

type LogEntry = { operation: MCPOperation; decision: ProxyDecision };

function makeOp(id: string, parentId?: string): MCPOperation {
  return { id, agentId: 'a', tool: 'fs', method: 'write', params: {}, timestamp: new Date(), sessionId: 's1', ...(parentId ? { parentId } : {}) };
}
function makeDecision(action: ProxyDecision['action'] = 'allow', riskScore = 0.1): ProxyDecision {
  return { action, riskScore, reasons: [] };
}

/** Mirror of the tree-building logic inside cmdTree — testable without I/O. */
function buildTree(logs: LogEntry[], rootId: string, maxDepth = 10): string[] {
  const byId = new Map(logs.map(l => [l.operation.id, l]));
  const childrenOf = new Map<string, string[]>();
  for (const l of logs) {
    const pid = l.operation.parentId;
    if (pid) {
      if (!childrenOf.has(pid)) childrenOf.set(pid, []);
      childrenOf.get(pid)!.push(l.operation.id);
    }
  }

  const lines: string[] = [];
  const actionIcon = (a: string) => a === 'allow' ? '✓' : a === 'block' ? '✗' : '?';

  function visit(id: string, prefix: string, isLast: boolean, depth: number): void {
    const log = byId.get(id);
    const connector = isLast ? '└─' : '├─';
    if (!log) { lines.push(`${prefix}${connector} [${id.slice(0, 8)}] (not found)`); return; }
    const { operation: op, decision: dec } = log;
    lines.push(`${prefix}${connector} ${actionIcon(dec.action)} [${op.id.slice(0, 8)}] ${op.tool}.${op.method}`);
    if (depth >= maxDepth) return;
    const children = childrenOf.get(id) ?? [];
    const childPrefix = prefix + (isLast ? '   ' : '│  ');
    children.forEach((cid, i) => visit(cid, childPrefix, i === children.length - 1, depth + 1));
  }

  visit(rootId, '', true, 0);
  return lines;
}

describe('agentsgate tree — causality tree logic', () => {
  it('single root with no children renders one line', () => {
    const logs = [{ operation: makeOp('root'), decision: makeDecision() }];
    const lines = buildTree(logs, 'root');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('root');
    expect(lines[0]).toContain('✓');
  });

  it('renders children indented under parent', () => {
    const logs = [
      { operation: makeOp('root'), decision: makeDecision() },
      { operation: makeOp('c1', 'root'), decision: makeDecision('block', 0.9) },
      { operation: makeOp('c2', 'root'), decision: makeDecision() },
    ];
    const lines = buildTree(logs, 'root');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('✗'); // c1 blocked
    expect(lines[1].startsWith('   ')).toBe(true); // indented
  });

  it('renders multi-level chains', () => {
    const logs = [
      { operation: makeOp('L0'), decision: makeDecision() },
      { operation: makeOp('L1', 'L0'), decision: makeDecision() },
      { operation: makeOp('L2', 'L1'), decision: makeDecision() },
    ];
    const lines = buildTree(logs, 'L0');
    expect(lines).toHaveLength(3);
    // L2 should be more indented than L1
    const l1Indent = lines[1].search(/\S/);
    const l2Indent = lines[2].search(/\S/);
    expect(l2Indent).toBeGreaterThan(l1Indent);
  });

  it('maxDepth truncates deep chains', () => {
    const logs = [
      { operation: makeOp('A'), decision: makeDecision() },
      { operation: makeOp('B', 'A'), decision: makeDecision() },
      { operation: makeOp('C', 'B'), decision: makeDecision() },
    ];
    const lines = buildTree(logs, 'A', 1);
    // Depth 0 = root, depth 1 = B; C is at depth 2 so pruned
    expect(lines).toHaveLength(2);
  });

  it('sibling connector uses ├─ for all but last child', () => {
    const logs = [
      { operation: makeOp('root'), decision: makeDecision() },
      { operation: makeOp('c1', 'root'), decision: makeDecision() },
      { operation: makeOp('c2', 'root'), decision: makeDecision() },
    ];
    const lines = buildTree(logs, 'root');
    expect(lines[1]).toContain('├─');
    expect(lines[2]).toContain('└─');
  });

  it('handles missing child gracefully', () => {
    const logs = [{ operation: makeOp('ghost-child', 'root'), decision: makeDecision() }];
    // root itself is not in logs
    const lines = buildTree(logs, 'root');
    expect(lines[0]).toContain('not found');
  });
});
