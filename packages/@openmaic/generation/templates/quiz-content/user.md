Title: {{title}}
Description: {{description}}
Test Points: {{keyPoints}}
Question Count: {{questionCount}}, Difficulty: {{difficulty}}, Question Types: {{questionTypes}}

## Language Directive
{{languageDirective}}

{{#if depthDirective}}
{{depthDirective}}
{{/if}}

{{#if unitContext}}
{{unitContext}}
{{/if}}

Output a JSON array directly (no explanation, no code blocks, no LaTeX). Each choice option MUST be `{ "label": "<content text>", "value": "<one ASCII uppercase letter A-Z>" }`. `value` is an enum A-Z and is never the option content; `label` is the content text and is never just the letter. Never reverse them (invalid: `{ "value": "(6, 2)", "label": "A" }`). `answer` MUST be an array of those `value` letters, never the content text. A numeric question has no options; its `answer` is `["<number>"]` with an optional non-negative `tolerance` and display `unit`. An ordering question lists its items in the correct order in `options` (at least two distinct items) and has NO `answer` key. A matching question has one left item in `options` and its partner at the same index in `matches` (equal length, at least two pairs, distinct right-hand labels) and NO `answer` key:
[{"id":"q1","type":"single","question":"Question text","options":[{"label":"Option A content","value":"A"},{"label":"Option B content","value":"B"},{"label":"Option C content","value":"C"},{"label":"Option D content","value":"D"}],"answer":["A"]},{"id":"q2","type":"numeric","question":"Question text asking for one quantity","answer":["0.392"],"tolerance":0.001,"unit":"m","analysis":"How the value is obtained.","points":10},{"id":"q3","type":"ordering","question":"Put these steps in the correct order","options":[{"label":"First step content","value":"A"},{"label":"Second step content","value":"B"},{"label":"Third step content","value":"C"}],"analysis":"Why this sequence is correct.","points":10},{"id":"q4","type":"matching","question":"Match each term with its definition","options":[{"label":"Term A","value":"A"},{"label":"Term B","value":"B"}],"matches":[{"label":"Definition of term A","value":"A"},{"label":"Definition of term B","value":"B"}],"analysis":"Why each pairing is correct.","points":10}]
