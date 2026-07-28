# Security Policy

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Report privately via [GitHub Security Advisories](https://github.com/agentsgate/agentsgate/security/advisories/new),
or by email to **security@agentsgate.net**.

Include:
- Description of the vulnerability
- Steps to reproduce
- Affected versions
- Potential impact

We aim to acknowledge within 48 hours and to release a patch within 14 days for
Critical/High severity issues.

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | ✅ Yes     |

---

## Threat model — read this before deploying

AgentsGate is a **local, single-operator security tool**. It sits between an AI
agent and the MCP servers that agent calls, and it holds a complete record of
everything the agent did — including tool arguments and results, which routinely
contain file contents, database rows, and credentials.

Two facts drive every deployment decision:

1. **The proxy transport has no authentication.** None. Anything that can reach
   the proxy port can forward operations through it.
2. **The dashboard's authentication is opt-in.** With no `dashboard.apiKey` set,
   every dashboard endpoint — including rollback and session expiry — is
   reachable without credentials.

Both are safe *only* because AgentsGate binds to loopback by default.

### Default: loopback-only

`proxy.host` defaults to `127.0.0.1`. The proxy, the dashboard, and the WebSocket
gateway all bind to this address, so out of the box nothing is reachable from
another machine.

| Surface | Default port | Default bind | Built-in auth |
|---------|--------------|--------------|---------------|
| MCP proxy | `4000` (`proxy.port`) | `127.0.0.1` | **None** |
| Dashboard REST/SSE | `4001` (`proxy.port` + 1) | `127.0.0.1` | Opt-in (`dashboard.apiKey`) |
| WebSocket gateway | — | `127.0.0.1` | Inherits dashboard key |

### Exposing AgentsGate beyond loopback

If you set `proxy.host` to a routable address, **you must put an authenticating
reverse proxy in front of it.** There is no configuration of AgentsGate alone
that makes a non-loopback bind safe.

A safe exposed deployment requires all of:

1. A reverse proxy (nginx, Caddy, Traefik) terminating TLS and enforcing
   authentication in front of **both** ports.
2. `dashboard.apiKey` set to a long random string (32+ bytes), or
   `dashboard.roles` for per-key RBAC.
3. A firewall restricting the proxy and dashboard ports to the reverse proxy only.
4. `audit.signingSecret` set, so tampering with the operation log is detectable.

AgentsGate warns on stdout at startup when it binds to a non-loopback host, and
warns additionally when the dashboard has no API key. Treat those warnings as
errors in production.

> Binding to `0.0.0.0` on a shared or cloud host without a reverse proxy exposes
> unauthenticated operation forwarding and full read access to your agent's
> history. Do not do it.

---

## Security controls

### Dashboard authentication and RBAC

- `dashboard.apiKey` — when set, all dashboard endpoints except `GET /health`
  require an `X-API-Key: <key>` header. Comparison is constant-time.
- Query-parameter auth is deliberately **not** supported, to keep keys out of
  server access logs and browser history.
- `dashboard.roles` maps API keys to `viewer` (read-only), `approver` (viewer +
  approve/reject), or `admin` (full access, including rollback, session expiry,
  and circuit-breaker reset). Unknown keys are denied. A `dashboard.apiKey` set
  alongside `roles` is treated as an admin key.
- There is no user database, no login flow, and no key rotation mechanism —
  rotate by editing config and restarting.

### Audit log integrity

- With `audit.signingSecret` set, every operation log is HMAC-SHA256 signed
  before it is persisted. Verify with `agentsgate audit --verify`.
- The signing secret must stay confidential; if it leaks, log integrity can no
  longer be established.
- Logs live in SQLite on local disk. Restrict the file with OS permissions —
  they contain full agent inputs and outputs.

### Outbound requests (SSRF defense)

AgentsGate fetches several operator-configured URLs. Where a check is applied
it is:

- Protocol allow-list (`http:` / `https:` only).
- DNS resolution followed by a denylist covering loopback, RFC1918 private
  ranges, link-local, CGNAT (`100.64.0.0/10`), multicast/reserved, IPv6
  loopback/link-local/ULA, IPv4-mapped IPv6, and the `169.254.169.254` cloud
  metadata address.

Resolving DNS first matters: a hostname allow-list alone is bypassable by a
public domain whose A record points at an internal address.

Every outbound target is checked. Strictness depends on where that target
legitimately lives:

| Outbound target | Denylist |
|-----------------|----------|
| Approval webhook | Full — loopback, private, link-local, metadata |
| Slack notifier | Full |
| Slack rollback adapter | Full |
| Community intelligence endpoint | Full |
| Telemetry stats export | Link-local/metadata only |
| Telemetry anomaly webhook | Link-local/metadata only |
| Telemetry OTLP export | Link-local/metadata only |
| Dashboard OTLP export | Link-local/metadata only |

Slack and the community endpoint are always external services, so anything
resolving inward is a misconfiguration and is refused. Telemetry sinks — stats
collectors, OTLP receivers, alert routers — routinely run on a private network
or on loopback beside the proxy, so blocking those would reject legitimate
deployments. Those paths block the link-local/metadata range instead, which is
the address an SSRF is actually worth aiming at (`169.254.169.254` and friends).

### Dashboard rendering of agent-controlled data

The monitored agent chooses its own identifiers. Agent id, tool name, method,
parameters and error text all reach the dashboard as attacker-controlled
strings, so the console you use to police an agent is a target that agent can
write to. Everything of that kind is HTML-escaped before it enters the DOM —
`&`, `<`, `>`, `"`, `'` and `` ` `` — in text, in attribute values, and in the
JSON payloads embedded in click handlers.

A quoted agent-supplied value would otherwise close an attribute and open an
event handler of the agent's choosing. That specific escape was missing from
the quick-rule buttons until it was fixed; the regression tests now render the
affected components with a breakout payload and assert that no event handler
other than the intended `onclick` survives.

Related properties the dashboard holds to:

- The page loads no scripts, styles or fonts from a remote origin, so a
  third-party host can never read your operation history and the dashboard
  works in an air-gapped deployment.
- The API is addressed relative to the dashboard's own origin, so it stays
  correct behind a reverse proxy on any path.
- The page is a static constant. Nothing is interpolated into it per request,
  so server state cannot leak into the served HTML.

Escaping the display is not a substitute for the trust model above: it stops an
agent from attacking your browser, not from reaching an unauthenticated
dashboard in the first place.

### Webhook payload signing

When `webhook.secret` is set, every webhook POST carries
`X-AgentsGate-Signature: sha256=<hex>`, an HMAC-SHA256 over the raw JSON body.
Receivers should verify it before acting. Webhook payloads contain full
operation data — only configure endpoints you control, over HTTPS.

### Policy regex safety

Policy rules may contain user-supplied regular expressions. Node has no regex
timeout, so a catastrophic-backtracking pattern would hang the single-threaded
event loop for the entire gateway. AgentsGate therefore:

- Refuses patterns matching a **heuristic** nested-quantifier detector
  (`(a+)+`, `(a*)*`, adjacent unbounded quantifiers), logging a warning and
  treating the rule as non-matching.
- Caps regex input length at 4096 characters.

This is a heuristic, not a proof. It is a denial-of-service bound, not a
guarantee — see Residual risks.

### Policy file trust

Policy files are plain JSON loaded at startup with no signature verification.
**Anyone who can write your policy file can disable every risk rule.** Protect
it with file permissions (`chmod 600`) and keep it in version control so
unexpected changes are visible.

---

## Residual risks

These are known and accepted for the current release. They are listed so you can
decide whether they matter for your deployment.

| Risk | Impact | Mitigation |
|------|--------|------------|
| Proxy transport is unauthenticated | Anything that reaches the port can forward operations | Loopback-only default; reverse proxy with auth if exposed |
| Dashboard auth is opt-in | No key set → full admin access to anyone who can reach the port | Set `dashboard.apiKey`; startup warns when exposed without one |
| No DNS rebinding protection | A malicious web page could drive a browser to reach a loopback-bound dashboard | Set `dashboard.apiKey` — the `X-API-Key` header cannot be forged cross-origin |
| ReDoS guard is heuristic | A novel catastrophic pattern could evade the detector | 4096-char input cap bounds worst case; treat policy files as trusted input |
| Telemetry senders allow private/loopback targets | A telemetry URL pointing at an internal host is dialled | Deliberate — internal collectors are the normal deployment; link-local/metadata is still refused |
| No built-in TLS | Traffic is plaintext on the wire | Terminate TLS at a reverse proxy |
| No key rotation | Rotation requires config edit + restart | Automate via config management |
| No built-in log rotation | SQLite grows unbounded | Use `logs.retentionDays` for auto-pruning |
| Secrets in logs | Tool arguments/results may contain credentials | Restrict DB file permissions; dashboard config output redacts `apiKey` and `signingSecret` |

---

## Dependency and vulnerability policy

Runtime dependencies are held to a higher bar than build/test tooling, which
never ships and never runs on a user's machine. Where an advisory has no
upstream fix, we document why it is not exploitable rather than pinning to a
version that breaks.

### What you will see after `npm install agentsgate`

Two **moderate** advisories, both the same upstream issue:

- **`@hono/node-server` < 2.0.5** — path traversal in `serve-static` on Windows
  via an encoded backslash (`%5C`), surfaced a second time as
  `@modelcontextprotocol/sdk` "depends on a vulnerable version".

**Not exploitable in AgentsGate.** The MCP SDK imports exactly one symbol from
that package — `getRequestListener`, a Node↔Web request adapter. The vulnerable
`serveStatic` middleware is never imported or invoked, by the SDK or by
AgentsGate; the dashboard serves its own HTML through `node:http`. The advisory
is additionally Windows-specific.

The real fix has to come from upstream: the MCP SDK pins `@hono/node-server` to
the 1.x line, and npm `overrides` apply only to the root project, so a pin here
would not reach you. This repository does pin the patched 2.x line via
`overrides` for its own development and CI (the full test suite passes against
it), which is why `npm audit` is clean when run inside the repo but not after
installing the package. We will drop the override and raise the SDK floor as
soon as the SDK ships a 2.x-compatible release.

### Development-only advisories

- **esbuild (low)** — reachable only when running an esbuild *development
  server*, which this project never starts. Pulled in transitively by `tsup` and
  `vite`. No upstream fix available at time of writing.

Verify the split yourself:

```bash
npm audit --omit=dev   # runtime tree only
npm audit              # includes build/test tooling
```

If you find that any of the above reasoning is wrong, that is itself a security
report — please use the reporting process at the top of this document.

---

## Deployment checklist

- [ ] Leave `proxy.host` at `127.0.0.1` unless you have a reverse proxy with auth
- [ ] Set `dashboard.apiKey` to a 32+ byte random string (required if exposed)
- [ ] Set `audit.signingSecret` so log tampering is detectable
- [ ] Restrict permissions on the SQLite database and policy files
- [ ] Run as a non-root user (the Docker image includes an `agentsgate` user)
- [ ] Configure webhooks over HTTPS only, with `webhook.secret` set
- [ ] Set `logs.retentionDays` so the operation log does not grow unbounded
- [ ] Monitor the audit log for unexpected `block` decisions
