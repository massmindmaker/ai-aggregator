import type {
  QueryConfig,
  TestDatabaseClient,
  TestDatabaseClientFactory,
} from "./test-db-guard";

export const createPgTestClient: TestDatabaseClientFactory = async (
  connectionString,
) => {
  const { Client } = await import("pg");
  const client = new Client({ connectionString, ssl: false });

  return {
    connect: () => client.connect(),
    end: () => client.end(),
    query: async <
      Row extends Record<string, unknown> = Record<string, unknown>,
    >(
      config: QueryConfig,
    ) => {
      const result = await client.query<Row>(config.text, [
        ...(config.values ?? []),
      ]);
      return { rows: result.rows, rowCount: result.rowCount };
    },
  } satisfies TestDatabaseClient;
};
