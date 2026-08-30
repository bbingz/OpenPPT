/**
 * OpenPPT public API — open IR load/validate/compile/import/qa/preview.
 * Default export path uses pptxgenjs only (no Kimi/neo-ppt WASM).
 */

export { loadDeck, expandExternalPages } from "./load.js";
export {
  validateDeck,
  getSchemaValidator,
  getSchemaPath,
  resolveColor,
  safeProjectPath,
  assertMediaSubtree,
  sniffImageType,
  sniffImageBytes,
  imageSizeFromBytes,
  clearSchemaValidatorCache,
} from "./validate.js";
export { compileToPptx, compileToBuffer } from "./compile.js";
export { importPptx } from "./import-pptx.js";
export { initProject } from "./init.js";
export {
  parseOutlineMarkdown,
  outlineToDeck,
  projectFromOutline,
} from "./from-outline.js";
export {
  analyzeLayout,
  qaDeck,
  issuesFailThreshold,
  severityRank,
} from "./qa.js";
export {
  expandLayouts,
  expandPageLayouts,
  deckHasGroups,
} from "./layout.js";
export { renderPreviewHtml, writePreviewHtml } from "./preview.js";
export { startWebServer } from "./server.js";
export { findSoffice, convertPptxToPdf, exportDeckPdf } from "./render-pdf.js";
export { OpenPptError, ErrorCodes, SeverityRank } from "./errors.js";

/**
 * High-level: load file → validate → export PPTX.
 * @param {string} deckPath
 * @param {string} outputPath
 * @param {{ force?: boolean }} [options]
 */
export async function exportDeckFile(deckPath, outputPath, options = {}) {
  const { loadDeck } = await import("./load.js");
  const { compileToPptx } = await import("./compile.js");
  const { deck, projectRoot, sourcePath } = loadDeck(deckPath);
  return compileToPptx(deck, outputPath, {
    projectRoot,
    force: Boolean(options.force),
    sourcePath,
  });
}
