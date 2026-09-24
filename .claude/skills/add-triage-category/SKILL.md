---
name: add-triage-category
description: Checklist for adding, renaming, or removing a triage category (e.g. Politics) — every file that duplicates the category set and why.
---

# Adding or renaming a triage category

The category set is duplicated across several files by design; a new one needs
all of:

- `src/ai.ts` — the `Category` union, `CATEGORIES`, the `CATEGORY_RUBRIC` text
  (including the "tricky boundaries" and worked-examples sections), and the
  literal category list inside both `Return ONLY a JSON array…` lines.
- `src/commands/triage.ts` — `MAILBOX_NAMES` (the Fastmail folder leaf),
  `LABELS`, `COLOR`, `emptyTotals()`.
- `src/senderstore.ts` — `CACHEABLE_CATEGORIES`, but only if the category
  describes a *sender* rather than a message. `reply` and `fyi` are excluded on
  purpose; caching them would misfile future mail.
- `src/heuristics.ts` — `HeuristicCategory`, only if headers alone can prove it.

Model output is untrusted: `parseTriageResults` / `parseSenderVerdicts` tolerate
fences and prose and silently drop entries with unknown categories, so a new
category that isn't in `CATEGORIES` fails as "unclassified", not as an error.
