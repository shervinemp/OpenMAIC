import { readFileSync, writeFileSync } from 'node:fs';

const labels = {
  'en-US': { sceneType: 'Free Response', trail: 'free responses' },
  'fr-FR': { sceneType: 'Rédaction libre', trail: 'rédactions libres' },
  'es-MX': { sceneType: 'Respuesta libre', trail: 'respuestas libres' },
  'pt-BR': { sceneType: 'Resposta livre', trail: 'respostas livres' },
  'ar-SA': { sceneType: 'إجابة حرة', trail: 'إجابات حرة' },
  'ru-RU': { sceneType: 'Свободный ответ', trail: 'свободные ответы' },
  'ja-JP': { sceneType: '自由記述', trail: '自由記述' },
  'ko-KR': { sceneType: '서술형 답변', trail: '서술형 답변' },
  'zh-CN': { sceneType: '自由写作', trail: '自由写作' },
  'zh-TW': { sceneType: '自由寫作', trail: '自由寫作' },
  'vi-VN': { sceneType: 'Tự luận', trail: 'bài tự luận' },
};

for (const [locale, map] of Object.entries(labels)) {
  const path = `lib/i18n/locales/${locale}.json`;
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  if (!doc.generation || !doc.classroomComplete?.trailLabels) throw new Error(`${locale}: missing blocks`);

  const generation = {};
  for (const [key, value] of Object.entries(doc.generation)) {
    generation[key] = value;
    if (key === 'sceneTypeTradeoffs') {
      generation.sceneTypeFreeResponse = map.sceneType;
    }
  }
  if (!generation.sceneTypeFreeResponse) throw new Error(`${locale}: anchor missing`);
  doc.generation = generation;

  const trailLabels = {};
  for (const [key, value] of Object.entries(doc.classroomComplete.trailLabels)) {
    trailLabels[key] = value;
    if (key === 'tradeoffs') {
      trailLabels.freeResponse = map.trail;
    }
  }
  doc.classroomComplete.trailLabels = trailLabels;

  writeFileSync(path, JSON.stringify(doc, null, 2) + '\n');
  console.log(`${locale}: ok`);
}
