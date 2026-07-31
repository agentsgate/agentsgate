# Changelog

---

## [Unreleased]

### Changed

- **Protection levels, and a new default.** The shipped defaults were unusable
  for the case most people have — one person keeping an agent away from their
  own project. `git status` was blocked. So was `npm test`, and a one-row
  `UPDATE ... WHERE id = 1`. Writing a file needed approval every time. The one
  thing everyone actually fears, `DROP TABLE`, was blocked too, so the signal
  was buried in the noise.

  Thresholds could not fix that: `DROP TABLE` (1.00) and `SELECT * FROM users`
  (0.60) differ in kind, not degree, so raising the bar past the SELECT also
  clears `DELETE FROM orders` (0.90). Every built-in rule now carries a
  category, and a level says what to do with each — `agentsgate level` shows and
  sets it, `protection.level` configures it.

  `minimal` stops only wholesale destruction. **`balanced`, the new default,**
  also refuses credentials and holds outbound deletions, and leaves ordinary
  work alone — including deleting a file, which a checkpoint covers. `strict`
  adds personal-data reads, outbound sends, shell commands and deletions.
  Adding and updating run at every level; wiping a table is refused at every
  level. Policy rules are applied after the level and still override it.

  The dashboard carries the same switch in its header, over `GET`/`POST
  /protection`. Changing it there applies to the running proxy at once — the
  level is resolved per operation rather than captured at startup — and is
  written back to `config.json`, because a level that silently reverts is worse
  than one that cannot be changed. Setting it needs the `admin` role.

  This changes the default verdict for many operations. Anyone relying on the
  old behaviour can set `protection.level` to `strict`, or omit it and pin
  thresholds — a level is only applied when one is configured.

- **The CLI reference moved out of the README** into
  [docs/cli.md](docs/cli.md). The README kept a short table of the commands
  most people need and links to the full one; it was 678 lines, of which 149
  were command tables. The moved text also claimed
  `agentsgate <command> --help` gave per-command flags, which was never
  implemented — `--help` is only recognised as a top-level command, so
  `agentsgate start --help` was parsed as an argument to `start`. That
  sentence is gone, and `--version` and `--help` are now listed like any
  other command.
- **The configuration reference moved out of the README** into
  [docs/configuration.md](docs/configuration.md), same reasoning. The README
  keeps the four settings most deployments touch and links to the rest. The
  `logs.retentionDays` row said only that its default was unset; it now says
  what that means — startup does no auto-pruning at all, while
  `agentsgate prune` still falls back to 30 days.
- **The policy guide was rewritten and merged with the README's policy section**
  into [docs/policy-guide.md](docs/policy-guide.md), aimed at someone who has
  never written a policy file. Writing it turned up the three defects below;
  every command and every sample output in it was run against the built CLI.

### Added

- **`npm run check:pii`**, and the same check in CI. Word stamps its own
  application-level user name into a PDF's `/Author` on every export, whatever
  the source document says — so a clean `.docx` does not keep it out, and
  remembering to strip it afterwards has already failed twice. The check scans
  tracked files for PDF authorship, home paths, machine names and personal
  email addresses, and fails the build on a hit. It runs in the `audit` job and
  from `prepublishOnly`, and matches the shape of the problem rather than one
  person's details, so it keeps working if the project changes hands.

### Fixed

- **A test fixture broke on the last day of a long month.** `monthsAgo(1)`
  subtracted a month from the 31st, which asks for "June 31" and normalises
  forward to July 1 — so `monthsAgo(0)` and `monthsAgo(1)` landed in the same
  month and the "distinct months" assertions counted one where they wanted two.
  It now moves to mid-month before doing the arithmetic. Same family as the
  window-boundary flakes fixed for 0.1.0.

- **`loadConfig` dropped whole sections of the config file.** It rebuilt the
  object from a written-out list of keys, so anything added afterwards was read
  off disk and discarded with the default silently taking its place. Found
  while auditing this release: `protection.level` never reached the proxy, so
  `agentsgate level strict` wrote the file and changed nothing;
  `approvals.waitTimeoutMs`, `grantTtlMs` and `holdHttpRequests` were inert for
  the same reason. This is the same defect fixed in `loadPolicy` this release —
  listing keys by name is the bug — so the config is now spread rather than
  transcribed, and a test walks the whole document instead of the keys someone
  remembered.
