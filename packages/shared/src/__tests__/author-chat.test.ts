import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../safe-fetch", () => ({
  safeFetch: vi.fn(),
  SsrfError: class extends Error {},
}));
import { safeFetch } from "../safe-fetch";
import * as manifestContract from "../author-manifest";
import * as endpoint from "../author-probe";
const candidate = manifestContract.parseAuthorSubmission({
  name: "Native Author",
  slug: "native-author",
  description: "A test model endpoint",
  endpointUrl: "https://author.example.com/v1/chat/completions",
  authToken: "secret",
});
const body = {
  model: "native-author",
  messages: [{ role: "user" as const, content: "hello" }],
  stream: false as const,
  max_tokens: 4,
};
const response = {
  id: "result-1",
  object: "chat.completion",
  created: 1,
  model: "native-author",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "answer" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
  privateDiagnostics: "discard",
};
beforeEach(() => vi.clearAllMocks());
describe("author executable manifest and bounded text transport", () => {
  it("reconstructs canonical manifest identity despite JSONB key order", () => {
    const reversed = Object.fromEntries(
      Object.entries(candidate.manifest).reverse(),
    );
    expect(
      manifestContract.parseStoredAuthorManifest(
        reversed,
        candidate.manifestDigest,
      ),
    ).toEqual(candidate.manifest);
  });
  it("rejects digest mismatch, tampered rights or injected manifest fields", () => {
    expect(() =>
      manifestContract.parseStoredAuthorManifest(
        candidate.manifest,
        "sha256:" + "0".repeat(64),
      ),
    ).toThrow();
    expect(() =>
      manifestContract.parseStoredAuthorManifest(
        {
          ...candidate.manifest,
          rights: { state: "approved", commercialUse: true },
        },
        candidate.manifestDigest,
      ),
    ).toThrow();
    expect(() =>
      manifestContract.parseStoredAuthorManifest(
        { ...candidate.manifest, authToken: "leak" },
        candidate.manifestDigest,
      ),
    ).toThrow();
  });
  it("executes bounded plaintext at the exact endpoint without redirects and sanitizes extra output", async () => {
    vi.mocked(safeFetch).mockResolvedValueOnce(Response.json(response));
    const output = await endpoint.executeAuthorChat(
      candidate.manifest,
      "secret",
      body,
    );
    expect(output).toEqual({ ...response, privateDiagnostics: undefined });
    expect(output).not.toHaveProperty("privateDiagnostics");
    expect(safeFetch).toHaveBeenCalledWith(
      candidate.manifest.endpoint.url,
      expect.objectContaining({
        maxRedirects: 0,
        method: "POST",
        maxBufferedResponseBytes: 65536,
      }),
    );
  });
  it.each([
    { ...body, stream: true },
    { ...body, model: "wrong" },
    { ...body, max_tokens: 4097 },
    { ...body, tools: [] },
    { ...body, messages: [{ role: "user", content: "x".repeat(32769) }] },
  ])("rejects unsupported input before dispatch", async (invalid) => {
    await expect(
      endpoint.executeAuthorChat(candidate.manifest, "secret", invalid),
    ).rejects.toBeDefined();
    expect(safeFetch).not.toHaveBeenCalled();
  });
  it.each([
    { ...response, model: "wrong" },
    {
      ...response,
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 4 },
    },
    {
      ...response,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "x" },
          finish_reason: "tool_calls",
        },
      ],
    },
  ])("does not accept invalid model/usage/finish evidence", async (invalid) => {
    vi.mocked(safeFetch).mockResolvedValueOnce(Response.json(invalid));
    await expect(
      endpoint.executeAuthorChat(candidate.manifest, "secret", body),
    ).rejects.toMatchObject({ code: "INVALID_PROBE_RESPONSE" });
  });
  it("bounds output and cancels the body on excessive bytes", async () => {
    const cancel = vi.fn();
    vi.mocked(safeFetch).mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array(65537));
          },
          cancel,
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    await expect(
      endpoint.executeAuthorChat(candidate.manifest, "secret", body),
    ).rejects.toBeDefined();
    expect(cancel).toHaveBeenCalled();
  });
});
