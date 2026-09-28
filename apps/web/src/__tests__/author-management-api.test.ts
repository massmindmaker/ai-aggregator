import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  admin: true,
  user: true,
  probe: vi.fn(),
  propose: vi.fn(),
  approve: vi.fn(),
  accept: vi.fn(),
  version: vi.fn(),
  payout: vi.fn(),
}));
vi.mock("@/lib/admin/api", () => ({
  withAdmin: async (fn: (ctx: unknown) => unknown) =>
    m.admin
      ? fn({ user: { id: "00000000-0000-4000-8000-000000000099" } })
      : new Response("{}", { status: 403 }),
}));
vi.mock("@/auth", () => ({
  auth: async () =>
    m.user ? { user: { id: "00000000-0000-4000-8000-000000000088" } } : null,
}));
vi.mock("@/lib/author/service", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  probeAuthorVersion: m.probe,
  proposeAuthorPolicy: m.propose,
  approveAuthorVersion: m.approve,
  acceptAuthorPolicy: m.accept,
  submitAuthorVersion: m.version,
  requestMockAuthorPayout: m.payout,
}));
vi.mock("@/lib/db", () => ({
  db: {
    execute: async () => ({
      rows: [{ id: "00000000-0000-4000-8000-000000000088" }],
    }),
  },
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings,
    values,
  }),
}));
import { POST as adminPost } from "../app/api/admin/models/[id]/author/route";
import { POST as ownerPost } from "../app/api/author/models/[id]/route";
import { POST as payoutPost } from "../app/api/author/payouts/mock/route";
const id = "00000000-0000-4000-8000-000000000001",
  versionId = "00000000-0000-4000-8000-000000000002",
  manifestDigest = "sha256:" + "a".repeat(64);
const params = { params: Promise.resolve({ id }) };
function req(body: unknown) {
  return new Request("https://app.example.test/api", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "owned-payout-key",
    },
    body: JSON.stringify(body),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  m.admin = true;
  m.user = true;
  m.probe.mockResolvedValue({ operationId: id, state: "succeeded" });
  m.propose.mockResolvedValue({ id });
  m.accept.mockResolvedValue({ id });
  m.payout.mockResolvedValue({ id, state: "paid", testOnly: true });
});
describe("author-management API trust boundaries", () => {
  it("requires admin step-up before a probe can cause any external call", async () => {
    m.admin = false;
    expect(
      (
        await adminPost(
          req({ action: "probe", versionId, manifestDigest }),
          params,
        )
      ).status,
    ).toBe(403);
    expect(m.probe).not.toHaveBeenCalled();
  });
  it("derives model and actor from route/session rather than user JSON", async () => {
    const response = await adminPost(
      req({ action: "probe", versionId, manifestDigest }),
      params,
    );
    expect(response.status).toBe(200);
    expect(m.probe).toHaveBeenCalledWith({
      modelId: id,
      versionId,
      manifestDigest,
      actorId: "00000000-0000-4000-8000-000000000099",
    });
  });
  it.each([
    { action: "probe", versionId, manifestDigest, actorId: id },
    {
      action: "propose",
      versionId,
      manifestDigest,
      priceMicrocredits: 1,
      authorShareBps: 7000,
      rightsReference: "license",
      consentReference: "terms",
      availabilityDelaySeconds: 0,
    },
    {
      action: "propose",
      versionId,
      manifestDigest,
      priceMicrocredits: "922337203685477581",
      authorShareBps: 7000,
      rightsReference: "license",
      consentReference: "terms",
      availabilityDelaySeconds: 0,
    },
  ])("rejects forged authority or invalid exact price", async (body) => {
    expect((await adminPost(req(body), params)).status).toBe(400);
    expect(m.probe).not.toHaveBeenCalled();
    expect(m.propose).not.toHaveBeenCalled();
  });
  it("requires signed-in owner and binds policy acceptance to their user ID", async () => {
    m.user = false;
    expect(
      (
        await ownerPost(
          req({
            action: "accept",
            policyId: versionId,
            policyDigest: manifestDigest,
          }),
          params,
        )
      ).status,
    ).toBe(401);
    m.user = true;
    expect(
      (
        await ownerPost(
          req({
            action: "accept",
            policyId: versionId,
            policyDigest: manifestDigest,
          }),
          params,
        )
      ).status,
    ).toBe(200);
    expect(m.accept).toHaveBeenCalledWith(
      id,
      versionId,
      manifestDigest,
      "00000000-0000-4000-8000-000000000088",
    );
  });
  it("does not expose internal database errors or plaintext credential errors", async () => {
    m.probe.mockRejectedValue(
      new Error("password=private-token INSERT full secret"),
    );
    const r = await adminPost(
      req({ action: "probe", versionId, manifestDigest }),
      params,
    );
    expect(r.status).toBe(503);
    expect(await r.text()).not.toMatch(/private-token|INSERT/);
  });
  it("rejects oversized request bodies before orchestration", async () => {
    expect(
      (
        await adminPost(
          req({
            action: "probe",
            versionId,
            manifestDigest,
            padding: "x".repeat(20000),
          }),
          params,
        )
      ).status,
    ).toBe(400);
    expect(m.probe).not.toHaveBeenCalled();
  });
  it("only accepts explicit mock recipients and exact string payout amounts", async () => {
    expect(
      (
        await payoutPost(
          req({ recipientReference: "real:bank", amountMicrocredits: "100" }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await payoutPost(
          req({ recipientReference: "mock:wallet", amountMicrocredits: "100" }),
        )
      ).status,
    ).toBe(200);
    expect(m.payout).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000088",
      "owned-payout-key",
      { recipientReference: "mock:wallet", amountMicrocredits: "100" },
    );
  });
});
