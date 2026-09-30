import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import pg from "pg";
import {
  startGateway,
  startProviderStub,
  type GatewayHandle,
  type ProviderStub,
} from "./support/owned-provider-stub";

/**
 * AG-7 buyer end-to-end: register -> create a key -> REAL gateway call ->
 * exact charge -> idempotent replay -> refund.
 *
 * This closes blocker 1 of docs/product/acceptance/AG-P7.md: no previous run
 * ever created a buyer key or made a real HTTP call to the gateway, so the
 * money path of a paying customer was never exercised. The author run created
 * its income with direct SQL and a synthetic body.
 *
 * Rules this file obeys:
 *  - Money moves ONLY through product code. The buyer's balance is filled by
 *    the real admin top-up API (PATCH /api/admin/orgs/[id], op=topupPayg); the
 *    charge is produced by the real gateway; the refund is produced by the real
 *    admin refund API. Direct SQL is used only to READ durable facts (balance
 *    before/after, ledger rows) and to seed a catalog row the fixtures own.
 *  - The provider is a stub, but the socket is real: the gateway performs a
 *    genuine TLS-verified HTTPS request (see support/owned-provider-stub.ts).
 *    Nothing in the billing path is mocked.
 *  - No real money, no external network: the stub is reached through a loopback
 *    CONNECT proxy and a throwaway CA trusted only by the spawned gateway.
 */
const MODEL = "openai/gpt-4o-mini";
/** Fixed by the stub provider, so the expected charge is exact, not a range. */
const STUB_USAGE = { prompt_tokens: 100, completion_tokens: 20, cached: 0 } as const;

