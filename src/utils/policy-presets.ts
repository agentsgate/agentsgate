/**
 * T133 — Built-in policy preset library.
 *
 * Presets are named AgentsGatePolicy objects that can be applied to the
 * policy file via `agentsgate policy preset apply <name>`.
 *
 * Available presets:
 *   strict      — very conservative; most operations require approval
 *   permissive  — relaxed; only clearly destructive operations are blocked
 *   readonly    — blocks all write/delete/create operations absolutely
 */

import type { AgentsGatePolicy } from '../policy.js';

const STRICT_PRESET: AgentsGatePolicy = {
  thresholds: { allowBelow: 0.1, blockAtOrAbove: 0.5 },
  rules: [
    {
      id: 'STRICT_BLOCK_DELETE',
      description: 'Block any delete / drop / truncate operations',
      match: { method: '/delete|drop|truncate|remove|unlink|rm/i' },
      action: 'block',
    },
    {
      id: 'STRICT_APPROVE_WRITE',
      description: 'Require approval for all write / create / update operations',
      match: { method: '/write|create|insert|update|put|patch|push/i' },
      action: 'require_approval',
    },
    {
      id: 'STRICT_APPROVE_EXEC',
      description: 'Require approval for shell / exec operations',
      match: { tool: '/shell|exec|bash|cmd|terminal/i' },
      action: 'require_approval',
    },
  ],
};

const PERMISSIVE_PRESET: AgentsGatePolicy = {
  thresholds: { allowBelow: 0.6, blockAtOrAbove: 0.9 },
  rules: [
    {
      id: 'PERMISSIVE_BLOCK_DESTRUCTIVE',
      description: 'Block only clearly destructive irreversible operations',
      match: { method: '/drop|truncate|format|wipe|nuke/i' },
      action: 'block',
    },
    {
      id: 'PERMISSIVE_APPROVE_PROD_DELETE',
      description: 'Require approval for production database deletes',
      match: { tool: '/database|sql/i', method: '/delete/i' },
      action: 'require_approval',
    },
  ],
};

const READONLY_PRESET: AgentsGatePolicy = {
  thresholds: { allowBelow: 0.05, blockAtOrAbove: 0.1 },
  rules: [
    {
      id: 'READONLY_BLOCK_WRITES',
      description: 'Block all operations that could modify state',
      match: { method: '/write|create|insert|update|put|patch|push|delete|drop|truncate|remove|unlink|exec|run/i' },
      action: 'block',
    },
    {
      id: 'READONLY_BLOCK_SHELL',
      description: 'Block all shell / exec tool calls',
      match: { tool: '/shell|exec|bash|cmd|terminal/i' },
      action: 'block',
    },
  ],
};

export const PRESETS: Record<string, AgentsGatePolicy> = {
  strict:     STRICT_PRESET,
  permissive: PERMISSIVE_PRESET,
  readonly:   READONLY_PRESET,
};

export const PRESET_NAMES = Object.keys(PRESETS) as Array<keyof typeof PRESETS>;

/**
 * Return a preset by name (case-insensitive), or undefined if not found.
 */
export function getPreset(name: string): AgentsGatePolicy | undefined {
  return PRESETS[name.toLowerCase()];
}
