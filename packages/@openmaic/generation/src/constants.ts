export const MAX_PDF_CONTENT_CHARS = 50_000;
export const MAX_VISION_IMAGES = 20;

// Corrective retry budget for the scene-content stage: beyond the first
// call, this many depth-corrected re-prompts. On exhaustion the scene
// fails with the depth report -- shallow content is never accepted.
export const MAX_CONTENT_ATTEMPTS = 2;

// Depth contract defaults (content-depth.ts): a slide needs at least this
// many substantive text elements (complete claims/sentences), caption
// fragments may not dominate, and a concrete example/definition/fact is
// required unless the outline is intro/summary.
export const MIN_SUBSTANTIVE_ELEMENTS = 4;
