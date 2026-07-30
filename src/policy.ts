/**
 * AgentsGate policy loader.
 * Reads ~/.agentsgate/policy.json and applies custom risk rules and
 * intervention threshold overrides on top of the default pipeline.
 *
 * Example policy.json:
 * {
 *   "rules": [
 *     {
 *       "id": "BLOCK_PROD_DB_DELETE",
 *       "description": "Always block deletes on the production database tool",
 *       "match": { "tool": "database", "method": "/delete|drop/i" },
 *       "action": "block"
 *     },
 *     {
 *       "id": "TRUST_READONLY_AGENT",
 *       "description": "Treat all ops from the readonly-agent as low risk",
 *       "match": { "agentId": "readonly-agent" },
 *       "score": 0.05
 *     },
 *     {
 *       "id": "ELEVATE_SECRET_WRITES",
 *       "description": "Treat writes to /secrets/ as very high risk",
 *       "match": { "pathPattern": "/secrets/" },
 *       "score": 0.95
 *     }
 *   ],
 *   "thresholds": { "allowBelow": 0.2, "blockAtOrAbove": 0.8 }
 * }
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
export type { FSWatcher };
import type { MCPOperation } from './types/interfaces.js';

// ── Policy types ──────────────────────────────────────────────────────────────

/**
 * Match criteria for a policy rule. All specified fields must match (AND logic).
 * String values are treated as exact matches unless wrapped in /…/ for regex.
 *
 * @example { tool: "filesystem", method: "/write|delete/" }
 */
export interface PolicyRuleMatch {
  /** MCP tool name — exact or /regex/ */
  tool?: string;
  /** Tool method — exact or /regex/ */
  method?: string;
  /** Agent identifier — exact or /regex/ */
  agentId?: string;
  /** Regex matched against params.path / params.filePath / params.file */
  pathPattern?: string;
  /** Rule fires only when the operation has ALL of these tags */
  tags?: string[];
  /**
   * Match against arbitrary operation parameter values.
   * Each key maps to a param field name; each value is an exact string or /regex/ pattern.
   * ALL entries must match (AND logic) for the rule to fire.
   *
   * @example { "channel": "/^D[A-Z0-9]+/" }   // Slack DM channels
   * @example { "to": "alice@example.com" }       // exact email recipient
   */
  paramsMatch?: Record<string, string>;
}

/**
 * A single custom risk rule. Rules are evaluated in priority order; the first match wins.
 */
export interface PolicyRule {
  /** Unique rule identifier (surfaced in ProxyDecision.reasons). */
  id: string;
  /** Human-readable description (optional). */
  description?: string;
  /** All specified fields must match for this rule to fire. */
  match: PolicyRuleMatch;
  /**
   * Override the L1 static risk score [0, 1].
   * When set, replaces the score that the built-in L1 rules would produce.
   * The blended L2/L3 re-weighting still applies on top of this value.
   */
  score?: number;
  /**
   * Force a specific proxy action, bypassing the threshold comparison entirely.
   * Takes effect after the score is determined (and after L2/L3 blending).
   */
  action?: 'allow' | 'block' | 'require_approval';
  /**
   * Evaluation priority — lower numbers are evaluated first (default: 100).
   * Rules with equal priority are evaluated in their declaration order.
   * Use this to ensure critical rules (e.g. emergency blocks) are checked
   * before broader catch-all rules.
   */
  priority?: number;
  /**
   * Optional ceiling on the risk score this rule can produce [0, 1].
   * When set alongside `score`, the effective score is `Math.min(score, max)`.
   * Useful to prevent a single rule from pushing the total score above a threshold.
   */
  max?: number;
  /**
   * Parameter keys to redact (replace with "[REDACTED]") in the operation log
   * when this rule matches. Useful for masking PII or secrets beyond the default set.
   */
  redact?: string[];
}

/**
 * Top-level policy document loaded from policy.json.
 */
