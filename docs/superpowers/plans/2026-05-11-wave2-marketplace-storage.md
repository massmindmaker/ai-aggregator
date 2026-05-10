# Wave 2 — Marketplace Image Storage + SEO Finalization

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Model images stored permanently in Timeweb Object Storage (S3-compatible); SEO pages `/marketplace/[org]/[model]` complete with JSON-LD; playground uses real gateway (Wave 1 prerequisite).

**Architecture:** Add an S3 client helper in `packages/shared/src/s3.ts`. Wire an admin API route (`/api/admin/models/[id]/image`) for image upload. Marketplace catalog updated to use `imageUrl` from DB. SEO pages already have JSON-LD — verify and complete missing fields.

**Tech Stack:** AWS SDK v3 S3 client (S3-compatible), Next.js API routes, Drizzle ORM

**Prerequisite:** Wave 1 complete, Timeweb Object Storage bucket `aiag-storage` created with S3 credentials.

---

## File Map

| Action | File | Purpose |
|--------|------|---------|
| Migrate | `packages/database/migrations/` | Add `image_url` column to models table |
| Create | `packages/shared/src/s3.ts` | S3 client singleton + upload helper |
| Create | `apps/web/src/app/api/admin/models/[slug]/image/route.ts` | Image upload API endpoint |
| Modify | `apps/web/src/app/admin/models/[slug]/edit/page.tsx` | Add image upload UI |
| Modify | `apps/web/src/lib/marketplace/catalog.ts` | Use `imageUrl` from DB if available |

---

## Task 0: DB migration — add image_url to models

**Files:**
- Create: `packages/database/migrations/<timestamp>_add_model_image_url.sql`

- [ ] **Step 1: Generate migration**

```bash
cd packages/database && npx drizzle-kit generate --name add_model_image_url
```

If drizzle-kit is not configured for migrations in this package, create a manual migration file:

```sql
-- packages/database/migrations/<timestamp>_add_model_image_url.sql
ALTER TABLE models ADD COLUMN IF NOT EXISTS image_url text;
```

- [ ] **Step 2: Apply migration**

```bash
cd packages/database && npx drizzle-kit migrate
```

Or on VPS: `psql $DATABASE_URL < migrations/<file>.sql`

- [ ] **Step 3: Verify schema type includes imageUrl**

In `packages/database/src/schema.ts`, ensure the `models` table definition has:
```typescript
imageUrl: text('image_url'),
```
Add it if missing, then rebuild: `cd packages/database && bun run build`

- [ ] **Step 4: Commit**

```bash
git add packages/database/
git commit -m "feat(db): add image_url column to models table"
```

---

## Task 1: S3 client helper

**Files:**
- Create: `packages/shared/src/s3.ts`

- [ ] **Step 1: Install AWS SDK S3 client (if not present)**

```bash
cd packages/shared && grep "@aws-sdk/client-s3" package.json || bun add @aws-sdk/client-s3 @aws-sdk/lib-storage
```

- [ ] **Step 2: Create S3 helper**

```typescript
// packages/shared/src/s3.ts
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

function createS3Client(): S3Client {
  const endpoint = process.env.S3_ENDPOINT; // e.g. https://s3.timeweb.cloud
  const region = process.env.S3_REGION ?? 'ru-1';
  const accessKeyId = process.env.S3_ACCESS_KEY_ID ?? '';
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY ?? '';

  return new S3Client({
    endpoint,
    region,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true, // required for Timeweb S3
  });
}

let _client: S3Client | null = null;
function getClient(): S3Client {
  if (!_client) _client = createS3Client();
  return _client;
}

export const S3_BUCKET = process.env.S3_BUCKET ?? 'aiag-storage';
export const S3_PUBLIC_URL = process.env.S3_PUBLIC_URL ?? '';

export async function uploadToS3(
  key: string,
  body: Buffer,
  contentType: string
): Promise<string> {
  const client = getClient();
  await client.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType,
    ACL: 'public-read',
  }));
  const base = S3_PUBLIC_URL || `https://${S3_BUCKET}.s3.timeweb.cloud`;
  return `${base}/${key}`;
}
```

- [ ] **Step 3: Export from shared package index**

In `packages/shared/src/index.ts`, add:
```typescript
export * from './s3';
```

- [ ] **Step 4: Build shared package**

```bash
cd packages/shared && bun run build
```
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/s3.ts packages/shared/src/index.ts packages/shared/package.json
git commit -m "feat(shared): S3 upload helper for Timeweb Object Storage"
```

---

## Task 2: Admin model image upload endpoint

**Files:**
- Create: `apps/web/src/app/api/admin/models/[slug]/image/route.ts`

- [ ] **Step 1: Write the upload route**

