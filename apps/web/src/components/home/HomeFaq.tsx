'use client';

import { useState } from 'react';

const faqs = [
  {
    q: 'Чем вы лучше Replicate или Hugging Face?',
    a: 'Основное — оплата рублёвой картой РФ, счетами для юрлиц и работа без VPN. Плюс OpenAI-совместимый API (drop-in замена), latency из РФ-региона < 100ms, и уникальный механизм open contests: ML-инженеры публикуют кастомные модели, получают 70% с подписок.',
  },
  {
    q: 'Как подключить модель за 2 минуты?',
    a: 'Регистрация через Яндекс/VK/email. Пополнение баланса через СБП (мгновенно) или Т-Банк. Получаете ключ sk_aiag_live_..., меняете base_url в OpenAI SDK на api.ai-aggregator.ru/v1 — и всё работает.',
  },
  {
    q: 'Что с безопасностью данных?',
    a: 'Запросы шифруются по TLS 1.3. Модели с отметкой Private не логируют content на стороне провайдера. Для бизнес-клиентов — NDA, договор с 152-ФЗ, on-premise-опция по договору.',
  },
  {
    q: 'Что если модель сломается или провайдер отвалится?',
    a: 'Uptime SLA 99.9% с компенсацией. Для топ-моделей — fallback на резервный провайдер с той же ценой (прозрачно для API). Статус инцидентов — на status.ai-aggregator.ru.',
  },
  {
    q: 'Как выплаты ML-инженерам за опубликованные модели?',
    a: '70% с API-выручки — автору модели. Выплаты от 1 000 ₽ на карту или по договору ГПХ. Публикация через open contest: submit → auto-eval → live за 48 часов. Earnings виден в dashboard в реальном времени.',
  },
];

export default function HomeFaq() {
  const [openIdx, setOpenIdx] = useState<number | null>(0);

  return (
    <div className="max-w-[820px] mx-auto">
      {faqs.map((item, i) => {
        const open = openIdx === i;
        return (
          <div
            key={i}
            className="mb-2.5 overflow-hidden rounded transition-colors"
            style={{
              border: `1px solid ${open ? 'var(--line-strong)' : 'var(--line)'}`,
              background: 'var(--bg-elev)',
            }}
          >
            <button
              type="button"
              onClick={() => setOpenIdx(open ? null : i)}
              className="flex items-center justify-between w-full text-left px-[22px] py-[18px] text-[15px] font-medium"
            >
              <span>{item.q}</span>
              <span
                className="grid place-items-center transition-transform duration-300"
                style={{
                  width: 20,
                  height: 20,
                  color: open ? 'var(--accent)' : 'var(--ink-muted)',
                  transform: open ? 'rotate(180deg)' : 'rotate(0)',
                }}
              >
                ▼
              </span>
            </button>
            <div
              className="overflow-hidden transition-[max-height]"
              style={{ maxHeight: open ? 400 : 0, transitionDuration: '400ms' }}
            >
              <div
                className="px-[22px] pb-5 text-[14px] leading-[1.65]"
                style={{ color: 'var(--ink-muted)' }}
              >
                {item.a}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
