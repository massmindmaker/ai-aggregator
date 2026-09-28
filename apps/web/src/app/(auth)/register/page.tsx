'use client';

import { useState, Suspense } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { signIn } from 'next-auth/react';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { Alert, AlertDescription } from '@/components/ui/Alert';
import { Card, CardContent } from '@/components/ui/Card';
import { ConsentCheckbox } from '@/components/ConsentCheckbox';
import { cn } from '@/lib/utils';

// See apps/web/src/app/(auth)/login/page.tsx for why this is a build-time
// flag (NEXT_PUBLIC_* is inlined at `next build`, not read at runtime).
const ENABLE_YANDEX = process.env.NEXT_PUBLIC_ENABLE_YANDEX === '1';
const ENABLE_VK = process.env.NEXT_PUBLIC_ENABLE_VK === '1';

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
          {(ENABLE_YANDEX || ENABLE_VK) && (
            <>
              <div className="flex flex-col gap-3">
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
            </>
          )}

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
                Информация об обработке данных — в{' '}
                <Link href="/privacy" className="text-primary hover:underline">
                  Политике конфиденциальности
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
          Подробнее об обработке данных — в{' '}
          <Link href="/privacy" className="text-primary hover:underline">
            Политике конфиденциальности
          </Link>
        </p>
      </div>
    </div>
  );
}
