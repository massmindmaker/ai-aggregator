/**
 * Plan 08 Task 2b (C3) — DPO (ответственный за обработку ПДн) footer strip.
 * Вставляется в MainLayout — site-wide. ФЗ-152 ст.22.1 требует публикации контакта.
 */
export function DpoFooter() {
  const email = process.env.NEXT_PUBLIC_DPO_EMAIL ?? 'dpo@ai-aggregator.ru';
  return (
    <div className="border-t bg-muted/50 px-4 py-3 text-center text-xs text-muted-foreground">
      Ответственный за обработку персональных данных:{' '}
      <a href={`mailto:${email}`} className="underline hover:text-foreground">
        {email}
      </a>
    </div>
  );
}
