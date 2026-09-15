/**
 * Turning result rows back into a plain-English answer.
 *
 * This is a second model call rather than part of the planning call, because the
 * planner has not seen the data yet. Summarising before the query runs means the
 * prose can describe numbers that never came back. Here the model is given the
 * actual rows and asked to state what they say.
 *
 * The prompt spends most of its length on one failure: reading absence from a
 * filtered result as absence from the database. Asked "how many chargers were
 * ordered?", an earlier version answered correctly with 6 and then added that
 * Phone Charger 65W was "the only product whose name contains charger" — there
 * is a second one, never ordered, and so invisible to a query that inner-joins
 * from order_items. The numbers were right and the sentence was false, which is
 * the worst combination: printing the SQL lets a reader check the query, but
 * nothing about a correct query reveals that the prose overstepped it.
 */

import Anthropic from '@anthropic-ai/sdk';
import { MODEL } from './planner.js';
import type { QueryResult } from './query.js';
import { formatCents } from './format.js';

const SYSTEM_PROMPT = `You state, in plain English, what a query result says in answer to the user's question.

What you are looking at:
  The rows are the output of ONE filtered query, not a view of the database. Rows
  were excluded by the query's joins and WHERE conditions, and you cannot see what
  was excluded or why. A thing missing from these rows may still exist in the
  database — most queries about orders inner-join from order_items, so anything
  never ordered is absent from the result while being perfectly real.
  Treat the rows as evidence about what matched, and as no evidence at all about
  what did not.

Rules:
- Use only the rows you are given. Never state a number, name, or fact that is
  not in them.
- Never claim completeness, exclusivity, or non-existence about anything beyond
  these rows: no "the only product", "no other user", "nothing else exists",
  "there are no X". However obvious such a claim looks, a filtered result cannot
  support it.
  Quantifying over the rows themselves is fine — "all six units were X", "every
  row here is from June" — because that is just reading the result. The line is
  between describing the result and describing the database.
- Describe what matched, not what is absent. Do not explain why something is
  missing, and do not infer a cause for any value.
- Lead with the direct answer. One or two sentences. Stop once the question is
  answered — do not add context to fill space.
- Money arrives as integer cents in columns ending in _cents, and is shown to you
  already formatted. Write amounts the same way, e.g. $1,234.56. Never print a
  raw cents integer as if it were dollars.
- The full table is printed directly below your answer, so do not restate every
  row. Name the top few where that is the point of the question.
- If there are no rows, say that nothing in the data matched what was asked for,
  and say what was searched for. Do not say the thing does not exist.

Worked example of the mistake to avoid:
  Question: "How many chargers were ordered?"
  Rows: product_name=Phone Charger 65W, units_ordered=6
  Wrong: "6 were ordered. Phone Charger 65W is the only product whose name
          contains 'charger'." — the second sentence is a claim about the product
          catalogue. The query only returned products that were ordered, so a
          charger with zero orders would be missing from these rows. You have no
          way to know it is the only one.
  Right:  "6 charger units were ordered, all of them Phone Charger 65W."`;

/** Render rows compactly for the model, with money already formatted. */
function renderRowsForModel(result: QueryResult): string {
  if (result.rows.length === 0) return '(no rows)';

  const lines = result.rows.map((row) => {
    const fields = result.columns.map((column) => {
      const value = row[column];
      if (column.endsWith('_cents') && typeof value === 'number') {
        return `${column}=${formatCents(value)}`;
      }
      return `${column}=${value === null ? 'null' : String(value)}`;
    });
    return `- ${fields.join(', ')}`;
  });

  return lines.join('\n');
}

export interface NarrateOptions {
  client: Anthropic;
  question: string;
  interpretation: string;
  result: QueryResult;
}

export async function narrateResult({
  client,
  question,
  interpretation,
  result,
}: NarrateOptions): Promise<string> {
  const truncationNote = result.truncated
    ? `\n\nNote: the result was capped at ${result.rows.length} rows, so this is a partial view.`
    : '';

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Question: ${question}

How it was interpreted: ${interpretation}

SQL that ran:
${result.sql}

Result (${result.rows.length} row${result.rows.length === 1 ? '' : 's'}):
${renderRowsForModel(result)}${truncationNote}

Answer the question.`,
      },
    ],
  });

  return response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}
