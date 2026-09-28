import { LegalPageShell } from '@/components/layout/LegalPageShell';

export const metadata = {
  title: 'Договор с авторами моделей — AI-Aggregator',
};

export default async function AuthorAgreementPage({
  searchParams: searchParamsPromise,
}: {
  searchParams: Promise<{ type?: string }>;
}) {
  const searchParams = await searchParamsPromise;
  const type = searchParams?.type === 'exclusive' ? 'exclusive' : 'standard';

  return (
    <LegalPageShell
      title="Договор с авторами моделей"
      version={`stub-${type}-2026-04-24`}
      publishedAt="2026-04-24"
    >
      <div className="mb-6 flex gap-2">
        <a
          href="?type=standard"
          className={
            'rounded-md border px-3 py-1.5 text-sm ' +
            (type === 'standard' ? 'bg-primary text-primary-foreground' : '')
          }
        >
          Стандартный (70/75/80%)
        </a>
        <a
          href="?type=exclusive"
          className={
            'rounded-md border px-3 py-1.5 text-sm ' +
            (type === 'exclusive' ? 'bg-primary text-primary-foreground' : '')
          }
        >
          Эксклюзив (85%)
        </a>
      </div>

      <section className="space-y-4">
        <p className="rounded-md border border-amber-500/50 bg-amber-500/10 p-4 text-sm">
          <strong>Черновик.</strong> Финальные формы будут утверждены юристом.
        </p>

        <h2>1. Предмет</h2>
        <p>
          Автор предоставляет Платформе неисключительную
          {type === 'exclusive' ? ' (эксклюзивную)' : ''} лицензию на размещение и коммерческую
          эксплуатацию его AI-модели на сервисе AI-Aggregator.
        </p>

        <h2>2. Revenue Share</h2>
        <p>
          {type === 'exclusive' ? (
            <>Эксклюзивный тариф: <strong>85%</strong> дохода от каждого вызова модели
            перечисляется автору за вычетом комиссии платёжной системы и налога.</>
          ) : (
            <>
              Стандартный тариф (ступенчатый от месячной выручки):
              <br />— до 100 000 ₽/мес: <strong>70%</strong>
              <br />— 100 001 – 500 000 ₽/мес: <strong>75%</strong>
              <br />— от 500 001 ₽/мес: <strong>80%</strong>
            </>
          )}
        </p>

        <h2>3. Выплаты</h2>
        <p>
          Выплаты производятся ежемесячно, 10-го числа, на реквизиты самозанятого / ИП /
          физлица. Минимальная сумма выплаты — 1 000 ₽. Декларирование налогов — ответственность
          Автора (НДФЛ 13% / НПД 4-6% / УСН 6%).
        </p>

        <h2>4. Гарантии Автора</h2>
        <ul>
          <li>Модель обучена на данных, допускающих коммерческое использование.</li>
          <li>Модель не содержит закладок, вредоносного кода, скрытого сбора данных.</li>
          <li>Автор обладает правами на все weights и training code, переданные Платформе.</li>
        </ul>

        <h2>5. Kill-switch</h2>
        <p>
          Платформа оставляет за собой право немедленно снять модель с публикации при
          подтверждённых нарушениях (CSAM, экстремизм, системные сбои) с последующей выплатой
          уже начисленного revenue share.
        </p>

        <h2>6. Расторжение</h2>
        <p>
          Любая сторона вправе расторгнуть договор с уведомлением за 30 дней. Начисленные
          revenue-share выплачиваются в ближайший расчётный период.
        </p>
      </section>
    </LegalPageShell>
  );
}
