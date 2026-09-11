import { readFileSync, writeFileSync } from 'node:fs';

const labels = {
  'de-DE': {
    title: 'Bereitschaftsprüfung der Generierung',
    description:
      'Einige der aktivierten Generierungsziele sind nicht erreichbar oder nicht eingerichtet. Sie können fortfahren, diese Teile des Kurses schlagen jedoch fehl oder werden übersprungen.',
    llm: 'Textmodell (LLM)',
    image: 'Bilderzeugung',
    video: 'Videoerzeugung',
    tts: 'Sprachausgabe',
    review: 'Einstellungen öffnen',
    proceed: 'Trotzdem generieren',
  },
  'en-US': {
    title: 'Generation readiness check',
    description:
      'Some of the enabled generation targets are not reachable or not set up. You can continue, but those parts of the course will fail or be skipped.',
    llm: 'Text model (LLM)',
    image: 'Image generation',
    video: 'Video generation',
    tts: 'Text-to-speech',
    review: 'Review settings',
    proceed: 'Generate anyway',
  },
  'fr-FR': {
    title: 'Vérification de disponibilité',
    description:
      "Certaines cibles de génération activées sont inaccessibles ou non configurées. Vous pouvez continuer, mais ces parties du cours échoueront ou seront ignorées.",
    llm: 'Modèle de texte (LLM)',
    image: "Génération d'images",
    video: 'Génération vidéo',
    tts: 'Synthèse vocale',
    review: 'Vérifier les réglages',
    proceed: 'Générer quand même',
  },
  'es-MX': {
    title: 'Verificación de disponibilidad',
    description:
      'Algunos objetivos de generación habilitados no están accesibles o configurados. Puedes continuar, pero esas partes del curso fallarán o se omitirán.',
    llm: 'Modelo de texto (LLM)',
    image: 'Generación de imágenes',
    video: 'Generación de video',
    tts: 'Texto a voz',
    review: 'Revisar ajustes',
    proceed: 'Generar de todos modos',
  },
  'pt-BR': {
    title: 'Verificação de prontidão',
    description:
      'Alguns alvos de geração habilitados estão inacessíveis ou não configurados. Você pode continuar, mas essas partes do curso falharão ou serão puladas.',
    llm: 'Modelo de texto (LLM)',
    image: 'Geração de imagens',
    video: 'Geração de vídeo',
    tts: 'Texto para fala',
    review: 'Revisar configurações',
    proceed: 'Gerar mesmo assim',
  },
  'ar-SA': {
    title: 'فحص جاهزية التوليد',
    description:
      'بعض أهداف التوليد الممكّنة غير متاحة أو غير مهيأة. يمكنك المتابعة، لكن تلك الأجزاء من الدورة ستفشل أو ستُتخطى.',
    llm: 'نموذج النص (LLM)',
    image: 'توليد الصور',
    video: 'توليد الفيديو',
    tts: 'تحويل النص إلى كلام',
    review: 'مراجعة الإعدادات',
    proceed: 'التوليد على أي حال',
  },
  'ru-RU': {
    title: 'Проверка готовности генерации',
    description:
      'Некоторые включённые цели генерации недоступны или не настроены. Можно продолжить, но эти части курса не сгенерируются.',
    llm: 'Текстовая модель (LLM)',
    image: 'Генерация изображений',
    video: 'Генерация видео',
    tts: 'Синтез речи',
    review: 'Открыть настройки',
    proceed: 'Всё равно создать',
  },
  'ja-JP': {
    title: '生成前チェック',
    description:
      '有効な生成先の一部にアクセスできないか、未設定です。続行できますが、コースの該当部分は失敗またはスキップされます。',
    llm: 'テキストモデル（LLM）',
    image: '画像生成',
    video: '動画生成',
    tts: '音声合成',
    review: '設定を確認',
    proceed: 'それでも生成する',
  },
  'ko-KR': {
    title: '생성 준비 상태 확인',
    description:
      '활성화된 생성 대상 중 접근할 수 없거나 설정되지 않은 항목이 있습니다. 계속할 수 있지만 해당 부분은 실패하거나 건너뛰어집니다.',
    llm: '텍스트 모델(LLM)',
    image: '이미지 생성',
    video: '비디오 생성',
    tts: '음성 합성',
    review: '설정 열기',
    proceed: '그래도 생성',
  },
  'zh-CN': {
    title: '生成前就绪检查',
    description: '部分已启用的生成目标不可用或未配置。你可以继续，但课程的这些部分会失败或被跳过。',
    llm: '文本模型（LLM）',
    image: '图像生成',
    video: '视频生成',
    tts: '语音合成',
    review: '打开设置',
    proceed: '仍然生成',
  },
  'zh-TW': {
    title: '生成前就緒檢查',
    description: '部分已啟用的生成目標無法使用或未設定。你可以繼續，但課程的這些部分會失敗或被跳過。',
    llm: '文字模型（LLM）',
    image: '圖像生成',
    video: '影片生成',
    tts: '語音合成',
    review: '開啟設定',
    proceed: '仍要生成',
  },
  'vi-VN': {
    title: 'Kiểm tra sẵn sàng trước khi tạo',
    description:
      'Một số đích tạo đã bật hiện không truy cập được hoặc chưa cấu hình. Bạn vẫn có thể tiếp tục, nhưng các phần đó của khóa học sẽ thất bại hoặc bị bỏ qua.',
    llm: 'Mô hình văn bản (LLM)',
    image: 'Tạo hình ảnh',
    video: 'Tạo video',
    tts: 'Chuyển văn bản thành giọng nói',
    review: 'Mở cài đặt',
    proceed: 'Vẫn tạo',
  },
};

for (const [locale, map] of Object.entries(labels)) {
  const path = `lib/i18n/locales/${locale}.json`;
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  if (!doc.generation) throw new Error(`${locale}: no generation block`);
  doc.generation.readiness = map;
  writeFileSync(path, JSON.stringify(doc, null, 2) + '\n');
  console.log(`${locale}: ok`);
}
