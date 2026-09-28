'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { ConsentCheckbox } from '@/components/ConsentCheckbox';
import { FormWizard, WizardStep } from '@/components/ui/FormWizard';

export default function SubmitModelForm() {
  const router = useRouter();
  const [name, setName] = React.useState('');
  const [slug, setSlug] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [endpointUrl, setEndpointUrl] = React.useState('');
  const [authToken, setAuthToken] = React.useState('');
  const [rightsConfirmed, setRightsConfirmed] = React.useState(false);

  async function handleSubmit() {
    const res = await fetch('/api/models/request-publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name,
        slug,
        description,
        hostedBy: 'author',
        endpointUrl,
        authToken,
        authHeader: 'Authorization',
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const messages: Record<string, string> = {
        INVALID_AUTHOR_SUBMISSION: 'Проверьте поля заявки.',
        INVALID_AUTHOR_ENDPOINT: 'Нужен публичный HTTPS endpoint /chat/completions.',
        SLUG_ALREADY_EXISTS: 'Этот slug уже занят.',
        AUTHOR_KEY_UNAVAILABLE: 'Подача заявок временно недоступна.',
      };
      throw new Error(messages[body?.error?.code] ?? 'Не удалось отправить заявку.');
    }
    router.push('/dashboard/models?submitted=1');
    router.refresh();
  }

  return (
    <FormWizard
      onSubmit={handleSubmit}
      submitLabel="Отправить на модерацию"
      hint="3 шага — описание, HTTPS endpoint и подтверждение прав. Публикация после проверки."
    >
      <WizardStep
        title="Описание"
        validate={() => {
          if (name.trim().length < 2) return 'Название: минимум 2 символа';
          if (slug.length < 3 || slug.length > 64 ||
              !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])$/.test(slug)) {
            return 'Slug: 3–64 символа, латиница, цифры и внутренние дефисы';
          }
          if (description.trim().length < 10) return 'Описание: минимум 10 символов';
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
              placeholder="https://api.example.com/v1/chat/completions"
            />
          </div>
          <div>
            <Label htmlFor="m-token">Bearer token</Label>
            <Input
              id="m-token"
              type="password"
              value={authToken}
              onChange={(e) => setAuthToken(e.target.value)}
              required
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Token шифруется перед сохранением. Модель останется недоступной до
            проверки endpoint и прав автора.
          </p>
        </div>
      </WizardStep>

      <WizardStep
        title="Права и проверка"
        validate={() => {
          if (!rightsConfirmed) return 'Подтвердите право отправить модель';
          return true;
        }}
      >
        <div className="space-y-4">
          <div className="p-4 rounded-lg bg-muted/50 border">
            <p className="text-xs text-muted-foreground">
              Это заявка на модерацию. Цена и доля автора будут согласованы
              отдельно до публикации и первых платных вызовов.
            </p>
          </div>

          <ConsentCheckbox
            id="author-rights"
            checked={rightsConfirmed}
            onChange={setRightsConfirmed}
            required
            label="Подтверждаю право отправить эту модель на проверку"
          />
        </div>
      </WizardStep>
    </FormWizard>
  );
}
