import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globals: false,
    environment: 'node',
    // m10-dashboard/index.ts is ~11k lines; increase transform timeout to avoid
    // SSR worker timeout when the file is transformed cold (no cache).
    transformTimeout: 60_000,
    // Many suites bind a throwaway HTTP server and talk to it over loopback.
    // Under full-suite load, binding and the first round trip can take well
    // over the 5s/10s defaults, which surfaced as spurious timeouts rather
    // than real hangs. Raised so a timeout means something is actually stuck.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/types/**'],
      // A ratchet. These sit just under what the suite currently produces, so
      // a drop fails the build. Raise them as coverage improves; never lower
      // them to make a build pass.
      //
      // Remaining gap: src/cli.ts is the argv dispatcher, whose switch runs at
      // import time, so it is only reachable by spawning the binary. Branch
      // coverage is the weakest axis — much of it is optional-field rendering
      // in the report formatters.
      thresholds: {
        statements: 89,
        branches: 76,
        functions: 96,
        lines: 82,
      },
    },
  },
});
