'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Lock } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { Alert, AlertDescription } from '@/components/ui/Alert';
import { Card, CardContent } from '@/components/ui/Card';

const ERROR_MESSAGES: Record<string, string> = {
  invalid: 'Неверный email или пароль.',
  not_admin: 'Этот аккаунт не имеет роли admin.',
  inactive: 'Аккаунт заблокирован.',
  internal: 'Внутренняя ошибка. Попробуйте позже.',
};

export default function AdminLoginForm({ error: initialError }: { error: string | null }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const error = formError ?? (initialError ? ERROR_MESSAGES[initialError] ?? 'Ошибка входа.' : null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFormError(null);
    setLoading(true);
    const fd = new FormData(e.currentTarget);
    const email = String(fd.get('email') ?? '');
    const password = String(fd.get('password') ?? '');
    try {
      const res = await fetch('/api/admin/auth', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setFormError(ERROR_MESSAGES[data.error ?? 'internal'] ?? 'Ошибка входа.');
        setLoading(false);
        return;
      }
      router.replace('/admin');
    } catch {
      setFormError('Сеть недоступна. Попробуйте снова.');
      setLoading(false);
    }
  }

  return (
    <Card className="shadow-lg">
      <CardContent className="p-6 flex flex-col gap-4">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="email">Email</Label>
            <Input id="email" name="email" type="email" autoComplete="email" required />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="password">Пароль</Label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </div>
          <Button type="submit" disabled={loading} className="w-full mt-2" size="lg" leftIcon={loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock className="h-4 w-4" />}>
            {loading ? 'Проверяем…' : 'Войти в админку'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
