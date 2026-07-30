/**
 * Single source of truth for the version AgentsGate reports about itself.
 *
 * It cannot be imported from package.json: `rootDir` is `./src`, so a JSON
 * import from the project root would fall outside the compilation root. It is
 * therefore duplicated here and pinned by a test that fails if the two drift
 * (`tests/version.test.ts`).
 *
 * Before this existed the CLI banner said 0.5.0, the OTLP exporter said 0.6.0
 * and `GET /health` said 0.4.0 — three numbers for one build.
 */
export const AGENTSGATE_VERSION = '0.1.2';
