/**
 * The question-to-answer pipeline.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { Database as DatabaseType } from 'better-sqlite3';
import { planQuery } from './planner.js';
import { narrateResult } from './narrator.js';
import { runQuery, QueryExecutionError, DEFAULT_MAX_ROWS, type QueryResult } from './query.js';
import { UnsafeSqlError } from './guard.js';
import type { ReferenceDate } from './reference-date.js';

/** How many times a failing query is sent back to the planner to be corrected. */
export const MAX_REPAIR_ATTEMPTS = 2;

export type Answer =
  | {
      status: 'answered';
      question: string;
      interpretation: string;
      result: QueryResult;
      answer: string;
      reference: ReferenceDate;
      /** Failed queries that preceded the successful one, if any. */
      repairs: Array<{ sql: string; error: string }>;
    }
  | {
      status: 'unanswerable';
      question: string;
      reason: string;
      reference: ReferenceDate;
    };

export interface AskOptions {
  client: Anthropic;
  db: DatabaseType;
  question: string;
  reference: ReferenceDate;
  maxRows?: number;
}

/**
 * Answer one question.
 *
 * The retry loop exists because a model-written query can be valid English and
 * invalid SQL — a mistyped column, a bad join. SQLite's error is specific enough
 * to be useful, so it goes back to the planner rather than to the user. Retries
 * are bounded, and a query that is rejected as unsafe is never retried: that is
 * not a mistake to correct, it is a request to refuse.
 */
export async function ask({
  client,
  db,
  question,
  reference,
  maxRows = DEFAULT_MAX_ROWS,
}: AskOptions): Promise<Answer> {
  const attempts: Array<{ sql: string; error: string }> = [];

  for (let round = 0; round <= MAX_REPAIR_ATTEMPTS; round++) {
    const plan = await planQuery({ client, question, reference, attempts });

    if (!plan.answerable) {
      return {
        status: 'unanswerable',
        question,
        reason: plan.reason || 'The question cannot be answered from this data.',
        reference,
      };
    }

    try {
      const result = runQuery(db, plan.sql, maxRows);
      const answer = await narrateResult({
        client,
        question,
        interpretation: plan.interpretation,
        result,
      });
      return {
        status: 'answered',
        question,
        interpretation: plan.interpretation,
        result,
        answer,
        reference,
        repairs: attempts,
      };
    } catch (error) {
      if (error instanceof UnsafeSqlError) {
        // Refuse rather than retry: the model asked for something it must not have.
        throw error;
      }
      if (error instanceof QueryExecutionError) {
        attempts.push({ sql: plan.sql, error: error.message });
        continue;
      }
      throw error;
    }
  }

  const last = attempts[attempts.length - 1];
  throw new Error(
    `Could not produce a working query after ${MAX_REPAIR_ATTEMPTS + 1} attempts. Last error: ${last?.error ?? 'unknown'}`,
  );
}
