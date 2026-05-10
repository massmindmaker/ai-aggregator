'use client';

import { useState, useRef, useEffect } from 'react';
import Link from 'next/link';
import { signOut } from 'next-auth/react';
import {
  LayoutDashboard,
  User,
  Shield,
  LogOut,
  ChevronDown,
} from 'lucide-react';

interface Props {
  name: string | null;
  email: string;
  image: string | null;
  isAdmin: boolean;
}

function initials(name: string | null, email: string): string {
  const src = (name || email).trim();
  const parts = src.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export default function UserMenu({ name, email, image, isAdmin }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, []);

  const display = name || email.split('@')[0];

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-2 px-3 py-2 text-[13px] font-medium rounded-[2px] border hover:bg-white/[0.04] transition-colors"
        style={{ borderColor: 'var(--line)' }}
      >
        {image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={image} alt="" className="h-6 w-6 rounded-full" />
        ) : (
          <span
            className="h-6 w-6 rounded-full text-black font-bold text-[11px] inline-flex items-center justify-center"
            style={{ background: 'var(--accent)' }}
          >
            {initials(name, email)}
          </span>
        )}
        <span className="hidden md:inline truncate max-w-[140px]">{display}</span>
        <ChevronDown className="h-3.5 w-3.5 opacity-60" />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-2 w-56 border rounded-md shadow-lg z-50 overflow-hidden"
          style={{ background: 'var(--bg-elev)', borderColor: 'var(--line)' }}
        >
          <Link
            href="/dashboard"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 px-3 py-2 text-[13px] hover:bg-white/[0.04]"
          >
            <LayoutDashboard className="h-4 w-4" /> Перейти в Dashboard
          </Link>
          <Link
            href="/dashboard/profile"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 px-3 py-2 text-[13px] hover:bg-white/[0.04]"
          >
            <User className="h-4 w-4" /> Профиль
          </Link>
          {isAdmin && (
            <Link
              href="/admin"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2 px-3 py-2 text-[13px] hover:bg-white/[0.04]"
              style={{ color: 'var(--accent)' }}
            >
              <Shield className="h-4 w-4" /> Админка
            </Link>
          )}
          <button
            type="button"
            onClick={() => signOut({ callbackUrl: '/' })}
            className="w-full text-left flex items-center gap-2 px-3 py-2 text-[13px] hover:bg-white/[0.04] border-t"
            style={{ borderColor: 'var(--line)' }}
          >
            <LogOut className="h-4 w-4" /> Выйти
          </button>
        </div>
      )}
    </div>
  );
}
