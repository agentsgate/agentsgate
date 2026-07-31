// ── Web Dashboard HTML ────────────────────────────────────────────────────────

export const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AgentsGate Dashboard</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  /* ─── theme variables ────────────────────────────────────────────────────── */
  :root {
    --bg:         #0f172a;
    --surface:    #1e293b;
    --surface2:   #162032;
    --border:     #334155;
    --text:       #e2e8f0;
    --text-head:  #f8fafc;
    --text-muted: #94a3b8;
    --text-dim:   #64748b;
    --text-faint: #475569;
    --hover-row:  #1a2840;
    --approval-bg: #1c170a;
    --approval-hover: #24200e;
    --toolbar-bg: #162032;
    --dialog-bg:  #1e293b;
    --dialog-border: #475569;
    --cancel-bg:  #334155;
    --cancel-text: #e2e8f0;
  }
  :root.light {
    --bg:         #f1f5f9;
    --surface:    #ffffff;
    --surface2:   #f8fafc;
    --border:     #cbd5e1;
    --text:       #1e293b;
    --text-head:  #0f172a;
    --text-muted: #475569;
    --text-dim:   #64748b;
    --text-faint: #94a3b8;
    --hover-row:  #f0f4f8;
    --approval-bg: #fffbeb;
    --approval-hover: #fef3c7;
    --toolbar-bg: #f8fafc;
    --dialog-bg:  #ffffff;
    --dialog-border: #cbd5e1;
    --cancel-bg:  #e2e8f0;
    --cancel-text: #1e293b;
  }
  body { font-family: system-ui, sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; transition: background 0.2s, color 0.2s; }
  header { background: var(--surface); border-bottom: 1px solid var(--border); padding: 14px 24px; display: flex; align-items: center; gap: 12px; }
  header h1 { font-size: 1.15rem; font-weight: 700; color: var(--text-head); }
  header .badge { font-size: 0.7rem; background: #0ea5e9; color: #fff; padding: 2px 8px; border-radius: 999px; }
  .status-dot { width: 8px; height: 8px; border-radius: 50%; background: #22c55e; flex-shrink: 0; animation: pulse 2s infinite; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
  /* ─── theme toggle button ────────────────────────────────────────────────── */
  #theme-toggle { background: var(--surface2); border: 1px solid var(--border); color: var(--text-muted); border-radius: 6px; padding: 4px 9px; cursor: pointer; font-size: 0.78rem; line-height: 1.4; transition: background 0.15s; }
  #theme-toggle:hover { background: var(--border); }
  main { padding: 20px 24px; display: grid; gap: 20px; max-width: 1280px; margin: 0 auto; }
  /* ─── stat cards ─────────────────────────────────────────────────────────── */
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; }
  .card.alert { border-color: #f59e0b; }
  .card .label { font-size: 0.72rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 6px; }
  .card .value { font-size: 1.75rem; font-weight: 700; color: var(--text-head); }
  /* ─── sections ───────────────────────────────────────────────────────────── */
  section { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
  .section-head { display: flex; align-items: center; justify-content: space-between; padding: 10px 16px; border-bottom: 1px solid var(--border); }
  .section-head h2 { font-size: 0.82rem; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.06em; }
  .section-head .count-badge { font-size: 0.7rem; background: var(--border); color: var(--text-muted); padding: 1px 7px; border-radius: 999px; }
  .section-head .count-badge.warn { background: #7c3e0a; color: #fde68a; }
  /* ─── tables ─────────────────────────────────────────────────────────────── */
  table { width: 100%; border-collapse: collapse; font-size: 0.83rem; }
  th { text-align: left; padding: 7px 14px; color: var(--text-dim); font-weight: 500; border-bottom: 1px solid var(--bg); background: var(--surface2); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em; }
  td { padding: 8px 14px; border-bottom: 1px solid var(--bg); vertical-align: middle; }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: var(--hover-row); }
  /* ─── risk pills ─────────────────────────────────────────────────────────── */
  .risk-pill { display: inline-block; padding: 2px 7px; border-radius: 4px; font-size: 0.72rem; font-weight: 700; font-variant-numeric: tabular-nums; }
  .risk-low  { background: #14532d; color: #86efac; }
  .risk-med  { background: #713f12; color: #fde68a; }
  .risk-high { background: #7f1d1d; color: #fca5a5; }
  /* ─── action colours ────────────────────────────────────────────────────── */
  .action-allow    { color: #4ade80; font-weight: 600; }
  .action-block    { color: #f87171; font-weight: 600; }
  .action-approval { color: #facc15; font-weight: 600; }
  .badge-allow    { background: rgba(74,222,128,.18); color: #4ade80; padding: 2px 7px; border-radius: 4px; font-size: .78rem; font-weight: 600; }
  .badge-block    { background: rgba(248,113,113,.18); color: #f87171; padding: 2px 7px; border-radius: 4px; font-size: .78rem; font-weight: 600; }
  .badge-require_approval { background: rgba(250,204,21,.18); color: #facc15; padding: 2px 7px; border-radius: 4px; font-size: .78rem; font-weight: 600; }
  /* ─── approvals ──────────────────────────────────────────────────────────── */
  .approval-row td { background: var(--approval-bg); }
  .approval-row:hover td { background: var(--approval-hover); }
  .approval-row.expiring-soon td { background: rgba(251,191,36,0.12); }
  .approval-row.expired td { opacity: 0.5; }
  .countdown { font-size: 0.75rem; font-variant-numeric: tabular-nums; color: var(--text-muted); }
  .countdown.warn  { color: #f59e0b; font-weight: 700; }
  .countdown.crit  { color: #ef4444; font-weight: 700; }
  .countdown.done  { color: var(--text-faint); }
  .rules-list { margin-top: 3px; font-size: 0.72rem; color: var(--text-dim); }
  /* ─── buttons ────────────────────────────────────────────────────────────── */
  .btn { display: inline-block; border: none; padding: 4px 11px; border-radius: 4px; cursor: pointer; font-size: 0.78rem; font-weight: 600; }
  .btn-approve { background: #16a34a; color: #fff; margin-right: 4px; }
  .btn-deny    { background: #dc2626; color: #fff; margin-right: 4px; }
  .btn-rollback { background: #7c3aed; color: #fff; }
  .btn:hover { opacity: 0.85; }
  .btn-secondary { background: var(--bg-card); border: 1px solid var(--border); color: var(--text); padding: .35rem .75rem; border-radius: 5px; cursor: pointer; font-size: .85rem; }
  .btn-secondary:hover { background: var(--bg-row, rgba(255,255,255,.06)); }
  /* ─── toolbar ────────────────────────────────────────────────────────────── */
  .toolbar { display: flex; align-items: center; gap: 10px; padding: 8px 14px; border-bottom: 1px solid var(--border); font-size: 0.75rem; color: var(--text-faint); background: var(--toolbar-bg); }
  .toolbar select, .toolbar input { background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 4px; padding: 3px 7px; font-size: 0.75rem; }
  /* ─── misc ───────────────────────────────────────────────────────────────── */
  .empty { padding: 28px; text-align: center; color: var(--text-faint); font-size: 0.83rem; }
  .mono { font-family: ui-monospace, monospace; font-size: 0.78rem; }
  .ts { color: var(--text-dim); font-size: 0.75rem; white-space: nowrap; }
  .truncate { max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* ─── expandable operation detail ────────────────────────────────────────── */
  .op-row { cursor: pointer; }
  .op-row:hover td { background: var(--hover-row); }
  .op-row.correlated td { background: rgba(99,102,241,.12); outline: 1px solid rgba(99,102,241,.35); }
  .op-row td:first-child::before { content: '▶'; font-size: 0.6rem; color: var(--text-dim); margin-right: 5px; display: inline-block; transition: transform 0.15s; }
  .op-row.expanded td:first-child::before { transform: rotate(90deg); }
  .detail-row td { background: var(--surface2); padding: 0; }
  .detail-row.hidden { display: none; }
  .detail-panel { padding: 10px 16px 12px 32px; }
  .detail-panel h4 { font-size: 0.7rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 8px; }
  .rule-table { width: 100%; border-collapse: collapse; font-size: 0.75rem; }
  .rule-table th { text-align: left; padding: 3px 8px; color: var(--text-dim); font-weight: 500; }
  .rule-table td { padding: 3px 8px; color: var(--text); border-top: 1px solid var(--border); }
  .rule-score-bar { display: inline-block; height: 6px; border-radius: 3px; vertical-align: middle; margin-right: 5px; }
  .detail-reasons { margin-top: 8px; font-size: 0.73rem; color: var(--text-muted); }
  .detail-reasons span { display: block; padding: 1px 0; }
  /* ─── session comparison ─────────────────────────────────────────────────── */
  .compare-toolbar { display: flex; align-items: center; gap: 12px; padding: 10px 16px; border-bottom: 1px solid var(--border); font-size: 0.78rem; color: var(--text-muted); background: var(--toolbar-bg); flex-wrap: wrap; }
  .compare-toolbar select { background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 4px; padding: 3px 7px; font-size: 0.78rem; }
  .compare-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0; }
  .compare-col { padding: 14px 16px; border-right: 1px solid var(--border); }
  .compare-col:last-child { border-right: none; }
  .compare-col h3 { font-size: 0.75rem; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 10px; }
  .compare-stat { display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid var(--border); font-size: 0.82rem; }
  .compare-stat:last-child { border-bottom: none; }
  .compare-stat .label { color: var(--text-muted); }
  .compare-stat .val { font-weight: 600; color: var(--text); font-variant-numeric: tabular-nums; }
  .compare-stat .val.better { color: #4ade80; }
  .compare-stat .val.worse  { color: #f87171; }
  /* ─── heatmap ────────────────────────────────────────────────────────────── */
  .heatmap-wrap { overflow-x: auto; padding: 4px 0; }
  .heatmap-table { border-collapse: collapse; font-size: 0.72rem; }
  .heatmap-table th { padding: 4px 10px; font-weight: 600; color: var(--text-muted); text-align: center; white-space: nowrap; }
  .heatmap-table th.row-head { text-align: left; color: var(--text); font-family: ui-monospace, monospace; }
  .heatmap-table td { width: 72px; height: 32px; text-align: center; font-variant-numeric: tabular-nums; font-size: 0.7rem; font-weight: 600; border: 1px solid var(--border); color: #fff; }
  .heatmap-table td.empty-cell { background: var(--bg); color: var(--text-faint); font-size: 0.65rem; font-weight: 400; }
  /* ─── sparkline ──────────────────────────────────────────────────────────── */
  .spark-row { display: flex; align-items: center; gap: 10px; padding: 8px 16px; border-bottom: 1px solid var(--border); }
  .spark-row:last-child { border-bottom: none; }
  .spark-agent { font-family: ui-monospace, monospace; font-size: 0.8rem; width: 160px; flex-shrink: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); }
  .spark-svg { flex: 1; height: 28px; }
  .spark-avg { font-size: 0.75rem; font-variant-numeric: tabular-nums; width: 48px; text-align: right; flex-shrink: 0; }
  /* ─── confirm overlay ────────────────────────────────────────────────────── */
  #overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,.6); z-index: 100; align-items: center; justify-content: center; }
  #overlay.show { display: flex; }
  #diff-modal.show { display: flex; }
  #dialog { background: var(--dialog-bg); border: 1px solid var(--dialog-border); border-radius: 10px; padding: 24px; max-width: 420px; width: 90%; }
  #dialog h3 { font-size: 1rem; margin-bottom: 10px; color: var(--text-head); }
  #dialog p  { font-size: 0.85rem; color: var(--text-muted); margin-bottom: 20px; }
  #dialog .btns { display: flex; justify-content: flex-end; gap: 8px; }
  .level-switch { display: flex; align-items: center; gap: 6px; margin-left: 16px; }
  .level-switch .lbl { font-size: .68rem; color: var(--text-faint); text-transform: uppercase; letter-spacing: .04em; }
  .level-switch .opts { display: flex; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
  .level-switch button { background: none; border: none; padding: 3px 10px; font-size: .74rem; cursor: pointer;
    color: var(--text-muted); font-weight: 500; transition: background .15s, color .15s; }
  .level-switch button + button { border-left: 1px solid var(--border); }
  .level-switch button:hover:not(:disabled) { background: var(--border); color: var(--text); }
  .level-switch button.on { background: var(--accent, #3b82f6); color: #fff; }
  .level-switch button:disabled { cursor: default; opacity: .55; }
  .level-summary { font-size: .68rem; color: var(--text-faint); max-width: 26rem; }
  .tabs { display: flex; gap: 4px; padding: 8px 24px; background: var(--surface); border-bottom: 1px solid var(--border); }
  .tab-btn { background: none; border: none; padding: 6px 14px; border-radius: 6px; cursor: pointer; color: var(--text-muted); font-size: 0.83rem; font-weight: 500; transition: background 0.15s; }
  .tab-btn:hover { background: var(--border); color: var(--text); }
  .tab-btn.active { background: var(--border); color: var(--text-head); }
  .tab-pane { display: none; }
  .tab-pane.active { display: block; }
</style>
</head>
<body>

<!-- Rollback confirmation overlay -->
<div id="overlay">
  <div id="dialog">
    <h3>Confirm Rollback</h3>
    <p id="dialog-msg">Are you sure you want to roll back to this checkpoint?</p>
    <div class="btns">
      <button class="btn" style="background:#334155;color:#e2e8f0" onclick="closeDialog()">Cancel</button>
      <button class="btn btn-rollback" id="dialog-confirm">Confirm Rollback</button>
    </div>
  </div>
</div>

<!-- Checkpoint diff modal -->
<div id="diff-modal" style="position:fixed;inset:0;z-index:200;background:rgba(0,0,0,.6);align-items:center;justify-content:center;display:none">
  <div style="background:var(--card);border-radius:10px;padding:24px;max-width:780px;width:94%;max-height:80vh;overflow-y:auto;position:relative">
    <h3 style="margin:0 0 12px">Checkpoint Diff</h3>
    <div id="diff-body"></div>
    <div style="margin-top:16px;text-align:right">
      <button class="btn" style="background:#334155;color:#e2e8f0" onclick="closeDiff()">Close</button>
    </div>
  </div>
</div>

<header>
  <div class="status-dot" id="dot"></div>
  <h1>AgentsGate</h1>
  <span class="badge">v0.5</span>
  <div id="level-switch" class="level-switch" title="What AgentsGate stops. Policy rules override this."></div>
  <span id="last-updated" style="margin-left:auto;font-size:.72rem;color:var(--text-faint)"></span>
  <button id="theme-toggle" onclick="toggleTheme()" title="Toggle dark/light theme">🌙</button>
</header>

<nav class="tabs">
  <button class="tab-btn active" onclick="showTab('overview', this)">Overview</button>
  <button class="tab-btn" onclick="showTab('agents', this)">Agents</button>
  <button class="tab-btn" onclick="showTab('tools', this)">Tools</button>
  <button class="tab-btn" onclick="showTab('circuit-breakers', this)">Circuit Breakers</button>
  <button class="tab-btn" onclick="showTab('quota', this)">Quota</button>
  <button class="tab-btn" onclick="showTab('rules', this)">Rules</button>
</nav>

<div id="tab-overview" class="tab-pane active">
<main>
  <!-- System Summary (T407) -->
  <section id="summary-section" style="margin-bottom:1.5rem">
    <div class="section-head"><h2>System Summary</h2></div>
    <div class="cards" id="summary-cards">
      <div class="card"><div class="label">Block Rate</div><div class="value" id="sum-block-rate">—</div></div>
      <div class="card"><div class="label">Avg Risk</div><div class="value" id="sum-avg-risk">—</div></div>
      <div class="card"><div class="label">Top Agent</div><div class="value" id="sum-top-agent" style="font-size:1rem">—</div></div>
      <div class="card"><div class="label">Top Tool</div><div class="value" id="sum-top-tool" style="font-size:1rem">—</div></div>
    </div>
  </section>

  <!-- Stat cards -->
  <div class="cards">
    <div class="card"><div class="label">Operations</div><div class="value" id="stat-ops">—</div></div>
    <div class="card"><div class="label">Blocked</div><div class="value" id="stat-blocked" style="color:#f87171">—</div></div>
    <div class="card" id="card-approvals"><div class="label">Pending Approvals</div><div class="value" id="stat-approvals" style="color:#facc15">—</div></div>
    <div class="card"><div class="label">Checkpoints</div><div class="value" id="stat-checkpoints">—</div></div>
    <div class="card"><div class="label">Avg Risk</div><div class="value" id="stat-risk">—</div></div>
  </div>

  <!-- Pending Approvals -->
  <section>
    <div class="section-head">
      <h2>⚠ Pending Approvals</h2>
      <span class="count-badge warn" id="badge-approvals">0</span>
    </div>
    <div id="approvals-body"><div class="empty">No pending approvals</div></div>
  </section>

  <!-- Checkpoints -->
  <section>
    <div class="section-head">
      <h2>Checkpoints</h2>
      <span class="count-badge" id="badge-checkpoints">0</span>
    </div>
    <div id="checkpoints-body"><div class="empty">No checkpoints recorded yet</div></div>
  </section>

  <!-- Sessions -->
  <section>
    <div class="section-head">
      <h2>Sessions</h2>
      <span class="count-badge" id="badge-sessions">0</span>
    </div>
    <div id="sessions-body"><div class="empty">Loading…</div></div>
  </section>

  <!-- Compare Sessions -->
  <section>
    <div class="section-head">
      <h2>Compare Sessions</h2>
    </div>
    <div class="compare-toolbar">
      Session A:
      <select id="cmp-a" onchange="renderComparison()">
        <option value="">— pick session —</option>
      </select>
      vs Session B:
      <select id="cmp-b" onchange="renderComparison()">
        <option value="">— pick session —</option>
      </select>
    </div>
    <div id="compare-body"><div class="empty">Select two sessions above to compare them side-by-side</div></div>
  </section>

  <!-- Risk Trend Sparklines -->
  <section>
    <div class="section-head">
      <h2>Risk Trend by Agent</h2>
      <span class="count-badge" id="badge-sparklines">0</span>
    </div>
    <div id="sparklines-body"><div class="empty">No data yet</div></div>
  </section>

  <!-- Agent × Tool Risk Heatmap -->
  <section>
    <div class="section-head">
      <h2>Agent × Tool Risk Heatmap</h2>
      <span class="count-badge" id="badge-heatmap">0</span>
    </div>
    <div id="heatmap-body"><div class="empty">No data yet</div></div>
  </section>

  <!-- Operations -->
  <section>
    <div class="section-head">
      <h2>Recent Operations</h2>
      <span class="count-badge" id="badge-ops">0</span>
    </div>
    <div class="toolbar">
      Filter:
      <select id="filter-action" title="Filter by action">
        <option value="">All actions</option>
        <option value="allow">allow</option>
        <option value="block">block</option>
        <option value="require_approval">require_approval</option>
      </select>
      <input id="filter-tool" placeholder="tool" style="width:90px" title="Filter by tool">
      <input id="filter-agent" placeholder="agentId" style="width:110px" title="Filter by agentId">
      &nbsp;|&nbsp; Auto-refresh:
      <select id="interval-select">
        <option value="3000">3 s</option>
        <option value="5000" selected>5 s</option>
        <option value="10000">10 s</option>
        <option value="30000">30 s</option>
        <option value="0">Off</option>
      </select>
      &nbsp;|&nbsp;
      <input id="search-ops" placeholder="Search…" style="width:130px" title="Full-text search: agent, tool, method, rules">
      &nbsp;|&nbsp; From:
      <input id="filter-from" type="datetime-local" style="width:160px" title="Show ops after this time">
      To:
      <input id="filter-to" type="datetime-local" style="width:160px" title="Show ops before this time">
      <button onclick="clearTimeRange()" style="font-size:.7rem;padding:2px 6px;background:#334155;color:#e2e8f0;border:none;border-radius:3px;cursor:pointer" title="Clear time range">✕</button>
      &nbsp;|&nbsp;
      <button id="btn-export-csv" title="Download current filtered view as CSV" style="font-size:0.85em;padding:2px 8px;cursor:pointer">⬇ CSV</button>
    </div>
    <div id="ops-body"><div class="empty">Loading…</div></div>
  </section>
</main>
</div>

<div id="tab-agents" class="tab-pane">
  <main>
    <section>
      <div class="section-head"><span>Agents</span></div>
      <div id="agents-body"><div class="empty">Loading…</div></div>
    </section>
  </main>
</div>

<div id="tab-tools" class="tab-pane">
  <main>
    <section>
      <div class="section-head"><span>Tools</span></div>
      <div id="tools-body"><div class="empty">Loading…</div></div>
    </section>
  </main>
</div>

<div id="tab-circuit-breakers" class="tab-pane">
  <main>
    <section>
      <div class="section-head"><span>Circuit Breakers</span></div>
      <div id="cb-body"><div class="empty">Loading…</div></div>
    </section>
  </main>
</div>

<div id="tab-quota" class="tab-pane">
  <main>
    <section>
      <div class="section-head"><span>Quota</span></div>
      <div id="quota-body"><div class="empty">Loading…</div></div>
    </section>
  </main>
</div>

<div id="tab-rules" class="tab-pane">
  <main>
    <section>
      <div class="section-head">
        <h2>Policy Rules</h2>
        <button class="btn-primary" onclick="openRuleModal(null)">+ New Rule</button>
      </div>
      <p style="color:var(--text-faint);font-size:.85rem;margin-bottom:.75rem">
        Policy rules override L1 risk scores or force a specific action. Evaluated in priority order.
        Changes are saved to policy.json immediately.
      </p>
      <div style="overflow-x:auto">
        <table id="policy-rules-table">
          <thead>
            <tr>
              <th>Priority</th><th>ID</th><th>Description</th>
              <th>Tool</th><th>Method</th><th>Action</th><th>Score</th><th>Hits</th>
              <th style="text-align:right">Actions</th>
            </tr>
          </thead>
          <tbody id="policy-rules-body">
            <tr><td colspan="9" style="text-align:center;color:var(--text-faint)">Loading&#x2026;</td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <section style="margin-top:2rem">
      <div class="section-head"><h2>Preset Templates</h2></div>
      <p style="color:var(--text-faint);font-size:.85rem;margin-bottom:.75rem">
        One-click add common protection patterns to your policy. Each preset adds a new rule — review and adjust after adding.
      </p>
      <div style="display:flex;flex-wrap:wrap;gap:.6rem" id="preset-buttons">
        <button onclick="addPreset('fs-delete-block')" class="btn-secondary">🗑️ Block filesystem deletes</button>
        <button onclick="addPreset('gmail-send-approval')" class="btn-secondary">📧 Require approval for email sends</button>
        <button onclick="addPreset('slack-channel-approval')" class="btn-secondary">💬 Require approval for Slack channel posts</button>
        <button onclick="addPreset('readonly-agent')" class="btn-secondary">🔒 Read-only agent lock</button>
        <button onclick="addPreset('trust-internal-email')" class="btn-secondary">✉️ Trust internal email (lower risk)</button>
        <button onclick="addPreset('gcal-delete-block')" class="btn-secondary">📅 Block calendar deletions</button>
      </div>
    </section>

    <section style="margin-top:2rem">
      <div class="section-head"><h2>Built-in L1 Rules (read-only)</h2></div>
      <p style="color:var(--text-faint);font-size:.85rem;margin-bottom:.75rem">
        These rules are always active. Override their scores using policy rules with the same ID pattern,
        or mute them in policy.json via the <code>mutedRules</code> array.
      </p>
      <div style="overflow-x:auto">
        <table id="l1-rules-table">
          <thead>
            <tr><th>ID</th><th>Score</th><th>Layer</th><th>Description</th></tr>
          </thead>
          <tbody id="l1-rules-body">
            <tr><td colspan="4" style="text-align:center;color:var(--text-faint)">Loading&#x2026;</td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <section style="margin-top:2rem">
      <div class="section-head"><h2>Rule Tester</h2></div>
      <p style="color:var(--text-faint);font-size:.85rem;margin-bottom:.75rem">
        Simulate an operation to see which rules fire and what score/action results.
      </p>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;max-width:700px">
        <label>Tool<input id="test-tool" placeholder="e.g. slack" style="width:100%"></label>
        <label>Method<input id="test-method" placeholder="e.g. send_message" style="width:100%"></label>
        <label>Agent ID<input id="test-agent" placeholder="e.g. claude-desktop" style="width:100%"></label>
        <label>Params (JSON)<input id="test-params" placeholder='{"channel":"C123"}' style="width:100%"></label>
      </div>
      <button class="btn-primary" style="margin-top:.75rem" onclick="runRuleTest()">Test</button>
      <pre id="rule-test-result" style="margin-top:1rem;background:var(--bg-card);padding:1rem;border-radius:6px;font-size:.82rem;min-height:60px"></pre>
    </section>
  </main>
</div>

<div id="rule-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:999;align-items:center;justify-content:center" onclick="if(event.target===this)closeRuleModal()">
  <div style="background:var(--bg-card);border-radius:10px;padding:1.5rem;width:min(680px,95vw);max-height:90vh;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,.4)">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem">
      <h2 id="rule-modal-title" style="margin:0">New Rule</h2>
      <button onclick="closeRuleModal()" style="background:none;border:none;font-size:1.4rem;cursor:pointer;color:var(--text)">&#x2715;</button>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:.75rem">
      <label style="grid-column:1/-1">Rule ID *<input id="rf-id" placeholder="MY_RULE_ID" style="width:100%"></label>
      <label style="grid-column:1/-1">Description<input id="rf-desc" placeholder="Human-readable description" style="width:100%"></label>
    </div>

    <h3 style="margin:.75rem 0 .4rem">Match Conditions <span style="font-weight:400;font-size:.8rem;color:var(--text-faint)">(all specified must match)</span></h3>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:.75rem">
      <label>Tool<input id="rf-tool" placeholder="exact or /regex/" style="width:100%"></label>
      <label>Method<input id="rf-method" placeholder="exact or /regex/" style="width:100%"></label>
      <label>Agent ID<input id="rf-agentId" placeholder="exact or /regex/" style="width:100%"></label>
      <label>Path Pattern<input id="rf-pathPattern" placeholder="/secrets/|credentials" style="width:100%"></label>
    </div>

    <div style="margin-top:.75rem">
      <label>Params Match <span style="font-size:.8rem;color:var(--text-faint)">(key=pattern pairs, one per line, exact or /regex/)</span></label>
      <textarea id="rf-paramsMatch" rows="3" placeholder="channel=/^D[A-Z0-9]+/" style="width:100%;font-family:monospace;font-size:.82rem"></textarea>
    </div>

    <h3 style="margin:.75rem 0 .4rem">Effect</h3>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:.75rem">
      <label>Risk Score (0&#x2013;1)<input id="rf-score" type="number" min="0" max="1" step="0.05" placeholder="e.g. 0.3" style="width:100%"></label>
      <label>Force Action
        <select id="rf-action" style="width:100%">
          <option value="">(none &#x2014; use score)</option>
          <option value="allow">allow</option>
          <option value="block">block</option>
          <option value="require_approval">require_approval</option>
        </select>
      </label>
      <label>Priority<input id="rf-priority" type="number" placeholder="100" style="width:100%"></label>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:.75rem;margin-top:.75rem">
      <label>Max Score Cap (0&#x2013;1)<input id="rf-max" type="number" min="0" max="1" step="0.05" placeholder="optional" style="width:100%"></label>
      <label>Redact Keys (comma-sep)<input id="rf-redact" placeholder="password,token" style="width:100%"></label>
    </div>

    <div style="display:flex;gap:.75rem;margin-top:1.25rem;justify-content:flex-end">
      <button onclick="closeRuleModal()" style="padding:.5rem 1rem">Cancel</button>
      <button class="btn-primary" id="rule-modal-test-btn" onclick="testModalRule()" style="padding:.5rem 1rem">Test Rule</button>
      <button class="btn-primary" onclick="saveRuleModal()" style="padding:.5rem 1rem" id="rule-save-btn">Save Rule</button>
    </div>
    <pre id="rule-modal-test-result" style="margin-top:.75rem;display:none;background:var(--bg-card);border:1px solid var(--border);padding:.75rem;border-radius:6px;font-size:.8rem"></pre>
  </div>
</div>

<script>
const BASE = '';

// ── utilities ─────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/\`/g,'&#96;');
}

// ── theme toggle ─────────────────────────────────────────────────────────────

(function initTheme() {
  const stored = localStorage.getItem('as-theme');
  if (stored === 'light') applyTheme('light');
})();

function applyTheme(mode) {
  if (mode === 'light') {
    document.documentElement.classList.add('light');
    const btn = document.getElementById('theme-toggle');
    if (btn) btn.textContent = '☀️';
  } else {
    document.documentElement.classList.remove('light');
    const btn = document.getElementById('theme-toggle');
    if (btn) btn.textContent = '🌙';
  }
}

// ── Protection level ───────────────────────────────────────────────────────
// Rendered from what the server reports rather than from an assumption, so the
// control always shows what is actually in force — including the case where no
// level is configured and the thresholds alone decide, where it shows nothing.
async function loadProtection() {
  const el = document.getElementById('level-switch');
  if (!el) return;
  try {
    const r = await fetch(BASE + '/protection');
    if (!r.ok) { el.innerHTML = ''; return; }
    const p = await r.json();
    if (!p.level) { el.innerHTML = ''; return; }
    const opts = (p.available || []).map(function (name) {
      const on = name === p.level ? ' class="on"' : '';
      const dis = p.editable ? '' : ' disabled';
      return '<button' + on + dis + ' onclick="setProtection(\'' + esc(name) + '\')">' + esc(name) + '</button>';
    }).join('');
    el.innerHTML = '<span class="lbl">level</span><span class="opts">' + opts + '</span>' +
                   '<span class="level-summary">' + esc(p.summary || '') + '</span>';
  } catch (e) { el.innerHTML = ''; }
}

async function setProtection(name) {
  try {
    const r = await fetch(BASE + '/protection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level: name })
    });
    if (!r.ok) {
      const e = await r.json().catch(function () { return {}; });
      alert('Could not change level: ' + (e.error || r.status));
      return;
    }
    await loadProtection();
    loadAll();
  } catch (e) { alert('Could not change level: ' + e.message); }
}

function toggleTheme() {
  const isLight = document.documentElement.classList.contains('light');
  const next = isLight ? 'dark' : 'light';
  localStorage.setItem('as-theme', next);
  applyTheme(next);
}

// ── helpers ──────────────────────────────────────────────────────────────────

function riskClass(score) {
  if (score < 0.3) return 'risk-low';
  if (score < 0.7) return 'risk-med';
  return 'risk-high';
}
function actionClass(a) {
  return a === 'allow' ? 'action-allow' : a === 'block' ? 'action-block' : 'action-approval';
}
function fmtTs(d) {
  if (!d) return '—';
  const dt = new Date(d);
  return dt.toLocaleDateString() + ' ' + dt.toLocaleTimeString();
}
function fmtRisk(score) {
  if (score == null) return '—';
  return (score * 100).toFixed(0) + '%';
}
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/\`/g,'&#96;');
}
async function fetchJSON(path) {
  const r = await fetch(BASE + path);
  if (!r.ok) throw new Error(r.status);
  return r.json();
}

// ── stat cards ───────────────────────────────────────────────────────────────

async function loadAll() {
  try {
    const action = document.getElementById('filter-action').value;
    const tool   = document.getElementById('filter-tool').value.trim();
    const agent  = document.getElementById('filter-agent').value.trim();
    const fromVal = document.getElementById('filter-from').value;
    const toVal   = document.getElementById('filter-to').value;
    let opsUrl = '/operations?limit=200';
    if (action)  opsUrl += '&action=' + encodeURIComponent(action);
    if (tool)    opsUrl += '&tool='   + encodeURIComponent(tool);
    if (agent)   opsUrl += '&agentId='+ encodeURIComponent(agent);
    if (fromVal) opsUrl += '&from='   + encodeURIComponent(new Date(fromVal).toISOString());
    if (toVal)   opsUrl += '&to='     + encodeURIComponent(new Date(toVal).toISOString());

    const [opsResp, appResp, cpResp, sessResp] = await Promise.all([
      fetchJSON(opsUrl),
      fetchJSON('/approvals/pending'),
      fetchJSON('/checkpoints?limit=50'),
      fetchJSON('/sessions'),
    ]);

    const ops      = opsResp.data  || [];
    const approvals = appResp.data || [];
    const checkpoints = cpResp.data || [];
    const sessions = sessResp.data || [];

    // Stats
    const blocked  = ops.filter(o => o.decision?.action === 'block').length;
    const totalRisk = ops.reduce((s, o) => s + (o.decision?.riskScore || 0), 0);
    const avgRisk  = ops.length ? totalRisk / ops.length : 0;

    document.getElementById('stat-ops').textContent        = opsResp.count ?? ops.length;
    document.getElementById('stat-blocked').textContent    = blocked;
    document.getElementById('stat-approvals').textContent  = approvals.length;
    document.getElementById('stat-checkpoints').textContent= checkpoints.length;
    document.getElementById('stat-risk').textContent       = fmtRisk(avgRisk);
    document.getElementById('badge-approvals').textContent = approvals.length;
    document.getElementById('badge-checkpoints').textContent = checkpoints.length;
    document.getElementById('badge-sessions').textContent  = sessions.length;
    document.getElementById('badge-ops').textContent       = ops.length;

    // Highlight approvals card when pending > 0
    document.getElementById('card-approvals').classList.toggle('alert', approvals.length > 0);

    document.getElementById('dot').style.background = '#22c55e';

    _allOps = ops;
    renderApprovals(approvals);
    renderCheckpoints(checkpoints);
    renderSessions(sessions);
    populateSessionDropdowns(sessions);
    renderComparison();
    renderSparklines(ops);
    renderHeatmap(ops);
    renderOps(ops);
    loadSummary();
    document.getElementById('last-updated').textContent = 'Updated ' + new Date().toLocaleTimeString();
  } catch(e) {
    document.getElementById('dot').style.background = '#ef4444';
  }
}

// ── summary (T407) ───────────────────────────────────────────────────────────

async function loadSummary() {
  try {
    const data = await fetchJSON('/operations/summary');
    const blockRate = data.operationCount > 0 ? (data.blockCount / data.operationCount * 100).toFixed(1) + '%' : '0%';
    const avgRisk   = data.avgRiskScore != null ? Number(data.avgRiskScore).toFixed(2) : '—';
    const topAgent  = (data.topAgents && data.topAgents.length > 0)
      ? data.topAgents.slice(0, 3).map(a => esc(a.agentId) + ' (' + a.count + ')').join(', ')
      : '—';
    const topTool   = (data.topTools && data.topTools.length > 0)
      ? data.topTools.slice(0, 3).map(t => esc(t.tool) + ' (' + t.count + ')').join(', ')
      : '—';
    document.getElementById('sum-block-rate').textContent = blockRate;
    document.getElementById('sum-avg-risk').textContent   = avgRisk;
    document.getElementById('sum-top-agent').textContent  = topAgent;
    document.getElementById('sum-top-tool').textContent   = topTool;
  } catch(e) {
    // summary is non-critical — leave placeholders as "—"
  }
}

// ── approvals ────────────────────────────────────────────────────────────────

async function resolveApproval(id, verdict) {
  if (!confirm('Are you sure you want to ' + verdict + ' this operation?')) return;
  try {
    const r = await fetch(BASE + '/approvals/' + id + '/' + verdict, { method: 'POST' });
    if (!r.ok) { const b = await r.json(); alert('Error: ' + b.error); return; }
    await loadAll();
  } catch(e) { alert('Request failed: ' + e.message); }
}

function fmtCountdown(expiresAt) {
  if (!expiresAt) return '';
  const msLeft = new Date(expiresAt).getTime() - Date.now();
  if (msLeft <= 0) return 'Expired';
  const s = Math.floor(msLeft / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return h + 'h ' + (m % 60) + 'm';
  if (m > 0) return m + 'm ' + (s % 60) + 's';
  return s + 's';
}

function countdownClass(expiresAt) {
  if (!expiresAt) return 'countdown';
  const msLeft = new Date(expiresAt).getTime() - Date.now();
  if (msLeft <= 0) return 'countdown done';
  if (msLeft < 60_000) return 'countdown crit';
  if (msLeft < 300_000) return 'countdown warn';
  return 'countdown';
}

let _countdownInterval = null;

function startCountdownTick() {
  clearInterval(_countdownInterval);
  _countdownInterval = setInterval(() => {
    document.querySelectorAll('[data-expires]').forEach(el => {
      const exp = el.getAttribute('data-expires');
      el.textContent = fmtCountdown(exp);
      el.className = countdownClass(exp);
      const row = el.closest('tr');
      if (row) {
        const msLeft = new Date(exp).getTime() - Date.now();
        row.classList.toggle('expiring-soon', msLeft > 0 && msLeft < 300_000);
        row.classList.toggle('expired', msLeft <= 0);
      }
    });
  }, 1000);
}

function renderApprovals(items) {
  const el = document.getElementById('approvals-body');
  if (!items.length) { el.innerHTML = '<div class="empty">No pending approvals — the system is running smoothly</div>'; clearInterval(_countdownInterval); return; }
  el.innerHTML = \`<table><thead><tr>
    <th>ID</th><th>Agent</th><th>Tool · Method</th><th>Risk</th><th>Queued</th><th>Expires</th><th>Actions</th>
  </tr></thead><tbody>\` +
  items.map(a => {
    const risk = a.riskScore ?? 0;
    const rules = (a.operation?.params ? Object.entries(a.operation.params).map(([k,v]) => esc(k) + '=' + esc(String(v))).join(', ') : '');
    const msLeft = a.expiresAt ? new Date(a.expiresAt).getTime() - Date.now() : Infinity;
    const expClass = msLeft <= 0 ? 'expired' : msLeft < 300_000 ? 'expiring-soon' : '';
    return \`<tr class="approval-row \${expClass}">
      <td class="mono truncate" title="\${esc(a.id)}">\${esc(a.id.slice(0,8))}…</td>
      <td class="mono truncate" title="\${esc(a.operation?.agentId||'')}">\${esc(a.operation?.agentId||'—')}</td>
      <td class="mono">\${esc(a.operation?.tool||'—')} · \${esc(a.operation?.method||'—')}\${rules ? '<div class="rules-list">' + rules + '</div>' : ''}</td>
      <td><span class="risk-pill \${riskClass(risk)}">\${fmtRisk(risk)}</span>\${a.checkpointId ? ' <span title="Checkpoint available" style="color:#818cf8;font-size:.7rem">✓ cp</span>':''}</td>
      <td class="ts">\${fmtTs(a.queuedAt)}</td>
      <td><span class="\${countdownClass(a.expiresAt)}" data-expires="\${esc(a.expiresAt||'')}">\${fmtCountdown(a.expiresAt)}</span></td>
      <td>
        <button class="btn btn-approve" onclick="resolveApproval('\${esc(a.id)}','approve')">Approve</button>
        <button class="btn btn-deny"    onclick="resolveApproval('\${esc(a.id)}','deny')">Deny</button>
      </td>
    </tr>\`;
  }).join('') + '</tbody></table>';
  startCountdownTick();
}

// ── checkpoints ───────────────────────────────────────────────────────────────

let _pendingRollbackId = null;

function openDialog(checkpointId) {
  _pendingRollbackId = checkpointId;
  document.getElementById('dialog-msg').textContent =
    'Roll back to checkpoint ' + checkpointId.slice(0,8) + '…? This will restore snapshotted files to their pre-operation state.';
  document.getElementById('overlay').classList.add('show');
}
function closeDialog() {
  _pendingRollbackId = null;
  document.getElementById('overlay').classList.remove('show');
}
document.getElementById('dialog-confirm').onclick = async function() {
  if (!_pendingRollbackId) return;
  const id = _pendingRollbackId;
  closeDialog();
  try {
    const r = await fetch(BASE + '/rollback/' + id, { method: 'POST' });
    const result = await r.json();
    if (result.success) {
      alert('Rollback succeeded — ' + result.restoredFiles.length + ' file(s) restored.');
    } else {
      alert('Rollback failed: ' + (result.error || 'unknown error'));
    }
    await loadAll();
  } catch(e) { alert('Request failed: ' + e.message); }
};

function renderCheckpoints(checkpoints) {
  const el = document.getElementById('checkpoints-body');
  if (!checkpoints.length) { el.innerHTML = '<div class="empty">No checkpoints yet — checkpoints are created automatically before risky operations</div>'; return; }
  el.innerHTML = \`<table><thead><tr>
    <th>ID</th><th>Operation</th><th>Files</th><th>Created</th><th>Actions</th>
  </tr></thead><tbody>\` +
  checkpoints.map(cp => \`<tr>
    <td class="mono truncate" title="\${esc(cp.id)}">\${esc(cp.id.slice(0,8))}…</td>
    <td class="mono truncate" title="\${esc(cp.operationId)}">\${esc(cp.operationId.slice(0,8))}…</td>
    <td>\${cp.fileSnapshots?.length ?? 0}</td>
    <td class="ts">\${fmtTs(cp.createdAt)}</td>
    <td>
      <button class="btn btn-rollback" onclick="openDialog('\${esc(cp.id)}')">Rollback</button>
      <button class="btn" style="margin-left:4px;background:#334155;color:#e2e8f0" onclick="openDiff('\${esc(cp.id)}')">Diff</button>
    </td>
  </tr>\`).join('') + '</tbody></table>';
}

async function openDiff(checkpointId) {
  const el = document.getElementById('diff-modal');
  const body = document.getElementById('diff-body');
  el.classList.add('show');
  body.innerHTML = '<div class="empty">Loading…</div>';
  try {
    const r = await fetch(BASE + '/checkpoints/' + checkpointId + '/diff');
    const data = await r.json();
    if (!r.ok) { body.innerHTML = '<div class="empty">Error: ' + esc(data.error) + '</div>'; return; }
    const summary = data.summary;
    const rows = data.files.map(f => {
      const color = f.status === 'unchanged' ? '#4ade80' : f.status === 'modified' ? '#f59e0b' : '#ef4444';
      return \`<tr>
        <td class="mono truncate" title="\${esc(f.path)}">\${esc(f.path)}</td>
        <td style="color:\${color};font-weight:600">\${esc(f.status)}</td>
        <td class="mono" style="font-size:.7rem">\${esc((f.snapshotHash||'').slice(0,12))}</td>
        <td class="mono" style="font-size:.7rem">\${esc((f.currentHash||'—').slice(0,12))}</td>
      </tr>\`;
    }).join('');
    body.innerHTML = \`<div style="margin-bottom:8px;font-size:.8rem;color:#94a3b8">
      \${summary.total} file(s) — <span style="color:#4ade80">\${summary.unchanged} unchanged</span>
      · <span style="color:#f59e0b">\${summary.modified} modified</span>
      · <span style="color:#ef4444">\${summary.missing} missing</span>
    </div>
    <table><thead><tr><th>Path</th><th>Status</th><th>Snapshot hash</th><th>Current hash</th></tr></thead>
    <tbody>\${rows || '<tr><td colspan="4" class="empty">No files in checkpoint</td></tr>'}</tbody></table>\`;
  } catch(e) { body.innerHTML = '<div class="empty">Request failed: ' + esc(e.message) + '</div>'; }
}
function closeDiff() { document.getElementById('diff-modal').classList.remove('show'); }

// ── sessions ──────────────────────────────────────────────────────────────────

function renderSessions(sessions) {
  const el = document.getElementById('sessions-body');
  if (!sessions.length) { el.innerHTML = '<div class="empty">No sessions recorded yet</div>'; return; }

  // Build per-session risk score arrays from _allOps (last 20 ops, chronological)
  const scoresBySession = new Map();
  for (const o of [..._allOps].reverse()) {
    const sid = o.operation?.sessionId;
    if (!sid) continue;
    if (!scoresBySession.has(sid)) scoresBySession.set(sid, []);
    const arr = scoresBySession.get(sid);
    if (arr.length < 20) arr.push(o.decision?.riskScore ?? 0);
  }

  el.innerHTML = \`<table><thead><tr>
    <th>Session</th><th>Agent</th><th>Ops</th><th>Allowed</th><th>Blocked</th><th>Pending</th><th>Risk trend</th><th>Last seen</th>
  </tr></thead><tbody>\` +
  sessions.map(s => {
    const scores = scoresBySession.get(s.sessionId) ?? [];
    const spark = scores.length >= 2 ? sparklineSVG(scores) : '<span style="color:var(--text-faint);font-size:.72rem">—</span>';
    return \`<tr>
      <td class="mono truncate" title="\${esc(s.sessionId)}">\${esc(s.sessionId.slice(0,12))}…</td>
      <td class="mono truncate" title="\${esc(s.agentId)}">\${esc(s.agentId)}</td>
      <td>\${s.operationCount}</td>
      <td class="action-allow">\${s.approved}</td>
      <td class="action-block">\${s.blocked}</td>
      <td class="action-approval">\${s.requireApproval}</td>
      <td>\${spark}</td>
      <td class="ts">\${fmtTs(s.lastSeen)}</td>
    </tr>\`;
  }).join('') + '</tbody></table>';
}

// ── sparklines ────────────────────────────────────────────────────────────────

/**
 * Generate an inline SVG sparkline from an array of [0,1] risk scores.
 * Width: 120px, Height: 28px. Line colour transitions green→amber→red by avg.
 */
function sparklineSVG(scores) {
  if (!scores.length) return '<svg class="spark-svg"></svg>';
  const W = 200, H = 28, pad = 2;
  const n = scores.length;
  const xs = scores.map((_, i) => pad + (i / Math.max(n - 1, 1)) * (W - 2 * pad));
  const ys = scores.map(s => H - pad - s * (H - 2 * pad));
  const pts = xs.map((x, i) => \`\${x.toFixed(1)},\${ys[i].toFixed(1)}\`).join(' ');
  const avg = scores.reduce((a, b) => a + b, 0) / n;
  const stroke = avg >= 0.7 ? '#ef4444' : avg >= 0.3 ? '#f59e0b' : '#22c55e';
  // Area fill (subtle)
  const areaClose = \`\${xs[xs.length-1].toFixed(1)},\${H-pad} \${xs[0].toFixed(1)},\${H-pad}\`;
  return \`<svg class="spark-svg" viewBox="0 0 \${W} \${H}" preserveAspectRatio="none">
    <polygon points="\${pts} \${areaClose}" fill="\${stroke}" fill-opacity="0.12"/>
    <polyline points="\${pts}" fill="none" stroke="\${stroke}" stroke-width="1.5" stroke-linejoin="round"/>
  </svg>\`;
}

function renderSparklines(ops) {
  const el = document.getElementById('sparklines-body');
  if (!ops.length) { el.innerHTML = '<div class="empty">No operations yet</div>'; return; }

  // Group risk scores by agentId, keep chronological order
  const byAgent = new Map();
  for (const o of [...ops].reverse()) {
    const a = o.operation?.agentId || '—';
    if (!byAgent.has(a)) byAgent.set(a, []);
    byAgent.get(a).push(o.decision?.riskScore ?? 0);
  }

  document.getElementById('badge-sparklines').textContent = byAgent.size;

  el.innerHTML = [...byAgent.entries()].map(([agent, scores]) => {
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    const avgClass = avg >= 0.7 ? 'risk-high' : avg >= 0.3 ? 'risk-med' : 'risk-low';
    return \`<div class="spark-row">
      <span class="spark-agent" title="\${esc(agent)}">\${esc(agent)}</span>
      \${sparklineSVG(scores)}
      <span class="risk-pill \${avgClass} spark-avg">\${fmtRisk(avg)}</span>
    </div>\`;
  }).join('');
}

// ── risk heatmap ──────────────────────────────────────────────────────────────

/**
 * Render an agent × tool risk heatmap from operations.
 * Each cell is coloured by average risk score:
 *   ≥ 0.7 → red, ≥ 0.3 → amber, < 0.3 → green, no data → grey
 */
function renderHeatmap(ops) {
  const el = document.getElementById('heatmap-body');
  if (!ops.length) { el.innerHTML = '<div class="empty">No operations yet</div>'; return; }

  // Collect unique agents and tools
  const agentSet = new Set();
  const toolSet  = new Set();
  const sumMap   = new Map(); // 'agent:tool' → { sum, count }

  for (const o of ops) {
    const a = o.operation?.agentId || '—';
    const t = o.operation?.tool    || '—';
    const r = o.decision?.riskScore ?? 0;
    agentSet.add(a);
    toolSet.add(t);
    const k = a + '\x00' + t;
    const prev = sumMap.get(k) ?? { sum: 0, count: 0 };
    sumMap.set(k, { sum: prev.sum + r, count: prev.count + 1 });
  }

  const agents = [...agentSet];
  const tools  = [...toolSet];
  document.getElementById('badge-heatmap').textContent = agents.length;

  function cellColor(avg) {
    if (avg >= 0.7) return '#ef4444';
    if (avg >= 0.3) return '#f59e0b';
    return '#22c55e';
  }

  let html = '<div class="heatmap-wrap"><table class="heatmap-table"><thead><tr><th class="row-head">Agent</th>';
  for (const t of tools) html += \`<th>\${esc(t)}</th>\`;
  html += '</tr></thead><tbody>';

  for (const a of agents) {
    html += \`<tr><th class="row-head">\${esc(a)}</th>\`;
    for (const t of tools) {
      const cell = sumMap.get(a + '\x00' + t);
      if (!cell) {
        html += '<td class="empty-cell">—</td>';
      } else {
        const avg = cell.sum / cell.count;
        html += \`<td style="background:\${cellColor(avg)}" title="\${esc(a)} / \${esc(t)}: \${fmtRisk(avg)} (n=\${cell.count})">\${fmtRisk(avg)}</td>\`;
      }
    }
    html += '</tr>';
  }
  html += '</tbody></table></div>';
  el.innerHTML = html;
}

// ── operations ────────────────────────────────────────────────────────────────

function renderRuleDetail(firedRules, reasons, op) {
  const hasRules = firedRules && firedRules.length > 0;
  const filteredReasons = (reasons || []).filter(r => !r.startsWith('Risk score'));
  let html = '<div class="detail-panel">';

  // ── Operation metadata ─────────────────────────────────────────────────────
  if (op) {
    html += '<h4>Operation</h4>';
    html += '<table class="rule-table"><tbody>';
    html += \`<tr><td style="width:120px;color:var(--text-dim)">ID</td><td class="mono">\${esc(op.id || '—')}</td></tr>\`;
    html += \`<tr><td style="color:var(--text-dim)">Session</td><td class="mono">\${esc(op.sessionId || '—')}</td></tr>\`;
    html += \`<tr><td style="color:var(--text-dim)">Agent</td><td class="mono">\${esc(op.agentId || '—')}</td></tr>\`;
    html += \`<tr><td style="color:var(--text-dim)">Tool</td><td class="mono">\${esc(op.tool || '—')} · \${esc(op.method || '—')}</td></tr>\`;
    const params = op.params && Object.keys(op.params).length > 0
      ? JSON.stringify(op.params, null, 2)
      : '(none)';
    html += \`<tr><td style="color:var(--text-dim);vertical-align:top">Params</td><td><pre style="margin:0;font-size:.72rem;white-space:pre-wrap;word-break:break-all;color:var(--text-muted)">\${esc(params)}</pre></td></tr>\`;
    html += '</tbody></table>';
  }

  // ── Fired rules ────────────────────────────────────────────────────────────
  if (hasRules) {
    html += '<h4 style="margin-top:10px">Fired Risk Rules</h4><table class="rule-table"><thead><tr><th>Rule ID</th><th>Layer</th><th>Score</th><th>Description</th></tr></thead><tbody>';
    for (const r of firedRules) {
      const barColor = r.score >= 0.7 ? '#ef4444' : r.score >= 0.3 ? '#f59e0b' : '#22c55e';
      const barW = Math.round(r.score * 60);
      html += \`<tr><td class="mono">\${esc(r.id)}</td><td>\${esc(r.layer)}</td><td><span class="rule-score-bar" style="width:\${barW}px;background:\${barColor}"></span>\${fmtRisk(r.score)}</td><td style="color:var(--text-muted)">\${esc(r.description || '')}</td></tr>\`;
    }
    html += '</tbody></table>';
  }
  if (filteredReasons.length > 0) {
    html += '<div class="detail-reasons">';
    filteredReasons.forEach(r => { html += \`<span>\${esc(r)}</span>\`; });
    html += '</div>';
  }
  if (!op && !hasRules && filteredReasons.length === 0) {
    html += '<span style="color:var(--text-faint);font-size:.75rem">No rule details available</span>';
  }
  const tool = op?.tool ?? '';
  const method = op?.method ?? '';
  const agentId = op?.agentId ?? '';
  if (tool && method) {
    const blockRule = JSON.stringify({
      id: \`BLOCK_\${tool.toUpperCase()}_\${method.toUpperCase()}\`.replace(/[^A-Z0-9_]/g, '_').slice(0, 50),
      description: \`Block \${tool}/\${method}\`,
      match: { tool, method },
      action: 'block',
      priority: 10,
    });
    const approvalRule = JSON.stringify({
      id: \`APPROVE_\${tool.toUpperCase()}_\${method.toUpperCase()}\`.replace(/[^A-Z0-9_]/g, '_').slice(0, 50),
      description: \`Require approval for \${tool}/\${method}\`,
      match: { tool, method },
      action: 'require_approval',
      priority: 10,
    });
    const allowAgentRule = JSON.stringify({
      id: \`ALLOW_AGENT_\${agentId.toUpperCase()}\`.replace(/[^A-Z0-9_]/g, '_').slice(0, 50),
      description: \`Always allow agent \${agentId}\`,
      match: { agentId },
      score: 0.0,
      action: 'allow',
      priority: 5,
    });
    html += \`<div style="margin-top:.75rem;padding-top:.75rem;border-top:1px solid var(--border);display:flex;gap:.5rem;flex-wrap:wrap;align-items:center">
      <span style="font-size:.78rem;color:var(--text-faint);margin-right:.25rem">Quick rule:</span>
      <button onclick='openRuleModal(\${esc(blockRule)})' style="font-size:.78rem;padding:2px 8px;background:rgba(248,113,113,.15);color:#f87171;border:1px solid rgba(248,113,113,.3);border-radius:4px;cursor:pointer">Block \${esc(tool)}/\${esc(method)}</button>
      <button onclick='openRuleModal(\${esc(approvalRule)})' style="font-size:.78rem;padding:2px 8px;background:rgba(250,204,21,.15);color:#facc15;border:1px solid rgba(250,204,21,.3);border-radius:4px;cursor:pointer">Require approval</button>
      <button onclick='openRuleModal(\${esc(allowAgentRule)})' style="font-size:.78rem;padding:2px 8px;background:rgba(74,222,128,.15);color:#4ade80;border:1px solid rgba(74,222,128,.3);border-radius:4px;cursor:pointer">Trust agent \${esc(agentId)}</button>
    </div>\`;
  }
  html += '</div>';
  return html;
}

function toggleOpRow(idx) {
  const detailRow = document.getElementById('detail-' + idx);
  const opRow = document.getElementById('op-' + idx);
  if (!detailRow || !opRow) return;
  const hidden = detailRow.classList.toggle('hidden');
  opRow.classList.toggle('expanded', !hidden);
}

function renderOps(ops) {
  const el = document.getElementById('ops-body');
  if (!ops.length) { el.innerHTML = '<div class="empty">No operations recorded yet</div>'; return; }

  // Client-side full-text search filter
  const searchTerm = (document.getElementById('search-ops')?.value ?? '').trim().toLowerCase();
  const filtered = searchTerm
    ? ops.filter(o => {
        const haystack = [
          o.operation?.agentId ?? '',
          o.operation?.tool ?? '',
          o.operation?.method ?? '',
          o.operation?.sessionId ?? '',
          (o.decision?.reasons ?? []).join(' '),
          (o.decision?.firedRules ?? []).map(r => r.id).join(' '),
        ].join(' ').toLowerCase();
        return haystack.includes(searchTerm);
      })
    : ops;

  if (!filtered.length) {
    el.innerHTML = \`<div class="empty">No operations match "\${esc(searchTerm)}"</div>\`;
    return;
  }

  el.innerHTML = \`<table><thead><tr>
    <th>Time</th><th>Agent</th><th>Tool · Method</th><th>Action</th><th>Risk</th><th>Rules</th>
  </tr></thead><tbody>\` +
  filtered.slice(0, 100).map((o, idx) => {
    const action    = o.decision?.action || '—';
    const risk      = o.decision?.riskScore ?? 0;
    const firedRules = o.decision?.firedRules || [];
    const ruleIds   = firedRules.map(r => r.id).join(', ') ||
                      (o.decision?.reasons || []).filter(r => r.startsWith('Triggered rule:')).map(r => r.replace('Triggered rule: ','')).join(', ');
    const agentId   = o.operation?.agentId || '—';
    const tool      = o.operation?.tool || '—';
    const method    = o.operation?.method || '—';
    const ts        = o.operation?.timestamp || o.createdAt;
    const detailHtml = renderRuleDetail(firedRules, o.decision?.reasons, o.operation);
    // Extract file path for correlation highlighting
    const filePath = o.operation?.params?.path || o.operation?.params?.filePath || o.operation?.params?.file || '';
    const fpAttr = filePath ? \` data-filepath="\${esc(filePath)}"\` : '';
    return \`<tr class="op-row" id="op-\${idx}"\${fpAttr} onclick="toggleOpRow(\${idx})" onmouseenter="highlightCorrelated(this)" onmouseleave="clearCorrelated()">
      <td class="ts">\${fmtTs(ts)}</td>
      <td class="mono truncate" title="\${esc(agentId)}">\${esc(agentId)}</td>
      <td class="mono">\${esc(tool)} · \${esc(method)}</td>
      <td class="\${actionClass(action)}">\${esc(action)}\${o.decision?.dryRun ? ' <span title="Dry-run mode" style="font-size:.65rem;background:#334155;color:#94a3b8;border-radius:3px;padding:1px 4px;margin-left:3px">DRY</span>' : ''}</td>
      <td><span class="risk-pill \${riskClass(risk)}">\${fmtRisk(risk)}</span></td>
      <td class="mono" style="color:var(--text-dim);font-size:.72rem">\${esc(ruleIds)}</td>
    </tr>
    <tr class="detail-row hidden" id="detail-\${idx}"><td colspan="6">\${detailHtml}</td></tr>\`;
  }).join('') + '</tbody></table>';
}

// ── session comparison ────────────────────────────────────────────────────────

let _allSessions = [];
let _allOps = [];

function populateSessionDropdowns(sessions) {
  _allSessions = sessions;
  ['cmp-a', 'cmp-b'].forEach(id => {
    const sel = document.getElementById(id);
    const prev = sel.value;
    sel.innerHTML = '<option value="">— pick session —</option>' +
      sessions.map(s => \`<option value="\${esc(s.sessionId)}" \${s.sessionId === prev ? 'selected' : ''}>\${esc(s.sessionId.slice(0,16))}… (\${esc(s.agentId)})</option>\`).join('');
  });
}

function renderComparison() {
  const idA = document.getElementById('cmp-a').value;
  const idB = document.getElementById('cmp-b').value;
  const el   = document.getElementById('compare-body');
  if (!idA || !idB || idA === idB) {
    el.innerHTML = '<div class="empty">Select two different sessions above to compare them side-by-side</div>';
    return;
  }
  const sA = _allSessions.find(s => s.sessionId === idA);
  const sB = _allSessions.find(s => s.sessionId === idB);
  if (!sA || !sB) { el.innerHTML = '<div class="empty">Session data not found</div>'; return; }

  // Per-session risk scores from ops
  const opsA = _allOps.filter(o => o.operation?.sessionId === idA);
  const opsB = _allOps.filter(o => o.operation?.sessionId === idB);
  const avgRiskA = opsA.length ? opsA.reduce((s, o) => s + (o.decision?.riskScore || 0), 0) / opsA.length : 0;
  const avgRiskB = opsB.length ? opsB.reduce((s, o) => s + (o.decision?.riskScore || 0), 0) / opsB.length : 0;

  function cmpStat(label, vA, vB, lowerIsBetter = false) {
    const better = lowerIsBetter ? vA < vB : vA > vB;
    const worse  = lowerIsBetter ? vA > vB : vA < vB;
    const clsA = vA === vB ? '' : (better ? ' better' : ' worse');
    const clsB = vA === vB ? '' : (worse  ? ' better' : ' worse');
    return { label, vA: String(vA), vB: String(vB), clsA, clsB };
  }

  const rows = [
    cmpStat('Operations',      sA.operationCount,       sB.operationCount),
    cmpStat('Allowed',         sA.approved,              sB.approved),
    cmpStat('Blocked',         sA.blocked,               sB.blocked,   true),
    cmpStat('Pending',         sA.requireApproval,       sB.requireApproval, true),
    cmpStat('Avg Risk',        fmtRisk(avgRiskA),        fmtRisk(avgRiskB),  true),
    cmpStat('Block rate',
      sA.operationCount ? (sA.blocked / sA.operationCount * 100).toFixed(1) + '%' : '—',
      sB.operationCount ? (sB.blocked / sB.operationCount * 100).toFixed(1) + '%' : '—',
      true
    ),
  ];

  function colHtml(session, vals, clss) {
    return \`<div class="compare-col">
      <h3>\${esc(session.agentId)} <span style="font-weight:400;text-transform:none;letter-spacing:0">\${esc(session.sessionId.slice(0,12))}…</span></h3>
      \${rows.map((r, i) => \`<div class="compare-stat"><span class="label">\${esc(r.label)}</span><span class="val\${clss[i]}">\${esc(vals[i])}</span></div>\`).join('')}
    </div>\`;
  }

  el.innerHTML = \`<div class="compare-grid">
    \${colHtml(sA, rows.map(r => r.vA), rows.map(r => r.clsA))}
    \${colHtml(sB, rows.map(r => r.vB), rows.map(r => r.clsB))}
  </div>\`;
}

// ── SSE live-updates ──────────────────────────────────────────────────────────

let sseSource;
function connectSSE() {
  if (sseSource) { sseSource.close(); sseSource = null; }
  sseSource = new EventSource(BASE + '/events');
  sseSource.addEventListener('connected', () => {
    console.log('[AgentsGate] SSE connected — live updates active');
  });
  sseSource.addEventListener('refresh', () => { loadAll(); });
  sseSource.onerror = () => {
    // Fall back to polling if SSE disconnects
    sseSource.close();
    sseSource = null;
    startTimer();
  };
}

// ── auto-refresh (fallback polling) ──────────────────────────────────────────

let timer;
function startTimer() {
  clearInterval(timer);
  // Only poll if SSE is not active
  if (sseSource && sseSource.readyState !== EventSource.CLOSED) return;
  const ms = parseInt(document.getElementById('interval-select').value, 10);
  if (ms > 0) timer = setInterval(loadAll, ms);
}
document.getElementById('interval-select').addEventListener('change', startTimer);
['filter-action','filter-tool','filter-agent','filter-from','filter-to'].forEach(id => {
  document.getElementById(id).addEventListener('change', loadAll);
});
function clearTimeRange() {
  document.getElementById('filter-from').value = '';
  document.getElementById('filter-to').value = '';
  loadAll();
}
// Search triggers a local re-render (no server round-trip needed)
document.getElementById('search-ops').addEventListener('input', () => {
  if (_allOps.length) renderOps(_allOps);
});

// ── Operation correlation: highlight rows sharing the same file path ───────────
function highlightCorrelated(row) {
  const fp = row.dataset.filepath;
  if (!fp) return;
  document.querySelectorAll('.op-row[data-filepath]').forEach(r => {
    if (r !== row && r.dataset.filepath === fp) r.classList.add('correlated');
  });
}
function clearCorrelated() {
  document.querySelectorAll('.op-row.correlated').forEach(r => r.classList.remove('correlated'));
}

document.getElementById('btn-export-csv').addEventListener('click', () => {
  const action    = document.getElementById('filter-action').value;
  const tool      = document.getElementById('filter-tool').value.trim();
  const agentId   = document.getElementById('filter-agent').value.trim();
  const params    = new URLSearchParams();
  if (action)  params.set('action',  action);
  if (tool)    params.set('tool',    tool);
  if (agentId) params.set('agentId', agentId);
  const qs = params.toString();
  const a  = document.createElement('a');
  a.href   = '/operations/export' + (qs ? '?' + qs : '');
  a.download = 'agentsgate-operations.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
});

loadAll();
loadProtection();
connectSSE();

// ── Tab navigation ────────────────────────────────────────────────────────────

function showTab(name, btn) {
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  btn.classList.add('active');
  if (name === 'agents') loadAgents();
  else if (name === 'tools') loadTools();
  else if (name === 'circuit-breakers') loadCircuitBreakers();
  else if (name === 'quota') loadQuota();
  else if (name === 'rules') loadRulesTab();
}

async function loadAgents() {
  const el = document.getElementById('agents-body');
  el.innerHTML = '<div class="empty">Loading…</div>';
  try {
    const r = await fetch(BASE + '/agents?limit=100');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    const agents = data.agents || [];
    if (!agents.length) { el.innerHTML = '<div class="empty">No agent data</div>'; return; }
    const rows = agents.map(a => {
      const blockRate = a.totalOps > 0 ? ((a.blockCount / a.totalOps) * 100).toFixed(1) + '%' : '0%';
      const lastSeen = a.lastSeenAt ? new Date(a.lastSeenAt).toLocaleString() : '—';
      return \`<tr><td>\${escHtml(a.agentId)}</td><td>\${a.totalOps}</td><td>\${blockRate}</td><td>\${(a.avgRiskScore || 0).toFixed(2)}</td><td>\${lastSeen}</td></tr>\`;
    }).join('');
    el.innerHTML = \`<table class="tbl"><thead><tr><th>Agent ID</th><th>Total Ops</th><th>Block Rate</th><th>Avg Risk</th><th>Last Seen</th></tr></thead><tbody>\${rows}</tbody></table>\`;
  } catch(e) {
    el.innerHTML = '<div class="empty">Failed to load agents: ' + escHtml(e.message) + '</div>';
  }
}

async function loadTools() {
  const el = document.getElementById('tools-body');
  el.innerHTML = '<div class="empty">Loading…</div>';
  try {
    const r = await fetch(BASE + '/tools?limit=100');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    const tools = data.tools || [];
    if (!tools.length) { el.innerHTML = '<div class="empty">No tool data</div>'; return; }
    const rows = tools.map(t => {
      const blockRate = t.totalOps > 0 ? ((t.blockCount / t.totalOps) * 100).toFixed(1) + '%' : '0%';
      return \`<tr><td>\${escHtml(t.tool)}</td><td>\${t.totalOps}</td><td>\${blockRate}</td><td>\${(t.avgRiskScore || 0).toFixed(2)}</td><td>\${t.distinctAgents}</td></tr>\`;
    }).join('');
    el.innerHTML = \`<table class="tbl"><thead><tr><th>Tool</th><th>Total Ops</th><th>Block Rate</th><th>Avg Risk</th><th>Distinct Agents</th></tr></thead><tbody>\${rows}</tbody></table>\`;
  } catch(e) {
    el.innerHTML = '<div class="empty">Failed to load tools: ' + escHtml(e.message) + '</div>';
  }
}

async function loadCircuitBreakers() {
  const el = document.getElementById('cb-body');
  el.innerHTML = '<div class="empty">Loading…</div>';
  try {
    const r = await fetch(BASE + '/circuit-breakers');
    if (r.status === 501 || r.status === 503) { el.innerHTML = '<div class="empty">Circuit breaker not configured</div>'; return; }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    const cbs = data.circuitBreakers || [];
    if (!cbs.length) { el.innerHTML = '<div class="empty">No circuit breaker data</div>'; return; }
    const stateColor = { closed: '#4ade80', open: '#f87171', 'half-open': '#facc15' };
    const rows = cbs.map(cb => {
      const color = stateColor[cb.state] || '#94a3b8';
      const pill = \`<span style="background:\${color};color:#0f172a;padding:2px 8px;border-radius:999px;font-size:0.78rem;font-weight:600">\${escHtml(cb.state)}</span>\`;
      const lastFail = cb.lastFailureAt ? new Date(cb.lastFailureAt).toLocaleString() : '—';
      const resetBtn = cb.state === 'open' ? \`<button class="btn btn-sm" onclick="resetCB('\${escHtml(cb.agentId)}')">Reset</button>\` : '';
      return \`<tr><td>\${escHtml(cb.agentId)}</td><td>\${pill}</td><td>\${cb.failureCount}</td><td>\${lastFail}</td><td>\${resetBtn}</td></tr>\`;
    }).join('');
    el.innerHTML = \`<table class="tbl"><thead><tr><th>Agent ID</th><th>State</th><th>Failure Count</th><th>Last Failure</th><th>Actions</th></tr></thead><tbody>\${rows}</tbody></table>\`;
  } catch(e) {
    el.innerHTML = '<div class="empty">Failed to load circuit breakers: ' + escHtml(e.message) + '</div>';
  }
}

async function resetCB(agentId) {
  try {
    const r = await fetch(BASE + '/circuit-breakers/' + encodeURIComponent(agentId) + '/reset', {
      method: 'POST',
      headers: { 'x-api-key': '' }
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    await loadCircuitBreakers();
  } catch(e) {
    alert('Reset failed: ' + e.message);
  }
}

async function loadQuota() {
  const el = document.getElementById('quota-body');
  el.innerHTML = '<div class="empty">Loading…</div>';
  try {
    const r = await fetch(BASE + '/quotas');
    if (r.status === 501 || r.status === 503) { el.innerHTML = '<div class="empty">Quota manager not configured</div>'; return; }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    const quotas = Array.isArray(data) ? data : (data.quotas || []);
    if (!quotas.length) { el.innerHTML = '<div class="empty">No quota data</div>'; return; }
    const rows = quotas.map(q => {
      const cells = Object.values(q).map(v => \`<td>\${escHtml(String(v ?? '—'))}</td>\`).join('');
      return \`<tr>\${cells}</tr>\`;
    }).join('');
    const headers = Object.keys(quotas[0]).map(k => \`<th>\${escHtml(k)}</th>\`).join('');
    el.innerHTML = \`<table class="tbl"><thead><tr>\${headers}</tr></thead><tbody>\${rows}</tbody></table>\`;
  } catch(e) {
    el.innerHTML = '<div class="empty">Failed to load quotas: ' + escHtml(e.message) + '</div>';
  }
}

// ── apiFetch helper ───────────────────────────────────────────────────────────
async function apiFetch(path, opts) {
  const r = await fetch(BASE + path, opts);
  if (!r.ok) { const t = await r.text(); throw new Error('HTTP ' + r.status + ': ' + t); }
  if (r.status === 204) return null;
  return r.json();
}

// ── Rules tab ─────────────────────────────────────────────────────────────────

let _editingRuleId = null;

async function loadRulesTab() {
  await Promise.all([loadPolicyRules(), loadL1Rules()]);
}

async function loadPolicyRules() {
  const tbody = document.getElementById('policy-rules-body');
  try {
    const [rulesResp, statsResp] = await Promise.all([
      apiFetch('/policy/rules'),
      apiFetch('/policy/stats').catch(() => ({ rules: [] })),
    ]);
    const rules = rulesResp.rules ?? [];
    const hitMap = new Map((statsResp.rules ?? []).map(s => [s.ruleId, s.hits]));
    if (!rules.length) {
      tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:var(--text-faint)">No policy rules defined. Click &quot;+ New Rule&quot; to add one.</td></tr>';
      return;
    }
    tbody.innerHTML = rules.map(rule => {
      const hits = hitMap.get(rule.id) ?? 0;
      const hitsCell = hits > 0 ? \`<span style="font-weight:600;color:var(--text)">\${hits}</span>\` : \`<span style="color:var(--text-faint)">0</span>\`;
      return \`
      <tr>
        <td>\${esc(rule.priority ?? 100)}</td>
        <td><code>\${esc(rule.id)}</code></td>
        <td>\${esc(rule.description ?? '\u2014')}</td>
        <td>\${esc(rule.match?.tool ?? '\u2014')}</td>
        <td>\${esc(rule.match?.method ?? '\u2014')}</td>
        <td>\${rule.action ? '<span class="badge badge-' + rule.action + '">' + esc(rule.action) + '</span>' : '\u2014'}</td>
        <td>\${rule.score !== undefined ? (rule.score * 100).toFixed(0) + '%' : '\u2014'}</td>
        <td>\${hitsCell}</td>
        <td style="text-align:right">
          <button onclick='openRuleModal(\${esc(JSON.stringify(rule))})' style="margin-right:.25rem">Edit</button>
          <button onclick='deleteRule("\${esc(rule.id)}")' style="color:var(--danger,#e55)">Delete</button>
        </td>
      </tr>\`;
    }).join('');
  } catch(e) {
    tbody.innerHTML = '<tr><td colspan="9" style="color:var(--danger,#e55)">' + esc(String(e)) + '</td></tr>';
  }
}

async function loadL1Rules() {
  const tbody = document.getElementById('l1-rules-body');
  try {
    const r = await apiFetch('/policy/l1-rules');
    const rules = r.rules ?? [];
    if (!rules.length) {
      tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--text-faint)">No L1 rules found.</td></tr>';
      return;
    }
    tbody.innerHTML = rules.map(rule => {
      const pct = (rule.score * 100).toFixed(0);
      const barColor = rule.score >= 0.8 ? 'var(--danger,#e55)' : rule.score >= 0.5 ? '#e8a020' : '#4caf50';
      return \`<tr>
        <td><code>\${esc(rule.id)}</code></td>
        <td>
          <span style="font-weight:600;color:\${barColor}">\${pct}%</span>
          <span style="display:inline-block;width:\${pct}px;max-width:80px;height:6px;background:\${barColor};border-radius:3px;margin-left:6px;vertical-align:middle"></span>
        </td>
        <td><span style="background:var(--bg-row,rgba(255,255,255,.04));padding:2px 6px;border-radius:4px;font-size:.78rem">L1</span></td>
        <td style="font-size:.85rem;color:var(--text-faint)">\${esc(rule.description)}</td>
      </tr>\`;
    }).join('');
  } catch(e) {
    tbody.innerHTML = '<tr><td colspan="4" style="color:var(--danger,#e55)">' + esc(String(e)) + '</td></tr>';
  }
}

const RULE_PRESETS = {
  'fs-delete-block': {
    id: 'PRESET_BLOCK_FS_DELETE',
    description: 'Block all filesystem delete operations',
    match: { tool: 'filesystem', method: '/delete|remove|unlink|rmdir/' },
    action: 'block',
    priority: 10,
  },
  'gmail-send-approval': {
    id: 'PRESET_GMAIL_SEND_APPROVAL',
    description: 'Require human approval before sending any email',
    match: { tool: 'gmail', method: '/send|reply|forward/' },
    action: 'require_approval',
    priority: 10,
  },
  'slack-channel-approval': {
    id: 'PRESET_SLACK_CHANNEL_APPROVAL',
    description: 'Require approval for Slack messages to public channels (not DMs)',
    match: { tool: 'slack', method: '/send|post/', paramsMatch: { channel: '/^[CG][A-Z0-9]+/' } },
    action: 'require_approval',
    priority: 10,
  },
  'readonly-agent': {
    id: 'PRESET_READONLY_AGENT',
    description: 'Allow only read operations for a specific agent — edit the agentId match after adding',
    match: { agentId: 'readonly-agent', method: '/write|delete|create|update|edit|modify/' },
    action: 'block',
    priority: 5,
  },
  'trust-internal-email': {
    id: 'PRESET_TRUST_INTERNAL_EMAIL',
    description: 'Lower risk for emails sent to your own domain — update the domain pattern after adding',
    match: { tool: 'gmail', method: '/send/', paramsMatch: { to: '/yourcompany\\.com$/' } },
    score: 0.2,
    priority: 20,
  },
  'gcal-delete-block': {
    id: 'PRESET_BLOCK_GCAL_DELETE',
    description: 'Block Google Calendar event deletions',
    match: { tool: 'google-calendar', method: '/delete|remove|cancel/' },
    action: 'block',
    priority: 10,
  },
};

async function addPreset(presetKey) {
  const preset = RULE_PRESETS[presetKey];
  if (!preset) return;
  if (!confirm('Add preset rule "' + preset.id + '"?\n\n' + preset.description)) return;
  try {
    await apiFetch('/policy/rules', {
      method: 'POST',
      body: JSON.stringify(preset),
      headers: { 'Content-Type': 'application/json' },
    });
    await loadPolicyRules();
    alert('Preset "' + preset.id + '" added. Review and adjust it in the rules table.');
  } catch(e) {
    alert('Failed to add preset: ' + String(e));
  }
}

function openRuleModal(rule) {
  _editingRuleId = rule?.id ?? null;
  document.getElementById('rule-modal-title').textContent = rule ? 'Edit Rule' : 'New Rule';
  document.getElementById('rf-id').value = rule?.id ?? '';
  document.getElementById('rf-id').disabled = !!rule;
  document.getElementById('rf-desc').value = rule?.description ?? '';
  document.getElementById('rf-tool').value = rule?.match?.tool ?? '';
  document.getElementById('rf-method').value = rule?.match?.method ?? '';
  document.getElementById('rf-agentId').value = rule?.match?.agentId ?? '';
  document.getElementById('rf-pathPattern').value = rule?.match?.pathPattern ?? '';
  const pm = rule?.match?.paramsMatch ?? {};
  document.getElementById('rf-paramsMatch').value = Object.entries(pm).map(([k,v]) => k+'='+v).join('\n');
  document.getElementById('rf-score').value = rule?.score !== undefined ? rule.score : '';
  document.getElementById('rf-action').value = rule?.action ?? '';
  document.getElementById('rf-priority').value = rule?.priority !== undefined ? rule.priority : '';
  document.getElementById('rf-max').value = rule?.max !== undefined ? rule.max : '';
  document.getElementById('rf-redact').value = rule?.redact?.join(',') ?? '';
  document.getElementById('rule-modal-test-result').style.display = 'none';
  document.getElementById('rule-modal').style.display = 'flex';
}

function closeRuleModal() {
  document.getElementById('rule-modal').style.display = 'none';
  _editingRuleId = null;
}

function parseRuleFromModal() {
  const id = document.getElementById('rf-id').value.trim();
  if (!id) throw new Error('Rule ID is required');
  const rule = { id, match: {} };
  const desc = document.getElementById('rf-desc').value.trim();
  if (desc) rule.description = desc;
  const tool = document.getElementById('rf-tool').value.trim();
  if (tool) rule.match.tool = tool;
  const method = document.getElementById('rf-method').value.trim();
  if (method) rule.match.method = method;
  const agentId = document.getElementById('rf-agentId').value.trim();
  if (agentId) rule.match.agentId = agentId;
  const pathPattern = document.getElementById('rf-pathPattern').value.trim();
  if (pathPattern) rule.match.pathPattern = pathPattern;
  const pmLines = document.getElementById('rf-paramsMatch').value.trim().split('\n').filter(Boolean);
  if (pmLines.length) {
    rule.match.paramsMatch = {};
    for (const line of pmLines) {
      const idx = line.indexOf('=');
      if (idx > 0) rule.match.paramsMatch[line.slice(0, idx).trim()] = line.slice(idx+1).trim();
    }
  }
  const score = document.getElementById('rf-score').value.trim();
  if (score !== '') rule.score = parseFloat(score);
  const action = document.getElementById('rf-action').value;
  if (action) rule.action = action;
  const priority = document.getElementById('rf-priority').value.trim();
  if (priority !== '') rule.priority = parseInt(priority, 10);
  const max = document.getElementById('rf-max').value.trim();
  if (max !== '') rule.max = parseFloat(max);
  const redact = document.getElementById('rf-redact').value.trim();
  if (redact) rule.redact = redact.split(',').map(s => s.trim()).filter(Boolean);
  if (rule.score === undefined && !rule.action) {
    throw new Error('Set at least a Risk Score or a Force Action — a rule with neither has no effect.');
  }
  return rule;
}

async function saveRuleModal() {
  let rule;
  try { rule = parseRuleFromModal(); } catch(e) { alert(String(e)); return; }
  const btn = document.getElementById('rule-save-btn');
  btn.disabled = true;
  try {
    if (_editingRuleId) {
      await apiFetch('/policy/rules/' + encodeURIComponent(_editingRuleId), { method: 'PUT', body: JSON.stringify(rule), headers: {'Content-Type':'application/json'} });
    } else {
      await apiFetch('/policy/rules', { method: 'POST', body: JSON.stringify(rule), headers: {'Content-Type':'application/json'} });
    }
    closeRuleModal();
    await loadPolicyRules();
  } catch(e) {
    alert('Save failed: ' + String(e));
  } finally {
    btn.disabled = false;
  }
}

async function deleteRule(ruleId) {
  if (!confirm('Delete rule "' + ruleId + '"? This cannot be undone.')) return;
  try {
    await apiFetch('/policy/rules/' + encodeURIComponent(ruleId), { method: 'DELETE' });
    await loadPolicyRules();
  } catch(e) {
    alert('Delete failed: ' + String(e));
  }
}

async function testModalRule() {
  const resultEl = document.getElementById('rule-modal-test-result');
  resultEl.style.display = 'block';
  resultEl.textContent = 'Testing\u2026';
  let rule;
  try { rule = parseRuleFromModal(); } catch(e) { resultEl.textContent = 'Error: ' + e; return; }
  const tool = document.getElementById('test-tool').value.trim() || document.getElementById('rf-tool').value.trim() || 'test-tool';
  const method = document.getElementById('test-method').value.trim() || document.getElementById('rf-method').value.trim() || 'test-method';
  const agentId = document.getElementById('test-agent').value.trim() || 'test-agent';
  let params = {};
  try { params = JSON.parse(document.getElementById('test-params').value || '{}'); } catch {}
  try {
    const r = await apiFetch('/policy/rules/test', { method: 'POST', body: JSON.stringify({ rule, operation: { tool, method, agentId, params } }), headers: {'Content-Type':'application/json'} });
    resultEl.textContent = JSON.stringify(r, null, 2);
  } catch(e) {
    resultEl.textContent = 'Error: ' + e;
  }
}

async function runRuleTest() {
  const resultEl = document.getElementById('rule-test-result');
  resultEl.textContent = 'Testing\u2026';
  const tool = document.getElementById('test-tool').value.trim();
  const method = document.getElementById('test-method').value.trim();
  const agentId = document.getElementById('test-agent').value.trim() || 'test-agent';
  let params = {};
  try { params = JSON.parse(document.getElementById('test-params').value || '{}'); } catch {}
  if (!tool || !method) { resultEl.textContent = 'Enter tool and method to test.'; return; }
  try {
    const r = await apiFetch('/policy/evaluate', { method: 'POST', body: JSON.stringify({ tool, method, agentId, params, id: 'test-' + Date.now(), timestamp: new Date().toISOString(), sessionId: 'test' }), headers: {'Content-Type':'application/json'} });
    resultEl.textContent = JSON.stringify(r, null, 2);
  } catch(e) {
    resultEl.textContent = 'Error: ' + e;
  }
}
</script>
</body>
</html>`;

