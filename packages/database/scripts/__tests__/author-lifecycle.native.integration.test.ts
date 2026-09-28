import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  scenario,
  call,
  denied,
  claimSql,
  proposeSql,
  acceptSql,
  approveSql,
} from "./author-lifecycle.native.fixture";
import { withGuardedTestDatabase } from "../test-db-guard";
import { createPgTestClient } from "../pg-test-client";

describe.runIf(process.env.RUN_NATIVE_DB_INTEGRATION === "1")(
  "author durable lifecycle native",
  () => {
    it("installs owned probe and versioned terms rather than activating a bare candidate", async () => {
      await withGuardedTestDatabase(
        process.env,
        { clientFactory: createPgTestClient },
        async (client) => {
          const result = await client.query({
            text: `SELECT to_regclass('author_probe_operations')::text AS probe,
        to_regclass('author_price_policies')::text AS policy`,
            values: [],
          });
          expect(result.rows[0]).toEqual({
            probe: "author_probe_operations",
            policy: "author_price_policies",
          });
        },
      );
    });
  },
);

describe.runIf(process.env.RUN_NATIVE_DB_INTEGRATION === "1")(
  "author probe and moderation ownership",
  () => {
    it("authorizes the moderator and expected version before creating any probe", async () =>
      scenario(async (c, f) => {
        await denied(
          c,
          claimSql,
          [f.version, f.digest, f.foreign, f.body, f.claim],
          /AUTHOR_ADMIN_REQUIRED/,
        );
        await denied(
          c,
          claimSql,
          [f.version, "sha256:" + "c".repeat(64), f.admin, f.body, f.claim],
          /AUTHOR_VERSION_CONFLICT/,
        );
        expect(
          await call(
            c,
            "SELECT count(*)::int AS n FROM author_probe_operations WHERE version_id=$1",
            [f.version],
          ),
        ).toEqual({ n: 0 });
      }));
    it("persists one dispatch identity and never grants a second attempt after unknown outcome", async () =>
      scenario(async (c, f) => {
        const first = await call(c, claimSql, [
          f.version,
          f.digest,
          f.admin,
          f.body,
          f.claim,
        ]);
        expect(first).toMatchObject({ state: "dispatching", did_claim: true });
        const duplicate = await call(c, claimSql, [
          f.version,
          f.digest,
          f.admin,
          f.body,
          randomUUID(),
        ]);
        expect(duplicate).toMatchObject({
          id: first.id,
          state: "dispatching",
          did_claim: false,
        });
        await denied(
          c,
          "SELECT * FROM aiag_complete_author_probe($1::uuid,$2::uuid,$3,$4,$5)",
          [
            first.id,
            randomUUID(),
            "succeeded",
            "sha256:" + "d".repeat(64),
            null,
          ],
          /AUTHOR_PROBE_CONFLICT/,
        );
        await call(
          c,
          "SELECT * FROM aiag_complete_author_probe($1::uuid,$2::uuid,$3,$4,$5)",
          [first.id, f.claim, "unknown", null, "ENDPOINT_UNAVAILABLE"],
        );
        expect(
          await call(c, claimSql, [
            f.version,
            f.digest,
            f.admin,
            f.body,
            randomUUID(),
          ]),
        ).toMatchObject({ id: first.id, state: "unknown", did_claim: false });
        expect(
          await call(
            c,
            "SELECT count(*)::int AS n FROM author_probe_operations WHERE version_id=$1",
            [f.version],
          ),
        ).toEqual({ n: 1 });
      }));
    it("requires confirmed probe, exact author acceptance and immutable commercial terms", async () =>
      scenario(async (c, f) => {
        const policy = await call(c, proposeSql, [
          f.version,
          f.digest,
          f.admin,
          "1001",
          7315,
          "license-document:123",
          "author-terms:v1",
        ]);
        await denied(
          c,
          acceptSql,
          [policy.id, policy.policy_digest, f.foreign],
          /AUTHOR_OWNER_REQUIRED/,
        );
        await denied(
          c,
          "UPDATE models SET status='live',enabled=true WHERE id=$1",
          [f.model],
          /AUTHOR_APPROVAL_NOT_READY/,
        );
        await denied(
          c,
          approveSql,
          [f.version, policy.id, f.digest, f.admin, null],
          /AUTHOR_APPROVAL_NOT_READY/,
        );
        await call(c, acceptSql, [policy.id, policy.policy_digest, f.author]);
        await denied(
          c,
          approveSql,
          [f.version, policy.id, f.digest, f.admin, null],
          /AUTHOR_APPROVAL_NOT_READY/,
        );
        const probe = await call(c, claimSql, [
          f.version,
          f.digest,
          f.admin,
          f.body,
          f.claim,
        ]);
        await call(
          c,
          "SELECT * FROM aiag_complete_author_probe($1::uuid,$2::uuid,$3,$4,$5)",
          [probe.id, f.claim, "succeeded", "sha256:" + "d".repeat(64), null],
        );
        await denied(
          c,
          `UPDATE author_price_policies SET price_microcredits=1 WHERE id=$1`,
          [policy.id],
          /AUTHOR_POLICY_IMMUTABLE/,
        );
        expect(
          await call(c, approveSql, [
            f.version,
            policy.id,
            f.digest,
            f.admin,
            null,
          ]),
        ).toMatchObject({ version_id: f.version, policy_id: policy.id });
        expect(
          await call(
            c,
            "SELECT current_author_version_id,status,enabled FROM models WHERE id=$1",
            [f.model],
          ),
        ).toEqual({
          current_author_version_id: f.version,
          status: "live",
          enabled: true,
        });
        expect(
          await call(c, approveSql, [
            f.version,
            policy.id,
            f.digest,
            f.admin,
            f.version,
          ]),
        ).toMatchObject({ version_id: f.version, policy_id: policy.id });
      }));
    it("rejects mutable price proposal and self-approval without author or money changes", async () =>
      scenario(async (c, f) => {
        const ledgerSnapshot = () => c.query({
          text: "SELECT id::text,org_id::text,request_id,type,source,delta::text FROM gateway_transactions ORDER BY id",
          values: [],
        });
        const before = (await ledgerSnapshot()).rows;
        await denied(
          c,
          proposeSql,
          [f.version, f.digest, f.admin, "0", 7000, "license", "terms"],
          /AUTHOR_POLICY_INVALID/,
        );
        const policy = await call(c, proposeSql, [
          f.version,
          f.digest,
          f.admin,
          "922337203685477",
          "9999",
          "license",
          "terms",
        ]);
        await denied(
          c,
          proposeSql,
          [f.version, f.digest, f.admin, "2", 7000, "license", "terms"],
          /AUTHOR_POLICY_CONFLICT/,
        );
        await denied(
          c,
          approveSql,
          [f.version, policy.id, f.digest, f.author, null],
          /AUTHOR_ADMIN_REQUIRED/,
        );
        expect((await ledgerSnapshot()).rows).toEqual(before);
      }));
    it("requires explicit operator review before probing a new version after an unknown old attempt", async () =>
      scenario(async (c, f) => {
        const old = await call(c, claimSql, [
          f.version,
          f.digest,
          f.admin,
          f.body,
          f.claim,
        ]);
        await call(
          c,
          "SELECT * FROM aiag_complete_author_probe($1::uuid,$2::uuid,$3,$4,$5)",
          [old.id, f.claim, "unknown", null, "ENDPOINT_UNAVAILABLE"],
        );
        const next = randomUUID();
        await c.query({
          text: `INSERT INTO author_model_versions(id,model_id,author_user_id,version_no,public_manifest,manifest_digest,encrypted_token_envelope,status)
      SELECT $1,model_id,author_user_id,2,public_manifest,manifest_digest,encrypted_token_envelope,'candidate' FROM author_model_versions WHERE id=$2`,
          values: [next, f.version],
        });
        await denied(
          c,
          claimSql,
          [next, f.digest, f.admin, f.body, randomUUID()],
          /AUTHOR_PROBE_REVIEW_REQUIRED/,
        );
        await denied(
          c,
          "SELECT * FROM aiag_review_author_probe($1::uuid,$2::uuid,$3)",
          [old.id, f.foreign, "case:reviewed"],
          /AUTHOR_ADMIN_REQUIRED/,
        );
        await call(
          c,
          "SELECT * FROM aiag_review_author_probe($1::uuid,$2::uuid,$3)",
          [old.id, f.admin, "case:reviewed"],
        );
        expect(
          await call(c, claimSql, [
            next,
            f.digest,
            f.admin,
            f.body,
            randomUUID(),
          ]),
        ).toMatchObject({ state: "dispatching", did_claim: true });
        expect(
          await call(
            c,
            "SELECT state FROM author_probe_operations WHERE id=$1",
            [old.id],
          ),
        ).toEqual({ state: "unknown" });
      }));
  },
);
