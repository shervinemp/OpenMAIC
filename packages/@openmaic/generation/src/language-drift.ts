/**
 * Conservative, deterministic language-drift detection for generated scenes.
 *
 * The course generator receives a free-form `languageDirective` ("Teach in
 * Chinese (Simplified); keep technical terms in English."). A prompt
 * instruction is not a guarantee: models sometimes answer in English anyway.
 * This module decides, without another model call, whether the learner-visible
 * text of a finished scene is in the target language.
 *
 * Scope and false-positive policy:
 * - The gate works at SCRIPT level (Han, Kana, Hangul, Cyrillic, Arabic, Latin,
 *   ...). It deliberately does not try to distinguish English from Spanish:
 *   technical prose mixes Latin-script languages, and a wrong accusation costs
 *   a full regeneration.
 * - A scene is flagged only when the target script is nearly absent and one
 *   other script dominates. Bilingual technical content (Chinese prose with
 *   English identifiers, for example) passes.
 * - Very short scenes (< 40 letters) are never flagged.
 * - Code, SQL, HTML/CSS, file contents and answer keys are excluded from the
 *   text sample so they cannot skew the count.
 */

export type TextScript =
  | 'latin'
  | 'han'
  | 'kana'
  | 'hangul'
  | 'cyrillic'
  | 'arabic'
  | 'devanagari'
  | 'thai'
  | 'hebrew'
  | 'greek';

export interface LanguageProfile {
  code: string;
  label: string;
  scripts: readonly TextScript[];
  patterns: readonly RegExp[];
}

export interface LanguageDriftFinding {
  /** Target language inferred from the directive. */
  targetLabel: string;
  /** Script that dominates the generated text. */
  detectedLabel: string;
  /** Share of letters in the target script(s), 0-1. */
  targetShare: number;
  /** Share of letters in the dominant script, 0-1. */
  detectedShare: number;
  /** One-line explanation for the job log. */
  finding: string;
  /** Corrective instruction appended to the directive for the rewrite. */
  correction: string;
}

const SCRIPT_LABELS: Record<TextScript, string> = {
  latin: 'Latin',
  han: 'Han (Chinese/Japanese)',
  kana: 'Japanese kana',
  hangul: 'Hangul',
  cyrillic: 'Cyrillic',
  arabic: 'Arabic',
  devanagari: 'Devanagari',
  thai: 'Thai',
  hebrew: 'Hebrew',
  greek: 'Greek',
};

const SCRIPT_PATTERNS: Record<TextScript, RegExp> = {
  latin: /\p{Script=Latin}/gu,
  han: /\p{Script=Han}/gu,
  kana: /[\p{Script=Hiragana}\p{Script=Katakana}]/gu,
  hangul: /\p{Script=Hangul}/gu,
  cyrillic: /\p{Script=Cyrillic}/gu,
  arabic: /\p{Script=Arabic}/gu,
  devanagari: /\p{Script=Devanagari}/gu,
  thai: /\p{Script=Thai}/gu,
  hebrew: /\p{Script=Hebrew}/gu,
  greek: /\p{Script=Greek}/gu,
};

/**
 * Language names and locale codes. Order matters only for equal match
 * positions; the primary-language heuristic resolves the common multi-language
 * directives.
 */
