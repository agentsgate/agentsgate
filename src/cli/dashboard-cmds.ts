import { createPipeline } from '../modules/m1-proxy/index.js';
import { StateStore } from '../modules/m2-store/index.js';
import { RiskScoringEngine } from '../modules/m6-risk/index.js';
import { InterventionController } from '../modules/m7-intervention/index.js';
import { loadConfig } from '../config.js';
import { DB_FILE, parseFlag, readState, dashFetch } from './shared.js';

export async function cmdHealth(_args: string[]): Promise<void> {
  const state = await readState();
  if (!state) { console.error('AgentsGate is not running.'); process.exit(1); }
  const { status, body } = await dashFetch(state.dashboardPort, 'GET', '/health');
  if (status !== 200) { console.error(`Dashboard returned ${status}`); process.exit(1); }
  type Health = {
    status: string; version: string; uptimeMs: number; startedAt: string;
    opCount: number; pendingApprovals: number; circuitBreakersOpen?: number;
    db: { operationLogs: number; checkpoints: number; pendingApprovals: number; outcomeRecords: number };
  };
  const h = body as Health;
  const uptimeSec = Math.round(h.uptimeMs / 1000);
  console.log(`AgentsGate ${h.status.toUpperCase()} — v${h.version}`);
  console.log('─'.repeat(40));
  console.log(`  Uptime:          ${uptimeSec}s (since ${h.startedAt})`);
  console.log(`  Operations:      ${h.opCount}`);
  console.log(`  Pending approvals: ${h.pendingApprovals}`);
  if (h.circuitBreakersOpen !== undefined) {
    console.log(`  Open circuits:   ${h.circuitBreakersOpen}`);
  }
  console.log(`\nDB row counts:`);
  console.log(`  operation_logs:  ${h.db.operationLogs}`);
  console.log(`  checkpoints:     ${h.db.checkpoints}`);
  console.log(`  pending_approvals: ${h.db.pendingApprovals}`);
}

export async function cmdQuota(_args: string[]): Promise<void> {
  const state = await readState();
  if (!state) { console.error('AgentsGate is not running.'); process.exit(1); }
  const { status, body } = await dashFetch(state.dashboardPort, 'GET', '/quota');
  if (status === 503) {
    console.error('Quota manager is not configured on the running server.');
    process.exit(1);
  }
  if (status !== 200) { console.error(`Dashboard returned ${status}`); process.exit(1); }
  const r = body as { quotas: Array<{ agentId: string; used: number; quota?: number; remaining?: number; percentUsed?: number }>; count: number };
  if (r.count === 0) {
    console.log('No agent quota data recorded yet.');
    return;
  }
  console.log(`\nAgent Quota Usage (${r.count} agents):\n`);
  console.log('  AGENT'.padEnd(30) + 'USED'.padEnd(8) + 'QUOTA'.padEnd(8) + 'REMAINING'.padEnd(12) + 'USED%');
  console.log('  ' + '─'.repeat(60));
  for (const q of r.quotas) {
    const quota = q.quota !== undefined ? String(q.quota) : '∞';
    const remaining = q.remaining !== undefined ? String(q.remaining) : '—';
    const pct = q.percentUsed !== undefined ? q.percentUsed.toFixed(1) + '%' : '—';
    console.log(`  ${q.agentId.padEnd(28)} ${String(q.used).padEnd(8)}${quota.padEnd(8)}${remaining.padEnd(12)}${pct}`);
  }
  console.log('');
}