```typescript
// apps/web/src/app/api/admin/models/[slug]/image/route.ts
import { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin/guard';
import { uploadToS3 } from '@aiag/shared/s3';
import { db } from '@/lib/db';
import { models } from '@aiag/database/schema';
import { eq } from 'drizzle-orm';

export const runtime = 'nodejs';

const MAX_SIZE = 2 * 1024 * 1024; // 2MB
const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const admin = await requireAdmin();
  if (admin instanceof Response) return admin;

  const { slug } = await params;

  const formData = await req.formData();
  const file = formData.get('image') as File | null;
  if (!file) return Response.json({ error: 'image_required' }, { status: 400 });
  if (!ALLOWED_TYPES.includes(file.type)) {
    return Response.json({ error: 'invalid_type', allowed: ALLOWED_TYPES }, { status: 400 });
  }
  if (file.size > MAX_SIZE) {
    return Response.json({ error: 'too_large', maxMb: 2 }, { status: 400 });
  }

  const ext = file.type.split('/')[1];
  const key = `models/${slug}/cover.${ext}`;
  const buffer = Buffer.from(await file.arrayBuffer());

  const imageUrl = await uploadToS3(key, buffer, file.type);

  await db.update(models)
    .set({ imageUrl, updatedAt: new Date() })
    .where(eq(models.slug, slug));

  return Response.json({ imageUrl });
}
```

- [ ] **Step 2: Verify TypeScript**

```bash
cd apps/web && npx tsc --noEmit 2>&1 | grep "image/route" | head -10
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/api/admin/models/
git commit -m "feat(admin): model image upload endpoint → Timeweb S3"
```

---

## Task 3: Wire image upload UI in admin model page

**Files:**
- Modify: `apps/web/src/app/admin/models/[slug]/edit/page.tsx`

- [ ] **Step 1: Check if admin models edit page exists**

```bash
ls apps/web/src/app/admin/models/
```

- [ ] **Step 2: Add image upload section**

In `apps/web/src/app/admin/models/[slug]/edit/page.tsx`, find the form area and add:

```tsx
{/* Image Upload */}
<div className="border rounded-sm p-4 space-y-3" style={{ borderColor: 'var(--line)' }}>
  <div className="font-semibold text-sm">Обложка модели</div>
  {model.imageUrl && (
    <img src={model.imageUrl} alt="cover" className="w-32 h-32 object-cover rounded" />
  )}
  <form
    onSubmit={async (e) => {
      e.preventDefault();
      const fd = new FormData(e.currentTarget);
      const res = await fetch(`/api/admin/models/${model.slug}/image`, { method: 'POST', body: fd });
      if (res.ok) router.refresh();
    }}
  >
    <input type="file" name="image" accept="image/png,image/jpeg,image/webp" className="text-sm" />
    <button type="submit" className="ml-2 px-3 py-1.5 text-sm bg-[var(--accent)] text-black rounded-sm font-semibold">
      Загрузить
    </button>
  </form>
</div>
```

Note: Next.js 15 App Router passes `params` as a Promise. In the page component:
```typescript
export default async function EditModelPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  // ...
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/admin/models/
git commit -m "feat(admin): model cover image upload UI"
```

---

## Task 4: SEO pages audit and completion

**Files:**
- Read: `apps/web/src/app/(marketing)/marketplace/[org]/[model]/page.tsx`

- [ ] **Step 1: Check current SEO page state**

```bash
cat apps/web/src/app/\(marketing\)/marketplace/\[org\]/\[model\]/page.tsx | head -80
```

- [ ] **Step 2: Verify JSON-LD structured data**

The page should have `<script type="application/ld+json">` with `SoftwareApplication` or `Product` schema. Verify it includes: `name`, `description`, `offers.price`, `offers.priceCurrency`.

If missing, add to the page component:
```tsx
<script
  type="application/ld+json"
  dangerouslySetInnerHTML={{ __html: JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: model.name,
    description: model.description,
    applicationCategory: 'AIApplication',
    offers: {
      '@type': 'Offer',
      price: model.pricePerUnit,
      priceCurrency: 'RUB',
    },
  })}}
/>
```

- [ ] **Step 3: Verify code samples section**

The page should show curl/Python/JS code samples for the model. If not present, add a simple `<pre>` block with the API call example using `model.slug`.

- [ ] **Step 4: Run build to check for broken pages**

```bash
cd apps/web && bun run build 2>&1 | grep -E "error|Error" | head -20
```
Expected: build completes without errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/\(marketing\)/marketplace/
git commit -m "feat(marketplace): complete SEO pages — JSON-LD + code samples"
```

---

## Task 5: VPS env vars for S3 (Human Gate 🔑)

- [ ] **Step 1: Create Timeweb Object Storage bucket**

In Timeweb Cloud console: create bucket `aiag-storage`, set ACL to public-read for objects, copy S3 endpoint + credentials.

- [ ] **Step 2: Add to VPS .env**

```bash
ssh aiag-vps
nano /srv/aiag/shared/.env
```

Add:
```
S3_ENDPOINT=https://s3.timeweb.cloud
S3_REGION=ru-1
S3_BUCKET=aiag-storage
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_PUBLIC_URL=https://aiag-storage.s3.timeweb.cloud
```

- [ ] **Step 3: Deploy and verify upload works**

```bash
ops/scripts/deploy.sh web
```

Test by uploading a model image via `/admin/models/[id]` page.

---

## Task 6: Push and deploy

- [ ] **Step 1: Push all commits**

```bash
git push origin master
```

- [ ] **Step 2: Verify on VPS**

```bash
ssh aiag-vps "pm2 status && curl -s http://127.0.0.1:3000/marketplace | grep -c 'img'"
```
