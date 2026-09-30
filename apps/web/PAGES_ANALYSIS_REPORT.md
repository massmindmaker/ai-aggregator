# AIAG Next.js Pages Analysis Report

Generated: 2025-12-09

> **STALE — historical snapshot, not a current state description.** The paths below
> (`C:/Users/bob/...`, MUI imports) no longer match the repo. Kept for provenance only.
> Contest-surface notes were removed on 2026-09-30: the contest contour moved to Arena
> and `/contests*` now 301-redirects to `/marketplace` (see `apps/web/next.config.mjs`).

## Executive Summary

**Total Pages Found**: 8 page routes + 2 API routes
**Critical Issues**: 3
**Missing Pages**: 6 referenced but not implemented
**Missing API Endpoints**: 1

---

## All Pages Found

### 1. `/` - Home Page
**File**: `C:/Users/bob/Projects/aiag/aiag-new/apps/web/src/app/page.tsx`
**Status**: Working
**Functionality**: Landing page with marketplace promotion, features section, API guides, contest guides

**Imports Status**:
- `@mui/material` - OK
- `@mui/material/styles` - OK
- `@mui/icons-material` - OK
- `next/link` - OK
- `@/components/layout/MainLayout` - OK

**Issues**: None

---

### 2. `/login` - Login Page
**File**: `C:/Users/bob/Projects/aiag/aiag-new/apps/web/src/app/(auth)/login/page.tsx`
**Status**: Working
**Functionality**: User login with email/password and OAuth (GitHub, Google)

**Imports Status**:
- `next-auth/react` - OK
- `lucide-react` - OK
- `@mui/material` - OK

**Issues**:
- Links to `/forgot-password` - **PAGE DOES NOT EXIST**
- Links to `/terms` - **PAGE DOES NOT EXIST**
- Links to `/privacy` - **PAGE DOES NOT EXIST**

---

### 3. `/register` - Registration Page
**File**: `C:/Users/bob/Projects/aiag/aiag-new/apps/web/src/app/(auth)/register/page.tsx`
**Status**: BROKEN
**Functionality**: User registration with form validation

**Imports Status**:
- `@mui/material` - OK
- `@mui/icons-material` - OK
- `next-auth/react` - OK

**Critical Issues**:
1. **MISSING API ENDPOINT**: Calls `/api/auth/register` but this endpoint DOES NOT EXIST
   - Line 128: `fetch('/api/auth/register', {...})`
   - Registration will fail with 404

2. Links to `/terms` - **PAGE DOES NOT EXIST**
3. Links to `/privacy` - **PAGE DOES NOT EXIST**

---

### 4. `/marketplace` - Marketplace Page
**File**: `C:/Users/bob/Projects/aiag/aiag-new/apps/web/src/app/(marketing)/marketplace/page.tsx`
**Status**: Partially Working
**Functionality**: AI models listing with search and filtering (uses mock data)

**Imports Status**:
- `@mui/material` - OK
- `@mui/icons-material` - OK
- `@/components/layout/MainLayout` - OK
- `next/link` - OK

**Critical Issues**:
1. **MISSING DYNAMIC ROUTES**: Links to `/marketplace/${ownerSlug}/${model.slug}` but NO dynamic route exists
   - Example: `/marketplace/openai/gpt-4-turbo` - **404**
   - No `[org]/[model]/page.tsx` or similar exists

2. Data is hardcoded mock data - no API integration

---

### 5. `/dashboard` - Dashboard Page
**File**: `C:/Users/bob/Projects/aiag/aiag-new/apps/web/src/app/dashboard/page.tsx`
**Status**: Working (Mock Data Only)
**Functionality**: User dashboard with token usage, API calls stats

**Imports Status**:
- `@mui/material` - OK
- `@mui/icons-material` - OK
- `@/components/layout/MainLayout` - OK

**Issues**:
- Uses hardcoded mock data
- No authentication protection
- No real API integration

---

### 6. `/docs` - Documentation Page
**File**: `C:/Users/bob/Projects/aiag/aiag-new/apps/web/src/app/docs/page.tsx`
**Status**: Working
**Functionality**: API documentation with code examples

**Imports Status**:
- `@mui/material` - OK
- `@mui/icons-material` - OK
- `@/components/layout/MainLayout` - OK

**Issues**: None - static content page

---

### 7. `/pricing` - Pricing Page
**File**: `C:/Users/bob/Projects/aiag/aiag-new/apps/web/src/app/pricing/page.tsx`
**Status**: Working
**Functionality**: Pricing tiers display with monthly/yearly toggle

