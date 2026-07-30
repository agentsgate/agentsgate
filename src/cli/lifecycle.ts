import path from 'node:path';
import fs from 'node:fs/promises';
import { MCPProxy, createPipeline } from '../modules/m1-proxy/index.js';
import { MCPStdioProxy } from '../modules/m1-proxy/stdio.js';
import { createApprovalResolver } from './approval-resolver.js';
import { StateStore } from '../modules/m2-store/index.js';
import { OperationLogger } from '../modules/m3-logger/index.js';
import { CheckpointEngine } from '../modules/m4-checkpoint/index.js';
import { FileShadowSystem } from '../modules/m5-shadow/index.js';
import { RiskScoringEngine } from '../modules/m6-risk/index.js';
import { InterventionController } from '../modules/m7-intervention/index.js';
import { RollbackEngine } from '../modules/m8-rollback/index.js';
import { RiskIntelligenceEngine } from '../modules/m11-intelligence/index.js';
import { DashboardAPI, ApprovalQueue } from '../modules/m10-dashboard/index.js';
import { TelemetryService } from '../modules/m13-telemetry/index.js';
import { AgentRateLimiter } from '../utils/rate-limiter.js';
import { loadConfig } from '../config.js';
import { loadPolicy } from '../policy.js';
import { GracefulShutdown } from '../utils/graceful-shutdown.js';
import { MCPServerRegistry } from '../utils/mcp-server-registry.js';
import { SlackNotifier } from '../utils/slack-notifier.js';
import { status as cdStatus, getClaudeDesktopConfigPath } from '../utils/claude-desktop-injector.js';
import { ErrorTracker } from '../utils/error-tracker.js';
import { STATE_DIR, STATE_FILE, DB_FILE, SHADOW_DIR, parseFlag, hasFlag, resolveDbPath, readState, dashFetch } from './shared.js';
import type { ProxyState } from './shared.js';
import { AGENTSGATE_VERSION } from '../version.js';

// ── Commands ──────────────────────────────────────────────────────────────────

