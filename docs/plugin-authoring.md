# AgentsGate Plugin Adapter Authoring Guide

Plugin adapters extend AgentsGate's rollback capability to SaaS tools and external systems.
Out of the box, AgentsGate can roll back **file system changes** and **database table inserts**.
Adapters let you add rollback for GitHub PRs, Notion pages, Slack messages, Stripe operations, and any other tool your agents use.

---

## What an Adapter Does

For each MCP tool call that passes through AgentsGate, an adapter can:

1. **Capture state** before the operation executes (snapshot)
2. **Roll back** to that snapshot if the user requests it

Adapters are queried in order. The first adapter that returns `canRollback: true` for an operation is used.

---

## The RollbackAdapter Interface

```typescript
import type { RollbackAdapter, RollbackCapability, StateSnapshot, RollbackResult, RollbackPreview, MCPOperation } from 'agentsgate';

export class MyAdapter implements RollbackAdapter {
  readonly adapterId = 'my-adapter';
  readonly version = '1.0.0';
  readonly supportedTools = ['my-tool'];

  async canRollback(operation: MCPOperation): Promise<RollbackCapability> {
    // Determine if this operation can be rolled back
    const supported = operation.tool === 'my-tool' && operation.method === 'create_item';
    return {
      canRollback: supported,
      confidence: supported ? 0.9 : 0.0,
      estimatedDuration: 500, // ms
      limitations: supported ? [] : ['Only create_item is reversible'],
    };
  }

  async captureState(operation: MCPOperation): Promise<StateSnapshot> {
    // Capture the state BEFORE the operation runs
    // For a create operation, this might capture the "nothing exists yet" state
    return {
      adapterId: this.adapterId,
      operationId: operation.id,
      data: {
        tool: operation.tool,
        method: operation.method,
        params: operation.params,
        // Store whatever you need to undo the action
        capturedAt: new Date().toISOString(),
      },
      capturedAt: new Date(),
    };
  }

  async rollback(snapshot: StateSnapshot): Promise<RollbackResult> {
    // Undo the operation using the captured snapshot
    try {
      const { params } = snapshot.data as { params: Record<string, unknown> };
      // Call your API to undo...
      // await myApi.deleteItem(params.itemId);
      return {
        success: true,
        restoredFiles: [],
        failedFiles: [],
      };
    } catch (err) {
      return {
        success: false,
        restoredFiles: [],
        failedFiles: [],
        error: String(err),
      };
    }
  }

  async previewRollback(snapshot: StateSnapshot): Promise<RollbackPreview> {
    // Describe what would happen without actually doing it
    return {
      willRestore: [`item:${(snapshot.data as Record<string, unknown>).itemId}`],
      cannotRestore: [],
      warnings: [],
    };
  }
}
```

---

## Type Reference

### MCPOperation

```typescript
interface MCPOperation {
  id: string;           // UUID
  agentId: string;
  tool: string;         // e.g. "github", "filesystem"
  method: string;       // e.g. "create_pull_request", "write_file"
  params: Record<string, unknown>;
  timestamp: Date;
  sessionId: string;
  parentId?: string;    // For causality tracing
  tags?: string[];
}
```

### RollbackCapability

```typescript
interface RollbackCapability {
  canRollback: boolean;
  confidence: number;           // 0–1: how reliable the rollback is
  estimatedDuration?: number;   // milliseconds
  limitations?: string[];       // warnings to show users
}
```

### StateSnapshot

```typescript
interface StateSnapshot {
  adapterId: string;
  operationId: string;
  data: Record<string, unknown>;  // Anything you need to undo
  capturedAt: Date;
}
```

### RollbackResult

```typescript
interface RollbackResult {
  success: boolean;
  restoredFiles: string[];   // Human-readable list of restored items
  failedFiles: string[];     // Items that could not be restored
  error?: string;
}
```

---

## Example: GitHub PR Adapter

