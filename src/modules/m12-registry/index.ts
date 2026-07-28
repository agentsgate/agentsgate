import fs from 'node:fs/promises';
import path from 'node:path';
import type { RollbackAdapter } from '../../types/interfaces.js';

const REQUIRED_FIELDS: (keyof RollbackAdapter)[] = [
  'adapterId', 'version', 'supportedTools',
  'canRollback', 'captureState', 'rollback', 'previewRollback',
];

/**
 * M12: Community Adapter Registry
 * Discovers, validates, and loads community-contributed RollbackAdapter plugins
 * from a local plugin directory. Each plugin file must have a default export
 * that implements the RollbackAdapter interface.
 */
export class CommunityAdapterRegistry {
  private readonly loaded: RollbackAdapter[] = [];

  /**
   * Scan `pluginDir` for .js / .mjs files and attempt to import each one.
   * Returns successfully imported adapters (invalid exports are skipped).
   */
  async discover(pluginDir: string): Promise<RollbackAdapter[]> {
    let entries: string[];
    try {
      const dirents = await fs.readdir(pluginDir, { withFileTypes: true });
      entries = dirents
        .filter(d => d.isFile() && /\.(js|mjs)$/.test(d.name))
        .map(d => path.join(pluginDir, d.name));
    } catch {
      return [];
    }

    const adapters: RollbackAdapter[] = [];
    for (const filePath of entries) {
      try {
        const mod = await import(filePath) as { default?: unknown };
        const candidate = mod.default;
        if (candidate && (await this.validate(candidate as RollbackAdapter))) {
          adapters.push(candidate as RollbackAdapter);
        }
      } catch {
        // Skip files that fail to import
      }
    }
    return adapters;
  }

  /**
   * Check that an adapter object has all required fields with the correct types.
   * Returns true if valid.
   */
  async validate(adapter: RollbackAdapter): Promise<boolean> {
    if (!adapter || typeof adapter !== 'object') return false;
    for (const field of REQUIRED_FIELDS) {
      if (adapter[field] === undefined || adapter[field] === null) return false;
    }
    if (typeof adapter.adapterId !== 'string' || adapter.adapterId.length === 0) return false;
    if (typeof adapter.version !== 'string') return false;
    if (!Array.isArray(adapter.supportedTools)) return false;
    if (typeof adapter.canRollback !== 'function') return false;
    if (typeof adapter.captureState !== 'function') return false;
    if (typeof adapter.rollback !== 'function') return false;
    if (typeof adapter.previewRollback !== 'function') return false;
    return true;
  }

  /**
   * Discover all valid adapters in `pluginDir` and store them internally.
   * Duplicates (same adapterId) are ignored.
   */
  async load(pluginDir: string): Promise<void> {
    const discovered = await this.discover(pluginDir);
    const existingIds = new Set(this.loaded.map(a => a.adapterId));
    for (const adapter of discovered) {
      if (!existingIds.has(adapter.adapterId)) {
        this.loaded.push(adapter);
        existingIds.add(adapter.adapterId);
      }
    }
  }

  /** Return all successfully loaded adapters. */
  getAll(): RollbackAdapter[] {
    return [...this.loaded];
  }

  /**
   * Discover all valid adapters in `pluginDir` and register them into any
   * object that exposes registerAdapter(). Returns the count registered.
   */
  async loadInto(
    engine: { registerAdapter(adapter: RollbackAdapter): void },
    pluginDir: string,
  ): Promise<number> {
    await this.load(pluginDir);
    const adapters = this.getAll();
    for (const adapter of adapters) {
      engine.registerAdapter(adapter);
    }
    return adapters.length;
  }
}
