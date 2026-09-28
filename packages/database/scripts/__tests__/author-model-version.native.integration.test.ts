import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { withGuardedTestDatabase } from "../test-db-guard";
import { createPgTestClient } from "../pg-test-client";
import {
  discoverNativeMigrations,
  runNativeMigrations,
} from "../native-migrate";

describe.runIf(process.env.RUN_NATIVE_DB_INTEGRATION === "1")(
  "author version migration native",
  () => {
    it("applies cleanly, preserves immutable content and rejects a foreign current pointer", async () => {
      await withGuardedTestDatabase(
        process.env,
        { clientFactory: createPgTestClient },
        async (canonical) => {
          const fixtureName = "aiag_author_" + randomUUID().replaceAll("-", "");
          if (!/^aiag_author_[a-f0-9]{32}$/.test(fixtureName))
            throw new Error("Invalid fixture name");
          const quotedName = '"' + fixtureName + '"';
          const before = await canonical.query<{ oid: string }>({
            text: "SELECT oid::text AS oid FROM pg_database WHERE datname=$1",
            values: [fixtureName],
          });
          expect(before.rows).toHaveLength(0);
          const fixtureUrl = new URL(process.env.TEST_DATABASE_URL!);
          fixtureUrl.pathname = "/" + fixtureName;
          let ownedOid: string | undefined;
          let fixture:
            | Awaited<ReturnType<typeof createPgTestClient>>
            | undefined;
          try {
            await canonical.query({
              text: "CREATE DATABASE " + quotedName + " TEMPLATE template0",
              values: [],
            });
            const created = await canonical.query<{ oid: string }>({
              text: "SELECT oid::text AS oid FROM pg_database WHERE datname=$1",
              values: [fixtureName],
            });
            ownedOid = created.rows[0]?.oid;
            if (!ownedOid)
              throw new Error("Fixture database missing after CREATE");
            fixture = await createPgTestClient(fixtureUrl.href);
            await fixture.connect();
            const identity = await fixture.query<{
              database_name: string;
              port: number;
            }>({
              text: "SELECT current_database() AS database_name, inet_server_port() AS port",
              values: [],
            });
            expect(identity.rows[0]).toEqual({
              database_name: fixtureName,
              port: 15432,
            });
            const migrations = await discoverNativeMigrations();
            expect(migrations).toHaveLength(90);
            expect(migrations.at(-1)?.filename).toBe(
              "0090_author_operator_reconciliation.sql",
            );
            const first = await runNativeMigrations(fixture, migrations);
            expect(first.applied).toHaveLength(migrations.length);
            expect(first.skipped).toHaveLength(0);
            const replay = await runNativeMigrations(fixture, migrations);
            expect(replay.applied).toHaveLength(0);
            expect(replay.skipped).toHaveLength(migrations.length);

            const authorId = randomUUID();
            const modelId = randomUUID();
            const otherModelId = randomUUID();
            await fixture.query({
              text: "INSERT INTO users(id,email) VALUES ($1::uuid,$2)",
              values: [authorId, "author-" + authorId + "@example.test"],
            });
            await fixture.query({
              text: `INSERT INTO models(id,slug,type,enabled,status,author_user_id)
                   VALUES ($1::uuid,$2,'chat',false,'draft',$3::uuid),
                          ($4::uuid,$5,'chat',false,'draft',$3::uuid)`,
              values: [
                modelId,
                "author-" + modelId,
                authorId,
                otherModelId,
                "other-" + otherModelId,
              ],
            });
            const versionId = randomUUID();
            const manifest = {
              schemaVersion: 1,
              adapter: "openai_chat_https_v1",
              endpoint: {
                url: "https://author.example.com/v1/chat/completions",
              },
            };
            const encrypted = {
              version: 1,
              ciphertext: "test",
              iv: "test",
              tag: "test",
            };
            await fixture.query({
              text: `INSERT INTO author_model_versions
                     (id,model_id,author_user_id,version_no,public_manifest,manifest_digest,
                      encrypted_token_envelope,status)
                   VALUES ($1::uuid,$2::uuid,$3::uuid,1,$4::jsonb,$5,$6::jsonb,'candidate')`,
              values: [
                versionId,
                modelId,
                authorId,
                JSON.stringify(manifest),
                "sha256:" + "a".repeat(64),
                JSON.stringify(encrypted),
              ],
            });
            await expect(
              fixture.query({
                text: `INSERT INTO author_model_versions
                     (model_id,author_user_id,version_no,public_manifest,manifest_digest,
                      encrypted_token_envelope,status)
                   VALUES ($1::uuid,$2::uuid,1,$3::jsonb,$4,$5::jsonb,'candidate')`,
                values: [
                  modelId,
                  authorId,
                  JSON.stringify(manifest),
                  "sha256:" + "a".repeat(64),
                  JSON.stringify(encrypted),
                ],
              }),
            ).rejects.toThrow(/duplicate key/i);
            await expect(
              fixture.query({
                text: `INSERT INTO author_model_versions
                     (model_id,author_user_id,version_no,public_manifest,manifest_digest,
                      encrypted_token_envelope,status)
                   VALUES ($1::uuid,$2::uuid,2,$3::jsonb,$4,$5::jsonb,'candidate')`,
                values: [
                  modelId,
                  authorId,
                  JSON.stringify(manifest),
                  "sha256:" + "a".repeat(64),
                  JSON.stringify({ auth_token: "raw" }),
                ],
              }),
            ).rejects.toThrow(/check constraint/i);
            await expect(
              fixture.query({
                text: "UPDATE author_model_versions SET public_manifest='{}'::jsonb WHERE id=$1::uuid",
                values: [versionId],
              }),
            ).rejects.toThrow(/immutable/);
            await expect(
              fixture.query({
                text: "UPDATE author_model_versions SET encrypted_token_envelope='{}'::jsonb WHERE id=$1::uuid",
                values: [versionId],
              }),
            ).rejects.toThrow(/immutable/);
            await expect(
              fixture.query({
                text: "UPDATE models SET current_author_version_id=$1::uuid WHERE id=$2::uuid",
                values: [versionId, otherModelId],
              }),
            ).rejects.toThrow(/foreign key/i);
            await fixture.query({
              text: "UPDATE models SET current_author_version_id=$1::uuid WHERE id=$2::uuid",
              values: [versionId, modelId],
            });
            await fixture.query({
              text: "UPDATE author_model_versions SET status='approved' WHERE id=$1::uuid",
              values: [versionId],
            });
            const current = await fixture.query<{
              current_author_version_id: string;
              status: string;
            }>({
              text: `SELECT m.current_author_version_id::text AS current_author_version_id,
                          v.status FROM models m JOIN author_model_versions v
                            ON v.id=m.current_author_version_id WHERE m.id=$1::uuid`,
              values: [modelId],
            });
            expect(current.rows[0]).toEqual({
              current_author_version_id: versionId,
              status: "approved",
            });
            const ledger = await fixture.query<{ count: string }>({
              text: "SELECT count(*)::text AS count FROM author_earnings",
              values: [],
            });
            expect(ledger.rows[0]?.count).toBe("0");
          } finally {
            await fixture?.end();
            if (ownedOid) {
              const current = await canonical.query<{ oid: string }>({
                text: "SELECT oid::text AS oid FROM pg_database WHERE datname=$1",
                values: [fixtureName],
              });
              if (current.rows[0]?.oid !== ownedOid)
                throw new Error("Fixture ownership changed before cleanup");
              await canonical.query({
                text: "DROP DATABASE " + quotedName + " WITH (FORCE)",
                values: [],
              });
              const after = await canonical.query<{ oid: string }>({
                text: "SELECT oid::text AS oid FROM pg_database WHERE datname=$1",
                values: [fixtureName],
              });
              expect(after.rows).toHaveLength(0);
            }
          }
        },
      );
    }, 120_000);
  },
);
