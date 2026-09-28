import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
import { AuthorModelPanel } from "../components/author/AuthorModelPanel";
import { formatAuthorCredits, formatAuthorShare } from "../lib/author/format";
const model = {
  id: "00000000-0000-4000-8000-000000000001",
  slug: "my-model",
  display_name: "My Model",
  description: "Test model description",
  status: "draft",
  enabled: false,
  current_author_version_id: null,
};
const version = {
  id: "00000000-0000-4000-8000-000000000002",
  version_no: 1,
  status: "candidate",
  manifest_digest: "sha256:" + "a".repeat(64),
  endpoint_url: "https://author.example.com/api",
  created_at: "2026-09-29T00:00:00Z",
  probe_state: "succeeded",
  policy_id: "00000000-0000-4000-8000-000000000003",
  policy_digest: "sha256:" + "b".repeat(64),
  price_microcredits: "1001",
  author_share_bps: 7315,
  availability_delay_seconds: 0,
  rights_reference: "license:reviewed",
  consent_reference: "terms:v1",
  accepted_at: null,
  approved_at: null,
};
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(Response.json({ ok: true })),
  );
});
describe("author version management UI", () => {
  it("shows exact credits and requires explicit acceptance before submitting terms", async () => {
    render(
      <AuthorModelPanel
        model={model}
        versions={[version]}
        mode="owner"
        runtimeEnabled={true}
      />,
    );
    expect(screen.getByText(/1,001 кредита/)).toBeInTheDocument();
    const button = screen.getByRole("button", { name: "Принять условия" });
    expect(button).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /принимаю цену/i }));
    fireEvent.click(button);
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Сохранено."),
    );
    const [url, options] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("/api/author/models/" + model.id);
    expect(JSON.parse(String(options?.body))).toEqual({
      action: "accept",
      policyId: version.policy_id,
      policyDigest: version.policy_digest,
    });
    expect(
      screen.queryByRole("button", { name: "Проверить подключение" }),
    ).not.toBeInTheDocument();
  });
  it("never offers approval before exact terms acceptance or probe confirmation", () => {
    render(
      <AuthorModelPanel
        model={model}
        versions={[version]}
        mode="admin"
        runtimeEnabled={true}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Сделать текущей" }),
    ).toBeDisabled();
  });
  it("blocks repeat probes after an unknown outcome", () => {
    render(
      <AuthorModelPanel
        model={model}
        versions={[{ ...version, probe_state: "unknown" }]}
        mode="admin"
        runtimeEnabled={true}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Проверить подключение" }),
    ).toBeDisabled();
    expect(
      screen.getByText(/автоматический повтор запрещён/i),
    ).toBeInTheDocument();
  });
  it("formats large or negative balances without floating point", () => {
    expect(formatAuthorCredits("9007199254740993").replace(/\s/g, "")).toBe(
      "9007199254740,993",
    );
    expect(formatAuthorCredits("-732")).toBe("-0,732");
    expect(formatAuthorShare(7315)).toBe("73,15%");
  });
});