- **The guides under `docs/` had drifted.** Audited mechanically against the
  source rather than by reading: `user-guide.md` carried five wrong L1 scores
  and a dashboard on port 3000; `openclaw-user-guide.md` had thirteen
  references to the pre-4000 ports; both named `agentsgate checkpoint list` and
  `agentsgate circuit list`, neither of which exists. `installation-guide.md`
  documented `--port 8080` and `--dashboard-port 4000` — the first works only
  because a bare number is picked up positionally, and the second is not a flag
  at all, so that example quietly put the dashboard somewhere the reader did
  not ask for. The policy guide this release rewrote had itself carried over
  two rule IDs that do not exist, `L1_LARGE_WRITE` and `L1_EXEC_COMMAND`, in
  the muting examples — copied verbatim they would have done nothing.

  `/errors` and `/snapshots` were undocumented and now appear in the API
  reference. The user and installation guides gained the protection level, in
  both languages, since without it they describe a product that blocks
  `git status`.
- **The dashboard header said `v0.5`**, hardcoded, while the package was
  0.1.x. It reads the shared version constant now, like the CLI banner and
  `/health`.

- **`L1_EXECUTE_COMMAND` no longer fires on a database write.** It matched the
  method name alone, and the database MCP servers call their write method
  `execute` — so a one-row `UPDATE ... WHERE id = 1` was scored as arbitrary
  code execution at 0.80 and blocked. Scoring takes the maximum, so
  `L1_DB_EXECUTE`'s own 0.30 could never take effect and the database rules were
  dead weight. Database tools are now excluded; everything else keeps the
  original reading.

- **Counting rows in a sensitive table no longer counts as exfiltration.**
  `L1_DB_EXFIL` fired on any SELECT naming `users`, `passwords`, `tokens` and
  the like, so `SELECT count(*) FROM users` — one number, no column values —
  scored 0.60 and waited for approval. It now scores 0.05 like any other read.
  The exemption is an allowlist of exactly `count()`, because most things that
  look like aggregates return the data: `max(password)` is the largest password
  verbatim, `group_concat` and `string_agg` return every row in one string,
  `mode() WITHIN GROUP` the most common value, and `sum(balance) WHERE id = 42`
  is that one person's balance. `GROUP BY`, `HAVING` and set operators
  disqualify too. A `WHERE` clause does not, which leaves repeated filtered
  counts as a blind oracle — bounded by rate limiting and the operation log
  rather than by scoring.
- **A singular table name is now as sensitive as a plural one.**
  `L1_DB_EXFIL` searched the whole SQL for words like `users`, and that list
  carried no `user` — as a substring it would have matched `user_id` and
  `username` in ordinary queries. So `SELECT * FROM user` scored 0.05 while
  `SELECT * FROM users` scored 0.60 on identical data, and schemas naming
  tables in the singular (Django, JPA and Prisma conventions among them) got no
  protection. Table names are now also read from their position after `FROM` and
  `JOIN`, where `user` cannot be confused with a column: `user`, `users`,
  `public."User"`, `app_user` and `user_accounts` all count, while
  `SELECT user_id FROM orders` still does not. The whole-text search stays, so a
  sensitive *column* on an unremarkable table — `SELECT password FROM accounts`
  — is unaffected.

- **`mutedRules` and `ruleOverrides` were discarded when the policy file was
  read.** `loadPolicy` rebuilt the policy from three named keys, so both fields
  were parsed and thrown away. The proxy reads them off the active policy, but
  nothing could put them there: muting a noisy built-in rule or re-scoring one
  did nothing at all, with no error. Documented since the feature shipped.

### Security

