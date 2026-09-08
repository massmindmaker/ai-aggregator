import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import { gatewayHttpRejections } from "../gateway";

describe("HTTP rejection schema boundary", () => {
  it("ties a terminal rejection to the owned request, without an admission FK or money fields", () => {
    const config = getTableConfig(gatewayHttpRejections);
    expect(config.name).toBe("gateway_http_rejections");
    expect(config.foreignKeys.map((f) => f.getName()).sort()).toEqual([
      "gateway_http_rejections_key_owner_fk",
      "gateway_http_rejections_request_owner_fk",
    ]);
    expect(config.foreignKeys.every((f) => f.onDelete === "restrict")).toBe(
      true,
    );
    expect(config.columns.map((c) => c.name)).toEqual([
      "billing_request_id",
      "org_id",
      "api_key_id",
      "result_version",
      "rejection_code",
      "http_status",
      "content_type",
      "response_body",
      "terminal_at",
    ]);
    expect(config.columns.every((c) => c.notNull)).toBe(true);
  });
});
