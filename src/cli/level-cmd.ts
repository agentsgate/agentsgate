/**
 * `agentsgate level` — show or change how much gets stopped.
 *
 * A control nobody can find is a control nobody uses, so this is one word and
 * prints the whole table rather than making anyone read the docs to learn what
 * changed.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../config.js';
import {
  getProtectionLevel, PROTECTION_LEVEL_NAMES, DEFAULT_PROTECTION_LEVEL,
} from '../protection-levels.js';
import type { CategoryAction, RuleCategory } from '../protection-levels.js';
import { parseFlag } from './shared.js';

const ROWS: Array<[RuleCategory, string]> = [
  ['destructive', 'Wipe a table, delete every row, force-push'],
  ['injection', 'Multi-statement SQL — the shape of an attack'],
  ['credential', 'Keys and secrets — .env, .pem, .ssh'],
  ['exfiltration', 'Read personal data — users, tokens, billing'],
  ['outbound_delete', 'Delete something outside — mail, messages, events'],
  ['outbound_write', 'Send something outside — mail, messages, events'],
  ['write_delete', 'Delete a file or a record'],
  ['write_update', 'Change a file or a record'],
  ['write_create', 'Add a file or a record'],
  ['exec', 'Run a shell command'],
  ['read', 'Read anything'],
];

const SHOWN: Record<CategoryAction, string> = {
  allow: 'runs',
  require_approval: 'asks you',
  block: 'refused',
};

export async function cmdLevel(args: string[]): Promise<void> {
  const configPath = parseFlag(args, 'config');
  const requested = args.find(a => !a.startsWith('--'));

  if (requested) {
    const level = getProtectionLevel(requested);
    if (!level) {
      console.error(`Unknown level "${requested}". Available: ${PROTECTION_LEVEL_NAMES.join(', ')}`);
      process.exit(1);
    }
    const file = configPath ?? path.join(os.homedir(), '.agentsgate', 'config.json');
    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(await fs.readFile(file, 'utf-8')) as Record<string, unknown>;
    } catch { /* no config yet — write a fresh one */ }
    existing['protection'] = { ...(existing['protection'] as object ?? {}), level: level.name };
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(existing, null, 2) + '\n');
    console.log(`Protection level set to "${level.name}".`);
    console.log(`  ${level.summary}`);
    console.log('\nRestart the proxy for it to take effect: agentsgate stop && agentsgate start\n');
  }

  const config = await loadConfig(configPath);
  const current = getProtectionLevel(config.protection?.level ?? DEFAULT_PROTECTION_LEVEL)!;

  console.log(`Protection level: ${current.name}`);
  console.log(`  ${current.summary}\n`);

  const width = Math.max(...ROWS.map(([c]) => c.length));
  console.log(`  ${'category'.padEnd(width)}  ${'now'.padEnd(9)}  what it covers`);
  console.log(`  ${'─'.repeat(width)}  ${'─'.repeat(9)}  ${'─'.repeat(46)}`);
  for (const [category, blurb] of ROWS) {
    const action = SHOWN[current.categories[category]];
    console.log(`  ${category.padEnd(width)}  ${action.padEnd(9)}  ${blurb}`);
  }

  const others = PROTECTION_LEVEL_NAMES.filter(n => n !== current.name);
  console.log(`\nOther levels: ${others.join(', ')}`);
  console.log(`  agentsgate level ${others[0]}`);
  console.log('\nPolicy rules are applied after the level and override it — see docs/policy-guide.md.');
}
