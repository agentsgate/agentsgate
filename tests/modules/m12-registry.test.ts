import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CommunityAdapterRegistry } from '../../src/modules/m12-registry/index.js';
import type { RollbackAdapter, MCPOperation, RollbackCapability, StateSnapshot, RollbackResult, RollbackPreview } from '../../src/types/interfaces.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function mkTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'as-reg-test-'));
}

/** Write a valid adapter plugin file to a temp directory. */
async function writeValidPlugin(dir: string, filename: string, adapterId: string): Promise<string> {
  const content = `
export default {
  adapterId: '${adapterId}',
  version: '1.0.0',
  supportedTools: ['test-tool'],
  canRollback: async () => ({ canRollback: true, confidence: 1 }),
  captureState: async (op) => ({ adapterId: '${adapterId}', operationId: op.id, data: {}, capturedAt: new Date() }),
  rollback: async () => ({ success: true, restoredFiles: [], failedFiles: [] }),
  previewRollback: async () => ({ willRestore: [], cannotRestore: [], warnings: [] }),
};
`;
  const filePath = path.join(dir, filename);
  await fs.writeFile(filePath, content);
  return filePath;
}

async function writeInvalidPlugin(dir: string, filename: string): Promise<void> {
  await fs.writeFile(path.join(dir, filename), `export default { adapterId: '' };`);
}

describe('CommunityAdapterRegistry', () => {
  let registry: CommunityAdapterRegistry;
  let pluginDir: string;

  beforeEach(async () => {
    registry = new CommunityAdapterRegistry();
    pluginDir = await mkTmpDir();
  });

  afterEach(async () => {
    await fs.rm(pluginDir, { recursive: true, force: true });
  });

  it('should discover adapter files in a plugin directory', async () => {
    await writeValidPlugin(pluginDir, 'my-adapter.js', 'my-adapter');
    const discovered = await registry.discover(pluginDir);
    expect(discovered).toHaveLength(1);
    expect(discovered[0].adapterId).toBe('my-adapter');
  });

  it('should validate an adapter with required fields', async () => {
    const adapter: RollbackAdapter = {
      adapterId: 'valid-adapter',
      version: '1.0.0',
      supportedTools: ['github'],
      canRollback: async (): Promise<RollbackCapability> => ({ canRollback: true, confidence: 1 }),
      captureState: async (op: MCPOperation): Promise<StateSnapshot> => ({ adapterId: 'valid-adapter', operationId: op.id, data: {}, capturedAt: new Date() }),
      rollback: async (): Promise<RollbackResult> => ({ success: true, restoredFiles: [], failedFiles: [] }),
      previewRollback: async (): Promise<RollbackPreview> => ({ willRestore: [], cannotRestore: [], warnings: [] }),
    };
    expect(await registry.validate(adapter)).toBe(true);
  });

  it('should reject adapters missing required fields', async () => {
    expect(await registry.validate({} as RollbackAdapter)).toBe(false);
    expect(await registry.validate({ adapterId: '' } as unknown as RollbackAdapter)).toBe(false);
    expect(await registry.validate({ adapterId: 'a', version: '1', supportedTools: ['t'] } as unknown as RollbackAdapter)).toBe(false);
  });

  it('should load and register all valid adapters from a directory', async () => {
    await writeValidPlugin(pluginDir, 'adapter-a.js', 'adapter-a');
    await writeValidPlugin(pluginDir, 'adapter-b.js', 'adapter-b');
    await writeInvalidPlugin(pluginDir, 'bad.js');

    await registry.load(pluginDir);
    const all = registry.getAll();
    expect(all).toHaveLength(2);
    expect(all.map(a => a.adapterId)).toContain('adapter-a');
    expect(all.map(a => a.adapterId)).toContain('adapter-b');
  });

  it('should list all loaded adapters', async () => {
    expect(registry.getAll()).toHaveLength(0);
    await writeValidPlugin(pluginDir, 'one.js', 'one');
    await registry.load(pluginDir);
    expect(registry.getAll()).toHaveLength(1);
  });
});