export interface AgentsGatePolicy {
  /** Custom risk rules, evaluated in order (first match wins). */
  rules: PolicyRule[];
  /**
   * Override the global intervention thresholds from config.
   * Useful when the operator wants tighter or looser defaults for a given
   * deployment without changing infrastructure config.
   */
  thresholds?: {
    allowBelow?: number;
    blockAtOrAbove?: number;
  };
  /**
   * Agent-level access control.
   *
   * - `denylist`: patterns (exact or /regex/) whose matching agentIds are always blocked.
   * - `allowlist`: when non-empty, only agentIds matching at least one pattern are allowed;
   *   all others are blocked.
   * - `toolRules`: per-agent tool restrictions.  Key is an agentId pattern (exact or /regex/).
   *   Value is `{ allowlist?, denylist? }` of tool name patterns.  Denylist takes priority.
   *
   * Agent denylist/allowlist is evaluated before tool rules, which are evaluated before `rules`.
   */
  agents?: {
    allowlist?: string[];
    denylist?: string[];
    toolRules?: Record<string, {
      allowlist?: string[];
      denylist?: string[];
    }>;
  };
  /**
   * L1 rule IDs that should be silenced (their score contribution is discarded).
   * Use this to suppress false-positive rules without removing them from the engine.
   * Example: `["L1_SENSITIVE_FILE_TYPE"]` to stop flagging .env files for trusted agents.
   */
  mutedRules?: string[];
  /**
   * Override the score of specific built-in L1 rules.
   * Key = rule ID (e.g. "L1_DELETE_FILE"), value = replacement score [0, 1].
   * Overridden rules still fire — they contribute the new score instead of the built-in one.
   * Takes effect before mutedRules checks (a muted rule is discarded even if overridden).
   */
  ruleOverrides?: Record<string, number>;
}

const DEFAULT_PRIORITY = 100;

/** Return rules sorted by priority (ascending). Stable sort preserves declaration order for equal priority. */
function sortedRules(rules: PolicyRule[]): PolicyRule[] {
  return [...rules].sort((a, b) => (a.priority ?? DEFAULT_PRIORITY) - (b.priority ?? DEFAULT_PRIORITY));
}

// ── Rule matching helpers ─────────────────────────────────────────────────────

/** Cap the length of a value tested against a regex — bounds worst-case backtracking. */
const MAX_REGEX_INPUT = 4096;

/**
 * Heuristic detector for regex patterns prone to catastrophic backtracking
 * (nested quantifiers such as `(a+)+`, `(a*)*`, `(.+)*`, or adjacent overlapping
 * quantified groups). Node has no built-in regex timeout, so a matching pattern
 * is refused rather than executed — this bounds a ReDoS that would otherwise hang
 * the single-threaded event loop for the whole gateway.
 */
export function isLikelyCatastrophicRegex(src: string): boolean {
  // A quantified group immediately followed by another quantifier: (…)+ * etc.
  if (/\([^()]*[+*][^()]*\)\s*[+*{]/.test(src)) return true;
  // Two adjacent unbounded quantifiers, e.g. ".*.*" or "a+a+" style overlap.
  if (/[+*]\s*[.\w\]\)]\s*[+*]/.test(src) && src.length > 12) return true;
  return false;
}

/**
 * Test `value` against a regex source safely: refuse patterns that look prone to
 * catastrophic backtracking and cap the input length. Returns false (no match)
 * on a refused/invalid pattern rather than risking an event-loop hang.
 */
function safeRegexTest(source: string, flags: string, value: string): boolean {
  if (isLikelyCatastrophicRegex(source)) {
    console.warn(`[policy] refused potentially catastrophic regex: ${source.slice(0, 80)}`);
    return false;
  }
  const input = value.length > MAX_REGEX_INPUT ? value.slice(0, MAX_REGEX_INPUT) : value;
  try {
    return new RegExp(source, flags).test(input);
  } catch {
    return false;
  }
}

/**
 * Match a string value against a policy field pattern.
 * /regex/ syntax → case-insensitive RegExp test.
 * Otherwise → exact equality.
 */
/**
 * Normalize an identifier before an exact-match comparison so that a block/deny
 * rule cannot be evaded with a different case, surrounding whitespace, or Unicode
 * confusables/zero-width characters (e.g. `"Delete_Record"`, `"delete_record "`).
 * NFKC folds compatibility variants; trim + lowercase mirror the case-insensitive
 * `'i'` flag already used on the regex branch.
 */
function normalizeForMatch(s: string): string {
  return s.normalize('NFKC').trim().toLowerCase();
}

