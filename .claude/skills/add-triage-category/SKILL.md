---
name: add-triage-category
description: Checklist for adding, renaming, or removing a triage category (e.g. Politics) — every file that duplicates the category set and why.
---

# Adding or renaming a triage category

The category set is duplicated across several files by design; a new one needs
all of:

- `src/classify.ts` — the `Category` union, `CATEGORIES`, and a
  `CATEGORY_CRITERIA` entry (`covers` / `not_for` / `examples`). The
  `satisfies Record<Category, …>` makes a missing entry a type error. Update
  the `not_for` of any neighbouring category the new one takes mail from.
- `src/commands/triage.ts` — `MAILBOX_NAMES` (the Fastmail folder leaf),
  `LABELS`, `COLOR`, `emptyTotals()`.
- `src/senderstore.ts` — `CACHEABLE_CATEGORIES`, but only if the category
  describes a *sender* rather than a message. `reply` and `fyi` are excluded on
  purpose; caching them would misfile future mail.
- `src/heuristics.ts` — `HeuristicCategory`, only if headers alone can prove it.

The criteria keys are the Choice labels TypeSafe returns, so the model can
only ever answer with a category in `CATEGORY_CRITERIA`. Re-check
`--min-confidence` after the change: a new label that overlaps an existing one
splits probability between them and lowers confidence on that boundary.
