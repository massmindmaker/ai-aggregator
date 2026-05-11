import * as React from 'react';
import { db, sql } from '@/lib/db';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { SettingsForm } from './SettingsForm';
import { SettingsTabs } from './SettingsTabs';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Настройки — AIAG Admin' };

async function fetchSettings(): Promise<Record<string, unknown>> {
  try {
    const r = await db.execute(sql`SELECT key, value FROM admin_settings`);
    const rows = ((r as unknown as { rows?: { key: string; value: unknown }[] }).rows ??
      (r as unknown as { key: string; value: unknown }[])) || [];
    const obj: Record<string, unknown> = {};
    for (const row of rows) obj[row.key] = row.value;
    return obj;
  } catch (e) {
    console.error(e);
    return {};
  }
}

export default async function AdminSettingsPage() {
  const settings = await fetchSettings();

  const pricing = (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Pricing</CardTitle>
      </CardHeader>
      <CardContent>
        <SettingsForm
          section="pricing"
          fields={[
            { key: 'fx_usd_rub', label: 'USD→RUB rate', type: 'text' },
            { key: 'default_cost_limit_per_key_rub', label: 'Default cost limit per key (₽/мес)', type: 'number' },
            { key: 'revshare_tiers', label: 'Revshare tiers (JSON)', type: 'json' },
          ]}
          values={settings}
        />
      </CardContent>
    </Card>
  );

  const features = (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Features</CardTitle>
      </CardHeader>
      <CardContent>
        <SettingsForm
          section="features"
          fields={[
            { key: 'feature_registration', label: 'Registration enabled', type: 'bool' },
            { key: 'feature_byok', label: 'BYOK enabled', type: 'bool' },
            { key: 'feature_playground', label: 'Playground enabled', type: 'bool' },
            { key: 'free_tier_credits_rub', label: 'Free credits on signup ₽', type: 'number' },
          ]}
          values={settings}
        />
      </CardContent>
    </Card>
  );

  const referrals = (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Реферальная программа</CardTitle>
      </CardHeader>
      <CardContent>
        <SettingsForm
          section="referrals"
          fields={[
            { key: 'referral_enabled', label: 'Реф. система включена', type: 'bool' },
            { key: 'referral_bonus_referrer_rub', label: 'Бонус рефереру ₽', type: 'number' },
            { key: 'referral_bonus_referred_rub', label: 'Бонус новому юзеру ₽', type: 'number' },
            { key: 'referral_qualifying_event', label: 'Qualifying event (json)', type: 'json' },
            { key: 'referral_min_topup_rub', label: 'Мин top-up для qualify ₽', type: 'number' },
            {
              key: 'referral_max_bonus_per_referrer_per_month_rub',
              label: 'Кэп ₽/мес/реферер',
              type: 'number',
            },
          ]}
          values={settings}
        />
      </CardContent>
    </Card>
  );

  const compliance = (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Compliance</CardTitle>
      </CardHeader>
      <CardContent>
        <SettingsForm
          section="compliance"
          fields={[
            { key: 'rkn_registration_number', label: 'РКН registration number', type: 'text' },
            { key: 'privacy_policy_version', label: 'Privacy policy version', type: 'text' },
            { key: 'maintenance_mode', label: 'Maintenance mode', type: 'bool' },
          ]}
          values={settings}
        />
      </CardContent>
    </Card>
  );

  return (
    <div className="container mx-auto px-4 py-8 max-w-4xl">
      <h1 className="text-3xl font-bold mb-2">Глобальные настройки</h1>
      <p className="text-sm text-muted-foreground mb-6">
        Изменения применяются мгновенно. Каждое изменение пишется в audit_log.
      </p>

      <SettingsTabs
        tabs={[
          { id: 'pricing', label: 'Pricing', content: pricing },
          { id: 'features', label: 'Features', content: features },
          { id: 'referrals', label: 'Рефералы', content: referrals },
          { id: 'compliance', label: 'Compliance', content: compliance },
        ]}
      />
    </div>
  );
}