export async function cmdCheckpointsCli(args: string[]): Promise<void> {
  const state = await readState();
  if (!state) { console.error('AgentsGate is not running.'); process.exit(1); }
  const limitStr = args.find(a => /^\d+$/.test(a)) ?? '10';
  const opId = parseFlag(args, 'operationId');
  const params = new URLSearchParams({ limit: limitStr });
  if (opId) params.set('operationId', opId);
  const { status, body } = await dashFetch(state.dashboardPort, 'GET', `/checkpoints?${params}`);
  if (status !== 200) { console.error(`Dashboard returned ${status}`); process.exit(1); }
  const r = body as { data: Array<{ id: string; operationId: string; createdAt: string }>; count: number; total: number };
  if (r.count === 0) { console.log('No checkpoints found.'); return; }
  console.log(`\nCheckpoints (${r.count} of ${r.total} total):\n`);
  console.log('  CHECKPOINT ID'.padEnd(40) + 'OPERATION ID'.padEnd(40) + 'CREATED AT');
  console.log('  ' + '─'.repeat(90));
  for (const cp of r.data) {
    const ts = new Date(cp.createdAt).toLocaleString();
    console.log(`  ${cp.id.slice(0, 38).padEnd(40)}${cp.operationId.slice(0, 38).padEnd(40)}${ts}`);
  }
}

export async function cmdRisk(args: string[]): Promise<void> {
  const state = await readState();
  if (!state) { console.error('AgentsGate is not running.'); process.exit(1); }
  const limit   = parseFlag(args, 'limit') ?? '20';
  const offset  = parseFlag(args, 'offset'); // T363
  // T307: --agent and --tool filters for risk list; T368: --session filter; T413: --method
  const agent   = parseFlag(args, 'agent');
  const tool    = parseFlag(args, 'tool');
  const session = parseFlag(args, 'session'); // T368
  const method  = parseFlag(args, 'method');  // T413
  // T323: --min-risk and --max-risk filters
  const minRisk = parseFlag(args, 'min-risk');
  const maxRisk = parseFlag(args, 'max-risk');
  // T328: --sort and --order for risk list
  const riskSort  = parseFlag(args, 'sort');
  const riskOrder = parseFlag(args, 'order');
  const riskParams = new URLSearchParams({ limit });
  if (offset)    riskParams.set('offset', offset); // T363
  if (agent)     riskParams.set('agentId', agent);
  if (tool)      riskParams.set('tool', tool);
  if (session)   riskParams.set('sessionId', session); // T368
  if (method)    riskParams.set('method', method);     // T413
  if (minRisk)   riskParams.set('minRisk', minRisk);
  if (maxRisk)   riskParams.set('maxRisk', maxRisk);
  if (riskSort)  riskParams.set('sort', riskSort);
  if (riskOrder) riskParams.set('order', riskOrder);
  const { status, body } = await dashFetch(state.dashboardPort, 'GET', `/risk?${riskParams}`);
  if (status !== 200) { console.error(`Dashboard returned ${status}`); process.exit(1); }
  type RiskRow = { operationId: string; agentId: string; tool: string; method: string; riskScore: number; action: string };
  const r = body as { data: RiskRow[]; count: number };
  if (r.data.length === 0) { console.log('No operations found.'); return; }
  console.log('RISK  ACTION           AGENT                   TOOL.METHOD');
  console.log('─'.repeat(80));
  for (const row of r.data) {
    const risk = `${(row.riskScore * 100).toFixed(0)}%`.padEnd(6);
    const act = row.action.padEnd(17);
    const ag = row.agentId.slice(0, 22).padEnd(23);
    console.log(`${risk}${act}${ag}${row.tool}.${row.method}`);
  }
  console.log(`\n${r.data.length} operations shown.`);
}

