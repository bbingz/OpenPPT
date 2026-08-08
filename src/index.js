/**
 * OpenPPT public API — open IR load/validate/compile.
 * Default export path uses pptxgenjs only (no Kimi/neo-ppt WASM).
 */

export { loadDeck } from "./load.js";
export {
  validateDeck,
  getSchemaValidator,
  getSchemaPath,
  resolveColor,
  safeProjectPath,
} from "./validate.js";
export { compileToPptx, compileToBuffer } from "./compile.js";
export { OpenPptError, ErrorCodes } from "./errors.js";

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
