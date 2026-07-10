'use client';

import * as React from 'react';
import { Calculator } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/Card';
import { Label } from '@/components/ui/Label';
import { Input } from '@/components/ui/Input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import {
  estimateCost,
  formatRub,
  type UsageEstimate,
} from '@/lib/marketplace/pricing-calc';
import {
  getAllModels,
  MODEL_TYPE_LABEL_RU,
  type CatalogModel,
} from '@/lib/marketplace/catalog';

export function PricingCalculator({
  defaultSlug,
}: {
  defaultSlug?: string;
}) {
  const all = React.useMemo(() => getAllModels(), []);
  const [slug, setSlug] = React.useState<string>(
    defaultSlug ?? all[0]?.slug ?? '',
  );
  const model = React.useMemo(
    () => all.find((m) => m.slug === slug),
    [all, slug],
  );

  const [usage, setUsage] = React.useState<UsageEstimate>({
    requestsPerDay: 100,
    avgInputTokens: 500,
    avgOutputTokens: 800,
    imagesPerDay: 10,
    minutesPerDay: 30,
    secondsPerDay: 60,
  });

  const cost = model ? estimateCost(model, usage) : null;

  return (
    <Card>
      <CardContent className="p-6 space-y-6">
        <div className="flex items-center gap-2">
          <Calculator className="h-5 w-5 text-primary" aria-hidden />
          <h2 className="text-lg font-semibold">Калькулятор стоимости</h2>
        </div>

        <div className="space-y-2">
          <Label htmlFor="pc-model">Модель</Label>
          <Select value={slug} onValueChange={setSlug}>
            <SelectTrigger id="pc-model">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {all.map((m) => (
                <SelectItem key={m.slug} value={m.slug}>
                  {m.name} — {MODEL_TYPE_LABEL_RU[m.type]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {model && <InputsForModel model={model} usage={usage} setUsage={setUsage} />}

        {cost && (
          <div className="rounded-md border border-border p-4 space-y-2 bg-secondary/40">
            <div className="flex justify-between">
              <span className="text-muted-foreground text-sm">В день</span>
              <span className="font-mono font-semibold">
                {formatRub(cost.perDayRub)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground text-sm">В месяц (~30 д)</span>
              <span className="font-mono font-semibold text-lg text-primary">
                {formatRub(cost.perMonthRub)}
              </span>
            </div>
            <div className="pt-2 border-t border-border text-xs text-muted-foreground">
              Наценка шлюза уже включена в цену.
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function InputsForModel({
  model,
  usage,
  setUsage,
}: {
  model: CatalogModel;
  usage: UsageEstimate;
  setUsage: React.Dispatch<React.SetStateAction<UsageEstimate>>;
}) {
  const p = model.pricing;
  const set = (patch: Partial<UsageEstimate>) =>
    setUsage((prev) => ({ ...prev, ...patch }));

  if (p.inputPer1k !== undefined) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <NumField
          label="Запросов / день"
          value={usage.requestsPerDay ?? 0}
          onChange={(v) => set({ requestsPerDay: v })}
        />
        <NumField
          label="Input токенов / запрос"
          value={usage.avgInputTokens ?? 0}
          onChange={(v) => set({ avgInputTokens: v })}
        />
        <NumField
          label="Output токенов / запрос"
          value={usage.avgOutputTokens ?? 0}
          onChange={(v) => set({ avgOutputTokens: v })}
        />
      </div>
    );
  }
  if (p.perImage !== undefined) {
    return (
      <NumField
        label="Изображений / день"
        value={usage.imagesPerDay ?? 0}
        onChange={(v) => set({ imagesPerDay: v })}
      />
    );
  }
  if (p.perMinute !== undefined) {
    return (
      <NumField
        label="Минут аудио / день"
        value={usage.minutesPerDay ?? 0}
        onChange={(v) => set({ minutesPerDay: v })}
      />
    );
  }
  if (p.perSecond !== undefined) {
    return (
      <NumField
        label="Секунд видео / день"
        value={usage.secondsPerDay ?? 0}
        onChange={(v) => set({ secondsPerDay: v })}
      />
    );
  }
  return null;
}

function NumField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  const id = React.useId();
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        min={0}
        value={value}
        onChange={(e) => onChange(Number(e.target.value) || 0)}
      />
    </div>
  );
}
