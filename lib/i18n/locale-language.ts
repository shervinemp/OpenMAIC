import type { Locale } from './types';

/**
 * English language name for each supported UI locale.
 *
 * Document indexing needs a language NAME, not a locale code: the digest and
 * caption prompts say "Respond in ${language}". Passing `pt-BR` there is
 * ambiguous, and the route's old default silently produced English digests and
 * captions for every non-English UI.
 *
 * Typed as a complete `Record<Locale, string>`, so adding a locale to
 * `supportedLocales` without naming its language fails the typecheck.
 */
const LOCALE_LANGUAGE_NAMES: Record<Locale, string> = {
  'zh-CN': 'Simplified Chinese',
  'zh-TW': 'Traditional Chinese',
  'en-US': 'English',
  'ja-JP': 'Japanese',
  'ru-RU': 'Russian',
  'ar-SA': 'Arabic',
  'pt-BR': 'Brazilian Portuguese',
  'ko-KR': 'Korean',
  'es-MX': 'Mexican Spanish',
  'fr-FR': 'French',
  'vi-VN': 'Vietnamese',
  'de-DE': 'German',
};

/** The English language name for a supported locale, or undefined for an unknown code. */
export function languageNameForLocale(locale: string): string | undefined {
  return LOCALE_LANGUAGE_NAMES[locale as Locale];
}
