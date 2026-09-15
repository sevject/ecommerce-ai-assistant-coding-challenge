# E-Commerce AI Analytics Assistant: Coding Challenge

A starting point for a two-hour take-home. It sets up a small e-commerce data
model and a SQLite database seeded with sample data. The challenge itself,
building an assistant that answers questions about this data, is described in
[CHALLENGE.md](./CHALLENGE.md).

This repository contains a solution: a command-line assistant that answers
questions about the data in plain English. See [NOTES.md](./NOTES.md) for the
design reasoning, assumptions, and known gaps.

## Requirements

Node.js 20 or newer and npm.

## Setup

```bash
npm install
npm run db:create
```

`npm run db:create` builds `database/ecommerce.sqlite` from the JSON files in
`data/seed/`. Run `npm run db:reset` to rebuild it from scratch. The database file
is git-ignored; the seed data is the source of truth.

You can point the database somewhere else with the `DATABASE_PATH` environment
variable (see `.env.example`).

There's no test runner, linter, or type-checking configured. Add whatever you like.

## Running the assistant

Set an Anthropic API key, then ask a question:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm run ask -- "Who ordered the most in the last seven days?"
```

The question goes in quotes after `--`. Output looks like this:

```
Olivia Bennett ordered the most, with $3,105.80 across 5 orders in the seven days
ending 2026-07-20. Anne-Marie Dubois ($1,468.92) and Liam O'Brien ($1,333.87)
follow.

Understood as: Top 5 users by total order value in the 7 days ending 2026-07-20.
Relative dates measured from: 2026-07-20 (most recent order in the database)

SQL:
  SELECT u.name AS user_name, ...

Result (5 rows):
  user_name          order_count  total_order_value_cents
  ─────────────────  ───────────  ───────────────────────
  Olivia Bennett               5                $3,105.80
  ...
```

### Options

| Option | Meaning |
| --- | --- |
| `--now=<value>` | What "today" means for relative dates. `data` (default) uses the most recent order in the database; `real` uses the system clock; or pass a date like `2026-07-20`. |
| `--max-rows=<n>` | Cap on rows returned. Default 200. |
| `--json` | Print the answer, SQL, and rows as JSON. |
| `--quiet` | Print only the prose answer. |
| `--help` | Usage. |

Exit codes: `0` answered, `1` error, `2` the question could not be answered from
the data, `3` the generated query was refused as unsafe.

### About `--now`

The seeded orders run from 2026-06-01 to 2026-07-20, which is in the past. If
"yesterday" were measured against the real system clock, every relative-date
question would correctly return nothing, which looks like a bug. So the reference
date defaults to the most recent order in the database, and every answer prints
which date it used. Use `--now=real` for true system-clock behaviour.

### Environment

| Variable | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` | Required. |
| `ANTHROPIC_MODEL` | Optional model override. Defaults to `claude-opus-5`. |
| `DATABASE_PATH` | Optional path to the SQLite file. |

These are read from the environment; a `.env` file is not loaded automatically.
To use one, run `node --env-file=.env node_modules/.bin/tsx src/cli.ts "..."`.

## Tests and type checking

```bash
npm test         # node:test, no API key needed
npm run typecheck
```

The tests cover the SQL guard, the execution layer, money formatting, and
reference-date resolution — the parts that must be right regardless of what the
model produces. The model calls themselves are not covered; see
[NOTES.md](./NOTES.md).

## AI coding assistants

You're welcome to use AI coding assistants, and we expect you will. You're still
responsible for understanding and explaining what you submit. More in
[CHALLENGE.md](./CHALLENGE.md).
