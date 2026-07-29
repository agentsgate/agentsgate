/**
 * `--version` must print the version and nothing else.
 *
 * It used to fall through to the `default:` arm of the dispatch switch, which
 * prints the banner followed by the whole usage block and exits 1 — so the
 * version was technically in the output, but buried in 60 lines of help and
 * accompanied by a failure exit code.
 *
 * The unit tests cover the text itself; the subprocess tests cover the routing,
 * which is only observable by actually running the built CLI.
 */
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { VERSION_LINE, printUsage } from '../../src/cli/help.js';
import { AGENTSGATE_VERSION } from '../../src/version.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const builtCli = path.join(root, 'dist', 'cli.js');
const isBuilt = fsSync.existsSync(builtCli);

function runCli(...args: string[]): { stdout: string; stderr: string; status: number } {
  const res = spawnSync(process.execPath, [builtCli, ...args], {
    encoding: 'utf8',
    env: { ...process.env, AGENTSGATE_DEBUG: '' },
  });
  return { stdout: res.stdout ?? '', stderr: res.stderr ?? '', status: res.status ?? -1 };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('VERSION_LINE', () => {
  it('is the version and nothing else', () => {
    expect(VERSION_LINE).toBe(`AgentsGate v${AGENTSGATE_VERSION}`);
  });

  it('is a single line, with no usage text attached', () => {
    expect(VERSION_LINE).not.toContain('\n');
    expect(VERSION_LINE).not.toContain('Usage:');
    expect(VERSION_LINE).not.toContain('—');
  });
});

describe('printUsage', () => {
  it('leads with the banner and lists the documented commands', () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation(msg => { lines.push(String(msg)); });

    printUsage();
    const out = lines.join('\n');

    expect(lines[0]).toBe(`AgentsGate v${AGENTSGATE_VERSION} — MCP Proxy Gateway\n`);
    expect(out).toContain('Usage:');
    for (const cmd of ['start', 'stop', 'status', 'doctor', 'inject', 'rollback', 'explain']) {
      expect(out).toContain(`agentsgate ${cmd}`);
    }
  });
});

// The routing is a property of the built entry point, so it needs a real run.
// CI builds before testing; locally this needs `npm run build` first.
describe.skipIf(!isBuilt)('dispatch (dist/cli.js)', () => {
  for (const flag of ['--version', '-v', 'version']) {
    it(`\`${flag}\` prints only the version and exits 0`, () => {
      const { stdout, status } = runCli(flag);
      expect(status).toBe(0);
      expect(stdout.trim()).toBe(`AgentsGate v${AGENTSGATE_VERSION}`);
      expect(stdout).not.toContain('Usage:');
    });
  }

  for (const flag of ['--help', '-h', 'help']) {
    it(`\`${flag}\` prints the usage and exits 0`, () => {
      const { stdout, status } = runCli(flag);
      expect(status).toBe(0);
      expect(stdout).toContain('Usage:');
      expect(stdout).toContain('agentsgate start');
    });
  }

  it('prints the usage and exits 0 when given no arguments', () => {
    const { stdout, status } = runCli();
    expect(status).toBe(0);
    expect(stdout).toContain('Usage:');
  });

  it('prints the usage and exits 1 on an unknown command', () => {
    const { stdout, status } = runCli('definitely-not-a-command');
    expect(status).toBe(1);
    expect(stdout).toContain('Usage:');
  });
});
