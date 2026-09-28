import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
import { MockAuthorPayoutPanel } from "../components/author/MockAuthorPayoutPanel";
import { isAuthorMockMode } from "../lib/author/service";
beforeEach(() => {
  sessionStorage.clear();
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => vi.unstubAllEnvs());
describe("mock payout UI and live-money separation", () => {
  it("retains logical operation identity while resolving an unknown result", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        Response.json({
          operationId: "test",
          state: "unknown",
          testOnly: true,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ operationId: "test", state: "paid", testOnly: true }),
      );
    render(
      <MockAuthorPayoutPanel
        actorId="owner"
        availableMicrocredits="1000"
        enabled={true}
      />,
    );
    fireEvent.change(screen.getByLabelText("Тестовый получатель"), {
      target: { value: "mock:wallet" },
    });
    fireEvent.change(screen.getByLabelText("Сумма, микрокредиты"), {
      target: { value: "500" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Создать тестовую выплату" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("неизвестен"),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Проверить ту же операцию" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "без реального перевода",
      ),
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetch).mock.calls[0][1]?.headers).toEqual(
      vi.mocked(fetch).mock.calls[1][1]?.headers,
    );
    expect(vi.mocked(fetch).mock.calls[0][1]?.body).toEqual(
      vi.mocked(fetch).mock.calls[1][1]?.body,
    );
  });
  it("does not expose payout controls outside test mode", () => {
    render(
      <MockAuthorPayoutPanel
        actorId="owner"
        availableMicrocredits="1000"
        enabled={false}
      />,
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
  it("refuses a mock-mode flag on any production-like database", () => {
    vi.stubEnv("AUTHOR_MOCK_PAYOUT_ENABLED", "1");
    vi.stubEnv("AIAG_TEST_DATABASE", "1");
    vi.stubEnv("DATABASE_URL", "postgresql://user@db.example.com/production");
    expect(isAuthorMockMode()).toBe(false);
    vi.stubEnv(
      "DATABASE_URL",
      "postgresql://test@127.0.0.1:15432/ai_aggregator_test",
    );
    expect(isAuthorMockMode()).toBe(true);
  });
});
