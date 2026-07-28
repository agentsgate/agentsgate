import fs from 'node:fs/promises';
import { StateStore } from '../modules/m2-store/index.js';
import { FileShadowSystem } from '../modules/m5-shadow/index.js';
import { DB_FILE, SHADOW_DIR, parseFlag, readState, dashFetch } from './shared.js';

/**
 * agentsgate top [--interval=N]
 * Live-refresh terminal dashboard showing top agents/tools by risk score.
 * Refreshes every N seconds (default: 2). Ctrl-C to stop.
 */
export async function cmdTop(args: string[]): Promise<void> {
  const state = await readState();
  if (!state) { console.error('AgentsGate is not running.'); process.exit(1); }

  const intervalSec = parseInt(parseFlag(args, 'interval') ?? '2', 10);
  const port = state.dashboardPort;

  let running = true;
  process.on('SIGINT', () => { running = false; process.stdout.write('\x1b[?25h\n'); process.exit(0); });

  // Hide cursor
  process.stdout.write('\x1b[?25l');

  while (running) {
    try {
      const [logsRes, telRes] = await Promise.all([
        fetch(`http://127.0.0.1:${port}/operations?limit=50`),
        fetch(`http://127.0.0.1:${port}/telemetry`),
      ]);
      const logsBody = logsRes.ok
        ? (await logsRes.json() as { data: Array<{ operation: { agentId: string; tool: string }; decision: { riskScore: number; action: string } }> })
        : { data: [] };
      const logs = logsBody.data ?? [];
      const tel = telRes.ok ? (await telRes.json() as {
        totalEvents?: number; byAction?: Record<string, number>;
        avgRiskScore?: number; topAgents?: Array<{ agentId: string; count: number }>;
        topTools?:  Array<{ tool: string; count: number }>;
      }) : {};

      // Compute top 5 agents by avg risk from logs
      const agentRisk: Record<string, { total: number; count: number }> = {};
      for (const l of logs) {
        const id = l.operation.agentId;
        agentRisk[id] = agentRisk[id] ?? { total: 0, count: 0 };
        agentRisk[id].total += l.decision.riskScore;
        agentRisk[id].count += 1;
      }
      const topAgents = Object.entries(agentRisk)
        .map(([agentId, { total, count }]) => ({ agentId, avgRisk: total / count, count }))
        .sort((a, b) => b.avgRisk - a.avgRisk)
        .slice(0, 5);

      const topTools: Record<string, number> = {};
      for (const l of logs) { topTools[l.operation.tool] = (topTools[l.operation.tool] ?? 0) + 1; }
      const topToolsSorted = Object.entries(topTools).sort((a, b) => b[1] - a[1]).slice(0, 5);

      // Clear screen and render
      process.stdout.write('\x1b[H\x1b[2J');
      const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
      console.log(`AgentsGate TOP — ${now}  (refreshing every ${intervalSec}s, Ctrl-C to stop)\n`);

      // Summary row
      const total = tel.totalEvents ?? logs.length;
      const allow = tel.byAction?.allow ?? 0;
      const block = tel.byAction?.block ?? 0;
      const apprvl = tel.byAction?.require_approval ?? 0;
      const avgRisk = tel.avgRiskScore?.toFixed(3) ?? '—';
      console.log(`  Total: ${total}  Allow: ${allow}  Block: ${block}  Approval: ${apprvl}  Avg-risk: ${avgRisk}\n`);

      // Top agents
      console.log('  TOP AGENTS (by avg risk score):');
      if (topAgents.length === 0) {
        console.log('    (no data)');
      } else {
        for (const a of topAgents) {
          const bar = '█'.repeat(Math.round(a.avgRisk * 20)).padEnd(20);
          console.log(`    ${a.agentId.padEnd(28)} risk=${a.avgRisk.toFixed(3)}  ops=${a.count}  ${bar}`);
        }
      }

      // Top tools
      console.log('\n  TOP TOOLS (by op count):');
      if (topToolsSorted.length === 0) {
        console.log('    (no data)');
      } else {
        for (const [tool, count] of topToolsSorted) {
          console.log(`    ${tool.padEnd(28)} ops=${count}`);
        }
      }
    } catch { /* proxy may be briefly unavailable */ }

    if (running) await new Promise(r => setTimeout(r, intervalSec * 1000));
  }
}

