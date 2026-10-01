/**
 * H-2 — the shared author admission predicate is the whole point of commit
 * 20dce56: `GET /v1/models` and `GET /v1/catalog` must not be able to disagree
 * about which author versions are sold, and they agree only because both read
 * `authorVersionListed()`. That predicate had no test at all — deleting
 * `v.status='approved'`, the successful-probe requirement and
 * `p.accepted_by = v.author_user_id` from it left the whole gateway suite green.
 *
 * The other catalog tests cannot see this: `public-catalog.test.ts` replaces the
 * transaction (readModels() returns a ready-made array) and the HTTP test mocks
 * `../lib/db` and hands back `state.models` directly, so the SQL is never run.
 *
 * So this test does run it. The fragment is emitted by a capturing client and
 * then EVALUATED by the small SQL-subset interpreter below against fixture
 * rows. Every clause of the predicate is a decision the interpreter makes, so
 * removing a clause changes an answer instead of a string: the "must not be
 * admitted" cases are what make each requirement bite.
 *
 * The interpreter deliberately supports only the grammar the predicate uses
 * (boolean composition, `=`/`IS [NOT] NULL`, `NOT`, bare boolean columns,
 * bound parameters with casts, and `EXISTS (SELECT 1 FROM t alias WHERE …)`).
 * If the predicate grows a construct outside it, these tests fail loudly
 * rather than silently passing an unevaluated fragment.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import type postgres from 'postgres';
import { authorVersionListed, type SqlFragmentSource } from '../catalog/author-admission';

type Row = Record<string, unknown>;
type Scope = Record<string, Row | undefined>;

/** Tables the EXISTS subqueries range over, plus the outer aliased rows. */
interface World {
  models: Row;
  author_model_versions: Row;
  author_price_policies: Row;
  author_probe_operations: Row[];
  users: Row[];
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'word'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'param'; index: number }
  | { kind: 'punct'; value: string };

function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "'") {
      let value = '';
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          value += "'";
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          i++;
          break;
        }
        value += sql[i]!;
        i++;
      }
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (ch === '?') {
      i++;
      // Parameters are numbered by position in the values array.
      const index = tokens.filter((t) => t.kind === 'param').length;
      tokens.push({ kind: 'param', index });
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let value = '';
      while (i < sql.length && /[0-9.]/.test(sql[i]!)) value += sql[i++]!;
      tokens.push({ kind: 'number', value: Number(value) });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let value = '';
      while (i < sql.length && /[A-Za-z0-9_.*]/.test(sql[i]!)) value += sql[i++]!;
      tokens.push({ kind: 'word', value });
      continue;
    }
    if (ch === ':' && sql[i + 1] === ':') {
      i += 2;
      while (i < sql.length && /[A-Za-z_]/.test(sql[i]!)) i++; // type cast
      continue;
    }
    if (ch === '<' && sql[i + 1] === '=') {
      tokens.push({ kind: 'punct', value: '<=' });
      i += 2;
      continue;
    }
    if (ch === '>' && sql[i + 1] === '=') {
      tokens.push({ kind: 'punct', value: '>=' });
      i += 2;
      continue;
    }
    if (ch === '!' && sql[i + 1] === '=') {
      tokens.push({ kind: 'punct', value: '<>' });
      i += 2;
      continue;
    }
    tokens.push({ kind: 'punct', value: ch });
    i++;
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser — the predicate's grammar, nothing more
// ---------------------------------------------------------------------------

type Expr =
  | { op: 'or'; left: Expr; right: Expr }
  | { op: 'and'; left: Expr; right: Expr }
  | { op: 'not'; arg: Expr }
  | { op: 'isNull'; operand: Operand; negated: boolean }
  | { op: 'compare'; operator: string; left: Operand; right: Operand }
  | { op: 'value'; operand: Operand }
  | { op: 'exists'; table: string; alias: string; body: Expr };

type Operand =
  | { kind: 'ref'; path: string }
  | { kind: 'literal'; value: unknown }
  | { kind: 'param'; index: number };

class Parser {
  private pos = 0;

  constructor(private readonly tokens: Token[]) {}

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private nextIs(value: string): boolean {
    const token = this.peek();
    return token !== undefined && ((token.kind === 'word' && token.value.toUpperCase() === value) || (token.kind === 'punct' && token.value === value));
  }

