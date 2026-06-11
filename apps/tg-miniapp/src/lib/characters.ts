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
  // public/characters/boyar.{mp4,webp} подготовлен (персонаж-«боярин») —
  // подключить сюда, когда основатель скажет, какому kind он принадлежит.
};

export function characterFor(kind: string | null | undefined): CharacterAsset | null {
  if (!kind) return null;
  return CHARACTERS[kind] ?? null;
}
