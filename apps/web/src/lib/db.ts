import { createDb, type Database } from '@aiag/database';

// Create a global db instance to avoid multiple connections in development
const globalForDb = globalThis as unknown as {
  db: Database | undefined;
};

function getDb(): Database {
  // During build time, DATABASE_URL might not be set
  // Return a placeholder that throws at runtime if actually used
  if (!process.env.DATABASE_URL) {
    // Create a mock that throws on actual usage
    return new Proxy({} as Database, {
      get(_, prop) {
        throw new Error(
          `Database not initialized. DATABASE_URL environment variable is not set. Tried to access: ${String(prop)}`
        );
      },
    });
  }

  if (!globalForDb.db) {
    globalForDb.db = createDb(process.env.DATABASE_URL);
  }

  return globalForDb.db;
}

// Export a proxy that lazily initializes the database
export const db = new Proxy({} as Database, {
  getPrototypeOf() {
    return Object.getPrototypeOf(getDb());
  },
  get(_, prop) {
    return getDb()[prop as keyof Database];
  },
});

export { eq, and, or, desc, asc, like, ilike, sql } from '@aiag/database';
