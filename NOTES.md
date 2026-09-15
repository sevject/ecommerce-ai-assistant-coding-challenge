# Solution notes

## Reading of the challenge

The task is a natural-language → SQL analytics assistant over the seeded SQLite
e-commerce database. An LLM must do the actual interpretation work (no canned or
regex intent matching), it must run read-only queries, return a readable answer
that shows the numbers, and say "I can't answer that" rather than guess when a
question is ambiguous or unsupported.

Constraints I took from `CHALLENGE.md`:

- Two-hour timebox. They explicitly prefer one question answered end-to-end over
  a broad attempt that doesn't run.
- Interface: CLI or small HTTP API, my call. No UI, no auth, no deployment.
- Money is integer cents everywhere. Historical order value must use
  `order_items.unit_price_cents`, **not** `products.current_price_cents`. This is
  the deliberate trap in the data and the thing most likely to produce answers
  that look right and are wrong.
- Timestamps are ISO-8601 UTC strings that sort lexicographically, so date
  filtering is plain string comparison.
- Deliverables include prose: how it works and why, assumptions, known rough
  edges, what I'd do next.

## What the starter repo already gives you

- `src/database/schema.sql` — 4 tables (`users`, `products`, `orders`,
  `order_items`) with FK indexes already in place.
- `src/database/connection.ts` — `openDatabase({ readonly })`. The read-only mode
  is already there, which is the free win for "must not change the data".
- `src/database/types.ts`, seed JSON (25 users, 30 products, 80 orders, 192 line
  items), `npm run db:create` / `db:reset`.
- TypeScript + tsx + better-sqlite3. No test runner, linter, or typecheck
  configured; the README says to add what I like.

## The main design decision

Whether the LLM generates SQL directly, or picks from a set of parameterized
query templates via tool-calling.

Templates are safer but cap the question range, and the brief explicitly says it
should "handle a range of questions the data can support, not just canned
responses to the specific examples". A template set is a canned response with
extra steps — it fails the actual requirement.

So: **the model generates SQL**, and safety comes from the execution layer rather
than from restricting what the model may express.

- The connection is opened read-only, so SQLite itself rejects any write.
- Every statement is prepared and then checked with better-sqlite3's `.readonly`
  and `.reader` flags — that is SQLite's own analysis of the statement, not a
  regex guess.
- A lightweight lexical guard runs first (single statement, must start with
  `SELECT`/`WITH`, no DDL/DML/`PRAGMA`/`ATTACH` keywords) so bad input fails with
  a clear message instead of a SQLite error.
- Rows are streamed with a hard cap rather than trusting the model to add a
  `LIMIT`.

That is four independent layers, and the one that actually matters (the read-only
connection) does not depend on the model behaving.

## The date problem

The seed data's orders run from **2026-06-01** to **2026-07-20**. Today is later
than that. So "yesterday" and "in the last seven days" measured against the real
system clock correctly return zero rows — which is technically right and
practically useless, and worse, looks like a bug.

I made "now" explicit instead of implicit. The assistant resolves a *reference
date*, defaulting to the latest `ordered_at` in the database, and prints which
date it used. `--now=real` uses the system clock, and `--now=<ISO date>` pins it
to anything you like. The reference date is passed to the model in the prompt, so
relative-date reasoning is grounded in a value the user can see rather than a
hidden assumption.

This is the kind of call the brief asks to be told about, so it's called out in
the README and in every answer the CLI prints.

## Shape

CLI, because the deliverable is "ask a question, read an answer" and an HTTP API
would add a server, a port, and a client for no gain inside the timebox.

```
question
  → plan (LLM, structured output)  → { sql, interpretation } | { cannot_answer, reason }
  → guard (lexical)
  → prepare + SQLite readonly/reader check
  → execute on a read-only connection, capped row stream
  → format (cents → currency, table)
  → narrate (LLM, given the question + the actual rows)
  → answer
```

Two model calls, not one. The first turns the question into SQL; the second
writes the prose answer *from the rows that actually came back*, so the summary
can't describe numbers the query didn't return. If the SQL fails to prepare or
execute, the error is fed back to the planner for a bounded number of retries.

## Correctness handling for the price trap

The schema context given to the model states the two-price rule explicitly, and
the planner prompt requires historical monetary values to come from
`order_items.unit_price_cents`. Money columns are named with a `_cents` suffix by
convention, which is also what the formatter keys on to render currency — so a
model that reaches for `current_price_cents` on a historical question produces a
visibly wrong column name as well as a wrong number.

