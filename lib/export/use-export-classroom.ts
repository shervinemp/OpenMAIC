'use client';

import { useState, useCallback } from 'react';
import { saveAs } from 'file-saver';
import { toast } from 'sonner';
import { useStageStore } from '@/lib/store/stage';
import { useI18n } from '@/lib/hooks/use-i18n';
import { CLASSROOM_ZIP_EXTENSION } from './classroom-zip-types';
import { addStageContentToZip } from './build-classroom-zip';
import { accessDocument } from '@/lib/document-store';
import { createLogger } from '@/lib/logger';

export { inlineSceneContent } from './build-classroom-zip';

const log = createLogger('ExportClassroom');

export function useExportClassroom() {
  const [exporting, setExporting] = useState(false);
  const { t } = useI18n();

  const exportClassroomZip = useCallback(async () => {
    const { stage, scenes } = useStageStore.getState();
    if (!stage?.id || scenes.length === 0) return;

    setExporting(true);
    const toastId = toast.loading(t('export.exporting'));

    try {
      const JSZip = (await import('jszip')).default;
      const zip = new JSZip();

      // Read latest stage name from the document aggregate (it may have been
      // renamed at home).
      const freshDocument = await accessDocument(stage.id);
      const latestName = freshDocument.document?.stage.name || stage.name;

      const { safeName, report } = await addStageContentToZip(zip, stage, scenes, {
        latestName,
      });

      // Generate and download
      const zipBlob = await zip.generateAsync({ type: 'blob' });
      saveAs(zipBlob, `${safeName}${CLASSROOM_ZIP_EXTENSION}`);

      if (report.failed.length > 0) {
        log.warn('Some interactive-scene assets could not be inlined:', report.failed);
        const hosts = [
          ...new Set(
            report.failed.map((f) => {
              try {
                return new URL(f.url).host;
              } catch {
                return f.url;
              }
            }),
          ),
        ];
        toast.warning(t('export.inlinePartial', { count: report.failed.length }), {
          description: hosts.join(', '),
        });
      }
      toast.success(t('export.exportSuccess'), { id: toastId });
    } catch (error) {
      log.error('Classroom ZIP export failed:', error);
      toast.error(t('export.exportFailed'), { id: toastId });
    } finally {
      setExporting(false);
    }
  }, [t]);

  return { exporting, exportClassroomZip };
}