export async function cmdStart(args: string[]): Promise<void> {
  // ── Already-running check (parent process only, not the daemon itself) ──
  if (!hasFlag(args, 'daemon')) {
    const existing = await readState();
    if (existing) {
      try {
        process.kill(existing.pid, 0); // throws if process is gone
        console.error('AgentsGate is already running.');
        console.error(`  PID:       ${existing.pid}`);
        console.error(`  Proxy:     http://localhost:${existing.port}`);
        console.error(`  Dashboard: http://localhost:${existing.dashboardPort}`);
        console.error('\nTo stop it: agentsgate stop');
        process.exit(1);
      } catch {
        // Stale state file — remove it and proceed
        await fs.unlink(STATE_FILE).catch(() => {});
      }
    }
  }

  // ── Daemon mode ────────────────────────────────────────────────────────
  // Default: spawn a detached background process and exit immediately.
  // Pass --foreground to keep the process attached to the terminal instead.
  if (!hasFlag(args, 'foreground') && !hasFlag(args, 'daemon')) {
    const { spawn } = await import('node:child_process');
    const scriptPath = process.argv[1]!;
    const child = spawn(process.execPath, [scriptPath, 'start', '--daemon', ...args], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    await new Promise<void>((resolve) => {
      const done = () => {
        // Destroy pipes before resolving — open pipe handles keep the parent alive
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
        resolve();
      };
      let settled = false;
      const once = () => { if (!settled) { settled = true; done(); } };

      child.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        process.stdout.write(text);
        if (text.includes('AgentsGate v')) once();
      });
      child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk));
      child.on('exit', once);
      setTimeout(once, 8000);
    });
    return;
  }

  // Remove internal daemon/foreground flags before further parsing
  const filteredArgs = args.filter(a => a !== '--daemon' && a !== '--foreground');

  const configPath = parseFlag(filteredArgs, 'config');
  const policyPath = parseFlag(filteredArgs, 'policy');
  const isDryRun = hasFlag(filteredArgs, 'dry-run');
  const logTtlStr = parseFlag(filteredArgs, 'log-ttl');
  const logTtlMs = logTtlStr ? parseInt(logTtlStr, 10) : undefined;
  const team = parseFlag(filteredArgs, 'team');
  const config = await loadConfig(configPath);
  if (team) config.team = team;
  const dbPath = resolveDbPath(config.team);
  const policy = await loadPolicy(policyPath);

  // CLI port arg overrides config
  const portArg = filteredArgs.find(a => /^\d+$/.test(a));
  const port = portArg ? parseInt(portArg, 10) : config.proxy.port;
  if (isNaN(port) || port < 1 || port > 65535) {
    console.error(`Invalid port: ${portArg}`);
    process.exit(1);
  }

  const errorTracker = new ErrorTracker({ maxSize: 200 });

  const store = new StateStore(dbPath);
  await store.initialize();

  // Prune logs older than the TTL if configured
  if (logTtlMs && logTtlMs > 0) {
    const pruned = store.pruneOldLogs(logTtlMs);
    if (pruned > 0) console.log(`[start] Pruned ${pruned} operation log(s) older than ${logTtlMs}ms.`);
  }

  const shadow = new FileShadowSystem();
  await shadow.initialize(SHADOW_DIR);

  const logger = new OperationLogger(store, config.audit?.signingSecret);
  const checkpoints = new CheckpointEngine(store, shadow);
  const riskEngine = new RiskScoringEngine();
  // Policy thresholds override config thresholds when present
  const interventionController = new InterventionController({
    allowBelow: policy.thresholds?.allowBelow ?? config.intervention.allowBelow,
    blockAtOrAbove: policy.thresholds?.blockAtOrAbove ?? config.intervention.blockAtOrAbove,
  });
  const intelligenceEngine = new RiskIntelligenceEngine({
    store,
    communityEndpoint: config.intelligence?.communityEndpoint,
  });
  const telemetry = new TelemetryService();
  const rollback = new RollbackEngine(checkpoints, shadow);

  const dashboardPort = port + 1;
  // Late-binding SSE callback — set after dashboard is created (T273)
  let onApprovalExpire: ((approval: { id: string; operation: { id: string } }) => void) | undefined;
  const approvalQueue = new ApprovalQueue({
    webhookUrl: config.webhook?.url,
    webhookSecret: config.webhook?.secret,
    dashboardBaseUrl: `http://localhost:${dashboardPort}`,
    store,
    maxAgeMs: config.approvals?.maxAgeMs,
    onExpire: (a) => onApprovalExpire?.(a),
  });
  await approvalQueue.initialize();

  const rateLimiter = config.rateLimit?.enabled
    ? new AgentRateLimiter(config.rateLimit.maxOpsPerMinute)
    : undefined;

  const slackNotifier = config.webhook?.slackUrl
    ? new SlackNotifier({ webhookUrl: config.webhook.slackUrl })
    : undefined;

  const expiredSessions = new Set<string>();

  const dashboard = new DashboardAPI(store, {
    queue: approvalQueue,
    intelligenceEngine,
    rollbackEngine: rollback,
    telemetry,
    apiKey: config.dashboard?.apiKey,
    roles: config.dashboard?.roles,
    // Fall back to the bind address so a non-loopback deployment still answers
    // to the name it is reached by, without the operator having to restate it.
    allowedHosts: config.dashboard?.allowedHosts,
    onSessionExpire: (id) => { expiredSessions.add(id); },
    rateLimiter: rateLimiter ?? undefined,
    config,
    errorTracker,
  });
  // Wire T273: push SSE event when approvals expire
  onApprovalExpire = (a) => {
    dashboard.notify('approval_expired', JSON.stringify({ id: a.id, operationId: a.operation.id }));
  };

  const proxy = new MCPProxy(
    createPipeline({
      riskEngine,
      interventionController,
      checkpointEngine: checkpoints,
      checkpointThreshold: config.proxy.checkpointThreshold,
      logger,
      intelligenceEngine,
      approvalQueue,
      telemetry,
      rateLimiter,
      policy: policy.rules.length > 0 ? policy : undefined,
      expiredSessions,
      dryRun: isDryRun,
      errorTracker,
      onOperation: (op, dec) => {
        // Push live event to SSE watchers
        dashboard.notify('operation', JSON.stringify({
          id: op.id, agentId: op.agentId, tool: op.tool, method: op.method,
          action: dec.action, riskScore: dec.riskScore,
          sessionId: op.sessionId, timestamp: op.timestamp,
          tags: op.tags,
        }));
        // Track rule hit counts for GET /policy/stats
        if (dec.firedRules && dec.firedRules.length > 0) {
          dashboard.recordFiredRules(dec.firedRules.map(r => r.id));
        }
        if (slackNotifier) void slackNotifier.notify(op, dec).catch(() => {});
      },
    })
  );

  const bindHost = config.proxy.host ?? '127.0.0.1';
  const isLoopback = bindHost === '127.0.0.1' || bindHost === '::1' || bindHost === 'localhost';
  if (!isLoopback) {
    // The M1 proxy transport has no built-in auth; the dashboard's is opt-in.
    // Warn loudly when exposing either beyond loopback without an API key.
    console.warn(`⚠️  SECURITY: binding to non-loopback host "${bindHost}".`);
    console.warn('    The proxy transport is UNAUTHENTICATED — put an authenticating reverse proxy in front.');
    if (!config.dashboard?.apiKey) {
      console.warn('    The dashboard has NO apiKey configured — it will be reachable with full admin access.');
    }
  }
  await dashboard.start(dashboardPort, bindHost);
  await proxy.start(port, bindHost);

  if (isDryRun) {
    console.log('⚠️  DRY-RUN MODE: all operations will be forwarded regardless of risk assessment.');
  }

  // Set up telemetry periodic export + anomaly webhook if configured
  let telemetryTimer: ReturnType<typeof setInterval> | undefined;
  if (config.telemetry?.exportEndpoint) {
    const interval = config.telemetry.exportIntervalMs ?? 300_000;
    let consecutiveExportFailures = 0;
    telemetryTimer = setInterval(() => {
      void telemetry.exportTo(config.telemetry!.exportEndpoint)
        .then(() => { consecutiveExportFailures = 0; })
        .catch((err: unknown) => {
          consecutiveExportFailures++;
          if (consecutiveExportFailures >= 3) {
            console.warn(`[agentsgate] telemetry export failed ${consecutiveExportFailures}x: ${String(err)}`);
          }
        });
      if (config.telemetry?.anomalyWebhookUrl) {
        void telemetry.checkAndNotify(
          config.telemetry.anomalyWebhookUrl,
          undefined,
          config.telemetry.anomalyZScoreThreshold,
          config.webhook?.secret
        ).catch(() => {});
      }
    }, interval);
  }

  if (config.telemetry?.otlpEndpoint) {
    const otlpInterval = config.telemetry.otlpExportIntervalMs ?? config.telemetry.exportIntervalMs ?? 300_000;
    let consecutiveOtlpFailures = 0;
    setInterval(async () => {
      const result = await telemetry.exportOTLP(config.telemetry!.otlpEndpoint!).catch((err: unknown) => ({ ok: false, error: String(err) }));
      if (!result.ok) {
        consecutiveOtlpFailures++;
        if (consecutiveOtlpFailures >= 3) {
          console.warn(`[agentsgate] OTLP export failed ${consecutiveOtlpFailures}x: ${result.error}`);
        }
      } else {
        consecutiveOtlpFailures = 0;
      }
    }, otlpInterval);
  }

  await fs.mkdir(STATE_DIR, { recursive: true });
  const state: ProxyState = { pid: process.pid, port, dashboardPort, startedAt: new Date().toISOString() };
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));

  // Auto-prune old operation logs based on retention config
  if (config.logs?.retentionDays) {
    const cutoff = new Date(Date.now() - config.logs.retentionDays * 24 * 60 * 60 * 1000);
    void store.pruneOperationLogs(cutoff).catch(() => {});
  }

  console.log(`AgentsGate v${AGENTSGATE_VERSION} started`);
  console.log(`  Proxy:     http://localhost:${port}`);
  console.log(`  Dashboard: http://localhost:${dashboardPort}`);
  console.log(`  Database:  ${dbPath}`);
  if (config.webhook?.url) console.log(`  Webhook:   ${config.webhook.url}`);
  if (rateLimiter) console.log(`  RateLimit: ${config.rateLimit!.maxOpsPerMinute} ops/min`);
  if (policy.rules.length > 0) console.log(`  Policy:    ${policy.rules.length} custom rule(s)`);
  console.log('Run `agentsgate stop` to stop.\n');

  const shutdown = new GracefulShutdown({
    stopProxy:    async () => proxy.stop(),
    stopDashboard: () => dashboard.stop(),
    flushTelemetry: async () => {
      if (config.telemetry?.exportEndpoint) {
        await telemetry.exportTo(config.telemetry.exportEndpoint).catch(() => {});
      }
      if (config.telemetry?.otlpEndpoint) {
        await telemetry.exportOTLP(config.telemetry.otlpEndpoint).catch(() => {});
      }
    },
    getPendingApprovalCount: async () => approvalQueue.size,
    closeStore:   () => store.close(),
    removeStateFile: () => fs.unlink(STATE_FILE).catch(() => {}),
    clearTimers:  () => clearInterval(telemetryTimer),
    log: (msg) => process.stderr.write(msg + '\n'),
  });
  shutdown.register();
}

