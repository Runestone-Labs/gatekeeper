import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  // Target the schema files directly rather than the barrel (index.ts). The
  // barrel re-exports with ESM `./audit.js` specifiers that drizzle-kit's CJS
  // loader can't resolve, which broke `db:generate`. The resulting snapshot is
  // identical to the barrel's, so migrations diff correctly.
  schema: ['./src/db/schema/audit.ts', './src/db/schema/memory.ts'],
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL || 'postgresql://runestone:runestone_dev@127.0.0.1:5432/memory',
  },
});
