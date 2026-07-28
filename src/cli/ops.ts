import fs from 'node:fs/promises';
import { StateStore } from '../modules/m2-store/index.js';
import { DB_FILE, parseFlag, readState, dashFetch } from './shared.js';
import { cmdOpsSummary } from './ops-summary.js';

export async function cmdLogs(args: string[]): Promise<void> {
  const limitArg = args.find(a => /^\d+$/.test(a)) ?? '20';
  const actionFilter = parseFlag(args, 'action');
  const toolFilter = parseFlag(args, 'tool');
  const agentIdFilter = parseFlag(args, 'agentId');
  const sessionIdFilter = parseFlag(args, 'sessionId');

  const state = await readState();
  let httpProxyRunning = false;
  if (state) {
    try { process.kill(state.pid, 0); httpProxyRunning = true; } catch { /* stale */ }
  }

  if (httpProxyRunning && state) {
    // HTTP proxy mode — query the live dashboard API
    let qs = `?limit=${limitArg}`;
    if (actionFilter) qs += `&action=${encodeURIComponent(actionFilter)}`;
    if (toolFilter) qs += `&tool=${encodeURIComponent(toolFilter)}`;
    if (agentIdFilter) qs += `&agentId=${encodeURIComponent(agentIdFilter)}`;
    if (sessionIdFilter) qs += `&sessionId=${encodeURIComponent(sessionIdFilter)}`;

    const { body } = await dashFetch(state.dashboardPort, 'GET', `/operations${qs}`);
    const resp = body as { data: Array<{ operationId: string; operation: { agentId: string; tool: string; method: string; timestamp: string }; decision: { action: string; riskScore: number } }>; count: number };

    if (resp.count === 0) { console.log('No operations found.'); return; }
    console.log(`${resp.count} operation(s):\n`);
    for (const log of resp.data) {
      const risk = (log.decision.riskScore * 100).toFixed(0).padStart(3);
      const action = log.decision.action.padEnd(16);
      const ts = new Date(log.operation.timestamp).toLocaleTimeString();
      console.log(`  ${ts}  ${action}  ${risk}%  ${log.operation.agentId}/${log.operation.tool}.${log.operation.method}`);
    }
    return;
  }

  // Stdio/offline mode — read directly from the SQLite database
  // (used when agentsgate inject is active but agentsgate start is not running)
  const store = new StateStore(DB_FILE);
  try {
    await store.initialize();
  } catch {
    console.error('No AgentsGate logs found. Start the proxy or run some tool calls first.');
    process.exit(1);
  }

  const filter: import('../modules/m2-store/index.js').OperationFilter = {};
  if (actionFilter) filter.action = actionFilter as import('../types/interfaces.js').ProxyDecision['action'];
  if (toolFilter) filter.tool = toolFilter;
  if (agentIdFilter) filter.agentId = agentIdFilter;
  if (sessionIdFilter) filter.sessionId = sessionIdFilter;

  const limit = parseInt(limitArg, 10);
  const logs = await store.listOperationLogs(limit, 0, Object.keys(filter).length ? filter : undefined);
  await store.close();

  if (logs.length === 0) { console.log('No operations found.'); return; }
  console.log(`${logs.length} operation(s) (offline — stdio proxy mode):\n`);
  for (const log of logs) {
    const risk = (log.decision.riskScore * 100).toFixed(0).padStart(3);
    const action = log.decision.action.padEnd(16);
    const ts = log.createdAt.toLocaleTimeString();
    console.log(`  ${ts}  ${action}  ${risk}%  ${log.operation.agentId}/${log.operation.tool ?? 'mcp'}.${log.operation.method}`);
  }
}