export async function cmdStop(): Promise<void> {
  const state = await readState();
  if (!state) { console.log('AgentsGate is not running.'); return; }
  try {
    process.kill(state.pid, 'SIGINT');
    console.log(`Sent stop signal to PID ${state.pid}`);
  } catch {
    console.log('Process not found — removing stale state file.');
    await fs.unlink(STATE_FILE).catch(() => {});
  }
}

export async function cmdStatus(args: string[] = []): Promise<void> {
  const team = parseFlag(args, 'team');
  const dbPath = resolveDbPath(team);
  const state = await readState();
  if (!state) { console.log('AgentsGate is STOPPED'); return; }

  let running = false;
  try { process.kill(state.pid, 0); running = true; } catch { /* not found */ }

  if (running) {
    console.log('AgentsGate is RUNNING');
    console.log(`  PID:       ${state.pid}`);
    console.log(`  Proxy:     http://localhost:${state.port}`);
    console.log(`  Dashboard: http://localhost:${state.dashboardPort}`);
    console.log(`  Started:   ${state.startedAt}`);
    console.log(`  Database:  ${dbPath}`);
  } else {
    console.log('AgentsGate is STOPPED (stale state file)');
    await fs.unlink(STATE_FILE).catch(() => {});
  }
}

export async function cmdSession(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub === 'expire') {
    const sessionId = args[1];
    if (!sessionId) { console.error('Usage: agentsgate session expire <sessionId>'); process.exit(1); }
    const state = await readState();
    if (!state) { console.error('AgentsGate is not running.'); process.exit(1); }
    const { body } = await dashFetch(state.dashboardPort, 'POST', `/sessions/${encodeURIComponent(sessionId)}/expire`);
    const result = body as { sessionId: string; status: string };
    console.log(`Session ${result.sessionId} status: ${result.status}`);
    console.log('All future operations from this session will be blocked.');
  } else {
    console.error('Usage: agentsgate session expire <sessionId>');
    process.exit(1);
  }
}

