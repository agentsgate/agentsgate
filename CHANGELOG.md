# Changelog

---

## [Unreleased]

### Changed

- **Releases are now triggered by a tag**, not by a commit message starting
  `release:`. Merging a version bump publishes nothing; pushing `v<version>`
  does. The old trigger read the head commit message, which stopped being
  reliable once `main` required pull requests — whether that message reaches the
  tip depends on the merge method, so a merge commit skipped the publish after
  every gate had passed. The publish step now also refuses a tag that disagrees
  with `package.json`.
- **Publishing authenticates over OIDC** via npm trusted publishing, so no npm
  token is stored in the repository. Nothing to rotate or leak, and the package
  can keep npm's strictest publishing-access setting.
- **`npm publish` runs with `--ignore-scripts` in CI.** `prepublishOnly` re-ran
  lint, all 7,258 tests and the build inside the publish step, after the same
  work had already passed across seven CI legs — duplicated effort whose only
  effect was another way for a release to fail at the last step. It still guards
  a manual publish.

---

## [0.1.1] — 2026-07-29

### Fixed

- `agentsgate --version` printed the banner followed by the entire usage block
  and exited 1, because it fell through to the `default:` arm of the dispatch
  switch. It now prints `AgentsGate v<version>` on its own and exits 0. `-v` and
  `version` do the same; `--help`, `-h` and `help` print the usage and exit 0,
  where before they too exited 1. An unknown command still prints the usage and
  exits 1.

---

## [0.1.0] — 2026-07-28

First release published to npm.

The version restarts at 0.1.0 deliberately. The 0.1.0–0.5.0 entries below were
internal development milestones — none of them was ever published, so no
installed version is being superseded and nothing downstream can break. They are
kept as a record of how the project got here, under headings that do not look
like npm releases. Everything in this entry accumulated across those milestones
and the work that followed them.

### Added

- **Database MCP servers** — guarded SQLite, PostgreSQL and MySQL servers, so
  SQL an agent issues is risk-scored, checkpointed and rollback-capable like any
  other tool call. Registered with `agentsgate inject-db` / `inject-pg` /
  `inject-mysql`, each with a matching `remove`, `--name` for running several
  databases side by side, and credentials redacted from all output.
- **Rollback adapters for all three databases**, plus `agentsgate db snapshot
  prune` for snapshot hygiene.
- **Dashboard Rule Editor** — full CRUD over policy rules from the UI, including
  `paramsMatch`, preset templates, a hit counter per rule, and quick-create
  buttons on operation rows.
- **Tabbed dashboard** with a summary section backed by `/operations/summary`.
- **RBAC for the dashboard** — `viewer` / `approver` / `admin` keys via
  `dashboard.roles`, on top of the existing single `dashboard.apiKey`.
- **OpenTelemetry OTLP export** — `telemetry.otlpEndpoint` and
  `telemetry.otlpExportIntervalMs`.
- **L1 risk rules for Slack, Google Calendar and Gmail** MCP servers.
- **Multi-tenant isolation** — `--team` selects a per-namespace database.
- **Error tracking** — `ErrorTracker`, `AGENTSGATE_DEBUG=1`, and
  `agentsgate errors`.
- **Webhook payload signing** — `webhook.secret` adds
  `X-AgentsGate-Signature: sha256=<hex>` over the raw body.
- **Docker image and compose file.**
- **Bilingual (EN/JA) installation, user, and rules/policy guides.**

### Changed

- **Renamed from AgentShield to AgentsGate.**
- `src/cli.ts` split into focused modules under `src/cli/`; the dashboard,
  approval queue and rollback adapters similarly extracted.
- 131 M10 analytics test files consolidated into 5 grouped suites.
- Test tooling moved to vitest 4.

### Fixed

- Analytics window assertions no longer depend on wall-clock timing: rolling
  window cutoffs take an injectable clock, and fixtures no longer sit on
  day/hour bucket edges. Previously the suite could fail anywhere from one to
  several thousand assertions depending on the minute it ran.
- Test servers bind OS-assigned ports instead of hand-picked numbers inside the
  ephemeral range, removing intermittent `EADDRINUSE` failures.
- `package.json` `bin` entries for the three database servers were shell
  commands rather than file paths, which produced broken launchers on
  `npm install -g`.