export async function cmdTelemetry(args: string[] = []): Promise<void> {
  const state = await readState();
  if (!state) { console.error('AgentsGate is not running.'); process.exit(1); }

  const sub = args[0];

  // T280/T299: agentsgate telemetry agents [agentId] — per-agent telemetry table or single-agent detail
  if (sub === 'agents') {
    const agentName = args[1]; // T299: optional agentId for single-agent detail
    if (agentName) {
      const { status, body } = await dashFetch(state.dashboardPort, 'GET', `/telemetry/agents/${encodeURIComponent(agentName)}`);
      if (status === 404) { console.error(`Agent not found: ${agentName}`); process.exit(1); }
      if (status !== 200) { console.error(`Dashboard returned ${status}`); process.exit(1); }
      const a = body as { agentId: string; totalOps: number; blockRate: number; avgRisk: number };
      console.log(`Agent Telemetry: ${a.agentId}`);
      console.log(`  Total ops:  ${a.totalOps}`);
      console.log(`  Block rate: ${(a.blockRate * 100).toFixed(1)}%`);
      console.log(`  Avg risk:   ${(a.avgRisk * 100).toFixed(1)}%`);
      return;
    }
    // T348: --limit/--offset; T351: --sort/--order
    const telAgentLimit  = parseFlag(args, 'limit');
    const telAgentOffset = parseFlag(args, 'offset');
    const telAgentSort   = parseFlag(args, 'sort');
    const telAgentOrder  = parseFlag(args, 'order');
    const telAgentParams = new URLSearchParams();
    if (telAgentLimit)  telAgentParams.set('limit', telAgentLimit);
    if (telAgentOffset) telAgentParams.set('offset', telAgentOffset);
    if (telAgentSort)   telAgentParams.set('sort', telAgentSort);
    if (telAgentOrder)  telAgentParams.set('order', telAgentOrder);
    const telAgentUrl = `/telemetry/agents${telAgentParams.toString() ? `?${telAgentParams}` : ''}`;
    const { status, body } = await dashFetch(state.dashboardPort, 'GET', telAgentUrl);
    if (status !== 200) { console.error(`Dashboard returned ${status}`); process.exit(1); }
    const b = body as { agents: Array<{ agentId: string; totalOps: number; blockRate: number; avgRisk: number }>; count: number };
    if (b.count === 0) { console.log('No agent telemetry data.'); return; }
    console.log(`Agent Telemetry (${b.count}):\n`);
    console.log('AGENT'.padEnd(28) + 'OPS'.padEnd(8) + 'BLOCK RATE   AVG RISK');
    console.log('─'.repeat(72));
    for (const a of b.agents) {
      console.log(
        `${a.agentId.slice(0,26).padEnd(28)}${String(a.totalOps).padEnd(8)}${(a.blockRate * 100).toFixed(1).padEnd(13)}${(a.avgRisk * 100).toFixed(1)}%`
      );
    }
    return;
  }

  // T281/T292: agentsgate telemetry tools [tool] — per-tool telemetry table or single-tool detail
  if (sub === 'tools') {
    const toolName = args[1]; // T292: optional tool name for single-tool detail
    if (toolName) {
      const { status, body } = await dashFetch(state.dashboardPort, 'GET', `/telemetry/tools/${encodeURIComponent(toolName)}`);
      if (status === 404) { console.error(`Tool not found: ${toolName}`); process.exit(1); }
      if (status !== 200) { console.error(`Dashboard returned ${status}`); process.exit(1); }
      const t = body as { tool: string; totalOps: number; blockRate: number; avgRisk: number };
      console.log(`Tool Telemetry: ${t.tool}`);
      console.log(`  Total ops:  ${t.totalOps}`);
      console.log(`  Block rate: ${(t.blockRate * 100).toFixed(1)}%`);
      console.log(`  Avg risk:   ${(t.avgRisk * 100).toFixed(1)}%`);
      return;
    }
    // T348: --limit/--offset; T352: --sort/--order
    const telToolLimit  = parseFlag(args, 'limit');
    const telToolOffset = parseFlag(args, 'offset');
    const telToolSort   = parseFlag(args, 'sort');
    const telToolOrder  = parseFlag(args, 'order');
    const telToolParams = new URLSearchParams();
    if (telToolLimit)  telToolParams.set('limit', telToolLimit);
    if (telToolOffset) telToolParams.set('offset', telToolOffset);
    if (telToolSort)   telToolParams.set('sort', telToolSort);
    if (telToolOrder)  telToolParams.set('order', telToolOrder);
    const telToolUrl = `/telemetry/tools${telToolParams.toString() ? `?${telToolParams}` : ''}`;
    const { status, body } = await dashFetch(state.dashboardPort, 'GET', telToolUrl);
    if (status !== 200) { console.error(`Dashboard returned ${status}`); process.exit(1); }
    const b = body as { tools: Array<{ tool: string; totalOps: number; blockRate: number; avgRisk: number }>; count: number };
    if (b.count === 0) { console.log('No tool telemetry data.'); return; }
    console.log(`Tool Telemetry (${b.count}):\n`);
    console.log('TOOL'.padEnd(28) + 'OPS'.padEnd(8) + 'BLOCK RATE   AVG RISK');
    console.log('─'.repeat(72));
    for (const t of b.tools) {
      console.log(
        `${t.tool.slice(0,26).padEnd(28)}${String(t.totalOps).padEnd(8)}${(t.blockRate * 100).toFixed(1).padEnd(13)}${(t.avgRisk * 100).toFixed(1)}%`
      );
    }
    return;
  }

  // T438: agentsgate telemetry export --otlp=<url>
  if (sub === 'export') {
    const otlpUrl = parseFlag(args, 'otlp');
    if (!otlpUrl) {
      console.error('Usage: agentsgate telemetry export --otlp=<url>');
      console.error('Example: agentsgate telemetry export --otlp=http://localhost:4318/v1/metrics');
      process.exit(1);
    }
    const { status, body } = await dashFetch(
      state.dashboardPort, 'POST', '/telemetry/export-otlp',
      { endpoint: otlpUrl }
    );
    if (status === 503) { console.error('Telemetry service is not running.'); process.exit(1); }
    if (status !== 200) { console.error(`Export failed (HTTP ${status}): ${JSON.stringify(body)}`); process.exit(1); }
    const r = body as { ok: boolean; statusCode?: number; error?: string };
    if (r.ok) {
      console.log(`✓ OTLP metrics exported to ${otlpUrl}`);
      if (r.statusCode) console.log(`  Collector responded: HTTP ${r.statusCode}`);
    } else {
      console.error(`✗ OTLP export failed: ${r.error ?? 'unknown error'}`);
      process.exit(1);
    }
    return;
  }

  const { status, body } = await dashFetch(state.dashboardPort, 'GET', '/telemetry');
  if (status === 503) { console.error('Telemetry service not available.'); process.exit(1); }

  const stats = body as { totalEvents: number; avgRiskScore: number; byAction: Record<string, number>; byTool: Record<string, number>; riskHistogram: Record<string, number> };
  console.log(`Telemetry stats (${stats.totalEvents} events since last flush):\n`);
  console.log(`  Avg risk score: ${(stats.avgRiskScore * 100).toFixed(1)}%`);
  console.log(`\n  By action:`);
  for (const [k, v] of Object.entries(stats.byAction)) console.log(`    ${k.padEnd(20)} ${v}`);
  console.log(`\n  By tool:`);
  for (const [k, v] of Object.entries(stats.byTool)) console.log(`    ${k.padEnd(20)} ${v}`);
  console.log(`\n  Risk histogram:`);
  for (const [k, v] of Object.entries(stats.riskHistogram)) console.log(`    ${k.padEnd(10)} ${v}`);
}

