/**
 * Turning a plain-English question into SQL, using Claude with structured output.
 *
 * The model is asked for one of two shapes: a query, or a refusal with a reason.
 * Making "I can't answer that" a first-class branch of the schema, rather than
 * something the model has to express in prose, is what stops it from guessing at
 * questions the data cannot support.
 */

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { SCHEMA_CONTEXT } from './schema-context.js';
import type { ReferenceDate } from './reference-date.js';

export const MODEL = process.env.ANTHROPIC_MODEL?.trim() || 'claude-opus-5';

const QueryPlanSchema = z.object({
  answerable: z
    .boolean()
    .describe('True if the question can be answered from the tables described.'),
  interpretation: z
    .string()
    .describe(
      'One sentence, for the user, restating what you understood the question to ask — which records, what is measured, how it is grouped and ordered. Empty string when answerable is false.',
    ),
  sql: z
    .string()
    .describe(
      'A single read-only SQLite SELECT statement, no trailing semicolon. Empty string when answerable is false.',
    ),
  reason: z
    .string()
    .describe(
      'When answerable is false, the reason: what is ambiguous, or what the data does not contain. Empty string when answerable is true.',
    ),
});

export type QueryPlan = z.infer<typeof QueryPlanSchema>;

function systemPrompt(reference: ReferenceDate): string {
  return `You translate plain-English analytical questions into SQLite queries over an e-commerce database.

${SCHEMA_CONTEXT}

Today's date for the purpose of this question is ${reference.date} (${reference.iso}).
Resolve every relative date against that value: "yesterday" is the day before it,
"the last seven days" is the seven-day window ending on it.

Rules for the SQL you produce:
- Exactly one statement. It must be a SELECT (a leading WITH is fine). Never write
  to the database.
- Name every money column with a _cents suffix, e.g. total_order_value_cents. The
  caller formats columns by that suffix, so an unsuffixed money column is displayed
  wrong.
- Always include human-readable identifying columns, not just ids: a user's name,
  a product's name. Someone should be able to read the result without a lookup.
- Include the numbers the answer rests on, and order the result so the answer is
  the first row.
- When the question implies a "top N" and gives no N, return the top 5. Otherwise
  add a LIMIT only when the question asks for one.

Decide answerable = false when the question cannot be answered from these tables
(for example anything about margins, costs, stock, shipping, returns, or refunds —
none of which exist here), or when it is too ambiguous to answer one way. Do not
guess and do not answer a different, easier question. Prefer the natural reading
of a question over refusing it: "how much did X spend" plainly means the value of
their orders, and needs no clarification.`;
}

export interface PlanQueryOptions {
  client: Anthropic;
  question: string;
  reference: ReferenceDate;
  /** Prior failed attempts, fed back so the model can correct itself. */
  attempts?: Array<{ sql: string; error: string }>;
}

/** Ask the model for a query plan. Throws on API failure or unparsable output. */
export async function planQuery({
  client,
  question,
  reference,
  attempts = [],
}: PlanQueryOptions): Promise<QueryPlan> {
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: question }];

  for (const attempt of attempts) {
    messages.push({
      role: 'assistant',
      content: `I proposed this query:\n${attempt.sql}`,
    });
    messages.push({
      role: 'user',
      content: `That query failed: ${attempt.error}\n\nFix it and return a corrected query. If the question genuinely cannot be answered from these tables, set answerable to false instead.`,
    });
  }

  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 4096,
    system: systemPrompt(reference),
    messages,
    output_config: { format: zodOutputFormat(QueryPlanSchema) },
  });

  if (response.stop_reason === 'refusal') {
    throw new Error(
      `The model declined to answer this question (${response.stop_details?.category ?? 'unspecified'}).`,
    );
  }

  const plan = response.parsed_output;
  if (!plan) {
    throw new Error('The model did not return a usable query plan.');
  }
  return plan;
}