/**
 * Match a field against a pattern.
 * `/regex/` syntax → case-insensitive RegExp test.
 * Otherwise → exact equality. When `normalize` is true (identifier fields:
 * tool/method/agentId), the exact comparison is case/whitespace/Unicode
 * normalized to prevent block-rule evasion. Arbitrary param values
 * (`paramsMatch`) keep strict case-sensitive equality.
 */
/**
 * `/body/` and `/body/flags` are regular expressions; anything else is a literal.
 *
 * Requiring the pattern to end in a slash meant `/delete|drop/i` — the form used
 * in the README, in docs/policy-guide.md and in every built-in preset — was
 * compared as a literal string and never matched, leaving those presets inert.
 *
 * Omitting flags keeps the historical case-insensitive behaviour, so existing
 * `/body/` patterns are unaffected.
 */
const REGEX_PATTERN = /^\/(.+)\/([a-z]*)$/;

function matchesField(value: string, pattern: string, normalize = false): boolean {
  const asRegex = REGEX_PATTERN.exec(pattern);
  if (asRegex) {
    const [, source, flags] = asRegex;
    return safeRegexTest(source!, flags || 'i', value);
  }
  return normalize ? normalizeForMatch(value) === normalizeForMatch(pattern) : value === pattern;
}

function extractPath(params: Record<string, unknown>): string {
  return String(params['path'] ?? params['filePath'] ?? params['file'] ?? '');
}

/**
 * Returns true if the operation satisfies all criteria in the rule's `match` block.
 */
export function matchRule(rule: PolicyRule, operation: MCPOperation): boolean {
  const { match } = rule;
  if (match.tool !== undefined && !matchesField(operation.tool, match.tool, true)) return false;
  if (match.method !== undefined && !matchesField(operation.method, match.method, true)) return false;
  if (match.agentId !== undefined && !matchesField(operation.agentId, match.agentId, true)) return false;
  if (match.pathPattern !== undefined) {
    if (!safeRegexTest(match.pathPattern, 'i', extractPath(operation.params))) return false;
  }
  if (match.tags && match.tags.length > 0) {
    const opTags = operation.tags ?? [];
    if (!match.tags.every(t => opTags.includes(t))) return false;
  }
  if (match.paramsMatch) {
    for (const [key, pattern] of Object.entries(match.paramsMatch)) {
      const value = String(operation.params[key] ?? '');
      if (!matchesField(value, pattern)) return false;
    }
  }
  return true;
}

/**
 * Walk policy rules in order. Return the score from the first rule that:
 *  - matches the operation, AND
 *  - has a `score` field set.
 *
 * Returns null if no such rule is found.
 */
export function evaluatePolicyScore(
  policy: AgentsGatePolicy,
  operation: MCPOperation
): number | null {
  for (const rule of sortedRules(policy.rules)) {
    if (rule.score !== undefined && matchRule(rule, operation)) {
      const raw = Math.min(1, Math.max(0, rule.score));
      return rule.max !== undefined ? Math.min(raw, Math.max(0, rule.max)) : raw;
    }
  }
  return null;
}

/**
 * Walk policy rules in order. Return the forced action from the first rule that:
 *  - matches the operation, AND
 *  - has an `action` field set.
 *
 * Agent denylist / allowlist is checked before rules:
 *   1. If agentId matches any denylist pattern → 'block'
 *   2. If allowlist is non-empty and agentId matches none → 'block'
 *
 * Returns null if no rule/agent check fires (normal threshold logic applies).
 */
export function evaluatePolicyAction(
  policy: AgentsGatePolicy,
  operation: MCPOperation
): 'allow' | 'block' | 'require_approval' | null {
  const { agents } = policy;
  if (agents) {
    const agentId = operation.agentId;

    // Denylist — block immediately
    if (agents.denylist?.some(p => matchesField(agentId, p))) {
      return 'block';
    }

    // Allowlist — block if not on the list (when list is non-empty)
    if (agents.allowlist && agents.allowlist.length > 0) {
      if (!agents.allowlist.some(p => matchesField(agentId, p))) {
        return 'block';
      }
    }

    // Per-agent tool rules — check all toolRule entries whose key matches agentId
    if (agents.toolRules) {
      const tool = operation.tool;
      for (const [agentPattern, toolRule] of Object.entries(agents.toolRules)) {
        if (!matchesField(agentId, agentPattern)) continue;
        // Tool denylist: block if tool matches
        if (toolRule.denylist?.some(p => matchesField(tool, p))) return 'block';
        // Tool allowlist: block if non-empty and tool not in list
        if (toolRule.allowlist && toolRule.allowlist.length > 0) {
          if (!toolRule.allowlist.some(p => matchesField(tool, p))) return 'block';
        }
      }
    }
  }

  for (const rule of sortedRules(policy.rules)) {
    if (rule.action !== undefined && matchRule(rule, operation)) {
      return rule.action as 'allow' | 'block' | 'require_approval';
    }
  }
  return null;
}