export async function cmdApprovals(): Promise<void> {
  const state = await readState();
  if (!state) { console.error('AgentsGate is not running.'); process.exit(1); }
  const { body } = await dashFetch(state.dashboardPort, 'GET', '/approvals/pending');
  const resp = body as { data: Array<{ id: string; operation: { agentId: string; tool: string; method: string }; riskScore: number; queuedAt: string }>; count: number };
  if (resp.count === 0) { console.log('No pending approvals.'); return; }
  console.log(`${resp.count} pending approval(s):\n`);
  for (const item of resp.data) {
    console.log(`  ID:      ${item.id}`);
    console.log(`  Agent:   ${item.operation.agentId}  Tool: ${item.operation.tool}  Method: ${item.operation.method}`);
    console.log(`  Risk:    ${(item.riskScore * 100).toFixed(0)}%`);
    console.log(`  Queued:  ${new Date(item.queuedAt).toLocaleString()}`);
    console.log(`  Run:     agentsgate approve ${item.id}  |  agentsgate deny ${item.id}\n`);
  }
}

export async function cmdErrors(args: string[]): Promise<void> {
  const state = await readState();
  if (!state) { console.error('AgentsGate is not running.'); process.exit(1); }

  const limitStr = parseFlag(args, 'limit') ?? args.find(a => /^\d+$/.test(a));
  const limit = limitStr ? parseInt(limitStr, 10) : 50;

  const { status, body } = await dashFetch(state.dashboardPort, 'GET', `/errors?limit=${limit}`);
  if (status !== 200) {
    console.error(`Dashboard returned ${status}`);
    process.exit(1);
  }

  type ErrorRow = { id: string; timestamp: string; module: string; message: string };
  const resp = body as { errors: ErrorRow[]; total: number };

  if (resp.errors.length === 0) {
    console.log('No errors recorded.');
    return;
  }

  const tsW = 25;
  const modW = 8;
  console.log(
    'TIMESTAMP'.padEnd(tsW) + '  ' +
    'MODULE'.padEnd(modW) + '  ' +
    'MESSAGE'
  );
  console.log('─'.repeat(tsW) + '  ' + '─'.repeat(modW) + '  ' + '─'.repeat(40));

  for (const err of resp.errors) {
    const ts = new Date(err.timestamp).toISOString().padEnd(tsW);
    const mod = err.module.padEnd(modW);
    console.log(`${ts}  ${mod}  ${err.message}`);
  }
}

