// Единый формат кредитов (P0-1 аудита 2026-06-11).
// КАНОН ХРАНЕНИЯ: целые центы США (D-1, BIGINT). КАНОН ДИСПЛЕЯ: «N,NN кр»
// (центы ÷ 100, ru-RU, 2 знака) — как кошелёк/RunTrace. До этого фикса
// templates/* рендерили сырые центы («500 кр» вместо «5,00 кр»), а ввод цены
// писал кр как центы — единицы расходились по поверхностям.

export function fmtCredits(cents: string | number | null | undefined): string {
  const n = typeof cents === 'string' ? Number(cents) : cents ?? NaN;
  if (!Number.isFinite(n)) return '0,00';
  return (n / 100).toLocaleString('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Ввод цены в КРЕДИТАХ (допускает дробь «12,5») → целые центы для хранения.
 *  null = пусто/бесплатно; NaN-вход или вне (0, maxCredits] → undefined (ошибка). */
export function parseCreditsInput(
  raw: string,
  maxCredits: number,
): number | null | undefined {
  const t = raw.trim().replace(',', '.');
  if (!t) return null;
  const credits = Number(t);
  if (!Number.isFinite(credits) || credits <= 0 || credits > maxCredits) return undefined;
  return Math.round(credits * 100);
}
