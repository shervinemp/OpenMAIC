// @vitest-environment jsdom
// Keep the .test.ts suffix: the repository's Vitest include intentionally
// discovers TypeScript tests with this extension.

import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  saveDocument: vi.fn(async () => undefined),
  deleteDocument: vi.fn(async () => undefined),
  mediaDelete: vi.fn(async () => 0),
  audioDelete: vi.fn(async () => 0),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: {
    loading: vi.fn(() => 'toast-id'),
    success: mocks.toastSuccess,
    error: mocks.toastError,
  },
}));
vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));
vi.mock('@/lib/media/asset-pool', () => ({ removeAsset: vi.fn(async () => undefined) }));
vi.mock('@/lib/utils/database', () => ({
  mediaFileKey: (stageId: string, elementId: string) => `${stageId}:${elementId}`,
  db: {
    mediaFiles: { where: () => ({ equals: () => ({ delete: mocks.mediaDelete }) }) },
    audioFiles: { where: () => ({ equals: () => ({ delete: mocks.audioDelete }) }) },
  },
}));
vi.mock('@/lib/document-store', () => ({
  canonicalizeLegacyScene: (scene: unknown) => scene,
  mutateDocument: vi.fn(
    async (
      _stageId: string,
      mutate: (
        existing: unknown,
        store: {
          saveDocument: typeof mocks.saveDocument;
          deleteDocument: typeof mocks.deleteDocument;
        },
      ) => Promise<unknown>,
    ) =>
      mutate(undefined, {
        saveDocument: mocks.saveDocument,
        deleteDocument: mocks.deleteDocument,
      }),
  ),
}));

import { useImportClassroom } from '@/lib/import/use-import-classroom';

type ImportHook = ReturnType<typeof useImportClassroom>;

async function classroomZipFile(): Promise<File> {
  const zip = new JSZip();
  zip.file(
    'manifest.json',
    JSON.stringify({
      formatVersion: 1,
      stage: { name: 'Imported course', createdAt: 1 },
      agents: [],
      scenes: [],
      mediaIndex: {},
    }),
  );
  const bytes = await zip.generateAsync({ type: 'arraybuffer' });
  return new File([bytes], 'course.maic.zip', { type: 'application/zip' });
}

describe('useImportClassroom commit semantics', () => {
  let container: HTMLDivElement;
  let root: Root;
  let hook: ImportHook | undefined;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    root = createRoot(container);
    for (const mock of Object.values(mocks)) mock.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    hook = undefined;
  });

  it('keeps a successfully imported course instead of rolling it back', async () => {
    const onSuccess = vi.fn();
    function Harness() {
      const value = useImportClassroom(onSuccess);
      useEffect(() => {
        hook = value;
      });
      return null;
    }
    await act(async () => {
      root.render(createElement(Harness));
    });

    const file = await classroomZipFile();
    const input = document.createElement('input');
    Object.defineProperty(input, 'files', { value: [file] });

    await act(async () => {
      await hook!.handleFileChange({
        target: input,
      } as unknown as React.ChangeEvent<HTMLInputElement>);
    });

    expect(mocks.saveDocument).toHaveBeenCalledTimes(1);
    expect(mocks.deleteDocument).not.toHaveBeenCalled();
    expect(mocks.mediaDelete).not.toHaveBeenCalled();
    expect(mocks.audioDelete).not.toHaveBeenCalled();
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(mocks.toastSuccess).toHaveBeenCalled();
  });
});