export async function cmdResolve(id: string, approved: boolean): Promise<void> {
  const state = await readState();
  if (!state) { console.error('AgentsGate is not running.'); process.exit(1); }
  const { status, body } = await dashFetch(state.dashboardPort, 'POST', `/approvals/${id}/${approved ? 'approve' : 'deny'}`);
  if (status === 200) {
    const r = body as { verdict: string; checkpointId?: string };
    console.log(`Operation ${id}: ${r.verdict}`);
    if (r.checkpointId) console.log(`  Checkpoint: ${r.checkpointId}`);
  } else {
    console.error(`Error: ${(body as { error: string }).error}`);
    process.exit(1);
  }
}

export async function cmdCheckpoints(limit: number): Promise<void> {
  const state = await readState();
  if (!state) { console.error('AgentsGate is not running.'); process.exit(1); }
  const { body } = await dashFetch(state.dashboardPort, 'GET', `/checkpoints?limit=${limit}`);
  const resp = body as { data: Array<{ id: string; operationId: string; fileSnapshots: unknown[]; createdAt: string }>; count: number };
  if (resp.count === 0) { console.log('No checkpoints found.'); return; }
  console.log(`${resp.count} checkpoint(s):\n`);
  for (const cp of resp.data) {
    console.log(`  ${cp.id}  files:${cp.fileSnapshots.length}  op:${cp.operationId.slice(0, 8)}  ${new Date(cp.createdAt).toLocaleString()}`);
    console.log(`  Rollback: agentsgate rollback ${cp.id}\n`);
  }
}

export async function cmdRollback(checkpointId: string): Promise<void> {
  const state = await readState();
  if (!state) { console.error('AgentsGate is not running.'); process.exit(1); }
  console.log(`Rolling back to checkpoint ${checkpointId}...`);
  const { status, body } = await dashFetch(state.dashboardPort, 'POST', `/rollback/${checkpointId}`);
  const result = body as { success: boolean; restoredFiles: string[]; failedFiles: string[]; error?: string };
  if (result.success) {
    console.log(`Rollback successful — ${result.restoredFiles.length} file(s) restored:`);
    for (const f of result.restoredFiles) console.log(`  ✓ ${f}`);
  } else {
    console.error(`Rollback failed: ${result.error ?? 'unknown error'}`);
    for (const f of result.failedFiles) console.log(`  ✗ ${f}`);
    process.exit(1);
  }
}

