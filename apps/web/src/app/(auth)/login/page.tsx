'use client';

import { useState, Suspense } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { signIn } from 'next-auth/react';
import { Github, Mail, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { Alert, AlertDescription } from '@/components/ui/Alert';
import { Card, CardContent } from '@/components/ui/Card';

// NextAuth surfaces these via ?error= on /login. Keep messages user-readable
// and specific enough for the user to take action (not a generic "ошибка").
const AUTH_ERROR_MESSAGES: Record<string, string> = {
  Configuration:
    'Серверная ошибка конфигурации провайдера. Сообщите в поддержку.',
  AccessDenied: 'Доступ запрещён провайдером — повторите вход.',
  Verification: 'Ссылка для входа недействительна или просрочена.',
  OAuthSignin: 'Не удалось начать OAuth — провайдер недоступен.',
  OAuthCallback:
    'OAuth callback вернул ошибку. Часто это значит, что redirect URI у провайдера не совпадает с https://ai-aggregator.ru/api/auth/callback/<provider>.',
  OAuthCreateAccount:
    'Не удалось создать аккаунт через OAuth. Возможно, такой email уже есть.',
  EmailCreateAccount: 'Не удалось создать аккаунт по email-ссылке.',
  Callback: 'Ошибка callback NextAuth.',
  OAuthAccountNotLinked:
    'Этот email уже связан с другим способом входа. Войдите тем способом, которым регистрировались впервые.',
  EmailSignin: 'Не удалось отправить email-ссылку.',
  CredentialsSignin: 'Неверный email или пароль.',
  SessionRequired: 'Требуется вход.',
  Default: 'Произошла ошибка авторизации.',
};

const ENABLE_YANDEX = process.env.NEXT_PUBLIC_ENABLE_YANDEX === '1';
const ENABLE_VK = process.env.NEXT_PUBLIC_ENABLE_VK === '1';

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get('callbackUrl') || '/dashboard';
  const error = searchParams.get('error');

  const [isLoading, setIsLoading] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const handleOAuthSignIn = async (provider: string) => {
    setIsLoading(provider);
    setFormError(null);
    try {
      await signIn(provider, { callbackUrl });
    } catch {
      setFormError('Что-то пошло не так. Попробуйте снова.');
      setIsLoading(null);
    }
  };

  const handleCredentialsSignIn = async (
    e: React.FormEvent<HTMLFormElement>
  ) => {
    e.preventDefault();
    setIsLoading('credentials');
    setFormError(null);

    const formData = new FormData(e.currentTarget);
    const email = formData.get('email') as string;
    const password = formData.get('password') as string;

    try {
      const result = await signIn('credentials', {
        email,
        password,
        redirect: false,
      });
      if (result?.error) {
        setFormError('Неверный email или пароль');
        setIsLoading(null);
      } else {
        router.push(callbackUrl);
      }
    } catch {
      setFormError('Что-то пошло не так. Попробуйте снова.');
      setIsLoading(null);
    }
  };

  return (
    <Card className="shadow-lg">
      <CardContent className="p-8">
        {(error || formError) && (
          <Alert variant="destructive" className="mb-6">
            <AlertDescription>
              {formError ||
                (error
                  ? `${AUTH_ERROR_MESSAGES[error] ?? AUTH_ERROR_MESSAGES.Default} (код: ${error})`
                  : 'Произошла ошибка. Попробуйте снова.')}
            </AlertDescription>
          </Alert>
        )}

        <div className="flex flex-col gap-3">
          <Button
            type="button"
            variant="outline"
            className="w-full"
            onClick={() => handleOAuthSignIn('github')}
            disabled={isLoading !== null}
            leftIcon={
              isLoading === 'github' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Github className="h-4 w-4" />
              )
            }
          >
            Продолжить с GitHub
          </Button>
          <Button
            type="button"
            variant="outline"
            className="w-full"
            onClick={() => handleOAuthSignIn('google')}
            disabled={isLoading !== null}
            leftIcon={
              isLoading === 'google' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
                  <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                  <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
                  <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
                </svg>
              )
            }
          >
            Продолжить с Google
          </Button>
          {ENABLE_YANDEX && (
            <Button
              type="button"
              variant="outline"
              className="w-full"
              onClick={() => handleOAuthSignIn('yandex')}
              disabled={isLoading !== null}
              leftIcon={
                isLoading === 'yandex' ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden="true">
                    <path
                      fill="#FC3F1D"
                      d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm2.273 18.857h-2.04V8.32h-.91c-1.667 0-2.541.835-2.541 2.077 0 1.41.604 2.066 1.853 2.9l1.03.694-2.96 4.866H6.486l2.66-3.953c-1.531-1.094-2.39-2.16-2.39-3.957 0-2.252 1.567-3.787 4.55-3.787h2.967v11.697z"
                    />
                  </svg>
                )
              }
            >
              Продолжить с Яндекс
            </Button>
          )}
          {ENABLE_VK && (
            <Button
              type="button"
              variant="outline"
              className="w-full"
              onClick={() => handleOAuthSignIn('vk')}
              disabled={isLoading !== null}
              leftIcon={
                isLoading === 'vk' ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden="true">
                    <path
                      fill="#0077FF"
                      d="M12.785 16.241s.288-.032.435-.193c.135-.148.131-.427.131-.427s-.02-1.305.582-1.501c.594-.193 1.357 1.292 2.165 1.864.61.432 1.074.337 1.074.337l2.16-.03s1.13-.072.594-.972c-.044-.073-.312-.661-1.605-1.872-1.355-1.268-1.173-1.062.46-3.293 1-1.359 1.398-2.187 1.273-2.541-.119-.34-.866-.249-.866-.249l-2.485.015s-.184-.025-.32.058c-.135.083-.222.273-.222.273s-.385 1.041-.901 1.927c-1.084 1.866-1.518 1.965-1.696 1.848-.412-.27-.31-1.092-.31-1.674 0-1.823.274-2.583-.532-2.78-.267-.066-.464-.109-1.147-.116-.876-.009-1.617.003-2.038.211-.279.139-.495.448-.364.466.162.022.529.1.724.367.252.345.243 1.121.243 1.121s.144 2.13-.337 2.397c-.331.182-.785-.19-1.752-1.886-.495-.86-.869-1.81-.869-1.81s-.072-.179-.205-.275c-.16-.117-.385-.154-.385-.154l-2.36.015s-.355.011-.485.165c-.116.137-.009.422-.009.422S8.114 14.61 10.21 15.78c1.92 1.067 3.18.999 3.18.999h.395z"
                    />
                  </svg>
                )
              }
            >
              Продолжить с ВКонтакте
            </Button>
          )}
        </div>

        <div className="relative my-6">
          <div className="absolute inset-0 flex items-center">
            <span className="w-full border-t border-border" />
          </div>
          <div className="relative flex justify-center text-xs uppercase">
            <span className="bg-card px-2 text-muted-foreground">
              или продолжить с email
            </span>
          </div>
        </div>

        <form
          onSubmit={handleCredentialsSignIn}
          className="flex flex-col gap-4"
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              placeholder="you@example.com"
              disabled={isLoading !== null}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="password">Пароль</Label>
              <Link
                href="/forgot-password"
                className="text-xs text-muted-foreground hover:text-primary transition-colors"
              >
                Забыли пароль?
              </Link>
            </div>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              placeholder="••••••••"
              disabled={isLoading !== null}
            />
          </div>

          <Button
            type="submit"
            className="w-full mt-2"
            size="lg"
            disabled={isLoading !== null}
            loading={isLoading === 'credentials'}
            leftIcon={
              isLoading === 'credentials' ? undefined : (
                <Mail className="h-4 w-4" />
              )
            }
          >
            Войти с email
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function LoginFormSkeleton() {
  return (
    <Card>
      <CardContent className="p-8">
        <div className="flex flex-col gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="h-12 rounded-md bg-muted animate-pulse"
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export default function LoginPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background py-8 px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <Link href="/" className="inline-block">
            <span className="text-3xl font-mono font-bold tracking-tight">
              ai-aggregator<span className="text-primary">.ru</span>
            </span>
          </Link>
          <h1 className="mt-6 text-2xl font-semibold text-foreground">
            Войти в аккаунт
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Нет аккаунта?{' '}
            <Link href="/register" className="text-primary hover:underline">
              Зарегистрироваться
            </Link>
          </p>
        </div>

        <Suspense fallback={<LoginFormSkeleton />}>
          <LoginForm />
        </Suspense>

        <p className="text-center text-xs text-muted-foreground mt-6">
          Входя в систему, вы соглашаетесь с{' '}
          <Link href="/terms" className="text-primary hover:underline">
            Условиями
          </Link>{' '}
          и{' '}
          <Link href="/privacy" className="text-primary hover:underline">
            Политикой конфиденциальности
          </Link>
        </p>
      </div>
    </div>
  );
}
