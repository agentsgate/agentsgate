import { describe, it, expect } from 'vitest';
import {
  PluginAdapterRegistry,
  BaseRollbackAdapter,
  FilesystemRollbackAdapter,
} from '../../src/modules/m9-plugin-sdk/index.js';
import type {
  MCPOperation,
  RollbackCapability,
  StateSnapshot,
  RollbackResult,
  RollbackPreview,
} from '../../src/types/interfaces.js';

// Minimal concrete adapter for testing
class MockAdapter extends BaseRollbackAdapter {
  readonly adapterId: string;
  readonly version = '1.0.0';
  readonly supportedTools: string[];

  constructor(id: string, tools: string[]) {
    super();
    this.adapterId = id;
    this.supportedTools = tools;
  }
  async canRollback(): Promise<RollbackCapability> { return { canRollback: true, confidence: 1 }; }
  async captureState(op: MCPOperation): Promise<StateSnapshot> { return { adapterId: this.adapterId, operationId: op.id, data: {}, capturedAt: new Date() }; }
  async rollback(): Promise<RollbackResult> { return { success: true, restoredFiles: [], failedFiles: [] }; }
  async previewRollback(): Promise<RollbackPreview> { return { willRestore: [], cannotRestore: [], warnings: [] }; }
}

describe('PluginAdapterRegistry', () => {
  it('should register an adapter', () => {
    const registry = new PluginAdapterRegistry();
    const adapter = new MockAdapter('test-adapter', ['test-tool']);
    registry.register(adapter);
    expect(registry.listAll()).toHaveLength(1);
  });

  it('should unregister an adapter', () => {
    const registry = new PluginAdapterRegistry();
    registry.register(new MockAdapter('rm-me', ['tool']));
    expect(registry.listAll()).toHaveLength(1);
    registry.unregister('rm-me');
    expect(registry.listAll()).toHaveLength(0);
    // Unregistering unknown ID is a no-op
    expect(() => registry.unregister('ghost')).not.toThrow();
  });

  it('should return adapters matching a given tool name', () => {
    const registry = new PluginAdapterRegistry();
    registry.register(new MockAdapter('github-adapter', ['github', 'github-mcp']));
    registry.register(new MockAdapter('fs-adapter', ['filesystem']));

    const githubAdapters = registry.getAdaptersForTool('github');
    expect(githubAdapters).toHaveLength(1);
    expect(githubAdapters[0].adapterId).toBe('github-adapter');

    const fsAdapters = registry.getAdaptersForTool('filesystem');
    expect(fsAdapters).toHaveLength(1);

    expect(registry.getAdaptersForTool('unknown')).toHaveLength(0);
  });

  it('should list all registered adapters', () => {
    const registry = new PluginAdapterRegistry();
    registry.register(new MockAdapter('a1', ['t1']));
    registry.register(new MockAdapter('a2', ['t2']));
    const all = registry.listAll();
    expect(all).toHaveLength(2);
    expect(all.map(a => a.adapterId)).toContain('a1');
    expect(all.map(a => a.adapterId)).toContain('a2');
  });

  it('should throw if registering duplicate adapterId', () => {
    const registry = new PluginAdapterRegistry();
    registry.register(new MockAdapter('dup', ['t']));
    expect(() => registry.register(new MockAdapter('dup', ['t2']))).toThrow(/already registered/);
  });
});

describe('FilesystemRollbackAdapter', () => {
  it('should report canRollback true when path is present', async () => {
    const adapter = new FilesystemRollbackAdapter();
    const op: MCPOperation = {
      id: 'op-1', agentId: 'a', tool: 'filesystem', method: 'write_file',
      params: { path: '/tmp/test.txt' }, timestamp: new Date(), sessionId: 's',
    };
    const cap = await adapter.canRollback(op);
    expect(cap.canRollback).toBe(true);
    expect(cap.confidence).toBeGreaterThan(0.9);
  });
});
