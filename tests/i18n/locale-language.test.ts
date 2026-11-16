import { describe, expect, it } from 'vitest';

import { languageNameForLocale } from '@/lib/i18n/locale-language';
import { supportedLocales } from '@/lib/i18n';

describe('languageNameForLocale', () => {
  it('names the language of every supported UI locale', () => {
    const names = supportedLocales.map((locale) => languageNameForLocale(locale.code));

    expect(names.every((name) => typeof name === 'string' && name.trim().length > 0)).toBe(true);
    // Distinct locales should not share a language name: the index cache keys
    // on this string, so collapsing them would reuse the wrong digest.
    expect(new Set(names).size).toBe(supportedLocales.length);
  });

  it('returns undefined for an unknown code so the route keeps its default', () => {
    expect(languageNameForLocale('xx-YY')).toBeUndefined();
    expect(languageNameForLocale('')).toBeUndefined();
  });
});
