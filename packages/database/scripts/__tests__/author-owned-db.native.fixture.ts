import { randomUUID } from "node:crypto";
import {
  withGuardedTestDatabase,
  type TestDatabaseClient,
} from "../test-db-guard";
import { createPgTestClient } from "../pg-test-client";
import {
  discoverNativeMigrations,
  runNativeMigrations,
} from "../native-migrate";

/** Each mounted author test owns a fresh child database; never resets the canonical test DB. */
export async function withOwnedAuthorDb(
  run: (db: TestDatabaseClient, url: string) => Promise<void>,
) {
  await withGuardedTestDatabase(
    process.env,
    { clientFactory: createPgTestClient },
    async (root) => {
      const name = "aiag_author_http_" + randomUUID().replaceAll("-", "");
      if (!/^aiag_author_http_[a-f0-9]{32}$/.test(name))
        throw Error("Invalid owned database");
      let oid: string | undefined, child: TestDatabaseClient | undefined;
      try {
        await root.query({
          text: 'CREATE DATABASE "' + name + '" TEMPLATE template0',
          values: [],
        });
        oid = (
          await root.query<{ oid: string }>({
            text: "SELECT oid::text FROM pg_database WHERE datname=$1",
            values: [name],
          })
        ).rows[0]?.oid;
        if (!oid) throw Error("Owned database creation uncertain");
        const url = new URL(process.env.TEST_DATABASE_URL!);
        url.pathname = "/" + name;
        child = await createPgTestClient(url.href);
        await child.connect();
        const identity = await child.query({
          text: "SELECT current_database() AS name,inet_server_port() AS port",
          values: [],
        });
        if (identity.rows[0]?.name !== name || identity.rows[0]?.port !== 15432)
          throw Error("Wrong owned database");
        await runNativeMigrations(child, await discoverNativeMigrations());
        await run(child, url.href);
      } finally {
        await child?.end();
        if (oid) {
          const current = (
            await root.query<{ oid: string }>({
              text: "SELECT oid::text FROM pg_database WHERE datname=$1",
              values: [name],
            })
          ).rows[0]?.oid;
          if (current !== oid) throw Error("Owned database identity changed");
          await root.query({
            text: 'DROP DATABASE "' + name + '" WITH (FORCE)',
            values: [],
          });
        }
      }
    },
  );
}
