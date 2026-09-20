import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import BillingPage from '@/app/dashboard/billing/page';

function jsonResponse(body: unknown) {
  return Promise.resolve({ ok: true, json: async () => body }) as Promise<Response>;
}

describe('billing refund balance status', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders pending reconciliation and debt as separate accessible facts', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.endsWith('/summary')) {
        return jsonResponse({
          plan: { name: 'Basic', creditsLimit: 1200 },
          balance: {
            totalSpendableCredits: 0,
            paygCredits: 2,
            subscriptionCredits: 1.5,
            refundDebtCredits: 0.25,
            refundPending: true,
          },
        });
      }
      if (url.endsWith('/payments')) return jsonResponse({ payments: [] });
      return jsonResponse({ autoTopup: null });
    });

    render(<BillingPage />);

    await screen.findByText('Итог возврата ещё не подтверждён. До завершения сверки кредиты временно недоступны.');
    expect(screen.getByRole('status')).toHaveTextContent('Итог возврата ещё не подтверждён');
    expect(screen.getByRole('alert')).toHaveTextContent('Задолженность: 0,25 кр.');
    expect(screen.getByLabelText('Статус возврата средств')).toHaveTextContent(
      'Учтено до блокировки: PAYG 2 кр., подписка 1,5 кр.'
    );
    await waitFor(() => expect(screen.getByText('0,00')).toBeInTheDocument());
  });

  it('shows loading without presenting fallback plan or balance facts', () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>(() => {}));

    render(<BillingPage />);

    expect(screen.getByRole('status')).toHaveTextContent('Загружаем данные биллинга');
    expect(screen.queryByText('Активная подписка')).not.toBeInTheDocument();
    expect(screen.queryByText('Баланс PAYG')).not.toBeInTheDocument();
  });

  it.each(['non-ok response', 'rejected fetch'])('shows a generic safe error for %s', async (failure) => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.endsWith('/summary')) {
        return failure === 'rejected fetch'
          ? Promise.reject(new Error('raw backend failure'))
          : Promise.resolve({ ok: false, status: 503 } as Response);
      }
      if (url.endsWith('/payments')) return jsonResponse({ payments: [] });
      return jsonResponse({ autoTopup: null });
    });

    render(<BillingPage />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Не удалось загрузить данные биллинга');
    expect(alert).not.toHaveTextContent('raw backend failure');
    expect(screen.queryByText('Активная подписка')).not.toBeInTheDocument();
    expect(screen.queryByText('Баланс PAYG')).not.toBeInTheDocument();
  });

  it('does not show refund warnings for an available balance', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.endsWith('/summary')) {
        return jsonResponse({
          plan: { name: 'Free', creditsLimit: null },
          balance: {
            totalSpendableCredits: 3.5,
            paygCredits: 2,
            subscriptionCredits: 1.5,
            refundDebtCredits: 0,
            refundPending: false,
          },
        });
      }
      if (url.endsWith('/payments')) return jsonResponse({ payments: [] });
      return jsonResponse({ autoTopup: null });
    });

    render(<BillingPage />);

    await waitFor(() => expect(screen.getByText('3,50')).toBeInTheDocument());
    expect(screen.queryByLabelText('Статус возврата средств')).not.toBeInTheDocument();
  });
});
