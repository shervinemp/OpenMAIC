#!/usr/bin/env node
// Adds the `backup` i18n namespace to every locale in lib/i18n/locales,
// preserving existing keys. Run: node scripts/add-backup-i18n.mjs
import fs from 'node:fs';
import path from 'node:path';

const LOCALES_DIR = path.join(process.cwd(), 'lib', 'i18n', 'locales');

const T = {
  'en-US': {
    cardTitle: 'Data & Local Backup',
    desc: 'Export every course plus your settings to a single ZIP (API keys and tokens are deliberately excluded). Restarting the app or switching browsers does not lose data while you hold the file.',
    export: 'Export full backup',
    exporting: 'Exporting…',
    restoreFile: 'Restore backup',
    restoring: 'Restoring…',
    importHint: 'Choose an OpenMAIC backup file (.zip)',
    modeLabel: 'Restore conflict behavior',
    modeReplace: 'Replace duplicates',
    modeSkip: 'Skip existing',
    modeAdd: 'Always import copies',
    autoToggle: 'Automatic local snapshots',
    autoToggleHint: 'kept in this browser, newest {{max}} retained',
    capture: 'Capture now',
    snapshotsTitle: 'Local snapshots',
    getSnapshotFailed: 'Could not load snapshots.',
    restore: 'Restore',
    delete: 'Delete',
    deleteConfirm: 'Delete this snapshot?',
    coursesOne: '{{count}} course',
    coursesOther: '{{count}} courses',
    settingsSuffix: ' · settings',
    expPreparing: 'Preparing full backup…',
    expDone: 'Full backup saved ({{courses}}{{settings}}).',
    expFailed: 'Full backup failed. See the console for details.',
    resPreparing: 'Restoring backup…',
    resDone: 'Restored {{courses}} & replaced {{replaced}}; {{skipped}}{{failed}}{{settings}}',
    resFailed: '{{message}}',
    snapPreparing: 'Restoring snapshot…',
    snapDone: 'Restored {{courses}} & replaced {{replaced}} ({{failed}}).',
    snapFail: 'Snapshot restore failed.',
    snapCaptured: 'Snapshot captured ({{courses}}, {{size}} MB).',
    snapCaptureFailed: 'Snapshot capture failed.',
    snapDeleteDone: 'Snapshot deleted.',
    snapDeleteFailed: 'Could not delete snapshot.',
    toggleOn: 'Automatic local snapshots enabled.',
    toggleOff: 'Automatic local snapshots disabled.',
    progressPack: 'Packing course {{index}}/{{total}}: {{name}}',
    progressRestore: 'Restoring course: {{name}}',
    progressReplace: 'Replacing course: {{name}}',
    progressSkip: 'Skipping existing course: {{name}}',
  },
  'zh-CN': {
    cardTitle: '数据与本地备份',
    export: '导出完整备份',
    exporting: '正在导出…',
    restoreFile: '还原备份',
    restoring: '正在还原…',
    importHint: '选择 OpenMAIC 备份文件（.zip）',
    modeLabel: '还原冲突行为',
    modeReplace: '替换重复课程',
    modeSkip: '跳过已有课程',
    modeAdd: '始终导入副本',
    autoToggle: '自动本地快照',
    autoToggleHint: '保存在本浏览器，保留最新 {{max}} 个',
    capture: '立即生成',
    snapshotsTitle: '本地快照',
    restore: '还原',
    delete: '删除',
    deleteConfirm: '确定删除该快照？',
    coursesOne: '{{count}} 门课程',
    coursesOther: '{{count}} 门课程',
    settingsSuffix: '· 设置',
    expPreparing: '正在准备完整备份…',
    expDone: '完整备份已导出（{{courses}}{{settings}}）。',
    expFailed: '完整备份导出失败，详见控制台。',
    resPreparing: '正在还原备份…',
    resDone: '还原 {{courses}}，替换 {{replaced}}{{skipped}}{{failed}}{{settings}}',
    resFailed: '{{message}}',
    snapPreparing: '正在还原快照…',
    snapDone: '已还原 {{courses}}、替换 {{replaced}}（{{failed}}）。',
    snapFail: '快照还原失败。',
    snapCaptured: '已生成快照（{{courses}}，{{size}}）。',
    snapCaptureFailed: '快照生成失败。',
    snapDeleteDone: '快照已删除。',
    snapDeleteFailed: '无法删除快照。',
    toggleOn: '已启用自动本地快照。',
    toggleOff: '已停用自动本地快照。',
    progressPack: '正在打包课程 {{index}}/{{total}}：{{name}}',
    progressRestore: '正在还原课程：{{name}}',
    progressReplace: '正在替换课程：{{name}}',
    progressSkip: '正在跳过已有课程：{{name}}',
  },
};

Object.entries(T['en-US']).forEach(([key]) => {
  for (const lang of Object.keys(T)) {
    if (Object.prototype.hasOwnProperty.call(T[lang], key)) continue;
    T[lang][key] = T['en-US'][key];
  }
});

const copyForFallback = Object.keys(T['en-US']);
for (const file of fs.readdirSync(LOCALES_DIR).filter((name) => name.endsWith('.json'))) {
  const lang = path.basename(file, '.json');
  const fullPath = path.join(LOCALES_DIR, file);
  const json = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
  if (json.backup === undefined) json.backup = {};
  const source = T[lang] ?? {};
  for (const key of copyForFallback) {
    json.backup[key] = source[key] ?? T['en-US'][key];
  }
  fs.writeFileSync(fullPath, `${JSON.stringify(json, null, 2)}\n`);
  console.log(`updated ${file}`);
}