const PROFILES: readonly LanguageProfile[] = [
  {
    code: 'zh',
    label: 'Chinese',
    scripts: ['han'],
    patterns: [
      /\bchinese\b/i,
      /\bmandarin\b/i,
      /\bcantonese\b/i,
      /中文|汉语|漢語|普通话|普通話|國語/,
      /\bzh[-_](cn|tw|hans|hant)\b/i,
    ],
  },
  {
    code: 'ja',
    label: 'Japanese',
    scripts: ['han', 'kana'],
    patterns: [/\bjapanese\b/i, /日本語|にほんご/, /\bja[-_]jp\b/i],
  },
  {
    code: 'ko',
    label: 'Korean',
    scripts: ['hangul'],
    patterns: [/\bkorean\b/i, /한국어|조선말/, /\bko[-_]kr\b/i],
  },
  {
    code: 'ru',
    label: 'Russian',
    scripts: ['cyrillic'],
    patterns: [/\brussian\b/i, /русск/i, /\bru[-_]ru\b/i],
  },
  {
    code: 'ar',
    label: 'Arabic',
    scripts: ['arabic'],
    patterns: [/\barabic\b/i, /العربية|عربي/, /\bar[-_]sa\b/i],
  },
  {
    code: 'hi',
    label: 'Hindi',
    scripts: ['devanagari'],
    patterns: [/\bhindi\b/i, /हिन्दी|हिंदी/, /\bhi[-_]in\b/i],
  },
  {
    code: 'th',
    label: 'Thai',
    scripts: ['thai'],
    patterns: [/\bthai\b/i, /ไทย/, /\bth[-_]th\b/i],
  },
  {
    code: 'he',
    label: 'Hebrew',
    scripts: ['hebrew'],
    patterns: [/\bhebrew\b/i, /עברית/, /\bhe[-_]il\b/i],
  },
  {
    code: 'el',
    label: 'Greek',
    scripts: ['greek'],
    patterns: [/\bgreek\b/i, /ελλην/i, /\bel[-_]gr\b/i],
  },
  {
    code: 'vi',
    label: 'Vietnamese',
    scripts: ['latin'],
    patterns: [/\bvietnamese\b/i, /tiếng việt|tieng viet/i, /\bvi[-_]vn\b/i],
  },
  {
    code: 'es',
    label: 'Spanish',
    scripts: ['latin'],
    patterns: [/\bspanish\b/i, /español|espanol/i, /\bes[-_][a-z]{2}\b/i],
  },
  {
    code: 'fr',
    label: 'French',
    scripts: ['latin'],
    patterns: [/\bfrench\b/i, /français|francais/i, /\bfr[-_][a-z]{2}\b/i],
  },
  {
    code: 'de',
    label: 'German',
    scripts: ['latin'],
    patterns: [/\bgerman\b/i, /\bdeutsch\b/i, /\bde[-_][a-z]{2}\b/i],
  },
  {
    code: 'pt',
    label: 'Portuguese',
    scripts: ['latin'],
    patterns: [/\bportuguese\b/i, /português|portugues/i, /\bpt[-_][a-z]{2}\b/i],
  },
  {
    code: 'it',
    label: 'Italian',
    scripts: ['latin'],
    patterns: [/\bitalian\b/i, /\bitaliano\b/i, /\bit[-_][a-z]{2}\b/i],
  },
  {
    code: 'nl',
    label: 'Dutch',
    scripts: ['latin'],
    patterns: [/\bdutch\b/i, /\bnederlands\b/i, /\bnl[-_][a-z]{2}\b/i],
  },
  {
    code: 'tr',
    label: 'Turkish',
    scripts: ['latin'],
    patterns: [/\bturkish\b/i, /türkçe|turkce/i, /\btr[-_][a-z]{2}\b/i],
  },
  {
    code: 'pl',
    label: 'Polish',
    scripts: ['latin'],
    patterns: [/\bpolish\b/i, /\bpolski\b/i, /\bpl[-_][a-z]{2}\b/i],
  },
  {
    code: 'en',
    label: 'English',
    scripts: ['latin'],
    patterns: [/\benglish\b/i, /\ben[-_][a-z]{2}\b/i],
  },
];

const TEACHING_VERB_RE =
  /\b(teach|taught|instruct|write|respond|answer|explain|deliver|course language|language of instruction)\b/i;

/**
 * High-frequency function words for the Latin-script languages the app ships.
 * They are used only as a SECOND check when the script gate cannot decide
 * (both languages share Latin letters). A language is flagged only when a
 * competitor has a strong function-word signature and the target has almost
 * none, so bilingual technical prose and quoted foreign terms stay safe.
 */
