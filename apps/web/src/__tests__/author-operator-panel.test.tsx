import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
import { AuthorOperatorPanel } from "../components/author/AuthorOperatorPanel";
const row = {
  billing_request_id: "00000000-0000-4000-8000-000000000001",
  model_id: "00000000-0000-4000-8000-000000000002",
  model_slug: "author-model",
  version_no: 1,
  state: "settled",
  attempt_id: "00000000-0000-4000-8000-000000000003",
  price_microcredits: "1001",
  actual_cost_credits: "1001",
  author_microcredits: "732",
  refunded: false,
  no_charge: false,
  disputed: false,
  reconcile_after: null,
  created_at: "2026-09-29T00:00:00Z",
};
beforeEach(() =>
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(Response.json({ state: "settled" })),
  ),
);
describe("operator money confirmation", () => {
  it("requires explicit refund confirmation and never sends a client-selected amount", async () => {
    render(<AuthorOperatorPanel rows={[row]} />);
    const refund = screen.getByRole("button", { name: "Вернуть списание" });
    expect(refund).toBeDisabled();
    fireEvent.click(
      screen.getByRole("checkbox", { name: /подтверждаю полный возврат/i }),
    );
    fireEvent.click(refund);
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Сохранено"),
    );
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))).toEqual(
      { action: "refund" },
    );
  });
  it("never offers a provider retry for an unknown dispatched outcome", () => {
    render(
      <AuthorOperatorPanel
        rows={[
          {
            ...row,
            state: "dispatched",
            actual_cost_credits: null,
            reconcile_after: "2020-01-01T00:00:00Z",
          },
        ]}
      />,
    );
    expect(screen.getByText(/повторно не запускается/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Подтвердить отсутствие списания" }),
    ).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: /запустить модель/i }),
    ).not.toBeInTheDocument();
  });
});
