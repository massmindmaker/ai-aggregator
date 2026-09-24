import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("stored chat HTTP startup config", () => {
  it("keeps the absent execution mode on the legacy compatibility default", async () => {
    vi.stubEnv("GATEWAY_HTTP_EXECUTION_MODE", "");
    delete process.env.GATEWAY_HTTP_EXECUTION_MODE;
    vi.resetModules();

    const { config } = await import("../config");
    expect(config.GATEWAY_HTTP_EXECUTION_MODE).toBe("legacy");
    expect(config.CACHING_DISCOUNT).toBe(0.5);
    expect(config.STORED_CHAT_CACHING_DISCOUNT_EXACT).toBe("0.5");
  });

  it("rejects an unknown execution mode at startup", async () => {
    vi.stubEnv("GATEWAY_HTTP_EXECUTION_MODE", "try_new_path");
    vi.resetModules();

    await expect(import("../config")).rejects.toThrow();
  });

  it("captures the same raw discount setting exactly in restricted mode", async () => {
    vi.stubEnv("GATEWAY_HTTP_EXECUTION_MODE", "stored_chat_only");
    vi.stubEnv("CACHING_DISCOUNT", "0.123456789012345678");
    vi.resetModules();

    const { config } = await import("../config");
    expect(config.CACHING_DISCOUNT).toBe(0.12345678901234568);
    expect(config.STORED_CHAT_CACHING_DISCOUNT_EXACT).toBe(
      "0.123456789012345678",
    );
  });

  it("accepts the explicit combined stored chat and embeddings mode", async () => {
    vi.stubEnv("GATEWAY_HTTP_EXECUTION_MODE", "stored_chat_embeddings");
    vi.resetModules();
    const { config } = await import("../config");
    expect(config.GATEWAY_HTTP_EXECUTION_MODE).toBe("stored_chat_embeddings");
  });

  it("accepts the explicit stored chat, embeddings and completions mode", async () => {
    vi.stubEnv("GATEWAY_HTTP_EXECUTION_MODE", "stored_chat_embeddings_completions");
    vi.resetModules();
    const { config } = await import("../config");
    expect(config.GATEWAY_HTTP_EXECUTION_MODE).toBe("stored_chat_embeddings_completions");
  });

  it("rejects a noncanonical exact discount only in restricted mode", async () => {
    vi.stubEnv("GATEWAY_HTTP_EXECUTION_MODE", "stored_chat_only");
    vi.stubEnv("CACHING_DISCOUNT", "1e-7");
    vi.resetModules();
    await expect(import("../config")).rejects.toThrow();

    vi.stubEnv("GATEWAY_HTTP_EXECUTION_MODE", "legacy");
    vi.resetModules();
    await expect(import("../config")).resolves.toMatchObject({
      config: { CACHING_DISCOUNT: 1e-7 },
    });
  });
});