export async function cmdCircuitBreakers(args: string[]): Promise<void> {
  const sub = args[0]; // list (default) | reset <agentId>
  const state = await readState();
  if (!state) { console.error('AgentsGate is not running.'); process.exit(1); }

  if (!sub || sub === 'list') {
    const { status, body } = await dashFetch(state.dashboardPort, 'GET', '/circuit-breakers');
    if (status === 503) { console.error('Circuit breaker not configured on the running proxy.'); process.exit(1); }
    const b = body as { agents: Array<{ agentId: string; isOpen: boolean; consecutiveBlocks: number; trippedAt?: number }>; count: number };
    if (b.count === 0) { console.log('No agents tracked by circuit breaker yet.'); return; }
    console.log(`${b.count} agent(s):\n`);
    for (const a of b.agents) {
      const status = a.isOpen ? 'OPEN  (blocking)' : 'closed';
      const tripped = a.trippedAt ? `  tripped:${new Date(a.trippedAt).toISOString()}` : '';
      console.log(`  ${a.agentId.padEnd(30)} ${status}  consecutive-blocks:${a.consecutiveBlocks}${tripped}`);
    }
    return;
  }

  if (sub === 'reset') {
    const agentId = args[1];
    if (!agentId) { console.error('Usage: agentsgate circuit-breakers reset <agentId>'); process.exit(1); }
    const { status, body } = await dashFetch(state.dashboardPort, 'POST', `/circuit-breakers/${encodeURIComponent(agentId)}/reset`);
    if (status === 503) { console.error('Circuit breaker not configured on the running proxy.'); process.exit(1); }
    const b = body as { ok: boolean; message?: string };
    if (b.ok) { console.log(`Circuit for agent "${agentId}" reset.`); }
    else { console.error(`Reset failed: ${JSON.stringify(body)}`); process.exit(1); }
    return;
  }

  console.error(`Unknown subcommand: ${sub}`);
  console.error('Usage: agentsgate circuit-breakers [list|reset <agentId>]');
  process.exit(1);
}

/**
 * agentsgate watch [--action=X] [--tool=X] [--agentId=X]
 * Live-tail proxy operation events via SSE. Ctrl-C to stop.
 */
/**
 * agentsgate verify-logs [--config=path] [--limit=N]
 * Reads operation logs from the local DB and verifies HMAC signatures.
 * Exits with code 1 if any log has an invalid or missing signature.
 * Exits with code 2 if no signing secret is configured.
 */
export async function cmdVerifyLogs(args: string[]): Promise<void> {
  const limitArg = parseFlag(args, 'limit');
  const limit = limitArg ? parseInt(limitArg, 10) : 1000;

  const config = await loadConfig(parseFlag(args, 'config'));
  const secret = config.audit?.signingSecret;
  if (!secret) {
    console.error('No audit.signingSecret in config — cannot verify HMAC signatures.');
    process.exit(2);
  }

  const store = new StateStore(DB_FILE);
  await store.initialize();
  const logs = await store.listOperationLogs(limit, 0);
  await store.close();

  if (logs.length === 0) { console.log('No logs found.'); return; }

  const { auditLogs } = await import('../utils/audit-hmac.js');
  const { valid, invalid } = auditLogs(logs, secret);

  console.log(`Verified ${logs.length} log(s):`);
  console.log(`  Valid   : ${valid.length}`);
  console.log(`  Invalid : ${invalid.length}`);

  if (invalid.length > 0) {
    console.error('\nTampered or pre-signing logs:');
    for (const l of invalid) {
      console.error(`  ✗ ${l.operationId}  ${l.operation.agentId} / ${l.operation.method}  hmac=${l.hmac ?? '(none)'}`);
    }
    process.exit(1);
  }

  console.log('\nAll signatures valid.');
}