export async function cmdWatch(args: string[]): Promise<void> {
  const state = await readState();
  if (!state) { console.error('AgentsGate is not running.'); process.exit(1); }

  const filterAction = parseFlag(args, 'action');
  const filterTool = parseFlag(args, 'tool');
  const filterAgent = parseFlag(args, 'agentId');

  const url = `http://127.0.0.1:${state.dashboardPort}/events`;
  console.log(`Watching live operations from ${url}  (Ctrl-C to stop)\n`);

  // Node's native fetch supports streaming via the Response body ReadableStream
  const resp = await fetch(url);
  if (!resp.ok || !resp.body) {
    console.error(`Failed to connect: HTTP ${resp.status}`);
    process.exit(1);
  }

  const decoder = new TextDecoder();
  let buf = '';
  let currentEvent = 'message';

  const reader = resp.body.getReader();
  // Allow Ctrl-C to terminate cleanly
  process.on('SIGINT', () => { void reader.cancel(); process.exit(0); });

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    // Process complete SSE lines
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';  // last (possibly incomplete) line stays in buf

    for (const line of lines) {
      if (line.startsWith('event:')) {
        currentEvent = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        if (currentEvent !== 'operation') { currentEvent = 'message'; continue; }
        const raw = line.slice(5).trim();
        try {
          const ev = JSON.parse(raw) as {
            id: string; agentId: string; tool: string; method: string;
            action: string; riskScore: number; sessionId: string;
            timestamp: string; tags?: string[];
          };
          if (filterAction && ev.action !== filterAction) { currentEvent = 'message'; continue; }
          if (filterTool && ev.tool !== filterTool) { currentEvent = 'message'; continue; }
          if (filterAgent && ev.agentId !== filterAgent) { currentEvent = 'message'; continue; }

          const risk = ev.riskScore.toFixed(3);
          const action = ev.action === 'allow' ? '\x1b[32mALLOW\x1b[0m'
            : ev.action === 'block' ? '\x1b[31mBLOCK\x1b[0m'
            : '\x1b[33mAPPRVL\x1b[0m';
          const tags = ev.tags?.length ? `  [${ev.tags.join(',')}]` : '';
          const ts = new Date(ev.timestamp).toISOString().slice(11, 23);
          console.log(`${ts}  ${action}  risk=${risk}  ${ev.agentId}/${ev.tool}.${ev.method}${tags}`);
        } catch { /* skip malformed */ }
        currentEvent = 'message';
      }
    }
  }
}

export async function cmdSessions(args: string[]): Promise<void> {
  // agentsgate sessions [list]          — list all sessions with rollup stats
  // agentsgate sessions <sessionId>     — show detail for one session
  const sub = args[0]; // list (default) | <sessionId>
  const state = await readState();
  if (!state) { console.error('AgentsGate is not running.'); process.exit(1); }

  if (!sub || sub === 'list') {
    const { status, body } = await dashFetch(state.dashboardPort, 'GET', '/telemetry/sessions');
    if (status === 503) { console.error('Telemetry not configured on the running proxy.'); process.exit(1); }
    if (status !== 200) { console.error(`Error: HTTP ${status}`); process.exit(1); }
    const sessions = body as Array<{
      sessionId: string; totalEvents: number; avgRiskScore: number; maxRiskScore: number;
      byAction: Record<string, number>; firstEvent: number; lastEvent: number;
    }>;
    if (sessions.length === 0) { console.log('No sessions recorded.'); return; }
    console.log(`${sessions.length} session(s):\n`);
    const header = 'SESSION ID'.padEnd(38) + 'EVENTS'.padStart(7) + '  AVG-RISK  MAX-RISK  ALLOW  BLOCK  APPRVL  DURATION';
    console.log(header);
    console.log('-'.repeat(header.length));
    for (const s of sessions) {
      const dur = s.lastEvent && s.firstEvent
        ? `${Math.round((s.lastEvent - s.firstEvent) / 1000)}s`
        : '—';
      const allow = (s.byAction['allow'] ?? 0).toString().padStart(5);
      const block = (s.byAction['block'] ?? 0).toString().padStart(5);
      const apprvl = (s.byAction['require_approval'] ?? 0).toString().padStart(6);
      console.log(
        s.sessionId.padEnd(38) +
        String(s.totalEvents).padStart(7) + '  ' +
        s.avgRiskScore.toFixed(3).padStart(8) + '  ' +
        s.maxRiskScore.toFixed(3).padStart(8) +
        allow + '  ' + block + '  ' + apprvl + '  ' + dur
      );
    }
    return;
  }

  // Treat first arg as sessionId detail view
  const sessionId = sub;
  const { status, body } = await dashFetch(state.dashboardPort, 'GET', `/telemetry/sessions/${encodeURIComponent(sessionId)}`);
  if (status === 404) { console.error(`Session "${sessionId}" not found.`); process.exit(1); }
  if (status === 503) { console.error('Telemetry not configured on the running proxy.'); process.exit(1); }
  if (status !== 200) { console.error(`Error: HTTP ${status}`); process.exit(1); }
  const s = body as {
    sessionId: string; totalEvents: number; avgRiskScore: number; maxRiskScore: number;
    byAction: Record<string, number>; byTool: Record<string, number>;
    firstEvent: number; lastEvent: number;
  };
  console.log(`Session: ${s.sessionId}`);
  console.log(`  Events:      ${s.totalEvents}`);
  console.log(`  Avg risk:    ${s.avgRiskScore.toFixed(4)}`);
  console.log(`  Max risk:    ${s.maxRiskScore.toFixed(4)}`);
  console.log(`  First event: ${new Date(s.firstEvent).toISOString()}`);
  console.log(`  Last event:  ${new Date(s.lastEvent).toISOString()}`);
  console.log(`\n  By action:`);
  for (const [action, count] of Object.entries(s.byAction)) {
    console.log(`    ${action}: ${count}`);
  }
  if (s.byTool && Object.keys(s.byTool).length > 0) {
    console.log(`\n  By tool:`);
    for (const [tool, count] of Object.entries(s.byTool)) {
      console.log(`    ${tool}: ${count}`);
    }
  }
}