export async function cmdOpsStats(args: string[]): Promise<void> {
  const agentId  = parseFlag(args, 'agentId');
  const tool     = parseFlag(args, 'tool');
  const limitStr = parseFlag(args, 'limit') ?? args.find(a => /^\d+$/.test(a));
  const limit    = limitStr ? parseInt(limitStr, 10) : 1000;

  const store = new StateStore(DB_FILE);
  await store.initialize();

  const filter: import('../modules/m2-store/index.js').OperationFilter = {};
  if (agentId) filter.agentId = agentId;
  if (tool)    filter.tool    = tool;

  const logs = await store.listOperationLogs(limit, 0, Object.keys(filter).length ? filter : undefined);
  await store.close();

  if (logs.length === 0) {
    console.log('No operations found.');
    return;
  }

  const total = logs.length;
  const byAction: Record<string, number> = { allow: 0, block: 0, require_approval: 0 };
  let riskSum = 0;
  let riskMax = 0;
  const toolCount:    Map<string, number> = new Map();
  const toolBlocked:  Map<string, number> = new Map();
  const agentCount:   Map<string, number> = new Map();
  const agentRiskSum: Map<string, number> = new Map();

  for (const l of logs) {
    const action = l.decision.action;
    byAction[action] = (byAction[action] ?? 0) + 1;
    const rs = l.decision.riskScore;
    riskSum += rs;
    if (rs > riskMax) riskMax = rs;

    const t = l.operation.tool;
    toolCount.set(t, (toolCount.get(t) ?? 0) + 1);
    if (action === 'block') toolBlocked.set(t, (toolBlocked.get(t) ?? 0) + 1);

    const a = l.operation.agentId;
    agentCount.set(a, (agentCount.get(a) ?? 0) + 1);
    agentRiskSum.set(a, (agentRiskSum.get(a) ?? 0) + rs);
  }

  const pct = (n: number) => ((n / total) * 100).toFixed(1) + '%';
  const avgRisk = (riskSum / total).toFixed(3);

  console.log(`\nOperations Summary (${total} total, last ${limit} loaded)\n`);
  console.log(`  allow           : ${String(byAction.allow ?? 0).padStart(4)}  (${pct(byAction.allow ?? 0)})`);
  console.log(`  block           : ${String(byAction.block ?? 0).padStart(4)}  (${pct(byAction.block ?? 0)})`);
  console.log(`  require_approval: ${String(byAction.require_approval ?? 0).padStart(4)}  (${pct(byAction.require_approval ?? 0)})`);
  console.log(`\n  Avg risk score  : ${avgRisk}`);
  console.log(`  Max risk score  : ${riskMax.toFixed(3)}`);

  const topTools = [...toolCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  console.log('\nTop tools by operation count:');
  for (const [t, cnt] of topTools) {
    const blocked = toolBlocked.get(t) ?? 0;
    const br = ((blocked / cnt) * 100).toFixed(1) + '%';
    console.log(`  ${t.padEnd(16)}: ${String(cnt).padStart(4)} ops  block-rate: ${br}`);
  }

  const topAgents = [...agentCount.entries()]
    .map(([a, cnt]) => ({ agent: a, cnt, avg: (agentRiskSum.get(a) ?? 0) / cnt }))
    .sort((a, b) => b.avg - a.avg)
    .slice(0, 10);
  console.log('\nTop agents by avg risk:');
  for (const { agent, cnt, avg } of topAgents) {
    console.log(`  ${agent.padEnd(24)}: ${avg.toFixed(3)} avg  ${cnt} ops`);
  }
  console.log('');
}

export async function cmdOpsTail(args: string[]): Promise<void> {
  const state = await readState();
  if (!state) { console.error('AgentsGate is not running.'); process.exit(1); }

  const limit  = parseInt(parseFlag(args, 'limit') ?? '20', 10);
  const action = parseFlag(args, 'action');
  const tool   = parseFlag(args, 'tool');
  const agent  = parseFlag(args, 'agent');
  const tags   = parseFlag(args, 'tags'); // T253: comma-separated tags filter

  const params = new URLSearchParams({ limit: String(limit), offset: '0' });
  if (action) params.set('action', action);
  if (tool)   params.set('tool', tool);
  if (agent)  params.set('agentId', agent);
  if (tags)   params.set('tags', tags);

  const { status, body } = await dashFetch(state.dashboardPort, 'GET', `/operations?${params}`);
  if (status !== 200) {
    console.error(`Dashboard returned ${status}`);
    process.exit(1);
  }

  type LogRow = {
    operationId: string;
    operation: { agentId: string; tool: string; method: string; timestamp: string };
    decision: { action: string; riskScore: number };
  };
  const resp = body as { data: LogRow[]; count: number };
  const rows = resp.data ?? [];

  if (rows.length === 0) {
    console.log('No operations found.');
    return;
  }

  // Header
  console.log(
    'TIME       '.padEnd(12) +
    'ACTION          '.padEnd(18) +
    'RISK '.padEnd(6) +
    'AGENT                '.padEnd(22) +
    'TOOL.METHOD'
  );
  console.log('─'.repeat(80));

  for (const row of rows) {
    const ts     = new Date(row.operation.timestamp).toLocaleTimeString();
    const act    = row.decision.action.padEnd(16);
    const risk   = `${(row.decision.riskScore * 100).toFixed(0)}%`.padEnd(5);
    const agentS = row.operation.agentId.slice(0, 20).padEnd(21);
    const tm     = `${row.operation.tool}.${row.operation.method}`;
    console.log(`${ts.padEnd(12)}${act}  ${risk} ${agentS} ${tm}`);
  }

  console.log(`\n${rows.length} of ${resp.count} operations shown.`);
}

export async function cmdOpsPrune(args: string[]): Promise<void> {
  const olderThanStr = parseFlag(args, 'older-than');
  if (!olderThanStr) {
    console.error('Usage: agentsgate ops prune --older-than=<ms>');
    process.exit(1);
  }
  const maxAgeMs = parseInt(olderThanStr, 10);
  if (isNaN(maxAgeMs) || maxAgeMs < 0) {
    console.error('--older-than must be a non-negative number of milliseconds');
    process.exit(1);
  }
  const store = new StateStore(DB_FILE);
  await store.initialize();
  try {
    const pruned = store.pruneOldLogs(maxAgeMs);
    console.log(`Pruned ${pruned} operation log(s) older than ${maxAgeMs}ms.`);
  } finally {
    await store.close();
  }
}

export async function cmdOpsExport(args: string[]): Promise<void> {
  const state = await readState();
  if (!state) { console.error('AgentsGate is not running.'); process.exit(1); }
  const outFile  = args.find(a => !a.startsWith('--'));
  const action   = parseFlag(args, 'action');
  const tool     = parseFlag(args, 'tool');
  const agent    = parseFlag(args, 'agent');
  const tags     = parseFlag(args, 'tags');     // T283: tag filter
  const parentId = parseFlag(args, 'parentId'); // T283: parentId filter
  const sort     = parseFlag(args, 'sort');     // T305: sort field
  const order    = parseFlag(args, 'order');    // T305: sort order
  const q        = parseFlag(args, 'q');        // T305: full-text search
  const format   = parseFlag(args, 'format');   // T305: csv|ndjson
  const minRisk  = parseFlag(args, 'min-risk'); // T314: risk range filter
  const maxRisk  = parseFlag(args, 'max-risk'); // T314: risk range filter

  const params = new URLSearchParams();
  if (action)   params.set('action', action);
  if (tool)     params.set('tool', tool);
  if (agent)    params.set('agentId', agent);
  if (tags)     params.set('tags', tags);
  if (parentId) params.set('parentId', parentId);
  if (sort)     params.set('sort', sort);
  if (order)    params.set('order', order);
  if (q)        params.set('q', q);
  if (format)   params.set('format', format);
  if (minRisk)  params.set('minRisk', minRisk);
  if (maxRisk)  params.set('maxRisk', maxRisk);

  const res = await fetch(
    `http://127.0.0.1:${state.dashboardPort}/operations/export?${params}`,
    { method: 'GET' }
  );
  if (!res.ok) { console.error(`Dashboard returned ${res.status}`); process.exit(1); }
  const csv = await res.text();

  if (outFile) {
    await fs.writeFile(outFile, csv, 'utf-8');
    console.log(`Exported to ${outFile}`);
  } else {
    process.stdout.write(csv);
  }
}

export async function cmdOpsGet(args: string[]): Promise<void> {
  const operationId = args[0];
  if (!operationId) {
    console.error('Usage: agentsgate ops get <operationId>');
    process.exit(1);
  }
  const state = await readState();
  if (!state) { console.error('AgentsGate is not running.'); process.exit(1); }
  const { body, status } = await dashFetch(state.dashboardPort, 'GET', `/operations/${encodeURIComponent(operationId)}`);
  if (status === 404) {
    console.error(`Operation ${operationId} not found.`);
    process.exit(1);
  }
  const log = body as { operationId: string; operation: Record<string, unknown>; decision: Record<string, unknown>; createdAt: string };
  console.log(`Operation: ${log.operationId}`);
  console.log(`  Agent:   ${log.operation['agentId']}`);
  console.log(`  Tool:    ${log.operation['tool']}.${log.operation['method']}`);
  console.log(`  Time:    ${new Date(log.operation['timestamp'] as string).toLocaleString()}`);
  console.log(`  Action:  ${log.decision['action']}`);
  console.log(`  Risk:    ${((log.decision['riskScore'] as number) * 100).toFixed(1)}%`);
  const rules = log.decision['firedRules'] as Array<{ id: string; score: number }> | undefined;
  if (rules && rules.length > 0) {
    console.log(`  Rules:   ${rules.map(r => `${r.id}(${(r.score * 100).toFixed(0)}%)`).join(', ')}`);
  }
  const parentId = log.operation['parentId'] as string | undefined;
  if (parentId) console.log(`  Parent:  ${parentId}`);
  const tags = log.operation['tags'] as string[] | undefined;
  if (tags && tags.length > 0) console.log(`  Tags:    ${tags.join(', ')}`);
  console.log(`  Params:  ${JSON.stringify(log.operation['params'])}`);
}

export async function cmdOpsCount(args: string[]): Promise<void> {
  const state = await readState();
  if (!state) { console.error('AgentsGate is not running.'); process.exit(1); }
  const action   = parseFlag(args, 'action');
  const tool     = parseFlag(args, 'tool');
  const agent    = parseFlag(args, 'agent');
  const method   = parseFlag(args, 'method');   // T401
  const tags     = parseFlag(args, 'tags');     // T309
  const parentId = parseFlag(args, 'parentId'); // T309
  const from     = parseFlag(args, 'from');     // T383
  const to       = parseFlag(args, 'to');       // T383
  const params = new URLSearchParams();
  if (action)   params.set('action', action);
  if (tool)     params.set('tool', tool);
  if (agent)    params.set('agentId', agent);
  if (method)   params.set('method', method);
  if (tags)     params.set('tags', tags);
  if (parentId) params.set('parentId', parentId);
  if (from)     params.set('from', from);
  if (to)       params.set('to', to);
  const { status, body } = await dashFetch(state.dashboardPort, 'GET', `/operations/count?${params}`);
  if (status !== 200) { console.error(`Dashboard returned ${status}`); process.exit(1); }
  const r = body as { count: number };
  console.log(r.count);
}

export async function cmdOps(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub === 'stats') {
    return cmdOpsStats(args.slice(1));
  }
  if (sub === 'tail') {
    return cmdOpsTail(args.slice(1));
  }
  if (sub === 'summary') {
    return cmdOpsSummary(args.slice(1));
  }
  if (sub === 'prune') {
    return cmdOpsPrune(args.slice(1));
  }
  if (sub === 'export') {
    return cmdOpsExport(args.slice(1));
  }
  if (sub === 'get') {
    return cmdOpsGet(args.slice(1));
  }
  if (sub === 'count') {
    return cmdOpsCount(args.slice(1));
  }
  if (sub !== 'watch') {
    console.error('Usage: agentsgate ops <watch|stats|tail|summary|prune|export|get|count>');
    process.exit(1);
  }
  const state = await readState();
  if (!state) { console.error('AgentsGate is not running.'); process.exit(1); }

  console.log(`Watching operations from dashboard on port ${state.dashboardPort}... (Ctrl+C to exit)\n`);

  // Connect to the SSE endpoint and fetch the latest op on each refresh event
  const { request } = await import('node:http');
  const req = request({
    host: '127.0.0.1',
    port: state.dashboardPort,
    path: '/events',
    headers: { Accept: 'text/event-stream' },
  });
  req.on('error', err => { console.error('Connection error:', err.message); process.exit(1); });
  req.end();

  req.on('response', (res) => {
    let buf = '';
    res.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('event: refresh') || line.startsWith('event: connected')) {
          // Fetch the latest single operation on each refresh
          void (async () => {
            try {
              const { body } = await dashFetch(state.dashboardPort, 'GET', '/operations?limit=1');
              const resp = body as { data: Array<{ operationId: string; operation: { agentId: string; tool: string; method: string; timestamp: string }; decision: { action: string; riskScore: number; dryRun?: boolean } }> };
              if (resp.data?.length) {
                const log = resp.data[0]!;
                const risk = (log.decision.riskScore * 100).toFixed(0).padStart(3);
                const action = log.decision.action.padEnd(16);
                const ts = new Date(log.operation.timestamp).toLocaleTimeString();
                const dryTag = log.decision.dryRun ? ' [DRY]' : '';
                console.log(`  ${ts}  ${action}  ${risk}%  ${log.operation.agentId}/${log.operation.tool}.${log.operation.method}${dryTag}`);
              }
            } catch { /* ignore fetch errors */ }
          })();
        }
      }
    });
    res.on('error', err => { console.error('Stream error:', err.message); });
    res.on('end', () => { console.log('Stream ended.'); process.exit(0); });
  });

  process.on('SIGINT', () => { console.log('\nStopped watching.'); process.exit(0); });
}