const LATIN_STOPWORDS: Partial<Record<string, readonly string[]>> = {
  en: [
    'the',
    'and',
    'of',
    'to',
    'in',
    'is',
    'are',
    'was',
    'were',
    'that',
    'for',
    'with',
    'as',
    'on',
    'by',
    'this',
    'be',
    'from',
    'it',
    'an',
    'at',
    'or',
    'which',
    'can',
    'has',
    'have',
    'not',
    'but',
    'they',
    'their',
    'you',
    'your',
    'we',
    'our',
    'these',
    'those',
    'when',
    'into',
    'than',
    'then',
    'so',
    'if',
    'will',
    'would',
    'should',
    'about',
    'more',
    'most',
    'also',
    'only',
  ],
  es: [
    'el',
    'la',
    'los',
    'las',
    'un',
    'una',
    'unos',
    'unas',
    'de',
    'del',
    'al',
    'a',
    'en',
    'es',
    'son',
    'que',
    'y',
    'o',
    'para',
    'por',
    'con',
    'sin',
    'se',
    'su',
    'sus',
    'como',
    'mas',
    'más',
    'pero',
    'este',
    'esta',
    'estos',
    'estas',
    'ese',
    'esa',
    'no',
    'si',
    'sí',
    'cuando',
    'donde',
    'porque',
    'entre',
    'sobre',
    'tambien',
    'también',
    'muy',
  ],
  fr: [
    'le',
    'la',
    'les',
    'un',
    'une',
    'des',
    'du',
    'de',
    'dans',
    'en',
    'est',
    'sont',
    'que',
    'qui',
    'et',
    'ou',
    'où',
    'pour',
    'par',
    'avec',
    'sans',
    'se',
    'son',
    'sa',
    'ses',
    'ce',
    'cette',
    'ces',
    'comme',
    'mais',
    'plus',
    'ne',
    'pas',
    'au',
    'aux',
    'il',
    'elle',
    'ils',
    'elles',
    'on',
    'nous',
    'vous',
  ],
  de: [
    'der',
    'die',
    'das',
    'den',
    'dem',
    'des',
    'ein',
    'eine',
    'einen',
    'einem',
    'einer',
    'und',
    'oder',
    'ist',
    'sind',
    'war',
    'waren',
    'mit',
    'für',
    'von',
    'zu',
    'zum',
    'zur',
    'in',
    'im',
    'am',
    'auf',
    'aus',
    'bei',
    'nach',
    'über',
    'nicht',
    'kein',
    'keine',
    'als',
    'auch',
    'aber',
    'wenn',
    'weil',
    'dass',
    'diese',
    'dieser',
    'dieses',
    'sich',
  ],
  pt: [
    'o',
    'a',
    'os',
    'as',
    'um',
    'uma',
    'uns',
    'umas',
    'de',
    'do',
    'da',
    'dos',
    'das',
    'em',
    'no',
    'na',
    'nos',
    'nas',
    'é',
    'e',
    'são',
    'que',
    'ou',
    'para',
    'por',
    'com',
    'sem',
    'se',
    'seu',
    'sua',
    'seus',
    'suas',
    'como',
    'mais',
    'mas',
    'este',
    'esta',
    'estes',
    'estas',
    'esse',
    'essa',
    'isso',
    'não',
    'sim',
    'quando',
    'onde',
    'porque',
    'entre',
    'sobre',
    'também',
  ],
  it: [
    'il',
    'lo',
    'la',
    'i',
    'gli',
    'le',
    'un',
    'uno',
    'una',
    'di',
    'del',
    'della',
    'dello',
    'dei',
    'degli',
    'delle',
    'da',
    'dal',
    'dalla',
    'in',
    'nel',
    'nella',
    'è',
    'e',
    'sì',
    'no',
    'che',
    'chi',
    'cui',
    'per',
    'con',
    'senza',
    'tra',
    'fra',
    'come',
    'ma',
    'più',
    'non',
    'questo',
    'questa',
    'questi',
    'queste',
    'quello',
    'quella',
    'sono',
    'essere',
  ],
  vi: [
    'và',
    'là',
    'của',
    'có',
    'trong',
    'một',
    'những',
    'cho',
    'với',
    'không',
    'được',
    'này',
    'đó',
    'thì',
    'nhưng',
    'hoặc',
    'khi',
    'ở',
    'từ',
    'đến',
    'để',
    'người',
    'các',
    'về',
  ],
  nl: [
    'de',
    'het',
    'een',
    'en',
    'van',
    'in',
    'is',
    'zijn',
    'dat',
    'op',
    'te',
    'voor',
    'met',
    'niet',
    'aan',
    'ook',
    'als',
    'maar',
    'of',
    'door',
    'uit',
    'bij',
    'naar',
    'over',
    'dan',
    'die',
    'deze',
    'dit',
  ],
  tr: [
    've',
    'bir',
    'bu',
    'şu',
    'o',
    'da',
    'de',
    'ki',
    'için',
    'ile',
    'olarak',
    'gibi',
    'daha',
    'çok',
    'var',
    'yok',
    'değil',
    'ama',
    'veya',
    'ne',
    'en',
    'kadar',
    'sonra',
    'önce',
  ],
  pl: [
    'i',
    'w',
    'z',
    'na',
    'do',
    'nie',
    'że',
    'się',
    'jest',
    'są',
    'to',
    'ten',
    'ta',
    'te',
    'dla',
    'jak',
    'po',
    'od',
    'przez',
    'przy',
    'ale',
    'lub',
    'czy',
    'już',
    'tylko',
    'bardzo',
  ],
};

interface Mention {
  profile: LanguageProfile;
  index: number;
}

