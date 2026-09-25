---
target: course and lesson views (classroom + stage)
total_score: 29
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
timestamp: 2026-09-10T17-35-46Z
slug: app-classroom-id-page-tsx
---
Synthesized dual-agent critique snapshot (A: ses_f73a22110ffee79, B: ses_f73a201d9ffe09).

Heuristics (0-4): VSS4 / RealWorld3 / Control3 / Consistency2 / ErrorPrev4 / Recognition3 / Flex3 / Aesthetic2 / Recovery3 / Help1 = 29/40 (Good).

Design specificity: authored (roundtable AI-agents, semantic scene thumbnails, phase chips, trophy completion); weak on 9-10px type floor.

Deterministic: 15 findings — ai-color-palette x11 (pbl/v2/chat.tsx:880,1055; milestone-card.tsx:79,152; pbl/v2/sidebar.tsx:332-335; quiz-view.tsx:174,220,956), gradient-text x3 (classroom-complete.tsx:470; pbl/v2/hero.tsx:249; pbl/v2/workspace.tsx:470), layout-transition scene-sidebar.tsx:176. Runtime: ~19 purple elements live. FP: low-alpha violet-50/100, double-counted milestone-card:152.

Strengths: ClassroomSurface.tsx:83-90 error-state splitting; scene-type thumbnails; interruptible/resumable playback + peak-end trophy & quiz banner.

Priority:
P1 i18n bypass + duplication in app/classroom/[id]/page.tsx:271,277,285 (raw {error}) -> delegate to ClassroomSurface variant=page (clarify)
P1 scene list not keyboard operable (scene-sidebar.tsx:273-288 div onClick, no tabIndex/role/focus) (audit)
P1 9-10px type floor scene-sidebar.tsx:222,441,584,613-715 -> 11px min (typeset)
P2 export all-media gate + no success feedback (header-controls.tsx:107-111) (harden)
P2 hidden/unsafe global keyboard shortcuts PlaybackChromeRoot.tsx:1315-1405 (onboard/distill)

Personas: Alex export-blocked + shortcut hijack + dual theme dropdowns; Jordan Pro Mode jargon, roundtable vs chat confusion, unlabeled phase bars; Sam non-focusable scenes, drag-only resize (scene-sidebar.tsx:181-188), invalid border-gray-150 (quiz-view.tsx:529), color-only status, 9px text.

Minor: Chinese debug chips app/page.tsx:1120-1141; quiz cover icons 3% opacity; AI-grading fallback silently halves score (quiz-view.tsx:133-143); Radix AlertDialog focus check.

Browser evidence: /classroom/<id> SSRs 200 shell, client-hydrated; /classroom index 404; overlay injection succeeded.
