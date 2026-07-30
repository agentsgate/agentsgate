# Policy Guide

AgentsGate scores every operation an agent attempts and decides whether to let
it through. A **policy** is how you change those decisions without touching
code — block a tool outright, trust a particular agent, raise the bar for
anything touching `/secrets/`.

This guide starts from nothing and builds up. If you have never written a policy
file, read it top to bottom; each section adds one idea to the previous one.

- [How a decision gets made](#how-a-decision-gets-made)
- [Your first rule](#your-first-rule)
- [The policy file](#the-policy-file)
- [Rules](#rules)
  - [Matching](#matching)
  - [What a rule does when it matches](#what-a-rule-does-when-it-matches)
  - [Order, and why it matters](#order-and-why-it-matters)
- [Thresholds](#thresholds)
- [Agent access control](#agent-access-control)
- [Adjusting the built-in rules](#adjusting-the-built-in-rules)
- [Presets](#presets)
- [Managing policies from the CLI](#managing-policies-from-the-cli)
- [Reloading without a restart](#reloading-without-a-restart)
- [Splitting a policy across files](#splitting-a-policy-across-files)
- [Field reference](#field-reference)

---

## How a decision gets made

Every operation goes through the same three steps.

**1. Built-in rules produce a score.** AgentsGate ships a set of rules — their
IDs all start with `L1_` — that recognise risky shapes: deleting a file, dropping
a table, writing to `.env`. Each rule that fires contributes to a score between
`0.0` (harmless) and `1.0` (as dangerous as it gets). Run `agentsgate policy list`
to see them.

**2. Your policy can overrule that.** A rule you write can replace the score
outright, or skip scoring altogether and force a decision.

**3. The score becomes a verdict, using two thresholds.**

```
0.0                allowBelow                blockAtOrAbove              1.0
 |──────── allow ──────|──── require_approval ────|──────── block ────────|
                      0.3                        0.7
```

- **allow** — the operation runs. You see it in the log afterwards.
- **require_approval** — the operation is paused, a checkpoint is taken, and it
  waits for you (`agentsgate approvals`, or the dashboard).
- **block** — the operation is refused and the reason is recorded.

Nothing is required to get started: with no policy file at all, the built-in
rules and the default thresholds apply.

---

## Your first rule

Say an agent keeps trying to delete files and you want to stop that outright.

```bash
agentsgate policy add \
  --id=NO_DELETES \
  --tool=filesystem \
  --method='/delete|unlink|rm/i' \
  --action=block \
  --description='Never let an agent delete a file'
```

That writes `~/.agentsgate/policy.json` for you. Check it landed:

```bash
agentsgate policy list
```

Then try it without involving a real agent:

```bash
agentsgate policy test --tool=filesystem --method=delete_file
```

```
Policy test for simulated operation:

  Tool:    filesystem
  Method:  delete_file
  Agent:   test-agent

  Forced action: BLOCK
  Score override: (none — built-in L1 rules apply)
```

`policy test` reads the policy file directly, so it works whether or not the
proxy is running. That makes it the safest way to check a rule before trusting
it in front of a real agent.

To undo:

```bash
agentsgate policy remove NO_DELETES
```

---

## The policy file

`~/.agentsgate/policy.json`. Point somewhere else with `--policy=path` on any
command.

```json
{
  "rules": [],
  "thresholds": { "allowBelow": 0.3, "blockAtOrAbove": 0.7 },
  "agents": { "allowlist": [], "denylist": [], "toolRules": {} },
  "mutedRules": [],
  "ruleOverrides": {}
}
```

Every field is optional. An empty `{}` is a valid policy and means "use all the
defaults". You never need to write a key you are not using.

---

## Rules

A rule is a **match** plus what to do about it.

```json
{
  "rules": [
    {
      "id": "BLOCK_PROD_DB_DELETE",
      "description": "Deletes and drops on the database tool are never allowed",
      "match": { "tool": "database", "method": "/delete|drop/i" },
      "action": "block",
      "priority": 10
    },
    {
      "id": "TRUST_READONLY_AGENT",
      "description": "This agent can only read, so treat its work as low risk",
      "match": { "agentId": "readonly-agent" },
      "score": 0.05
    },
    {
      "id": "ELEVATE_SECRET_WRITES",
      "description": "Anything under /secrets/ is as risky as it gets",
      "match": { "pathPattern": "/secrets/" },
      "score": 0.95
    },
    {
      "id": "REDACT_API_KEYS",
      "description": "Keep credentials out of the operation log",
      "match": { "tool": "http" },
      "redact": ["apiKey", "authorization", "password"]
    }
  ]
}
```

### Matching

| Field | Matches against |
|-------|-----------------|
| `tool` | The MCP tool name — `filesystem`, `database`, `http`, … |
| `method` | The method on that tool — `write_file`, `execute`, … |
| `agentId` | Which agent is asking |
| `pathPattern` | The file path in `params.path`, `params.filePath` or `params.file` |
| `paramsMatch` | Named parameter values — `{ "channel": "/^D[A-Z0-9]+/" }` |
| `tags` | The operation must carry **all** the listed tags |

Three things to remember.

**Everything in a `match` must match.** Listing `tool` and `method` means both,
not either. To express "or", write two rules.

**A plain string is an exact match.** `"tool": "database"` matches the tool
called `database` and nothing else — not `database-prod`. For anything looser,
wrap the value in slashes to make it a regular expression:

```json
"method": "/delete|drop/i"     matches delete_row, DROP TABLE, deleteAll
"tool":   "/^prod-/"           matches prod-db, prod-cache
```

The trailing letters are regex flags; `i` means case-insensitive. Omit them and
you get `i` anyway, which is usually what you want for method names — spell out
a flag set only when you specifically need case sensitivity.

This applies to `tool`, `method`, `agentId` and the values inside `paramsMatch`.

**`pathPattern` is the exception: it is always a regular expression, written
without the slashes.**

```json
"pathPattern": "secrets"          matches /var/secrets/key
"pathPattern": "/secrets/"        also matches — as the literal path segment
"pathPattern": "\\.env$"           matches .env, but not .environment
```

Writing `"/secrets/i"` there does not mean "case-insensitive"; it looks for the
six characters `/secrets/i` in the path, and matches nothing.

### What a rule does when it matches

A rule can do any of these, and they are independent:

| Key | Effect |
|-----|--------|
| `action` | Decide immediately — `allow`, `block` or `require_approval`. Thresholds are not consulted. |
| `score` | Replace the built-in score with yours (`0`–`1`). Thresholds then decide. |
| `max` | Cap the score this rule can produce. |
| `redact` | Replace these parameter keys with `[REDACTED]` in the operation log. |

`action` is a decision; `score` is an opinion that the thresholds still judge.
Reach for `score` when you want the operation treated as more or less risky than
AgentsGate thinks, and `action` when the answer is the same regardless of where
you set your thresholds.

`redact` is worth using early. The operation log stores the arguments an agent
passed, verbatim — that includes API keys and passwords unless you say
otherwise.

### Order, and why it matters

Rules are sorted by `priority`, **lowest number first** (the default is `100`).
Ties keep the order you wrote them in. The **first** rule that matches wins for
`score`, and the first that matches wins for `action`.

So a catch-all with a low priority number will shadow everything below it:

```json
{
  "rules": [
    { "id": "EMERGENCY_BLOCK",   "match": { "agentId": "compromised-agent" }, "action": "block", "priority": 1 },
    { "id": "GENERAL_HIGH_RISK", "match": { "tool": "filesystem" },           "score": 0.8,      "priority": 100 }
  ]
}
```

`compromised-agent` is blocked before the filesystem rule is ever considered.
Give the rules that must not be overridden a small number, and leave everything
else at the default.

---

## Thresholds

```json
{ "thresholds": { "allowBelow": 0.3, "blockAtOrAbove": 0.7 } }
```

- Score **below** `allowBelow` → allowed.
- Score **at or above** `blockAtOrAbove` → blocked.
- Anything between → waits for approval.

Defaults are `allowBelow: 0.3` and `blockAtOrAbove: 0.7`, from
`~/.agentsgate/config.json`. Setting them here overrides that for policy
evaluation.

Moving `blockAtOrAbove` down makes AgentsGate stricter; moving `allowBelow` up
makes it quieter. Narrowing the gap between them means fewer approval prompts
and more automatic decisions — in both directions.

```bash
agentsgate policy set-threshold --allowBelow=0.3 --blockAtOrAbove=0.75
```

---

## Agent access control

Rules judge operations. This judges **who is asking**, before any scoring
happens.

```json
{
  "agents": {
    "denylist": ["malicious-agent", "/^test-/"],
    "allowlist": [],
    "toolRules": {
      "data-analyst": {
        "allowlist": ["database", "filesystem"],
        "denylist": ["shell"]
      },
      "/^prod-.*/": {
        "denylist": ["shell", "http"]
      }
    }
  }
}
```

- **`denylist`** — matching agents are blocked outright. Checked first, so it
  beats everything else.
- **`allowlist`** — while it is empty, every agent is allowed. The moment you put
  one entry in it, every agent *not* listed is blocked. This is easy to trip
  over: adding one trusted agent locks out all the others.
- **`toolRules`** — which tools a given agent may use. The key is an agent
  pattern (exact or `/regex/`). Inside, `denylist` beats `allowlist`, and a
  non-empty `allowlist` restricts that agent to exactly those tools.

From the CLI:

```bash
agentsgate policy agent list
agentsgate policy agent deny 'untrusted-*'
agentsgate policy agent allow my-agent
agentsgate policy agent remove my-agent

agentsgate policy agent tool-allow data-analyst database
agentsgate policy agent tool-deny  data-analyst shell
agentsgate policy agent tool-remove data-analyst shell
```

---

## Adjusting the built-in rules

Sometimes a built-in `L1_` rule is right in general and wrong for you. Two ways
to deal with that, without writing a rule of your own.

**Mute it.** The rule still runs, but contributes nothing to the score.

```json
{ "mutedRules": ["L1_SENSITIVE_FILE_TYPE", "L1_LARGE_WRITE"] }
```

**Re-score it.** The rule still fires and still contributes — with your number
instead of the built-in one.

```json
{ "ruleOverrides": { "L1_DELETE_FILE": 0.5, "L1_EXEC_COMMAND": 0.9 } }
```

Prefer re-scoring. Muting removes a signal entirely, so a genuinely dangerous
operation stops being visible; lowering the score keeps it in the picture, just
weighted the way you want.

`agentsgate policy list` prints every built-in rule ID, which is where you get
the names for both.

### A note on database reads

`L1_DB_EXFIL` scores a SELECT at `0.60` when it names a table that sounds
sensitive — `users`, `passwords`, `tokens`, `credentials`, `billing` and
similar. Counting is exempt, because a count reveals a number and no column
values:

```sql
SELECT count(*) FROM users            -- 0.05, allowed
SELECT count(*) FROM users WHERE active   -- 0.05, allowed
SELECT * FROM users                   -- 0.60, waits for approval
```

The exemption covers `count()` and nothing else, deliberately. `max(password)`
is the largest password verbatim; `group_concat(email)` and `string_agg(email)`
return every row in one string; `sum(balance) WHERE id = 42` is one person's
balance. A `GROUP BY`, a `HAVING`, or a `UNION` also disqualifies.

Two limits worth knowing:

- **The table-name list is literal.** `users` is on it, `user` is not — so
  `SELECT * FROM user` scores `0.05`. If your schema uses singular names, add a
  rule with `paramsMatch` on the SQL text.
- **Repeated filtered counts are still an oracle.** `count(*) FROM users WHERE
  password LIKE 'a%'`, asked enough times, narrows a value down. Scoring does
  not catch that; rate limiting (`rateLimit` in `config.json`) and reading the
  operation log do.

> Both fields were silently discarded before 0.1.3 — read out of the file and
> thrown away — so muting and re-scoring did nothing at all. Likewise, a pattern
> written `/…/i` never matched anything until 0.1.3, which left every built-in
> preset inert. If you wrote either on an older version and wondered why nothing
> changed, that was why.

---

## Presets

A preset is a whole policy, written for you, as a starting point.

```bash
agentsgate policy preset list          # see what each one contains
agentsgate policy preset apply strict
```

| Preset | Thresholds | What it does |
|--------|-----------|--------------|
| `strict` | `0.1` / `0.5` | Blocks deletes; sends writes, creates and any shell tool to approval |
| `permissive` | `0.6` / `0.9` | Blocks only the irreversible things — drop, truncate, format, wipe — and asks about production database deletes |
| `readonly` | `0.05` / `0.1` | Blocks everything that could change state, and every shell tool |

Applying a preset **replaces** your policy. If you already have rules, the
command refuses unless you pass `--force`, so export first if you want a way
back:

```bash
agentsgate policy export my-policy-backup.json
agentsgate policy preset apply strict --force
```

Presets are a starting point, not a finished configuration. Apply one, then edit
the file.

---

## Managing policies from the CLI

Everything here can also be done by editing the JSON by hand.

```bash
# Look at what is in effect
agentsgate policy list                    # your rules and thresholds, from the file
agentsgate policy rules                   # what the running proxy has loaded
agentsgate policy stats                   # how often each rule has actually fired

# Change rules
agentsgate policy add --id=MY_RULE --tool=filesystem --method=write_file --score=0.7
agentsgate policy add --id=URGENT --tool=shell --action=block --priority=5
agentsgate policy remove MY_RULE

# Thresholds
agentsgate policy set-threshold --allowBelow=0.3 --blockAtOrAbove=0.75

# Move a policy between machines
agentsgate policy export policy-backup.json
agentsgate policy import policy-backup.json          # --force to overwrite existing rules

# Try before you trust
agentsgate policy test --tool=filesystem --method=delete_file --agentId=my-agent
agentsgate policy evaluate --tool=filesystem --method=delete_file --agentId=my-agent
```

Flags for `policy add`: `--id` (required), `--tool`, `--method`, `--agentId`,
`--pathPattern`, `--score`, `--action`, `--priority`, `--description`. They take
the form `--name=value`; the space-separated form is not recognised.

**`test` and `evaluate` are not the same command.** `test` reads the policy file
and needs nothing running — use it while you are writing rules. `evaluate` asks
the running proxy what *it* would decide, which is what you want when the file
and the running process might have drifted apart.

`policy rules` and `policy stats` also need the proxy running; they read from the
dashboard.

---

## Reloading without a restart

Start with an explicit policy path and the file is watched. Save it and the new
version takes effect a fraction of a second later, with no restart and no
dropped operations:

```bash
agentsgate start --policy=/etc/agentsgate/policy.json
```

**Watching only happens when you pass `--policy`.** Started without it,
AgentsGate reads `~/.agentsgate/policy.json` once at startup and does not look
at it again — editing the file then requires `agentsgate stop && agentsgate start`.
If you expect to iterate on rules, start with `--policy` pointing at the default
path and you get reloading for free:

```bash
agentsgate start --policy=~/.agentsgate/policy.json
```

A file that fails to parse is ignored and the previous policy stays in force, so
saving mid-keystroke will not disarm your rules. AgentsGate prints why on
stderr and keeps going with what it already had.

> Before 0.1.3 that was not true: a broken file replaced the live policy with an
> empty one, silently, for as long as the typo survived. If you have edited a
> policy file with an older version running, check `agentsgate policy rules`
> against what you expect.

---

## Splitting a policy across files

A policy can be assembled from several files — useful when an organisation-wide
baseline is combined with per-team additions. Files are sorted by name, so a
numeric prefix makes the order explicit:

```
00-base.json      thresholds and the rules nobody may override
10-team.json      team-specific tools
20-project.json   this project only
```

They merge like this:

- **Rules** from every file are concatenated. `priority` decides evaluation
  order across the whole set, not the file it came from.
- **Thresholds** — later files win.
- **Agent denylists** are concatenated; allowlists and tool rules — later files
  win.
- **`mutedRules`** are concatenated; **`ruleOverrides`** merge key by key, later
  files winning.

This is available through the library API (`loadPolicies`), not from the CLI —
there is no `--policy-dir` flag. Merge the files yourself and pass the result to
`--policy`, or call `loadPolicies` from a wrapper.

---

## Field reference

### Rule

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier. Required. Appears in `ProxyDecision.reasons` and in `agentsgate explain`. |
| `description` | string | Free text for whoever reads the file next. Optional. |
| `match` | object | The conditions below. All specified fields must match. |
| `score` | number | Replace the built-in risk score, `0`–`1`. First matching rule wins. |
| `action` | string | Force `allow`, `block` or `require_approval`, skipping the thresholds. |
| `priority` | number | Evaluation order, lowest first. Default `100`. |
| `max` | number | Upper bound on the score this rule can produce. |
| `redact` | string[] | Parameter keys replaced with `[REDACTED]` in the operation log. |

### `match`

| Field | Type | Description |
|-------|------|-------------|
| `tool` | string | Tool name — exact, or `/regex/flags` |
| `method` | string | Method name — exact, or `/regex/flags` |
| `agentId` | string | Agent identifier — exact, or `/regex/flags` |
| `pathPattern` | string | Regex tested against `params.path`, `params.filePath`, `params.file`. Bare source — no surrounding slashes, no flag suffix. |
| `paramsMatch` | object | Parameter name → exact string or `/regex/flags`. All entries must match. |
| `tags` | string[] | The operation must carry every listed tag |

### Top level

| Field | Type | Description |
|-------|------|-------------|
| `rules` | Rule[] | Your rules. Defaults to none. |
| `thresholds.allowBelow` | number | Below this, allow. Default `0.3`. |
| `thresholds.blockAtOrAbove` | number | At or above this, block. Default `0.7`. |
| `agents.allowlist` | string[] | When non-empty, only these agents may run at all. |
| `agents.denylist` | string[] | These agents are always blocked. Beats the allowlist. |
| `agents.toolRules` | object | Per-agent tool allow/deny lists, keyed by agent pattern. |
| `mutedRules` | string[] | Built-in rule IDs whose score contribution is discarded. |
| `ruleOverrides` | object | Built-in rule ID → replacement score. |

---

## Related

- [cli.md](cli.md) — every command and flag
- [configuration.md](configuration.md) — `config.json`, including the default thresholds
- [api-reference.md](api-reference.md) — evaluating and editing policy over the REST API
