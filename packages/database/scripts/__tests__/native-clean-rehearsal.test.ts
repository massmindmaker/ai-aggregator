import { beforeEach, describe, expect, it, vi } from "vitest";
import * as migrator from "../native-migrate";
import { runCleanRehearsal } from "../native-clean-rehearsal";
import {
  TEST_DATABASE_MARKER,
  type QueryConfig,
  type TestDatabaseClient,
} from "../test-db-guard";

const env = {
  DATABASE_URL:
    "postgres://unit:unit%21@127.0.0.1:15432/ai_aggregator_test?application_name=unit",
  TEST_DATABASE_URL:
    "postgres://unit:unit%21@127.0.0.1:15432/ai_aggregator_test?application_name=unit",
  AIAG_TEST_DATABASE: "1",
};
const runId = "f27c2992-347b-4f2f-811e-581ac39af548";
type Ledger = {
  version: string;
  checksum: string;
  effective_checksum: string;
}[];
class RecordingClient implements TestDatabaseClient {
  queries: QueryConfig[] = [];
  marker: string | null;
  oid = "12345";
  exists = false;
  rights = true;
  nonempty = false;
  wrongIdentity = false;
  port = 15432;
  missingHttpObject = false;
  closed = false;
  ledger: Ledger = [];
  fail = "";
  constructor(readonly target: boolean) {
    this.marker = target ? null : TEST_DATABASE_MARKER;
  }
  async connect() {}
  async end() {
    this.closed = true;
    if (this.fail === "close") throw new Error("secret close failure");
  }
  async query<Row extends Record<string, unknown>>(q: QueryConfig) {
    this.queries.push(q);
    if (this.fail && q.text.includes(this.fail))
      throw new Error("postgres://secret SQL secret");
    let rows: Record<string, unknown>[] = [];
    if (q.text.includes("current_database()"))
      rows = [
        {
          database_name: this.wrongIdentity
            ? "wrong"
            : this.target
              ? "ai_aggregator_clean69_test"
              : "ai_aggregator_test",
          oid: this.target ? this.oid : "100",
          host: "127.0.0.1",
          port: this.port,
        },
      ];
    else if (q.text.includes("AS marker_table"))
      rows = [
        { marker_table: this.marker ? "_aiag_test_database_marker" : null },
      ];
    else if (q.text.includes("SELECT marker"))
      rows = this.marker ? [{ marker: this.marker }] : [];
    else if (q.text.includes("SELECT version, checksum")) rows = this.ledger;
    else if (q.text.includes("AS can_create"))
      rows = [{ can_create: this.rights }];
    else if (q.text.includes("gen_random_uuid()")) rows = [{ run_id: runId }];
    else if (q.text.includes("FROM pg_database WHERE datname"))
      rows = this.exists ? [{ oid: this.oid }] : [];
    else if (q.text.startsWith("CREATE DATABASE")) this.exists = true;
    else if (q.text.startsWith("DROP DATABASE")) this.exists = false;
    else if (q.text.includes("AS user_objects"))
      rows = [{ user_objects: this.nonempty ? "1" : "0" }];
    else if (q.text.includes("INSERT INTO public._aiag_test_database_marker"))
      this.marker = String(q.values?.[0]);
    else if (q.text.includes("AS object_name"))
      rows = [{ object_name: this.missingHttpObject ? null : "present" }];
    return { rows: rows as Row[], rowCount: rows.length };
  }
}
function setup() {
  const canonical = new RecordingClient(false);
  const target = new RecordingClient(true);
  const factory = vi.fn(async (url: string) =>
    new URL(url).pathname === "/ai_aggregator_test" ? canonical : target,
  );
  const migrate = vi
    .spyOn(migrator, "runNativeMigrations")
    .mockImplementation(async (client, migrations) => {
      expect(client).toBe(target);
      const versions = migrations.map((m) => m.version);
      const first = target.ledger.length === 0;
      target.ledger = migrations.map((m) => ({
        version: m.version,
        checksum: m.checksum,
        effective_checksum: migrator.prepareMigrationSql(m).effectiveChecksum,
      }));
      return { applied: first ? versions : [], skipped: first ? [] : versions };
    });
  return {
    canonical,
    target,
    factory,
    migrate,
    run: () => runCleanRehearsal(env, { clientFactory: factory }),
  };
}
function noDrop(c: RecordingClient) {
  expect(c.queries.some((q) => q.text.startsWith("DROP DATABASE"))).toBe(false);
}
function noMutation(c: RecordingClient) {
  expect(
    c.queries.some((q) =>
      /^(CREATE|DROP|INSERT|UPDATE|DELETE|ALTER)\b/.test(q.text.trim()),
    ),
  ).toBe(false);
}
beforeEach(() => {
  vi.restoreAllMocks();
});
describe("clean69 ownership protocol (recording clients, not native migration proof)", () => {
  it("refuses invalid environment before constructing any client", async () => {
    const s = setup();
    expect(
      (
        await runCleanRehearsal(
          { ...env, AIAG_TEST_DATABASE: "0" },
          { clientFactory: s.factory },
        )
      ).ok,
    ).toBe(false);
    expect(s.factory).not.toHaveBeenCalled();
  });
  it.each(["identity", "marker", "existing", "rights"])(
    "refuses %s before CREATE or other canonical writes",
    async (fault) => {
      const s = setup();
      if (fault === "identity") s.canonical.wrongIdentity = true;
      if (fault === "marker") s.canonical.marker = "wrong";
      if (fault === "existing") s.canonical.exists = true;
      if (fault === "rights") s.canonical.rights = false;
      expect(await s.run()).toMatchObject({
        ok: false,
        error:
          fault === "identity" || fault === "marker"
            ? "canonical_guard_failed"
            : fault === "existing"
              ? "target_absence_failed"
              : "create_rights_failed",
        cleanup: "not_created",
      });
      expect(s.factory).toHaveBeenCalledTimes(1);
      noMutation(s.canonical);
      expect(s.migrate).not.toHaveBeenCalled();
    },
  );
  it("proves two migration passes and closes then drops only its own fixed database", async () => {
    const s = setup();
    const result = await s.run();
    expect(result).toMatchObject({
      ok: true,
      cleanup: "dropped",
      canonicalUnchanged: true,
      first: { total: 69, applied: 69, skipped: 0 },
      rerun: { total: 69, applied: 0, skipped: 69 },
    });
    expect(s.target.closed).toBe(true);
    expect(s.canonical.closed).toBe(true);
    expect(
      s.canonical.queries
        .filter((q) => /^(CREATE|DROP)/.test(q.text))
        .map((q) => q.text),
    ).toEqual([
      "CREATE DATABASE ai_aggregator_clean69_test TEMPLATE template0",
      "DROP DATABASE ai_aggregator_clean69_test",
    ]);
    const base = new URL(env.TEST_DATABASE_URL);
    const alternate = new URL(s.factory.mock.calls[1][0]);
    expect(alternate.pathname).toBe("/ai_aggregator_clean69_test");
    alternate.pathname = base.pathname;
    expect(alternate.href === base.href).toBe(true);
    expect(s.target.marker).toBe(`ai-aggregator:clean69:${runId}`);
  });
  it("never adopts a database after unknown CREATE acknowledgement", async () => {
    const s = setup();
    s.canonical.fail = "CREATE DATABASE";
    const result = await s.run();
    expect(result).toMatchObject({ ok: false, cleanup: "cleanup_unverified" });
    noDrop(s.canonical);
    expect(s.factory).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toMatch(/secret|postgres:\/\//);
  });
  it.each(["identity", "nonempty", "marker_insert"])(
    "leaves created DB when bootstrap %s cannot establish ownership",
    async (fault) => {
      const s = setup();
      if (fault === "identity") s.target.wrongIdentity = true;
      if (fault === "nonempty") s.target.nonempty = true;
      if (fault === "marker_insert")
        s.target.fail = "INSERT INTO public._aiag_test_database_marker";
      expect(await s.run()).toMatchObject({
        ok: false,
        cleanup: "cleanup_unverified",
      });
      noDrop(s.canonical);
      expect(s.migrate).not.toHaveBeenCalled();
    },
  );
  it.each(["marker", "oid", "canonical_oid"])(
    "refuses DROP after %s drift",
    async (fault) => {
      const s = setup();
      s.migrate.mockImplementation(async () => {
        if (fault === "marker") s.target.marker = "foreign";
        if (fault === "oid") s.target.oid = "54321";
        if (fault === "canonical_oid") s.canonical.oid = "54321";
        throw new Error("migration failed");
      });
      expect(await s.run()).toMatchObject({
        ok: false,
        cleanup: "cleanup_unverified",
      });
      noDrop(s.canonical);
    },
  );
  it("preserves migration failure while allowing verified owned cleanup", async () => {
    const s = setup();
    s.migrate.mockRejectedValue(new Error("secret SQL"));
    expect(await s.run()).toMatchObject({
      ok: false,
      error: "first_migration_failed",
      cleanup: "dropped",
    });
  });
  it("reports unknown DROP acknowledgement once without retry", async () => {
    const s = setup();
    s.canonical.fail = "DROP DATABASE";
    expect(await s.run()).toMatchObject({
      ok: false,
      cleanup: "cleanup_unverified",
    });
    expect(
      s.canonical.queries.filter((q) => q.text.startsWith("DROP DATABASE")),
    ).toHaveLength(1);
  });
  it("refuses DROP after owned target close failure", async () => {
    const s = setup();
    s.target.fail = "close";
    expect(await s.run()).toMatchObject({
      ok: false,
      cleanup: "cleanup_unverified",
    });
    noDrop(s.canonical);
  });
  it("rejects canonical ledger drift despite successful migrations and cleanup", async () => {
    const s = setup();
    const original = s.migrate.getMockImplementation()!;
    s.migrate.mockImplementation(async (...args) => {
      s.canonical.ledger = [
        {
          version: "foreign",
          checksum: "changed",
          effective_checksum: "changed",
        },
      ];
      return original(...args);
    });
    expect(await s.run()).toMatchObject({
      ok: false,
      cleanup: "dropped",
      canonicalUnchanged: false,
    });
  });
  it.each(["canonical", "target"])(
    "rejects wrong connected server port on %s",
    async (which) => {
      const s = setup();
      (which === "canonical" ? s.canonical : s.target).port = 5432;
      expect(await s.run()).toMatchObject({ ok: false });
      noDrop(s.canonical);
      expect(s.migrate).not.toHaveBeenCalled();
      if (which === "canonical") noMutation(s.canonical);
    },
  );
  it("rejects missing source migration before CREATE", async () => {
    const s = setup();
    const migrations = await migrator.discoverNativeMigrations();
    vi.spyOn(migrator, "discoverNativeMigrations").mockResolvedValue(
      migrations.slice(1),
    );
    expect(await s.run()).toMatchObject({
      ok: false,
      error: "inventory_failed",
      cleanup: "not_created",
    });
    noMutation(s.canonical);
  });
  it("rejects frozen source checksum drift before CREATE", async () => {
    const s = setup();
    const migrations = await migrator.discoverNativeMigrations();
    vi.spyOn(migrator, "discoverNativeMigrations").mockResolvedValue(
      migrations.map((m) =>
        m.version.includes("0068_") ? { ...m, checksum: "changed" } : m,
      ),
    );
    expect(await s.run()).toMatchObject({
      ok: false,
      error: "inventory_failed",
    });
    noMutation(s.canonical);
  });
  it("rejects incomplete first migration result", async () => {
    const s = setup();
    s.migrate.mockResolvedValue({ applied: [], skipped: [] });
    expect(await s.run()).toMatchObject({
      ok: false,
      error: "first_migration_failed",
      cleanup: "dropped",
    });
  });
  it("rejects mismatched effective ledger checksum", async () => {
    const s = setup();
    const original = s.migrate.getMockImplementation()!;
    s.migrate.mockImplementation(async (...args) => {
      const result = await original(...args);
      s.target.ledger[0].effective_checksum = "corrupt";
      return result;
    });
    expect(await s.run()).toMatchObject({
      ok: false,
      error: "first_ledger_failed",
      cleanup: "dropped",
    });
    expect(s.migrate).toHaveBeenCalledTimes(1);
  });
  it("rejects missing HTTP table or function signature", async () => {
    const s = setup();
    s.target.missingHttpObject = true;
    expect(await s.run()).toMatchObject({
      ok: false,
      error: "http_objects_failed",
      cleanup: "dropped",
    });
    expect(s.migrate).toHaveBeenCalledTimes(1);
  });
  it("rejects an incomplete rerun even after complete first ledger", async () => {
    const s = setup();
    const original = s.migrate.getMockImplementation()!;
    s.migrate
      .mockImplementationOnce(original)
      .mockResolvedValue({ applied: [], skipped: [] });
    expect(await s.run()).toMatchObject({
      ok: false,
      error: "rerun_migration_failed",
      cleanup: "dropped",
    });
  });
  it("preserves primary failure when cleanup also fails", async () => {
    const s = setup();
    s.migrate.mockRejectedValue(new Error("primary secret"));
    s.canonical.fail = "DROP DATABASE";
    expect(await s.run()).toMatchObject({
      ok: false,
      error: "first_migration_failed",
      cleanup: "cleanup_unverified",
      gaps: ["drop_ack_unverified"],
    });
  });
  it.each(["identity", "marker"])(
    "detects canonical %s drift during final read-only check",
    async (fault) => {
      const s = setup();
      const original = s.migrate.getMockImplementation()!;
      s.migrate.mockImplementation(async (...args) => {
        if (fault === "identity") s.canonical.wrongIdentity = true;
        else s.canonical.marker = "foreign";
        return original(...args);
      });
      expect(await s.run()).toMatchObject({
        ok: false,
        canonicalUnchanged: false,
      });
    },
  );
});