**Imports Status**:
- `@mui/material` - OK
- `@/components/layout/MainLayout` - OK

**Issues**:
- Plan selection buttons don't link to checkout

---

## API Routes

### 1. `/api/auth/[...nextauth]`
**File**: `C:/Users/bob/Projects/aiag/aiag-new/apps/web/src/app/api/auth/[...nextauth]/route.ts`
**Status**: Working
**Dependencies**:
- `@/auth` - OK
- `@/lib/db` - OK (requires DATABASE_URL env)
- `@aiag/database` package - OK

---

### 2. `/api/webhooks/tinkoff`
**File**: `C:/Users/bob/Projects/aiag/aiag-new/apps/web/src/app/api/webhooks/tinkoff/route.ts`
**Status**: Working (requires env vars)
**Dependencies**:
- `@/lib/tinkoff` - OK
- `@/lib/db` - OK
- `@aiag/database` - OK
- `@aiag/tinkoff` - OK

---

## Missing Pages (Referenced but Not Implemented)

| Route | Referenced In | Priority |
|-------|--------------|----------|
| `/forgot-password` | Login page | HIGH |
| `/terms` | Login, Register pages | MEDIUM |
| `/privacy` | Login, Register pages | MEDIUM |
| `/marketplace/[org]/[model]` | Marketplace cards | CRITICAL |
| `/dashboard/request` | Home page | LOW |
| `/dashboard/api` | Home page | LOW |

---

## Missing API Endpoints

| Endpoint | Referenced In | Priority |
|----------|--------------|----------|
| `/api/auth/register` | Register page | CRITICAL |

---

## Component Dependencies

### MainLayout
**File**: `C:/Users/bob/Projects/aiag/aiag-new/apps/web/src/components/layout/MainLayout.tsx`
**Status**: Working
**Used By**: All main pages

### MainNavbar
**File**: `C:/Users/bob/Projects/aiag/aiag-new/apps/web/src/components/layout/MainNavbar.tsx`
**Status**: Working
**Issues**:
- _(2026-09-30) the old dead `/contests` link is gone; the surface now 301s to `/marketplace`_

### ThemeRegistry
**File**: `C:/Users/bob/Projects/aiag/aiag-new/apps/web/src/theme/ThemeRegistry.tsx`
**Status**: Working
**Used By**: Root layout

---

## Model/Algorithm Pages Issue

**Why model/algorithm pages don't work:**

1. The marketplace page at `/marketplace` displays model cards with links like:
   ```
   /marketplace/${ownerSlug}/${model.slug}
   ```
   Examples:
   - `/marketplace/openai/gpt-4-turbo`
   - `/marketplace/anthropic/claude-35-sonnet`
   - `/marketplace/stability/sdxl`

2. **NO DYNAMIC ROUTE EXISTS** for these URLs. The following files are MISSING:
   - `apps/web/src/app/(marketing)/marketplace/[org]/page.tsx`
   - `apps/web/src/app/(marketing)/marketplace/[org]/[model]/page.tsx`

3. Clicking any model card in the marketplace will result in a **404 error**.

---

## Critical Fixes Required

### 1. Create Registration API Endpoint (CRITICAL)
```
Location: apps/web/src/app/api/auth/register/route.ts
```

### 2. Create Model Detail Dynamic Route (CRITICAL)
```
Location: apps/web/src/app/(marketing)/marketplace/[org]/[model]/page.tsx
```

### 3. Create Missing Static Pages (HIGH)
- `/forgot-password`
- `/terms`
- `/privacy`

---

## Environment Variables Required

For full functionality, these env vars must be set:
- `DATABASE_URL` - Neon PostgreSQL connection
- `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` - GitHub OAuth
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` - Google OAuth
- `TINKOFF_TERMINAL_KEY`, `TINKOFF_SECRET_KEY` - Tinkoff payments
- `NEXTAUTH_SECRET`, `NEXTAUTH_URL` - NextAuth.js

---

## TypeScript Status

All pages compile without TypeScript errors. Type definitions are properly configured:
- MUI theme extensions in `theme.ts`
- NextAuth session extensions in `auth.ts`
- Proper interface definitions throughout

---

## Summary

| Category | Count |
|----------|-------|
| Total Pages | 8 |
| Working Pages | 5 |
| Partially Working | 2 |
| Broken Pages | 1 |
| Missing Pages | 9+ |
| Missing API Endpoints | 1 |
| Critical Issues | 3 |
