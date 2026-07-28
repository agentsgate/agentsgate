import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts', 'src/mcp-servers/filesystem-extended/index.ts', 'src/mcp-servers/database/index.ts', 'src/mcp-servers/pg-database/index.ts', 'src/mcp-servers/mysql-database/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node20',
});
