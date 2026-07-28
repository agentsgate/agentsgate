# Contributing to AgentsGate

Thanks for your interest in improving AgentsGate. This document covers how to set up the project, the expectations for code and tests, and how patches get reviewed.

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By participating you agree to uphold it.

## Where to start

- **Bug?** Open an issue with the bug report template, or — if it has security implications — see [SECURITY.md](SECURITY.md).
- **Feature idea?** Open an issue with the feature request template *before* writing code, so we can agree on shape and scope.
- **Good first issues** are tagged `good-first-issue` on GitHub.
- **Adapter or MCP server integration?** See [docs/plugin-authoring.md](docs/plugin-authoring.md).

## Development setup

Requires **Node.js ≥ 20**.

```bash
git clone https://github.com/agentsgate/agentsgate.git
cd agentsgate
npm run bootstrap        # installs deps, builds, runs smoke test
```

Useful scripts (see `package.json`):

| Command | Purpose |
|---------|---------|
| `npm test` | Run the full Vitest suite |
| `npm run test:watch` | Vitest watch mode |
| `npm run test:coverage` | Coverage report |
| `npm run typecheck` | TypeScript strict check (no emit) |
| `npm run build` | Bundle with tsup → `dist/` |
| `npm run smoke:start` | One-shot startup smoke test |

The local proxy is started with `node dist/cli.js start` after a build, or `npx agentsgate start` once published.

## Project structure

```
src/types/interfaces.ts   Shared type definitions (touch with care)
src/modules/              One folder per module (M1–M13)
src/cli.ts                CLI entry
src/mcp-servers/          Bundled MCP server implementations
tests/                    Mirrors src/ layout
docs/                     User-facing documentation
examples/                 Runnable example configurations
```

Module map (status in [README.md](README.md)):

| Module | Folder |
|--------|--------|
| M1 Proxy | `src/modules/m1-proxy` |
| M2 Store | `src/modules/m2-store` |
| M3 Logger | `src/modules/m3-logger` |
| M4 Checkpoint | `src/modules/m4-checkpoint` |
| M5 Shadow | `src/modules/m5-shadow` |
| M6 Risk | `src/modules/m6-risk` |
| M7 Intervention | `src/modules/m7-intervention` |
| M8 Rollback | `src/modules/m8-rollback` |
| M9 Adapter SDK | `src/modules/m9-adapter` |
| M10 Dashboard API | `src/modules/m10-dashboard` |
| M11 Risk Intelligence | `src/modules/m11-intelligence` |
| M12 Adapter Registry | `src/modules/m12-registry` |
| M13 Telemetry | `src/modules/m13-telemetry` |

## Workflow

1. **Fork** and create a feature branch off `main` (`feat/<short-name>` or `fix/<short-name>`).
2. **Write tests first** when fixing a bug — a failing test that captures the bug is the most valuable part of the PR.
3. **Implement** the smallest change that solves the problem.
4. **Run the full suite** before pushing: `npm run typecheck && npm test`.
5. **Open a PR** against `main` using the PR template.

### Commit messages

Conventional-style prefixes are preferred but not enforced:

```
feat(M11): add Bayesian decay for stale agent history
fix(M1): handle ECONNRESET on upstream MCP socket
docs(README): clarify dry-run mode
refactor(M10): consolidate dashboard route registration
test(M6): add fixtures for git force-push detection
```

Keep the subject line under 72 characters. Use the body to explain *why*, not *what* — the diff already shows the *what*.

### Pull request checklist

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes (no skipped tests left behind)
- [ ] New behavior has tests; bug fixes have a regression test
- [ ] User-visible changes have a `CHANGELOG.md` entry under `Unreleased`
- [ ] Public API changes update relevant docs (`docs/api-reference.md`, `docs/user-guide.md`)
- [ ] No new dependencies without discussion in the PR description
- [ ] No commits of build output, logs, secrets, or local config (`logs/`, `dist/`, `~$*.docx`)

### Reviewing

Maintainers review PRs in order of severity (security > bug > feature > refactor). Expect first response within a few days. Larger PRs benefit from a design issue first — we may ask you to split work.

## Coding conventions

- **TypeScript strict mode** — no `any` without justification, no `// @ts-ignore` without a comment explaining why.
- **ESM** — use `import`/`export`, not `require`.
- **No comments that just describe what the code does** — comments should explain non-obvious *why*.
- **Errors are values** — return typed result objects from modules that can fail predictably; reserve `throw` for programmer errors and unrecoverable I/O.
- **No new top-level deps** without discussion. `better-sqlite3`, `@modelcontextprotocol/sdk`, `uuid`, and the database drivers are the current set.
- **Match the style of the file you're editing** — don't reformat unrelated lines.

## Tests

We use **Vitest**. Tests live under `tests/` mirroring `src/`. Each module has unit tests; cross-module behavior is covered by integration tests under `tests/integration/`.

- Use real SQLite (in-memory or temp file) — do not mock the database
- Use temp directories for filesystem shadow tests, and clean them up in `afterEach`
- Tests must be deterministic — no relying on wall-clock time, network, or test order
- Aim for one assertion per test where reasonable; group related assertions when they share setup

## Security

If you believe you've found a vulnerability, **do not** open a public issue. Follow the process in [SECURITY.md](SECURITY.md).

## Releases

Contributors don't need to run `npm publish` — CI does it. Maintainers, the
procedure is:

1. Bump the version in **both** `package.json` and `src/version.ts`. They are
   separate because `rootDir` is `./src`, so package.json cannot be imported
   from source; `tests/version.test.ts` fails if they disagree.
2. Move the `[Unreleased]` CHANGELOG entry under the new version with today's
   date, and open a fresh `[Unreleased]`.
3. Update the supported-versions table in `SECURITY.md`.
4. Merge to `main` with a commit message starting `release:` — for example
   `release: 0.2.0`.

CI then runs the full matrix, the quickstart smoke test on three operating
systems, the dependency audit and the coverage gate. Only if all of them pass
does it publish, with `--provenance` so the tarball can be traced back to the
commit and workflow run that produced it. A `release:` commit whose version is
already on the registry fails early rather than at the publish step.

Versions before 0.1.0 in the CHANGELOG are internal development milestones that
were never published; see the note in that file.

## License

By contributing you agree that your contributions are licensed under the MIT License (see [LICENSE](LICENSE)).
