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

{"chartTitle":"Title","chartType":"line","xAxisLabel":"X (unit)","yAxisLabel":"Y (unit)","unitNote":"Optional note.","series":[{"name":"Series A","points":[{"x":1,"y":10.5},{"x":2,"y":12.0}]}],"claims":[{"id":"claim-1","statement":"The claim to evaluate.","verdict":"supported","explanation":"Why, citing the concrete values."}]}
