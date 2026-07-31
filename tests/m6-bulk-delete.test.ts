/**
 * Deleting a tree is not the same as deleting a file.
 *
 * The database rules draw this line: `DELETE ... WHERE id = 1` is a routine
 * write, `DELETE FROM orders` is destruction, and they score and categorise
 * differently. The filesystem rules did not. `L1_DELETE_FILE` matched on the
 * method name alone, so removing one file and removing a directory tree were
 * indistinguishable — and with `balanced` allowing `write_delete`, both ran
 * without a word.
 *
 * The same gap existed via the shell: `rm -rf /` scored as ordinary command
 * execution, which `balanced` allows.
 *
 * Two new categories, split on whether a checkpoint can undo it:
 *
 *   bulk_delete   removes many things at once, but the shadow repo has them —
 *                 held for approval at balanced, blocked at strict
 *   destructive   nothing can bring it back: mkfs, dd onto a device, shred
 *                 — refused at every level, as the database equivalents are
 */
import { describe, it, expect } from 'vitest';
import { createPipeline } from '../src/modules/m1-proxy/index.js';
import { RiskScoringEngine } from '../src/modules/m6-risk/index.js';
import { InterventionController } from '../src/modules/m7-intervention/index.js';
import { getProtectionLevel } from '../src/protection-levels.js';
import type { MCPOperation, ProxyDecision } from '../src/types/interfaces.js';

const engine = new RiskScoringEngine();

async function assess(tool: string, method: string, params: Record<string, unknown> = {}) {
  return engine.assess({
    id: 'op', agentId: 'a', tool, method, params,
    timestamp: new Date(), sessionId: 's',
  } as MCPOperation);
}

function at(level: string) {
  const p = createPipeline({
    riskEngine: new RiskScoringEngine(),
    interventionController: new InterventionController({ allowBelow: 0.3, blockAtOrAbove: 0.7 }),
    protectionLevel: getProtectionLevel(level)!,
  });
  return (tool: string, method: string, params: Record<string, unknown> = {}): Promise<ProxyDecision> =>
    p.evaluateRisk!({
      id: 'op', agentId: 'a', tool, method, params,
      timestamp: new Date(), sessionId: 's',
    } as MCPOperation);
}

describe('removing a directory', () => {
  it('is recognised as a different thing from removing a file', async () => {
    const tree = await assess('filesystem', 'delete_directory', { path: '/app/src' });
    expect(tree.triggeredRules).toContain('L1_DELETE_TREE');

    const one = await assess('filesystem', 'delete_file', { path: '/app/src/a.ts' });
    expect(one.triggeredRules).toContain('L1_DELETE_FILE');
    expect(one.triggeredRules).not.toContain('L1_DELETE_TREE');
  });

  it('is recognised however the method is spelled', async () => {
    for (const method of ['delete_directory', 'remove_directory', 'rmdir', 'delete_dir', 'remove_tree']) {
      const r = await assess('filesystem', method, { path: '/app/src' });
      expect(r.triggeredRules, method).toContain('L1_DELETE_TREE');
    }
  });

  it('is recognised from a wildcard, whatever the method is called', async () => {
    const r = await assess('filesystem', 'delete_file', { path: '/app/src/*.ts' });
    expect(r.triggeredRules).toContain('L1_DELETE_TREE');
  });

  it('waits for a human at balanced, and is refused at strict', async () => {
    expect((await at('minimal')('filesystem', 'delete_directory', { path: '/app/src' })).action).toBe('allow');
    expect((await at('balanced')('filesystem', 'delete_directory', { path: '/app/src' })).action).toBe('require_approval');
    expect((await at('strict')('filesystem', 'delete_directory', { path: '/app/src' })).action).toBe('block');
  });

  it('leaves deleting a single file where it was', async () => {
    expect((await at('balanced')('filesystem', 'delete_file', { path: '/app/a.ts' })).action).toBe('allow');
    expect((await at('strict')('filesystem', 'delete_file', { path: '/app/a.ts' })).action).toBe('require_approval');
  });
});

describe('a recursive delete through the shell', () => {
  it('is treated as the directory delete it is', async () => {
    for (const command of ['rm -rf /app/src', 'rm -fr build', 'rm -r ./dist', 'rm --recursive tmp']) {
      const r = await assess('shell', 'execute', { command });
      expect(r.triggeredRules, command).toContain('L1_DELETE_TREE');
    }
    expect((await at('balanced')('shell', 'execute', { command: 'rm -rf node_modules' })).action)
      .toBe('require_approval');
  });

  it('does not fire for a shell command that merely mentions a file', async () => {
    for (const command of ['rm a.txt', 'npm test', 'git status', 'grep -r foo .']) {
      const r = await assess('shell', 'execute', { command });
      expect(r.triggeredRules, command).not.toContain('L1_DELETE_TREE');
    }
  });
});

describe('commands nothing can undo', () => {
  it('are refused at every level, as the database equivalents are', async () => {
    const commands = [
      'mkfs.ext4 /dev/sda1',
      'dd if=/dev/zero of=/dev/sda',
      'shred -u /etc/passwd',
      'echo x > /dev/sda',
    ];
    for (const command of commands) {
      const r = await assess('shell', 'execute', { command });
      expect(r.triggeredRules, command).toContain('L1_DESTRUCTIVE_COMMAND');
      for (const level of ['minimal', 'balanced', 'strict']) {
        expect((await at(level)('shell', 'execute', { command })).action, `${level}: ${command}`).toBe('block');
      }
    }
  });

  it('do not catch ordinary work', async () => {
    for (const command of ['npm test', 'git status', 'dd --help', 'echo hello > out.txt']) {
      const r = await assess('shell', 'execute', { command });
      expect(r.triggeredRules, command).not.toContain('L1_DESTRUCTIVE_COMMAND');
    }
  });
});

describe('everyday work is still not interrupted', () => {
  it('at balanced', async () => {
    const run = at('balanced');
    expect((await run('filesystem', 'read_file', { path: '/app/a.ts' })).action).toBe('allow');
    expect((await run('filesystem', 'write_file', { path: '/app/a.ts', content: 'x' })).action).toBe('allow');
    expect((await run('shell', 'execute', { command: 'npm test' })).action).toBe('allow');
    expect((await run('shell', 'execute', { command: 'git status' })).action).toBe('allow');
  });
});
