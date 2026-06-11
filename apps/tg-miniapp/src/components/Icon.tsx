// Единый outline-набор иконок (24×24, stroke=currentColor) — тот же язык, что
// HubIcon в agents/page.tsx и BottomNav. PRODUCT.md запрещает emoji-«function
// tile»; деталь/создание агента раньше мешали три языка иконок (баг #15 аудита).

export const ICONS = {
  // ⤴ → публикация/«поделиться наружу»
  publish: 'M12 15V3 M8 7l4-4 4 4 M4 13v6a2 2 0 002 2h12a2 2 0 002-2v-6',
  // ⏰ → расписание (часы)
  clock: 'M12 21a9 9 0 110-18 9 9 0 010 18z M12 8v4l3 2',
  // 🧩 → MCP-скиллы (пазл)
  puzzle:
    'M9 4a2 2 0 114 0v1h2.5a1 1 0 011 1V9h1a2 2 0 110 4h-1v3a1 1 0 01-1 1H15v-1a2 2 0 10-4 0v1H7.5a1 1 0 01-1-1v-3.5H5a2 2 0 110-4h1.5V6a1 1 0 011-1H9V4z',
  // ▤ → канбан/доска
  board: 'M4 4h16a1 1 0 011 1v14a1 1 0 01-1 1H4a1 1 0 01-1-1V5a1 1 0 011-1z M9 4v16 M15 4v16',
  // → отправка сообщения
  send: 'M22 2L11 13 M22 2l-7 20-4-9-9-4 20-7z',
  // ✓ успех
  check: 'M20 6L9 17l-5-5',
} as const;

export function Icon({
  d,
  size = 16,
}: {
  d: string;
  size?: number;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}