/**
 * Like evaluatePolicyAction, but also returns the PolicyRule that fired so
 * callers can surface it in firedRules for dashboard transparency.
 */
export function evaluatePolicyActionWithRule(
  policy: AgentsGatePolicy,
  operation: MCPOperation
): { action: 'allow' | 'block' | 'require_approval'; rule: PolicyRule } | null {
  const { agents } = policy;
  if (agents) {
    const agentId = operation.agentId;
    if (agents.denylist?.some(p => matchesField(agentId, p))) {
      return { action: 'block', rule: { id: 'AGENT_DENYLIST', match: {}, description: 'Agent is on the denylist' } };
    }
    if (agents.allowlist && agents.allowlist.length > 0) {
      if (!agents.allowlist.some(p => matchesField(agentId, p))) {
        return { action: 'block', rule: { id: 'AGENT_NOT_ALLOWLISTED', match: {}, description: 'Agent is not on the allowlist' } };
      }
    }
    if (agents.toolRules) {
      const tool = operation.tool;
      for (const [agentPattern, toolRule] of Object.entries(agents.toolRules)) {
        if (!matchesField(agentId, agentPattern)) continue;
        if (toolRule.denylist?.some(p => matchesField(tool, p)))
          return { action: 'block', rule: { id: 'AGENT_TOOL_DENYLIST', match: {}, description: `Tool denied for agent pattern "${agentPattern}"` } };
        if (toolRule.allowlist && toolRule.allowlist.length > 0) {
          if (!toolRule.allowlist.some(p => matchesField(tool, p)))
            return { action: 'block', rule: { id: 'AGENT_TOOL_NOT_ALLOWLISTED', match: {}, description: `Tool not allowlisted for agent pattern "${agentPattern}"` } };
        }
      }
    }
  }
  for (const rule of sortedRules(policy.rules)) {
    if (rule.action !== undefined && matchRule(rule, operation)) {
      return { action: rule.action as 'allow' | 'block' | 'require_approval', rule };
    }
  }
  return null;
}

/**
 * Return the list of parameter keys that should be redacted for the given operation
 * based on any matching policy rule's `redact` field.
 * Returns an empty array if no matching rule has a `redact` list.
 */
export function getPolicyRedactKeys(
  policy: AgentsGatePolicy,
  operation: MCPOperation
): string[] {
  for (const rule of sortedRules(policy.rules)) {
    if (rule.redact && rule.redact.length > 0 && matchRule(rule, operation)) {
      return rule.redact;
    }
  }
  return [];
}

// ── Persistence ───────────────────────────────────────────────────────────────

/**
 * Load policy from disk.
 * Returns `{ rules: [] }` (no-op policy) when the file does not exist.
 *
 * @param policyPath — explicit path; falls back to ~/.agentsgate/policy.json
 */
function defaultPolicyPath(policyPath?: string): string {
  return policyPath ?? path.join(os.homedir(), '.agentsgate', 'policy.json');
}

/**
 * Read and parse a policy file, throwing on anything that goes wrong.
 *
 * Callers that must distinguish "there is no policy" from "the policy is
 * broken" use this; `loadPolicy` wraps it with the forgiving behaviour.
 */
async function readPolicyFile(filePath: string): Promise<AgentsGatePolicy> {
  const raw = await fs.readFile(filePath, 'utf-8');
  const parsed = JSON.parse(raw) as Partial<AgentsGatePolicy>;
  // Every field the file declares, not a hand-picked three. Listing them by
  // name silently dropped `mutedRules` and `ruleOverrides`, so muting a noisy
  // L1 rule or re-scoring one did nothing — the proxy reads both off the
  // active policy, but nothing could put them there.
  return { ...parsed, rules: parsed.rules ?? [] };
}