- **`require_approval` no longer executes in stdio proxy mode.** The stdio proxy
  short-circuited only on `block`; a `require_approval` verdict took the same
  path as `allow` and was forwarded to the MCP server, with the risk score
  annotated onto the params. The source called this "approval can be handled
  async" — but an approval that arrives after the tool has run is a
  notification, and `agentsgate inject` wires Claude Desktop through exactly
  this path, so with the default thresholds every operation scoring 0.3–0.7 ran
  unchecked. The README described the same band as "pause, create checkpoint,
  wait for user".

  The request is now held: the child is not called until an approver answers.
  `MCPStdioProxy` takes an `awaitApproval` resolver, and **without one the
  operation is refused**, because the proxy sits synchronously in the request
  path and there is no safe way to ask afterwards. A resolver that throws or
  never answers also leaves the operation unrun.

  Nine existing tests asserted the old behaviour — that `require_approval` was
  forwarded — and have been updated to supply an approver where they were
  really testing what happens to an approved call.

  Investigating it turned up a wider point: `ApprovalQueue.resolve()` only
  removed the item and recorded the outcome for L2 scoring, and nothing anywhere
  waited on it — approve/deny had always been after-the-fact review rather than
  a gate. stdio is the one place that can hold a call, and the rest of this
  entry makes that hold usable.

- **`agentsgate approve` now releases a held call.** The stdio proxy runs where
  the MCP client launched it and the dashboard runs under `agentsgate start`, so
  the two share only the SQLite file. A `require_approval` operation is written
  there, the dashboard lists it — `GET /approvals/pending` re-reads the store
  rather than only its own memory — and the verdict comes back the same way.
  Approve and the tool runs; deny, or answer nothing within
  `approvals.waitTimeoutMs` (new, default 60s), and it does not.

  Approvals are settled in place instead of deleted: `PendingApprovalRecord`
  gains `verdict` and `resolvedAt`, added by migration so existing databases
  keep working. A deleted row cannot tell a waiting process approved from denied
  from expired. The first verdict stands, so an approval arriving after the call
  was already refused cannot release it retroactively.

  `approvals.waitTimeoutMs` is deliberately short. The MCP client is blocked for
  the whole wait and has a timeout of its own; waiting longer than the client
  does means it gives up and a later approval would run the tool with nobody
  left to receive the result.

- **Approving now does something on the HTTP proxy too.** It never ran a
  `require_approval` operation — that part was always safe — but it answers the
  caller straight away, so there is no held request for an approval to release.
  Approving cleared the queue entry and nothing else: the only route to getting
  the work done was to lower the threshold, which permits the operation every
  time rather than once.

  Approving now leaves a **one-time grant**, and a retry of the same request
  spends it. "Same" means same agent, tool, method and arguments — the retry
  arrives with a new operation id, so the grant is keyed on a fingerprint of
  what the operation *is*. It is good for one retry, expires after
  `approvals.grantTtlMs` (default 5 minutes), and the check-and-spend is a
  single statement so two concurrent retries cannot both be told yes.

  `approvals.holdHttpRequests: true` opts into holding the caller instead, as
  the stdio proxy does, so the original call carries the result. Off by default:
  it keeps an HTTP request open for the length of the wait, which reverse
  proxies and load balancers may cut.

  Executing in the background after approval was considered and rejected. The
  caller has already been answered, so the side effect would land with nobody
  waiting for it; the parameters were built against state that has since moved;
  and the agent may have retried or worked around it in the meantime. A grant
  keeps execution synchronous with a live caller, which is where a gate belongs.


- **A policy pattern written `/…/i` never matched.** Match values were treated
  as a regular expression only when they both started and ended with a slash, so
  any pattern carrying flags — the form used in the README, in the policy guide,
  and in **every built-in preset** — fell through to an exact string comparison.
  `agentsgate policy preset apply readonly` claims to block every write, delete
  and exec, and blocked none of them; `strict` was equally inert. Anyone who
  applied a preset to lock an agent down got no rule enforcement whatsoever.
  Flags are now honoured, and omitting them still means case-insensitive, so
  existing `/…/` patterns are unaffected.
- **A policy file that failed to parse disarmed the running policy.** With
  `--policy` set the file is watched; `loadPolicy` answered "no rules" for a
  malformed file exactly as it does for a missing one, so saving a half-typed
  edit swapped the live policy for an empty one — silently, and for as long as
  the typo survived. A file that does not parse is now ignored, the previous
  policy stays in force, and the reason is printed to stderr.

---

## [0.1.2] — 2026-07-29

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
  can keep npm's strictest publishing-access setting. This needs npm 11.5.1 or
  later, which the publish job installs itself — Node 20 ships npm 10. The npm
  major is pinned: `npm@latest` is 12, which requires Node 22 or newer and so
  cannot install on that job at all.
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
