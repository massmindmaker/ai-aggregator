import type { MetadataRoute } from 'next';

/**
 * Plan 08 Task 6 — dynamic sitemap.xml.
 *
 * MVP: статический список основных страниц. При интеграции с БД расширить
 * — добавить все published models через drizzle query.
 */

const BASE = 'https://ai-aggregator.ru';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();
  return [
    { url: `${BASE}/`, lastModified: now, changeFrequency: 'weekly', priority: 1.0 },
    { url: `${BASE}/marketplace`, lastModified: now, changeFrequency: 'daily', priority: 0.9 },
    { url: `${BASE}/pricing`, lastModified: now, changeFrequency: 'monthly', priority: 0.8 },
    { url: `${BASE}/docs`, lastModified: now, changeFrequency: 'weekly', priority: 0.7 },
    { url: `${BASE}/status`, lastModified: now, changeFrequency: 'hourly', priority: 0.5 },
    { url: `${BASE}/privacy`, lastModified: now, changeFrequency: 'monthly', priority: 0.3 },
    { url: `${BASE}/cookies`, lastModified: now, changeFrequency: 'monthly', priority: 0.2 },
    {
      url: `${BASE}/author-agreement`,
      lastModified: now,
      changeFrequency: 'monthly',
      priority: 0.3,
    },
    { url: `${BASE}/ai-disclosure`, lastModified: now, changeFrequency: 'monthly', priority: 0.3 },
  ];
}
