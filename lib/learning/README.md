# Learning evidence, mastery, and review

This directory is the substrate for the platform's longitudinal learning loop. It
turns graded observations into concept estimates and a review schedule. It owns
no React, no IndexedDB, and no network calls, so every rule here is testable with
a fixed clock.

## The record

`LearningEvidence` is the one shape every practice surface can write: quiz,
exam, activity, PBL, or review. It carries the learner partition, the item, the
concepts the item measures, a 0..1 score, and an idempotency key.

Two invariants matter:

- **Ungraded is not wrong.** `outcome: 'ungraded'` is skipped by mastery and
  must not be scheduled for review. A grading outage is the absence of an
  observation.
- **The first write for an id wins.** Producers retry; replaying a submission
  must not double-count it.

Items are tagged with opaque `conceptIds`. The course owns the vocabulary. An
untagged item is still valid evidence about the item, but it cannot move a
concept estimate.

## Mastery

Concept mastery is a Beta posterior over graded evidence. The prior is
`Beta(1, 1)`: score 0.5, confidence 0. Correct credit raises `alpha`; missed
credit raises `beta`. Partial credit contributes to both, so it raises
confidence without pretending the concept is mastered. Confidence is derived
from the posterior variance relative to the prior, not from a raw count, so a
learner who answered one question is not shown as certain.

Mastery does not decay here. Forgetting belongs to the review scheduler; a
review success or lapse is simply new evidence.

## Review

The scheduler is SM-2 with a four-button rating (`again`, `hard`, `good`,
`easy`). A new card is due immediately. Successful reviews grow the interval
1 day, 6 days, then `interval * ease`. `again` returns the card in ten minutes
and resets the repetition count; it counts as a lapse only after the card had
been learned. `hard` is still a pass but lowers ease; `easy` raises it. Ease
never drops below 1.3.

Time is always passed in. `dueReviewCards` sorts by due date and applies a
caller-chosen cap; `reviewSummary` reports what is due, how many cards are new,
and when the next batch lands. A malformed due date is never treated as due.

A review result is evidence with half weight: self-rating is real signal, but
weaker than a fresh graded answer.

## What is not wired yet

There is no persistence, no UI, and no concept tagging in the generated content
schema. The intended next slices are:

1. Tag quiz and exam items with concepts during generation.
2. Append evidence when a quiz is reviewed and when an activity check settles.
3. Persist the log and cards in the learner partition.
4. Surface a due queue and a per-concept dashboard.

Until then, this module is a library with tests, not a feature. Keeping it pure
is deliberate: the persistence and UI layers can change without rewriting the
model, and the model can be validated before it starts influencing what a
learner sees.
