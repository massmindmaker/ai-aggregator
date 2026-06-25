// Персонажи-портреты карточной системы (PRODUCT.md: агенты — персонифицированные
// персонажи; ассеты поставляет основатель). Файлы в public/characters/, пути с
// basePath /tg (plain <img>/<video> его НЕ префиксуют автоматически).
// Видео = карточный луп (640px, без звука, ~8с); image = постер/фоллбэк.

export interface CharacterAsset {
  name: string;
  image: string;
  video?: string;
}

const CHARACTERS: Record<string, CharacterAsset> = {
  writer: {
    name: 'Алиса',
    image: '/tg/characters/alisa.webp',
  },
  // Персонаж-«боярин» (основательский арт) — мужской характер, подключён к kind
  // 'coder' (Программист). Видео = карточный луп, webp = постер/фоллбэк.
  coder: {
    name: 'Боярин',
    image: '/tg/characters/boyar.webp',
    video: '/tg/characters/boyar.mp4',
  },
};

export function characterFor(kind: string | null | undefined): CharacterAsset | null {
  if (!kind) return null;
  return CHARACTERS[kind] ?? null;
}
