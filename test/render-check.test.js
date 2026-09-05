import { describe, test, expect } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const posix = process.platform !== "win32";

async function writeSlidePptx(path, slides) {
  const zip = new JSZip();
  for (let i = 1; i <= slides; i += 1) {
    zip.file(`ppt/slides/slide${i}.xml`, "<p:sld/>");
  }
  writeFileSync(path, await zip.generateAsync({ type: "nodebuffer" }));
}

function writeExec(path, body) {
  writeFileSync(path, `#!${process.execPath}\n${body}\n`);
  chmodSync(path, 0o755);
}

async function runRenderCheck({ soffice, pdfinfo, pptxPath, env: extraEnv = {} }) {
  const env = { ...process.env, SOFFICE: soffice, PDFINFO: pdfinfo };
  delete env.SAL_USE_VCLPLUGIN;
  Object.assign(env, extraEnv);
  const child = Bun.spawn(
    [process.execPath, "scripts/render-check.js", "--require", pptxPath],
    {
      cwd: root,
      env,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

describe("render-check page count honesty", () => {
  test.skipIf(!posix)("positive/mismatch/zero/unknown/missing-pdfinfo without real tools", async () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-render-check-"));
    try {
      const pptx = join(work, "deck.pptx");
      await writeSlidePptx(pptx, 1);
      const soffice = join(work, "fake-soffice");
      writeExec(
        soffice,
        `import { writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
const a = process.argv.slice(2);
if (a.includes('--version')) process.exit(0);
writeFileSync(join(a[a.indexOf('--outdir') + 1], basename(a.at(-1), '.pptx') + '.pdf'), '%PDF-1.7\\n' + 'x'.repeat(2200));`,
      );

      const cases = [
        {
          name: "positive",
          pdfinfoBody: 'console.log("Pages:          1");',
          expectPass: true,
        },
        {
          name: "mismatch",
          pdfinfoBody: 'console.log("Pages:          9");',
          expectPass: false,
          needle: /pdfinfo pages 9 != PPTX slides 1/,
        },
        {
          name: "zero",
          pdfinfoBody: 'console.log("Pages:          0");',
          expectPass: false,
          needle: /page count is 0/,
        },
        {
          name: "unknown",
          pdfinfoBody: 'console.log("Title: no pages field");',
          expectPass: false,
          needle: /did not report a page count/,
        },
      ];

      for (const item of cases) {
        const pdfinfo = join(work, `pdfinfo-${item.name}`);
        writeExec(pdfinfo, item.pdfinfoBody);
        const result = await runRenderCheck({ soffice, pdfinfo, pptxPath: pptx });
        if (item.expectPass) {
          expect(`${item.name}:${result.code}`).toBe(`${item.name}:0`);
          expect(result.stdout).toMatch(/\[PASS]/);
        } else {
          expect(result.code).not.toBe(0);
          expect(result.stdout).toMatch(/\[FAIL]/);
          expect(result.stdout).not.toMatch(/\[PASS]/);
          if (item.needle) expect(result.stdout).toMatch(item.needle);
        }
        expect(result.stdout).toMatch(/not full Office/i);
      }

      const missing = await runRenderCheck({
        soffice,
        pdfinfo: join(work, "no-such-pdfinfo"),
        pptxPath: pptx,
      });
      expect(missing.code).not.toBe(0);
      expect(missing.stdout.includes("[FAIL]") || missing.stderr.includes("pdfinfo")).toBe(true);
      expect(missing.stdout).toMatch(/pdfinfo not found|pdfinfo failed|ENOENT/i);
      expect(missing.stdout).not.toMatch(/\[PASS]/);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test.skipIf(!posix)("converter child receives darwin default or an explicit override", async () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-render-check-env-"));
    try {
      const pptx = join(work, "deck.pptx");
      await writeSlidePptx(pptx, 1);
      const dumpDefault = join(work, "env-default.json");
      const dumpOverride = join(work, "env-override.json");
      const soffice = join(work, "fake-soffice");
      writeExec(
        soffice,
        `import { writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
const a = process.argv.slice(2);
if (a.includes('--version')) process.exit(0);
const dump = process.env.OPENPPT_ENV_DUMP;
if (dump) {
  writeFileSync(dump, JSON.stringify({
    sal: process.env.SAL_USE_VCLPLUGIN ?? null,
    sentinel: process.env.OPENPPT_ENV_SENTINEL ?? null,
  }));
}
writeFileSync(join(a[a.indexOf('--outdir') + 1], basename(a.at(-1), '.pptx') + '.pdf'), '%PDF-1.7\\n' + 'x'.repeat(2200));`,
      );
      const pdfinfo = join(work, "pdfinfo");
      writeExec(pdfinfo, 'console.log("Pages:          1");');

      const def = await runRenderCheck({
        soffice,
        pdfinfo,
        pptxPath: pptx,
        env: {
          OPENPPT_ENV_DUMP: dumpDefault,
          OPENPPT_ENV_SENTINEL: "keep-me",
        },
      });
      expect(def.code).toBe(0);
      const defaultEnv = JSON.parse(readFileSync(dumpDefault, "utf8"));
      expect(defaultEnv.sentinel).toBe("keep-me");
      if (process.platform === "darwin") {
        expect(defaultEnv.sal).toBe("osx");
      } else {
        expect(defaultEnv.sal).toBe(null);
      }

      const over = await runRenderCheck({
        soffice,
        pdfinfo,
        pptxPath: pptx,
        env: {
          OPENPPT_ENV_DUMP: dumpOverride,
          SAL_USE_VCLPLUGIN: "gen",
        },
      });
      expect(over.code).toBe(0);
      expect(JSON.parse(readFileSync(dumpOverride, "utf8")).sal).toBe("gen");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
