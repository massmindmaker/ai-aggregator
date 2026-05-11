'use client';

import { SessionProvider } from 'next-auth/react';
import type { Session } from 'next-auth';
import { usePathname } from 'next/navigation';
import { Toaster } from '@/components/ui/Sonner';
import { OnboardingTour } from '@/components/onboarding/OnboardingTour';
import { CommandPalette } from '@/components/command/CommandPalette';

interface ProvidersProps {
  children: React.ReactNode;
  session?: Session | null;
}

export function Providers({ children, session }: ProvidersProps) {
  const path = usePathname();
  const showOnboarding =
    !path?.startsWith('/admin') && !path?.startsWith('/dashboard');

  return (
    <SessionProvider session={session}>
      {children}
      <Toaster position="top-right" richColors closeButton />
      {showOnboarding && <OnboardingTour />}
      <CommandPalette />
    </SessionProvider>
  );
}
