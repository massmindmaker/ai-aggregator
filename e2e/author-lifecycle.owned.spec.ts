import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import pg from "pg";

// HTTP credentials, real forms and real SQL. No external probe or paid provider is called.
test("author and moderator browser lifecycle with synthetic confirmed provider evidence", async ({
  browser,
  baseURL,
}) => {
  if (
    process.env.AIAG_E2E_OWNED_SERVER !== "1" ||
    process.env.AIAG_TEST_DATABASE !== "1" ||
    baseURL !== "http://127.0.0.1:3107"
  )
    throw Error("Owned test server required");
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (
    url.hostname !== "127.0.0.1" ||
    url.port !== "15432" ||
    url.pathname !== "/ai_aggregator_test" ||
    url.search
  )
    throw Error("Disposable database required");
  const db = new pg.Client({ connectionString: url.href });
  await db.connect();
  const contexts: BrowserContext[] = [],
    errors: string[] = [];
  const out = resolve(
    ".superpowers/sdd/2026-09-28-ag-author-version-v1/browser",
  );
  await mkdir(out, { recursive: true, mode: 0o700 });
  const query = async (text: string, values: unknown[] = []) =>
    (await db.query(text, values)).rows;
  const hash = (value: string) =>
    createHash("sha256").update(value).digest("hex");
  async function login(role: "user" | "admin") {
    const context = await browser.newContext({
      baseURL,
      viewport: { width: 1440, height: 1000 },
    });
    contexts.push(context);
    const email = "author-browser-" + randomUUID() + "@example.test",
      password = "Owned1-" + randomUUID();
    const registration = await context.request.post("/api/auth/register", {
      data: {
        name: "Test " + role,
        email,
        password,
        consentProcessing: true,
        consentTransborder: true,
        consentMarketing: false,
      },
    });
    expect(registration.status()).toBe(201);
    const { user } = await registration.json();
    if (role === "admin")
      await query("UPDATE users SET role='admin' WHERE id=$1 AND email=$2", [
        user.id,
        email,
      ]);
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/login");
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByLabel("Пароль", { exact: true }).fill(password);
    await page
      .getByRole("button", { name: "Войти с email", exact: true })
      .click();
    await page.waitForURL(/\/dashboard(?:[/?#]|$)/);
    if (role === "admin") {
      const elevated = await context.request.post("/api/admin/auth", {
        data: { email, password },
      });
      expect(elevated.status()).toBe(200);
    }
    return { context, page, id: user.id as string };
  }
  async function clickWrite(page: Page, label: string) {
    const [response] = await Promise.all([
      page.waitForResponse(
        (r) => r.request().method() === "POST" && r.url().includes("/api/"),
      ),
      page.getByRole("button", { name: label, exact: true }).click(),
    ]);
    expect(response.status()).toBe(200);
    return response.json();
  }
  try {
    expect(
      (
        await query(
          "SELECT marker FROM public._aiag_test_database_marker WHERE singleton=true",
        )
      )[0].marker,
    ).toBe("ai-aggregator:test-database:v1");
    const author = await login("user"),
      admin = await login("admin");
    const slug = "browser-" + randomUUID(),
      token = "synthetic-token-" + randomUUID();
    await author.page.goto("/dashboard/models/new");
    await author.page
      .getByLabel("Название", { exact: true })
      .fill("Проверенная модель автора");
    await author.page.getByLabel("Slug (URL-идентификатор)").fill(slug);
    await author.page
      .getByLabel("Описание", { exact: true })
      .fill(
        "Локальная проверка подключения авторской модели и согласования цены.",
      );
    await author.page
      .getByRole("button", { name: "Далее", exact: true })
      .click();
    await author.page
      .getByLabel("Endpoint URL")
      .fill("https://author.example.com/v1/chat/completions");
    await author.page.getByLabel("Bearer token").fill(token);
    await author.page
      .getByRole("button", { name: "Далее", exact: true })
      .click();
    await author.page
      .getByRole("checkbox", {
        name: "Подтверждаю право отправить эту модель на проверку",
      })
      .check();
    await clickWrite(author.page, "Отправить на модерацию");
    await author.page.waitForURL(/submitted=1/);
    const [model] = await query(
      "SELECT id,current_author_version_id FROM models WHERE slug=$1 AND author_user_id=$2",
      [slug, author.id],
    );
    expect(model.current_author_version_id).toBeNull();
    const [version] = await query(
      "SELECT id,manifest_digest FROM author_model_versions WHERE model_id=$1",
      [model.id],
    );
    // Confirmed provider output is explicitly synthetic. Native tests exercise the real safeFetch seam separately.
    const claim = randomUUID();
    const [probe] = await query(
      "SELECT * FROM aiag_claim_author_probe($1,$2,$3,$4,$5)",
      [
        version.id,
        version.manifest_digest,
        admin.id,
        "sha256:" + hash("synthetic health body"),
        claim,
      ],
    );
    await query("SELECT * FROM aiag_complete_author_probe($1,$2,$3,$4,$5)", [
      probe.id,
      claim,
      "succeeded",
      "sha256:" + hash("synthetic healthy output"),
      null,
    ]);
    await admin.page.goto("/admin/author-models/" + model.id);
    await expect(
      admin.page.getByRole("heading", {
        name: "Проверенная модель автора",
        exact: true,
      }),
    ).toBeVisible();
    await admin.page.getByLabel("Цена, микрокредиты").fill("1001");
    await admin.page.getByLabel("Доля автора, %").fill("73,15");
    await admin.page.getByLabel("Удержание, дней").fill("0");
    await admin.page
      .getByLabel("Документ о правах")
      .fill("synthetic-license:v1");
    await admin.page.getByLabel("Версия согласия").fill("synthetic-consent:v1");
    await clickWrite(admin.page, "Зафиксировать предложение");
    await expect(
      admin.page.getByRole("button", { name: "Сделать текущей" }),
    ).toBeDisabled();
    await author.page.goto("/dashboard/models/" + model.id);
    await expect(
      author.page.getByRole("button", { name: "Принять условия" }),
    ).toBeDisabled();
    await author.page
      .getByRole("checkbox", { name: /Я принимаю цену/ })
      .check();
    await clickWrite(author.page, "Принять условия");
    await admin.page.reload();
    await expect(
      admin.page.getByRole("button", { name: "Сделать текущей" }),
    ).toBeEnabled();
    await clickWrite(admin.page, "Сделать текущей");
    await admin.page.screenshot({
      path: resolve(out, "moderator-desktop.png"),
      fullPage: true,
    });
    const [policy] = await query(
      "SELECT id,price_microcredits::text FROM author_price_policies WHERE version_id=$1",
      [version.id],
    );
    expect(
      (
        await query(
          "SELECT current_author_version_id FROM models WHERE id=$1",
          [model.id],
        )
      )[0].current_author_version_id,
    ).toBe(version.id);
    await author.page.goto("/marketplace/community/" + slug);
    await expect(
      author.page.getByText("1,001 кредита за запрос", { exact: true }),
    ).toBeVisible();
    expect(await author.page.content()).not.toContain(token);
    await author.page.screenshot({
      path: resolve(out, "public-model-desktop.png"),
      fullPage: true,
    });
    // Generate a synthetic paid request only through the already-tested canonical SQL authority.
    const org = randomUUID(),
      key = randomUUID(),
      billing = randomUUID(),
      attempt = randomUUID(),
      fingerprint = hash("synthetic body"),
      keyDigest = hash("synthetic browser key");
    await query(
      "INSERT INTO organizations(id,slug,name,owner_id,payg_credits) VALUES ($1,$2,'synthetic buyer',$3,10000)",
      [org, org, admin.id],
    );
    await query(
      "INSERT INTO gateway_api_keys(id,org_id,name,key_hash,key_prefix) VALUES ($1,$2,'synthetic buyer',$3,'synthetic')",
      [key, org, hash(randomUUID())],
    );
    await query(
      "INSERT INTO gateway_quota_org_policies(org_id,enforcement_version) VALUES ($1,2)",
      [org],
    );
    await query(
      "SELECT * FROM aiag_claim_gateway_http_request_v1($1,$2,$3,'chat','stored',$4,$5,1::smallint)",
      [org, key, billing, keyDigest, fingerprint],
    );
    const [binding] = await query(
      "SELECT * FROM aiag_bind_author_request($1,$2,$3,$4,$5,$6)",
      [org, key, billing, version.id, policy.id, fingerprint],
    );
    const quote = binding.author_quote;
    await query(
      "SELECT * FROM aiag_admit_gateway_charge_v2($1,$2,$3,'browser-trace','chat','stored',$4,$5::bigint,$6::jsonb,$7::timestamptz,NULL,$8::jsonb)",
      [
        org,
        billing,
        key,
        slug,
        policy.price_microcredits,
        JSON.stringify({ version: 1, authorQuote: quote }),
        new Date(Date.now() + 60000).toISOString(),
        JSON.stringify({
          version: 2,
          formulaVersion: "author-share-usd-micro-v1",
          authorQuote: quote,
        }),
      ],
    );
    await query(
      "SELECT * FROM aiag_mark_gateway_charge_dispatched($1,$2,$3,$4,$5::jsonb)",
      [org, billing, attempt, "author:" + version.id, JSON.stringify(quote)],
    );
    const output = {
      id: "synthetic-browser-result",
      object: "chat.completion",
      created: 1,
      model: slug,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Synthetic output" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    };
    const usage = {
      version: 1,
      formulaVersion: "author-fixed-microcredits-v1",
      billingRequestId: billing,
      attemptId: attempt,
      upstreamId: "author:" + version.id,
      verified: true,
      responseDigest: "sha256:" + hash(JSON.stringify(output)),
      completionId: output.id,
      reportedModel: slug,
      usage: {
        promptTokens: 1,
        completionTokens: 2,
        totalTokens: 3,
        cachedInputTokens: 0,
      },
    };
    await query(
      "SELECT * FROM aiag_record_gateway_http_outcome_v1($1,$2,$3,$4,$5,$6::bigint,$7::jsonb,'success',$8::jsonb,1::smallint)",
      [
        org,
        key,
        billing,
        keyDigest,
        fingerprint,
        policy.price_microcredits,
        JSON.stringify(usage),
        JSON.stringify(output),
      ],
    );
    await query("SELECT * FROM aiag_settle_admitted_gateway_charge($1,$2)", [
      org,
      billing,
    ]);
    await author.page.goto("/dashboard/earnings");
    await expect(
      author.page.getByRole("heading", { name: "Мои доходы" }),
    ).toBeVisible();
    await expect(author.page.getByText("0,732", { exact: true })).toBeVisible();
    await author.page.getByLabel("Сумма, микрокредиты").fill("732");
    await clickWrite(author.page, "Создать тестовую выплату");
    await expect(author.page.getByRole("status")).toHaveText(
      /без реального перевода/,
    );
    await admin.page.goto("/admin/author-requests");
    const card = admin.page.getByRole("article").filter({ hasText: billing });
    await expect(card).toHaveCount(1);
    await expect(card).toBeVisible();
    await card
      .getByRole("checkbox", { name: /Подтверждаю полный возврат/ })
      .check();
    await clickWrite(admin.page, "Вернуть списание");
    await author.page.reload();
    await expect(
      author.page.locator("section").filter({
        has: author.page.getByRole("heading", { name: "Доступно", exact: true }),
      }).getByText("-0,732", { exact: true }),
    ).toBeVisible();
    expect(
      (
        await query(
          "SELECT payg_credits::text AS n FROM organizations WHERE id=$1",
          [org],
        )
      )[0].n,
    ).toBe("10000");
    await author.page.screenshot({
      path: resolve(out, "author-earnings-desktop.png"),
      fullPage: true,
    });
    await author.page.setViewportSize({ width: 390, height: 844 });
    await author.page.reload();
    expect(
      await author.page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
    await author.page.screenshot({
      path: resolve(out, "author-earnings-mobile.png"),
      fullPage: true,
    });
    await admin.page.goto("/admin/author-models/" + model.id);
    await admin.page.getByLabel("Причина остановки").fill("synthetic pause");
    await clickWrite(admin.page, "Заморозить");
    expect((await query("SELECT status,enabled FROM models WHERE id=$1", [model.id]))[0])
      .toEqual({ status: "frozen", enabled: false });
    // Next's streamed notFound response may carry HTTP200. Assert the rendered denial,
    // not an untrue status requirement; the gateway denial is checked separately.
    await author.page.goto("/marketplace/community/" + slug);
    await expect(author.page.getByRole("heading", { name: "Страница не найдена", exact: true })).toBeVisible();
    await expect(author.page.getByRole("heading", { name: "Вызов через общий API", exact: true })).toHaveCount(0);
    await admin.page.reload();
    await admin.page.getByLabel("Причина остановки").fill("synthetic resume");
    await clickWrite(admin.page, "Возобновить");
    expect((await query("SELECT status,enabled FROM models WHERE id=$1", [model.id]))[0])
      .toEqual({ status: "live", enabled: true });
    await author.page.reload();
    await expect(author.page.getByRole("heading", { name: "Вызов через общий API", exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    for (const c of contexts) await c.close();
    await db.end();
  }
});
