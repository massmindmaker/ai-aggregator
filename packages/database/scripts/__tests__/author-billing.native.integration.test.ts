import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { TestDatabaseClient } from "../test-db-guard";
import {
  scenario,
  call,
  denied,
  claimSql,
  acceptSql,
  approveSql,
} from "./author-lifecycle.native.fixture";
const q = (c: TestDatabaseClient, text: string, values: unknown[] = []) =>
  c.query({ text, values });
async function prepare(
  c: TestDatabaseClient,
  f: Parameters<Parameters<typeof scenario>[0]>[1],
  price = "1001",
  share = 7315,
) {
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
  const policy = await call(
    c,
    "SELECT * FROM aiag_propose_author_policy($1::uuid,$2,$3::uuid,$4::bigint,$5::integer,$6,$7,0)",
    [f.version, f.digest, f.admin, price, share, "license-doc:1", "terms:v1"],
  );
  await call(c, acceptSql, [policy.id, policy.policy_digest, f.author]);
  await call(c, approveSql, [f.version, policy.id, f.digest, f.admin, null]);
  const org = randomUUID(),
    key = randomUUID(),
    billing = randomUUID(),
    attempt = randomUUID(),
    fingerprint = "e".repeat(64),
    keyDigest = "f".repeat(64),
    slug = "native-" + f.model;
  await q(
    c,
    `INSERT INTO organizations(id,slug,name,owner_id,payg_credits) VALUES ($1,$2,'buyer',$3,$4::bigint)`,
    [org, org, f.foreign, (BigInt(price) * 3n).toString()],
  );
  await q(
    c,
    `INSERT INTO gateway_api_keys(id,org_id,name,key_hash,key_prefix) VALUES ($1,$2,'buyer',$3,'synthetic')`,
    [key, org, key],
  );
  await q(
    c,
    `INSERT INTO gateway_quota_org_policies(org_id,enforcement_version) VALUES ($1,2)`,
    [org],
  );
  await q(
    c,
    `SELECT * FROM aiag_claim_gateway_http_request_v1($1::uuid,$2::uuid,$3::uuid,'chat'::varchar,'stored'::varchar,$4,$5,1::smallint)`,
    [org, key, billing, keyDigest, fingerprint],
  );
  const bound = await call(
    c,
    `SELECT * FROM aiag_bind_author_request($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6)`,
    [org, key, billing, f.version, policy.id, fingerprint],
  );
  const quote = bound.author_quote;
  const deadline = new Date(Date.now() + 120000).toISOString();
  await q(
    c,
    `SELECT * FROM aiag_admit_gateway_charge_v2($1::uuid,$2::uuid,$3::uuid,'trace','chat','stored',$4,$5::bigint,$6::jsonb,$7::timestamptz,NULL,$8::jsonb)`,
    [
      org,
      billing,
      key,
      slug,
      price,
      JSON.stringify({ version: 1, authorQuote: quote }),
      deadline,
      JSON.stringify({
        version: 2,
        formulaVersion: "author-share-usd-micro-v1",
        authorQuote: quote,
      }),
    ],
  );
  return {
    ...f,
    org,
    key,
    billing,
    attempt,
    quote,
    price,
    policyId: policy.id,
    slug,
    fingerprint,
    keyDigest,
    share,
  };
}
async function outcome(
  c: TestDatabaseClient,
  f: Awaited<ReturnType<typeof prepare>>,
) {
  const upstream = "author:" + f.version;
  await q(
    c,
    "SELECT * FROM aiag_mark_gateway_charge_dispatched($1::uuid,$2::uuid,$3::uuid,$4,$5::jsonb)",
    [f.org, f.billing, f.attempt, upstream, JSON.stringify(f.quote)],
  );
  const response = {
    id: "author-result",
    object: "chat.completion",
    created: 1,
    model: f.slug,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "author answer" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  };
  const usage = {
    version: 1,
    formulaVersion: "author-fixed-microcredits-v1",
    billingRequestId: f.billing,
    attemptId: f.attempt,
    upstreamId: upstream,
    verified: true,
    responseDigest: "sha256:" + "a".repeat(64),
    completionId: response.id,
    reportedModel: response.model,
    usage: {
      promptTokens: 1,
      completionTokens: 2,
      totalTokens: 3,
      cachedInputTokens: 0,
    },
  };
  await q(
    c,
    `SELECT * FROM aiag_record_gateway_http_outcome_v1($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::bigint,$7::jsonb,'success',$8::jsonb,1::smallint)`,
    [
      f.org,
      f.key,
      f.billing,
      f.keyDigest,
      f.fingerprint,
      f.price,
      JSON.stringify(usage),
      JSON.stringify(response),
    ],
  );
}
const settle = (
  c: TestDatabaseClient,
  f: Awaited<ReturnType<typeof prepare>>,
) =>
  q(c, "SELECT * FROM aiag_settle_admitted_gateway_charge($1::uuid,$2::uuid)", [
    f.org,
    f.billing,
  ]);

