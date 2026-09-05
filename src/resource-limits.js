import { ErrorCodes, OpenPptError } from "./errors.js";

const KiB = 1024;
const MiB = 1024 * KiB;

/** Fixed OpenPPT safety ceilings. These are not OOXML format limits. */
export const RESOURCE_LIMITS = Object.freeze({
  pagesPerDeck: 256,
  elementsPerPage: 512,
  elementsPerDeck: 8192,
  authoringNodesPerPage: 1024,
  authoringNodesPerDeck: 16384,
  groupDepth: 16,
  groupChildren: 256,
  stringBytes: 64 * KiB,
  totalStringBytes: 8 * MiB,
  richTextRunsPerElement: 1024,
  chartSeriesPerElement: 32,
  chartPointsPerSeries: 2048,
  chartPointsPerElement: 8192,
  chartPointsPerDeck: 32768,
  tableRowsPerElement: 256,
  tableColumnsPerRow: 64,
  tableCellsPerElement: 8192,
  tableCellsPerDeck: 32768,
  namedTextStyles: 128,
  paragraphsPerElement: 256,
  pptxArchiveBytes: 192 * MiB,
  pptxEntries: 4096,
  pptxEntryUncompressedBytes: 32 * MiB,
  pptxUncompressedBytes: 256 * MiB,
  mediaBytesPerFile: 32 * MiB,
  mediaBytesPerDeck: 128 * MiB,
});

/**
 * @param {number} actual
 * @param {number} maximum
 * @param {keyof typeof RESOURCE_LIMITS} limit
 * @param {string} context
 */
export function assertResourceLimit(actual, maximum, limit, context) {
  if (actual <= maximum) return;
  throw new OpenPptError(
    ErrorCodes.RESOURCE_LIMIT,
    `Resource limit exceeded at ${context}: ${limit}=${actual}, maximum=${maximum}`,
    { limit, actual, maximum, context },
  );
}

/**
 * Enforce structural and user-authored collection ceilings before rendering.
 * Authoring groups are walked iteratively so limits apply before recursive
 * layout expansion. Malformed fields are left to schema/layout validation.
 * @param {object} deck
 */
