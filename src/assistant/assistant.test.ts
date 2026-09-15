/**
 * Tests for the deterministic parts of the pipeline: the SQL guard, the
 * execution layer, and money formatting.
 *
 * The model calls are deliberately not tested here. What is worth pinning down
 * is that a bad query cannot reach the database and that cents never turn into
 * a wrong-looking number, and neither of those needs an API key.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { assertReadOnlySql, stripLiteralsAndComments, UnsafeSqlError } from './guard.js';
import { runQuery, QueryExecutionError } from './query.js';
import { formatCents, formatCell, formatTable } from './format.js';
import { resolveReferenceDate } from './reference-date.js';
import { openDatabase } from '../database/connection.js';
import type { Database as DatabaseType } from 'better-sqlite3';

describe('stripLiteralsAndComments', () => {
  it('removes single-quoted strings', () => {
    assert.equal(stripLiteralsAndComments("SELECT 'drop table x'").trim(), 'SELECT');
  });

  it('removes line and block comments', () => {
    assert.match(stripLiteralsAndComments('SELECT 1 -- delete everything\n, 2'), /SELECT 1\s+, 2/);
    assert.match(stripLiteralsAndComments('SELECT /* drop */ 1'), /SELECT\s+1/);
  });

  it('handles doubled quotes inside a literal', () => {
    // 'O''Brien' is one literal; the stripped form must not leak SQL-looking text.
    assert.equal(stripLiteralsAndComments("SELECT 'O''Brien'").trim(), 'SELECT');
  });
});

describe('assertReadOnlySql', () => {
  it('accepts a plain SELECT and strips the trailing semicolon', () => {
    assert.equal(assertReadOnlySql('SELECT 1;'), 'SELECT 1');
  });

  it('accepts a CTE', () => {
    const sql = 'WITH t AS (SELECT 1 AS n) SELECT n FROM t';
    assert.equal(assertReadOnlySql(sql), sql);
  });

  it('rejects writes', () => {
    for (const sql of [
      "INSERT INTO users (name) VALUES ('x')",
      'UPDATE users SET name = 1',
      'DELETE FROM orders',
      'DROP TABLE users',
      'PRAGMA table_info(users)',
      "ATTACH DATABASE '/tmp/x' AS x",
    ]) {
      assert.throws(() => assertReadOnlySql(sql), UnsafeSqlError, `should reject: ${sql}`);
    }
  });

  it('rejects stacked statements', () => {
    assert.throws(
      () => assertReadOnlySql('SELECT 1; DROP TABLE users'),
      UnsafeSqlError,
    );
  });

  it('does not trip on keywords inside string literals', () => {
    const sql = "SELECT name FROM products WHERE name = 'Drop Shipping Insert Kit'";
    assert.equal(assertReadOnlySql(sql), sql);
  });

  it('allows the replace() string function but not REPLACE INTO', () => {
    const sql = "SELECT replace(name, 'a', 'b') AS n FROM products";
    assert.equal(assertReadOnlySql(sql), sql);
    assert.throws(
      () => assertReadOnlySql("REPLACE INTO users (id, name) VALUES (1, 'x')"),
      UnsafeSqlError,
    );
  });

  it('rejects an empty query', () => {
    assert.throws(() => assertReadOnlySql('   '), UnsafeSqlError);
  });
});

describe('formatCents', () => {
  it('formats whole and fractional amounts', () => {
    assert.equal(formatCents(0), '$0.00');
    assert.equal(formatCents(5), '$0.05');
    assert.equal(formatCents(4599), '$45.99');
    assert.equal(formatCents(100000), '$1,000.00');
    assert.equal(formatCents(123456789), '$1,234,567.89');
  });

  it('formats negatives with the sign outside the symbol', () => {
    assert.equal(formatCents(-4599), '-$45.99');
  });
});

describe('formatCell', () => {
  it('formats _cents columns as currency and leaves other numbers alone', () => {
    assert.equal(formatCell('total_cents', 4599), '$45.99');
    assert.equal(formatCell('order_count', 12), '12');
    assert.equal(formatCell('name', null), '—');
  });
});

describe('runQuery', () => {
  let db: DatabaseType;

  before(() => {
    db = openDatabase({ readonly: true });
  });

  after(() => {
    db.close();
  });

  it('runs a read-only query and reports columns', () => {
    const result = runQuery(db, 'SELECT id, name FROM users ORDER BY id LIMIT 3');
    assert.deepEqual(result.columns, ['id', 'name']);
    assert.equal(result.rows.length, 3);
    assert.equal(result.truncated, false);
  });

  it('caps rows and flags truncation', () => {
    const result = runQuery(db, 'SELECT id FROM order_items', 5);
    assert.equal(result.rows.length, 5);
    assert.equal(result.truncated, true);
  });

  it('reports SQLite errors as QueryExecutionError', () => {
    assert.throws(
      () => runQuery(db, 'SELECT no_such_column FROM users'),
      QueryExecutionError,
    );
  });

  it('refuses a write even though the guard would also catch it', () => {
    assert.throws(() => runQuery(db, "INSERT INTO users (name) VALUES ('x')"), UnsafeSqlError);
  });

  it('computes order value from the historical unit price, not the current one', () => {
    // The distinction the challenge calls out: these two numbers must differ,
    // which is what makes using the wrong column a silent error.
    const historical = runQuery(
      db,
      'SELECT SUM(quantity * unit_price_cents) AS total_cents FROM order_items',
    ).rows[0].total_cents as number;

    const current = runQuery(
      db,
      `SELECT SUM(oi.quantity * p.current_price_cents) AS total_cents
       FROM order_items oi JOIN products p ON p.id = oi.product_id`,
    ).rows[0].total_cents as number;

    assert.equal(Number.isInteger(historical), true);
    assert.notEqual(historical, current);
  });
});

describe('resolveReferenceDate', () => {
  let db: DatabaseType;

  before(() => {
    db = openDatabase({ readonly: true });
  });

  after(() => {
    db.close();
  });

  it('defaults to the latest order in the database', () => {
    const reference = resolveReferenceDate(db, 'data');
    assert.equal(reference.source, 'latest-order');
    const latest = runQuery(db, 'SELECT MAX(ordered_at) AS m FROM orders').rows[0].m as string;
    assert.equal(reference.iso, latest);
  });

  it('accepts an explicit date', () => {
    const reference = resolveReferenceDate(db, '2026-07-01');
    assert.equal(reference.date, '2026-07-01');
    assert.equal(reference.source, 'explicit');
  });

  it('rejects an unparsable value', () => {
    assert.throws(() => resolveReferenceDate(db, 'last tuesday'), /Could not understand/);
  });
});

describe('formatTable', () => {
  it('renders a header, rule and rows', () => {
    const table = formatTable({
      sql: '',
      columns: ['name', 'total_cents'],
      rows: [{ name: 'Ada', total_cents: 4599 }],
      truncated: false,
    });
    assert.match(table, /name/);
    assert.match(table, /\$45\.99/);
  });

  it('handles an empty result', () => {
    assert.equal(
      formatTable({ sql: '', columns: ['a'], rows: [], truncated: false }),
      '(no rows)',
    );
  });
});
