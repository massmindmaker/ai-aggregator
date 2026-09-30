import { db, sql } from '@/lib/db';
import type { Mode } from '@/lib/dashboard/mode';

export interface OverviewTile {
  label: string;
  value: string;
  sublabel?: string;
  href?: string;
  cta?: string;
}

export interface RecentCall {
  id: string;
  created_at: string;
  model: string | null;
  endpoint: string | null;
  tokens: number | null;
  status: string | null;
}

export interface Overview {
  tiles: OverviewTile[];
  recent: RecentCall[];
  planName: string;
}

interface CountRow {
  c: string;
}
interface SubRow {
  plan_name: string | null;
  credits_limit: string | null;
  credits_used: string | null;
}

async function fetchCount(query: ReturnType<typeof sql>): Promise<number> {
  try {
    const r = await db.execute(query);
    const rows = ((r as unknown as { rows?: unknown[] }).rows ?? r) as CountRow[];
    return rows[0] ? Number(rows[0].c) : 0;
  } catch {
    return 0;
  }
}

export async function fetchOverview(userId: string, mode: Mode): Promise<Overview> {
  // Subscription / plan — LEFT JOIN, may be null.
  // Schema may not have plan_name/credits_limit columns; coalesce defensively.
  let sub: SubRow = { plan_name: 'Free', credits_limit: null, credits_used: null };
  try {
    const subRes = await db.execute(sql`
      SELECT
        COALESCE(s.plan_name, 'Free') AS plan_name,
        s.credits_limit::text AS credits_limit,
        s.credits_used::text AS credits_used
      FROM users u
      LEFT JOIN subscriptions s ON s.user_id = u.id AND s.status = 'active'
      WHERE u.id = ${userId}::uuid
      LIMIT 1
    `);
    const rows = (((subRes as unknown as { rows?: unknown[] }).rows ?? subRes) as SubRow[]);
    if (rows[0]) sub = rows[0];
  } catch {
    // schema mismatch — keep Free defaults
  }

  // API calls this month — gateway_requests (table name may not exist).
  const apiCalls = await fetchCount(sql`
    SELECT count(*)::text AS c
    FROM gateway_requests
    WHERE user_id = ${userId}::uuid
      AND created_at >= date_trunc('month', NOW())
  `);

  const myModelsLive = await fetchCount(sql`
    SELECT count(*)::text AS c FROM models
    WHERE author_user_id = ${userId}::uuid AND status = 'live'
  `);

  let recent: RecentCall[] = [];
  try {
    const recentRes = await db.execute(sql`
      SELECT id::text, created_at::text, model, endpoint, tokens, status
      FROM gateway_requests
      WHERE user_id = ${userId}::uuid
      ORDER BY created_at DESC
      LIMIT 5
    `);
    recent = (((recentRes as unknown as { rows?: unknown[] }).rows ?? recentRes) as RecentCall[]);
  } catch {
    recent = [];
  }

  const planName = sub.plan_name ?? 'Free';
  const limit = sub.credits_limit ? Number(sub.credits_limit) : null;
  const used = sub.credits_used ? Number(sub.credits_used) : 0;

  let tiles: OverviewTile[];
  if (mode === 'author') {
    tiles = [
      { label: 'Заработок (мес)', value: '— ₽', sublabel: 'появится после первой выплаты' },
      { label: 'Вызовы моих моделей', value: '—', sublabel: 'появится после live-модели' },
      {
        label: 'Опубликовано',
        value: String(myModelsLive),
        sublabel: myModelsLive === 0 ? 'нет live-моделей' : undefined,
        cta: myModelsLive === 0 ? 'Загрузить модель' : undefined,
        href: myModelsLive === 0 ? '/dashboard/models/new' : '/dashboard/models',
      },
      { label: 'Тариф', value: planName },
    ];
  } else {
    tiles = [
      {
        label: 'Кредиты',
        value: limit != null ? `${used} / ${limit}` : `${used}`,
        sublabel: limit != null ? 'в этом месяце' : 'нет тарифа',
      },
      {
        label: 'API-вызовы',
        value: String(apiCalls),
        sublabel: 'за этот месяц',
      },
      {
        label: 'Активные модели',
        value: '—',
        sublabel: 'модели вы используете',
      },
      { label: 'Тариф', value: planName },
    ];
  }

  return { tiles, recent, planName };
}
