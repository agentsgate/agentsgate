/**
 * The version AgentsGate reports must match the version it is published as.
 *
 * `rootDir` is ./src, so package.json cannot be imported from source and the
 * number is duplicated in src/version.ts. This test is what keeps the two in
 * step. Before the constant existed the CLI banner said 0.5.0, the OTLP
 * exporter 0.6.0 and GET /health 0.4.0 — for the same build.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENTSGATE_VERSION } from '../src/version.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('AGENTSGATE_VERSION', () => {
  it('matches the version in package.json', async () => {
    const pkg = JSON.parse(await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8')) as { version: string };
    expect(AGENTSGATE_VERSION).toBe(pkg.version);
  });

  it('is a plain semver triple', () => {
    expect(AGENTSGATE_VERSION).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  });

  it('is the only place the product version is written down', async () => {
    // Narrow on purpose. MCP servers and rollback adapters declare their own
    // component versions ('1.0.0' and friends) as part of their protocol and
    // SDK contracts; those are independent of the release number and must not
    // be swept up here. What this catches is a product version hardcoded back
    // into a banner or a self-reporting payload.
    const PRODUCT_VERSION_PATTERNS = [
      /AgentsGate v\d+\.\d+\.\d+/i,                        // CLI banner
      /service\.version['"]?\s*[,:].*['"]\d+\.\d+\.\d+['"]/, // OTLP resource attr
      /\bversion:\s*['"]\d+\.\d+\.\d+['"]/,                 // /health payload
    ];
    const COMPONENT_FILES = /(mcp-servers|m9-adapters|m9-plugin-sdk|streamable-http|types)/;

    const offenders: string[] = [];

    async function walk(dir: string): Promise<void> {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { await walk(full); continue; }
        if (!entry.name.endsWith('.ts')) continue;
        if (full.endsWith(path.join('src', 'version.ts'))) continue;
        if (COMPONENT_FILES.test(full)) continue;

        const src = await fs.readFile(full, 'utf8');
        src.split('\n').forEach((line, i) => {
          if (PRODUCT_VERSION_PATTERNS.some(re => re.test(line))) {
            offenders.push(`${path.relative(repoRoot, full)}:${i + 1}  ${line.trim().slice(0, 70)}`);
          }
        });
      }
    }

    await walk(path.join(repoRoot, 'src'));
    expect(offenders).toEqual([]);
  });

  it('is what the CLI banner, /health and OTLP all report', async () => {
    // The three places that previously disagreed now read the same constant.
    const read = (p: string): Promise<string> => fs.readFile(path.join(repoRoot, p), 'utf8');
    expect(await read('src/cli/help.ts')).toContain('AGENTSGATE_VERSION');
    expect(await read('src/cli/lifecycle.ts')).toContain('AGENTSGATE_VERSION');
    expect(await read('src/modules/m10-dashboard/index.ts')).toContain('version: AGENTSGATE_VERSION');
    expect(await read('src/modules/m13-telemetry/index.ts')).toContain('AGENTSGATE_VERSION');
  });
});
