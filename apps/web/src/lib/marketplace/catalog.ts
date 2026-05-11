/**
 * Plan 06 — Marketplace seed catalog.
 *
 * Until Plan 04 gateway schema is merged into this worktree, the marketplace
 * reads from this static catalog. The shape matches the future DB model
 * (slug = `<provider>/<model>`) so the UI can switch to real data with zero
 * refactor — only the loader function needs to change.
 */

export type ModelType =
  | 'llm'
  | 'image'
  | 'audio'
  | 'video'
  | 'embedding'
  | 'code'
  | 'speech-to-text'
  | 'text-to-speech'
  | 'multimodal';

export type HostingRegion = 'ru' | 'eu' | 'us' | 'global';

export interface ModelPricing {
  /** RUB per 1K input tokens (chat/llm) */
  inputPer1k?: number;
  /** RUB per 1K output tokens (chat/llm) */
  outputPer1k?: number;
  /** RUB per image */
  perImage?: number;
  /** RUB per minute of audio */
  perMinute?: number;
  /** RUB per second of video */
  perSecond?: number;
  unit?: string;
}

export interface ModelCapabilities {
  streaming?: boolean;
  tools?: boolean;
  vision?: boolean;
  jsonSchema?: boolean;
  batch?: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
}

export interface ModelStats {
  avgRating: number;
  totalReviews: number;
  weeklyRequests: number;
  p50LatencyMs: number;
  uptimePct: number;
}

export interface CatalogModel {
  /** `<provider>/<model>` — e.g. "openai/gpt-4-turbo" */
  slug: string;
  orgSlug: string;
  orgName: string;
  modelSlug: string;
  name: string;
  shortDescription: string;
  description: string;
  type: ModelType;
  hostingRegion: HostingRegion;
  tags: string[];
  derivedTags: string[];
  pricing: ModelPricing;
  capabilities: ModelCapabilities;
  stats: ModelStats;
  featured?: boolean;
  /** Optional OG/preview image URL for the model. */
  imageUrl?: string;
}

/** Foreign-hosted org slugs (trigger transfer warning per 152-ФЗ). */
export const FOREIGN_ORGS = new Set([
  'openai',
  'anthropic',
  'google',
  'stability',
  'meta',
  'runway',
  'elevenlabs',
  'mistral',
]);

export function isForeignHosted(orgSlug: string): boolean {
  return FOREIGN_ORGS.has(orgSlug);
}

export const MODEL_TYPE_LABEL_RU: Record<ModelType, string> = {
  llm: 'LLM / Чат',
  image: 'Изображения',
  audio: 'Аудио',
  video: 'Видео',
  embedding: 'Эмбеддинги',
  code: 'Код',
  'speech-to-text': 'Речь → Текст',
  'text-to-speech': 'Текст → Речь',
  multimodal: 'Мультимодальные',
};

