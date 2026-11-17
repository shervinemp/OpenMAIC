Title: {{title}}
Description: {{description}}
Key Points: {{keyPoints}}
Lab kind: {{labKind}}
{{#if codeLab}}
Runtime language: {{language}}
{{/if}}

## Language Directive
{{languageDirective}}

{{#if depthDirective}}
{{depthDirective}}
{{/if}}

{{#if unitContext}}
{{unitContext}}
{{/if}}

Design the lab around the key points above. The starter must run and fail at least one check; the reference must satisfy every check.
{{#if codeLab}}
The reference solution must replace the entry file and pass every test.
{{/if}}
{{#if sqlLab}}
The reference SQL must run after the same setup and make every probe return its expected rows.
{{/if}}
{{#if terminalLab}}
The reference commands must run in order in the simulated shell and satisfy every check.
{{/if}}
Output only the JSON object described in the system prompt.