  private take(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('sql-eval: unexpected end of predicate');
    this.pos++;
    return token;
  }

  private expect(value: string): void {
    if (!this.nextIs(value)) {
      const token = this.peek();
      throw new Error(`sql-eval: expected ${value}, got ${token ? JSON.stringify(token) : 'end of input'}`);
    }
    this.pos++;
  }

  parse(): Expr {
    const expr = this.parseOr();
    if (this.pos !== this.tokens.length) {
      throw new Error(`sql-eval: unparsed tail at token ${this.pos}: ${JSON.stringify(this.tokens[this.pos])}`);
    }
    return expr;
  }

  private parseOr(): Expr {
    let left = this.parseAnd();
    while (this.nextIs('OR')) {
      this.pos++;
      left = { op: 'or', left, right: this.parseAnd() };
    }
    return left;
  }

  private parseAnd(): Expr {
    let left = this.parseUnary();
    while (this.nextIs('AND')) {
      this.pos++;
      left = { op: 'and', left, right: this.parseUnary() };
    }
    return left;
  }

  private parseUnary(): Expr {
    if (this.nextIs('NOT')) {
      this.pos++;
      return { op: 'not', arg: this.parseUnary() };
    }
    if (this.nextIs('(')) {
      this.pos++;
      const inner = this.parseOr();
      this.expect(')');
      return inner;
    }
    if (this.nextIs('EXISTS')) {
      this.pos++;
      this.expect('(');
      this.expect('SELECT');
      this.take(); // 1
      this.expect('FROM');
      const table = (this.take() as { value: string }).value;
      let alias = table;
      if (!this.nextIs('WHERE')) alias = (this.take() as { value: string }).value;
      this.expect('WHERE');
      const body = this.parseOr();
      this.expect(')');
      return { op: 'exists', table, alias, body };
    }
    const operand = this.parseOperand();
    if (this.nextIs('IS')) {
      this.pos++;
      const negated = this.nextIs('NOT');
      if (negated) this.pos++;
      this.expect('NULL');
      return { op: 'isNull', operand, negated };
    }
    const token = this.peek();
    if (token && token.kind === 'punct' && ['=', '<>', '<', '>', '<=', '>='].includes(token.value)) {
      this.pos++;
      return { op: 'compare', operator: token.value, left: operand, right: this.parseOperand() };
    }
    return { op: 'value', operand };
  }