## An observed failure: the narration over-claiming

Worth recording in full, because it is the most interesting thing that went wrong
and the safeguards I had built did not catch it.

Asked *"how many chargers were ordered?"*, the assistant answered:

> 6 charger units were ordered in total. These all came from a single product, the
> Phone Charger 65W — it's the only product whose name contains "charger."

The first sentence is correct. The second is false: `Wireless Charger Pad` is also
in the catalogue. It has never been ordered.

The query was right. It anchors on `order_items` and inner-joins to `products`:

```sql
FROM order_items oi
JOIN products p ON p.id = oi.product_id
WHERE lower(p.name) LIKE '%charger%'
```

That is the correct shape for "how many were ordered" — but it makes a product
with zero line items structurally invisible. The result set means *chargers that
were ordered*, not *chargers*, so absence from it carries no information about
whether something exists.

The narrator receives only the question, the planner's interpretation, the SQL
text, and the rows. It has no access to `products`, no schema, and no way to know
the join was inner. It saw one product row and concluded "one row = one matching
product in the catalogue" — a reasonable inference from a false premise.

My guardrail did not apply. The rule read *"never introduce a number that is not
in them"*, which is **number-scoped**; the false sentence contains no number. It
is a claim about set membership, and it walked straight through a constraint
written to police arithmetic. Two things made it likelier: the planner's own
interpretation described a "per-product breakdown", which implies an exhaustive
decomposition, and the instruction to write "two or three sentences" created
pressure to elaborate past the one sentence the data supported.

The fix, in `narrator.ts`, is four changes to the prompt:

- State the epistemic status of the rows up front — the output of one filtered
  query, with exclusions the narrator cannot see, and specifically that queries
  about orders inner-join from `order_items` so anything never ordered is absent
  while being perfectly real.
- Broaden the rule from numbers to any unsupported number, name, or fact, and ban
  claims of completeness, exclusivity, or non-existence outright. The line is
  drawn between quantifying over *the rows* ("all six units were X", fine) and
  quantifying over *the database* ("the only product", not fine).
- Cut the sentence quota to one or two, with an explicit instruction to stop
  rather than add context.
- Include this exact case as a worked wrong/right example. A concrete instance
  constrains a model far better than an abstract rule.

The same latent bug was in the empty-result rule, which said to report that the
query "found nothing matching" — one paraphrase away from "there are no
chargers". It now says nothing *matched*, and explicitly not to claim the thing
does not exist.

**What this class of failure teaches.** I had listed "semantic errors pass
silently" as a known gap, but I had framed it as *wrong SQL producing a confident
wrong answer*, and my mitigation was printing the SQL so a reader could check it.
This failure is the inverse and sneakier: right SQL, right numbers, prose that
overstepped them. Printing the query is no defence, because there is nothing
wrong with the query. Any stage that restates results in natural language needs
its own constraints, independent of whether the stage feeding it was correct.

## Layout

```
src/
  cli.ts                      argument parsing, output, exit codes
  assistant/
    ask.ts                    the pipeline and the bounded repair loop
    planner.ts                question -> SQL (Claude, structured output)
    narrator.ts               rows -> prose answer (Claude)
    schema-context.ts         what the model is told about the data
    guard.ts                  lexical SQL safety check
    query.ts                  prepare, verify read-only, execute, cap rows
    format.ts                 cents -> currency, rows -> table
    reference-date.ts         resolving "now"
    assistant.test.ts         tests for everything above except the model calls
```

`src/database/connection.ts` is used as provided; nothing in the starter was
modified apart from adding `strict: true` to `tsconfig.json` and three scripts
(`ask`, `test`, `typecheck`) to `package.json`.

[`src/assistant/README.md`](./src/assistant/README.md) walks through each file and
why it is shaped the way it is.

## Assumptions

- **"Order value" means the sum of its line items** at the price charged at the
  time (`quantity * unit_price_cents`). There is no total column on `orders`, so
  this is the only available definition.
- **"Ordered the most" means the most by value**, not by order count or unit
  count, when the question mentions order values. Where a question is genuinely
  ambiguous the model is instructed to refuse rather than pick — but "how much
  did X spend" is treated as a plain question about order value, not an
  ambiguous one. Refusing too readily is as bad as guessing.