export const CATALOG: CatalogModel[] = [
  {
    slug: 'openai/gpt-4-turbo',
    orgSlug: 'openai',
    orgName: 'OpenAI',
    modelSlug: 'gpt-4-turbo',
    name: 'GPT-4 Turbo',
    shortDescription: 'Флагманская модель OpenAI с 128K контекстом и vision.',
    description:
      'GPT-4 Turbo — передовая языковая модель с улучшенными рассуждением и следованием инструкциям. Поддерживает vision и function calling.',
    type: 'llm',
    hostingRegion: 'us',
    tags: ['текст', 'чат', 'reasoning', 'vision'],
    derivedTags: ['long-context'],
    pricing: { inputPer1k: 0.9, outputPer1k: 2.7, unit: '1K токенов' },
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      jsonSchema: true,
      batch: true,
      contextWindow: 128000,
      maxOutputTokens: 4096,
    },
    stats: {
      avgRating: 4.9,
      totalReviews: 2134,
      weeklyRequests: 152000,
      p50LatencyMs: 820,
      uptimePct: 99.95,
    },
    featured: true,
  },
  {
    slug: 'anthropic/claude-3-5-sonnet',
    orgSlug: 'anthropic',
    orgName: 'Anthropic',
    modelSlug: 'claude-3-5-sonnet',
    name: 'Claude 3.5 Sonnet',
    shortDescription: 'Лучшая модель Anthropic по соотношению цена/качество.',
    description:
      'Claude 3.5 Sonnet — сбалансированная модель с отличными навыками программирования и анализа длинных документов.',
    type: 'llm',
    hostingRegion: 'us',
    tags: ['текст', 'чат', 'reasoning', 'code'],
    derivedTags: ['long-context', 'fast'],
    pricing: { inputPer1k: 0.3, outputPer1k: 1.5, unit: '1K токенов' },
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      jsonSchema: true,
      contextWindow: 200000,
      maxOutputTokens: 8192,
    },
    stats: {
      avgRating: 4.8,
      totalReviews: 1520,
      weeklyRequests: 98000,
      p50LatencyMs: 690,
      uptimePct: 99.9,
    },
    featured: true,
  },
  {
    slug: 'yandex/yandexgpt-5',
    orgSlug: 'yandex',
    orgName: 'Yandex',
    modelSlug: 'yandexgpt-5',
    name: 'YandexGPT 5',
    shortDescription: 'Русскоязычная модель Yandex. Хостинг в РФ.',
    description:
      'YandexGPT 5 — русскоязычная LLM с хостингом на территории РФ. Соответствует 152-ФЗ, без трансграничной передачи.',
    type: 'llm',
    hostingRegion: 'ru',
    tags: ['текст', 'чат', 'russian', 'reasoning'],
    derivedTags: ['cheap', 'fast'],
    pricing: { inputPer1k: 0.2, outputPer1k: 0.6, unit: '1K токенов' },
    capabilities: {
      streaming: true,
      tools: false,
      vision: false,
      jsonSchema: false,
      contextWindow: 32000,
      maxOutputTokens: 2048,
    },
    stats: {
      avgRating: 4.5,
      totalReviews: 412,
      weeklyRequests: 45000,
      p50LatencyMs: 540,
      uptimePct: 99.8,
    },
    featured: true,
  },
  {
    slug: 'sber/gigachat-pro',
    orgSlug: 'sber',
    orgName: 'Sber',
    modelSlug: 'gigachat-pro',
    name: 'GigaChat Pro',
    shortDescription: 'Русскоязычная LLM от Сбера. Хостинг в РФ.',
    description:
      'GigaChat Pro — русскоязычная LLM от Сбера. Полностью локальный хостинг в РФ.',
    type: 'llm',
    hostingRegion: 'ru',
    tags: ['текст', 'чат', 'russian'],
    derivedTags: ['cheap'],
    pricing: { inputPer1k: 0.25, outputPer1k: 0.75, unit: '1K токенов' },
    capabilities: {
      streaming: true,
      tools: false,
      vision: false,
      jsonSchema: false,
      contextWindow: 32000,
      maxOutputTokens: 2048,
    },
    stats: {
      avgRating: 4.3,
      totalReviews: 287,
      weeklyRequests: 28000,
      p50LatencyMs: 620,
      uptimePct: 99.7,
    },
  },
  {
    slug: 'openai/dall-e-3',
    orgSlug: 'openai',
    orgName: 'OpenAI',
    modelSlug: 'dall-e-3',
    name: 'DALL-E 3',
    shortDescription: 'Генерация изображений высокого качества.',
    description:
      'DALL-E 3 — модель генерации изображений с точным следованием промпту и высокой детализацией.',
    type: 'image',
    hostingRegion: 'us',
    tags: ['изображения', 'генерация', 'photo', 'art'],
    derivedTags: [],
    pricing: { perImage: 7.5, unit: 'изображение 1024×1024' },
    capabilities: {},
    stats: {
      avgRating: 4.7,
      totalReviews: 980,
      weeklyRequests: 41000,
      p50LatencyMs: 9500,
      uptimePct: 99.8,
    },
    featured: true,
  },
  {
    slug: 'stability/sdxl',
    orgSlug: 'stability',
    orgName: 'Stability AI',
    modelSlug: 'sdxl',
    name: 'Stable Diffusion XL',
    shortDescription: 'Открытая модель генерации изображений.',
    description: 'Stable Diffusion XL — open-source модель для генерации фото-реалистичных изображений.',
    type: 'image',
    hostingRegion: 'eu',
    tags: ['изображения', 'open-source', 'photo'],
    derivedTags: ['cheap'],
    pricing: { perImage: 1.2, unit: 'изображение' },
    capabilities: {},
    stats: {
      avgRating: 4.5,
      totalReviews: 612,
      weeklyRequests: 22000,
      p50LatencyMs: 4200,
      uptimePct: 99.5,
    },
  },
  {
    slug: 'kandinsky/kandinsky-3',
    orgSlug: 'kandinsky',
    orgName: 'Kandinsky',
    modelSlug: 'kandinsky-3',
    name: 'Kandinsky 3.0',
    shortDescription: 'Русская модель генерации изображений. Хостинг в РФ.',
    description: 'Kandinsky 3.0 — российская модель генерации изображений с хостингом в РФ.',
    type: 'image',
    hostingRegion: 'ru',
    tags: ['изображения', 'russian', 'art'],
    derivedTags: ['cheap'],
    pricing: { perImage: 0.9, unit: 'изображение' },
    capabilities: {},
    stats: {
      avgRating: 4.4,
      totalReviews: 214,
      weeklyRequests: 8500,
      p50LatencyMs: 5100,
      uptimePct: 99.6,
    },
  },
  {
    slug: 'openai/whisper-large-v3',
    orgSlug: 'openai',
    orgName: 'OpenAI',
    modelSlug: 'whisper-large-v3',
    name: 'Whisper Large v3',
    shortDescription: 'Высокоточное распознавание речи на 98 языках.',
    description: 'Whisper Large v3 — модель распознавания речи на 98 языках с высокой точностью.',
    type: 'speech-to-text',
    hostingRegion: 'us',
    tags: ['аудио', 'транскрипция'],
    derivedTags: ['cheap'],
    pricing: { perMinute: 0.6, unit: 'минута' },
    capabilities: {},
    stats: {
      avgRating: 4.7,
      totalReviews: 540,
      weeklyRequests: 14000,
      p50LatencyMs: 3200,
      uptimePct: 99.8,
    },
  },
  {
    slug: 'elevenlabs/eleven-multilingual',
    orgSlug: 'elevenlabs',
    orgName: 'ElevenLabs',
    modelSlug: 'eleven-multilingual',
    name: 'Eleven Multilingual v2',
    shortDescription: 'Реалистичный синтез речи на 29 языках.',
    description: 'Eleven Multilingual v2 — реалистичный TTS с клонированием голоса.',
    type: 'text-to-speech',
    hostingRegion: 'us',
    tags: ['аудио', 'синтез', 'voice'],
    derivedTags: [],
    pricing: { perMinute: 15, unit: '1K символов' },
    capabilities: {},
    stats: {
      avgRating: 4.8,
      totalReviews: 320,
      weeklyRequests: 9200,
      p50LatencyMs: 1800,
      uptimePct: 99.7,
    },
  },
  {
    slug: 'runway/gen-3',
    orgSlug: 'runway',
    orgName: 'Runway',
    modelSlug: 'gen-3',
    name: 'Runway Gen-3',
    shortDescription: 'Генерация видео по текстовому описанию.',
    description: 'Runway Gen-3 — модель text-to-video с реалистичной анимацией.',
    type: 'video',
    hostingRegion: 'us',
    tags: ['видео', 'генерация'],
    derivedTags: [],
    pricing: { perSecond: 45, unit: 'секунда' },
    capabilities: {},
    stats: {
      avgRating: 4.5,
      totalReviews: 120,
      weeklyRequests: 3400,
      p50LatencyMs: 45000,
      uptimePct: 99.3,
    },
  },
  {
    slug: 'openai/text-embedding-3-large',
    orgSlug: 'openai',
    orgName: 'OpenAI',
    modelSlug: 'text-embedding-3-large',
    name: 'Text Embedding 3 Large',
    shortDescription: 'Эмбеддинги высокой размерности для RAG.',
    description: 'Text Embedding 3 Large — модель эмбеддингов для поиска и RAG.',
    type: 'embedding',
    hostingRegion: 'us',
    tags: ['эмбеддинги', 'rag'],
    derivedTags: ['cheap', 'fast'],
    pricing: { inputPer1k: 0.013, unit: '1K токенов' },
    capabilities: { batch: true, contextWindow: 8191 },
    stats: {
      avgRating: 4.6,
      totalReviews: 380,
      weeklyRequests: 67000,
      p50LatencyMs: 180,
      uptimePct: 99.95,
    },
  },
  {
    slug: 'anthropic/claude-3-haiku',
    orgSlug: 'anthropic',
    orgName: 'Anthropic',
    modelSlug: 'claude-3-haiku',
    name: 'Claude 3 Haiku',
    shortDescription: 'Быстрая и дешёвая модель для продакшен-трафика.',
    description: 'Claude 3 Haiku — самая быстрая модель Anthropic, идеальна для высоконагруженных сценариев.',
    type: 'llm',
    hostingRegion: 'us',
    tags: ['текст', 'чат', 'code'],
    derivedTags: ['fast', 'cheap'],
    pricing: { inputPer1k: 0.025, outputPer1k: 0.125, unit: '1K токенов' },
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      jsonSchema: true,
      contextWindow: 200000,
      maxOutputTokens: 4096,
    },
    stats: {
      avgRating: 4.6,
      totalReviews: 720,
      weeklyRequests: 54000,
      p50LatencyMs: 320,
      uptimePct: 99.9,
    },
  },
  {
    slug: 'mistral/mistral-large',
    orgSlug: 'mistral',
    orgName: 'Mistral AI',
    modelSlug: 'mistral-large',
    name: 'Mistral Large',
    shortDescription: 'Европейская LLM с хостингом в ЕС.',
    description: 'Mistral Large — европейская open-weight модель, хостинг в Париже.',
    type: 'llm',
    hostingRegion: 'eu',
    tags: ['текст', 'чат', 'reasoning', 'code'],
    derivedTags: ['long-context'],
    pricing: { inputPer1k: 0.4, outputPer1k: 1.2, unit: '1K токенов' },
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      jsonSchema: true,
      contextWindow: 128000,
      maxOutputTokens: 4096,
    },
    stats: {
      avgRating: 4.5,
      totalReviews: 290,
      weeklyRequests: 18000,
      p50LatencyMs: 780,
      uptimePct: 99.8,
    },
  },
  {
    slug: 'google/gemini-1-5-pro',
    orgSlug: 'google',
    orgName: 'Google',
    modelSlug: 'gemini-1-5-pro',
    name: 'Gemini 1.5 Pro',
    shortDescription: 'Мультимодальная модель Google с 2M контекстом.',
    description: 'Gemini 1.5 Pro — мультимодальная модель с рекордным контекстом 2M токенов.',
    type: 'multimodal',
    hostingRegion: 'us',
    tags: ['multimodal', 'reasoning', 'vision'],
    derivedTags: ['long-context'],
    pricing: { inputPer1k: 0.35, outputPer1k: 1.05, unit: '1K токенов' },
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      jsonSchema: true,
      contextWindow: 2000000,
      maxOutputTokens: 8192,
    },
    stats: {
      avgRating: 4.5,
      totalReviews: 410,
      weeklyRequests: 32000,
      p50LatencyMs: 1200,
      uptimePct: 99.85,
    },
  },
];

