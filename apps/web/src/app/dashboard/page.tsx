import Link from 'next/link';
import { auth } from '@/auth';
import { redirect } from 'next/navigation';
import { resolveMode } from '@/lib/dashboard/mode';
import { fetchOverview } from '@/lib/dashboard/overview';
import { Card, CardContent } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { CountUp } from '@/components/ui/CountUp';

/**
 * Renders tile value. If string is purely numeric (with optional decimals)
 * or "N / M" form, animates via CountUp. Otherwise passes through.
 */
function TileValue({ value }: { value: string }) {
  const trimmed = value.trim();
  // pure integer or decimal
  const numMatch = /^(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (numMatch) {
    const decimals = numMatch[2]?.length ?? 0;
    return <CountUp end={Number(trimmed)} decimals={decimals} />;
  }
  // "used / limit" pattern
  const ratio = /^(\d+)\s*\/\s*(\d+)$/.exec(trimmed);
  if (ratio) {
    return (
      <>
        <CountUp end={Number(ratio[1])} /> / <CountUp end={Number(ratio[2])} />
      </>
    );
  }
  // "1234 ₽" (number + currency suffix)
  const numSuffix = /^(\d+(?:\.\d+)?)\s*(.+)$/.exec(trimmed);
  if (numSuffix) {
    const decimals = numSuffix[1].includes('.') ? numSuffix[1].split('.')[1].length : 0;
    return <CountUp end={Number(numSuffix[1])} decimals={decimals} suffix={` ${numSuffix[2]}`} />;
  }
  return <>{value}</>;
}

export const dynamic = 'force-dynamic';

interface SearchParams {
  mode?: string;
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const session = await auth();
  // Layout already gates, but be defensive.
  if (!session?.user?.id) redirect('/login?callbackUrl=/dashboard');

  const params = await searchParams;
  const mode = resolveMode(params.mode, '/dashboard');
  const data = await fetchOverview(session.user.id, mode);

  return (
    <section className="container mx-auto max-w-7xl px-6 py-10">
      <header className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Личный кабинет</h1>
          <p className="mt-1 text-muted-foreground text-sm">
            Обзор расходов, баланса и последних запросов
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            href="/dashboard/keys"
            className="inline-flex items-center gap-1.5 px-3 py-2 text-[13px] rounded-md border hover:bg-white/[0.04]"
            style={{ borderColor: 'var(--line)' }}
          >
            🔑 API-ключи
          </Link>
          <Link
            href="/dashboard/billing"
            className="inline-flex items-center gap-1.5 px-3 py-2 text-[13px] rounded-md font-semibold"
            style={{ background: 'var(--accent)', color: '#000' }}
          >
            + Пополнить
          </Link>
        </div>
      </header>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {data.tiles.map((t, i) => (
          <Card key={i}>
            <CardContent className="p-5 flex flex-col gap-1.5">
              <div className="text-xs uppercase tracking-wider text-muted-foreground">
                {t.label}
              </div>
              <div className="text-3xl font-bold tabular-nums">
                <TileValue value={t.value} />
              </div>
              {t.sublabel && (
                <div className="text-xs text-muted-foreground">{t.sublabel}</div>
              )}
              {t.cta && t.href && (
                <Link
                  href={t.href}
                  className="text-xs text-[var(--accent)] mt-1 hover:underline"
                >
                  {t.cta} →
                </Link>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardContent className="p-0">
          <div
            className="px-5 py-4 border-b flex items-center justify-between"
            style={{ borderColor: 'var(--line)' }}
          >
            <h2 className="text-lg font-semibold">Последние API-вызовы</h2>
          </div>
          {data.recent.length === 0 ? (
            <div className="px-5 py-12 text-center text-sm text-muted-foreground">
              Здесь появятся ваши API-вызовы.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-xs uppercase text-muted-foreground bg-muted/30">
                <tr>
                  <th className="px-5 py-3 text-left">Время</th>
                  <th className="px-5 py-3 text-left">Модель</th>
                  <th className="px-5 py-3 text-left">Endpoint</th>
                  <th className="px-5 py-3 text-right">Токены</th>
                  <th className="px-5 py-3 text-left">Статус</th>
                </tr>
              </thead>
              <tbody>
                {data.recent.map((r) => (
                  <tr key={r.id} className="border-t" style={{ borderColor: 'var(--line)' }}>
                    <td className="px-5 py-3 whitespace-nowrap font-mono text-xs text-muted-foreground">
                      {r.created_at?.slice(0, 19).replace('T', ' ') ?? ''}
                    </td>
                    <td className="px-5 py-3 font-mono text-xs">{r.model ?? '—'}</td>
                    <td className="px-5 py-3 font-mono text-xs text-muted-foreground">
                      {r.endpoint ?? '—'}
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums">{r.tokens ?? '—'}</td>
                    <td className="px-5 py-3">
                      <Badge
                        variant={
                          r.status === 'success' || r.status === 'ok'
                            ? ('success' as never)
                            : ('destructive' as never)
                        }
                      >
                        {r.status ?? '—'}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
