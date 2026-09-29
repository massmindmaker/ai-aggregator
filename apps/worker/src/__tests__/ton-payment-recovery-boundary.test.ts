import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
const root = resolve(import.meta.dirname, "../../../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
describe("observe-only recovery ownership", () => {
  it("keeps settlement absent while allowing one disabled-by-default observation bootstrap", () => {
    for (const file of [
      "ton-payment-reconciler.ts",
      "ton-payment-bootstrap.ts",
      "ton-recovery-contract.ts",
      "ton-recovery-control.ts",
    ]) {
      const source = read("apps/worker/src/" + file);
      expect(source).not.toMatch(
        /\bsettleTonInvoice\s*\(|aiag_settle_ton_invoice_v1/,
      );
    }
    const entry=read("apps/worker/src/index.ts");
    expect(entry.match(/await startTonReconciliationFromEnv\(/g)).toHaveLength(1);
    expect(entry).not.toMatch(/settleTonInvoice|ton-reconciliation-internal|createToncenterV3Provider/);
  });
  it("loads the internal database API only through the validated bootstrap", () => {
    const sources = [
      "ton-payment-reconciler.ts",
      "ton-recovery-contract.ts",
      "ton-recovery-control.ts",
    ];
    for (const file of sources)
      expect(read("apps/worker/src/" + file)).not.toMatch(
        /from\s+['"]@aiag\/database\/ton-reconciliation-internal/,
      );
    const bootstrap = read("apps/worker/src/ton-payment-bootstrap.ts");
    expect(bootstrap).toMatch(
      /await import\(['"]@aiag\/database\/ton-reconciliation-internal['"]\)/,
    );
  });
  it("adds no migration and does not change the approved native-only provider contract", () => {
    expect(
      ["drizzle", "migrations"].flatMap((directory) =>
        readdirSync(resolve(root, "packages/database", directory)).filter((n) =>
          /^\d{4}.*\.sql$/.test(n),
        ),
      ),
    ).toHaveLength(90);
    expect(read("apps/worker/src/ton-payment-provider.ts")).toContain(
      "if (source.asset.kind === 'jetton') return failure('unsupported_asset')",
    );
  });
});
