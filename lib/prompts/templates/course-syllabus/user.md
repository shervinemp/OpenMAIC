Please design the course syllabus (unit and lesson structure) based on the following course requirements.

---

## User Requirements

{{requirement}}

---

{{userProfile}}

## Reference Materials

### PDF Content Summary

{{pdfContent}}

### Web Search Results

{{researchContext}}

{{teacherContext}}

---

## Syllabus Contract (NON-NEGOTIABLE)

The course duration has been resolved to **{{resolvedDurationMinutes}} minutes**. The unit and lesson split below is computed from it — it is not a suggestion and you may not produce a different structure.

{{courseContract}}

Then output your response as a single JSON object.

**Top-level shape — this is what you MUST return:**

```json
{
  "languageDirective": "2-5 sentence instruction describing the course language behavior",
  "courseTitle": "concise course name, ≤30 chars, in the teaching language",
  "units": [
    {
      "title": "Unit title (teaching language)",
      "objectives": ["unit-level objective 1", "unit-level objective 2"],
      "lessons": [
        { "title": "Lesson title", "objectives": ["learning objective"] }
      ]
    }
  ],
  "audience": "inferred audience",
  "objectives": ["course-level objective 1", "course-level objective 2"]
}
```

- `units` must contain EXACTLY the contracted number of units, each with EXACTLY the contracted number of lessons, in order.
- Every unit and lesson needs a non-empty `title` and 1-2 `objectives`.
- Do NOT include scene outlines — only the structure above.
