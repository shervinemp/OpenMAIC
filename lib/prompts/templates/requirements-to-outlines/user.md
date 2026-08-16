Please generate scene outlines based on the following course requirements.

---

## User Requirements

{{requirement}}

---

{{userProfile}}

## Language Context

Infer the course language directive by applying the decision rules from the system prompt. Key reminders:
- Requirement language = teaching language (unless overridden by explicit request or learner context)
- Foreign language learning → teach in user's native language, not the target language
- PDF language does NOT override teaching language — translate/explain document content instead

---

## Reference Materials

### PDF Content Summary

{{pdfContent}}

### Available Images

{{availableImages}}

### Web Search Results

{{researchContext}}

{{teacherContext}}

---

## Output Requirements

Please automatically infer the following from user requirements:

- Course topic and core content
- Target audience and difficulty level
- Course duration (resolved below — do NOT invent your own)
- Teaching style (formal/casual/interactive/academic)
- Visual style (minimal/colorful/professional/playful)

---

## Course Contract (NON-NEGOTIABLE)

The course duration has been resolved to **{{resolvedDurationMinutes}} minutes**. The
scene count and lesson split below are computed from it — they are not
suggestions and you may not produce fewer scenes, more scenes, or a different
lesson structure.

{{courseContract}}

Then output your response as a single JSON object.

**Top-level shape — this is what you MUST return:**

```json
{
  "languageDirective": "2-5 sentence instruction describing the course language behavior",
  "courseTitle": "concise course name, ≤30 chars, in the teaching language",
  "lessons": [ /* array of lesson objects: {"title": "...", "objectives": ["..."]} */ ],
  "audience": "inferred audience",
  "objectives": ["course-level objective 1", "course-level objective 2"],
  "outlines": [ /* array of scene objects, schema described below */ ]
}
```

Never return a bare array. Never omit `languageDirective`, `courseTitle`, or `outlines` — those three keys are required. `lessons`, `audience`, and `objectives` are strongly recommended (they fill the course contract).

**Each scene inside the `outlines` array has this minimum shape:**

```json
{
  "id": "scene_1",
  "type": "slide" | "quiz" | "interactive" | "pbl" | "exercise" | "derivation" | "glossary" | "reading",
  "title": "Scene Title",
  "description": "Teaching purpose description",
  "keyPoints": ["Point 1", "Point 2", "Point 3"],
  "order": 1
}
```

### Special Notes

- **quiz scenes must include quizConfig**:
   ```json
   "quizConfig": {
     "questionCount": 2,
     "difficulty": "easy" | "medium" | "hard",
     "questionTypes": ["single", "multiple"]
   }
   ```
{{#if hasSourceImages}}
- **If source images are available**, add `suggestedImageIds` to relevant slide scenes. Only use image IDs listed under Available Images.
{{/if}}
- **Interactive scenes**: If a concept benefits from hands-on simulation/visualization, use `"type": "interactive"` with `widgetType` and `widgetOutline` fields. Limit to 1-2 per course.
   - Select widgetType based on concept: simulation (physics/chem), diagram (processes), code (programming), game (practice), visualization3d (3D models)
   - Provide appropriate widgetOutline for the widget type
- **Specialized scenes** (only when the Course Contract's depth level calls for them):
   - `exercise` — one or two fully-worked problems (concrete numbers, worked solution, analysis) for computational/quantitative lessons.
   - `derivation` — step-by-step proof/derivation with LaTeX formulas, for formula-heavy lessons.
   - `glossary` — one per unit: the unit's key terms with complete definitions.
   - `reading` — one per unit: an annotated further-reading list (title + why-read).
- **Scene count**: Governed entirely by the Course Contract above — produce EXACTLY the per-lesson counts it demands. It overrides any other count guidance in this prompt.
- **Quiz placement**: Insert quizzes per the Course Contract cadence (course-wide positions). Quiz scenes count toward the lesson totals.
- **Language**: Infer from the user's requirement text and context, then output all content in the inferred language
- **If web search results are provided**, reference specific findings and sources in scene descriptions and keyPoints. The search results provide up-to-date information — incorporate it to make the course content current and accurate.

**Final reminder**: your entire response must be a JSON **object** with at least the three top-level keys — `languageDirective` (string), `courseTitle` (string, ≤30 chars, in the teaching language), and `outlines` (array) — plus `lessons`, `audience`, and `objectives` where possible. Do not return a bare array. Do not wrap in prose or code fences. The Course Contract governs the number of scenes: produce exactly what it demands.
