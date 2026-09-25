import { readFileSync, writeFileSync } from 'node:fs';

const labels = {
  'en-US': 'Resume',
  'fr-FR': 'Reprendre',
  'es-MX': 'Reanudar',
  'pt-BR': 'Retomar',
  'ar-SA': 'استئناف',
  'ru-RU': 'Продолжить',
  'ja-JP': '再開',
  'ko-KR': '재개',
  'zh-CN': '继续生成',
  'zh-TW': '繼續生成',
  'vi-VN': 'Tiếp tục',
};

for (const [locale, label] of Object.entries(labels)) {
  const path = `lib/i18n/locales/${locale}.json`;
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  if (!doc.stage) throw new Error(`${locale}: no stage block`);
  doc.stage.resumeGeneration = label;
  writeFileSync(path, JSON.stringify(doc, null, 2) + '\n');
  console.log(`${locale}: ok`);
}
