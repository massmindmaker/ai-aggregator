import { describe, expect, it } from "vitest";

import {
  discoverNativeMigrations,
  prepareMigrationSql,
  runNativeMigrations,
  type NativeMigration,
} from "../native-migrate";
import type { QueryConfig, TestDatabaseClient } from "../test-db-guard";

class RecordingClient implements TestDatabaseClient {
  readonly queries: QueryConfig[] = [];
  readonly applied = new Map<
    string,
    { checksum: string; effectiveChecksum: string }
  >();
  failOnSql: string | null = null;

  async connect() {}
  async end() {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    config: QueryConfig,
  ): Promise<{ rows: Row[]; rowCount: number | null }> {
    this.queries.push(config);
    if (config.text.includes("SELECT version, checksum")) {
      return {
        rows: [...this.applied].map(([version, value]) => ({
          version,
          checksum: value.checksum,
          effective_checksum: value.effectiveChecksum,
        })) as unknown as Row[],
        rowCount: this.applied.size,
      };
    }
    if (this.failOnSql && config.text.includes(this.failOnSql)) {
      throw new Error("synthetic migration failure");
    }
    if (config.text.includes("INSERT INTO public.schema_migrations")) {
      this.applied.set(String(config.values?.[0]), {
        checksum: String(config.values?.[1]),
        effectiveChecksum: String(config.values?.[2]),
      });
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
}

function migration(
  version: string,
  sql: string,
  checksum = `${version}-checksum`,
): NativeMigration {
  return { version, filename: `${version}.sql`, sql, checksum };
}

describe("native ordered migrator", () => {
  it("discovers the complete immutable history in deterministic order", async () => {
    const migrations = await discoverNativeMigrations();

    expect(migrations).toHaveLength(80);
    expect(migrations[0].version).toBe("drizzle/0000_moaning_the_fury.sql");
    expect(migrations[1].version).toBe("migrations/0004_gateway_core.sql");
    expect(migrations[2].version).toBe(
      "migrations/0004_seed_test_upstreams.sql",
    );
    expect(migrations.at(-1)?.version).toBe(
      "migrations/0080_gateway_stored_chat_byok.sql",
    );
    expect(new Set(migrations.map(({ checksum }) => checksum)).size).toBe(80);
  });

  it("removes only an outer transaction wrapper owned by a historical file", () => {
    const prepared = prepareMigrationSql(
      migration(
        "migrations/wrapped.sql",
        "-- header\nBEGIN;\nDO $$ BEGIN RAISE NOTICE 'inner'; END $$;\nCOMMIT;\n-- footer\n",
      ),
    );

    expect(prepared.text).toContain(
      "DO $$ BEGIN RAISE NOTICE 'inner'; END $$;",
    );
    expect(prepared.text).not.toMatch(/^\s*BEGIN;/m);
    expect(prepared.text).not.toMatch(/^\s*COMMIT;/m);
  });

  it("maps the vetted 0060 psql values to bind parameters", () => {
    const prepared = prepareMigrationSql(
      migration(
        "migrations/0060_tma_own_org.sql",
        "INSERT INTO gateway_api_keys (key_hash, key_prefix)\nVALUES (\n  :'key_hash',\n  :'key_prefix'\n)",
      ),
    );

    expect(prepared.text).toBe(
      "INSERT INTO gateway_api_keys (key_hash, key_prefix)\nVALUES (\n  $1,\n  $2\n)",
    );
    expect(prepared.values).toHaveLength(2);
    expect(prepared.values[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(prepared.values[1]).toMatch(/^sk_aiag_test_/);
  });

  it("does not confuse JSON object keys with psql variables", () => {
    const prepared = prepareMigrationSql(
      migration(
        "drizzle/0000.sql",
        `SELECT '{"notifications":true,"theme":"system"}'::jsonb`,
      ),
    );

    expect(prepared.values).toEqual([]);
    expect(prepared.text).toContain('"notifications":true');
  });

  it("guards the stale 0005 payouts author index against the canonical user_id table", () => {
    const prepared = prepareMigrationSql(
      migration(
        "migrations/0005_contests.sql",
        "CREATE INDEX IF NOT EXISTS payouts_author_idx ON payouts(author_id);",
      ),
    );

    expect(prepared.text).toContain("DO $$ BEGIN");
    expect(prepared.text).toContain("END $$;");
    expect(prepared.text).toContain("column_name = 'author_id'");
    expect(prepared.text).toContain("column_name = 'user_id'");
    expect(prepared.text).toContain("RAISE EXCEPTION");
    expect(prepared.text).toContain(
      "CREATE INDEX IF NOT EXISTS payouts_author_idx",
    );
    expect(prepared.text).not.toMatch(
      /^CREATE INDEX IF NOT EXISTS payouts_author_idx/m,
    );
  });

  it("fails closed if the vetted 0005 compatibility statement drifts", () => {
    expect(() =>
      prepareMigrationSql(
        migration(
          "migrations/0005_contests.sql",
          "CREATE INDEX payouts_author_idx ON payouts(author_id);",
        ),
      ),
    ).toThrow("did not match exactly once");
  });

  it("adds only the runtime-required audit columns before the historical 0011 body", () => {
    const prepared = prepareMigrationSql(
      migration(
        "migrations/0011_admin.sql",
        `CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  actor_email VARCHAR(255),
  details JSONB,
  ip_address VARCHAR(45)
);`,
      ),
    );

    const prelude = prepared.text.indexOf("ALTER TABLE public.audit_log");
    const historical = prepared.text.indexOf(
      "CREATE TABLE IF NOT EXISTS audit_log",
    );
    expect(prelude).toBeGreaterThanOrEqual(0);
    expect(prelude).toBeLessThan(historical);
    expect(prepared.text).toContain(
      "ADD COLUMN IF NOT EXISTS actor_email VARCHAR(255)",
    );
    expect(prepared.text).toContain("ADD COLUMN IF NOT EXISTS details JSONB");
    expect(prepared.text).toContain(
      "ADD COLUMN IF NOT EXISTS ip_address VARCHAR(45)",
    );
    expect(prepared.text).toContain(
      "CREATE INDEX IF NOT EXISTS audit_log_actor_email_idx ON audit_log(actor_email)",
    );
    expect(prepared.text).not.toMatch(/\b(DROP|RENAME|UPDATE)\b/i);
  });

  it("applies each pending migration and its checksum in one transaction", async () => {
    const client = new RecordingClient();
    const migrations = [migration("migrations/0001.sql", "SELECT 1")];

    const result = await runNativeMigrations(client, migrations);

    expect(result).toEqual({ applied: ["migrations/0001.sql"], skipped: [] });
    expect(client.queries.map(({ text }) => text)).toEqual([
      expect.stringContaining(
        "CREATE TABLE IF NOT EXISTS public.schema_migrations",
      ),
      expect.stringContaining("SELECT version, checksum"),
      "BEGIN",
      "SELECT 1",
      expect.stringContaining("INSERT INTO public.schema_migrations"),
      "COMMIT",
    ]);
    expect(client.applied.get("migrations/0001.sql")?.checksum).toBe(
      "migrations/0001.sql-checksum",
    );
  });

  it("skips an already-applied migration without mutating it", async () => {
    const client = new RecordingClient();
    const prepared = prepareMigrationSql(
      migration("migrations/0001.sql", "SELECT 1", "same"),
    );
    client.applied.set("migrations/0001.sql", {
      checksum: "same",
      effectiveChecksum: prepared.effectiveChecksum,
    });

    const result = await runNativeMigrations(client, [
      migration("migrations/0001.sql", "SELECT 1", "same"),
    ]);

    expect(result).toEqual({ applied: [], skipped: ["migrations/0001.sql"] });
    expect(client.queries.map(({ text }) => text)).not.toContain("BEGIN");
  });

  it("rejects an effective SQL checksum change before executing migration SQL", async () => {
    const client = new RecordingClient();
    client.applied.set("migrations/0001.sql", {
      checksum: "same-original",
      effectiveChecksum: "old-adapter",
    });

    await expect(
      runNativeMigrations(client, [
        migration("migrations/0001.sql", "MUST NOT RUN", "same-original"),
      ]),
    ).rejects.toThrow("effective checksum mismatch");

    expect(
      client.queries.some(({ text }) => text.includes("MUST NOT RUN")),
    ).toBe(false);
  });

  it("executes the 0060 prefix and parameterized key insert inside one owned transaction", async () => {
    const client = new RecordingClient();
    const sql = `BEGIN;
INSERT INTO users (email) VALUES ('local@example.test');
INSERT INTO gateway_api_keys (key_hash, key_prefix)
VALUES (
  :'key_hash',
  :'key_prefix'
);
COMMIT;`;

    await runNativeMigrations(client, [
      migration("migrations/0060_tma_own_org.sql", sql),
    ]);

    const texts = client.queries.map(({ text }) => text);
    const begin = texts.indexOf("BEGIN");
    const prefix = texts.findIndex((text) =>
      text.includes("INSERT INTO users"),
    );
    const keyed = texts.findIndex((text) =>
      text.startsWith("INSERT INTO gateway_api_keys"),
    );
    const ledger = texts.findIndex((text) =>
      text.includes("INSERT INTO public.schema_migrations"),
    );
    const commit = texts.indexOf("COMMIT");
    expect(begin).toBeLessThan(prefix);
    expect(prefix).toBeLessThan(keyed);
    expect(keyed).toBeLessThan(ledger);
    expect(ledger).toBeLessThan(commit);
    expect(client.queries[keyed].values).toHaveLength(2);
  });

  it("rejects a changed checksum before executing migration SQL", async () => {
    const client = new RecordingClient();
    client.applied.set("migrations/0001.sql", {
      checksum: "old-checksum",
      effectiveChecksum: "irrelevant",
    });

    await expect(
      runNativeMigrations(client, [
        migration("migrations/0001.sql", "MUST NOT RUN", "new-checksum"),
      ]),
    ).rejects.toThrow("checksum mismatch");

    expect(
      client.queries.some(({ text }) => text.includes("MUST NOT RUN")),
    ).toBe(false);
  });

  it("rolls back a failed migration and does not record it", async () => {
    const client = new RecordingClient();
    client.failOnSql = "BROKEN SQL";

    await expect(
      runNativeMigrations(client, [
        migration("migrations/0001.sql", "BROKEN SQL"),
      ]),
    ).rejects.toThrow("synthetic migration failure");

    expect(client.queries.at(-1)?.text).toBe("ROLLBACK");
    expect(client.applied.has("migrations/0001.sql")).toBe(false);
  });
});
