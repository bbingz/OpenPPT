/**
 * Structured errors for OpenPPT validate/compile.
 */

export class OpenPptError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = "OpenPptError";
    this.code = code;
    this.details = details;
  }
}

export const ErrorCodes = {
  SCHEMA: "SCHEMA_INVALID",
  BOUNDS: "BOUNDS_OUT_OF_RANGE",
  MEDIA_MISSING: "MEDIA_MISSING",
  THEME_COLOR: "THEME_COLOR_UNRESOLVED",
  IO: "IO_ERROR",
  EXPORT: "EXPORT_FAILED",
};