export async function cmdConfig(args: string[]): Promise<void> {
  const sub = args.find(a => !a.startsWith('--'));

  // T271: config show — fetch from live dashboard (sanitized, secrets redacted)
  if (sub === 'show') {
    const state = await readState();
    if (!state) {
      console.error('AgentsGate is not running. Use `agentsgate config` (offline) to view local config file.');
      process.exit(1);
    }
    const { status, body } = await dashFetch(state.dashboardPort, 'GET', '/config');
    if (status === 503) { console.error('Dashboard has no config exposed.'); process.exit(1); }
    if (status !== 200) { console.error(`Dashboard returned ${status}`); process.exit(1); }
    console.log('Live configuration (secrets redacted):\n');
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  const configPath = parseFlag(args, 'config');
  const config = await loadConfig(configPath);
  console.log('Effective configuration:\n');
  console.log(JSON.stringify(config, null, 2));
}

/**
 * `agentsgate proxy -- <command> [args...]`
 * Starts a stdio MCP proxy that wraps the given MCP server command.
 * All tools/call requests are risk-assessed before being forwarded.
 *
 * Example (Claude Desktop mcp_servers.json):
 *   {
 *     "filesystem": {
 *       "command": "agentsgate",
 *       "args": ["proxy", "--", "npx", "@modelcontextprotocol/server-filesystem", "/home/user"]
 *     }
 *   }
 */
export async function cmdProxy(args: string[]): Promise<void> {
  const configPath  = parseFlag(args, 'config');
  const policyPath  = parseFlag(args, 'policy');
  const agentId     = parseFlag(args, 'agentId') ?? 'stdio-client';
  const serverName  = parseFlag(args, 'server');

  // Sub-command: agentsgate proxy discover
  if (args[0] === 'discover') {
    const registry = new MCPServerRegistry();
    const servers  = await registry.discover();
    if (!servers.length) {
      console.log('No MCP servers discovered. Check your Claude Desktop config or add a .mcp.json.');
      return;
    }
    console.log(`Discovered ${servers.length} MCP server(s):\n`);
    for (const s of servers) {
      const cmd = MCPServerRegistry.toCommandArray(s).join(' ');
      console.log(`  ${s.name.padEnd(24)} ${cmd}`);
      console.log(`  ${' '.repeat(24)} (from ${s.sourceFile})`);
    }
    return;
  }

  let serverCommand: string[];

  if (serverName) {
    // Auto-discover and select a named server
    const registry = new MCPServerRegistry();
    const servers  = await registry.discover();
    const found    = servers.find(s => s.name === serverName);
    if (!found) {
      const names = servers.map(s => s.name).join(', ') || '(none)';
      console.error(`Server '${serverName}' not found. Discovered: ${names}`);
      process.exit(1);
    }
    serverCommand = MCPServerRegistry.toCommandArray(found);
    process.stderr.write(`[agentsgate] Using discovered server: ${serverName} → ${serverCommand.join(' ')}\n`);
  } else {
    // Everything after -- is the server command
    const sepIdx = args.indexOf('--');
    if (sepIdx === -1 || sepIdx === args.length - 1) {
      console.error('Usage: agentsgate proxy [--server=<name>] [options] -- <server-command> [args...]');
      console.error('       agentsgate proxy discover   (list discovered MCP servers)');
      console.error('Example: agentsgate proxy -- npx @modelcontextprotocol/server-filesystem /data');
      console.error('Example: agentsgate proxy --server=filesystem');
      process.exit(1);
    }
    serverCommand = args.slice(sepIdx + 1);
  }

  const config = await loadConfig(configPath);
  const policy = await loadPolicy(policyPath);

  const store = new StateStore(DB_FILE);
  await store.initialize();

  const shadow = new FileShadowSystem();
  await shadow.initialize(SHADOW_DIR);

  const logger  = new OperationLogger(store);
  const checks  = new CheckpointEngine(store, shadow);
  const risk    = new RiskScoringEngine();
  const intv    = new InterventionController({
    allowBelow:     policy.thresholds?.allowBelow     ?? config.intervention.allowBelow,
    blockAtOrAbove: policy.thresholds?.blockAtOrAbove ?? config.intervention.blockAtOrAbove,
  });
  const intel   = new RiskIntelligenceEngine({ store, communityEndpoint: config.intelligence?.communityEndpoint });
  const telem   = new TelemetryService();
  const rateLimiter = config.rateLimit?.enabled ? new AgentRateLimiter(config.rateLimit.maxOpsPerMinute) : undefined;

  const pipeline = createPipeline({
    riskEngine: risk,
    interventionController: intv,
    checkpointEngine: checks,
    checkpointThreshold: config.proxy.checkpointThreshold,
    logger,
    intelligenceEngine: intel,
    telemetry: telem,
    rateLimiter,
    policy: policy.rules.length > 0 ? policy : undefined,
  });

  // Holds a require_approval operation until the dashboard — another process,
  // sharing this database — answers. Denies on timeout.
  const awaitApproval = createApprovalResolver({
    store,
    timeoutMs: config.approvals?.waitTimeoutMs ?? 60_000,
  });

  const proxy = new MCPStdioProxy({
    command: serverCommand,
    evaluateRisk: pipeline.evaluateRisk!,
    agentId,
    awaitApproval,
    onIntercept: (op, dec) => {
      // Write to stderr so it doesn't pollute the JSON-RPC stdout stream
      process.stderr.write(
        `[agentsgate] ${dec.action.toUpperCase().padEnd(16)} ${(dec.riskScore * 100).toFixed(0).padStart(3)}%  ${op.method}\n`
      );
    },
  });

  await proxy.start();
  await store.close();
}

// ── T137: agentsgate doctor ───────────────────────────────────────────────────

export async function cmdDoctor(args: string[]): Promise<void> {
  const configFlag = parseFlag(args, 'config');
  const policyFlag = parseFlag(args, 'policy');

  interface Check { label: string; ok: boolean; detail?: string }
  const checks: Check[] = [];

  const pass = (label: string, detail?: string) => checks.push({ label, ok: true,  detail });
  const fail = (label: string, detail?: string) => checks.push({ label, ok: false, detail });

  // 1. Config file
  try {
    const config = await loadConfig(configFlag);
    pass('Config file', `port=${config.proxy.port} dashboard=${config.proxy.port + 1}`);
  } catch (err) {
    fail('Config file', (err as Error).message);
  }

  // 2. Policy file
  try {
    const policy = await loadPolicy(policyFlag);
    pass('Policy file', `${policy.rules.length} rule(s) loaded`);
  } catch (err) {
    fail('Policy file', (err as Error).message);
  }

  // 3. State directory
  try {
    await fs.access(STATE_DIR);
    pass('State directory', STATE_DIR);
  } catch {
    fail('State directory', `not found: ${STATE_DIR}`);
  }

  // 4. SQLite DB
  try {
    const store = new StateStore(DB_FILE);
    await store.initialize();
    const logs = await store.listOperationLogs(1, 0);
    await store.close();
    pass('SQLite database', `${DB_FILE} (accessible, ${logs.length === 0 ? 'empty' : 'has records'})`);
  } catch (err) {
    fail('SQLite database', (err as Error).message);
  }

  // 5. Shadow repo
  try {
    await fs.access(path.join(SHADOW_DIR, '.git'));
    pass('Shadow git repo', SHADOW_DIR);
  } catch {
    fail('Shadow git repo', `not initialised: ${SHADOW_DIR} (run agentsgate start once to create)`);
  }

  // 6. Running proxy process
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf-8');
    const state = JSON.parse(raw) as ProxyState;
    // Check if the PID is still alive
    try {
      process.kill(state.pid, 0); // 0 = signal-free existence check
      pass('Proxy process', `pid=${state.pid} port=${state.port} dashboard=${state.dashboardPort}`);
    } catch {
      fail('Proxy process', `pid=${state.pid} from state file is not running`);
    }
  } catch {
    fail('Proxy process', 'not running (no state file found)');
  }

  // 7. Claude Desktop config
  try {
    const cdPath = getClaudeDesktopConfigPath();
    await fs.access(cdPath);
    const statuses = await cdStatus(cdPath);
    const injected = statuses.filter(s => s.injected).length;
    pass('Claude Desktop config', `${statuses.length} server(s), ${injected} injected`);
  } catch {
    fail('Claude Desktop config', 'not found (Claude Desktop may not be installed)');
  }

  // ── Print results ────────────────────────────────────────────────────────────
  console.log('\nAgentsGate Doctor\n');
  let allOk = true;
  for (const c of checks) {
    const icon = c.ok ? '✓' : '✗';
    const label = c.label.padEnd(26);
    console.log(`  ${icon} ${label}${c.detail ?? ''}`);
    if (!c.ok) allOk = false;
  }
  console.log('');
  if (allOk) {
    console.log('All checks passed.');
  } else {
    console.log('Some checks failed. Review the items marked ✗ above.');
    process.exit(1);
  }
}
