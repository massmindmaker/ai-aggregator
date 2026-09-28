/** Display only: one canonical credit contains1000integer microcredits. No floating point or FX. */
export function formatAuthorCredits(value: string): string {
  if (!/^-?[0-9]+$/.test(value)) return "—";
  const amount = BigInt(value),
    absolute = amount < 0n ? -amount : amount;
  const whole = (absolute / 1000n).toLocaleString("ru-RU");
  const fraction = (absolute % 1000n)
    .toString()
    .padStart(3, "0")
    .replace(/0+$/, "");
  return (amount < 0n ? "-" : "") + whole + (fraction ? "," + fraction : "");
}
export function formatAuthorShare(bps: number): string {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10000) return "—";
  const fraction = (bps % 100).toString().padStart(2, "0").replace(/0+$/, "");
  return (
    Math.floor(bps / 100).toString() + (fraction ? "," + fraction : "") + "%"
  );
}
export function authorPercentToBps(value: string): number {
  const normalized = value.trim().replace(",", ".");
  if (!/^(?:[0-9]{1,2}|100)(?:\.[0-9]{1,2})?$/.test(normalized))
    throw Error("Укажите долю от0до100% с двумя знаками после запятой.");
  const [whole, fraction = ""] = normalized.split(".");
  const bps = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (bps > 10000) throw Error("Доля не может превышать100%.");
  return bps;
}
