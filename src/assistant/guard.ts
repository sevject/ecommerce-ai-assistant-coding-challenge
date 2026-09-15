/**
 * Lexical guard for model-generated SQL.
 *
 * This is the first of several layers, not the load-bearing one. The connection
 * is opened read-only and every statement is checked with SQLite's own
 * `.readonly` analysis before it runs (see `runQuery`), so a write cannot
 * succeed even if this guard were bypassed. What this adds is a clear, early
 * error message and a defence against multi-statement payloads, which SQLite's
 * per-statement analysis would not see as a whole.
 */

/**
 * Patterns for statements that modify data, schema, or connection state.
 *
 * `REPLACE` is matched only as `REPLACE INTO`, because bare `replace(x, a, b)`
 * is a legitimate SQLite string function that a reasonable query might use.
 */
const FORBIDDEN_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  'insert',
  'update',
  'delete',
  'drop',
  'alter',
  'create',
  'truncate',
  'attach',
  'detach',
  'pragma',
  'vacuum',
  'reindex',
  'begin',
  'commit',
  'rollback',
  'savepoint',
  'grant',
  'revoke',
]
  .map((keyword) => ({ label: keyword, pattern: new RegExp(`\\b${keyword}\\b`, 'i') }))
  .concat([{ label: 'replace into', pattern: /\breplace\s+into\b/i }]);

export class UnsafeSqlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeSqlError';
  }
}

/**
 * Remove string literals, quoted identifiers, and comments.
 *
 * Keyword and semicolon detection has to run against this stripped form,
 * otherwise a product name like "Drop Shipping Kit" would trip the keyword
 * check and a semicolon inside a literal would look like a second statement.
 * Literals are replaced by a space so adjacent tokens do not merge.
 */
export function stripLiteralsAndComments(sql: string): string {
  let out = '';
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    // Line comment: -- ... end of line
    if (ch === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      out += ' ';
      continue;
    }

    // Block comment: /* ... */
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      out += ' ';
      continue;
    }

    // Single-quoted string, double-quoted identifier, or bracket identifier.
    // In SQLite a quote is escaped by doubling it ('' or ""), which this handles
    // naturally: the closing quote ends the literal and the next one re-opens it.
    if (ch === "'" || ch === '"' || ch === '`') {
      i++;
      while (i < sql.length && sql[i] !== ch) i++;
      i++;
      out += ' ';
      continue;
    }
    if (ch === '[') {
      while (i < sql.length && sql[i] !== ']') i++;
      i++;
      out += ' ';
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

/**
 * Assert that `sql` is a single read-only statement.
 *
 * Returns the SQL with any trailing semicolon and surrounding whitespace removed.
 * Throws {@link UnsafeSqlError} otherwise.
 */
export function assertReadOnlySql(sql: string): string {
  const trimmed = sql.trim().replace(/;+\s*$/, '').trim();

  if (trimmed.length === 0) {
    throw new UnsafeSqlError('The generated query was empty.');
  }

  const stripped = stripLiteralsAndComments(trimmed);

  if (stripped.includes(';')) {
    throw new UnsafeSqlError(
      'Only a single SQL statement is allowed, but the query contains more than one.',
    );
  }

  if (!/^\s*(select|with)\b/i.test(stripped)) {
    throw new UnsafeSqlError('Only SELECT and WITH queries are allowed.');
  }

  const found = FORBIDDEN_PATTERNS.filter(({ pattern }) => pattern.test(stripped)).map(
    ({ label }) => label,
  );
  if (found.length > 0) {
    throw new UnsafeSqlError(
      `The query contains disallowed keyword(s): ${found.join(', ')}. This assistant only reads data.`,
    );
  }

  return trimmed;
}