export async function loadPolicy(policyPath?: string): Promise<AgentsGatePolicy> {
  const filePath = defaultPolicyPath(policyPath);
  try {
    return await readPolicyFile(filePath);
  } catch (err) {
    // No file is a legitimate state — it means "no policy". A file that exists
    // but does not parse is a mistake, and returning an empty policy for it
    // without a word looks identical to having no rules at all.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[policy] could not read ${filePath}: ${(err as Error).message}`);
      console.warn('[policy] continuing with no custom rules — built-in L1 rules still apply.');
    }
    return { rules: [] };
  }
}

/**
 * Merge multiple policies into one. Rules from later policies are appended
 * (they run after earlier-policy rules in priority order). Thresholds and
 * agent rules from the LAST policy that defines them win.
 *
 * @param policies — ordered list of policies; earlier = higher precedence for thresholds.
 */
export function mergePolicies(policies: AgentsGatePolicy[]): AgentsGatePolicy {
  if (policies.length === 0) return { rules: [] };
  const merged: AgentsGatePolicy = { rules: [] };
  for (const p of policies) {
    merged.rules.push(...p.rules);
    if (p.thresholds !== undefined) merged.thresholds = { ...merged.thresholds, ...p.thresholds };
    if (p.agents !== undefined) {
      merged.agents = {
        allowlist: p.agents.allowlist ?? merged.agents?.allowlist,
        denylist: [...(merged.agents?.denylist ?? []), ...(p.agents.denylist ?? [])],
        toolRules: { ...merged.agents?.toolRules, ...p.agents.toolRules },
      };
    }
    if (p.mutedRules && p.mutedRules.length > 0) {
      merged.mutedRules = [...(merged.mutedRules ?? []), ...p.mutedRules];
    }
    if (p.ruleOverrides && Object.keys(p.ruleOverrides).length > 0) {
      merged.ruleOverrides = { ...merged.ruleOverrides, ...p.ruleOverrides };
    }
  }
  return merged;
}

/**
 * Load and merge multiple policy files in order.
 * Paths are sorted alphabetically so naming conventions (e.g. 01-base.json, 02-team.json)
 * give predictable ordering. Non-existent files are silently skipped.
 *
 * @param policyPaths — array of file paths; if empty, falls back to the single default file.
 */
export async function loadPolicies(policyPaths: string[]): Promise<AgentsGatePolicy> {
  if (policyPaths.length === 0) return loadPolicy();
  if (policyPaths.length === 1) return loadPolicy(policyPaths[0]);
  const sorted = [...policyPaths].sort();
  const loaded = await Promise.all(sorted.map(p => loadPolicy(p)));
  return mergePolicies(loaded);
}

/**
 * Write a policy file to disk (creates directory if needed).
 */
export async function savePolicy(
  policy: AgentsGatePolicy,
  policyPath?: string
): Promise<void> {
  const filePath = policyPath ?? path.join(os.homedir(), '.agentsgate', 'policy.json');
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(policy, null, 2));
}

/**
 * Watch a policy file for changes and call `onReload` with the updated policy
 * whenever the file is written. Returns a watcher handle; call `.close()` to stop.
 *
 * Uses a 200ms debounce to avoid double-firing on editors that write twice.
 */
export function watchPolicy(
  policyPath: string,
  onReload: (policy: AgentsGatePolicy) => void
): FSWatcher {
  let debounce: ReturnType<typeof setTimeout> | null = null;

  const watcher = watch(policyPath, () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      // readPolicyFile, not loadPolicy: a half-typed edit must leave the
      // running policy alone. loadPolicy answers "no rules" for a broken file,
      // which here would disarm every rule the moment the file was saved
      // mid-keystroke — silently, and for as long as the typo survived.
      readPolicyFile(policyPath)
        .then(p => onReload(p))
        .catch((err: unknown) => {
          console.warn(`[policy] ${policyPath} did not parse — keeping the previous policy.`);
          console.warn(`[policy] ${(err as Error).message}`);
        });
    }, 200);
  });

  return watcher;
}