- The L3 community endpoint no longer issues an uncached, untimed HTTP request
  on every single operation.

### Security

- **Fixed an authentication bypass in dashboard RBAC.** Key lookup indexed a
  plain object with the caller-supplied `X-API-Key`, so a header naming a
  JavaScript built-in — `constructor`, `toString`, `__proto__` and others —
  resolved to a truthy value and passed the "is this a known key" check. Anyone
  could then read every operation, including tool arguments and results. Keys
  are now held in a `Map`, which has no prototype chain.
- **Added DNS rebinding defence.** The `Host` header is checked against an
  allowlist before authentication and before routing. Binding to loopback does
  not stop a page the operator visits: an attacker pointing their own hostname
  at 127.0.0.1 becomes same-origin with the dashboard, and with no API key set
  — the default — that meant full admin access, including rollback.
  Configurable via `dashboard.allowedHosts`.
- **The audit log is now chained.** Each record's signature covers its
  predecessor's, recorded on the entry as `prevHmac`. Per-record signatures
  detected a record being edited but not one being deleted — rows could be
  dropped and every remaining signature would still verify. Verification now
  reports where a chain breaks. This changes the signature format: records
  written by earlier builds will not verify.
- **Fixed stored XSS in the dashboard, reachable by the monitored agent.** The
  quick-rule buttons embedded the operation's tool, method and agent id into an
  `onclick` attribute as unescaped JSON, so an agent that named a tool
  `x' onmouseover='…` could run script in the operator's console — the page
  holding the full history of every tool call. All agent-controlled data is now
  escaped before entering the DOM, in text, in attributes, and in embedded JSON.
- **Documented the trust model.** The proxy transport is unauthenticated and the
  dashboard's authentication is opt-in; both are safe only because `proxy.host`
  binds to `127.0.0.1`. README and SECURITY.md now state this up front, along
  with residual risks and a deployment checklist.
- **SSRF defense on every outbound sender** — protocol allow-list plus
  DNS-resolving denylist, so a public hostname whose record points inward cannot
  be used to probe the host network. Strict for Slack and the community
  endpoint; link-local/metadata for telemetry sinks, which legitimately run on
  private networks.
- **ReDoS guard on policy regexes** — patterns with nested quantifiers are
  refused and input is length-capped, bounding a hang of the single-threaded
  gateway.
- **Credential redaction** for URLs in dashboard output and logs.
- **Constant-time dashboard API key comparison**; query-parameter auth
  deliberately unsupported so keys stay out of access logs.
- **Runtime dependency advisories cleared** (13 known issues down to 1
  development-only), including the critical vitest-UI advisory.

---

## Pre-release development history

Internal milestones from before the first npm release. Listed for provenance;
none of these version numbers was ever published to the registry.

---

### Milestone 0.5.0 — 2026-03-13

#### Added
- **Policy CLI subcommands** — `agentsgate policy list`, `add --id=X [--tool] [--method] [--agentId] [--pathPattern] [--score] [--action] [--description]`, `remove <id>`, `set-threshold [--allowBelow] [--blockAtOrAbove]`
- **Operation log TTL pruning** — `StateStore.pruneOperationLogs(cutoff)` deletes logs older than cutoff; `AgentsGateConfig.logs.retentionDays` (default: 30); auto-prune on startup; `agentsgate prune [--dry-run]` command
- **Enhanced `/health` endpoint** — returns `status`, `version`, `uptimeMs`, `startedAt`, `db` (row counts per table), `pendingApprovals`
- **`StateStore.getStats()`** — row counts for all four tables; used by dashboard health check
- 12 new tests (prune, getStats, health endpoint, policy CLI CRUD); total 171/171

---

### Milestone 0.4.0 — 2026-03-13