```typescript
import { Octokit } from '@octokit/rest';
import type { RollbackAdapter, RollbackCapability, StateSnapshot, RollbackResult, RollbackPreview, MCPOperation } from 'agentsgate';

export class GitHubPRAdapter implements RollbackAdapter {
  readonly adapterId = 'github-pr';
  readonly version = '1.0.0';
  readonly supportedTools = ['github'];

  private octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

  async canRollback(op: MCPOperation): Promise<RollbackCapability> {
    const rollbackable = op.tool === 'github' && op.method === 'create_pull_request';
    return { canRollback: rollbackable, confidence: rollbackable ? 1.0 : 0 };
  }

  async captureState(op: MCPOperation): Promise<StateSnapshot> {
    return {
      adapterId: this.adapterId,
      operationId: op.id,
      data: { params: op.params },
      capturedAt: new Date(),
    };
  }

  async rollback(snapshot: StateSnapshot): Promise<RollbackResult> {
    const { prNumber, owner, repo } = snapshot.data as {
      prNumber: number; owner: string; repo: string;
    };
    try {
      await this.octokit.pulls.update({ owner, repo, pull_number: prNumber, state: 'closed' });
      return { success: true, restoredFiles: [`PR #${prNumber} closed`], failedFiles: [] };
    } catch (err) {
      return { success: false, restoredFiles: [], failedFiles: [], error: String(err) };
    }
  }

  async previewRollback(snapshot: StateSnapshot): Promise<RollbackPreview> {
    const { prNumber } = snapshot.data as { prNumber: number };
    return {
      willRestore: [`Close PR #${prNumber}`],
      cannotRestore: [],
      warnings: ['Closing a PR does not delete the source branch'],
    };
  }
}
```

---

## Registering Your Adapter

### Via `createPipeline` (programmatic)

```typescript
import { createPipeline } from 'agentsgate';
import { GitHubPRAdapter } from './my-github-adapter.js';

const { proxy } = await createPipeline({
  store,
  pluginAdapters: [new GitHubPRAdapter()],
});
```

### Via the Plugin Registry (discovery)

Adapters can be published to npm and discovered via the `agentsgate-plugin-*` naming convention:

```bash
npm install agentsgate-plugin-github
```

Then in `agentsgate.config.json`:

```json
{
  "plugins": {
    "autoLoad": true,
    "paths": ["./my-local-adapter.js"]
  }
}
```

---

## Testing Your Adapter

```typescript
import { describe, it, expect } from 'vitest';
import { GitHubPRAdapter } from './github-pr-adapter.js';

describe('GitHubPRAdapter', () => {
  const adapter = new GitHubPRAdapter();

  it('claims rollback for create_pull_request', async () => {
    const cap = await adapter.canRollback({
      id: 'op-1', agentId: 'claude', tool: 'github',
      method: 'create_pull_request', params: {},
      timestamp: new Date(), sessionId: 'sess-1',
    });
    expect(cap.canRollback).toBe(true);
  });

  it('does not claim rollback for other methods', async () => {
    const cap = await adapter.canRollback({
      id: 'op-2', agentId: 'claude', tool: 'github',
      method: 'get_issue', params: {},
      timestamp: new Date(), sessionId: 'sess-1',
    });
    expect(cap.canRollback).toBe(false);
  });
});
```

---

## Built-in Adapters

| Adapter | Rollback target |
|---------|-----------------|
| `FilesystemAdapter` | File writes/deletes — restores from shadow git snapshot |
| `DatabaseAdapter` | Database INSERT/UPDATE — replays inverse SQL |
| `GitHubPRAdapter` | GitHub PR creation — closes the opened PR |

---

## Best Practices

1. **Capture before, not after** — `captureState` is called before the operation executes. Don't try to read "what changed" — instead, record what would need to be undone.
2. **Idempotent rollback** — calling `rollback` twice should be safe (closing an already-closed PR is a no-op).
3. **Fail gracefully** — never throw from `rollback`; return `{ success: false, error }` instead.
4. **Set confidence < 1 when uncertain** — if you can't guarantee a clean rollback (e.g., due to side effects), set `confidence: 0.7` and add `limitations`.
5. **Keep `data` serializable** — `StateSnapshot.data` is JSON-serialized to SQLite. No `Date` objects, functions, or circular references.
