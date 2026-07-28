import fs from 'node:fs/promises';
import { StateStore } from '../modules/m2-store/index.js';
import { RiskScoringEngine } from '../modules/m6-risk/index.js';
import { InterventionController } from '../modules/m7-intervention/index.js';
import { loadConfig } from '../config.js';
import { loadPolicy } from '../policy.js';
import { DB_FILE, parseFlag, hasFlag, resolveDbPath, readState, dashFetch } from './shared.js';

export async function cmdTree(args: string[]): Promise<void> {
  const rootId = args[0];
  if (!rootId) { console.error('Usage: agentsgate tree <operationId>'); process.exit(1); }
  const maxDepth = parseInt(parseFlag(args, 'depth') ?? '10', 10);

  const store = new StateStore(DB_FILE);
  await store.initialize();

  // Load all logs into a map for efficient child lookup
  const allLogs = await store.listOperationLogs(5000, 0);
  await store.close();

  const byId = new Map(allLogs.map(l => [l.operation.id, l]));
  const childrenOf = new Map<string, string[]>();
  for (const l of allLogs) {
    const pid = l.operation.parentId;
    if (pid) {
      if (!childrenOf.has(pid)) childrenOf.set(pid, []);
      childrenOf.get(pid)!.push(l.operation.id);
    }
  }

  const root = byId.get(rootId);
  if (!root) { console.error(`Operation "${rootId}" not found.`); process.exit(1); }

  const actionIcon = (a: string) => a === 'allow' ? '✓' : a === 'block' ? '✗' : '?';

  function printNode(id: string, prefix: string, isLast: boolean, depth: number): void {
    const log = byId.get(id);
    if (!log) { console.log(`${prefix}${isLast ? '└─' : '├─'} [${id.slice(0, 8)}] (not found)`); return; }
    const op = log.operation;
    const dec = log.decision;
    const connector = isLast ? '└─' : '├─';
    console.log(`${prefix}${connector} ${actionIcon(dec.action)} [${op.id.slice(0, 8)}] ${op.tool}.${op.method}  risk:${(dec.riskScore * 100).toFixed(0)}%  agent:${op.agentId}`);
    if (depth >= maxDepth) return;
    const children = childrenOf.get(id) ?? [];
    const childPrefix = prefix + (isLast ? '   ' : '│  ');
    children.forEach((cid, i) => printNode(cid, childPrefix, i === children.length - 1, depth + 1));
  }

  console.log(`\nOperation tree rooted at ${rootId.slice(0, 8)}\n`);
  printNode(rootId, '', true, 0);
  console.log('');
}

export async function cmdExplain(args: string[]): Promise<void> {
  const operationId = args[0];
  if (!operationId) { console.error('Usage: agentsgate explain <operationId>'); process.exit(1); }

  const store = new StateStore(DB_FILE);
  await store.initialize();
  const log = await store.getOperationLog(operationId);
  await store.close();

  if (!log) { console.error(`Operation "${operationId}" not found.`); process.exit(1); }

  const op  = log.operation;
  const dec = log.decision;

  console.log(`\nOperation Explanation — ${operationId}\n`);
  console.log(`  Agent:     ${op.agentId}`);
  console.log(`  Tool:      ${op.tool} · ${op.method}`);
  console.log(`  Session:   ${op.sessionId}`);
  console.log(`  Timestamp: ${op.timestamp instanceof Date ? op.timestamp.toISOString() : op.timestamp}`);
  console.log(`\nDecision: ${dec.action.toUpperCase()} (risk ${(dec.riskScore * 100).toFixed(1)}%)`);
  if (dec.dryRun) console.log(`  [DRY-RUN mode — operation was forwarded regardless of decision]`);

  if (dec.firedRules && dec.firedRules.length > 0) {
    console.log(`\nFired Risk Rules:`);
    for (const r of dec.firedRules) {
      const bar = '█'.repeat(Math.round(r.score * 20)).padEnd(20, '░');
      console.log(`  [${r.layer}] ${r.id.padEnd(32)} ${bar} ${(r.score * 100).toFixed(0)}%`);
      if (r.description) console.log(`           ${r.description}`);
    }
  }

  if (dec.reasons.length > 0) {
    console.log(`\nReasons:`);
    for (const reason of dec.reasons) console.log(`  • ${reason}`);
  }

  console.log(`\nParams:`);
  if (Object.keys(op.params).length === 0) {
    console.log('  (none)');
  } else {
    for (const [k, v] of Object.entries(op.params)) {
      console.log(`  ${k}: ${JSON.stringify(v)}`);
    }
  }
  console.log('');
}

