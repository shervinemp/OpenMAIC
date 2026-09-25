import {
  sanitizeSlidePlacement,
  validateSlidePlacement,
  type PlacementFinding,
} from '@openmaic/dsl';

export interface PlacementSweepEntry {
  sceneId: string;
  sceneTitle: string;
  findings: Array<{ kind: string; severity: string; message: string }>;
}

export interface ScenePlacementResult {
  findings: Array<{ kind: string; severity: string; message: string }>;
  elementsClamped: number;
  scene: unknown;
}

export interface PlacementSweepResult {
  scenesChecked: number;
  scenesFlagged: number;
  elementsClamped: number;
  scenes: Array<unknown>;
  summary: PlacementSweepEntry[];
}

export function sweepCoursePlacement(
  scenes: Array<{ id: string; title?: string; type?: string; content?: unknown }>,
  options?: { repair?: boolean },
): PlacementSweepResult {
  const summary: Array<PlacementSweepEntry> = [];
  let elementsClamped = 0;
  let scenesChanged = 0;

  const nextScenes = scenes.map((scene) => {
    if (scene.type !== 'slide') return scene;
    const content = scene.content as { canvas?: unknown } | undefined;
    const canvas = content?.canvas as
      | { viewportSize: number; viewportRatio: number; elements: Array<Record<string, unknown>> }
      | undefined;
    if (!canvas || !Array.isArray(canvas.elements)) return scene;
    const findings: PlacementFinding[] = validateSlidePlacement(canvas as never);
    if (findings.length > 0) {
      summary.push({
        sceneId: scene.id,
        sceneTitle: scene.title ?? '',
        findings: findings.map((finding) => ({
          kind: finding.kind,
          severity: finding.severity,
          message: finding.message,
        })),
      });
    }
    if (!options?.repair) return scene;
    const { changes } = sanitizeSlidePlacement({
      viewportSize: canvas.viewportSize,
      viewportRatio: canvas.viewportRatio,
      elements: canvas.elements.map((element) => ({ ...element })) as never,
    });
    if (changes.length === 0) return scene;
    elementsClamped += changes.length;
    scenesChanged += 1;
    const patchedElements: Array<Record<string, unknown>> = canvas.elements.map(
      (element, index) => {
        const change = changes.find((entry) => entry.elementIndex === index);
        if (!change) return element;
        return {
          ...element,
          left: change.to.left,
          top: change.to.top,
          width: change.to.width,
          height: change.to.height,
        };
      },
    );
    return {
      ...scene,
      content: { ...content, canvas: { ...canvas, elements: patchedElements } },
    } as typeof scene;
  });

  return {
    scenesChecked: scenes.filter((scene) => scene.type === 'slide').length,
    scenesFlagged: summary.length,
    elementsClamped,
    scenes: scenesChanged > 0 ? nextScenes : scenes,
    summary,
  };
}

export function sweepScenePlacement(
  scene: { id: string; title?: string; type?: string; content?: unknown },
  options?: { repair?: boolean },
): ScenePlacementResult {
  const result = sweepCoursePlacement([scene], options);
  return {
    findings: result.summary[0]?.findings ?? [],
    elementsClamped: result.elementsClamped,
    scene: result.scenes[0],
  };
}
