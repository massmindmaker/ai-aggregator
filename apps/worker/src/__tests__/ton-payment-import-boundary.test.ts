import { readFileSync, readdirSync } from "node:fs";
import { resolve, relative } from "node:path";
import { describe, expect, it } from "vitest";
const root = resolve(import.meta.dirname, "../../../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");
function sourceFiles(dir: string): string[] {
  return readdirSync(resolve(root, dir), { withFileTypes: true }).flatMap(
    (e) =>
      e.isDirectory()
        ? ["__tests__", "__fixtures__", "node_modules", "dist"].includes(e.name)
          ? []
          : sourceFiles(dir + "/" + e.name)
        : /\.(ts|tsx)$/.test(e.name)
          ? [dir + "/" + e.name]
          : [],
  );
}
describe("TON settlement source ownership fence, not DB authorization", () => {
  it("exposes invoice read/create publicly and settlement only in the explicit worker subpath", () => {
    expect(read("packages/database/src/index.ts")).not.toMatch(
      /\bsettleTonInvoice\b/,
    );
    expect(
      read("packages/database/src/ton-reconciliation-internal.ts"),
    ).toMatch(/\bsettleTonInvoice\b/);
  });
  it("keeps Web/gateway free of internal settlement import and raw settlement SQL", () => {
    const violations = ["apps/web/src", "packages/api-gateway/src"]
      .flatMap(sourceFiles)
      .filter((p) =>
        /ton-reconciliation-internal|aiag_settle_ton_invoice_v1|\bsettleTonInvoice\b/.test(
          read(p),
        ),
      );
    expect(violations).toEqual([]);
  });
  it("only allows the existing validated worker bootstrap to import the internal package", () => {
    expect(
      sourceFiles("apps/worker/src").filter((p) =>
        /@aiag\/database\/ton-reconciliation-internal/.test(read(p)),
      ),
    ).toEqual(["apps/worker/src/ton-payment-bootstrap.ts"]);
    expect(read("apps/worker/src/ton-payment-bootstrap.ts")).not.toMatch(
      /settleVerifiedCredit\s*\(|api\.settleTonInvoice|reconcileTonInvoicesWithFixtureSettlement/,
    );
  });
});