export async function cmdReport(args: string[]): Promise<void> {
  const outputFlag = parseFlag(args, 'output');
  const formatFlag = parseFlag(args, 'format') ?? 'markdown'; // T417: --format=json|markdown
  const limitStr   = args.find(a => /^\d+$/.test(a));
  const limit      = limitStr ? parseInt(limitStr, 10) : 1000;
  const team       = parseFlag(args, 'team');
  const dbPath     = resolveDbPath(team);

  const store = new StateStore(dbPath);
  await store.initialize();
  const logs = await store.listOperationLogs(limit, 0);
  await store.close();

  const now = new Date();
  const generatedAt = now.toISOString();

  // Aggregate stats
  const totalOps = logs.length;
  const byAction: Record<string, number> = { allow: 0, block: 0, require_approval: 0 };
  const byTool: Record<string, number> = {};
  const byAgent: Record<string, number> = {};
  let riskSum = 0;
  const riskBuckets: Record<string, number> = {
    '0.0-0.2': 0, '0.2-0.4': 0, '0.4-0.6': 0, '0.6-0.8': 0, '0.8-1.0': 0,
  };

  for (const l of logs) {
    const action = l.decision.action;
    byAction[action] = (byAction[action] ?? 0) + 1;
    byTool[l.operation.tool] = (byTool[l.operation.tool] ?? 0) + 1;
    byAgent[l.operation.agentId] = (byAgent[l.operation.agentId] ?? 0) + 1;
    const rs = l.decision.riskScore;
    riskSum += rs;
    const bucket = rs < 0.2 ? '0.0-0.2' : rs < 0.4 ? '0.2-0.4' : rs < 0.6 ? '0.4-0.6' : rs < 0.8 ? '0.6-0.8' : '0.8-1.0';
    riskBuckets[bucket] = (riskBuckets[bucket] ?? 0) + 1;
  }
  const avgRisk = totalOps > 0 ? riskSum / totalOps : 0;
  const blockRate = totalOps > 0 ? ((byAction.block ?? 0) / totalOps) * 100 : 0;

  const topTools = Object.entries(byTool).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const topAgents = Object.entries(byAgent).sort((a, b) => b[1] - a[1]).slice(0, 10);

  // Oldest / newest op timestamps
  let windowStart = '';
  let windowEnd = '';
  if (logs.length > 0) {
    const times = logs.map(l => new Date(l.createdAt).getTime());
    windowStart = new Date(Math.min(...times)).toISOString();
    windowEnd   = new Date(Math.max(...times)).toISOString();
  }

  const lines: string[] = [
    `# AgentsGate Compliance Report`,
    ``,
    `**Generated:** ${generatedAt}`,
    `**Operation window:** ${windowStart || 'N/A'} — ${windowEnd || 'N/A'}`,
    `**Operations sampled:** ${totalOps}`,
    ``,
    `---`,
    ``,
    `## Summary`,
    ``,
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Total operations | ${totalOps} |`,
    `| Allowed | ${byAction.allow ?? 0} (${totalOps > 0 ? (((byAction.allow ?? 0) / totalOps) * 100).toFixed(1) : 0}%) |`,
    `| Blocked | ${byAction.block ?? 0} (${blockRate.toFixed(1)}%) |`,
    `| Require approval | ${byAction.require_approval ?? 0} (${totalOps > 0 ? (((byAction.require_approval ?? 0) / totalOps) * 100).toFixed(1) : 0}%) |`,
    `| Average risk score | ${avgRisk.toFixed(3)} |`,
    ``,
    `---`,
    ``,
    `## Risk Score Distribution`,
    ``,
    `| Bucket | Count | Bar |`,
    `|--------|-------|-----|`,
    ...Object.entries(riskBuckets).map(([bucket, count]) => {
      const bar = count > 0 ? '█'.repeat(Math.min(40, Math.round((count / totalOps) * 40))) : '';
      return `| ${bucket} | ${count} | ${bar} |`;
    }),
    ``,
    `---`,
    ``,
    `## Top Tools by Operation Count`,
    ``,
    `| Tool | Operations |`,
    `|------|-----------|`,
    ...topTools.map(([tool, count]) => `| ${tool} | ${count} |`),
    ``,
    `---`,
    ``,
    `## Top Agents by Operation Count`,
    ``,
    `| Agent ID | Operations |`,
    `|----------|-----------|`,
    ...topAgents.map(([agent, count]) => `| ${agent} | ${count} |`),
    ``,
    `---`,
    ``,
    `## Recent Blocked Operations`,
    ``,
  ];

  const blocked = logs.filter(l => l.decision.action === 'block').slice(0, 20);
  if (blocked.length === 0) {
    lines.push(`*No blocked operations in this sample.*`);
  } else {
    lines.push(`| Time | Agent | Tool | Reason |`);
    lines.push(`|------|-------|------|--------|`);
    for (const l of blocked) {
      const t = new Date(l.createdAt).toISOString();
      const reason = l.decision.reasons[0] ?? '';
      lines.push(`| ${t} | ${l.operation.agentId} | ${l.operation.tool} | ${reason} |`);
    }
  }

  lines.push(``, `---`, ``, `*Report generated by AgentsGate CLI.*`, ``);

  // T417: --format=json outputs a structured JSON compliance report
  if (formatFlag === 'json') {
    const cfg = await loadConfig();
    let hmacVerified: null | { valid: number; invalid: number; unsigned: number } = null;
    const signingSecret = cfg?.audit?.signingSecret;
    if (signingSecret) {
      const { auditLogs } = await import('../utils/audit-hmac.js');
      const { valid, invalid } = auditLogs(logs, signingSecret);
      const unsigned = logs.filter(l => !(l as unknown as Record<string, unknown>)['hmac']).length;
      hmacVerified = { valid: valid.length, invalid: invalid.length, unsigned };
    }
    const jsonReport = {
      generatedAt,
      windowStart: windowStart || null,
      windowEnd: windowEnd || null,
      operationsSampled: totalOps,
      byAction: { allow: byAction.allow ?? 0, block: byAction.block ?? 0, require_approval: byAction.require_approval ?? 0 },
      blockRate: parseFloat(blockRate.toFixed(4)),
      avgRiskScore: parseFloat(avgRisk.toFixed(4)),
      riskDistribution: riskBuckets,
      topTools,
      topAgents,
      hmacVerified,
    };
    const out = JSON.stringify(jsonReport, null, 2);
    if (outputFlag) {
      await fs.writeFile(outputFlag, out, 'utf-8');
      console.log(`JSON report written to ${outputFlag}`);
    } else {
      console.log(out);
    }
    return;
  }

  const report = lines.join('\n');

  if (outputFlag) {
    await fs.writeFile(outputFlag, report, 'utf-8');
    console.log(`Report written to ${outputFlag}`);
  } else {
    console.log(report);
  }
}

