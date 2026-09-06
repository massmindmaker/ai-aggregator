import { createHash, randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { QueryConfig, TestDatabaseClient } from "./test-db-guard";

export interface NativeMigration {
  version: string;
  filename: string;
  sql: string;
  checksum: string;
}

export interface PreparedMigrationSql extends QueryConfig {
  values: readonly unknown[];
  effectiveChecksum: string;
}

const databasePackageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const MIGRATION_FILENAME = /^[0-9][0-9a-z_-]*\.sql$/;

async function readMigrationDirectory(
  root: string,
  directory: "drizzle" | "migrations",
): Promise<NativeMigration[]> {
  const absoluteDirectory = path.join(root, directory);
  const filenames = (await readdir(absoluteDirectory))
    .filter((filename) => filename.endsWith(".sql"))
    .sort();

  return Promise.all(
    filenames.map(async (filename) => {
      if (!MIGRATION_FILENAME.test(filename)) {
        throw new Error(`untrusted migration filename: ${filename}`);
      }
      const sql = await readFile(
        path.join(absoluteDirectory, filename),
        "utf8",
      );
      return {
        version: `${directory}/${filename}`,
        filename,
        sql,
        checksum: createHash("sha256").update(sql).digest("hex"),
      };
    }),
  );
}

export async function discoverNativeMigrations(
  root = databasePackageRoot,
): Promise<NativeMigration[]> {
  const [drizzle, ordered] = await Promise.all([
    readMigrationDirectory(root, "drizzle"),
    readMigrationDirectory(root, "migrations"),
  ]);
  return [...drizzle, ...ordered];
}

function stripOuterTransaction(sql: string): string {
  const lines = sql.split("\n");
  const beginLines: number[] = [];
  const commitLines: number[] = [];
  lines.forEach((line, index) => {
    if (/^\s*BEGIN\s*;\s*$/i.test(line)) beginLines.push(index);
    if (/^\s*COMMIT\s*;\s*$/i.test(line)) commitLines.push(index);
  });

  if (beginLines.length === 0 && commitLines.length === 0) return sql;
  if (beginLines.length !== 1 || commitLines.length !== 1) {
    throw new Error("migration has unsupported transaction control");
  }

  const begin = beginLines[0];
  const commit = commitLines[0];
  const before = lines
    .slice(0, begin)
    .filter((line) => !/^\s*--/.test(line))
    .join("")
    .trim();
  const after = lines
    .slice(commit + 1)
    .filter((line) => !/^\s*--/.test(line))
    .join("")
    .trim();
  if (begin >= commit || before || after) {
    throw new Error("migration transaction wrapper is not outermost");
  }

  lines.splice(commit, 1);
  lines.splice(begin, 1);
  return lines.join("\n");
}

function nativeTestKeyValues() {
  const rawKey = `sk_aiag_test_${randomBytes(24).toString("base64url")}`;
  return {
    keyHash: createHash("sha256").update(rawKey).digest("hex"),
    keyPrefix: rawKey.slice(0, 20),
  };
}

export function prepareMigrationSql(
  migration: NativeMigration,
): PreparedMigrationSql {
  let text = stripOuterTransaction(migration.sql);
  const values: unknown[] = [];

  if (migration.version === "migrations/0005_contests.sql") {
    const staleIndex =
      "CREATE INDEX IF NOT EXISTS payouts_author_idx ON payouts(author_id);";
    const occurrences = text.split(staleIndex).length - 1;
    if (occurrences !== 1) {
      throw new Error(
        "0005 payouts compatibility statement did not match exactly once",
      );
    }
    text = text.replace(
      staleIndex,
      () => `DO $$ BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'payouts'
      AND column_name = 'author_id'
  ) THEN
    CREATE INDEX IF NOT EXISTS payouts_author_idx ON payouts(author_id);
  ELSIF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'payouts'
      AND column_name = 'user_id'
  ) THEN
    NULL;
  ELSE
    RAISE EXCEPTION 'unsupported payouts schema: expected author_id or canonical user_id';
  END IF;
END $$;`,
    );
  }

  if (migration.version === "migrations/0011_admin.sql") {
    const auditTableAnchor = "CREATE TABLE IF NOT EXISTS audit_log (";
    const occurrences = text.split(auditTableAnchor).length - 1;
    if (occurrences !== 1) {
      throw new Error(
        "0011 audit_log compatibility anchor did not match exactly once",
      );
    }
    text = text.replace(
      auditTableAnchor,
      () => `ALTER TABLE public.audit_log
  ADD COLUMN IF NOT EXISTS actor_email VARCHAR(255),
  ADD COLUMN IF NOT EXISTS details JSONB,
  ADD COLUMN IF NOT EXISTS ip_address VARCHAR(45);
CREATE INDEX IF NOT EXISTS audit_log_actor_email_idx ON audit_log(actor_email);

${auditTableAnchor}`,
    );
  }

  if (migration.version === "migrations/0060_tma_own_org.sql") {
    const { keyHash, keyPrefix } = nativeTestKeyValues();
    text = text.replace(
      /^(\s*):'key_hash'(\s*,\s*)$/gm,
      (_match, indent, suffix) => {
        values.push(keyHash);
        return `${indent}$${values.length}${suffix}`;
      },
    );
    text = text.replace(
      /^(\s*):'key_prefix'(\s*,?\s*)$/gm,
      (_match, indent, suffix) => {
        values.push(keyPrefix);
        return `${indent}$${values.length}${suffix}`;
      },
    );
    if (
      values.length !== 2 ||
      /:'(?:key_hash|key_prefix)'/.test(text.replace(/^\s*--.*$/gm, ""))
    ) {
      throw new Error(
        "0060 psql placeholders did not match the vetted native mapping",
      );
    }
  } else if (
    /:'[A-Za-z_][A-Za-z0-9_]*'/.test(text.replace(/^\s*--.*$/gm, ""))
  ) {
    throw new Error(`unsupported psql variable in ${migration.version}`);
  }

  return {
    text,
    values,
    effectiveChecksum: createHash("sha256").update(text).digest("hex"),
  };
}

export async function runNativeMigrations(
  client: TestDatabaseClient,
  migrations: NativeMigration[],
): Promise<{ applied: string[]; skipped: string[] }> {
  await client.query({
    text: `
      CREATE TABLE IF NOT EXISTS public.schema_migrations (
        version TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        effective_checksum TEXT,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      ALTER TABLE public.schema_migrations
        ADD COLUMN IF NOT EXISTS effective_checksum TEXT;
      UPDATE public.schema_migrations
         SET effective_checksum = checksum
       WHERE effective_checksum IS NULL;
      ALTER TABLE public.schema_migrations
        ALTER COLUMN effective_checksum SET NOT NULL
    `,
    values: [],
  });
  const preparedMigrations = new Map(
    migrations.map((migration) => [
      migration.version,
      prepareMigrationSql(migration),
    ]),
  );
  const ledger = await client.query<{
    version: string;
    checksum: string;
    effective_checksum: string;
  }>({
    text: "SELECT version, checksum, effective_checksum FROM public.schema_migrations ORDER BY version",
    values: [],
  });
  const recorded = new Map(ledger.rows.map((row) => [row.version, row]));

  for (const migration of migrations) {
    const row = recorded.get(migration.version);
    if (row && row.checksum !== migration.checksum) {
      throw new Error(`migration checksum mismatch: ${migration.version}`);
    }
    const prepared = preparedMigrations.get(migration.version)!;
    if (row && row.effective_checksum !== prepared.effectiveChecksum) {
      throw new Error(
        `migration effective checksum mismatch: ${migration.version}`,
      );
    }
  }

  const applied: string[] = [];
  const skipped: string[] = [];
  for (const migration of migrations) {
    if (recorded.has(migration.version)) {
      skipped.push(migration.version);
      continue;
    }

    const prepared = preparedMigrations.get(migration.version)!;
    await client.query({ text: "BEGIN", values: [] });
    try {
      if (prepared.values.length === 0) {
        await client.query(prepared);
      } else {
        const parameterizedStatement = prepared.text.indexOf(
          "INSERT INTO gateway_api_keys",
        );
        if (
          migration.version !== "migrations/0060_tma_own_org.sql" ||
          parameterizedStatement < 0
        ) {
          throw new Error(
            `unexpected parameterized migration: ${migration.version}`,
          );
        }
        const prefix = prepared.text.slice(0, parameterizedStatement).trim();
        const statement = prepared.text.slice(parameterizedStatement).trim();
        if (prefix) {
          await client.query({ text: prefix, values: [] });
        }
        await client.query({ text: statement, values: prepared.values });
      }
      await client.query({
        text: `
          INSERT INTO public.schema_migrations (version, checksum, effective_checksum)
          VALUES ($1, $2, $3)
        `,
        values: [
          migration.version,
          migration.checksum,
          prepared.effectiveChecksum,
        ],
      });
      await client.query({ text: "COMMIT", values: [] });
      recorded.set(migration.version, {
        version: migration.version,
        checksum: migration.checksum,
        effective_checksum: prepared.effectiveChecksum,
      });
      applied.push(migration.version);
    } catch (error) {
      await client.query({ text: "ROLLBACK", values: [] });
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`migration ${migration.version} failed: ${message}`, {
        cause: error,
      });
    }
  }

  return { applied, skipped };
}
