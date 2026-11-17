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

Generated quiz questions and exam items carry an optional `concepts` list.
Activities carry one scene-level list instead: every check in a lab is evidence
about the same small set of ideas. The shared normalizer
(`normalizeConceptTags` in `@openmaic/dsl`) trims list markers and quotes, drops
format-only tags such as `quiz` or `multiple choice`, lower-cases the rest,
deduplicates, and caps an item at four tags. Lower case is the identity rule:
`Recursion` and `recursion.` must be one concept for mastery to add up across
scenes, not two.

Tags are generated from the scene's outline key points and reused across the
questions that measure the same idea. Imported or hand-edited content is
normalized again when the quiz view builds evidence, so sloppy casing cannot
fragment a learner's history. Activity evidence normalizes the scene tags for the
same reason; a legacy untagged lab still records check history, it just cannot
move a concept estimate.

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
logical evidence window is bounded on read.

Physical compaction is log-structured, not a checkpoint rewrite. When one
active session reaches 2,000 records and its oldest record is 30 days old, a
throttled pass (at most once per stage per six hours, after the learning
overlay loads) creates a fresh active session and archives the old one with an
optimistic tail check. A later pass deletes an inactive session only when
nothing in it is still visible: none of its evidence survives the bounded
window, and none of its card snapshots is the latest snapshot for a card.
Active sessions are never deleted, so a concurrent writer cannot lose a record;
nothing is copied, so a partial failure only leaves records for the next pass.

Review card ids are scene-qualified (`stageId:sceneId:itemId`): quiz item ids
repeat across scenes (`q1`), and an unqualified id would merge unrelated items
into one card.

## Wired today

- Quiz questions and exam items are tagged during generation.
- Activity labs are tagged with scene-level concepts during generation. A
  completed session records one evidence row per check, once per scene visit.
  The starter is expected to fail, so an incomplete run stays formative feedback
  rather than a mastery observation; code, SQL, and server-terminal labs complete
  through their Run button, and the simulated terminal completes when every
  check passes its final session state. Activities create no review cards: a
  check is an application task, not a memory prompt with a question to show in
  review.
- A reviewed quiz attempt writes evidence and creates review cards for tagged,
  graded items (`recordQuizLearning`, called from `quiz-view`). The write is
  idempotent, so reopening a reviewed attempt retries safely.
- A reviewed exam attempt writes per-item MC and FR evidence from the drawn
  form (`recordExamLearning`, called from `exam-view`). Partial FR credit is
  preserved; a missing grade is `ungraded`, not zero. The attempt stores the
  `ExamSpec.generatedAt` it was drawn from, so a regenerated pool cannot map
  old answers onto recycled question ids. Legacy attempts are not backfilled.
- Exam items do not create review cards yet: a pool item has no owning scene to
  send the learner back to. Their evidence still feeds concept mastery. A pool
  item whose concepts match a covered teaching outline conservatively gets a
  `remediationOutlineId`, and exam review offers a jump to that live lesson; the
  link never creates a review card.
- Ungraded items become evidence but never review cards.
- Retagging a question refreshes the card's concepts without changing its
  schedule.
- The stage header opens a learning overlay: a due-review session with
  show-answer and four-button rating, plus a weakest-first per-concept mastery
  list. Rating a card advances its schedule and appends the half-weight review
  evidence (`recordReviewRating`); a repeated review id is a no-op. Opening the
  overlay also runs the throttled `maybeCompactLearningHistory` pass.
- Cards carry `sceneId` / `itemId` so the overlay can find the question stem;
  legacy cards without those fields fall back to decoding the card id. A card
  whose scene or question was deleted stays out of the review session and is
  reported as orphaned.
- Choice options carry a per-option `rationale`, and wrong options also carry
  the `misconception` they encode. The quiz review shows both, and the exam
  analytics panel groups the chosen distractors into misconception counts.
- Quiz generation points each tagged item at the preceding teaching outline
  whose key points cover its concepts (`attachQuizRemediation`). The review
  screen and the learning overlay resolve that outline to the live scene and
  offer a "review lesson" jump.

## Next

1. Add a placement / adaptive-routing decision on top of real evidence.
