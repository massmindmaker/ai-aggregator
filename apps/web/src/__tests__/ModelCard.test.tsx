import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ModelCard, ModelGrid } from '@/components/marketplace/ModelCard';
import type { CatalogModel } from '@/lib/marketplace/catalog';

function makeModel(overrides: Partial<CatalogModel> = {}): CatalogModel {
  return {
    slug: 'openai/gpt-4-turbo',
    orgSlug: 'openai',
    orgName: 'OpenAI',
    modelSlug: 'gpt-4-turbo',
    name: 'GPT-4 Turbo',
    shortDescription: 'Test desc',
    description: 'Long desc',
    type: 'llm',
    hostingRegion: 'us',
    tags: ['текст', 'чат'],
    derivedTags: [],
    pricing: { inputPer1k: 1, outputPer1k: 2, unit: '1K токенов' },
    capabilities: {},
    stats: {
      avgRating: 4.5,
      totalReviews: 100,
      weeklyRequests: 1000,
      p50LatencyMs: 500,
      uptimePct: 99.9,
    },
    ...overrides,
  };
}

describe('ModelCard', () => {
  it('renders model name and links to detail page', () => {
    render(<ModelCard model={makeModel()} />);
    const link = screen.getByRole('link', { name: /gpt-4 turbo/i });
    expect(link.getAttribute('href')).toBe('/marketplace/openai/gpt-4-turbo');
  });

  it('shows transfer warning for foreign-hosted orgs', () => {
    render(<ModelCard model={makeModel({ orgSlug: 'openai', hostingRegion: 'us' })} />);
    expect(screen.getByLabelText(/трансгран/i)).toBeTruthy();
  });

  it('shows Hosting-RF badge for ru-hosted models', () => {
    render(
      <ModelCard
        model={makeModel({
          orgSlug: 'yandex',
          orgName: 'Yandex',
          hostingRegion: 'ru',
          slug: 'yandex/yandexgpt',
          modelSlug: 'yandexgpt',
        })}
      />,
    );
    expect(screen.getByLabelText(/Хостинг РФ/i)).toBeTruthy();
  });
});

describe('ModelGrid', () => {
  it('renders fallback when empty', () => {
    render(<ModelGrid items={[]} />);
    expect(screen.getByText(/Моделей не найдено/i)).toBeTruthy();
  });

  it('renders one card per item', () => {
    const items = [
      makeModel({ slug: 'a/1', modelSlug: '1' }),
      makeModel({ slug: 'a/2', modelSlug: '2', name: 'Second' }),
    ];
    render(<ModelGrid items={items} />);
    expect(screen.getAllByRole('link').length).toBe(2);
  });
});
