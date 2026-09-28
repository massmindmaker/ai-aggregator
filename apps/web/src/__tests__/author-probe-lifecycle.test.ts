import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { parseAuthorSubmission, AuthorProbeError } from "@aiag/shared/server";
import { deriveKek, encryptAesGcm } from "@aiag/upstream-adapters/byok";
const execute = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({
  db: { execute },
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    text: strings.join("?"),
    values,
  }),
}));
import { probeAuthorVersion } from "../lib/author/service";
const id = "00000000-0000-4000-8000-000000000001",
  version = "00000000-0000-4000-8000-000000000002",
  author = "00000000-0000-4000-8000-000000000003";
const candidate = parseAuthorSubmission({
  name: "Native author",
  slug: "native-author",
  description: "Test author model endpoint",
  endpointUrl: "https://author.example.com/v1/chat/completions",
  authToken: "synthetic-private-token",
});
const args = {
  modelId: id,
  versionId: version,
  manifestDigest: candidate.manifestDigest,
  actorId: "00000000-0000-4000-8000-000000000004",
};
const row = () => ({
  id: version,
  model_id: id,
  author_user_id: author,
  public_manifest: candidate.manifest,
  manifest_digest: candidate.manifestDigest,
  encrypted_token_envelope: encryptAesGcm(
    candidate.authToken,
    deriveKek("ab".repeat(32), "aiag:author-endpoint:" + author + ":v1"),
  ),
});
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("AUTHOR_ENDPOINT_KEK", "ab".repeat(32));
});
afterEach(() => vi.unstubAllEnvs());
describe("owned author probe external effect", () => {
  it("persists claim before exactly one POST and never returns the credential", async () => {
    const sequence: string[] = [];
    execute.mockImplementation(async (q) => {
      sequence.push(
        q.text.includes("aiag_claim")
          ? "claim"
          : q.text.includes("aiag_complete")
            ? "complete"
            : "read",
      );
      return {
        rows: [
          q.text.includes("aiag_claim")
            ? { id, state: "dispatching", did_claim: true }
            : q.text.includes("aiag_complete")
              ? { id, state: "succeeded" }
              : row(),
        ],
      };
    });
    const probe = vi.fn(async () => {
      sequence.push("post");
      return {
        checkedAt: new Date().toISOString(),
        responseDigest: "sha256:" + "a".repeat(64),
      };
    });
    const result = await probeAuthorVersion(args, probe);
    expect(sequence).toEqual(["read", "claim", "post", "complete"]);
    expect(probe).toHaveBeenCalledWith(candidate.manifest, candidate.authToken);
    expect(result).toEqual({ operationId: id, state: "succeeded" });
    expect(JSON.stringify(result)).not.toContain(candidate.authToken);
  });
  it("does not dispatch after duplicate or uncertain claim acknowledgement", async () => {
    const probe = vi.fn();
    execute
      .mockResolvedValueOnce({ rows: [row()] })
      .mockResolvedValueOnce({
        rows: [{ id, state: "unknown", did_claim: false }],
      });
    expect(await probeAuthorVersion(args, probe)).toEqual({
      operationId: id,
      state: "unknown",
    });
    expect(probe).not.toHaveBeenCalled();
    execute
      .mockResolvedValueOnce({ rows: [row()] })
      .mockRejectedValueOnce(new Error("lost claim ACK"));
    await expect(probeAuthorVersion(args, probe)).rejects.toBeDefined();
    expect(probe).not.toHaveBeenCalled();
  });
  it("persists timeout as unknown and does not turn it into a retry", async () => {
    execute
      .mockResolvedValueOnce({ rows: [row()] })
      .mockResolvedValueOnce({
        rows: [{ id, state: "dispatching", did_claim: true }],
      })
      .mockResolvedValueOnce({ rows: [{ id, state: "unknown" }] });
    const probe = vi
      .fn()
      .mockRejectedValue(new AuthorProbeError("ENDPOINT_UNAVAILABLE"));
    expect(await probeAuthorVersion(args, probe)).toEqual({
      operationId: id,
      state: "unknown",
    });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[2][0].values).toContain("unknown");
  });
  it("rejects tampered content or missing key before creating an external operation", async () => {
    const probe = vi.fn();
    execute.mockResolvedValueOnce({
      rows: [
        {
          ...row(),
          public_manifest: {
            ...candidate.manifest,
            model: { ...candidate.manifest.model, slug: "changed" },
          },
        },
      ],
    });
    await expect(probeAuthorVersion(args, probe)).rejects.toBeDefined();
    expect(execute).toHaveBeenCalledTimes(1);
    execute.mockClear();
    execute.mockResolvedValueOnce({ rows: [row()] });
    vi.stubEnv("AUTHOR_ENDPOINT_KEK", "");
    await expect(probeAuthorVersion(args, probe)).rejects.toBeDefined();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(probe).not.toHaveBeenCalled();
  });
});