export async function cmdExport(args: string[]): Promise<void> {
  const format = (parseFlag(args, 'format') ?? 'json').toLowerCase();
  const output = parseFlag(args, 'output');
  const limitStr = args.find(a => /^\d+$/.test(a));
  const limit = limitStr ? parseInt(limitStr, 10) : 1000;
  const action = parseFlag(args, 'action');
  const tool   = parseFlag(args, 'tool');
  const agent  = parseFlag(args, 'agentId');
  const sess   = parseFlag(args, 'sessionId');

  if (format !== 'json' && format !== 'csv' && format !== 'ndjson') {
    console.error('--format must be json, csv, or ndjson'); process.exit(1);
  }

  const store = new StateStore(DB_FILE);
  await store.initialize();

  const filter: import('../modules/m2-store/index.js').OperationFilter = {};
  if (action === 'allow' || action === 'block' || action === 'require_approval') filter.action = action;
  if (tool)  filter.tool = tool;
  if (agent) filter.agentId = agent;
  if (sess)  filter.sessionId = sess;

  const logs = await store.listOperationLogs(limit, 0, Object.keys(filter).length ? filter : undefined);
  await store.close();

  let content: string;
  if (format === 'json') {
    content = JSON.stringify(logs, null, 2);
  } else if (format === 'ndjson') {
    content = logs.map(l => JSON.stringify({
      operationId: l.operationId,
      agentId: l.operation.agentId,
      tool: l.operation.tool,
      method: l.operation.method,
      sessionId: l.operation.sessionId,
      parentId: l.operation.parentId,
      action: l.decision.action,
      riskScore: l.decision.riskScore,
      reasons: l.decision.reasons,
      timestamp: l.operation.timestamp instanceof Date ? l.operation.timestamp.toISOString() : l.operation.timestamp,
      createdAt: l.createdAt instanceof Date ? l.createdAt.toISOString() : l.createdAt,
    })).join('\n');
  } else {
    const headers = ['operationId','agentId','tool','method','action','riskScore','sessionId','timestamp','createdAt'];
    const csvRow = (vals: string[]) => vals.map(v => `"${v.replace(/"/g, '""')}"`).join(',');
    const rows = logs.map(l => csvRow([
      l.operationId,
      l.operation.agentId,
      l.operation.tool,
      l.operation.method,
      l.decision.action,
      l.decision.riskScore.toFixed(4),
      l.operation.sessionId,
      l.operation.timestamp instanceof Date ? l.operation.timestamp.toISOString() : String(l.operation.timestamp),
      l.createdAt instanceof Date ? l.createdAt.toISOString() : String(l.createdAt),
    ]));
    content = [headers.join(','), ...rows].join('\n');
  }

  if (output) {
    await fs.writeFile(output, content, 'utf-8');
    console.log(`Exported ${logs.length} record(s) to ${output} (${format.toUpperCase()})`);
  } else {
    process.stdout.write(content + '\n');
  }
}