export async function cmdAudit(args: string[]): Promise<void> {
  const fromStr  = parseFlag(args, 'from');
  const toStr    = parseFlag(args, 'to');
  const agentId  = parseFlag(args, 'agentId');
  const action   = parseFlag(args, 'action');
  const limitStr = args.find(a => /^\d+$/.test(a));
  const limit    = limitStr ? parseInt(limitStr, 10) : 200;
  const diff     = hasFlag(args, 'diff');
  const verify   = hasFlag(args, 'verify');
  const stats    = hasFlag(args, 'stats');
  const team     = parseFlag(args, 'team');
  const dbPath   = resolveDbPath(team);

  // --stats: fetch live audit verification summary from running dashboard
  if (stats) {
    const state = await readState();
    if (!state) { console.error('AgentsGate is not running (use --verify for offline check).'); process.exit(1); }
    const { body, status } = await dashFetch(state.dashboardPort, 'GET', `/audit/verify?limit=${limit}`);
    if (status === 503) {
      console.error('Audit signing is not configured on the running server.');
      process.exit(1);
    }
    const r = body as { checked: number; valid: number; invalid: number; unsigned: number };
    console.log('\n─────────────────────────────────────────────────────────');
    console.log('  AgentsGate Audit Verification Summary');
    console.log('─────────────────────────────────────────────────────────');
    console.log(`  Checked  : ${r.checked}`);
    console.log(`  Valid    : ${r.valid}`);
    console.log(`  Invalid  : ${r.invalid}${r.invalid > 0 ? '  ← TAMPERED OR CORRUPTED' : ''}`);
    console.log(`  Unsigned : ${r.unsigned}`);
    console.log('─────────────────────────────────────────────────────────\n');
    if (r.invalid > 0) process.exit(1);
    return;
  }

  const fromDate = fromStr ? new Date(fromStr) : undefined;
  const toDate   = toStr   ? new Date(toStr)   : undefined;

  const store = new StateStore(dbPath);
  await store.initialize();

  const filter: import('../modules/m2-store/index.js').OperationFilter = {};
  if (action === 'allow' || action === 'block' || action === 'require_approval') filter.action = action;
  if (agentId) filter.agentId = agentId;

  const logs = await store.listOperationLogs(limit, 0, Object.keys(filter).length ? filter : undefined);
  await store.close();

  // Filter by time window
  const inWindow = logs.filter(l => {
    const t = new Date(l.createdAt).getTime();
    if (fromDate && t < fromDate.getTime()) return false;
    if (toDate   && t > toDate.getTime())   return false;
    return true;
  });

  if (inWindow.length === 0) {
    console.log('No operations found in the specified window.');
    return;
  }

  // Summary stats
  const total   = inWindow.length;
  const blocked = inWindow.filter(l => l.decision.action === 'block').length;
  const pending = inWindow.filter(l => l.decision.action === 'require_approval').length;
  const avgRisk = inWindow.reduce((s, l) => s + l.decision.riskScore, 0) / total;
  const uniqueAgents = new Set(inWindow.map(l => l.operation.agentId)).size;

  console.log('\n─────────────────────────────────────────────────────────');
  console.log('  AgentsGate Audit Report');
  if (fromDate || toDate) {
    console.log(`  Window: ${fromDate?.toISOString() ?? 'beginning'} → ${toDate?.toISOString() ?? 'now'}`);
  }
  console.log('─────────────────────────────────────────────────────────');
  console.log(`  Total operations : ${total}`);
  console.log(`  Blocked          : ${blocked} (${((blocked / total) * 100).toFixed(1)}%)`);
  console.log(`  Require approval : ${pending}`);
  console.log(`  Avg risk score   : ${avgRisk.toFixed(3)}`);
  console.log(`  Unique agents    : ${uniqueAgents}`);
  console.log('─────────────────────────────────────────────────────────\n');

  // Per-agent breakdown
  const byAgent = new Map<string, { total: number; blocked: number; avgRisk: number }>();
  for (const l of inWindow) {
    const a = l.operation.agentId;
    const prev = byAgent.get(a) ?? { total: 0, blocked: 0, avgRisk: 0 };
    byAgent.set(a, {
      total: prev.total + 1,
      blocked: prev.blocked + (l.decision.action === 'block' ? 1 : 0),
      avgRisk: prev.avgRisk + l.decision.riskScore,
    });
  }
  console.log('  Per-agent breakdown:');
  for (const [agent, stats] of byAgent) {
    const ar = (stats.avgRisk / stats.total).toFixed(3);
    console.log(`    ${agent.padEnd(24)} ops=${stats.total} blocked=${stats.blocked} avg-risk=${ar}`);
  }

  if (diff) {
    // Show operations that changed risk tier between first and last half of window
    const mid = Math.floor(inWindow.length / 2);
    const firstHalf  = inWindow.slice(0, mid);
    const secondHalf = inWindow.slice(mid);
    const avg1 = firstHalf.reduce((s, l)  => s + l.decision.riskScore, 0) / (firstHalf.length  || 1);
    const avg2 = secondHalf.reduce((s, l) => s + l.decision.riskScore, 0) / (secondHalf.length || 1);
    const delta = avg2 - avg1;
    const trend = delta > 0.05 ? '↑ increasing' : delta < -0.05 ? '↓ decreasing' : '→ stable';
    console.log(`\n  Risk trend (first half vs second half): ${trend} (Δ ${delta >= 0 ? '+' : ''}${delta.toFixed(3)})`);

    // List high-risk ops (top 5 by riskScore)
    const top5 = [...inWindow].sort((a, b) => b.decision.riskScore - a.decision.riskScore).slice(0, 5);
    console.log('\n  Top-5 highest-risk operations:');
    for (const l of top5) {
      const firedIds = (l.decision.firedRules ?? []).map(r => r.id).join(', ') || '—';
      console.log(`    [${l.decision.riskScore.toFixed(2)}] ${l.operation.agentId} / ${l.operation.method}  rules: ${firedIds}`);
    }
  }

  // ── HMAC verification ────────────────────────────────────────────────────
  if (verify) {
    const { auditLogs } = await import('../utils/audit-hmac.js');
    const config = await loadConfig(parseFlag(args, 'config'));
    const secret = config.audit?.signingSecret;
    if (!secret) {
      console.log('\n  HMAC verification skipped — no audit.signingSecret in config.\n');
    } else {
      const { valid, invalid } = auditLogs(inWindow, secret);
      console.log(`\n  HMAC verification (secret configured):`);
      console.log(`    Valid   : ${valid.length}`);
      console.log(`    Invalid : ${invalid.length}${invalid.length > 0 ? '  ← TAMPERED OR PRE-SIGNING' : ''}`);
      if (invalid.length > 0) {
        for (const l of invalid) {
          console.log(`      ✗ ${l.operationId}  ${l.operation.agentId} / ${l.operation.method}  hmac=${l.hmac ?? '(none)'}`);
        }
        process.exit(1);
      }
    }
  }

  console.log('');
}