/**
 * agentsgate diff <checkpointId>
 * Shows which files differ between a checkpoint snapshot and their current state on disk.
 */
export async function cmdDiff(args: string[]): Promise<void> {
  const checkpointId = args[0];
  if (!checkpointId) {
    console.error('Usage: agentsgate diff <checkpointId>');
    process.exit(1);
  }

  const store = new StateStore(DB_FILE);
  await store.initialize();
  const cp = await store.getCheckpoint(checkpointId);
  await store.close();

  if (!cp) {
    console.error(`Checkpoint "${checkpointId}" not found.`);
    process.exit(1);
  }

  if (cp.fileSnapshots.length === 0) {
    console.log('No file snapshots in this checkpoint.');
    return;
  }

  const shadow = new FileShadowSystem();
  await shadow.initialize(SHADOW_DIR);

  console.log(`Diff for checkpoint ${checkpointId}  (${cp.fileSnapshots.length} file(s)):\n`);
  let identical = 0;
  let changed = 0;
  let missing = 0;

  for (const snap of cp.fileSnapshots) {
    const snapContent = await shadow.readSnapshot(snap);

    let currentContent: Buffer | null = null;
    try {
      currentContent = await fs.readFile(snap.path);
    } catch { /* file deleted */ }

    if (snapContent === null) {
      console.log(`  ? ${snap.path}  [snapshot unreadable]`);
      missing++;
      continue;
    }

    if (currentContent === null) {
      console.log(`  D ${snap.path}  [deleted since checkpoint]`);
      changed++;
      continue;
    }

    if (snapContent.equals(currentContent)) {
      console.log(`  = ${snap.path}  [unchanged]`);
      identical++;
    } else {
      // Basic text diff: count differing lines
      const snapLines = snapContent.toString('utf-8').split('\n');
      const curLines = currentContent.toString('utf-8').split('\n');
      const added   = curLines.filter(l => !snapLines.includes(l)).length;
      const removed = snapLines.filter(l => !curLines.includes(l)).length;
      console.log(`  M ${snap.path}  [modified: ~${removed} line(s) removed, ~${added} line(s) added]`);
      changed++;
    }
  }

  console.log(`\n  ${identical} unchanged, ${changed} changed, ${missing} unreadable`);
}

export async function cmdSnapshot(args: string[]): Promise<void> {
  const sub = args[0]; // list | inspect | delete
  const store = new StateStore(DB_FILE);
  await store.initialize();

  if (!sub || sub === 'list') {
    const limitStr = args.find(a => /^\d+$/.test(a));
    const limit = limitStr ? parseInt(limitStr, 10) : 20;
    const checkpoints = await store.listCheckpoints();
    await store.close();
    const slice = checkpoints.slice(0, limit);
    if (slice.length === 0) { console.log('No snapshots found.'); return; }
    console.log(`${slice.length} snapshot(s) (newest first):\n`);
    for (const cp of slice) {
      const age = Math.round((Date.now() - new Date(cp.createdAt).getTime()) / 1000);
      console.log(`  ${cp.id}`);
      console.log(`    Operation:  ${cp.operationId}`);
      console.log(`    Files:      ${cp.fileSnapshots.length}`);
      console.log(`    Created:    ${new Date(cp.createdAt).toISOString()} (${age}s ago)`);
      console.log('');
    }
    return;
  }

  if (sub === 'inspect') {
    const id = args[1];
    if (!id) { await store.close(); console.error('Usage: agentsgate snapshot inspect <checkpointId>'); process.exit(1); }
    const cp = await store.getCheckpoint(id);
    await store.close();
    if (!cp) { console.error(`Snapshot "${id}" not found.`); process.exit(1); }
    console.log(`\nSnapshot: ${cp.id}`);
    console.log(`  Type:      ${cp.type}`);
    console.log(`  Operation: ${cp.operationId}`);
    console.log(`  Created:   ${cp.createdAt instanceof Date ? cp.createdAt.toISOString() : cp.createdAt}`);
    console.log(`  Files (${cp.fileSnapshots.length}):`);
    for (const f of cp.fileSnapshots) {
      const snap = f as { path: string; contentHash: string; size?: number };
      console.log(`    ${snap.path}  [sha256:${snap.contentHash.slice(0, 12)}...]`);
    }
    if (cp.dbSnapshot) console.log(`  DB snapshot: yes`);
    console.log('');
    return;
  }

  if (sub === 'delete') {
    const id = args[1];
    if (!id) { await store.close(); console.error('Usage: agentsgate snapshot delete <checkpointId>'); process.exit(1); }
    await store.deleteCheckpoint(id);
    await store.close();
    console.log(`Snapshot ${id} deleted.`);
    return;
  }

  await store.close();
  console.error(`Unknown snapshot subcommand: ${sub}`);
  console.error('Usage: agentsgate snapshot [list|inspect|delete] [id]');
  process.exit(1);
}
