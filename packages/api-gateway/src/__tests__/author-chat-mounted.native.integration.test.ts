import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { withOwnedAuthorDb } from "../../../database/scripts/__tests__/author-owned-db.native.fixture";
import { parseAuthorSubmission } from "@aiag/shared/server";
import { deriveKek, encryptAesGcm } from "@aiag/upstream-adapters/byok";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const inputForVersion = (slug: string) => ({
  name: "Mounted author",
  slug,
  description: "Native author model",
  endpointUrl: "https://author.example.com/v1/chat/completions",
  authToken: "synthetic-private-author-token",
});

describe.runIf(process.env.RUN_NATIVE_DB_INTEGRATION === "1")(
  "actual mounted author chat lifecycle",
  () => {
    it(
      "runs a pinned author once through real auth/HTTP/quota/settlement and replays old version after change",
      async () =>
        withOwnedAuthorDb(async (c, url) => {
          const saved = Object.fromEntries(
            [
              "DATABASE_URL",
              "GATEWAY_HTTP_EXECUTION_MODE",
              "AUTHOR_CHAT_ENABLED",
              "AUTHOR_ENDPOINT_KEK",
            ].map((k) => [k, process.env[k]]),
          );
          let end: (() => Promise<void>) | undefined,
            disconnect: (() => void) | undefined;
          const admin = randomUUID(),
            author = randomUUID(),
            buyer = randomUUID(),
            org = randomUUID(),
            key = randomUUID(),
            model = randomUUID(),
            version = randomUUID();
          const bearer = "sk_aiag_test_" + randomUUID().replaceAll("-", ""),
            master = "ab".repeat(32);
          const candidate = parseAuthorSubmission({
            name: "Mounted author",
            slug: "author-" + model,
            description: "Native mounted author model",
            endpointUrl: "https://author.example.com/v1/chat/completions",
            authToken: "synthetic-private-author-token",
          });
          const query = async (text: string, values: unknown[] = []) =>
            (await c.query({ text, values })).rows;
          try {
            await query(
              `INSERT INTO users(id,email,role) VALUES ($1,$2,'admin'),($3,$4,'user'),($5,$6,'user')`,
              [
                admin,
                admin + "@example.test",
                author,
                author + "@example.test",
                buyer,
                buyer + "@example.test",
              ],
            );
            await query(
              `INSERT INTO organizations(id,slug,name,owner_id,payg_credits) VALUES ($1,$2,'buyer',$3,10000)`,
              [org, org, buyer],
            );
            await query(
              `INSERT INTO gateway_api_keys(id,org_id,name,key_hash,key_prefix,rpm_limit) VALUES ($1,$2,'buyer',$3,'synthetic',1000)`,
              [key, org, hash(bearer)],
            );
            await query(
              `INSERT INTO gateway_quota_org_policies(org_id,enforcement_version) VALUES ($1,2)`,
              [org],
            );
            await query(
              `INSERT INTO models(id,slug,type,enabled,status,author_user_id) VALUES ($1,$2,'chat',false,'draft',$3)`,
              [model, candidate.manifest.model.slug, author],
            );
            const envelope = encryptAesGcm(
              candidate.authToken,
              deriveKek(master, "aiag:author-endpoint:" + author + ":v1"),
            );
            await query(
              `INSERT INTO author_model_versions(id,model_id,author_user_id,version_no,public_manifest,manifest_digest,encrypted_token_envelope,status) VALUES ($1,$2,$3,1,$4::jsonb,$5,$6::jsonb,'candidate')`,
              [
                version,
                model,
                author,
                JSON.stringify(candidate.manifest),
                candidate.manifestDigest,
                JSON.stringify(envelope),
              ],
            );
            const claim = randomUUID();
            const [probe] = await query(
              "SELECT * FROM aiag_claim_author_probe($1,$2,$3,$4,$5)",
              [
                version,
                candidate.manifestDigest,
                admin,
                "sha256:" + "c".repeat(64),
                claim,
              ],
            );
            await query(
              "SELECT * FROM aiag_complete_author_probe($1,$2,$3,$4,$5)",
              [probe.id, claim, "succeeded", "sha256:" + "d".repeat(64), null],
            );
            const [policy] = await query(
              "SELECT * FROM aiag_propose_author_policy($1,$2,$3,$4,$5,$6,$7,0)",
              [
                version,
                candidate.manifestDigest,
                admin,
                1001,
                7315,
                "rights:verified",
                "consent:v1",
              ],
            );
            await query("SELECT * FROM aiag_accept_author_policy($1,$2,$3)", [
              policy.id,
              policy.policy_digest,
              author,
            ]);
            await query(
              "SELECT * FROM aiag_approve_author_version($1,$2,$3,$4,NULL)",
              [version, policy.id, candidate.manifestDigest, admin],
            );
            process.env.DATABASE_URL = url;
            process.env.GATEWAY_HTTP_EXECUTION_MODE = "stored_chat_only";
            process.env.AUTHOR_CHAT_ENABLED = "1";
            process.env.AUTHOR_ENDPOINT_KEK = master;
            const network = await import("../../../shared/src/safe-fetch");
            let release: () => void = () => {};
            let started: () => void = () => {};
            const begun = new Promise<void>((r) => {
              started = r;
            });
            const gate = new Promise<void>((r) => {
              release = r;
            });
            const transport = vi
              .spyOn(network, "safeFetch")
              .mockImplementation(async (_url, options) => {
                const body = JSON.parse(String(options?.body));
                started();
                await gate;
                return Response.json({
                  id: "owned-author-response",
                  object: "chat.completion",
                  created: 1,
                  model: body.model,
                  choices: [
                    {
                      index: 0,
                      message: { role: "assistant", content: "author answer" },
                      finish_reason: "stop",
                    },
                  ],
                  usage: {
                    prompt_tokens: 1,
                    completion_tokens: 2,
                    total_tokens: 3,
                  },
                });
              });
            const { sql } = await import("../lib/db");
            end = () => sql.end();
            const { redis } = await import("../lib/redis");
            disconnect = () => redis.disconnect();
            const { default: server } = await import("../server");
            const post = (
              id: string,
              patch: Record<string, unknown> = {},
              auth = bearer,
            ) =>
              server.fetch(
                new Request("http://localhost/v1/chat/completions", {
                  method: "POST",
                  headers: {
                    "content-type": "application/json",
                    authorization: "Bearer " + auth,
                    "idempotency-key": id,
                  },
                  body: JSON.stringify({
                    model: candidate.manifest.model.slug,
                    messages: [{ role: "user", content: "hello" }],
                    max_tokens: 8,
                    ...patch,
                  }),
                }),
              );
            expect((await post("unauth", {}, "invalid")).status).toBe(401);
            const catalog = await server.fetch(
              new Request("http://localhost/v1/models", {
                headers: { authorization: "Bearer " + bearer },
              }),
            );
            const catalogBody = await catalog.json() as {
              data: Array<{ id: string; aiag_pricing?: unknown }>;
            };
            const listed = catalogBody.data.find(
              entry => entry.id === candidate.manifest.model.slug,
            );
            expect(listed?.aiag_pricing).toMatchObject({
              unit: "request",
              price_microcredits: "1001",
              author_version_id: version,
            });
            expect((await post("stream", { stream: true })).status).toBe(501);
            const first = post("one");
            await Promise.race([
              begun,
              new Promise((_, reject) =>
                setTimeout(
                  () => reject(Error("Author provider did not start")),
                  4000,
                ),
              ),
            ]);
            const duplicate = await post("one");
            expect(duplicate.status).toBe(202);
            release();
            const response = await first;
            expect(response.status).toBe(200);
            expect(response.headers.get("x-aiag-author-version-id")).toBe(
              version,
            );
            expect(response.headers.get("x-aiag-charged-microcredits")).toBe(
              "1001",
            );
            expect(JSON.stringify(await response.json())).not.toContain(
              candidate.authToken,
            );
            expect(transport).toHaveBeenCalledTimes(1);
            await query(
              "UPDATE models SET status='frozen',enabled=false WHERE id=$1",
              [model],
            );
            const replay = await post("one");
            expect(replay.status).toBe(200);
            expect(replay.headers.get("x-aiag-author-version-id")).toBe(
              version,
            );
            expect((await post("one", { max_tokens: 9 })).status).toBe(409);
            expect((await post("two")).status).toBe(503);
            expect(transport).toHaveBeenCalledTimes(1);
            expect(
              (
                await query(
                  "SELECT payg_credits::text AS amount FROM organizations WHERE id=$1",
                  [org],
                )
              )[0],
            ).toEqual({ amount: "8999" });
            expect(
              (
                await query(
                  "SELECT count(*)::int AS n,sum(amount_microcredits)::text AS amount FROM author_credit_ledger WHERE author_user_id=$1",
                  [author],
                )
              )[0],
            ).toEqual({ n: 1, amount: "732" });
            await query(
              "UPDATE models SET status='live',enabled=true WHERE id=$1",
              [model],
            );
            const secondVersion = randomUUID(),
              secondClaim = randomUUID();
            const secondCandidate = parseAuthorSubmission({
              ...inputForVersion(candidate.manifest.model.slug),
              description:
                "A revised author model with separate commercial terms",
            });
            await query(
              `INSERT INTO author_model_versions(id,model_id,author_user_id,version_no,public_manifest,manifest_digest,encrypted_token_envelope,status) VALUES ($1,$2,$3,2,$4::jsonb,$5,$6::jsonb,'candidate')`,
              [
                secondVersion,
                model,
                author,
                JSON.stringify(secondCandidate.manifest),
                secondCandidate.manifestDigest,
                JSON.stringify(envelope),
              ],
            );
            const [secondProbe] = await query(
              "SELECT * FROM aiag_claim_author_probe($1,$2,$3,$4,$5)",
              [
                secondVersion,
                secondCandidate.manifestDigest,
                admin,
                "sha256:" + "c".repeat(64),
                secondClaim,
              ],
            );
            await query(
              "SELECT * FROM aiag_complete_author_probe($1,$2,$3,$4,$5)",
              [
                secondProbe.id,
                secondClaim,
                "succeeded",
                "sha256:" + "d".repeat(64),
                null,
              ],
            );
            const [secondPolicy] = await query(
              "SELECT * FROM aiag_propose_author_policy($1,$2,$3,$4,$5,$6,$7,0)",
              [
                secondVersion,
                secondCandidate.manifestDigest,
                admin,
                2001,
                7315,
                "rights:version2",
                "consent:v2",
              ],
            );
            await query("SELECT * FROM aiag_accept_author_policy($1,$2,$3)", [
              secondPolicy.id,
              secondPolicy.policy_digest,
              author,
            ]);
            await query(
              "SELECT * FROM aiag_approve_author_version($1,$2,$3,$4,$5)",
              [
                secondVersion,
                secondPolicy.id,
                secondCandidate.manifestDigest,
                admin,
                version,
              ],
            );
            const oldReplay = await post("one");
            expect(oldReplay.headers.get("x-aiag-author-version-id")).toBe(
              version,
            );
            expect(oldReplay.headers.get("x-aiag-charged-microcredits")).toBe(
              "1001",
            );
            const newRun = await post("version-two");
            expect(newRun.status).toBe(200);
            expect(newRun.headers.get("x-aiag-author-version-id")).toBe(
              secondVersion,
            );
            expect(newRun.headers.get("x-aiag-charged-microcredits")).toBe(
              "2001",
            );
            await query(
              "SELECT * FROM aiag_approve_author_version($1,$2,$3,$4,$5)",
              [
                version,
                policy.id,
                candidate.manifestDigest,
                admin,
                secondVersion,
              ],
            );
            const secondReplay = await post("version-two");
            expect(secondReplay.headers.get("x-aiag-author-version-id")).toBe(
              secondVersion,
            );
            expect(transport).toHaveBeenCalledTimes(2);
            const firstBilling = response.headers.get(
              "x-aiag-billing-request-id",
            )!;
            await query("SELECT * FROM aiag_refund_author_request($1,$2)", [
              firstBilling,
              admin,
            ]);
            expect(
              (await post("one")).headers.get("x-aiag-author-refund-state"),
            ).toBe("refunded");
            transport.mockRejectedValueOnce(
              new Error("simulated unknown provider outcome"),
            );
            expect((await post("unknown")).status).toBe(503);
            expect((await post("unknown")).status).toBe(202);
            const [uncertain] = await query(
              `SELECT a.billing_request_id::text,a.attempt_id::text FROM gateway_charge_admissions a JOIN gateway_http_requests h USING(billing_request_id) WHERE a.org_id=$1 AND a.state='dispatched'`,
              [org],
            );
            await query(
              "UPDATE gateway_charge_admissions SET reconcile_after=clock_timestamp()-interval '1 second' WHERE billing_request_id=$1",
              [uncertain.billing_request_id],
            );
            await query(
              "SELECT * FROM aiag_resolve_author_no_charge($1,$2,$3,$4)",
              [
                uncertain.billing_request_id,
                uncertain.attempt_id,
                admin,
                "provider:verified-absent",
              ],
            );
            const noCharge = await post("unknown");
            expect(noCharge.status).toBe(503);
            expect(noCharge.headers.get("x-aiag-charged-microcredits")).toBe(
              "0",
            );
            expect(await noCharge.json()).toMatchObject({
              error: { code: "AUTHOR_NO_RESULT" },
            });
            expect((await post("unknown", { max_tokens: 9 })).status).toBe(409);
            expect(transport).toHaveBeenCalledTimes(3);
            expect(
              (
                await query(
                  "SELECT payg_credits::text AS amount FROM organizations WHERE id=$1",
                  [org],
                )
              )[0],
            ).toEqual({ amount: "7999" });
            expect(
              (
                await query(
                  "SELECT sum(amount_microcredits)::text AS amount FROM author_credit_ledger WHERE author_user_id=$1",
                  [author],
                )
              )[0],
            ).toEqual({ amount: "1463" });
            await query(
              "UPDATE gateway_api_keys SET revoked_at=now() WHERE id=$1",
              [key],
            );
            expect((await post("one")).status).toBe(401);
          } finally {
            vi.restoreAllMocks();
            await end?.();
            disconnect?.();
            for (const [k, v] of Object.entries(saved)) {
              if (v === undefined) delete process.env[k];
              else process.env[k] = v;
            }
          }
        }),
      120000,
    );
  },
);
