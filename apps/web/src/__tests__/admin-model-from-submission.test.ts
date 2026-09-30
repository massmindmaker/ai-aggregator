import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ execute: vi.fn(), audit: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: { execute: mocks.execute },
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    text: strings.join("?"),
    values,
  }),
}));
vi.mock("@/lib/admin/api", () => ({
  withAdmin: async (fn: (ctx: unknown) => unknown) =>
    fn({ user: { email: "admin@example.test" } }),
}));
vi.mock("@/lib/admin/guard", () => ({ audit: mocks.audit }));

import { POST } from "../app/api/admin/models/from-submission/route";

const AUTHOR = "00000000-0000-4000-8000-0000000000a1";
const VALID = {
  author_user_id: AUTHOR,
  model_slug: "author-first-model",
  display_name: "Author First Model",
  description: "great model",
  hosting_strategy: "cloud_api_wrap",
  tags: ["new", "author-submitted"],
};

const call = (body: unknown) =>
  POST(
    new Request("http://localhost/api/admin/models/from-submission", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );

beforeEach(() => {
  vi.resetAllMocks();
  mocks.execute.mockResolvedValue({ rows: [] });
});

describe("POST /api/admin/models/from-submission", () => {
  it.each([
    ["missing author_user_id", { ...VALID, author_user_id: "" }, "INVALID_AUTHOR_ID"],
    ["malformed author_user_id", { ...VALID, author_user_id: "nope" }, "INVALID_AUTHOR_ID"],
    ["missing display_name", { ...VALID, display_name: "" }, "INVALID_INPUT"],
    ["bad slug", { ...VALID, model_slug: "Bad Slug" }, "INVALID_SLUG"],
    ["short slug", { ...VALID, model_slug: "ab" }, "INVALID_SLUG"],
    ["bad hosting", { ...VALID, hosting_strategy: "on_our_hardware" }, "INVALID_HOSTING"],
  ])("rejects %s with 400", async (_name, body, code) => {
    const response = await call(body);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe(code);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("rejects an unknown author with 404 AUTHOR_NOT_FOUND before inserting", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [] });
    const response = await call(VALID);
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe("AUTHOR_NOT_FOUND");
    const queries = mocks.execute.mock.calls.map(([q]) => q.text as string);
    expect(queries.some((q) => /INSERT INTO models/.test(q))).toBe(false);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("rejects a duplicate model_slug with 409 SLUG_TAKEN", async () => {
    mocks.execute
      .mockResolvedValueOnce({ rows: [{ id: AUTHOR }] })
      .mockResolvedValueOnce({ rows: [{ id: "existing-model" }] });
    const response = await call(VALID);
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("SLUG_TAKEN");
    const queries = mocks.execute.mock.calls.map(([q]) => q.text as string);
    expect(queries.some((q) => /INSERT INTO models/.test(q))).toBe(false);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("inserts the model in pending_author_consent, unpublished, with a NULL contest link", async () => {
    mocks.execute
      .mockResolvedValueOnce({ rows: [{ id: AUTHOR }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "m-1" }] });
    const response = await call(VALID);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      model_id: "m-1",
      model_slug: VALID.model_slug,
    });
    const insert = mocks.execute.mock.calls
      .map(([q]) => q as { text: string; values: unknown[] })
      .find((q) => /INSERT INTO models/.test(q.text));
    expect(insert).toBeDefined();
    expect(insert!.text).toContain("pending_author_consent");
    expect(insert!.text).toContain("'llm'");
    expect(insert!.text).toContain("false");
    // The contest column is kept in the column list but always NULL — no contest
    // entity, id or rank is part of this route's inputs.
    expect(insert!.text).toContain("derived_from_contest_id");
    expect(insert!.text).toMatch(/NULL/i);
    expect(insert!.values).toContain(AUTHOR);
    expect(insert!.values).toContain(VALID.model_slug);
  });

  it("defaults hosting_strategy, description and tags when omitted", async () => {
    mocks.execute
      .mockResolvedValueOnce({ rows: [{ id: AUTHOR }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "m-2" }] });
    const response = await call({
      author_user_id: AUTHOR,
      model_slug: "minimal-model",
      display_name: "Minimal",
    });
    expect(response.status).toBe(200);
    const insert = mocks.execute.mock.calls
      .map(([q]) => q as { text: string; values: unknown[] })
      .find((q) => /INSERT INTO models/.test(q.text))!;
    expect(insert.values).toContain("cloud_api_wrap");
    expect(insert.values).toContain(null);
  });

  it("does not report success when the insert returns no row", async () => {
    mocks.execute
      .mockResolvedValueOnce({ rows: [{ id: AUTHOR }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const response = await call(VALID);
    expect(response.status).toBe(500);
    expect((await response.json()).error).toBe("INSERT_FAILED");
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("audits model.create_from_dashboard against the new model", async () => {
    mocks.execute
      .mockResolvedValueOnce({ rows: [{ id: AUTHOR }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "m-3" }] });
    const response = await call(VALID);
    expect(response.status).toBe(200);
    expect(mocks.audit).toHaveBeenCalledWith(
      "admin@example.test",
      "model.create_from_dashboard",
      "model",
      "m-3",
      expect.objectContaining({ model_slug: VALID.model_slug, author_user_id: AUTHOR }),
    );
  });

  it("never mentions a contest in the queries it issues", async () => {
    mocks.execute
      .mockResolvedValueOnce({ rows: [{ id: AUTHOR }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "m-4" }] });
    await call(VALID);
    for (const [q] of mocks.execute.mock.calls) {
      const text = (q as { text: string }).text;
      expect(text).not.toMatch(/contest_submission/i);
      expect(text).not.toMatch(/final_rank/i);
      expect(text).not.toMatch(/email_jobs/i);
    }
    expect(mocks.audit.mock.calls[0][1]).not.toMatch(/contest/i);
  });
});
