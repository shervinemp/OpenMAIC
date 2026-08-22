Title: {{title}}
Description: {{description}}
Key Points:
{{keyPoints}}

## Language Directive
{{languageDirective}}

{{#if depthDirective}}
{{depthDirective}}
{{/if}}

{{#if unitContext}}
{{unitContext}}
{{/if}}

Output JSON directly (no explanation, no code blocks):

{"context":"Decision situation in complete sentences.","constraints":["Hard limit 1","Hard limit 2"],"options":[{"id":"opt-1","name":"Option name","pros":["Real advantage"],"cons":["Real cost"],"bestFor":"When this is the right call"}],"recommendation":{"choice":"Option name","justification":"Why it wins under the stated constraints."}}
