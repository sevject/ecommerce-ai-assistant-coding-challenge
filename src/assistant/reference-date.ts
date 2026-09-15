/**
 * Resolving what "now" means for relative dates like "yesterday".
 *
 * The seeded data stops well before the current system date, so anchoring
 * relative dates to the real clock makes every "last seven days" question return
 * an empty result: correct, but indistinguishable from a bug. Rather than hide
 * the choice, the reference date is resolved explicitly, printed with every
 * answer, and overridable from the command line.
 */

import type { Database as DatabaseType } from 'better-sqlite3';

export type ReferenceDateSource = 'latest-order' | 'system-clock' | 'explicit';

export interface ReferenceDate {
  /** Full ISO 8601 UTC instant, e.g. "2026-07-20T12:00:00.000Z". */
  iso: string;
  /** Date part only, e.g. "2026-07-20". This is what the model reasons with. */
  date: string;
  source: ReferenceDateSource;
}

/** The `--now` value as given on the command line. */
export type NowOption = 'data' | 'real' | string;

function toReferenceDate(iso: string, source: ReferenceDateSource): ReferenceDate {
  return { iso, date: iso.slice(0, 10), source };
}

/**
 * Resolve the reference date.
 *
 * - `'data'` (the default) uses the most recent `orders.ordered_at`, so relative
 *   questions are answered against the period the data actually covers.
 * - `'real'` uses the system clock.
 * - Anything else is parsed as an explicit date or instant.
 */
export function resolveReferenceDate(db: DatabaseType, now: NowOption = 'data'): ReferenceDate {
  if (now === 'real') {
    return toReferenceDate(new Date().toISOString(), 'system-clock');
  }

  if (now === 'data') {
    const row = db.prepare('SELECT MAX(ordered_at) AS latest FROM orders').get() as {
      latest: string | null;
    };
    if (!row.latest) {
      // No orders at all: nothing to anchor to, so fall back to the real clock.
      return toReferenceDate(new Date().toISOString(), 'system-clock');
    }
    return toReferenceDate(row.latest, 'latest-order');
  }

  // Explicit value: accept either "2026-07-20" or a full ISO instant.
  const candidate = /^\d{4}-\d{2}-\d{2}$/.test(now) ? `${now}T23:59:59.999Z` : now;
  const parsed = new Date(candidate);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(
      `Could not understand --now="${now}". Use "data", "real", a date like 2026-07-20, or a full ISO timestamp.`,
    );
  }
  return toReferenceDate(parsed.toISOString(), 'explicit');
}

/** A short human explanation of where the reference date came from. */
export function describeReferenceDate(reference: ReferenceDate): string {
  switch (reference.source) {
    case 'latest-order':
      return `${reference.date} (most recent order in the database)`;
    case 'system-clock':
      return `${reference.date} (system clock)`;
    case 'explicit':
      return `${reference.date} (set with --now)`;
  }
}