  private parseOperand(): Operand {
    const token = this.take();
    if (token.kind === 'word') return { kind: 'ref', path: token.value };
    if (token.kind === 'string') return { kind: 'literal', value: token.value };
    if (token.kind === 'number') return { kind: 'literal', value: token.value };
    if (token.kind === 'param') return { kind: 'param', index: token.index };
    throw new Error(`sql-eval: unexpected operand token ${JSON.stringify(token)}`);
  }
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

function resolveOperand(operand: Operand, scope: Scope, params: unknown[]): unknown {
  if (operand.kind === 'literal') return operand.value;
  if (operand.kind === 'param') return params[operand.index];
  const [alias, column] = operand.path.split('.');
  const row = scope[alias!];
  if (row === undefined) return undefined;
  return column === undefined ? row : row[column];
}

function truthy(value: unknown): boolean {
  return value === true || (typeof value === 'string' && value.toLowerCase() === 'true');
}

function evaluate(expr: Expr, scope: Scope, params: unknown[], world: World): boolean {
  switch (expr.op) {
    case 'or':
      return evaluate(expr.left, scope, params, world) || evaluate(expr.right, scope, params, world);
    case 'and':
      return evaluate(expr.left, scope, params, world) && evaluate(expr.right, scope, params, world);
    case 'not':
      return !evaluate(expr.arg, scope, params, world);
    case 'isNull': {
      const value = resolveOperand(expr.operand, scope, params);
      const isNull = value === null || value === undefined;
      return expr.negated ? !isNull : isNull;
    }
    case 'compare': {
      const left = resolveOperand(expr.left, scope, params);
      const right = resolveOperand(expr.right, scope, params);
      // SQL comparison against NULL is never true.
      if (left === null || left === undefined || right === null || right === undefined) return false;
      if (expr.operator === '=') return left === right;
      if (expr.operator === '<>') return left !== right;
      const l = left as number;
      const r = right as number;
      if (expr.operator === '<') return l < r;
      if (expr.operator === '>') return l > r;
      if (expr.operator === '<=') return l <= r;
      return l >= r;
    }
    case 'value':
      return truthy(resolveOperand(expr.operand, scope, params));
    case 'exists': {
      const rows = world[expr.table as keyof World];
      if (!Array.isArray(rows)) {
        throw new Error(`sql-eval: predicate ranges over unknown table ${expr.table}`);
      }
      return rows.some((row) => evaluate(expr.body, { ...scope, [expr.alias]: row }, params, world));
    }
  }
}

// ---------------------------------------------------------------------------
// Capturing the real fragment
// ---------------------------------------------------------------------------

interface Fragment {
  sql: string;
  params: unknown[];
}

/**
 * Emits `authorVersionListed()` through a client that records the template and
 * its bound values, then parses it — so an unevaluated fragment is a test
 * failure, not a silent pass.
 */
async function captureFragment(authorChatEnabled: boolean): Promise<Fragment> {
  vi.stubEnv('AUTHOR_CHAT_ENABLED', authorChatEnabled ? '1' : '0');
  // config.ts refuses AUTHOR_CHAT_ENABLED=1 on the legacy execution mode.
  vi.stubEnv('GATEWAY_HTTP_EXECUTION_MODE', 'stored_chat_only');
  vi.resetModules();
  const module = await import('../catalog/author-admission');
  let captured: Fragment = { sql: '', params: [] };
  const client = ((strings: TemplateStringsArray, ...params: unknown[]) => {
    captured = { sql: strings.join('?'), params };
    return Promise.resolve([]) as unknown as postgres.PendingQuery<readonly postgres.Row[]>;
  }) as unknown as SqlFragmentSource;
  module.authorVersionListed(client);
  expect(captured.sql.length).toBeGreaterThan(0);
  const parsed = new Parser(tokenize(captured.sql)).parse();
  // Parsing is the guard: the fragment must be fully understood before use.
  expect(parsed.op).toBeTypeOf('string');
  return captured;
}

// ---------------------------------------------------------------------------
// Fixtures — every author fact, individually overridable
// ---------------------------------------------------------------------------

const AUTHOR = '11111111-1111-4111-8111-111111111111';
const OTHER_AUTHOR = '22222222-2222-4222-8222-222222222222';

function world(overrides: {
  model?: Row;
  version?: Row;
  policy?: Row;
  probes?: Row[];
  users?: Row[];
} = {}): World {
  return {
    models: overrides.model ?? { id: 'm1', slug: 'author-model', author_user_id: AUTHOR, status: 'live', enabled: true },
    author_model_versions: overrides.version ?? { id: 'v1', model_id: 'm1', author_user_id: AUTHOR, status: 'approved' },
    author_price_policies: overrides.policy ?? { id: 'p1', version_id: 'v1', approved_at: '2026-09-01T00:00:00Z', accepted_by: AUTHOR },
    author_probe_operations: overrides.probes ?? [{ id: 'probe1', version_id: 'v1', state: 'succeeded' }],
    users: overrides.users ?? [{ id: AUTHOR, is_active: true, is_banned: false }],
  };
}

/** True when the real predicate admits this row set. */
function admits(f: Fragment, w: World): boolean {
  const expr = new Parser(tokenize(f.sql)).parse();
  return evaluate(
    expr,
    { m: w.models, v: w.author_model_versions, p: w.author_price_policies },
    f.params,
    w,
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('authorVersionListed — the admission predicate itself (H-2)', () => {
  it('admits an author version whose every requirement holds', async () => {
    const f = await captureFragment(true);
    expect(admits(f, world())).toBe(true);
  });

  it('binds the process flag as a parameter instead of inlining it', async () => {
    const enabled = await captureFragment(true);
    const disabled = await captureFragment(false);
    // One bound parameter, carrying the flag value itself.
    expect(enabled.params).toHaveLength(1);
    expect(enabled.params[0]).toBe(true);
    expect(disabled.params[0]).toBe(false);
    expect(enabled.sql).not.toMatch(/\btrue::boolean/);
    expect(enabled.sql).not.toMatch(/\bfalse::boolean/);
  });

  it('admits no author version at all when the process flag is off', async () => {
    const f = await captureFragment(false);
    expect(admits(f, world())).toBe(false);
  });

  it('still lists a model that has no author at all', async () => {
    const f = await captureFragment(true);
    const w = world({
      model: { id: 'm1', slug: 'stock-model', author_user_id: null, status: 'live', enabled: true },
      version: { id: 'v1', author_user_id: null, status: 'draft' },
      policy: { id: 'p1', version_id: 'v1', approved_at: null, accepted_by: null },
      probes: [],
      users: [],
    });
    expect(admits(f, w)).toBe(true);
  });

  it('rejects a version that was never approved by moderation', async () => {
    const f = await captureFragment(true);
    expect(admits(f, world({ version: { id: 'v1', model_id: 'm1', author_user_id: AUTHOR, status: 'candidate' } }))).toBe(false);
  });

  it('rejects a version whose probe never succeeded', async () => {
    const f = await captureFragment(true);
    expect(admits(f, world({ probes: [{ id: 'probe1', version_id: 'v1', state: 'failed' }] }))).toBe(false);
    expect(admits(f, world({ probes: [{ id: 'probe1', version_id: 'v1', state: 'unknown' }] }))).toBe(false);
    expect(admits(f, world({ probes: [{ id: 'probe1', version_id: 'v1', state: 'dispatching' }] }))).toBe(false);
  });

  it('rejects a version that has no probe row at all', async () => {
    const f = await captureFragment(true);
    expect(admits(f, world({ probes: [] }))).toBe(false);
  });

  it('rejects a version whose probe belongs to a different version', async () => {
    const f = await captureFragment(true);
    expect(admits(f, world({ probes: [{ id: 'probe1', version_id: 'v-other', state: 'succeeded' }] }))).toBe(false);
  });

  it('rejects a version owned by somebody other than the model author', async () => {
    const f = await captureFragment(true);
    // The impostor is an active, unbanned user, so only the ownership match can
    // reject this row.
    const w = world({
      version: { id: 'v1', model_id: 'm1', author_user_id: OTHER_AUTHOR, status: 'approved' },
      policy: { id: 'p1', version_id: 'v1', approved_at: '2026-09-01T00:00:00Z', accepted_by: OTHER_AUTHOR },
      probes: [{ id: 'probe1', version_id: 'v1', state: 'succeeded' }],
      users: [
        { id: AUTHOR, is_active: true, is_banned: false },
        { id: OTHER_AUTHOR, is_active: true, is_banned: false },
      ],
    });
    expect(admits(f, w)).toBe(false);
  });

  it('rejects a policy accepted by somebody other than the version author', async () => {
    const f = await captureFragment(true);
    const w = world({
      policy: { id: 'p1', version_id: 'v1', approved_at: '2026-09-01T00:00:00Z', accepted_by: OTHER_AUTHOR },
      users: [
        { id: AUTHOR, is_active: true, is_banned: false },
        { id: OTHER_AUTHOR, is_active: true, is_banned: false },
      ],
    });
    expect(admits(f, w)).toBe(false);
  });

  it('rejects a policy that was never approved', async () => {
    const f = await captureFragment(true);
    expect(admits(f, world({ policy: { id: 'p1', version_id: 'v1', approved_at: null, accepted_by: AUTHOR } }))).toBe(false);
  });

  it('rejects a deactivated author account', async () => {
    const f = await captureFragment(true);
    expect(admits(f, world({ users: [{ id: AUTHOR, is_active: false, is_banned: false }] }))).toBe(false);
  });

  it('rejects a banned author account', async () => {
    const f = await captureFragment(true);
    expect(admits(f, world({ users: [{ id: AUTHOR, is_active: true, is_banned: true }] }))).toBe(false);
  });

  it('rejects an author account that no longer exists', async () => {
    const f = await captureFragment(true);
    expect(admits(f, world({ users: [] }))).toBe(false);
  });

  it('rejects a model that is not live', async () => {
    const f = await captureFragment(true);
    expect(admits(f, world({ model: { id: 'm1', slug: 'author-model', author_user_id: AUTHOR, status: 'frozen', enabled: true } }))).toBe(false);
  });
});