describe.runIf(process.env.RUN_NATIVE_DB_INTEGRATION === "1")(
  "author paid lifecycle through existing gateway authority",
  () => {
    it("pins approved price/version, enforces quotas and accrues once even after model freeze", async () =>
      scenario(async (c, base) => {
        const f = await prepare(c, base);
        await outcome(c, f);
        await q(
          c,
          "UPDATE models SET status='frozen',enabled=false WHERE id=$1",
          [f.model],
        );
        await settle(c, f);
        await settle(c, f);
        expect(
          await call(
            c,
            "SELECT sum(amount_microcredits)::text AS amount,count(*)::int AS n FROM author_credit_ledger WHERE billing_request_id=$1",
            [f.billing],
          ),
        ).toEqual({ amount: "732", n: 1 });
        expect(
          await call(
            c,
            "SELECT payg_credits::text AS balance FROM organizations WHERE id=$1",
            [f.org],
          ),
        ).toEqual({ balance: "2002" });
        expect(
          await call(
            c,
            "SELECT supplier_actual_usd_micro::text AS supplier FROM gateway_charge_quota_contexts WHERE billing_request_id=$1",
            [f.billing],
          ),
        ).toEqual({ supplier: "7320" });
      }));
    it("rejects an unbound author hold and a new admission after a freeze", async () =>
      scenario(async (c, base) => {
        const f = await prepare(c, base),
          next = randomUUID();
        await q(
          c,
          `SELECT * FROM aiag_claim_gateway_http_request_v1($1::uuid,$2::uuid,$3::uuid,'chat'::varchar,'stored'::varchar,$4,$5,1::smallint)`,
          [f.org, f.key, next, "d".repeat(64), f.fingerprint],
        );
        const admit = `SELECT * FROM aiag_admit_gateway_charge_v2($1::uuid,$2::uuid,$3::uuid,'trace','chat','stored',$4,$5::bigint,$6::jsonb,$7::timestamptz,NULL,$8::jsonb)`;
        const values = [
          f.org,
          next,
          f.key,
          f.slug,
          f.price,
          JSON.stringify({ version: 1, authorQuote: f.quote }),
          new Date(Date.now() + 60000).toISOString(),
          JSON.stringify({
            version: 2,
            formulaVersion: "author-share-usd-micro-v1",
            authorQuote: f.quote,
          }),
        ];
        await denied(c, admit, values, /AUTHOR_REQUEST_CONFLICT/);
        await q(
          c,
          "SELECT * FROM aiag_bind_author_request($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6)",
          [f.org, f.key, next, f.version, f.policyId, f.fingerprint],
        );
        await q(
          c,
          "UPDATE models SET status='frozen',enabled=false WHERE id=$1",
          [f.model],
        );
        await denied(c, admit, values, /AUTHOR_VERSION_UNAVAILABLE/);
        expect(
          await call(
            c,
            "SELECT payg_credits::text AS balance FROM organizations WHERE id=$1",
            [f.org],
          ),
        ).toEqual({ balance: "2002" });
        expect(
          await call(
            c,
            "SELECT count(*)::int AS n FROM gateway_charge_admissions WHERE org_id=$1",
            [f.org],
          ),
        ).toEqual({ n: 1 });
      }));
    it("keeps values above2^53 exact and reverses full charge and author credit exactly once", async () =>
      scenario(async (c, base) => {
        const f = await prepare(c, base, "9007199254740993", 3317);
        await outcome(c, f);
        await settle(c, f);
        const share = ((BigInt(f.price) * 3317n) / 10000n).toString();
        expect(
          await call(
            c,
            "SELECT amount_microcredits::text AS amount FROM author_credit_ledger WHERE billing_request_id=$1",
            [f.billing],
          ),
        ).toEqual({ amount: share });
        const query =
          "SELECT * FROM aiag_refund_author_request($1::uuid,$2::uuid)";
        await call(c, query, [f.billing, f.admin]);
        await call(c, query, [f.billing, f.admin]);
        expect(
          await call(
            c,
            "SELECT sum(amount_microcredits)::text AS amount,count(*)::int AS n FROM author_credit_ledger WHERE billing_request_id=$1",
            [f.billing],
          ),
        ).toEqual({ amount: "0", n: 2 });
        expect(
          await call(
            c,
            "SELECT payg_credits::text AS balance FROM organizations WHERE id=$1",
            [f.org],
          ),
        ).toEqual({ balance: (BigInt(f.price) * 3n).toString() });
      }));
    it("rolls settlement back if author accrual cannot be persisted, then recovers without dispatch", async () =>
      scenario(async (c, base) => {
        const f = await prepare(c, base);
        await outcome(c, f);
        await q(
          c,
          `CREATE FUNCTION pg_temp.reject_author_credit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic author failure'; END $$`,
        );
        await q(
          c,
          "CREATE TRIGGER author_test_reject BEFORE INSERT ON author_credit_ledger FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_author_credit()",
        );
        await denied(
          c,
          "SELECT * FROM aiag_settle_admitted_gateway_charge($1::uuid,$2::uuid)",
          [f.org, f.billing],
          /synthetic author failure/,
        );
        expect(
          await call(
            c,
            "SELECT state FROM gateway_charge_admissions WHERE billing_request_id=$1",
            [f.billing],
          ),
        ).toEqual({ state: "outcome_recorded" });
        await q(c, "DROP TRIGGER author_test_reject ON author_credit_ledger");
        await settle(c, f);
        expect(
          await call(
            c,
            "SELECT count(*)::int AS n FROM author_credit_ledger WHERE billing_request_id=$1",
            [f.billing],
          ),
        ).toEqual({ n: 1 });
      }));
    it("reserves a mock payout once, never redispatches unknown and retains refund debt", async () =>
      scenario(async (c, base) => {
        const f = await prepare(c, base);
        await outcome(c, f);
        await settle(c, f);
        const claim = randomUUID(),
          key = "c".repeat(64);
        const text =
          "SELECT * FROM aiag_claim_author_mock_payout($1::uuid,$2,$3,$4::bigint,$5::uuid)";
        const payout = await call(c, text, [
          f.author,
          key,
          "mock:wallet",
          732,
          claim,
        ]);
        expect(payout.did_claim).toBe(true);
        await call(
          c,
          "SELECT * FROM aiag_complete_author_mock_payout($1::uuid,$2::uuid,$3)",
          [payout.id, claim, "unknown"],
        );
        expect(
          await call(c, text, [
            f.author,
            key,
            "mock:wallet",
            732,
            randomUUID(),
          ]),
        ).toMatchObject({ id: payout.id, did_claim: false, state: "unknown" });
        await denied(
          c,
          text,
          [f.author, "d".repeat(64), "mock:wallet", 1, randomUUID()],
          /AUTHOR_PAYOUT_BALANCE/,
        );
        await call(
          c,
          "SELECT * FROM aiag_complete_author_mock_payout($1::uuid,$2::uuid,$3)",
          [payout.id, claim, "paid"],
        );
        await call(
          c,
          "SELECT * FROM aiag_refund_author_request($1::uuid,$2::uuid)",
          [f.billing, f.admin],
        );
        expect(
          await call(c, "SELECT * FROM aiag_author_credit_balance($1::uuid)", [
            f.author,
          ]),
        ).toMatchObject({
          available_microcredits: "-732",
          paid_microcredits: "732",
        });
      }));
    it("requires elapsed reconciliation and recorded operator evidence before a no-charge release", async () =>
      scenario(async (c, base) => {
        const f = await prepare(c, base);
        await q(
          c,
          "SELECT * FROM aiag_mark_gateway_charge_dispatched($1::uuid,$2::uuid,$3::uuid,$4,$5::jsonb)",
          [
            f.org,
            f.billing,
            f.attempt,
            "author:" + f.version,
            JSON.stringify(f.quote),
          ],
        );
        const op =
          "SELECT * FROM aiag_resolve_author_no_charge($1::uuid,$2::uuid,$3::uuid,$4)";
        await denied(
          c,
          op,
          [f.billing, f.attempt, f.foreign, "provider:confirmed-no-result"],
          /AUTHOR_ADMIN_REQUIRED/,
        );
        await denied(
          c,
          op,
          [f.billing, f.attempt, f.admin, "provider:confirmed-no-result"],
          /AUTHOR_RECONCILIATION_NOT_DUE/,
        );
        await q(
          c,
          "UPDATE gateway_charge_admissions SET reconcile_after=clock_timestamp()-interval '1 second' WHERE billing_request_id=$1",
          [f.billing],
        );
        const resolved = await call(c, op, [
          f.billing,
          f.attempt,
          f.admin,
          "provider:confirmed-no-result",
        ]);
        expect(resolved).toMatchObject({
          state: "settled",
          actual_cost_credits: "0",
        });
        expect(
          await call(c, op, [
            f.billing,
            f.attempt,
            f.admin,
            "provider:confirmed-no-result",
          ]),
        ).toMatchObject({ state: "settled", actual_cost_credits: "0" });
        await denied(
          c,
          op,
          [f.billing, f.attempt, f.admin, "different-proof"],
          /AUTHOR_RECONCILIATION_CONFLICT/,
        );
        expect(
          await call(
            c,
            "SELECT payg_credits::text AS balance FROM organizations WHERE id=$1",
            [f.org],
          ),
        ).toEqual({ balance: "3003" });
        expect(
          await call(
            c,
            "SELECT count(*)::int AS n FROM author_credit_ledger WHERE billing_request_id=$1",
            [f.billing],
          ),
        ).toEqual({ n: 0 });
        expect(
          await call(
            c,
            "SELECT count(*)::int AS n FROM author_operator_resolutions WHERE billing_request_id=$1",
            [f.billing],
          ),
        ).toEqual({ n: 1 });
      }));
    it("disputes block author withdrawal and saved success can be settled by an operator after key revoke", async () =>
      scenario(async (c, base) => {
        const f = await prepare(c, base);
        await outcome(c, f);
        await q(
          c,
          "UPDATE gateway_api_keys SET revoked_at=clock_timestamp() WHERE id=$1",
          [f.key],
        );
        const recover =
          "SELECT * FROM aiag_recover_author_settlement($1::uuid,$2::uuid)";
        await denied(
          c,
          recover,
          [f.billing, f.foreign],
          /AUTHOR_ADMIN_REQUIRED/,
        );
        expect(await call(c, recover, [f.billing, f.admin])).toMatchObject({
          state: "settled",
        });
        expect(await call(c, recover, [f.billing, f.admin])).toMatchObject({
          state: "settled",
        });
        const dispute =
          "SELECT * FROM aiag_set_author_dispute($1::uuid,$2::uuid,$3,$4)";
        await call(c, dispute, [
          f.billing,
          f.admin,
          true,
          "case:author-output-dispute",
        ]);
        expect(
          await call(c, "SELECT * FROM aiag_author_credit_balance($1::uuid)", [
            f.author,
          ]),
        ).toMatchObject({
          available_microcredits: "0",
          pending_microcredits: "732",
        });
        await denied(
          c,
          "SELECT * FROM aiag_claim_author_mock_payout($1::uuid,$2,$3,$4::bigint,$5::uuid)",
          [f.author, "7".repeat(64), "mock:wallet", 1, randomUUID()],
          /AUTHOR_PAYOUT_BALANCE/,
        );
        await call(c, dispute, [f.billing, f.admin, false, "case:resolved"]);
        expect(
          await call(c, "SELECT * FROM aiag_author_credit_balance($1::uuid)", [
            f.author,
          ]),
        ).toMatchObject({
          available_microcredits: "732",
          pending_microcredits: "0",
        });
      }));
  },
);
