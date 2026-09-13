import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/validation.ts",
    "src/client.ts",
    "src/server.ts",
    "src/ton-payment-contract.ts",
    "src/catalog-contract.ts",
  ],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
});
