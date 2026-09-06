import {
  assertTestDatabaseEnvironment,
  withGuardedTestDatabase,
} from "./test-db-guard";
import {
  discoverNativeMigrations,
  runNativeMigrations,
} from "./native-migrate";
import { createPgTestClient } from "./pg-test-client";

type Command = "bootstrap" | "migrate" | "status";

function sanitizeError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(
    /postgres(?:ql)?:\/\/[^\s]+/gi,
    "[redacted-postgres-url]",
  );
}

async function main() {
  const command = process.argv[2] as Command | undefined;
  if (!command || !["bootstrap", "migrate", "status"].includes(command)) {
    throw new Error("usage: native-test-db.ts <bootstrap|migrate|status>");
  }

  // This pure check deliberately runs before the pg module is imported by the
  // client factory, so a malformed or mismatched environment cannot construct
  // a production-capable database client.
  assertTestDatabaseEnvironment(process.env);

  await withGuardedTestDatabase(
    process.env,
    {
      bootstrapMarker: command === "bootstrap",
      clientFactory: createPgTestClient,
    },
    async (client) => {
      if (command === "bootstrap") {
        console.log("Local test database marker is ready.");
        return;
      }

      if (command === "migrate") {
        const migrations = await discoverNativeMigrations();
        const result = await runNativeMigrations(client, migrations);
        console.log(
          `Native migrations: total=${migrations.length} applied=${result.applied.length} skipped=${result.skipped.length}.`,
        );
        return;
      }

      const result = await client.query<{
        migration_count: string;
        table_count: string;
      }>({
        text: `
          SELECT
            (SELECT COUNT(*)::text FROM public.schema_migrations) AS migration_count,
            (SELECT COUNT(*)::text
               FROM information_schema.tables
              WHERE table_schema = 'public'
                AND table_type = 'BASE TABLE') AS table_count
        `,
        values: [],
      });
      const row = result.rows[0];
      console.log(
        `Native database status: migrations=${row?.migration_count ?? "0"} tables=${row?.table_count ?? "0"}.`,
      );
    },
  );
}

main().catch((error) => {
  console.error(`Native test database command failed: ${sanitizeError(error)}`);
  process.exitCode = 1;
});