function findMentions(directive: string): Mention[] {
  const mentions: Mention[] = [];
  for (const profile of PROFILES) {
    let best = Number.POSITIVE_INFINITY;
    for (const pattern of profile.patterns) {
      const match = pattern.exec(directive);
      if (match?.index !== undefined && match.index < best) best = match.index;
    }
    if (Number.isFinite(best)) mentions.push({ profile, index: best });
  }
  return mentions.sort((a, b) => a.index - b.index);
}

/** Infer the PRIMARY teaching language, or null when the directive is silent. */
export function inferTargetLanguage(directive: string): LanguageProfile | null {
  const mentions = findMentions(directive);
  if (mentions.length === 0) return null;
  if (mentions.length === 1) return mentions[0]!.profile;

  // A language named in the same clause as a teaching verb wins over an
  // incidental mention ("use English for code identifiers"). Only the text
  // BEFORE the language name counts: a following clause often names a
  // secondary language.
  const preferred = mentions.find((mention) => {
    const start = Math.max(0, mention.index - 80);
    return TEACHING_VERB_RE.test(directive.slice(start, mention.index));
  });
  return (preferred ?? mentions[0]!).profile;
}

const LATIN_STOPWORD_SETS = new Map(
  Object.entries(LATIN_STOPWORDS).map(([code, words]) => [code, new Set(words)] as const),
);

function countScripts(text: string): { counts: Record<TextScript, number>; total: number } {
  const counts = {} as Record<TextScript, number>;
  let total = 0;
  for (const [script, pattern] of Object.entries(SCRIPT_PATTERNS) as Array<[TextScript, RegExp]>) {
    const count = text.match(pattern)?.length ?? 0;
    counts[script] = count;
    total += count;
  }
  return { counts, total };
}

/**
 * Decide whether a finished scene drifted out of its target language.
 *
 * Two deterministic passes:
 * 1. Script level — catches Chinese/English, Cyrillic/Latin, Arabic/Latin etc.
 * 2. Function-word level — only for Latin-script targets, and only when a
 *    competitor has a strong signature and the target has almost none.
 *
 * Returns null when the directive is silent, the sample is too short, or the
 * content is a plausible bilingual mix.
 */
export function detectLanguageDrift(
  text: string,
  directive: string | undefined,
): LanguageDriftFinding | null {
  if (!text || !directive?.trim()) return null;
  const target = inferTargetLanguage(directive);
  if (!target) return null;

  const { counts, total } = countScripts(text);
  if (total < 40) return null;

  let dominant: TextScript = 'latin';
  for (const script of Object.keys(counts) as TextScript[]) {
    if (counts[script] > counts[dominant]) dominant = script;
  }
  const targetCount = target.scripts.reduce((sum, script) => sum + counts[script], 0);
  const targetShare = targetCount / total;
  const detectedShare = counts[dominant] / total;
  const targetIsLatin = target.scripts.includes('latin');

  if (targetIsLatin) {
    if (detectedShare > 0.5 && targetShare < 0.25) {
      return buildFinding(target, dominant, targetShare, detectedShare);
    }
    return detectLatinDrift(text, target);
  }

  if (detectedShare > 0.5 && targetShare < 0.15 && !target.scripts.includes(dominant)) {
    return buildFinding(target, dominant, targetShare, detectedShare);
  }
  return null;
}

interface LatinScore {
  profile: LanguageProfile;
  score: number;
}

/**
 * Compare function-word densities. This is deliberately one-sided: it only
 * fires when a competitor is clearly present and the target is nearly absent.
 * Spanish/Portuguese and English/French share enough function words that a
 * weak signal is not worth a regeneration.
 */
function detectLatinDrift(text: string, target: LanguageProfile): LanguageDriftFinding | null {
  if (!LATIN_STOPWORD_SETS.has(target.code)) return null;
  const tokens = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  if (tokens.length < 50) return null;

  const scores: LatinScore[] = [];
  for (const profile of PROFILES) {
    const words = LATIN_STOPWORD_SETS.get(profile.code);
    if (!words || !profile.scripts.includes('latin')) continue;
    let hits = 0;
    for (const token of tokens) if (words.has(token)) hits += 1;
    scores.push({ profile, score: hits / tokens.length });
  }

  const targetScore = scores.find((entry) => entry.profile.code === target.code)?.score ?? 0;
  const competitor = scores
    .filter((entry) => entry.profile.code !== target.code)
    .sort((a, b) => b.score - a.score)[0];
  // Require a strong competitor signature AND an almost total absence of the
  // target's own function words. A quotation or a bilingual aside leaves some
  // target signal and is not worth a rewrite.
  if (!competitor || competitor.score < 0.12) return null;
  if (targetScore >= competitor.score * 0.35 || competitor.score - targetScore < 0.12) {
    return null;
  }
  return buildLanguageFinding(target, competitor.profile, targetScore, competitor.score);
}

