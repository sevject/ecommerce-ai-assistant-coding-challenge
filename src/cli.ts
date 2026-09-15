#!/usr/bin/env node
/**
 * Command-line entry point.
 *
 *   npm run ask -- "Who ordered the most in the last seven days?"
 */

import Anthropic from '@anthropic-ai/sdk';
import { openDatabase } from './database/connection.js';
import { ask } from './assistant/ask.js';
import { MODEL } from './assistant/planner.js';
import { DEFAULT_MAX_ROWS } from './assistant/query.js';
import { UnsafeSqlError } from './assistant/guard.js';
import { formatTable, indent } from './assistant/format.js';
import {
  resolveReferenceDate,
  describeReferenceDate,
  type NowOption,
} from './assistant/reference-date.js';

const USAGE = `Ask questions about the e-commerce database in plain English.

Usage:
  npm run ask -- "<question>" [options]

Options:
  --now=<value>    What "today" means for relative dates like "yesterday".
                   "data" (default) uses the most recent order in the database,
                   "real" uses the system clock, or pass a date (2026-07-20).
  --max-rows=<n>   Cap on rows returned (default ${DEFAULT_MAX_ROWS}).
  --json           Print the whole result as JSON instead of a table.
  --quiet          Print only the answer, without the SQL and table.
  -h, --help       Show this message.

Environment:
  ANTHROPIC_API_KEY   Required.
  ANTHROPIC_MODEL     Optional model override (default ${MODEL}).
  DATABASE_PATH       Optional path to the SQLite file.

Examples:
  npm run ask -- "Which products were ordered in the greatest quantities?"
  npm run ask -- "What was the total order value yesterday?"
  npm run ask -- "How many orders did each user place?" --json
`;

interface ParsedArgs {
  question: string;
  now: NowOption;
  maxRows: number;
  json: boolean;
  quiet: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    question: '',
    now: 'data',
    maxRows: DEFAULT_MAX_ROWS,
    json: false,
    quiet: false,
    help: false,
  };
  const words: string[] = [];

  for (const arg of argv) {
    if (arg === '-h' || arg === '--help') parsed.help = true;
    else if (arg === '--json') parsed.json = true;
    else if (arg === '--quiet') parsed.quiet = true;
    else if (arg.startsWith('--now=')) parsed.now = arg.slice('--now='.length);
    else if (arg.startsWith('--max-rows=')) {
      const value = Number.parseInt(arg.slice('--max-rows='.length), 10);
      if (!Number.isInteger(value) || value < 1) {
        throw new Error(`--max-rows must be a positive integer, got "${arg}".`);
      }
      parsed.maxRows = value;
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option "${arg}". Run with --help to see the options.`);
    } else {
      // Unquoted questions arrive as several words; join them back together.
      words.push(arg);
    }
  }

  parsed.question = words.join(' ').trim();
  return parsed;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || (!args.question && process.argv.length <= 2)) {
    process.stdout.write(USAGE);
    return args.help ? 0 : 1;
  }

  if (!args.question) {
    process.stderr.write('Please pass a question, e.g. npm run ask -- "What is the average order value?"\n');
    return 1;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    process.stderr.write(
      'ANTHROPIC_API_KEY is not set. Export it first:\n  export ANTHROPIC_API_KEY=sk-ant-...\n',
    );
    return 1;
  }

  const client = new Anthropic();
  const db = openDatabase({ readonly: true });

  try {
    const reference = resolveReferenceDate(db, args.now);
    const answer = await ask({
      client,
      db,
      question: args.question,
      reference,
      maxRows: args.maxRows,
    });

    if (args.json) {
      process.stdout.write(`${JSON.stringify(answer, null, 2)}\n`);
      return answer.status === 'answered' ? 0 : 2;
    }

    if (answer.status === 'unanswerable') {
      process.stdout.write(`\nI can't answer that.\n\n${answer.reason}\n\n`);
      return 2;
    }

    if (args.quiet) {
      process.stdout.write(`${answer.answer}\n`);
      return 0;
    }

    const { result } = answer;
    const rowCount = `${result.rows.length} row${result.rows.length === 1 ? '' : 's'}${
      result.truncated ? ` (capped at ${args.maxRows})` : ''
    }`;

    process.stdout.write(
      [
        '',
        answer.answer,
        '',
        `Understood as: ${answer.interpretation}`,
        `Relative dates measured from: ${describeReferenceDate(reference)}`,
        '',
        'SQL:',
        indent(result.sql),
        '',
        `Result (${rowCount}):`,
        indent(formatTable(result)),
        '',
      ].join('\n'),
    );

    if (answer.repairs.length > 0) {
      process.stdout.write(
        `Note: ${answer.repairs.length} earlier quer${answer.repairs.length === 1 ? 'y' : 'ies'} failed and ${answer.repairs.length === 1 ? 'was' : 'were'} corrected automatically.\n\n`,
      );
    }

    return 0;
  } catch (error) {
    if (error instanceof UnsafeSqlError) {
      process.stderr.write(`\nRefused to run the generated query: ${error.message}\n\n`);
      return 3;
    }
    if (error instanceof Anthropic.AuthenticationError) {
      process.stderr.write('\nANTHROPIC_API_KEY was rejected. Check the key and try again.\n\n');
      return 1;
    }
    if (error instanceof Anthropic.RateLimitError) {
      process.stderr.write('\nRate limited by the Anthropic API. Wait a moment and retry.\n\n');
      return 1;
    }
    if (error instanceof Anthropic.APIError) {
      process.stderr.write(`\nAnthropic API error (${error.status}): ${error.message}\n\n`);
      return 1;
    }
    process.stderr.write(`\nError: ${(error as Error).message}\n\n`);
    return 1;
  } finally {
    db.close();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`Unexpected failure: ${(error as Error).stack ?? error}\n`);
    process.exitCode = 1;
  },
);
