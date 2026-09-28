import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { withOwnedAuthorDb } from "../../../../packages/database/scripts/__tests__/author-owned-db.native.fixture";
const actor = vi.hoisted(() => ({ id: "", role: "user" }));
vi.mock("@/auth", () => ({ auth: async () => ({ user: { id: actor.id } }) }));
vi.mock("@/lib/admin/api", () => ({
  withAdmin: async (fn: (ctx: unknown) => unknown) =>
    actor.role === "admin"
      ? fn({ user: { id: actor.id } })
      : new Response("{}", { status: 403 }),
}));
const request = (body: unknown) =>
  new NextRequest("https://app.example.test/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
describe.runIf(process.env.RUN_NATIVE_DB_INTEGRATION === "1")(
  "real author management routes and SQL",
  () => {
    it(
      "submits, probes, proposes, accepts, approves and versions without publishing unreviewed material",
      async () =>
        withOwnedAuthorDb(async (c, url) => {
          const saved = Object.fromEntries(
            ["DATABASE_URL", "AUTHOR_CHAT_ENABLED", "AUTHOR_ENDPOINT_KEK"].map(
              (k) => [k, process.env[k]],
            ),
          );
          let end: (() => Promise<void>) | undefined;
          const admin = randomUUID(),
            author = randomUUID(),
            foreign = randomUUID();
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
                foreign,
                foreign + "@example.test",
              ],
            );
            process.env.DATABASE_URL = url;
            process.env.AUTHOR_CHAT_ENABLED = "1";
            process.env.AUTHOR_ENDPOINT_KEK = "ab".repeat(32);
            const { db } = await import("../lib/db");
            end = async () => {
              await db.$client.end();
              (globalThis as unknown as { db?: unknown }).db = undefined;
            };
            const { POST: submit } =
              await import("../app/api/models/request-publish/route");
            const { POST: adminPost } =
              await import("../app/api/admin/models/[id]/author/route");
            const { POST: ownerPost } =
              await import("../app/api/author/models/[id]/route");
            actor.id = author;
            actor.role = "user";
            const input = {
              name: "Native managed model",
              slug: "author-" + randomUUID(),
              description: "Native author lifecycle through real Web routes",
              endpointUrl: "https://author.example.com/v1/chat/completions",
              authToken: "never-return-this-synthetic-token",
            };
            await query("UPDATE users SET is_banned=true WHERE id=$1", [
              author,
            ]);
            expect((await submit(request(input))).status).toBe(403);
            expect(
              (
                await query(
                  "SELECT count(*)::int AS n FROM models WHERE slug=$1",
                  [input.slug],
                )
              )[0].n,
            ).toBe(0);
            await query("UPDATE users SET is_banned=false WHERE id=$1", [
              author,
            ]);
            const submitted = await submit(request(input));
            expect(submitted.status).toBe(200);
            const model = (
              await query(
                "SELECT id::text,status,current_author_version_id FROM models WHERE slug=$1",
                [input.slug],
              )
            )[0];
            expect(model.status).toBe("draft");
            expect(model.current_author_version_id).toBeNull();
            const version = (
              await query(
                "SELECT id::text,manifest_digest,encrypted_token_envelope FROM author_model_versions WHERE model_id=$1",
                [model.id],
              )
            )[0];
            expect(
              JSON.stringify(version.encrypted_token_envelope),
            ).not.toContain(input.authToken);
            const params = {
              params: Promise.resolve({ id: String(model.id) }),
            };
            const scope = {
              versionId: version.id,
              manifestDigest: version.manifest_digest,
            };
            expect(
              (await adminPost(request({ action: "probe", ...scope }), params))
                .status,
            ).toBe(403);
            actor.id = admin;
            actor.role = "admin";
            const network =
              await import("../../../../packages/shared/src/safe-fetch");
            const transport = vi
              .spyOn(network, "safeFetch")
              .mockResolvedValue(
                Response.json({
                  object: "chat.completion",
                  choices: [
                    {
                      index: 0,
                      message: { role: "assistant", content: "healthy" },
                    },
                  ],
                }),
              );
            const probe = await adminPost(
              request({ action: "probe", ...scope }),
              params,
            );
            expect(probe.status).toBe(200);
            expect(await probe.json()).toMatchObject({ state: "succeeded" });
            expect(
              (await adminPost(request({ action: "probe", ...scope }), params))
                .status,
            ).toBe(200);
            expect(transport).toHaveBeenCalledTimes(1);
            const proposed = await adminPost(
              request({
                action: "propose",
                ...scope,
                priceMicrocredits: "1001",
                authorShareBps: 7315,
                rightsReference: "rights:document:1",
                consentReference: "consent:v1",
                availabilityDelaySeconds: 0,
              }),
              params,
            );
            expect(proposed.status).toBe(200);
            const policy = await proposed.json();
            expect(
              (
                await adminPost(
                  request({
                    action: "approve",
                    ...scope,
                    policyId: policy.id,
                    expectedCurrentVersionId: null,
                  }),
                  params,
                )
              ).status,
            ).toBe(409);
            actor.id = foreign;
            actor.role = "user";
            expect(
              (
                await ownerPost(
                  request({
                    action: "accept",
                    policyId: policy.id,
                    policyDigest: policy.policy_digest,
                  }),
                  params,
                )
              ).status,
            ).toBe(403);
            actor.id = author;
            expect(
              (
                await ownerPost(
                  request({
                    action: "accept",
                    policyId: policy.id,
                    policyDigest: policy.policy_digest,
                  }),
                  params,
                )
              ).status,
            ).toBe(200);
            actor.id = admin;
            actor.role = "admin";
            expect(
              (
                await adminPost(
                  request({
                    action: "approve",
                    ...scope,
                    policyId: policy.id,
                    expectedCurrentVersionId: null,
                  }),
                  params,
                )
              ).status,
            ).toBe(200);
            actor.id = author;
            actor.role = "user";
            const update = {
              action: "new_version",
              name: input.name,
              description: input.description + " revision2",
              endpointUrl: input.endpointUrl,
              authToken: "new-private-token",
              expectedLatestVersionNo: 1,
            };
            const updated = await ownerPost(request(update), params);
            expect(updated.status).toBe(200);
            expect(await updated.json()).toMatchObject({
              versionNo: 2,
              state: "candidate",
            });
            expect((await ownerPost(request(update), params)).status).toBe(409);
            expect(
              (
                await query(
                  "SELECT current_author_version_id::text AS current FROM models WHERE id=$1",
                  [model.id],
                )
              )[0].current,
            ).toBe(version.id);
            expect(
              (
                await query(
                  "SELECT count(*)::int AS n FROM author_model_versions WHERE model_id=$1",
                  [model.id],
                )
              )[0].n,
            ).toBe(2);
            actor.id = admin;
            actor.role = "admin";
            expect(
              (
                await adminPost(
                  request({
                    action: "status",
                    status: "frozen",
                    reason: "operator:pause",
                    expectedCurrentVersionId: version.id,
                  }),
                  params,
                )
              ).status,
            ).toBe(200);
            expect(
              (
                await adminPost(
                  request({
                    action: "status",
                    status: "live",
                    reason: "operator:resolved",
                    expectedCurrentVersionId: version.id,
                  }),
                  params,
                )
              ).status,
            ).toBe(200);
            actor.id = author;
            actor.role = "user";
            const { getAuthorModelView, getPublicAuthorModels } =
              await import("../lib/author/data");
            expect(
              await getAuthorModelView(String(model.id), foreign),
            ).toBeNull();
            const own = await getAuthorModelView(String(model.id), author);
            expect(own?.versions).toHaveLength(2);
            expect(JSON.stringify(own)).not.toContain(
              "encrypted_token_envelope",
            );
            const publicModels = await getPublicAuthorModels(input.slug);
            expect(publicModels[0].version_id).toBe(version.id);
            expect(JSON.stringify(publicModels)).not.toContain(
              input.endpointUrl,
            );
          } finally {
            vi.restoreAllMocks();
            await end?.();
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
