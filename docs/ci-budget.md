# AgentsGate CI Test Budget

**Budget: 120 seconds for the full test suite**

## Current Baseline (2026-03-21)

| Metric | Value |
|--------|-------|
| Test files | 294 |
| Total tests | 6,281 |
| Wall time | ~90s |
| Transform | ~10s |
| Collect | ~74s |
| Test execution | ~446s (parallel) |
| Status | ✅ Within budget |

## Budget Enforcement

If CI duration exceeds 120s, investigate in this order:

1. **Port collisions** — check for `EADDRINUSE` failures in M10 dashboard tests
2. **New test files** — check if new large test files were added
3. **Parallel workers** — Vitest defaults to CPU count; lower if needed via `vitest.config.ts`
4. **Test consolidation** — merge M10 dashboard files into fewer suites (T400)

## Vitest Configuration

No custom pool config — defaults to automatic worker count based on CPU cores.
To cap workers: add `pool: 'forks', poolOptions: { forks: { maxForks: 8 } }` to vitest.config.ts.
