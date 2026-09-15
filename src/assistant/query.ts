/**
 * Execution of model-generated SQL against a read-only connection.
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import { assertReadOnlySql, UnsafeSqlError } from './guard.js';

/** Hard cap on rows pulled back from a single query. */
export const DEFAULT_MAX_ROWS = 200;

export interface QueryResult {
  /** The SQL that actually ran, normalised (no trailing semicolon). */
  sql: string;
  /** Column names in result order, taken from the prepared statement. */
  columns: string[];
  rows: Array<Record<string, unknown>>;
  /** True when the result was cut off at `maxRows`. */
  truncated: boolean;
}

/** Thrown when SQLite rejects the query. The message is fed back to the planner. */
export class QueryExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueryExecutionError';
  }
}

/**
 * Run a single read-only query and return at most `maxRows` rows.
 *
 * Safety is layered, strongest first:
 *   1. `db` is opened read-only, so SQLite refuses any write outright.
 *   2. `stmt.readonly` is SQLite's own analysis of the prepared statement.
 *   3. {@link assertReadOnlySql} catches multi-statement input and gives a clear error.
 *   4. Rows are streamed and capped rather than trusting the model to add a LIMIT.
 */
export function runQuery(
  db: DatabaseType,
  rawSql: string,
  maxRows: number = DEFAULT_MAX_ROWS,
): QueryResult {
  const sql = assertReadOnlySql(rawSql);

  let stmt;
  try {
    stmt = db.prepare(sql);
  } catch (error) {
    throw new QueryExecutionError(
      `SQLite could not prepare the query: ${(error as Error).message}`,
    );
  }

  // SQLite's own verdict, which beats any keyword list we could write.
  if (!stmt.readonly) {
    throw new UnsafeSqlError('SQLite reports this statement would modify the database.');
  }
  if (!stmt.reader) {
    throw new UnsafeSqlError('This statement does not return any rows.');
  }

  const rows: Array<Record<string, unknown>> = [];
  let truncated = false;

  try {
    for (const row of stmt.iterate()) {
      if (rows.length >= maxRows) {
        truncated = true;
        break;
      }
      rows.push(row as Record<string, unknown>);
    }
  } catch (error) {
    throw new QueryExecutionError(
      `SQLite could not run the query: ${(error as Error).message}`,
    );
  }

  // `stmt.columns()` is only valid on a statement that returns rows, and it
  // gives the declared result order even when zero rows come back.
  const columns = stmt.columns().map((column) => column.name);

  return { sql, columns, rows, truncated };
}
