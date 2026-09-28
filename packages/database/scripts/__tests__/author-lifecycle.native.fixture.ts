import { expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  withGuardedTestDatabase,
  type TestDatabaseClient,
} from "../test-db-guard";
import { createPgTestClient } from "../pg-test-client";

export async function scenario(
  run: (client: TestDatabaseClient, f: ReturnType<typeof ids>) => Promise<void>,
) {
  await withGuardedTestDatabase(
    process.env,
    { clientFactory: createPgTestClient },
    async (client) => {
      const f = ids();
      await client.query({ text: "BEGIN", values: [] });
      try {
        await client.query({
          text: `INSERT INTO users(id,email,role) VALUES ($1,$2,'admin'),($3,$4,'user'),($5,$6,'user')`,
          values: [
            f.admin,
            f.admin + "@example.test",
            f.author,
            f.author + "@example.test",
            f.foreign,
            f.foreign + "@example.test",
          ],
        });
        await client.query({
          text: `INSERT INTO models(id,slug,type,enabled,status,author_user_id) VALUES ($1,$2,'chat',false,'draft',$3)`,
          values: [f.model, "native-" + f.model, f.author],
        });
        await client.query({
          text: `INSERT INTO author_model_versions(id,model_id,author_user_id,version_no,public_manifest,manifest_digest,encrypted_token_envelope,status)
        VALUES ($1,$2,$3,1,'{}'::jsonb,$4,'{"version":1,"ciphertext":"test","iv":"test","tag":"test"}'::jsonb,'candidate')`,
          values: [f.version, f.model, f.author, f.digest],
        });
        await run(client, f);
      } finally {
        await client.query({ text: "ROLLBACK", values: [] });
      }
    },
  );
}
export function ids() {
  return {
    admin: randomUUID(),
    author: randomUUID(),
    foreign: randomUUID(),
    model: randomUUID(),
    version: randomUUID(),
    claim: randomUUID(),
    digest: "sha256:" + "a".repeat(64),
    body: "sha256:" + "b".repeat(64),
  };
}
export async function call(
  client: TestDatabaseClient,
  text: string,
  values: unknown[],
) {
  return (await client.query({ text, values })).rows[0];
}
export async function denied(
  client: TestDatabaseClient,
  text: string,
  values: unknown[],
  message: RegExp,
) {
  await client.query({ text: "SAVEPOINT rejection", values: [] });
  await expect(client.query({ text, values })).rejects.toThrow(message);
  await client.query({ text: "ROLLBACK TO SAVEPOINT rejection", values: [] });
}
export const claimSql =
  "SELECT * FROM aiag_claim_author_probe($1::uuid,$2,$3::uuid,$4,$5::uuid)";
export const proposeSql =
  "SELECT * FROM aiag_propose_author_policy($1::uuid,$2,$3::uuid,$4::bigint,$5::integer,$6,$7)";
export const acceptSql =
  "SELECT * FROM aiag_accept_author_policy($1::uuid,$2,$3::uuid)";
export const approveSql =
  "SELECT * FROM aiag_approve_author_version($1::uuid,$2::uuid,$3,$4::uuid,$5::uuid)";