function buildFinding(
  target: LanguageProfile,
  dominant: TextScript,
  targetShare: number,
  detectedShare: number,
): LanguageDriftFinding {
  const targetPct = Math.round(targetShare * 100);
  const detectedPct = Math.round(detectedShare * 100);
  const detectedLabel = SCRIPT_LABELS[dominant];
  return {
    targetLabel: target.label,
    detectedLabel,
    targetShare,
    detectedShare,
    finding: `only ${targetPct}% of the learner-visible letters are in the target language (${target.label}), while ${detectedPct}% are ${detectedLabel}`,
    correction: `LANGUAGE COMPLIANCE (NON-NEGOTIABLE): The previous attempt drifted out of the course language. Its learner-visible text is ${detectedPct}% ${detectedLabel} and only ${targetPct}% ${target.label}. Rewrite every learner-visible heading, sentence, explanation, question and option in ${target.label}. Keep code, identifiers, formulas and direct source quotations unchanged where they must stay in another language.`,
  };
}

function buildLanguageFinding(
  target: LanguageProfile,
  detected: LanguageProfile,
  targetScore: number,
  detectedScore: number,
): LanguageDriftFinding {
  const targetPct = Math.round(targetScore * 100);
  const detectedPct = Math.round(detectedScore * 100);
  return {
    targetLabel: target.label,
    detectedLabel: detected.label,
    targetShare: targetScore,
    detectedShare: detectedScore,
    finding: `only ${targetPct}% of words are ${target.label} function words, while ${detectedPct}% match ${detected.label}`,
    correction: `LANGUAGE COMPLIANCE (NON-NEGOTIABLE): The previous attempt drifted out of the course language. Its learner-visible text uses ${detected.label} function words (${detectedPct}% of words) and almost no ${target.label} ones (${targetPct}%). Rewrite every learner-visible heading, sentence, explanation, question and option in ${target.label}. Keep code, identifiers, formulas and direct source quotations unchanged where they must stay in another language.`,
  };
}

/**
 * Keys that hold code, markup, identifiers, styling or answer keys rather than
 * learner-visible prose. A language gate that counted these would flag a
 * perfectly good Chinese lesson for its Python identifiers.
 */
const SKIP_KEYS = new Set([
  'id',
  'type',
  'kind',
  'language',
  'entryFile',
  'storageId',
  'assetId',
  'elementId',
  'widgetId',
  'selector',
  'src',
  'url',
  'href',
  'path',
  'code',
  'css',
  'js',
  'javascript',
  'setupSql',
  'starterSql',
  'referenceSql',
  'referenceCommands',
  'files',
  'referenceFiles',
  'tests',
  'checks',
  'answer',
  'answers',
  'value',
  'mode',
  'mimeType',
  'providerId',
  'defaultFontName',
  'defaultColor',
  'fontName',
  'fontFamily',
  'fill',
  'stroke',
  'color',
  'backgroundColor',
  'theme',
  'themeColors',
  'outline',
  'shadow',
  'left',
  'top',
  'width',
  'height',
  'rotate',
  'lineHeight',
  'opacity',
  'viewportSize',
  'viewportRatio',
  'latex',
  'formula',
  'expression',
]);

/** Flatten learner-visible prose from any generated content shape. */
/** Strip executable/non-visible HTML blocks before sampling learner prose. */
function htmlVisibleText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
}

export function collectLearnerText(value: unknown, maxChars = 200_000): string {
  const parts: string[] = [];
  let size = 0;

  const visit = (node: unknown): void => {
    if (size >= maxChars) return;
    if (typeof node === 'string') {
      // Slide text elements carry HTML fragments; tags are not prose and would
      // add Latin letters to a Chinese lesson.
      const clean = node
        .replace(/<[^>]*>/g, ' ')
        .replace(/&[a-z][a-z0-9]+;/gi, ' ')
        .trim();
      if (clean) {
        parts.push(clean);
        size += clean.length;
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) {
        if (SKIP_KEYS.has(key)) continue;
        // Widget HTML holds the learner-visible labels and node text. Script
        // and style blocks are not prose and would skew the script counts.
        if (key === 'html' && typeof child === 'string') {
          visit(htmlVisibleText(child));
        } else {
          visit(child);
        }
      }
    }
  };

  visit(value);
  return parts.join('\n');
}
