/**
 * Plan 06 Task 11 — Scenario templates.
 *
 * A scenario is a pre-filled prompt for a specific real-world use-case,
 * paired with a recommended model slug. Rendered as landing cards that
 * deep-link into the Playground with the prompt pre-populated via URL.
 */

export type ScenarioModality =
  | 'chat'
  | 'image'
  | 'tts'
  | 'embedding';

export interface Scenario {
  slug: string;
  title: string;
  modality: ScenarioModality;
  shortDescription: string;
  longDescription: string;
  recommendedModelSlug: string;
  prompt: string;
  tags: string[];
}

export const SCENARIOS: Scenario[] = [
  {
    slug: 'support-ticket-summary',
    title: 'Суммаризация тикетов поддержки',
    modality: 'chat',
    shortDescription:
      'Автоматически выделяйте суть из длинных обращений клиентов.',
    longDescription:
      'Сократите время первого ответа: модель читает переписку и выдаёт 3-пунктное резюме, теги и предложение решения.',
    recommendedModelSlug: 'yandex/yandexgpt-5-pro',
    prompt:
      'Ты — ассистент службы поддержки. Прочитай обращение клиента и верни JSON с полями:\n' +
      '- summary: 1-2 предложения о сути\n' +
      '- tags: массив тем (billing, bug, how-to, complaint)\n' +
      '- urgency: low/normal/high\n' +
      '- next_step: рекомендуемое первое действие\n\n' +
      'Обращение:\n"""\nЗдравствуйте, я три дня назад оплатил подписку на год, но личный кабинет показывает только месячный тариф. Прошу разобраться."""',
    tags: ['чат', 'поддержка', 'classification'],
  },
  {
    slug: 'product-description',
    title: 'Генерация описаний товаров',
    modality: 'chat',
    shortDescription: 'Превратите характеристики в продающий текст за секунды.',
    longDescription:
      'Для маркетплейсов и e-commerce — единый стиль, без воды и фактических ошибок. Подставляйте свойства товара и получайте карточку.',
    recommendedModelSlug: 'sber/gigachat-pro',
    prompt:
      'Напиши описание товара для маркетплейса длиной 150-200 слов. Сохрани SEO-ключи, выдели абзацы, добавь bullet-список ключевых преимуществ.\n\n' +
      'Характеристики:\n- Название: Беспроводные наушники Sound Pro X5\n- Время работы: 40 часов\n- Шумоподавление: активное\n- Кодеки: LDAC, AAC\n- Цена: 9990 ₽',
    tags: ['чат', 'маркетинг', 'ecommerce'],
  },
  {
    slug: 'cover-image',
    title: 'Обложка для статьи / поста',
    modality: 'image',
    shortDescription: 'Сгенерируйте обложку под тему материала — 1024×1024.',
    longDescription:
      'Быстрый способ сделать обложку для блога, e-mail-рассылки или поста в соцсетях. Опишите тему — модель нарисует.',
    recommendedModelSlug: 'stable-diffusion-3-5',
    prompt:
      'Минималистичная обложка для статьи про искусственный интеллект в корпоративной автоматизации. Тёплые янтарные акценты на тёмном фоне, абстрактные нейронные узоры, без текста. Формат 1024×1024.',
    tags: ['изображения', 'контент'],
  },
  {
    slug: 'doc-qa-embeddings',
    title: 'Поиск по документации (RAG)',
    modality: 'embedding',
    shortDescription:
      'Векторизуйте внутреннюю базу знаний и отвечайте по ней через LLM.',
    longDescription:
      'Сценарий RAG: embeddings для индексации + LLM для ответа. Ниже — промпт финального шага после retrieval.',
    recommendedModelSlug: 'anthropic/claude-sonnet-4-6',
    prompt:
      'Ты отвечаешь на вопрос пользователя ТОЛЬКО на основе приведённых фрагментов документации. Если информации не хватает — так и скажи.\n\n' +
      'Вопрос: Как изменить тариф в середине месяца?\n\n' +
      'Фрагменты:\n"""\n<сюда подставьте top-k из векторного поиска>\n"""',
    tags: ['чат', 'rag', 'enterprise'],
  },
  {
    slug: 'product-voiceover',
    title: 'Озвучка карточки товара',
    modality: 'tts',
    shortDescription:
      'Озвучьте описание товара или рекламного ролика готовым голосом.',
    longDescription:
      'Модель text-to-speech принимает текст и возвращает аудио. Ниже — готовый текст для озвучки карточки товара.',
    // Source of truth at runtime is catalog.generated.ts (GENERATED_CATALOG, 69 models);
    // the hand-written CATALOG array is only a fallback. Slug must exist in the generated one.
    recommendedModelSlug: 'elevenlabs-tts-hf',
    prompt:
      'Карточка беспроводных наушников Sound Pro X5. Время работы 40 часов, активное шумоподавление, кодеки LDAC и AAC, цена 9990 ₽.',
    tags: ['аудио', 'маркетинг', 'ecommerce'],
  },
];

export function getAllScenarios(): Scenario[] {
  return SCENARIOS;
}

export function getScenarioBySlug(slug: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.slug === slug);
}
