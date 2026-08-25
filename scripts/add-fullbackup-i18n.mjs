import { readFileSync, writeFileSync } from 'node:fs';

const msgs = {
  'en-US':
    'This is a full backup file, not a single course. Use "Restore backup" on the home page instead.',
  'fr-FR':
    "Ceci est une sauvegarde complète, pas un cours unique. Utilisez « Restaurer la sauvegarde » sur la page d'accueil.",
  'es-MX':
    'Este es un respaldo completo, no un curso individual. Usa "Restaurar respaldo" en la página de inicio.',
  'pt-BR':
    'Este é um backup completo, não um curso único. Use "Restaurar backup" na página inicial.',
  'ru-RU':
    'Это полная резервная копия, а не отдельный курс. Используйте «Восстановить копию» на главной странице.',
  'ja-JP':
    'これはフルバックアップであり単一コースではありません。ホームページの「バックアップを復元」を使用してください。',
  'ko-KR':
    '전체 백업 파일이며 단일 강의가 아닙니다. 홈 페이지의 "백업 복원"을 사용하세요.',
  'zh-CN': '这是完整备份文件，不是单个课程。请使用主页上的"恢复备份"。',
  'zh-TW': '這是完整備份檔案，不是單一課程。請使用首頁上的「還原備份」。',
  'ar-SA':
    'هذا ملف نسخة احتياطية كاملة وليس دورة واحدة. استخدم "استعادة النسخة الاحتياطية" في الصفحة الرئيسية.',
  'vi-VN':
    'Đây là bản sao lưu đầy đủ, không phải một khóa học. Hãy dùng "Khôi phục bản sao lưu" trên trang chủ.',
};

for (const loc of Object.keys(msgs)) {
  const path = `lib/i18n/locales/${loc}.json`;
  const d = JSON.parse(readFileSync(path, 'utf8'));
  if (!d.import?.error) {
    console.log(loc, 'SKIP (no import.error)');
    continue;
  }
  d.import.error.fullBackup = msgs[loc];
  writeFileSync(path, JSON.stringify(d, null, 2) + '\n');
  console.log(loc, 'ok');
}
