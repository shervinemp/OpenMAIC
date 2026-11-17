# Learning evidence, mastery, and review

This directory is the substrate for the platform's longitudinal learning loop. It
turns graded observations into concept estimates and a review schedule. The
reducers own no React and no network calls, so every rule is testable with a
fixed clock; one client-side adapter (`store.ts`) writes the results into the
learner's RuntimeStore partition.

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

## Concept tags

Generated quiz questions and exam items carry an optional `concepts` list. The
shared normalizer (`normalizeConceptTags` in `@openmaic/dsl`) trims list
markers and quotes, drops format-only tags such as `quiz` or `multiple choice`,
lower-cases the rest, deduplicates, and caps a question at four tags. Lower case
is the identity rule: `Recursion` and `recursion.` must be one concept for
mastery to add up across scenes, not two.

Tags are generated from the scene's outline key points and reused across the
questions that measure the same idea. Imported or hand-edited content is
normalized again when the quiz view builds evidence, so sloppy casing cannot
fragment a learner's history.

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

## Persistence

`store.ts` keeps the log in the existing RuntimeStore partition
`(stageId, learnerKey)`, under one long-lived session of kind `learning`. That
keeps learner history out of the course document (shared and git-synced) and
out of localStorage (per browser, not per learner).

Two record kinds ride the append-only session:

- one `evidence` observation per append, with the same idempotency key the
  model uses;
- an occasional `reviewCards` snapshot. Reads merge snapshots per card, so a
  later write for one card does not erase another card written by a second tab.

`store-payload.ts` folds the records into `{ evidence, reviewCards }`. Evidence
uses the bounded, first-write-wins log; a card snapshot with a corrupt due date
is dropped rather than repaired. The payload is registered as a RuntimeStore
validator, so a malformed row is rejected at the write boundary as well. The
logical evidence window is bounded on read; physical compaction of very old
records is left to the runtime store.

Review card ids are scene-qualified (`stageId:sceneId:itemId`): quiz item ids
repeat across scenes (`q1`), and an unqualified id would merge unrelated items
into one card.

## Wired today

- Quiz questions and exam items are tagged during generation.
- A reviewed quiz attempt writes evidence and creates review cards for tagged,
  graded items (`recordQuizLearning`, called from `quiz-view`). The write is
  idempotent, so reopening a reviewed attempt retries safely.
- Ungraded items become evidence but never review cards.
- Retagging a question refreshes the card's concepts without changing its
  schedule.

## Next

1. Record review ratings and fold them back into the card and mastery evidence.
2. Surface a due queue and a per-concept dashboard.
3. Add distractor-to-misconception diagnosis and remediation links.
4. Attach exam and activity producers to the same log.
