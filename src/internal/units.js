/** CSS px per inch (96dpi web/PPT mapping). */
export const PX_PER_INCH = 96;

/** Typographic points per inch. */
export const PT_PER_INCH = 72;

/** EMUs per inch (OOXML). */
export const EMU_PER_INCH = 914400;

/** EMUs per CSS px at 96dpi (914400 / 96). */
export const EMU_PER_PX = EMU_PER_INCH / PX_PER_INCH;

/** CSS px per point at 96dpi (96/72 = 4/3). */
export const PX_PER_PT = PX_PER_INCH / PT_PER_INCH;

/** Default omitted OOXML bodyPr lIns/rIns: 91440 EMU = 0.1in = 9.6 CSS px. */
export const TEXT_INSET_X_PX = 91440 / EMU_PER_PX;

/** Default omitted OOXML bodyPr tIns/bIns: 45720 EMU = 0.05in = 4.8 CSS px. */
export const TEXT_INSET_Y_PX = 45720 / EMU_PER_PX;

/**
 * @param {number} px
 * @returns {number}
 */
export function pxToInch(px) {
  return px / PX_PER_INCH;
}

/**
 * @param {number} emu
 * @returns {number}
 */
export function emuToPx(emu) {
  return Math.round(Number(emu) / EMU_PER_PX);
}

/**
 * Convert IR typographic points to CSS pixels at 96dpi.
 * @param {number} pt
 * @returns {number}
 */
export function ptToPx(pt) {
  return Number(pt) * PX_PER_PT;
}