/**
 * agentsgate rate-limits
 * Shows per-agent rate-limiter stats from the running proxy dashboard.
 */
export async function cmdRateLimits(_args: string[]): Promise<void> {
  const state = await readState();
  if (!state) { console.error('AgentsGate is not running.'); process.exit(1); }

  const { status, body } = await dashFetch(state.dashboardPort, 'GET', '/rate-limits');
  if (status === 503) { console.error('Rate limiter not configured on the running proxy.'); process.exit(1); }
  if (status !== 200) { console.error(`Error: HTTP ${status}`); process.exit(1); }

  const b = body as { agents: Array<{ agentId: string; count: number; limit: number; windowMs: number; limited: boolean }>; count: number };
  if (b.count === 0) { console.log('No agents tracked by rate limiter yet.'); return; }
  console.log(`${b.count} agent(s):\n`);
  const header = 'AGENT ID'.padEnd(32) + 'COUNT'.padStart(6) + '  LIMIT'.padStart(7) + '  WINDOW'.padStart(8) + '  STATUS';
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const a of b.agents) {
    const windowSec = Math.round(a.windowMs / 1000);
    const statusStr = a.limited ? '\x1b[31mLIMITED\x1b[0m' : '\x1b[32mok\x1b[0m';
    console.log(
      a.agentId.padEnd(32) +
      String(a.count).padStart(6) + '  ' +
      String(a.limit).padStart(5) + '  ' +
      `${windowSec}s`.padStart(6) + '  ' +
      statusStr
    );
  }
}

export async function cmdBenchmark(args: string[]): Promise<void> {
  const count = parseInt(args.find(a => /^\d+$/.test(a)) ?? '100', 10);
  const concurrency = parseInt(parseFlag(args, 'concurrency') ?? '1', 10);

  console.log(`AgentsGate Proxy Benchmark`);
  console.log(`  Operations:  ${count}`);
  console.log(`  Concurrency: ${concurrency}\n`);

  const { RiskScoringEngine } = await import('../modules/m6-risk/index.js');
  const { InterventionController } = await import('../modules/m7-intervention/index.js');
  const { createPipeline } = await import('../modules/m1-proxy/index.js');

  const pipeline = createPipeline({
    riskEngine: new RiskScoringEngine(),
    interventionController: new InterventionController(),
  });

  const TOOLS = ['filesystem', 'database', 'shell', 'github'];
  const METHODS = ['read_file', 'write_file', 'delete_file', 'execute', 'list_directory'];

  function makeOp(i: number): import('../types/interfaces.js').MCPOperation {
    return {
      id: `bench-${i}`,
      agentId: `agent-${i % 5}`,
      tool: TOOLS[i % TOOLS.length]!,
      method: METHODS[i % METHODS.length]!,
      params: { path: `/tmp/bench-${i}.txt` },
      timestamp: new Date(),
      sessionId: `sess-${i % 3}`,
    };
  }

  const start = performance.now();
  let completed = 0;

  if (concurrency === 1) {
    // Sequential
    for (let i = 0; i < count; i++) {
      await pipeline.evaluateRisk!(makeOp(i));
      completed++;
    }
  } else {
    // Concurrent batches
    const tasks = Array.from({ length: count }, (_, i) => i);
    while (tasks.length > 0) {
      const batch = tasks.splice(0, concurrency);
      await Promise.all(batch.map(i => pipeline.evaluateRisk!(makeOp(i))));
      completed += batch.length;
    }
  }

  const elapsed = performance.now() - start;
  const opsPerSec = (completed / (elapsed / 1000)).toFixed(0);
  const avgMs = (elapsed / completed).toFixed(2);

  console.log(`Results:`);
  console.log(`  Total time:  ${elapsed.toFixed(0)}ms`);
  console.log(`  Throughput:  ${opsPerSec} ops/sec`);
  console.log(`  Avg latency: ${avgMs}ms per operation`);
}
