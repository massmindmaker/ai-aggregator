'use client';

import { useState } from 'react';
import Link from 'next/link';
import { signOut } from 'next-auth/react';
import {
  Menu,
  X,
  LogOut,
  LayoutDashboard,
  Shield,
  User as UserIcon,
} from 'lucide-react';

interface Props {
  menu: { title: string; href: string }[];
  loggedIn: boolean;
  name: string | null;
  email: string;
  isAdmin: boolean;
}

export default function MainNavbarMobile({
  menu,
  loggedIn,
  name,
  email,
  isAdmin,
}: Props) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        aria-label="Открыть меню"
        className="lg:hidden p-2 rounded-md hover:bg-white/[0.04] transition-colors"
        onClick={() => setOpen(true)}
      >
        <Menu className="h-5 w-5" />
      </button>

      {open && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true">
          <div
            className="absolute inset-0 bg-black/70"
            onClick={() => setOpen(false)}
          />
          <aside
            className="absolute inset-y-0 end-0 w-72 border-s shadow-xl flex flex-col"
            style={{ background: 'var(--bg-elev)', borderColor: 'var(--line)' }}
          >
            <div
              className="flex items-center justify-between p-4 border-b"
              style={{ borderColor: 'var(--line)' }}
            >
              <span className="font-mono font-bold text-sm">
                ai<span style={{ color: 'var(--accent)' }}>-</span>aggregator
              </span>
              <button
                type="button"
                aria-label="Закрыть меню"
                className="p-2 rounded-md hover:bg-white/[0.04]"
                onClick={() => setOpen(false)}
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <ul className="flex flex-col p-2 flex-1">
              {menu.map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={() => setOpen(false)}
                    className="block px-4 py-3 text-sm hover:bg-white/[0.04] rounded"
                  >
                    {item.title}
                  </Link>
                </li>
              ))}
            </ul>
            <div
              className="p-4 border-t flex flex-col gap-2"
              style={{ borderColor: 'var(--line)' }}
            >
              {loggedIn ? (
                <>
                  <div className="px-1 pb-2 text-xs text-muted-foreground truncate">
                    {name || email}
                  </div>
                  <Link
                    href="/dashboard"
                    onClick={() => setOpen(false)}
                    className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold rounded-[2px] border"
                    style={{ borderColor: 'var(--line)' }}
                  >
                    <LayoutDashboard className="h-4 w-4" /> Dashboard
                  </Link>
                  <Link
                    href="/dashboard/profile"
                    onClick={() => setOpen(false)}
                    className="inline-flex items-center gap-2 px-4 py-2.5 text-sm rounded-[2px] border"
                    style={{ borderColor: 'var(--line)' }}
                  >
                    <UserIcon className="h-4 w-4" /> Профиль
                  </Link>
                  {isAdmin && (
                    <Link
                      href="/admin"
                      onClick={() => setOpen(false)}
                      className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold rounded-[2px] border"
                      style={{ borderColor: 'var(--accent)', color: 'var(--accent)' }}
                    >
                      <Shield className="h-4 w-4" /> Админка
                    </Link>
                  )}
                  <button
                    type="button"
                    onClick={() => signOut({ callbackUrl: '/' })}
                    className="inline-flex items-center gap-2 px-4 py-2.5 text-sm rounded-[2px] border text-left"
                    style={{ borderColor: 'var(--line)' }}
                  >
                    <LogOut className="h-4 w-4" /> Выйти
                  </button>
                </>
              ) : (
                <>
                  <Link
                    href="/login"
                    onClick={() => setOpen(false)}
                    className="inline-flex justify-center items-center px-4 py-2.5 text-sm font-semibold rounded-[2px] border"
                    style={{ borderColor: 'var(--line)' }}
                  >
                    Войти
                  </Link>
                  <Link
                    href="/register"
                    onClick={() => setOpen(false)}
                    className="inline-flex justify-center items-center px-4 py-2.5 text-sm font-semibold rounded-[2px]"
                    style={{ background: 'var(--accent)', color: '#000' }}
                  >
                    Регистрация
                  </Link>
                </>
              )}
            </div>
          </aside>
        </div>
      )}
    </>
  );
}
