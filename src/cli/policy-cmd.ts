import fs from 'node:fs/promises';
import { loadPolicy, savePolicy } from '../policy.js';
import type { PolicyRule } from '../policy.js';
import { parseFlag, hasFlag, readState, dashFetch } from './shared.js';

export async function cmdPolicy(subArgs: string[]): Promise<void> {
  const policyPath = parseFlag(subArgs, 'policy');
  const subCmd = subArgs.find(a => !a.startsWith('--'));

  // ── policy list ────────────────────────────────────────────────────────────
  if (!subCmd || subCmd === 'list') {
    const policy = await loadPolicy(policyPath);
    if (policy.rules.length === 0 && !policy.thresholds) {
      console.log('No policy file found — default built-in rules apply.');
      console.log('Create one with: agentsgate policy add --id=MY_RULE --action=block --tool=database');
      return;
    }
    const DEFAULT_PRIORITY = 100;
    const sortedRules = [...policy.rules].sort(
      (a, b) => (a.priority ?? DEFAULT_PRIORITY) - (b.priority ?? DEFAULT_PRIORITY)
    );
    console.log(`Policy (${policy.rules.length} rule(s)):\n`);
    if (policy.thresholds) {
      console.log(`  Thresholds: allowBelow=${policy.thresholds.allowBelow ?? '(default)'} blockAtOrAbove=${policy.thresholds.blockAtOrAbove ?? '(default)'}`);
      console.log('');
    }
    for (const rule of sortedRules) {
      const priorityDisplay = rule.priority !== undefined ? String(rule.priority) : `${DEFAULT_PRIORITY} (default)`;
      console.log(`  [${rule.id}]`);
      if (rule.description) console.log(`    Description: ${rule.description}`);
      console.log(`    priority:    ${priorityDisplay}`);
      const m = rule.match;
      if (m.tool)        console.log(`    tool:        ${m.tool}`);
      if (m.method)      console.log(`    method:      ${m.method}`);
      if (m.agentId)     console.log(`    agentId:     ${m.agentId}`);
      if (m.pathPattern) console.log(`    pathPattern: ${m.pathPattern}`);
      if (m.tags && m.tags.length > 0) console.log(`    tags:        ${m.tags.join(', ')}`);
      if (rule.score !== undefined) console.log(`    score:       ${rule.score}`);
      if (rule.action)   console.log(`    action:      ${rule.action}`);
      console.log('');
    }
    return;
  }

  // ── policy add ─────────────────────────────────────────────────────────────
  if (subCmd === 'add') {
    const id = parseFlag(subArgs, 'id');
    if (!id) { console.error('Usage: agentsgate policy add --id=RULE_ID [options]'); process.exit(1); }

    const policy = await loadPolicy(policyPath);
    if (policy.rules.some(r => r.id === id)) {
      console.error(`Rule "${id}" already exists. Use policy remove first.`);
      process.exit(1);
    }

    const rule: PolicyRule = { id, match: {} };
    const tool        = parseFlag(subArgs, 'tool');
    const method      = parseFlag(subArgs, 'method');
    const agentId     = parseFlag(subArgs, 'agentId');
    const pathPattern = parseFlag(subArgs, 'pathPattern');
    const scoreStr    = parseFlag(subArgs, 'score');
    const priorityStr = parseFlag(subArgs, 'priority');
    const action      = parseFlag(subArgs, 'action') as PolicyRule['action'] | undefined;
    const description = parseFlag(subArgs, 'description');

    if (tool)        rule.match.tool = tool;
    if (method)      rule.match.method = method;
    if (agentId)     rule.match.agentId = agentId;
    if (pathPattern) rule.match.pathPattern = pathPattern;
    if (scoreStr)    rule.score = parseFloat(scoreStr);
    // `policy list` sorts on priority and the rule schema documents it, but
    // until now it could only be set by hand-editing the policy file.
    if (priorityStr !== undefined) {
      const priority = Number(priorityStr);
      if (!Number.isFinite(priority)) {
        console.error(`Invalid --priority "${priorityStr}": expected a number.`);
        process.exit(1);
      }
      rule.priority = priority;
    }
    if (action && ['allow','block','require_approval'].includes(action)) rule.action = action;
    if (description) rule.description = description;

    policy.rules.push(rule);
    await savePolicy(policy, policyPath);
    console.log(`Rule "${id}" added.`);
    return;
  }

  // ── policy remove ──────────────────────────────────────────────────────────
  if (subCmd === 'remove') {
    const id = subArgs.find(a => !a.startsWith('--') && a !== 'remove');
    if (!id) { console.error('Usage: agentsgate policy remove <rule-id>'); process.exit(1); }

    const policy = await loadPolicy(policyPath);
    const before = policy.rules.length;
    policy.rules = policy.rules.filter(r => r.id !== id);
    if (policy.rules.length === before) {
      console.error(`Rule "${id}" not found.`);
      process.exit(1);
    }
    await savePolicy(policy, policyPath);
    console.log(`Rule "${id}" removed.`);
    return;
  }

  // ── policy set-threshold ───────────────────────────────────────────────────
  if (subCmd === 'set-threshold') {
    const allowBelowStr     = parseFlag(subArgs, 'allowBelow');
    const blockAtOrAboveStr = parseFlag(subArgs, 'blockAtOrAbove');
    if (!allowBelowStr && !blockAtOrAboveStr) {
      console.error('Usage: agentsgate policy set-threshold [--allowBelow=X] [--blockAtOrAbove=Y]');
      process.exit(1);
    }
    const policy = await loadPolicy(policyPath);
    policy.thresholds = policy.thresholds ?? {};
    if (allowBelowStr)     policy.thresholds.allowBelow = parseFloat(allowBelowStr);
    if (blockAtOrAboveStr) policy.thresholds.blockAtOrAbove = parseFloat(blockAtOrAboveStr);
    await savePolicy(policy, policyPath);
    console.log(`Thresholds updated: allowBelow=${policy.thresholds.allowBelow ?? '(default)'} blockAtOrAbove=${policy.thresholds.blockAtOrAbove ?? '(default)'}`);
    return;
  }

  // ── policy agent ───────────────────────────────────────────────────────────
  if (subCmd === 'agent') {
    const agentAction = subArgs.find(a => !a.startsWith('--') && a !== 'agent');

    if (!agentAction || agentAction === 'list') {
      const policy = await loadPolicy(policyPath);
      const al = policy.agents?.allowlist ?? [];
      const dl = policy.agents?.denylist ?? [];
      console.log(`Agent allowlist (${al.length}): ${al.length ? al.join(', ') : '(empty — all agents allowed)'}`);
      console.log(`Agent denylist  (${dl.length}): ${dl.length ? dl.join(', ') : '(empty)'}`);
      return;
    }

    if (agentAction === 'allow' || agentAction === 'deny') {
      const pattern = subArgs.find(a => !a.startsWith('--') && a !== 'agent' && a !== agentAction);
      if (!pattern) { console.error(`Usage: agentsgate policy agent ${agentAction} <pattern>`); process.exit(1); }
      const policy = await loadPolicy(policyPath);
      policy.agents = policy.agents ?? {};
      const list = agentAction === 'allow' ? 'allowlist' : 'denylist';
      policy.agents[list] = policy.agents[list] ?? [];
      if (!policy.agents[list]!.includes(pattern)) {
        policy.agents[list]!.push(pattern);
        await savePolicy(policy, policyPath);
        console.log(`Added "${pattern}" to agent ${list}.`);
      } else {
        console.log(`"${pattern}" is already in the agent ${list}.`);
      }
      return;
    }

    if (agentAction === 'remove') {
      const pattern = subArgs.find(a => !a.startsWith('--') && a !== 'agent' && a !== 'remove');
      if (!pattern) { console.error('Usage: agentsgate policy agent remove <pattern>'); process.exit(1); }
      const policy = await loadPolicy(policyPath);
      if (!policy.agents) { console.log('No agent lists configured.'); return; }
      const before = (policy.agents.allowlist?.length ?? 0) + (policy.agents.denylist?.length ?? 0);
      policy.agents.allowlist = (policy.agents.allowlist ?? []).filter(p => p !== pattern);
      policy.agents.denylist  = (policy.agents.denylist  ?? []).filter(p => p !== pattern);
      const after = (policy.agents.allowlist.length) + (policy.agents.denylist.length);
      if (before === after) { console.error(`Pattern "${pattern}" not found in any agent list.`); process.exit(1); }
      await savePolicy(policy, policyPath);
      console.log(`Removed "${pattern}" from agent lists.`);
      return;
    }

    // ── policy agent tool-allow / tool-deny / tool-remove ──────────────────
    if (agentAction === 'tool-allow' || agentAction === 'tool-deny' || agentAction === 'tool-remove') {
      const remaining = subArgs.filter(a => !a.startsWith('--') && a !== 'agent' && a !== agentAction);
      const agentPat = remaining[0];
      const toolPat  = remaining[1];
      if (!agentPat || !toolPat) {
        console.error(`Usage: agentsgate policy agent ${agentAction} <agentPattern> <toolPattern>`);
        process.exit(1);
      }
      const policy = await loadPolicy(policyPath);
      policy.agents = policy.agents ?? {};
      policy.agents.toolRules = policy.agents.toolRules ?? {};

      if (agentAction === 'tool-remove') {
        const rules = policy.agents.toolRules[agentPat];
        if (!rules) { console.error(`No tool rules for agent pattern "${agentPat}".`); process.exit(1); }
        rules.allowlist = (rules.allowlist ?? []).filter(p => p !== toolPat);
        rules.denylist  = (rules.denylist  ?? []).filter(p => p !== toolPat);
        console.log(`Removed tool pattern "${toolPat}" for agent "${agentPat}".`);
      } else {
        const list = agentAction === 'tool-allow' ? 'allowlist' : 'denylist';
        policy.agents.toolRules[agentPat] = policy.agents.toolRules[agentPat] ?? {};
        const arr = policy.agents.toolRules[agentPat][list] ?? [];
        if (!arr.includes(toolPat)) arr.push(toolPat);
        policy.agents.toolRules[agentPat][list] = arr;
        console.log(`Added tool "${toolPat}" to ${list} for agent "${agentPat}".`);
      }

      await savePolicy(policy, policyPath);
      return;
    }

    console.error(`Unknown agent action: ${agentAction}`);
    process.exit(1);
  }

  // ── policy preset ──────────────────────────────────────────────────────────
  if (subCmd === 'preset') {
    const { PRESET_NAMES, getPreset } = await import('../utils/policy-presets.js');
    const presetAction = subArgs.find(a => !a.startsWith('--') && a !== 'preset');

    if (!presetAction || presetAction === 'list') {
      console.log('Available policy presets:\n');
      for (const name of PRESET_NAMES) {
        const p = getPreset(name)!;
        console.log(`  ${name.padEnd(12)} ${p.rules.length} rule(s)  thresholds: allowBelow=${p.thresholds?.allowBelow ?? '?'} blockAtOrAbove=${p.thresholds?.blockAtOrAbove ?? '?'}`);
        for (const r of p.rules) console.log(`               - [${r.id}] ${r.description ?? ''}`);
        console.log('');
      }
      return;
    }

    if (presetAction === 'apply') {
      const presetName = subArgs.find(a => !a.startsWith('--') && a !== 'preset' && a !== 'apply');
      if (!presetName) { console.error('Usage: agentsgate policy preset apply <name>'); process.exit(1); }
      const preset = getPreset(presetName);
      if (!preset) {
        console.error(`Unknown preset "${presetName}". Available: ${PRESET_NAMES.join(', ')}`);
        process.exit(1);
      }
      const force = subArgs.includes('--force');
      const existing = await loadPolicy(policyPath);
      if (existing.rules.length > 0 && !force) {
        console.error(`Policy already has ${existing.rules.length} rule(s). Use --force to overwrite.`);
        process.exit(1);
      }
      await savePolicy(preset, policyPath);
      console.log(`Preset "${presetName}" applied (${preset.rules.length} rules).`);
      return;
    }

    console.error(`Unknown preset action: ${presetAction}`);
    process.exit(1);
  }

  // ── policy export ──────────────────────────────────────────────────────────
  if (subCmd === 'export') {
    const outFile = subArgs.find(a => !a.startsWith('--') && a !== 'export');
    const policy = await loadPolicy(policyPath);
    const json = JSON.stringify(policy, null, 2);
    if (outFile) {
      await fs.writeFile(outFile, json, 'utf-8');
      console.log(`Policy exported to ${outFile}`);
    } else {
      console.log(json);
    }
    return;
  }

  // ── policy import ──────────────────────────────────────────────────────────
  if (subCmd === 'import') {
    const inFile = subArgs.find(a => !a.startsWith('--') && a !== 'import');
    if (!inFile) { console.error('Usage: agentsgate policy import <file>'); process.exit(1); }
    const raw = await fs.readFile(inFile, 'utf-8');
    let imported: import('../policy.js').AgentsGatePolicy;
    try {
      imported = JSON.parse(raw) as import('../policy.js').AgentsGatePolicy;
    } catch {
      console.error(`Invalid JSON in ${inFile}`); process.exit(1);
    }
    if (!Array.isArray(imported.rules)) { console.error('Policy file must have a "rules" array.'); process.exit(1); }
    const force = hasFlag(subArgs, 'force');
    const existing = await loadPolicy(policyPath);
    if (existing.rules.length > 0 && !force) {
      console.error(`Existing policy has ${existing.rules.length} rule(s). Use --force to overwrite.`);
      process.exit(1);
    }
    await savePolicy(imported, policyPath);
    console.log(`Imported ${imported.rules.length} rule(s) from ${inFile}.`);
    return;
  }

  // ── policy test ────────────────────────────────────────────────────────────
  // agentsgate policy test --tool=X --method=Y --agentId=Z [--path=P] [--tags=a,b]
  if (subCmd === 'test') {
    const tool        = parseFlag(subArgs, 'tool') ?? 'filesystem';
    const method      = parseFlag(subArgs, 'method') ?? 'read_file';
    const agentIdArg  = parseFlag(subArgs, 'agentId') ?? 'test-agent';
    const filePath    = parseFlag(subArgs, 'path') ?? '';
    const tagsArg     = parseFlag(subArgs, 'tags');
    const tags        = tagsArg ? tagsArg.split(',').map(t => t.trim()).filter(Boolean) : undefined;

    const policy = await loadPolicy(policyPath);
    const { evaluatePolicyAction, evaluatePolicyScore } = await import('../policy.js');

    const op = {
      id: 'dry-run',
      agentId: agentIdArg,
      tool,
      method,
      params: filePath ? { path: filePath } : {},
      timestamp: new Date(),
      sessionId: 'dry-run',
      tags,
    };

    const action = evaluatePolicyAction(policy, op);
    const score  = evaluatePolicyScore(policy, op);

    console.log(`Policy test for simulated operation:\n`);
    console.log(`  Tool:    ${tool}`);
    console.log(`  Method:  ${method}`);
    console.log(`  Agent:   ${agentIdArg}`);
    if (filePath) console.log(`  Path:    ${filePath}`);
    if (tags?.length) console.log(`  Tags:    ${tags.join(', ')}`);
    console.log('');
    if (action) {
      console.log(`  Forced action: ${action.toUpperCase()}`);
    } else {
      console.log(`  Forced action: (none — threshold logic applies)`);
    }
    if (score !== null) {
      console.log(`  Score override: ${score}`);
    } else {
      console.log(`  Score override: (none — built-in L1 rules apply)`);
    }
    return;
  }

  // ── policy stats ───────────────────────────────────────────────────────────
  if (subCmd === 'stats') {
    const state = await readState();
    if (!state) { console.error('AgentsGate is not running.'); process.exit(1); }
    const { status, body } = await dashFetch(state.dashboardPort, 'GET', '/policy/stats');
    if (status !== 200) { console.error(`Dashboard returned ${status}`); process.exit(1); }
    const b = body as { rules: Array<{ ruleId: string; hits: number }>; totalRules: number };
    if (b.totalRules === 0) { console.log('No rule hits recorded yet.'); return; }
    console.log(`Policy Rule Hit Counts (${b.totalRules} rules fired):\n`);
    console.log('  RULE'.padEnd(36) + 'HITS');
    console.log('  ' + '─'.repeat(40));
    for (const r of b.rules) {
      console.log(`  ${r.ruleId.padEnd(34)} ${r.hits}`);
    }
    return;
  }

  // ── policy evaluate (T259) ──────────────────────────────────────────────────
  if (subCmd === 'evaluate') {
    const state = await readState();
    if (!state) { console.error('AgentsGate is not running.'); process.exit(1); }
    const tool     = parseFlag(subArgs, 'tool') ?? '';
    const method   = parseFlag(subArgs, 'method') ?? '';
    const agentId  = parseFlag(subArgs, 'agentId') ?? 'cli-eval';
    const pathArg  = parseFlag(subArgs, 'path');
    const params: Record<string, unknown> = {};
    if (pathArg) params['path'] = pathArg;
    const { status, body } = await dashFetch(state.dashboardPort, 'POST', '/policy/evaluate', {
      tool, method, agentId, params, sessionId: 'cli-eval',
    });
    if (status === 503) { console.error('No policy loaded on running server.'); process.exit(1); }
    const r = body as { score: number | null; action: string | null; redactKeys: string[]; matched: boolean };
    console.log('\nPolicy Evaluation Result:');
    console.log(`  tool:       ${tool}.${method}`);
    console.log(`  agentId:    ${agentId}`);
    console.log(`  score:      ${r.score !== null ? r.score.toFixed(3) : '(no override)'}`);
    console.log(`  action:     ${r.action ?? '(threshold-based)'}`);
    console.log(`  redactKeys: ${r.redactKeys.length > 0 ? r.redactKeys.join(', ') : '(none)'}`);
    console.log(`  matched:    ${r.matched}`);
    return;
  }

  // ── policy rules [id] (T289) ────────────────────────────────────────────────
  if (subCmd === 'rules') {
    const state = await readState();
    if (!state) { console.error('AgentsGate is not running.'); process.exit(1); }
    const ruleId = subArgs.find(a => !a.startsWith('--') && a !== 'rules');
    if (ruleId) {
      const { status, body } = await dashFetch(state.dashboardPort, 'GET', `/policy/rules/${encodeURIComponent(ruleId)}`);
      if (status === 404) { console.error(`Rule not found: ${ruleId}`); process.exit(1); }
      if (status !== 200) { console.error(`Dashboard returned ${status}`); process.exit(1); }
      console.log(JSON.stringify(body, null, 2));
      return;
    }
    const { status, body } = await dashFetch(state.dashboardPort, 'GET', '/policy/rules');
    if (status !== 200) { console.error(`Dashboard returned ${status}`); process.exit(1); }
    const b = body as { rules: Array<{ id: string; score?: number; action?: string }>, count: number };
    if (b.count === 0) { console.log('No policy rules loaded.'); return; }
    console.log(`Policy Rules (${b.count}):\n`);
    for (const r of b.rules) {
      const parts = [`[${r.id}]`];
      if (r.score !== undefined) parts.push(`score=${r.score}`);
      if (r.action) parts.push(`action=${r.action}`);
      console.log(`  ${parts.join('  ')}`);
    }
    return;
  }

  console.error(`Unknown policy subcommand: ${subCmd}`);
  console.error('Available: list, add, remove, set-threshold, preset, agent, export, import, test, stats, evaluate, rules');
  process.exit(1);
}