- **A top-N question with no N returns 5.** Arbitrary, but it has to be something,
  and the question examples in the brief use five.
- **The reference date defaults to the last order in the data**, as described
  above.
- **Amounts are shown in dollars.** Nothing in the schema or the seed files
  records a currency — the `_cents` columns are bare integers with no unit
  attached — so the symbol is a labelling decision, not something read from the
  data. It follows the one example in the brief (`$45.99` is `4599`).
  `CURRENCY_SYMBOL` in `format.ts` is the single place it is set. A genuinely
  multi-currency dataset would need the currency to travel with each amount, which
  is a schema change, not a formatting one.
- **200 rows is enough for an analytical answer.** Anything larger is a report,
  not an answer to a question, and the result is flagged as truncated.
- **One question per invocation.** No conversation, no follow-ups, no memory of
  the previous question.
- **Single user, local, trusted.** No authentication, no rate limiting, no
  per-user quota, no audit log of what was asked.

## What is rough or missing

- **The live model path is barely tested.** It has been run against the real API
  and works — the charger question above produced correct SQL and a correct
  number — but only for a handful of questions, and the one real run that was
  examined closely turned up a genuine bug. The pipeline around the model calls
  was verified end-to-end with a stubbed client, covering the happy path, the
  repair loop, refusal, an unsafe query, and an empty result. The prompts remain
  the least-proven part, and the narrator fix described above has not itself been
  run. Prompt quality is exactly what needs real runs to judge.
- **No evaluation set.** There is no way to tell whether a prompt change makes
  the assistant better or worse. For a real system this matters more than any
  individual feature, and it is the piece I would build next.
- **Semantic errors pass silently.** The repair loop catches SQL that does not
  *run*. SQL that runs and answers the wrong question — averaging over line items
  instead of orders, say — produces a confident, wrong answer. The safeguards are
  the prompt, the `_cents` naming convention, and printing the SQL so a reader can
  check it. That is weaker than I would like, and the charger failure above showed
  the reader-checks-the-SQL safeguard does not cover errors introduced *after* the
  query. The narrator is now constrained; nothing yet validates the query itself.
- **Inner joins hide zeroes, and the planner is not told to care.** "How many
  chargers were ordered" returns only chargers that were ordered; one with zero
  orders vanishes rather than showing a 0. The narrator no longer misreports this,
  but arguably the better answer lists the zero. Whether to prefer a `LEFT JOIN`
  from the dimension table is a real design question — some questions genuinely
  want only what was ordered — so it deserves a decision rather than a default.
- **The `_cents` convention is a soft contract.** If the model names a money
  column something else, it renders as a bare integer — off by a factor of 100
  and not obviously wrong. A stricter version would check the plan's column names
  against the aggregates in the SQL before running it.
- **Cost and latency are not managed.** Two model calls per question, no caching
  and no streaming, so there is a multi-second pause before any output appears.
  The system prompt is a stable prefix and an obvious caching candidate.
- **The row cap can change an answer.** A query returning more than 200 rows is
  truncated before the narrator sees it, so a summary over a capped result
  describes only the first 200 rows. It is flagged, but flagging is not fixing.
- **`--now` shifts the reference date but not the data.** Asking about "last
  week" with `--now=2026-06-15` works, but there is no way to ask "as the data
  looked on 2026-06-15" — there is no history to replay.

## What I would do next

In order:

1. **Exercise it properly against the real API** and iterate on the two prompts.
   A few questions have been run; the example questions in the brief have not, nor
   has the narrator fix. Nothing below is worth doing before this.
2. **Build an eval set** — twenty or so questions with known-correct answers,
   including the ones designed to trip the price trap and the ambiguous ones that
   should be refused. Score every prompt change against it.
3. **Verify the plan before running it.** Cheap structural checks first: does a
   historical-value question's SQL touch `current_price_cents`, do money columns
   carry the `_cents` suffix, does a "per order" average group by order. These
   catch the specific semantic errors that are both likely and silent.
4. **Add conversational follow-ups.** "What about the week before?" is the natural
   next question and currently needs the whole thing restated.
5. **Cache the system prompt** and stream the narration, so the first token
   arrives quickly.
6. **Widen the schema context to be generated**, not hand-written, so the
   assistant does not silently go stale when a column is added — while keeping
   the hand-written semantic notes, which are the part that actually matters.