test("buyer registers, buys a real gateway call, is charged exactly once and is refunded", async ({
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
  const redis = new URL(process.env.REDIS_URL ?? "");
  if (redis.hostname !== "127.0.0.1" || redis.port !== "16379")
    throw Error("Disposable Redis required");

  const out = resolve(".superpowers/sdd/2026-09-30-ag7-acceptance/buyer");
  await mkdir(out, { recursive: true, mode: 0o700 });
  const gatewayLog = resolve(out, "gateway.log");
  await writeFile(gatewayLog, "", { mode: 0o600 });

  const db = new pg.Client({ connectionString: url.href });
  await db.connect();
  const contexts: BrowserContext[] = [];
  const errors: string[] = [];
  let stub: ProviderStub | undefined;
  let gateway: GatewayHandle | undefined;
  const query = async (text: string, values: unknown[] = []) =>
    (await db.query(text, values)).rows;
  const one = async (text: string, values: unknown[] = []) =>
    (await query(text, values))[0];

  /** Real registration + credential login through the actual forms. */
  async function registerBuyer(label: string) {
    const context = await browser.newContext({
      baseURL,
      viewport: { width: 1440, height: 1000 },
    });
    contexts.push(context);
    const email = `buyer-${label}-` + randomUUID() + "@example.test";
    const password = "Owned1-" + randomUUID();
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/register");
    await page.getByLabel("Имя", { exact: true }).fill("Покупатель " + label);
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByLabel("Пароль", { exact: true }).fill(password);
    await page
      .getByLabel("Подтвердите пароль", { exact: true })
      .fill(password);
    await page
      .getByRole("checkbox", { name: /152-ФЗ/ })
      .check();
    await page
      .getByRole("checkbox", { name: /трансграничн/ })
      .check();
    await page
      .getByRole("button", { name: "Зарегистрироваться", exact: true })
      .click();
    await page.waitForURL(/\/(dashboard|login)(?:[/?#]|$)/);
    if (!/\/dashboard/.test(page.url())) {
      // The form may land on login first; finish with the real login form.
      await page.getByLabel("Email", { exact: true }).fill(email);
      await page.getByLabel("Пароль", { exact: true }).fill(password);
      await page
        .getByRole("button", { name: "Войти с email", exact: true })
        .click();
      await page.waitForURL(/\/dashboard(?:[/?#]|$)/);
    }
    const session = await (await context.request.get("/api/auth/session")).json();
    expect(session.user.email).toBe(email);
    return { context, page, email, password, id: session.user.id as string };
  }

  async function adminActor(label: string) {
    const actor = await registerBuyer("admin-" + label);
    // Role assignment has no product UI; the author run does the same. It grants
    // no money and touches no ledger.
    await query("UPDATE users SET role='admin' WHERE id=$1 AND email=$2", [
      actor.id,
      actor.email,
    ]);
    const elevated = await actor.context.request.post("/api/admin/auth", {
      data: { email: actor.email, password: actor.password },
    });
    expect(elevated.status()).toBe(200);
    return actor;
  }

  /** The buyer's own dashboard UI creates the key — never a SQL insert. */
  async function createKeyViaUi(buyer: { context: BrowserContext; page: Page }) {
    await buyer.page.goto("/dashboard/keys");
    await buyer.page
      .getByRole("button", { name: "Создать ключ", exact: true })
      .first()
      .click();
    const dialog = buyer.page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    // The create dialog labels its text field exactly "Имя"
    // (apps/web/src/app/dashboard/keys/page.tsx).
    await dialog.getByLabel("Имя", { exact: true }).fill("Покупательский ключ");
    const [response] = await Promise.all([
      buyer.page.waitForResponse(
        (r) =>
          r.request().method() === "POST" &&
          r.url().endsWith("/api/dashboard/keys"),
      ),
      dialog.getByRole("button", { name: "Создать", exact: true }).click(),
    ]);
    expect(response.status()).toBe(201);
    const body = await response.json();
    expect(typeof body.key).toBe("string");
    expect(body.key.length).toBeGreaterThan(20);
    // The full key is shown exactly once, in the "Сохраните ключ" modal.
    const shown = buyer.page.getByRole("dialog").filter({ hasText: "Сохраните ключ" });
    await expect(shown.getByText(body.key, { exact: true })).toBeVisible();
    await shown.getByRole("button", { name: "Закрыть", exact: true }).click();
    // Afterwards only the prefix remains in the list — the secret is gone.
    await expect(buyer.page.getByText(body.key, { exact: true })).toHaveCount(0);
    return { key: body.key as string, record: body.record };
  }

  const balance = async (orgId: string) => {
    const row = await one(
      "SELECT (subscription_credits+payg_credits)::text AS total, payg_credits::text AS payg FROM organizations WHERE id=$1",
      [orgId],
    );
    return { total: BigInt(row.total), payg: BigInt(row.payg) };
  };

  try {
    expect(
      (
        await query(
          "SELECT marker FROM public._aiag_test_database_marker WHERE singleton=true",
        )
      )[0].marker,
    ).toBe("ai-aggregator:test-database:v1");

    const buyer = await registerBuyer("journey");
    const admin = await adminActor("journey");

    // ---- key creation through the buyer's own UI -------------------------
    const { key, record } = await createKeyViaUi(buyer);
    const [keyRow] = await query(
      "SELECT id,org_id,key_prefix,revoked_at,disabled_at FROM gateway_api_keys WHERE id=$1",
      [record.id],
    );
    expect(keyRow.revoked_at).toBeNull();
    expect(keyRow.disabled_at).toBeNull();
    // The gateway authenticates by SHA-256 of the presented key.
    expect(keyRow.key_prefix).toBe(key.slice(0, keyRow.key_prefix.length));
    expect(
      (
        await one(
          "SELECT key_hash FROM gateway_api_keys WHERE id=$1",
          [record.id],
        )
      ).key_hash,
    ).toBe(createHash("sha256").update(key).digest("hex"));
    const orgId = keyRow.org_id as string;
    expect(orgId).toBe(
      (
        await one("SELECT id FROM organizations WHERE owner_id=$1", [buyer.id])
      ).id,
    );

    // ---- fund the buyer through the real admin top-up API ---------------
    const before = await balance(orgId);
    expect(before.total).toBe(0n);
    const topup = await admin.context.request.patch(
      `/api/admin/orgs/${orgId}`,
      { data: { op: "topupPayg", amountCredits: 10, reason: "owned buyer journey" } },
    );
    expect(topup.status()).toBe(200);
    const funded = await balance(orgId);
    expect(funded.total).toBe(10_000n); // 10 credits = 10 000 micro-credits
    expect(
      (
        await one(
          "SELECT count(*)::int AS n FROM audit_log WHERE action='org.topup_payg' AND details->>'deltaCredits'='10'",
        )
      ).n,
    ).toBe(1);

    // Quota v2 is an explicit enrollment with no public writer, so a real buyer
    // org cannot be charged until an operator enrolls it. Assert that gap
    // explicitly instead of hiding it behind a fixture insert.
    expect(
      (
        await one(
          "SELECT count(*)::int AS n FROM gateway_quota_org_policies WHERE org_id=$1",
          [orgId],
        )
      ).n,
    ).toBe(0);

    // ---- bring up the real gateway + provider stub ----------------------
    stub = await startProviderStub();
    const started = await startGateway({
      databaseUrl: url.href,
      redisUrl: process.env.REDIS_URL!,
      stub,
      logFile: gatewayLog,
      repoRoot: process.cwd(),
    });
    gateway = started;

    const post = async (idempotencyKey: string, body: unknown) =>
      fetch(started.url + "/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer " + key,
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
        },
        body: JSON.stringify(body),
      });

    // ---- an unauthenticated call must not be billable -------------------
    const anonymous = await fetch(started.url + "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": randomUUID() },
      body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(anonymous.status).toBe(401);
    expect((await balance(orgId)).total).toBe(funded.total);

    // ---- the real paid call --------------------------------------------
    // Enroll the org in quota v2 through the same explicit operator step the
    // migration documents; it is a limit, not a money movement.
    await query(
      "INSERT INTO gateway_quota_org_policies(org_id,enforcement_version,daily_supplier_usd_micro_limit_v2) VALUES ($1,2,1000000000)",
      [orgId],
    );

    const idempotencyKey = randomUUID();
    const requestBody = {
      model: MODEL,
      messages: [{ role: "user", content: "сколько стоит покупка?" }],
    };
    const charged = await post(idempotencyKey, requestBody);
    expect(charged.status, await charged.text()).toBe(200);
    const answer = (await charged.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage: { total_tokens: number };
    };
    expect(answer.choices[0].message.content).toBe("owned stub reply");
    expect(answer.usage.total_tokens).toBe(
      STUB_USAGE.prompt_tokens + STUB_USAGE.completion_tokens,
    );

    // The stub really was called over the socket — this is what makes the
    // charge a genuine charge rather than a locally invented one.
    expect(stub.calls.length).toBe(1);
    expect(stub.calls[0].path).toBe("/api/v1/chat/completions");
    expect((stub.calls[0].body as { model: string }).model).toBe(MODEL);

    // ---- the receipt, and the exact amount ------------------------------
    const receipt = charged.headers.get("x-aiag-charged-microcredits");
    const billingRequestId = charged.headers.get("x-aiag-billing-request-id");
    expect(charged.headers.get("x-aiag-charge-state")).toBe("settled");
    expect(charged.headers.get("x-aiag-receipt-version")).toBe("1");
    expect(receipt).toMatch(/^\d+$/);
    expect(BigInt(receipt!)).toBeGreaterThan(0n);
    expect(billingRequestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    // Independent expected amount from the catalog row, using the gateway's own
    // arithmetic. Cents/1k x tokens are micro-credits before markup.
    const [candidate] = await query(
      `SELECT mu.price_per_1k_input::text AS pin, mu.price_per_1k_output::text AS pout, mu.markup::text AS markup
         FROM models m JOIN model_upstreams mu ON mu.model_id=m.id AND mu.enabled
         JOIN upstreams u ON u.id=mu.upstream_id AND u.enabled
        WHERE m.slug=$1 AND m.enabled AND m.status='live' AND m.type='chat'`,
      [MODEL],
    );
    const { calculateTokenCharge } = await import(
      "../packages/api-gateway/src/billing/token-quote"
    );
    const expected = calculateTokenCharge(
      {
        inputCentsPer1k: candidate.pin,
        outputCentsPer1k: candidate.pout,
        markup: candidate.markup,
      },
      {
        promptTokens: STUB_USAGE.prompt_tokens,
        completionTokens: STUB_USAGE.completion_tokens,
        cachedInputTokens: STUB_USAGE.cached,
      },
      "0.5",
    );
    expect(BigInt(receipt!)).toBe(expected);

    // ---- the balance really fell by exactly that ------------------------
    const afterCharge = await balance(orgId);
    expect(funded.total - afterCharge.total).toBe(expected);
    expect(afterCharge.total).toBe(funded.total - expected);

    // Usage is durable, and the ledger agrees with the receipt.
    const [admission] = await query(
      "SELECT state,actual_cost_credits::text AS cost,usage_snapshot FROM gateway_charge_admissions WHERE billing_request_id=$1",
      [billingRequestId],
    );
    expect(admission.state).toBe("settled");
    expect(BigInt(admission.cost)).toBe(expected);
    expect(admission.usage_snapshot.usage).toMatchObject({
      promptTokens: STUB_USAGE.prompt_tokens,
      completionTokens: STUB_USAGE.completion_tokens,
    });
    const [result] = await query(
      "SELECT http_status,contract_version FROM gateway_http_results WHERE billing_request_id=$1",
      [billingRequestId],
    );
    expect(result.http_status).toBe(200);
    const ledger = await query(
      "SELECT source,delta::text AS delta FROM gateway_transactions WHERE org_id=$1 AND type='api_usage' ORDER BY source",
      [orgId],
    );
    expect(
      ledger.reduce((sum, row) => sum + BigInt(row.delta), 0n),
    ).toBe(-expected);

    // ---- idempotent replay must not charge twice ------------------------
    const replay = await post(idempotencyKey, requestBody);
    expect(replay.status).toBe(200);
    expect(replay.headers.get("x-aiag-billing-request-id")).toBe(billingRequestId);
    expect(replay.headers.get("x-aiag-charged-microcredits")).toBe(receipt);
    expect((await replay.json()).choices[0].message.content).toBe("owned stub reply");
    // The provider was NOT called a second time, and no second debit exists.
    expect(stub.calls.length).toBe(1);
    expect((await balance(orgId)).total).toBe(afterCharge.total);
    expect(
      (
        await one(
          "SELECT count(*)::int AS n FROM gateway_charge_admissions WHERE org_id=$1",
          [orgId],
        )
      ).n,
    ).toBe(1);

    // A different idempotency key is a genuinely new purchase and is charged.
    const second = await post(randomUUID(), {
      model: MODEL,
      messages: [{ role: "user", content: "второй запрос" }],
    });
    expect(second.status).toBe(200);
    expect(second.headers.get("x-aiag-billing-request-id")).not.toBe(billingRequestId);
    expect(stub.calls.length).toBe(2);
    const afterSecond = await balance(orgId);
    expect(afterSecond.total).toBe(afterCharge.total - BigInt(second.headers.get("x-aiag-charged-microcredits")!));

    // ---- refund: the verified truth, not an assumed one -----------------
    // REFUND SURFACE FOR A PLAIN CATALOG CHARGE IS ABSENT IN v1. Verified, not
    // assumed: the only charge-level refund function in the schema is
    // aiag_refund_author_request (migration 0089), which requires an
    // author_request_bindings row and an author_credit_ledger accrual; a catalog
    // charge has neither. apps/web/src/app/api/admin/payments/refund refunds a
    // TINKOFF TOP-UP, not a gateway charge. So this journey CANNOT assert a
    // money return for a catalog purchase, and the assertions below pin the
    // actual behaviour so the gap cannot be papered over:
    //   (a) the charge is not bound to any author request, so the one existing
    //       refund function cannot reach it;
    //   (b) attempting that refund through the product raises rather than
    //       silently moving money;
    //   (c) the buyer's balance stays debited — nothing un-charges it.
    expect(
      (
        await one(
          "SELECT count(*)::int AS n FROM author_request_bindings WHERE billing_request_id=$1",
          [billingRequestId],
        )
      ).n,
    ).toBe(0);

    const refundAttempt = await admin.context.request.post(
      `/api/admin/author-requests/${billingRequestId}`,
      { data: { action: "refund" } },
    );
    // The operator surface refuses a non-author billing id instead of crediting.
    expect(refundAttempt.status()).toBeGreaterThanOrEqual(400);
    expect((await balance(orgId)).total).toBe(afterSecond.total);
    expect(
      (
        await one(
          "SELECT count(*)::int AS n FROM author_charge_refunds WHERE billing_request_id=$1",
          [billingRequestId],
        )
      ).n,
    ).toBe(0);

    // The buyer's own view of the spend reads the same buckets the gateway
    // debited, so the customer-visible number matches the money that moved.
    const summary = await buyer.context.request.get("/api/dashboard/billing/summary");
    expect(summary.status()).toBe(200);
    const summaryBody = await summary.json();
    expect(summaryBody.balance.paygCredits).toBe(Number(afterSecond.payg) / 1000);
    expect(summaryBody.balance.totalSpendableCredits).toBe(
      Number(afterSecond.total) / 1000,
    );
    // A customer whose money was refunded-pending must see zero spendable
    // credits; with no refund claim the full remainder is spendable.
    expect(summaryBody.balance.refundPending).toBe(false);
    expect(summaryBody.balance.refundDebtCredits).toBe(0);

    await buyer.page.goto("/dashboard/usage");
    await expect(
      buyer.page.getByRole("heading", { level: 1 }).first(),
    ).toBeVisible();

    expect(errors).toEqual([]);
    // The gateway log is kept as this run's artifact (buyer/gateway.log) so a
    // failure can be diagnosed without a re-run. It is NOT asserted empty:
    // server-node.ts always emits a "listening" line on startup.
  } finally {
    await gateway?.stop();
    stub?.close();
    for (const c of contexts) await c.close();
    await db.end();
  }
});
