'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import { ConsentCheckbox } from '@/components/ConsentCheckbox';
import { Badge } from '@/components/ui/Badge';
import { FormWizard, WizardStep } from '@/components/ui/FormWizard';

type HostedBy = 'platform' | 'author';

export default function SubmitModelForm() {
  const router = useRouter();
  const [name, setName] = React.useState('');
  const [slug, setSlug] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [contestSubmissionId, setContestSubmissionId] =
    React.useState<string>('');
  const [hostedBy, setHostedBy] = React.useState<HostedBy>('platform');
  const [exclusive, setExclusive] = React.useState(false);
  const [endpointUrl, setEndpointUrl] = React.useState('');
  const [authToken, setAuthToken] = React.useState('');
  const [authHeader, setAuthHeader] = React.useState('Authorization');
  const [pricingHint, setPricingHint] = React.useState('');
  const [termsAccepted, setTermsAccepted] = React.useState(false);

  const tierPct = React.useMemo(() => {
    if (hostedBy === 'author' && exclusive) return 85;
    if (hostedBy === 'author') return 80;
    return 70;
  }, [hostedBy, exclusive]);

  async function handleSubmit() {
    const res = await fetch('/api/models/request-publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name,
        slug,
        description,
        contestSubmissionId: contestSubmissionId || null,
        hostedBy,
        exclusive,
        endpointUrl,
        authToken,
        authHeader,
        pricingHintPerRequestRub: parseFloat(pricingHint) || null,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body?.error?.message || 'Ошибка отправки');
    }
    router.push('/dashboard/models?submitted=1');
    router.refresh();
  }

  return (
    <FormWizard
      onSubmit={handleSubmit}
      submitLabel="Отправить на модерацию"
      hint="4 шага — описание модели, технические параметры, условия публикации."
    >
      <WizardStep title="Описание">
        <div className="space-y-4">
          <div>
            <Label htmlFor="sub-id">
              Из конкурса (submission ID, необязательно)
            </Label>
            <Input
              id="sub-id"
              value={contestSubmissionId}
              onChange={(e) => setContestSubmissionId(e.target.value)}
              placeholder="uuid submission из топа конкурса"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Оставьте пустым, если модель не связана с конкурсом.
            </p>
          </div>
        </div>
      </WizardStep>

      <WizardStep
        title="Метаданные"
        validate={() => {
          if (!name.trim()) return 'Укажите название';
          if (!slug.trim()) return 'Укажите slug';
          if (!/^[a-z0-9-]+$/.test(slug)) return 'Slug — только латиница, цифры и дефисы';
          if (!description.trim()) return 'Укажите описание';
          return true;
        }}
      >
        <div className="space-y-4">
          <div>
            <Label htmlFor="m-name">Название</Label>
            <Input
              id="m-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>
          <div>
            <Label htmlFor="m-slug">Slug (URL-идентификатор)</Label>
            <Input
              id="m-slug"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              required
              pattern="[a-z0-9-]+"
              placeholder="medner-ru-v2"
            />
          </div>
          <div>
            <Label htmlFor="m-desc">Описание</Label>
            <Input
              id="m-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              required
              placeholder="NER модель для медицинских анамнезов"
            />
          </div>
        </div>
      </WizardStep>

      <WizardStep
        title="Технические параметры"
        validate={() => {
          if (!endpointUrl.trim()) return 'Укажите Endpoint URL';
          if (!authToken.trim()) return 'Укажите Token';
          return true;
        }}
      >
        <div className="space-y-4">
          <div>
            <Label htmlFor="m-endpoint">Endpoint URL</Label>
            <Input
              id="m-endpoint"
              type="url"
              value={endpointUrl}
              onChange={(e) => setEndpointUrl(e.target.value)}
              required
              placeholder="https://api.example.com/v1/predict"
            />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <Label htmlFor="m-header">Заголовок авторизации</Label>
              <Input
                id="m-header"
                value={authHeader}
                onChange={(e) => setAuthHeader(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="m-token">Token</Label>
              <Input
                id="m-token"
                type="password"
                value={authToken}
                onChange={(e) => setAuthToken(e.target.value)}
                required
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Token шифруется AES-256-GCM перед сохранением. Расшифровка только в
            gateway при форвардинге запроса.
          </p>
          <div>
            <Label htmlFor="m-price">
              Ориентировочная цена за запрос (RUB, подсказка)
            </Label>
            <Input
              id="m-price"
              type="number"
              step="0.0001"
              min="0"
              value={pricingHint}
              onChange={(e) => setPricingHint(e.target.value)}
              placeholder="0.50"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Финальную цену установит админ при approve.
            </p>
          </div>
        </div>
      </WizardStep>

      <WizardStep
        title="Условия"
        validate={() => {
          if (!termsAccepted) return 'Подтвердите согласие с договором автора';
          return true;
        }}
      >
        <div className="space-y-4">
          <div>
            <Label htmlFor="m-host">Тип хостинга</Label>
            <Select
              value={hostedBy}
              onValueChange={(v) => setHostedBy(v as HostedBy)}
            >
              <SelectTrigger id="m-host">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="platform">
                  Платформа хостит (Path 1 / Fal.ai) — 70%
                </SelectItem>
                <SelectItem value="author">
                  Автор хостит (pass-through) — 80%
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          {hostedBy === 'author' && (
            <ConsentCheckbox
              id="exclusive"
              checked={exclusive}
              onChange={setExclusive}
              label="Эксклюзивно (12 мес) — revshare 85%"
            />
          )}

          <div className="p-4 rounded-lg bg-muted/50 border">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium">Ваш revshare tier</span>
              <Badge variant="default">{tierPct}%</Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              {tierPct === 70 &&
                'Baseline. Повышается до 75% автоматически после 3 месяцев подряд с выручкой >100 000 ₽.'}
              {tierPct === 80 && 'Self-hosted, вы держите endpoint сами.'}
              {tierPct === 85 &&
                'Эксклюзивный self-hosted на 12 месяцев — наивысший tier.'}
            </p>
          </div>

          <ConsentCheckbox
            id="terms"
            checked={termsAccepted}
            onChange={setTermsAccepted}
            required
            detailsHref="/docs/legal/author-standard"
            label={
              exclusive
                ? 'Согласен с эксклюзивным договором автора (12 мес)'
                : 'Согласен со стандартным договором автора'
            }
          />
        </div>
      </WizardStep>
    </FormWizard>
  );
}
