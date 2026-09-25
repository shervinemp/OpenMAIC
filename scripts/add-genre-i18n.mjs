import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const labels = {
  'en-US': {
    sceneType: ['Comparison', 'Data Reading', 'Trade-offs'],
    trail: ['comparisons', 'data readings', 'trade-offs'],
  },
  'fr-FR': {
    sceneType: ['Comparaison', 'Lecture de données', 'Arbitrages'],
    trail: ['comparaisons', 'lectures de données', 'arbitrages'],
  },
  'es-MX': {
    sceneType: ['Comparación', 'Lectura de datos', 'Decisiones'],
    trail: ['comparaciones', 'lecturas de datos', 'decisiones'],
  },
  'pt-BR': {
    sceneType: ['Comparação', 'Leitura de dados', 'Trade-offs'],
    trail: ['comparações', 'leituras de dados', 'trade-offs'],
  },
  'ar-SA': {
    sceneType: ['مقارنة', 'قراءة البيانات', 'المفاضلات'],
    trail: ['مقارنات', 'قراءات بيانات', 'مفاضلات'],
  },
  'ru-RU': {
    sceneType: ['Сравнение', 'Чтение данных', 'Компромиссы'],
    trail: ['сравнения', 'чтения данных', 'компромиссы'],
  },
  'ja-JP': {
    sceneType: ['比較', 'データの読み取り', 'トレードオフ'],
    trail: ['比較', 'データ読み取り', 'トレードオフ'],
  },
  'ko-KR': {
    sceneType: ['비교', '데이터 읽기', '트레이드오프'],
    trail: ['비교', '데이터 읽기', '트레이드오프'],
  },
  'zh-CN': {
    sceneType: ['对比', '数据解读', '权衡分析'],
    trail: ['对比', '数据解读', '权衡分析'],
  },
  'zh-TW': {
    sceneType: ['對比', '數據解讀', '權衡分析'],
    trail: ['對比', '數據解讀', '權衡分析'],
  },
};

const dir = 'lib/i18n/locales';
for (const [locale, map] of Object.entries(labels)) {
  const path = join(dir, `${locale}.json`);
  const raw = readFileSync(path, 'utf8');
  const doc = JSON.parse(raw);
  if (!doc.generation || typeof doc.generation !== 'object') throw new Error(`${locale}: no generation block`);
  if (!doc.classroomComplete?.trailLabels) throw new Error(`${locale}: no trailLabels block`);

  // Insert after sceneTypeReading to keep the specialized kinds grouped.
  const generation = {};
  for (const [key, value] of Object.entries(doc.generation)) {
    generation[key] = value;
    if (key === 'sceneTypeReading') {
      generation.sceneTypeComparison = map.sceneType[0];
      generation.sceneTypeDataReading = map.sceneType[1];
      generation.sceneTypeTradeoffs = map.sceneType[2];
    }
  }
  if (!generation.sceneTypeComparison) throw new Error(`${locale}: sceneTypeReading anchor missing`);

  const trailLabels = {};
  for (const [key, value] of Object.entries(doc.classroomComplete.trailLabels)) {
    trailLabels[key] = value;
    if (key === 'reading') {
      trailLabels.comparison = map.trail[0];
      trailLabels.dataReading = map.trail[1];
      trailLabels.tradeoffs = map.trail[2];
    }
  }
  if (!trailLabels.comparison) throw new Error(`${locale}: trail reading anchor missing`);
  doc.generation = generation;
  doc.classroomComplete.trailLabels = trailLabels;

  writeFileSync(path, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  console.log(`${locale}: ok`);
}