#### Added
- **Policy file** (`~/.agentsgate/policy.json`) — `AgentsGatePolicy` with ordered `PolicyRule` list and optional threshold overrides
- **Policy rules** — match by `tool`, `method`, `agentId` (exact or `/regex/`) and `pathPattern` (regex against params.path/filePath/file)
- **Score override** — `PolicyRule.score` replaces L1 static score; L2/L3 blending still applies on top
- **Action override** — `PolicyRule.action` forces `allow`/`block`/`require_approval` after all scoring
- **Threshold override** — `policy.thresholds` overrides config `allowBelow`/`blockAtOrAbove` at startup
- `loadPolicy()`, `savePolicy()`, `matchRule()`, `evaluatePolicyScore()`, `evaluatePolicyAction()` exported from public API
- `agentsgate policy [--policy=path]` CLI command to inspect the effective policy
- `agentsgate start --policy=path` to load a custom policy file at startup
- 27 new policy tests; total 144/144

---

### Milestone 0.3.0 — 2026-03-13

#### Added
- **Config file** (`~/.agentsgate/config.json`) — typed `AgentsGateConfig`, `loadConfig()`, `saveConfig()` with deep-merge over defaults
- **Per-agent rate limiting** — sliding-window `AgentRateLimiter` (configurable `maxOpsPerMinute`), wired into the proxy pipeline
- **Approval persistence** — `pending_approvals` SQLite table; `ApprovalQueue.initialize()` restores queued approvals across restarts
- **Approval TTL expiry** — `maxAgeMs` config option (default 24 h); expired approvals pruned automatically
- **Webhook notifications** — `POST` to configured URL when an approval is queued; includes operation metadata and dashboard link
- **Operation filtering** — `GET /operations?action=&tool=&agentId=&sessionId=` on Dashboard API
- **Telemetry HTTP export** — `TelemetryService.exportTo(endpoint)` posts stats and flushes; periodic export via CLI config
- **Rollback preview endpoint** — `GET /rollback/:id/preview` returns affected files without restoring
- **Session stats** — `GET /sessions` groups operations by `sessionId` with per-session risk and tool counts
- **CLI commands** — `agentsgate telemetry`, `agentsgate approvals`, `agentsgate approve <id>`, `agentsgate deny <id>`, `agentsgate config`
- **L2 SQLite persistence** — `outcome_records` table; `RiskIntelligenceEngine` reads cross-session history when a `StateStore` is provided
- **L3 community scores** — optional HTTP endpoint; returns `-1` when unconfigured or unreachable

#### Changed
- `createPipeline` `PipelineModules` extended with `intelligenceEngine`, `approvalQueue`, `telemetry`, `rateLimiter`, `checkpointThreshold`
- `DashboardOptions` extended with `queue`, `intelligenceEngine`, `rollbackEngine`, `telemetry`
- CLI banner updated to v0.3.0

---

### Milestone 0.2.0 — 2026-03-10

#### Added
- **M11 Risk Intelligence Engine** — L2 user-history Bayesian scoring, L3 community HTTP adapter
- **M12 Community Adapter Registry** — plugin registry for community risk providers
- **M13 Telemetry & Analytics** — in-memory event store, `getStats()`, per-action breakdowns
- **M10 Dashboard API** — REST server (`port+1`), approval queue, rollback, web UI with auto-refresh
- **ApprovalQueue** — in-memory queue with `enqueue`, `approve`, `deny`, webhook fire-and-forget
- **L2/L3 score blending** — weighted blend (L1 × 0.5 + L2 × 0.3 + L3 × 0.2) in `blendScores()`

#### Changed
- `MCPProxy.evaluateRisk` wires intelligence, telemetry, and approval queue

---

### Milestone 0.1.0 — 2026-03-05

#### Added
- **M1 MCP Proxy Core** — `MCPProxy` class, `createPipeline` factory
- **M2 State Store** — SQLite (WAL mode) with operation logs and checkpoint metadata
- **M3 Operation Logger** — structured log with PII scrubbing
- **M4 Checkpoint Engine** — pre-operation snapshot creation and listing
- **M5 File Shadow System** — file snapshot/restore using SQLite BLOB storage
- **M6 Risk Scoring Engine** — L1 static rules: destructive-flag, bulk-writes, path traversal, known-bad tools
- **M7 Intervention Controller** — allow / require_approval / block decision based on thresholds
- **M8 Rollback Engine** — restore files from checkpoint; plugin adapter hook
- **M9 Plugin Adapter SDK** — `PluginAdapter` interface, adapter registry, adapter validation
- Full Vitest test suite — 77 tests across 13 modules + E2E pipeline