export function assertDeckResourceLimits(deck) {
  if (!deck || typeof deck !== "object") return;

  let totalElements = 0;
  let totalAuthoringNodes = 0;
  let totalStringBytes = 0;
  let totalChartPoints = 0;
  let totalTableCells = 0;

  function addString(value, context) {
    if (typeof value !== "string") return;
    const bytes = Buffer.byteLength(value, "utf8");
    assertResourceLimit(
      bytes,
      RESOURCE_LIMITS.stringBytes,
      "stringBytes",
      context,
    );
    totalStringBytes += bytes;
    assertResourceLimit(
      totalStringBytes,
      RESOURCE_LIMITS.totalStringBytes,
      "totalStringBytes",
      "deck",
    );
  }

  addString(deck.title, "title");
  if (deck.theme?.colors && typeof deck.theme.colors === "object") {
    let colorIndex = 0;
    for (const name in deck.theme.colors) {
      if (!Object.prototype.hasOwnProperty.call(deck.theme.colors, name)) continue;
      addString(name, `theme.colors[${colorIndex}].name`);
      addString(deck.theme.colors[name], `theme.colors[${colorIndex}].value`);
      colorIndex += 1;
    }
  }
  if (deck.theme?.fonts && typeof deck.theme.fonts === "object") {
    addString(deck.theme.fonts.latin, "theme.fonts.latin");
    addString(deck.theme.fonts.ea, "theme.fonts.ea");
  }
  if (deck.theme?.textStyles && typeof deck.theme.textStyles === "object") {
    let styleCount = 0;
    for (const name in deck.theme.textStyles) {
      if (!Object.prototype.hasOwnProperty.call(deck.theme.textStyles, name)) continue;
      styleCount += 1;
      assertResourceLimit(
        styleCount,
        RESOURCE_LIMITS.namedTextStyles,
        "namedTextStyles",
        "theme.textStyles",
      );
      addString(name, `theme.textStyles.${name}.name`);
      const style = deck.theme.textStyles[name];
      if (style && typeof style === "object" && !Array.isArray(style)) {
        addString(style.fontFamily, `theme.textStyles.${name}.fontFamily`);
        addString(style.color, `theme.textStyles.${name}.color`);
      }
    }
  }

  if (!Array.isArray(deck.pages)) return;
  assertResourceLimit(
    deck.pages.length,
    RESOURCE_LIMITS.pagesPerDeck,
    "pagesPerDeck",
    "pages",
  );

  for (let pageIndex = 0; pageIndex < deck.pages.length; pageIndex += 1) {
    const page = deck.pages[pageIndex];
    if (typeof page === "string") {
      addString(page, `pages[${pageIndex}]`);
      continue;
    }
    if (!page || typeof page !== "object" || !Array.isArray(page.elements)) {
      continue;
    }

    addString(page.id, `pages[${pageIndex}].id`);
    addString(page.background?.color, `pages[${pageIndex}].background.color`);
    assertResourceLimit(
      page.elements.length,
      RESOURCE_LIMITS.authoringNodesPerPage,
      "authoringNodesPerPage",
      `pages[${pageIndex}].elements`,
    );

    let pageElements = 0;
    let pageAuthoringNodes = 0;
    const stack = page.elements.map((element) => ({ element, depth: 0 }));
    while (stack.length > 0) {
      const { element, depth } = stack.pop();
      if (!element || typeof element !== "object" || Array.isArray(element)) {
        continue;
      }

      pageAuthoringNodes += 1;
      totalAuthoringNodes += 1;
      assertResourceLimit(
        pageAuthoringNodes,
        RESOURCE_LIMITS.authoringNodesPerPage,
        "authoringNodesPerPage",
        `pages[${pageIndex}]`,
      );
      assertResourceLimit(
        totalAuthoringNodes,
        RESOURCE_LIMITS.authoringNodesPerDeck,
        "authoringNodesPerDeck",
        "deck",
      );

      const context = `pages[${pageIndex}].elements`;
      addString(element.id, `${context}.id`);
      if (element.type === "group") {
        const groupDepth = depth + 1;
        assertResourceLimit(
          groupDepth,
          RESOURCE_LIMITS.groupDepth,
          "groupDepth",
          `${context} (id=${element.id || "?"})`,
        );
        if (Array.isArray(element.children)) {
          assertResourceLimit(
            element.children.length,
            RESOURCE_LIMITS.groupChildren,
            "groupChildren",
            `${context} (id=${element.id || "?"}).children`,
          );
          for (const child of element.children) {
            stack.push({ element: child, depth: groupDepth });
          }
        }
        continue;
      }

      pageElements += 1;
      totalElements += 1;
      assertResourceLimit(
        pageElements,
        RESOURCE_LIMITS.elementsPerPage,
        "elementsPerPage",
        `pages[${pageIndex}].elements`,
      );
      assertResourceLimit(
        totalElements,
        RESOURCE_LIMITS.elementsPerDeck,
        "elementsPerDeck",
        "deck",
      );

      const elementContext = `${context} (id=${element.id || "?"})`;
      if (element.type === "text") {
        addString(element.fontFamily, `${elementContext}.fontFamily`);
        addString(element.style, `${elementContext}.style`);
        addString(element.href, `${elementContext}.href`);
        addString(element.color, `${elementContext}.color`);
        if (Array.isArray(element.paragraphs)) {
          assertResourceLimit(
            element.paragraphs.length,
            RESOURCE_LIMITS.paragraphsPerElement,
            "paragraphsPerElement",
            `${elementContext}.paragraphs`,
          );
          let authoredRuns = 0;
          let fragments = 0;
          for (let pi = 0; pi < element.paragraphs.length; pi += 1) {
            const para = element.paragraphs[pi];
            const pctx = `${elementContext}.paragraphs[${pi}]`;
            if (!para || typeof para !== "object") continue;
            addString(para.fontFamily, `${pctx}.fontFamily`);
            addString(para.color, `${pctx}.color`);
            if (Array.isArray(para.text)) {
              assertResourceLimit(
                authoredRuns + para.text.length,
                RESOURCE_LIMITS.richTextRunsPerElement,
                "richTextRunsPerElement",
                `${pctx}.text`,
              );
              authoredRuns += para.text.length;
              for (let ri = 0; ri < para.text.length; ri += 1) {
                const run = para.text[ri];
                if (!run || typeof run !== "object") continue;
                addString(run.text, `${pctx}.text[${ri}].text`);
                addString(run.fontFamily, `${pctx}.text[${ri}].fontFamily`);
                addString(run.color, `${pctx}.text[${ri}].color`);
                fragments += String(run.text ?? "").split(/\r\n|\r|\n/).length;
                assertResourceLimit(
                  fragments,
                  RESOURCE_LIMITS.richTextRunsPerElement,
                  "richTextRunsPerElement",
                  `${pctx}.text fragments`,
                );
              }
            } else {
              authoredRuns += 1;
              assertResourceLimit(
                authoredRuns,
                RESOURCE_LIMITS.richTextRunsPerElement,
                "richTextRunsPerElement",
                `${pctx}.text`,
              );
              addString(para.text, `${pctx}.text`);
              fragments += String(para.text ?? "").split(/\r\n|\r|\n/).length;
              assertResourceLimit(
                fragments,
                RESOURCE_LIMITS.richTextRunsPerElement,
                "richTextRunsPerElement",
                `${pctx}.text fragments`,
              );
            }
          }
          assertResourceLimit(
            authoredRuns,
            RESOURCE_LIMITS.richTextRunsPerElement,
            "richTextRunsPerElement",
            `${elementContext}.paragraphs`,
          );
          assertResourceLimit(
            fragments,
            RESOURCE_LIMITS.richTextRunsPerElement,
            "richTextRunsPerElement",
            `${elementContext}.paragraphs fragments`,
          );
        } else if (Array.isArray(element.text)) {
          assertResourceLimit(
            element.text.length,
            RESOURCE_LIMITS.richTextRunsPerElement,
            "richTextRunsPerElement",
            `${elementContext}.text`,
          );
          for (let runIndex = 0; runIndex < element.text.length; runIndex += 1) {
            const run = element.text[runIndex];
            if (!run || typeof run !== "object") continue;
            addString(run.text, `${elementContext}.text[${runIndex}].text`);
            addString(
              run.fontFamily,
              `${elementContext}.text[${runIndex}].fontFamily`,
            );
            addString(run.color, `${elementContext}.text[${runIndex}].color`);
          }
        } else {
          addString(element.text, `${elementContext}.text`);
        }
      } else if (element.type === "shape") {
        addString(element.fill, `${elementContext}.fill`);
        addString(element.lineColor, `${elementContext}.lineColor`);
      } else if (element.type === "image") {
        addString(element.src, `${elementContext}.src`);
      } else if (element.type === "chart") {
        addString(element.title, `${elementContext}.title`);
        if (!Array.isArray(element.series)) continue;
        assertResourceLimit(
          element.series.length,
          RESOURCE_LIMITS.chartSeriesPerElement,
          "chartSeriesPerElement",
          `${elementContext}.series`,
        );
        let elementPoints = 0;
        for (let seriesIndex = 0; seriesIndex < element.series.length; seriesIndex += 1) {
          const series = element.series[seriesIndex];
          if (!series || typeof series !== "object") continue;
          const seriesContext = `${elementContext}.series[${seriesIndex}]`;
          addString(series.name, `${seriesContext}.name`);
          if (Array.isArray(series.values)) {
            assertResourceLimit(
              series.values.length,
              RESOURCE_LIMITS.chartPointsPerSeries,
              "chartPointsPerSeries",
              `${seriesContext}.values`,
            );
            elementPoints += series.values.length;
            totalChartPoints += series.values.length;
            assertResourceLimit(
              elementPoints,
              RESOURCE_LIMITS.chartPointsPerElement,
              "chartPointsPerElement",
              elementContext,
            );
            assertResourceLimit(
              totalChartPoints,
              RESOURCE_LIMITS.chartPointsPerDeck,
              "chartPointsPerDeck",
              "deck",
            );
          }
          if (Array.isArray(series.labels)) {
            assertResourceLimit(
              series.labels.length,
              RESOURCE_LIMITS.chartPointsPerSeries,
              "chartPointsPerSeries",
              `${seriesContext}.labels`,
            );
            for (let labelIndex = 0; labelIndex < series.labels.length; labelIndex += 1) {
              addString(
                series.labels[labelIndex],
                `${seriesContext}.labels[${labelIndex}]`,
              );
            }
          }
        }
      } else if (element.type === "table") {
        addString(element.borderColor, `${elementContext}.borderColor`);
        if (Array.isArray(element.colW)) {
          assertResourceLimit(
            element.colW.length,
            RESOURCE_LIMITS.tableColumnsPerRow,
            "tableColumnsPerRow",
            `${elementContext}.colW`,
          );
        }
        if (!Array.isArray(element.rows)) continue;
        assertResourceLimit(
          element.rows.length,
          RESOURCE_LIMITS.tableRowsPerElement,
          "tableRowsPerElement",
          `${elementContext}.rows`,
        );
        let elementCells = 0;
        for (let rowIndex = 0; rowIndex < element.rows.length; rowIndex += 1) {
          const row = element.rows[rowIndex];
          if (!Array.isArray(row)) continue;
          assertResourceLimit(
            row.length,
            RESOURCE_LIMITS.tableColumnsPerRow,
            "tableColumnsPerRow",
            `${elementContext}.rows[${rowIndex}]`,
          );
          elementCells += row.length;
          totalTableCells += row.length;
          assertResourceLimit(
            elementCells,
            RESOURCE_LIMITS.tableCellsPerElement,
            "tableCellsPerElement",
            elementContext,
          );
          assertResourceLimit(
            totalTableCells,
            RESOURCE_LIMITS.tableCellsPerDeck,
            "tableCellsPerDeck",
            "deck",
          );
          for (let cellIndex = 0; cellIndex < row.length; cellIndex += 1) {
            const cell = row[cellIndex];
            const cellContext = `${elementContext}.rows[${rowIndex}][${cellIndex}]`;
            if (typeof cell === "string") addString(cell, cellContext);
            else if (cell && typeof cell === "object" && !Array.isArray(cell)) {
              addString(cell.text, `${cellContext}.text`);
              addString(cell.color, `${cellContext}.color`);
              addString(cell.fill, `${cellContext}.fill`);
            }
          }
        }
      }
    }
  }
}
