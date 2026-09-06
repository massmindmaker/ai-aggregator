import { createPgTestClient } from "../../../../packages/database/scripts/pg-test-client";
import {
  withGuardedTestDatabase,
  type TestDatabaseClientFactory,
} from "../../../../packages/database/scripts/test-db-guard";

export interface ApiRegisterTestModules {
  POST: (typeof import("../app/api/auth/register/route"))["POST"];
  db: (typeof import("@/lib/db"))["db"];
  users: (typeof import("@aiag/database/schema"))["users"];
  eq: (typeof import("@aiag/database"))["eq"];
}

type TestDatabaseEnvironment = Record<string, string | undefined>;

export async function loadApiRegisterTestModules(
  env: TestDatabaseEnvironment,
  clientFactory: TestDatabaseClientFactory = createPgTestClient,
): Promise<ApiRegisterTestModules> {
  await withGuardedTestDatabase(env, { clientFactory }, async () => undefined);

  const [{ POST }, { db }, { users }, { eq }] = await Promise.all([
    import("../app/api/auth/register/route"),
    import("@/lib/db"),
    import("@aiag/database/schema"),
    import("@aiag/database"),
  ]);
  return { POST, db, users, eq };
}
