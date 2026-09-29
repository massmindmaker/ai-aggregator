'use client';

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2, CheckCircle2 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { Button } from '@/components/ui/Button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import { Alert, AlertDescription } from '@/components/ui/Alert';

const modalities = [
  ['llm', 'Чат / LLM'],
  ['image', 'Изображения'],
  ['audio', 'Аудио'],
  ['text-to-speech', 'TTS — синтез речи'],
  ['video', 'Видео'],
  ['embedding', 'Эмбеддинги'],
  ['code', 'Код'],
  ['multimodal', 'Мультимодальные'],
] as const;

const regions = [
  ['ru', 'Россия'],
  ['eu', 'Европа'],
  ['us', 'США'],
  ['global', 'Не знаю / глобально'],
] as const;

const schema = z.object({
  modelName: z.string().trim().min(2, 'Минимум 2 символа').max(120),
  provider: z.string().trim().min(2, 'Минимум 2 символа').max(120),
  website: z
    .string()
    .trim()
    .url('Нужна валидная ссылка')
    .optional()
    .or(z.literal('')),
  modality: z.enum([
    'llm',
    'image',
    'audio',
    'video',
    'embedding',
    'code',
    'text-to-speech',
    'multimodal',
  ]),
  hostingRegion: z.enum(['ru', 'eu', 'us', 'global']).optional(),
  useCase: z
    .string()
    .trim()
    .min(10, 'Минимум 10 символов')
    .max(1200, 'Максимум 1200 символов'),
  contactEmail: z.string().trim().email('Нужен валидный email'),
  contactName: z.string().trim().min(2).max(120).optional(),
});

type FormValues = z.infer<typeof schema>;

export function ModelRequestForm() {
  const [submitted, setSubmitted] = React.useState(false);
  const [serverError, setServerError] = React.useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      modality: 'llm',
      hostingRegion: 'global',
    },
  });

  async function onSubmit(values: FormValues) {
    setServerError(null);
    try {
      const res = await fetch('/api/marketplace/model-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `Ошибка ${res.status}`);
      }
      setSubmitted(true);
    } catch (err) {
      setServerError(err instanceof Error ? err.message : 'Не удалось отправить');
    }
  }

  if (submitted) {
    return (
      <Card>
        <CardContent className="p-8 text-center space-y-3">
          <CheckCircle2 className="h-12 w-12 text-emerald-500 mx-auto" aria-hidden />
          <h2 className="text-xl font-semibold">Заявка отправлена</h2>
          <p className="text-muted-foreground">
            Спасибо! Мы посмотрим предложение и вернёмся по email в течение 1-2
            недель.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="p-6">
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
          <FieldRow>
            <Field label="Название модели" error={errors.modelName?.message}>
              <Input {...register('modelName')} placeholder="Llama 3 70B" />
            </Field>
            <Field label="Провайдер / автор" error={errors.provider?.message}>
              <Input {...register('provider')} placeholder="Meta" />
            </Field>
          </FieldRow>

          <Field label="Ссылка на модель / страницу" error={errors.website?.message}>
            <Input
              {...register('website')}
              placeholder="https://llama.meta.com"
              type="url"
            />
          </Field>

          <FieldRow>
            <Field label="Модальность" error={errors.modality?.message}>
              <Select
                value={watch('modality')}
                onValueChange={(v) => setValue('modality', v as FormValues['modality'])}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {modalities.map(([v, label]) => (
                    <SelectItem key={v} value={v}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Регион хостинга" error={errors.hostingRegion?.message}>
              <Select
                value={watch('hostingRegion')}
                onValueChange={(v) =>
                  setValue('hostingRegion', v as FormValues['hostingRegion'])
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {regions.map(([v, label]) => (
                    <SelectItem key={v} value={v}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </FieldRow>

          <Field
            label="Для чего нужна модель?"
            error={errors.useCase?.message}
            hint="Минимум 10 символов. Расскажите о задаче — это поможет приоритизировать заявку."
          >
            <textarea
              {...register('useCase')}
              rows={4}
              className="w-full resize-none bg-transparent rounded-md border border-border px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </Field>

          <FieldRow>
            <Field label="Ваше имя" error={errors.contactName?.message}>
              <Input {...register('contactName')} placeholder="Иван" />
            </Field>
            <Field label="Email для ответа" error={errors.contactEmail?.message}>
              <Input {...register('contactEmail')} type="email" />
            </Field>
          </FieldRow>

          {serverError && (
            <Alert variant="destructive">
              <AlertDescription>{serverError}</AlertDescription>
            </Alert>
          )}

          <div className="flex justify-end">
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting && (
                <Loader2 className="h-4 w-4 me-2 animate-spin" aria-hidden />
              )}
              Отправить заявку
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function FieldRow({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">{children}</div>;
}

function Field({
  label,
  error,
  hint,
  children,
}: {
  label: string;
  error?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  const id = React.useId();
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <div id={id}>{children}</div>
      {hint && !error && (
        <p className="text-xs text-muted-foreground">{hint}</p>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
