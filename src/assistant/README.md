# The assistant module

Nine files, ~980 lines. The organising principle: **two files talk to the model,
six are pure deterministic code, one tests them.** That split is why the test
suite runs without an API key.

```
ask.ts ──┬── planner.ts ── schema-context.ts     [model call]
         │              └─ reference-date.ts
         ├── guard.ts  ←── query.ts
         └── narrator.ts ── format.ts            [model call]
```

Design reasoning, assumptions, and known gaps are in [../../NOTES.md](../../NOTES.md).

---

## `ask.ts` — the pipeline

The module's entry point, and the only file that knows the whole sequence:
plan → guard → execute → narrate. Everything else is a component it calls.

Its real content is the **repair loop** (`MAX_REPAIR_ATTEMPTS = 2`). A
model-written query can be perfect English and invalid SQL — a mistyped column, a
bad join. SQLite's error message is specific enough to be actionable, so it goes
back to the planner rather than to the user.

The important distinction is in the catch block: a `QueryExecutionError` is
retried, but an `UnsafeSqlError` is rethrown immediately and never retried. A
broken query is a mistake to correct; an unsafe one is a request to refuse.

Returns a discriminated union — `{status: 'answered', ...}` or
`{status: 'unanswerable', reason}` — so the CLI can treat refusal as a normal
outcome with its own exit code rather than as an error.

## `planner.ts` — question → SQL

The first model call. Defines a Zod schema (`answerable`, `interpretation`,
`sql`, `reason`) and passes it through `zodOutputFormat` to
`client.messages.parse()`, so the response shape is structurally guaranteed
rather than parsed out of prose.

**Making `answerable: false` a first-class branch of the schema is the design
decision here.** If refusal had to be expressed in prose, the model would drift
toward answering a nearby easier question instead. As a schema field it is a
clean fork with nowhere to drift to.

The system prompt carries the rules that matter: a single SELECT, the `_cents`
suffix on money columns, include human-readable names and not just ids, top-5 by
default. It also pushes *against* over-refusing — "how much did X spend" is a
plain question about order value, not an ambiguous one. Refusing too readily
fails the brief as surely as guessing does.

Also holds `MODEL` (`claude-opus-5`, overridable with `ANTHROPIC_MODEL`).

## `schema-context.ts` — what the model is told about the data

A hand-written description of the four tables, imported into the planner's prompt.

Deliberately **not** generated from `sqlite_master`. A column list conveys names
and types; it cannot convey that `order_items.unit_price_cents` is what was
actually charged while `products.current_price_cents` is today's catalogue price,
or that the ISO-8601 timestamps sort correctly as plain text. Those are the facts
a model actually gets wrong, so they are stated explicitly — including a blunt
warning that choosing the wrong price column is the most common mistake.

The tradeoff: this goes stale if a column is added. Generating the structure while
keeping these semantic notes hand-written is the obvious improvement.

## `guard.ts` — lexical SQL safety

Rejects anything that is not a single read-only statement: must start with
`SELECT` or `WITH`, no DDL/DML/`PRAGMA`/`ATTACH`, no stacked statements.

The interesting part is `stripLiteralsAndComments`, which removes string
literals, quoted identifiers, and comments **before** any keyword matching runs.
Without it a product named `'Drop Shipping Insert Kit'` would trip the keyword
check, and a `;` inside a literal would look like a second statement. Both cases
are tested.

One subtlety: `REPLACE` is matched only as `REPLACE INTO`, because a bare
`replace(x, a, b)` is a legitimate SQLite string function that a reasonable query
might use.

This is the *weakest* of the safety layers, and deliberately so. It exists to
produce clear early error messages, not to be the real defence.

## `query.ts` — execution

Where safety actually lives, in four layers, strongest first:

1. The connection is opened **read-only**, so SQLite refuses any write outright.
   This layer does not depend on the model behaving.
2. `stmt.readonly` and `stmt.reader` — SQLite's own analysis of the prepared
   statement, which beats any keyword list one could write by hand.
3. The lexical guard, which catches multi-statement payloads that a per-statement
   check would not see as a whole.
4. Rows are **streamed with a hard cap** (`DEFAULT_MAX_ROWS = 200`) rather than
   trusting the model to include a `LIMIT`.

Wraps SQLite failures in `QueryExecutionError` so `ask.ts` can tell "retry this"
apart from "refuse this".

## `narrator.ts` — rows → prose

The second model call. It is separate from the planner because the planner has
not seen the data yet: summarising before the query runs lets the prose describe
numbers that never came back.

Most of its length is prompt guarding against one specific failure — reading
absence from a filtered result as absence from the database. It states that the
rows are the output of one filtered query with exclusions the narrator cannot
see, bans claims of completeness or non-existence about anything beyond those
rows, and carries a real worked example of the mistake.

`renderRowsForModel` pre-formats `_cents` columns as currency before the model
sees them, so the model never has to divide by 100 — only to copy.

## `format.ts` — presentation

`formatCents` is the **only place in the codebase that divides by 100**. All
arithmetic upstream stays in integer cents; the conversion happens once, at the
display boundary.

`formatCell` renders `_cents` columns as currency — the contract stated in the
planner's prompt, which is what makes it a convention rather than a guess about
the data. `formatTable` builds the aligned text table, right-aligning numeric
columns. `indent` nests SQL under headings in the CLI output.

## `reference-date.ts` — resolving "now"

Resolves what "yesterday" means, in three modes: `data` (the default, using
`MAX(ordered_at)`), `real` (the system clock), or an explicit date.

It exists because the seeded orders end on 2026-07-20. Measured against the real
clock, every relative-date question correctly returns nothing — right, useless,
and indistinguishable from a bug. `describeReferenceDate` produces the line the
CLI prints with every answer, so the assumption is visible rather than hidden.

## `assistant.test.ts` — 23 tests

Covers the guard, the execution layer, money formatting, table rendering, and
date resolution: everything that must be correct regardless of what the model
produces. Needs no API key.

```bash
npm test
```

The one worth singling out is *"computes order value from the historical unit
price, not the current one"*, which asserts that the two price columns yield
**different** totals. It tests no function directly. It guards the premise that
makes the price trap a trap, so the seed data cannot quietly stop exercising it.

The model calls themselves are not covered. An eval set is the fix, and it is
item 2 in the next-steps list in NOTES.md.