export function getAllModels(): CatalogModel[] {
  return CATALOG;
}

export function getModelBySlug(slug: string): CatalogModel | undefined {
  return CATALOG.find((m) => m.slug === slug);
}

export function getModelByOrgAndSlug(
  orgSlug: string,
  modelSlug: string
): CatalogModel | undefined {
  return CATALOG.find(
    (m) => m.orgSlug === orgSlug && m.modelSlug === modelSlug
  );
}

export function getAllOrgs(): Array<{ slug: string; name: string; count: number }> {
  const map = new Map<string, { slug: string; name: string; count: number }>();
  for (const m of CATALOG) {
    const existing = map.get(m.orgSlug);
    if (existing) existing.count += 1;
    else map.set(m.orgSlug, { slug: m.orgSlug, name: m.orgName, count: 1 });
  }
  return Array.from(map.values()).sort((a, b) => b.count - a.count);
}

/**
 * Find up to `limit` catalog entries related to the given model.
 * Ranking: same type first, then shared tags, excluding the source model.
 */
export function findRelatedModels(
  model: CatalogModel,
  limit = 4
): CatalogModel[] {
  const scored = CATALOG.filter((m) => m.slug !== model.slug).map((m) => {
    const typeScore = m.type === model.type ? 10 : 0;
    const sharedTags = m.tags.filter((t) => model.tags.includes(t)).length;
    const hostingScore = m.hostingRegion === model.hostingRegion ? 1 : 0;
    return { m, score: typeScore + sharedTags * 2 + hostingScore };
  });
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.m);
}

export function getAllTags(): Array<{ tag: string; count: number }> {
  const map = new Map<string, number>();
  for (const m of CATALOG) {
    for (const t of m.tags) map.set(t, (map.get(t) || 0) + 1);
  }
  return Array.from(map.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count);
}
