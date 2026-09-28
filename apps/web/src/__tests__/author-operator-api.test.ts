import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ admin: true, operate: vi.fn() }));
vi.mock("@/lib/admin/api", () => ({
  withAdmin: async (fn: (ctx: unknown) => unknown) =>
    m.admin
      ? fn({ user: { id: "00000000-0000-4000-8000-000000000099" } })
      : new Response("{}", { status: 403 }),
}));
vi.mock("@/auth", () => ({ auth: async () => null }));
vi.mock("@/lib/author/operator", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  operateAuthorRequest: m.operate,
}));
import { POST } from "../app/api/admin/author-requests/[id]/route";
const id = "00000000-0000-4000-8000-000000000001",
  attemptId = "00000000-0000-4000-8000-000000000002";
const params = { params: Promise.resolve({ id }) };
const request = (body: unknown) =>
  new Request("https://app.example.test/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.resetAllMocks();
  m.admin = true;
  m.operate.mockResolvedValue({ state: "settled" });
});
describe("author operator API", () => {
  it("requires the real admin step-up wrapper for every financial action", async () => {
    m.admin = false;
    expect((await POST(request({ action: "refund" }), params)).status).toBe(
      403,
    );
    expect(m.operate).not.toHaveBeenCalled();
  });
  it("derives billing request and admin ID rather than trusting JSON", async () => {
    expect((await POST(request({ action: "recover" }), params)).status).toBe(
      200,
    );
    expect(m.operate).toHaveBeenCalledWith(
      id,
      "00000000-0000-4000-8000-000000000099",
      { action: "recover" },
    );
  });
  it.each([
    { action: "refund", amount: "1" },
    { action: "no_charge", attemptId },
    { action: "dispute", disputed: true, reason: "" },
    { action: "recover", actorId: id },
  ])("rejects financial overrides or missing evidence", async (input) => {
    expect((await POST(request(input), params)).status).toBe(400);
    expect(m.operate).not.toHaveBeenCalled();
  });
  it("accepts explicit no-charge evidence only with an exact attempt identity", async () => {
    const action = {
      action: "no_charge",
      attemptId,
      evidenceReference: "provider-reconciliation:123",
    };
    expect((await POST(request(action), params)).status).toBe(200);
    expect(m.operate).toHaveBeenCalledWith(
      id,
      "00000000-0000-4000-8000-000000000099",
      action,
    );
  });
  it("keeps unrecognized database/transport details private", async () => {
    m.operate.mockRejectedValue(
      new Error("postgres://private:password@server"),
    );
    const res = await POST(request({ action: "recover" }), params);
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain("password");
  });
});
