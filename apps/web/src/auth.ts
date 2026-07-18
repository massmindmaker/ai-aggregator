import NextAuth from 'next-auth';
import { DrizzleAdapter } from '@auth/drizzle-adapter';
import GitHub from 'next-auth/providers/github';
import Google from 'next-auth/providers/google';
import Yandex from 'next-auth/providers/yandex';
import VK from 'next-auth/providers/vk';
import Credentials from 'next-auth/providers/credentials';
import { db } from './lib/db';
import {
  users,
  accounts,
  sessions,
  verificationTokens,
} from '@aiag/database/schema';
import { eq } from '@aiag/database';
import bcrypt from 'bcryptjs';

// Adapter must be attached lazily — at build-time DATABASE_URL is unset and
// DrizzleAdapter(db) eagerly touches the lazy db Proxy, which throws
// "Database not initialized" and fails Next page-data collection on every
// route that imports @/auth (e.g. via requireAdmin in @/lib/admin/guard).
// JWT session strategy doesn't need the adapter for build-time analysis.
//
// Explicit table mapping is required: our DB has plural snake_case tables
// (users, accounts, sessions, verification_tokens) but DrizzleAdapter's
// defaults assume singular camelCase (account, session, user) and would
// fail with `relation "account" does not exist` on every OAuth callback —
// the actual cause of the user-facing "Configuration" error on /login.
const adapter =
  typeof process !== 'undefined' && process.env.DATABASE_URL
    ? // The adapter's strict generic shape expects "default" Auth.js columns;
      // our `users` table carries extra app columns (role, kyc_*, consent_*…)
      // that don't fit. The adapter still works at runtime — it only reads
      // the columns it needs. Cast through unknown to bypass the structural check.
      DrizzleAdapter(db, {
        usersTable: users as unknown as never,
        accountsTable: accounts as unknown as never,
        sessionsTable: sessions as unknown as never,
        verificationTokensTable: verificationTokens as unknown as never,
      })
    : undefined;

export const { handlers, signIn, signOut, auth } = NextAuth({
  adapter,
  trustHost: true,
  session: {
    strategy: 'jwt',
  },
  pages: {
    signIn: '/login',
    signOut: '/logout',
    error: '/login',
    // newUser intentionally omitted — there is no /onboarding page yet, so a
    // redirect there gives 404 on first OAuth login. NextAuth defaults to the
    // configured callbackUrl (/dashboard) without it.
  },
  providers: [
    // ── TRANSITIONAL: GitHub + Google are kept SERVER-SIDE ON PURPOSE ──────
    // Google/GitHub are blocked in RU, so their sign-in BUTTONS were removed
    // from /login and /register — no new user can register through them.
    //
    // But the providers must NOT be deleted from this config yet. Prod fact
    // (2026-07-14): 26 users authenticate via Google and 2 via GitHub, and
    // they have NO other way in — no password hash, no second linked provider.
    // Removing the provider here would lock all 28 out of their accounts.
    //
    // So this is a soft migration:
    //   1. UI is Yandex + email/password only (new signups).
    //   2. These two providers stay reachable via a direct callback so the
    //      existing 28 can still sign in, then set a password (/forgot-password)
    //      or link Yandex.
    //   3. Deleting GitHub/Google from this array is a SEPARATE, LATER step —
    //      only once those 28 accounts have an alternative credential.
    // Do not "clean this up" without checking that count against prod.
    // ──────────────────────────────────────────────────────────────────────
    GitHub({
      clientId: process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET,
    }),
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    }),
    Yandex({
      clientId: process.env.YANDEX_CLIENT_ID,
      clientSecret: process.env.YANDEX_CLIENT_SECRET,
    }),
    VK({
      clientId: process.env.VK_CLIENT_ID,
      clientSecret: process.env.VK_CLIENT_SECRET,
    }),
    Credentials({
      name: 'credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) {
          return null;
        }

        const email = credentials.email as string;
        const password = credentials.password as string;

        const user = await db.query.users.findFirst({
          where: eq(users.email, email),
        });

        if (!user || !user.passwordHash) {
          return null;
        }

        const isValidPassword = await bcrypt.compare(password, user.passwordHash);
        if (!isValidPassword) {
          return null;
        }

        // Mirrors the admin step-up check in api/admin/auth/route.ts: a
        // banned or deactivated user must be refused login the same way a
        // wrong password is — returning null fails the credentials grant
        // without leaking which check tripped.
        if (user.isBanned || user.isActive === false) {
          return null;
        }

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          image: user.image,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user, trigger, session }) {
      if (user) {
        token.id = user.id;
        // Lookup role once on sign-in so server components can show admin
        // affordances (e.g. "Админка" link in header) without each request
        // querying the DB. Refresh on session update if the trigger fires.
        try {
          const u = await db.query.users.findFirst({
            where: eq(users.id, user.id as string),
            columns: { role: true },
          });
          token.role = u?.role ?? 'user';
        } catch {
          token.role = 'user';
        }
      }

      if (trigger === 'update' && session) {
        token.name = session.name;
        token.image = session.image;
      }

      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
        session.user.role = (token.role as string | undefined) ?? 'user';
      }
      return session;
    },
  },
});

// Type augmentation for session
declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      name?: string | null;
      email?: string | null;
      image?: string | null;
      role?: string;
    };
  }
}

// (JWT shape is augmented via the Session type — next-auth/jwt module
// augmentation is not used here to avoid version-mismatch resolution issues.)
