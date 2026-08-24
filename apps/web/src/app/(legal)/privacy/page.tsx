import { LegalLayout } from '@/components/legal/LegalLayout';

export const metadata = { title: 'Политика обработки ПДн — AI-Aggregator' };

const TOC = [
  { id: 'processing', label: '1. Категории ПДн' },
  { id: 'transborder', label: '2. Трансграничная передача' },
  { id: 'retention', label: '3. Сроки хранения' },
  { id: 'rights', label: '4. Ваши права' },
];

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <LegalLayout
        title="Политика обработки персональных данных"
        updated="2026-04-18"
        toc={TOC}
      >
        <p className="mb-6 text-muted-foreground">
          Редакция от 2026-04-18. Оператор: ИП Боборов, [ОГРНИП: заполняет основатель],
          [ИНН: заполняет основатель].
        </p>

        <h2 id="processing" className="text-xl font-semibold mt-8 mb-3">
          1. Категории обрабатываемых ПДн
        </h2>
        <p className="mb-4">
          Email, имя, IP-адрес, user-agent, содержимое API-запросов (prompts),
          платёжные данные (хешированные).
        </p>

        <h2 id="transborder" className="text-xl font-semibold mt-8 mb-3">
          2. Трансграничная передача
        </h2>
        <p className="mb-4">
          При использовании моделей, размещённых на зарубежных серверах
          (OpenAI, Anthropic и др.), ваши промпты могут передаваться в США
          или страны ЕС. Для критичных данных используйте модели с меткой
          🛡 «Хостинг РФ».
        </p>

        <h2 id="retention" className="text-xl font-semibold mt-8 mb-3">
          3. Сроки хранения
        </h2>
        <p className="mb-4">
          Логи запросов — 30 дней (по умолчанию, настраивается в
          /dashboard/settings). Персональные данные — до отзыва согласия.
        </p>

        <h2 id="rights" className="text-xl font-semibold mt-8 mb-3">
          4. Ваши права
        </h2>
        <p className="mb-4">
          Вы можете запросить удаление данных через
          support@ai-aggregator.ru или отозвать согласие в настройках
          профиля.
        </p>

        <p className="mt-10 text-xs text-muted-foreground">
          Эта страница — стартовая версия. Финальная редакция юриста — Plan 08.
        </p>
      </LegalLayout>
    </main>
  );
}
