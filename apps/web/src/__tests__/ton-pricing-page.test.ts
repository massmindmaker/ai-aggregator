import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { render } from '@testing-library/react';
import PricingClient from '@/app/pricing/PricingClient';
import type { GramPricingView } from '@/lib/ton-wallet/pricing-packages';

const view: GramPricingView = {
  packages: [
    { id: 'credit-1200', label: 'Basic — 1 200 кредитов', credits: '1 200', amountAtomic: '2400000000', grams: '2.4' },
  ],
  fxSource: 'coingecko:the-open-network', fxExpiresAtMs: 1, stale: false, testnet: true,
};

describe('pricing storefront (task 4)', () => {
  it('renders gram package cards without ruble signs', () => {
    const { container } = render(createElement(PricingClient, { isLoggedIn: false, view }));
    expect(container.textContent).toContain('2.4');
    expect(container.textContent).toContain('GRAM');
    expect(container.textContent).not.toContain('₽');
    expect(container.textContent).not.toContain('рубл');
  });
  it('renders the no-packages fallback without crashing', () => {
    const { container } = render(createElement(PricingClient, { isLoggedIn: false, view: null }));
    expect(container.textContent).toContain('Пополнить');
  });
  it('marks stale fx honestly', () => {
    const { container } = render(createElement(PricingClient, { isLoggedIn: false, view: { ...view, stale: true } }));
    expect(container.textContent).toContain('Курс обновляется');
  });
});