/**
 * `agentsgate replay [N] [options]`
 *
 * Re-evaluates the last N stored operations against the current (or a
 * specified) policy and risk scoring engine.  Useful for checking what
 * decisions would change if you updated the policy or thresholds.
 *
 * Options:
 *   --policy=<path>     path to policy file (default: ~/.agentsgate/policy.json)
 *   --config=<path>     path to config file
 *   --agentId=<id>      filter by agent
 *   --dry-run           print diff table; do NOT update the DB
 *   --output=<file>     write JSON results to file
 */
export async function cmdReplay(args: string[]): Promise<void> {
  const policyPath = parseFlag(args, 'policy');
  const configPath = parseFlag(args, 'config');
  const agentId    = parseFlag(args, 'agentId');
  const output     = parseFlag(args, 'output');
  const dryRun     = hasFlag(args, 'dry-run') || !output; // default dry-run
  const limitStr   = args.find(a => /^\d+$/.test(a));
  const limit      = limitStr ? parseInt(limitStr, 10) : 100;

  const config = await loadConfig(configPath);
  const policy = await loadPolicy(policyPath);

  const store = new StateStore(DB_FILE);
  await store.initialize();

  const filter: import('../modules/m2-store/index.js').OperationFilter = {};
  if (agentId) filter.agentId = agentId;

  const logs = await store.listOperationLogs(limit, 0, Object.keys(filter).length ? filter : undefined);
  await store.close();

  if (logs.length === 0) {
    console.log('No operation logs found to replay.');
    return;
  }

  // Build a lightweight risk engine (L1 static only, no DB for speed)
  const riskEngine         = new RiskScoringEngine();
  const interventionCtrl   = new InterventionController({
    allowBelow: config.intervention?.allowBelow ?? 0.3,
    blockAtOrAbove: config.intervention?.blockAtOrAbove ?? 0.7,
  });
  const { evaluatePolicyScore: eps, evaluatePolicyAction: epa } = await import('../policy.js');

  interface ReplayResult {
    operationId: string;
    agentId: string;
    tool: string;
    method: string;
    timestamp: string;
    original: string;
    replayed: string;
    changed: boolean;
    originalRisk: number;
    replayedRisk: number;
  }

  const results: ReplayResult[] = [];
  let changed = 0;

  for (const log of logs) {
    const op = log.operation;
    const assessment = await riskEngine.assess(op);

    // Blend policy score
    let finalScore = assessment.finalScore;
    if (policy.rules.length > 0) {
      const policyScore = eps(policy, op);
      if (policyScore !== null && policyScore >= 0) {
        finalScore = Math.max(finalScore, policyScore);
      }
    }

    // Determine decision
    let replayedAction = (await interventionCtrl.decide({ ...assessment, finalScore })).action;
    if (policy.rules.length > 0) {
      const policyAction = epa(policy, op);
      if (policyAction) replayedAction = policyAction;
    }

    const original  = log.decision.action;
    const isChanged = original !== replayedAction;
    if (isChanged) changed++;

    results.push({
      operationId: log.operationId,
      agentId: op.agentId,
      tool: op.tool,
      method: op.method,
      timestamp: log.createdAt.toISOString(),
      original,
      replayed: replayedAction,
      changed: isChanged,
      originalRisk: log.decision.riskScore,
      replayedRisk: finalScore,
    });
  }

  if (output) {
    await fs.writeFile(output, JSON.stringify(results, null, 2), 'utf-8');
    console.log(`Wrote ${results.length} replay results to ${output}`);
  }

  // Always print a summary table
  console.log('\n─────────────────────────────────────────────────────────────────');
  console.log('  AgentsGate Replay — re-evaluating with current policy');
  console.log('─────────────────────────────────────────────────────────────────');
  console.log(`  Replayed : ${results.length} operations`);
  console.log(`  Changed  : ${changed} decision(s) would differ`);
  console.log(`  Same     : ${results.length - changed} decision(s) unchanged`);
  console.log('─────────────────────────────────────────────────────────────────');

  if (changed > 0) {
    console.log('\n  Changed decisions:');
    const changedRows = results.filter(r => r.changed);
    for (const r of changedRows) {
      const riskDelta = r.replayedRisk - r.originalRisk;
      const deltaStr  = `${riskDelta >= 0 ? '+' : ''}${riskDelta.toFixed(3)}`;
      console.log(
        `    [${r.original.padEnd(16)} → ${r.replayed.padEnd(16)}] ` +
        `${r.agentId}/${r.method}  risk Δ ${deltaStr}  (${r.operationId.slice(0, 8)}…)`
      );
    }
  }
  console.log('');

  if (dryRun) {
    console.log('  (Dry run — database not modified)');
  }
}
