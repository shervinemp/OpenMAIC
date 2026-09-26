/**
 * Narration alignment for split slides (deterministic, zero tokens).
 *
 * When the layout train splits one overfull slide into ordered parts, each
 * action has to land on a part. Anchored actions (a spotlight on an element)
 * follow their element; an unanchored narration line has only its words to go
 * by. Without an anchor anywhere on the slide, every line used to fall to part
 * 1 — the whole lecture played over the first part and the rest were silent.
 *
 * This assigns each narration line to the part whose text it overlaps most,
 * weighting a word by how few parts carry it (a word on every part says
 * nothing about which part a line is about). Assignments are monotonic —
 * narration keeps its order and never goes back to an earlier part — and when
 * there are at least as many lines as parts, every part gets at least one,
 * so no part is left silent. Position breaks ties, so a slide whose words do
 * not discriminate still spreads its narration evenly instead of piling it up.
 *
 * Actions that are not narration ride with the narration line they precede
 * (trailing ones stay with the last line), so a sequence plays in its
 * original order across the parts.
 */

export interface AlignableAction {
  readonly type: string;
  readonly text?: string;
}

const STOPWORDS = new Set(
  (
    'the and for are but not you all any can her was one our out day get has him his how man new now old see ' +
    'two way who boy did its let put say she too use that with have this will your from they know want been ' +
    'good much some time very when come here just like long make many more only over such take than them well ' +
    'were what into then there these those which while about after again also because before being both each ' +
    'from further having itself most other same should through under until where would could their theirs ' +
    'let lets we us our so to of in on at by as is it be or an a if do does'
  ).split(/\s+/),
);

/** Word tokens (Unicode letters/digits); CJK runs contribute their bigrams. */
export function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const match of text.toLowerCase().matchAll(/[\p{L}\p{N}_]+/gu)) {
    const word = match[0];
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(word)) {
      for (let i = 0; i + 1 < word.length; i += 1) tokens.add(word.slice(i, i + 2));
      continue;
    }
    if (word.length < 3 || STOPWORDS.has(word)) continue;
    tokens.add(word);
  }
  return tokens;
}

/** Plain text of an HTML fragment (tags dropped, common entities decoded). */
export function plainText(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The part index (0-based) each action plays on, given the parts' texts in
 * order. Actions are returned in their original order; only `speech` lines
 * are scored, the rest follow the next line (or the last one).
 */
export function alignActionsToParts(
  actions: readonly AlignableAction[],
  partTexts: readonly string[],
): number[] {
  const parts = partTexts.length;
  if (parts <= 1) return actions.map(() => 0);
  const lineIndices = actions.flatMap((action, index) =>
    action.type === 'speech' && typeof action.text === 'string' ? [index] : [],
  );
  if (lineIndices.length === 0) return actions.map(() => 0);

  const partTokens = partTexts.map((text) => tokenize(text));
  const documentFrequency = new Map<string, number>();
  for (const tokens of partTokens) {
    for (const token of tokens)
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
  }
  const weight = (token: string) => Math.log(parts / (documentFrequency.get(token) ?? parts));
  const lines = lineIndices.map((index) => tokenize(actions[index]!.text as string));
  const score = (line: number, part: number): number => {
    let total = 0;
    for (const token of lines[line]!) if (partTokens[part]!.has(token)) total += weight(token);
    // Positional prior: tiny next to any real overlap, decisive only on ties.
    const expected = lines.length === 1 ? 0 : (line / (lines.length - 1)) * (parts - 1);
    return total - 0.001 * Math.abs(part - expected);
  };

  const assignment = monotonicAssignment(lines.length, parts, score);
  const partOfAction = new Array<number>(actions.length);
  lineIndices.forEach((actionIndex, line) => {
    partOfAction[actionIndex] = assignment[line]!;
  });
  // Non-narration actions ride with the next narration line; trailing ones
  // with the last.
  let next = assignment[assignment.length - 1]!;
  for (let index = actions.length - 1; index >= 0; index -= 1) {
    if (partOfAction[index] === undefined) partOfAction[index] = next;
    else next = partOfAction[index]!;
  }
  return partOfAction;
}

/**
 * Best non-decreasing assignment of `lines` to `parts`. With at least as many
 * lines as parts it is also onto: line 0 on part 0, the last line on the last
 * part, and no part skipped, so every part speaks.
 */
function monotonicAssignment(
  lines: number,
  parts: number,
  score: (line: number, part: number) => number,
): number[] {
  const onto = lines >= parts;
  const best: number[][] = Array.from({ length: lines }, () => new Array(parts).fill(-Infinity));
  const from: number[][] = Array.from({ length: lines }, () => new Array(parts).fill(-1));
  for (let part = 0; part < parts; part += 1) {
    if (onto && part > 0) break;
    best[0]![part] = score(0, part);
  }
  for (let line = 1; line < lines; line += 1) {
    for (let part = 0; part < parts; part += 1) {
      // Onto: a line may stay on its predecessor's part or move one ahead,
      // and must leave enough lines for the parts still to come.
      if (onto && (part > line || parts - 1 - part > lines - 1 - line)) continue;
      const lowest = onto ? Math.max(0, part - 1) : 0;
      let bestPrevious = -Infinity;
      let bestFrom = -1;
      for (let previous = lowest; previous <= part; previous += 1) {
        if (best[line - 1]![previous]! > bestPrevious) {
          bestPrevious = best[line - 1]![previous]!;
          bestFrom = previous;
        }
      }
      if (bestFrom < 0) continue;
      best[line]![part] = bestPrevious + score(line, part);
      from[line]![part] = bestFrom;
    }
  }
  let part = onto ? parts - 1 : best[lines - 1]!.indexOf(Math.max(...best[lines - 1]!));
  const assignment = new Array<number>(lines);
  for (let line = lines - 1; line >= 0; line -= 1) {
    assignment[line] = part;
    part = from[line]![part]!;
  }
  return assignment;
}
