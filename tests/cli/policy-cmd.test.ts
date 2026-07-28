/**
 * src/cli/policy-cmd.ts — policy list / add / remove / set-threshold.
 *
 * These operate on a policy JSON file rather than the dashboard, so each test
 * points --policy at its own file and asserts on what was written back.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { redirectHome, capture } from './helpers.js';

redirectHome();

const { cmdPolicy } = await import('../../src/cli/policy-cmd.js');

let policyPath: string;

beforeEach(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ag-policy-'));
  policyPath = path.join(dir, 'policy.json');
});

async function readPolicy(): Promise<{ rules: Array<Record<string, unknown>>; thresholds?: Record<string, number> }> {
  return JSON.parse(await fs.readFile(policyPath, 'utf8')) as never;
}

const P = () => `--policy=${policyPath}`;

describe('policy list', () => {
  it('explains how to start when no policy file exists', async () => {
    const r = await capture(() => cmdPolicy([P()]));
    expect(r.exitCode).toBeUndefined();
    expect(r.stdout).toContain('No policy file found');
    expect(r.stdout).toContain('agentsgate policy add');
  });

  it('defaults to list when no subcommand is given', async () => {
    await capture(() => cmdPolicy(['add', '--id=R1', '--action=block', P()]));
    const r = await capture(() => cmdPolicy([P()]));
    expect(r.stdout).toContain('Policy (1 rule(s)):');
    expect(r.stdout).toContain('[R1]');
  });

  it('prints every match field that is set', async () => {
    await capture(() => cmdPolicy([
      'add', '--id=R_FULL', '--tool=database', '--method=execute_ddl',
      '--agentId=agent-x', '--pathPattern=^/etc/', '--score=0.9',
      '--action=block', '--description=No DDL', P(),
    ]));
    const r = await capture(() => cmdPolicy(['list', P()]));
    expect(r.stdout).toContain('Description: No DDL');
    expect(r.stdout).toContain('tool:        database');
    expect(r.stdout).toContain('method:      execute_ddl');
    expect(r.stdout).toContain('agentId:     agent-x');
    expect(r.stdout).toContain('pathPattern: ^/etc/');
    expect(r.stdout).toContain('score:       0.9');
    expect(r.stdout).toContain('action:      block');
  });

  it('orders rules by priority, lowest first', async () => {
    await capture(() => cmdPolicy(['add', '--id=LATE',  '--priority=200', '--action=allow', P()]));
    await capture(() => cmdPolicy(['add', '--id=EARLY', '--priority=10',  '--action=block', P()]));
    const r = await capture(() => cmdPolicy(['list', P()]));
    expect(r.stdout.indexOf('[EARLY]')).toBeLessThan(r.stdout.indexOf('[LATE]'));
  });

  it('marks the implicit priority as a default', async () => {
    await capture(() => cmdPolicy(['add', '--id=NOPRIO', '--action=allow', P()]));
    const r = await capture(() => cmdPolicy(['list', P()]));
    expect(r.stdout).toContain('100 (default)');
  });
});

describe('policy add', () => {
  it('requires an id', async () => {
    const r = await capture(() => cmdPolicy(['add', P()]));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('Usage: agentsgate policy add --id=RULE_ID');
  });

  it('persists the rule to the policy file', async () => {
    await capture(() => cmdPolicy(['add', '--id=R1', '--tool=database', '--action=block', P()]));
    const policy = await readPolicy();
    expect(policy.rules).toHaveLength(1);
    expect(policy.rules[0]).toMatchObject({ id: 'R1', action: 'block' });
  });

  it('appends rather than replacing', async () => {
    await capture(() => cmdPolicy(['add', '--id=R1', '--action=block', P()]));
    await capture(() => cmdPolicy(['add', '--id=R2', '--action=allow', P()]));
    const policy = await readPolicy();
    expect(policy.rules.map(r => r['id'])).toEqual(['R1', 'R2']);
  });

  it('stores a numeric score as a number', async () => {
    await capture(() => cmdPolicy(['add', '--id=R1', '--score=0.75', P()]));
    const policy = await readPolicy();
    expect(policy.rules[0]!['score']).toBe(0.75);
  });
});

describe('policy remove', () => {
  it('deletes the named rule', async () => {
    await capture(() => cmdPolicy(['add', '--id=R1', '--action=block', P()]));
    await capture(() => cmdPolicy(['add', '--id=R2', '--action=allow', P()]));

    const r = await capture(() => cmdPolicy(['remove', 'R1', P()]));
    expect(r.exitCode).toBeUndefined();

    const policy = await readPolicy();
    expect(policy.rules.map(x => x['id'])).toEqual(['R2']);
  });

  it('exits 1 for an unknown rule id', async () => {
    await capture(() => cmdPolicy(['add', '--id=R1', '--action=block', P()]));
    const r = await capture(() => cmdPolicy(['remove', 'NOPE', P()]));
    expect(r.exitCode).toBe(1);
  });
});

describe('policy set-threshold', () => {
  it('writes both thresholds', async () => {
    const r = await capture(() => cmdPolicy(['set-threshold', '--allowBelow=0.2', '--blockAtOrAbove=0.8', P()]));
    expect(r.exitCode).toBeUndefined();

    const policy = await readPolicy();
    expect(policy.thresholds).toMatchObject({ allowBelow: 0.2, blockAtOrAbove: 0.8 });
  });

  it('surfaces thresholds in the listing', async () => {
    await capture(() => cmdPolicy(['set-threshold', '--allowBelow=0.25', '--blockAtOrAbove=0.75', P()]));
    const r = await capture(() => cmdPolicy(['list', P()]));
    expect(r.stdout).toContain('allowBelow=0.25');
    expect(r.stdout).toContain('blockAtOrAbove=0.75');
  });
});

describe('unknown subcommand', () => {
  it('exits 1', async () => {
    const r = await capture(() => cmdPolicy(['frobnicate', P()]));
    expect(r.exitCode).toBe(1);
  });
});

describe('policy add --priority', () => {
  it('persists the priority as a number', async () => {
    await capture(() => cmdPolicy(['add', '--id=R1', '--priority=25', '--action=block', P()]));
    const policy = await readPolicy();
    expect(policy.rules[0]!['priority']).toBe(25);
  });

  it('rejects a non-numeric priority', async () => {
    const r = await capture(() => cmdPolicy(['add', '--id=R1', '--priority=soon', P()]));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('Invalid --priority');
  });

  it('accepts 0 as a valid priority', async () => {
    await capture(() => cmdPolicy(['add', '--id=R0', '--priority=0', P()]));
    const policy = await readPolicy();
    expect(policy.rules[0]!['priority']).toBe(0);
  });
});
