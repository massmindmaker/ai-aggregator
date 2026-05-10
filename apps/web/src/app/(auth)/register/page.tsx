'use client';

import { useState, Suspense } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { signIn } from 'next-auth/react';
import { Eye, EyeOff, Github, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { Alert, AlertDescription } from '@/components/ui/Alert';
import { Card, CardContent } from '@/components/ui/Card';
import { ConsentCheckbox } from '@/components/ConsentCheckbox';
import { cn } from '@/lib/utils';

function RegisterForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get('callbackUrl') || '/dashboard';
  const error = searchParams.get('error');

  const [isLoading, setIsLoading] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    password: '',
    confirmPassword: '',
  });
  const [fieldErrors, setFieldErrors] = useState({
    name: '',
    email: '',
    password: '',
    confirmPassword: '',
  });
  const [consentProcessing, setConsentProcessing] = useState(false);
  const [consentTransborder, setConsentTransborder] = useState(false);
  const [consentMarketing, setConsentMarketing] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  const handleOAuthSignIn = async (provider: string) => {
    setIsLoading(provider);
    setFormError(null);
    try {
      await signIn(provider, { callbackUrl });
    } catch {
      setFormError('Что-то пошло не так. Пожалуйста, попробуйте снова.');
      setIsLoading(null);
    }
  };

  const validateForm = () => {
    const errors = { name: '', email: '', password: '', confirmPassword: '' };
    let isValid = true;

    if (!formData.name.trim()) {
      errors.name = 'Имя обязательно';
      isValid = false;
    } else if (formData.name.trim().length < 2) {
      errors.name = 'Имя должно содержать минимум 2 символа';
      isValid = false;
    }

    if (!formData.email.trim()) {
      errors.email = 'Email обязателен';
      isValid = false;
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) {
      errors.email = 'Некорректный email';
      isValid = false;
    }

    if (!formData.password) {
      errors.password = 'Пароль обязателен';
      isValid = false;
    } else if (formData.password.length < 8) {
      errors.password = 'Пароль должен содержать минимум 8 символов';
      isValid = false;
    }

    if (!formData.confirmPassword) {
      errors.confirmPassword = 'Подтвердите пароль';
      isValid = false;
    } else if (formData.password !== formData.confirmPassword) {
      errors.confirmPassword = 'Пароли не совпадают';
      isValid = false;
    }

    setFieldErrors(errors);
    return isValid;
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setFormError(null);

    if (!validateForm()) return;

    setIsLoading('credentials');

    try {
      const response = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formData.name,
          email: formData.email,
          password: formData.password,
          consentProcessing,
          consentTransborder,
          consentMarketing,
        }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        // API returns { error, details? } on errors and { message } on success.
        const detailMsg = Array.isArray(data?.details) && data.details[0]?.message;
        setFormError(data?.error || detailMsg || data?.message || 'Ошибка регистрации');
        setIsLoading(null);
        return;
      }

      const result = await signIn('credentials', {
        email: formData.email,
        password: formData.password,
        redirect: false,
      });

      if (result?.error) {
        setFormError('Регистрация успешна, но не удалось войти. Попробуйте войти вручную.');
        setIsLoading(null);
        setTimeout(() => router.push('/login'), 2000);
      } else {
        router.push(callbackUrl);
      }
    } catch {
      setFormError('Что-то пошло не так. Пожалуйста, попробуйте снова.');
      setIsLoading(null);
    }
  };

  const handleInputChange =
    (field: string) => (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value;
      setFormData((prev) => ({ ...prev, [field]: value }));
      if (fieldErrors[field as keyof typeof fieldErrors]) {
        setFieldErrors((prev) => ({ ...prev, [field]: '' }));
      }
    };

  return (
    <div className="w-full max-w-md px-2">
      <Card className="shadow-lg">
        <CardContent className="p-8">
          {(error || formError) && (
            <Alert variant="destructive" className="mb-6">
              <AlertDescription>
                {error === 'OAuthAccountNotLinked'
                  ? 'Этот email уже связан с другим аккаунтом.'
                  : formError || 'Произошла ошибка. Пожалуйста, попробуйте снова.'}
              </AlertDescription>
            </Alert>
          )}

          {/* OAuth Buttons */}
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
                    <path
                      d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                      fill="#4285F4"
                    />
                    <path
                      d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                      fill="#34A853"
                    />
                    <path
                      d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                      fill="#FBBC05"
                    />
                    <path
                      d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                      fill="#EA4335"
                    />
                  </svg>
                )
              }
            >
              Продолжить с Google
            </Button>
          </div>

          {/* Divider */}
          <div className="relative my-6">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t border-border" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-card px-2 text-muted-foreground">
                или продолжить с Email
              </span>
            </div>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="name">Имя</Label>
              <Input
                id="name"
                name="name"
                type="text"
                autoComplete="name"
                required
                value={formData.name}
                onChange={handleInputChange('name')}
                disabled={isLoading !== null}
                error={!!fieldErrors.name}
              />
              {fieldErrors.name && (
                <p className="text-xs text-destructive">{fieldErrors.name}</p>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                required
                value={formData.email}
                onChange={handleInputChange('email')}
                disabled={isLoading !== null}
                error={!!fieldErrors.email}
              />
              {fieldErrors.email && (
                <p className="text-xs text-destructive">{fieldErrors.email}</p>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="password">Пароль</Label>
              <Input
                id="password"
                name="password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="new-password"
                required
                value={formData.password}
                onChange={handleInputChange('password')}
                disabled={isLoading !== null}
                error={!!fieldErrors.password}
                rightIcon={
                  <button
                    type="button"
                    aria-label="переключить видимость пароля"
                    onClick={() => setShowPassword(!showPassword)}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    {showPassword ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                }
              />
              {fieldErrors.password && (
                <p className="text-xs text-destructive">{fieldErrors.password}</p>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="confirmPassword">Подтвердите пароль</Label>
              <Input
                id="confirmPassword"
                name="confirmPassword"
                type={showConfirmPassword ? 'text' : 'password'}
                autoComplete="new-password"
                required
                value={formData.confirmPassword}
                onChange={handleInputChange('confirmPassword')}
                disabled={isLoading !== null}
                error={!!fieldErrors.confirmPassword}
                rightIcon={
                  <button
                    type="button"
                    aria-label="переключить видимость пароля"
                    onClick={() =>
                      setShowConfirmPassword(!showConfirmPassword)
                    }
                    className="text-muted-foreground hover:text-foreground"
                  >
                    {showConfirmPassword ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                }
              />
              {fieldErrors.confirmPassword && (
                <p className="text-xs text-destructive">
                  {fieldErrors.confirmPassword}
                </p>
              )}
            </div>

            {/* 152-FZ Consents */}
            <div className="flex flex-col gap-3 mt-2">
              <ConsentCheckbox
                id="consent-processing"
                required
                checked={consentProcessing}
                onChange={setConsentProcessing}
                detailsHref="/privacy"
                label="Я даю согласие на обработку персональных данных в соответствии с 152-ФЗ"
              />
              <ConsentCheckbox
                id="consent-transborder"
                required
                checked={consentTransborder}
                onChange={setConsentTransborder}
                detailsHref="/privacy#transborder"
                label="Я даю согласие на трансграничную передачу данных (некоторые модели хостятся за рубежом)"
              />
              <ConsentCheckbox
                id="consent-marketing"
                checked={consentMarketing}
                onChange={setConsentMarketing}
                label="Я согласен(на) получать маркетинговые рассылки и новости (необязательно)"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Регистрируясь, вы также принимаете{' '}
                <Link
                  href="/terms"
                  className="text-primary hover:underline"
                >
                  Условия использования
                </Link>{' '}
                и{' '}
                <Link
                  href="/privacy"
                  className="text-primary hover:underline"
                >
                  Политику конфиденциальности
                </Link>
                .
              </p>
            </div>

            {/* Submit */}
            <Button
              type="submit"
              className={cn('w-full mt-2')}
              size="lg"
              disabled={
                isLoading !== null || !consentProcessing || !consentTransborder
              }
              loading={isLoading === 'credentials'}
            >
              Зарегистрироваться
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

function RegisterFormSkeleton() {
  return (
    <div className="w-full max-w-md px-2">
      <Card>
        <CardContent className="p-8">
          <div className="flex flex-col gap-3">
            {Array.from({ length: 8 }).map((_, i) => (
              <div
                key={i}
                className="h-12 rounded-md bg-muted animate-pulse"
              />
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default function RegisterPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background py-8">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <Link href="/" className="inline-block">
            <span className="text-3xl font-bold text-foreground">
              AI<span className="text-primary">AG</span>
            </span>
          </Link>
          <h1 className="mt-6 text-2xl font-semibold text-foreground">
            Создать аккаунт
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Уже есть аккаунт?{' '}
            <Link href="/login" className="text-primary hover:underline">
              Войти
            </Link>
          </p>
        </div>

        <Suspense fallback={<RegisterFormSkeleton />}>
          <RegisterForm />
        </Suspense>

        <p className="text-center text-xs text-muted-foreground mt-6">
          При регистрации вы соглашаетесь с нашими{' '}
          <Link href="/terms" className="text-primary hover:underline">
            Условиями использования
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
