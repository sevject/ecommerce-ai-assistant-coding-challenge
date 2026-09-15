/**
 * Presentation: integer cents to currency, and result rows to a text table.
 */

import type { QueryResult } from './query.js';

/**
 * Format integer cents as a currency string.
 *
 * The division by 100 happens exactly here, at the display boundary, and nowhere
 * else — all arithmetic upstream stays in integer cents.
 */
export function formatCents(cents: number): string {
  const negative = cents < 0;
  const absolute = Math.abs(Math.round(cents));
  const whole = Math.floor(absolute / 100);
  const fraction = String(absolute % 100).padStart(2, '0');
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}$${grouped}.${fraction}`;
}

/**
 * Format one cell for display.
 *
 * Columns whose name ends in `_cents` are rendered as currency; this convention
 * is stated in the planner prompt, so it is a contract with the model rather
 * than a guess about the data.
 */
export function formatCell(column: string, value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (column.endsWith('_cents') && typeof value === 'number') return formatCents(value);
  if (typeof value === 'number' && Number.isFinite(value) && !Number.isInteger(value)) {
    return value.toFixed(2);
  }
  return String(value);
}

/** Right-align numeric and currency columns, left-align everything else. */
function isNumericColumn(result: QueryResult, column: string): boolean {
  if (column.endsWith('_cents')) return true;
  return result.rows.some((row) => typeof row[column] === 'number');
}

/** Render a result as a plain-text table with a header rule. */
export function formatTable(result: QueryResult): string {
  if (result.columns.length === 0) return '(no columns)';
  if (result.rows.length === 0) return '(no rows)';

  const cells = result.rows.map((row) =>
    result.columns.map((column) => formatCell(column, row[column])),
  );

  const widths = result.columns.map((column, index) =>
    Math.max(column.length, ...cells.map((row) => row[index].length)),
  );

  const alignRight = result.columns.map((column) => isNumericColumn(result, column));

  const pad = (text: string, width: number, right: boolean) =>
    right ? text.padStart(width) : text.padEnd(width);

  const header = result.columns
    .map((column, index) => pad(column, widths[index], alignRight[index]))
    .join('  ');
  const rule = widths.map((width) => '─'.repeat(width)).join('  ');
  const body = cells
    .map((row) => row.map((cell, index) => pad(cell, widths[index], alignRight[index])).join('  '))
    .join('\n');

  return [header, rule, body].join('\n');
}

/** Indent a block of text, for nesting SQL under a heading. */
export function indent(text: string, prefix = '  '): string {
  return text
    .split('\n')
    .map((line) => (line.length > 0 ? prefix + line : line))
    .join('\n');
}
