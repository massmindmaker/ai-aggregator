'use client';

import { SessionProvider } from 'next-auth/react';
import type { Session } from 'next-auth';
import { Toaster } from '@/components/ui/Sonner';

interface ProvidersProps {
  children: React.ReactNode;
  session?: Session | null;
}

export function Providers({ children, session }: ProvidersProps) {
  return (
    <SessionProvider session={session}>
      {children}
      <Toaster position="top-right" richColors closeButton />
    </SessionProvider>
  );
}
