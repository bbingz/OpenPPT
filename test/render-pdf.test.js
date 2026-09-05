import { describe, test, expect } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  convertPptxToPdf,
  convertPptxToPdfAsync,
} from "../src/render-pdf.js";
import { ErrorCodes, OpenPptError } from "../src/errors.js";
import { libreOfficeChildEnv } from "../src/internal/libreoffice-env.js";

const posix = process.platform !== "win32";

function dummyPptx(dir, name = "deck.pptx") {
  const path = join(dir, name);
  writeFileSync(path, "PK\x03\x04dummy");
  return path;
}

function fakeSoffice(dir, body) {
  const path = join(dir, "fake-soffice");
  writeFileSync(
    path,
    `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nimport { join, basename } from 'node:path';\nconst args = process.argv.slice(2);\nif (args.includes('--version')) { console.log('Fake LibreOffice'); process.exit(0); }\n${body}\n`,
  );
  chmodSync(path, 0o755);
  return path;
}

describe("async PDF conversion", () => {
  test.skipIf(!posix)("findSofficeAsync shares one --version probe across concurrent callers", async () => {
    const work = mkdtempSync(join(tmpdir(), "openppt-discovery-"));
    const probes = join(work, "probes");
    try {
      const fake = join(work, "soffice");
      writeFileSync(
        fake,
        `#!${process.execPath}
import { appendFileSync } from 'node:fs';
if (process.argv.includes('--version')) {
  appendFileSync(${JSON.stringify(probes)}, 'v');
  await Bun.sleep(400);
  console.log('LibreOffice fake');
  process.exit(0);
}
process.exit(1);
`,
      );
      chmodSync(fake, 0o755);
      const caller = join(work, "caller.js");
      writeFileSync(
        caller,
        `import { findSofficeAsync } from ${JSON.stringify(join(import.meta.dir, "../src/render-pdf.js"))};
const found = await Promise.all([1, 2, 3, 4].map(() => findSofficeAsync()));
console.log(JSON.stringify({ found: found[0], n: found.length }));
`,
      );
      const env = { ...process.env, PATH: `${work}:${process.env.PATH}` };
      delete env.SOFFICE;
      const child = Bun.spawn([process.execPath, caller], {
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stdout] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
      ]);
      expect(code).toBe(0);
      const body = JSON.parse(stdout.split("\n")[0]);
      expect(body.n).toBe(4);
      expect(body.found).toBe("soffice");
      expect(readFileSync(probes, "utf8")).toBe("v");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test.skipIf(!posix)("sync convertPptxToPdf writes a PDF via fake soffice", () => {
    const dir = mkdtempSync(join(tmpdir(), "openppt-pdf-sync-"));
    try {
      const soffice = fakeSoffice(
        dir,
        `const outdir = args[args.indexOf('--outdir') + 1];
writeFileSync(join(outdir, basename(args.at(-1), '.pptx') + '.pdf'), '%PDF-1.4\\nsync\\n');`,
      );
      const src = dummyPptx(dir);
      const out = join(dir, "out.pdf");
      const result = convertPptxToPdf(src, out, { soffice });
      expect(typeof result).toBe("string");
      expect(result).toBe(out);
      expect(readFileSync(out, "utf8")).toContain("%PDF-1.4");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("success/nonzero/timeout/no-output remove the captured work dir", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openppt-pdf-work-"));
    const src = dummyPptx(dir);
    try {
      const cases = [
        {
          name: "success",
          run: async ({ work }) => {
            writeFileSync(join(work, "deck.pdf"), "%PDF-1.4\nok\n");
            return { status: 0 };
          },
          wantThrow: false,
        },
        {
          name: "nonzero",
          run: async () => ({ status: 1 }),
          wantThrow: true,
        },
        {
          name: "timeout",
          run: async () => ({ status: 1, timedOut: true }),
          wantThrow: true,
        },
        {
          name: "nooutput",
          run: async () => ({ status: 0 }),
          wantThrow: true,
        },
      ];
      for (const item of cases) {
        const out = join(dir, `${item.name}.pdf`);
        let workPath = null;
        const job = convertPptxToPdfAsync(src, out, {
          soffice: "injected",
          runConverter: async (spec) => {
            workPath = spec.work;
            expect(existsSync(workPath)).toBe(true);
            return item.run(spec);
          },
        });
        if (item.wantThrow) {
          await expect(job).rejects.toBeInstanceOf(OpenPptError);
          expect(existsSync(out)).toBe(false);
        } else {
          expect(await job).toBe(out);
          expect(readFileSync(out, "utf8")).toContain("%PDF-1.4");
        }
        expect(workPath).toBeTruthy();
        expect(existsSync(workPath)).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no-clobber when output appears during async conversion", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openppt-pdf-race-"));
    try {
      const src = dummyPptx(dir);
      const out = join(dir, "out.pdf");
      await expect(
        convertPptxToPdfAsync(src, out, {
          soffice: "injected",
          runConverter: async ({ work }) => {
            writeFileSync(out, "SNEAK");
            writeFileSync(join(work, "deck.pdf"), "%PDF-1.4\nnew\n");
            return { status: 0 };
          },
        }),
      ).rejects.toMatchObject({
        code: ErrorCodes.EXPORT,
        message: expect.stringMatching(/already exists/i),
      });
      expect(readFileSync(out, "utf8")).toBe("SNEAK");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refuses to clobber an existing PDF without force, allows force", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openppt-pdf-clobber-"));
    try {
      const src = dummyPptx(dir);
      const out = join(dir, "out.pdf");
      writeFileSync(out, "KEEP");
      await expect(
        convertPptxToPdfAsync(src, out, {
          soffice: "injected",
          runConverter: async ({ work }) => {
            writeFileSync(join(work, "deck.pdf"), "%PDF-1.4\nnew\n");
            return { status: 0 };
          },
        }),
      ).rejects.toMatchObject({
        code: ErrorCodes.EXPORT,
        message: expect.stringMatching(/already exists/i),
      });
      expect(readFileSync(out, "utf8")).toBe("KEEP");
      const rewritten = await convertPptxToPdfAsync(src, out, {
        soffice: "injected",
        force: true,
        runConverter: async ({ work }) => {
          writeFileSync(join(work, "deck.pdf"), "%PDF-1.4\nforced\n");
          return { status: 0 };
        },
      });
      expect(rewritten).toBe(out);
      expect(readFileSync(out, "utf8")).toContain("forced");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.skipIf(!posix)("POSIX: SIGKILL terminates a converter that ignores SIGTERM", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openppt-pdf-stubborn-"));
    const marker = join(dir, "owned-process.json");
    try {
      const soffice = fakeSoffice(
        dir,
        `process.on('SIGTERM', () => {});
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid, conversionWork: args[args.indexOf('--outdir') + 1] }));
await Bun.sleep(10000);`,
      );
      const src = dummyPptx(dir);
      const out = join(dir, "out.pdf");
      const started = performance.now();
      const converting = convertPptxToPdfAsync(src, out, { soffice, timeoutMs: 500 });
      const readyDeadline = Date.now() + 2000;
      while (!existsSync(marker) && Date.now() < readyDeadline) await Bun.sleep(20);
      expect(existsSync(marker)).toBe(true);
      let failure = null;
      try {
        await converting;
      } catch (err) {
        failure = err;
      }
      const elapsedMs = performance.now() - started;
      expect(failure).toBeInstanceOf(OpenPptError);
      expect(String(failure.message)).toMatch(/timed out/i);
      expect(elapsedMs).toBeLessThan(1100);
      expect(existsSync(out)).toBe(false);
      const owned = JSON.parse(readFileSync(marker, "utf8"));
      expect(existsSync(owned.conversionWork)).toBe(false);
      try {
        process.kill(owned.pid, 0);
        throw new Error("stubborn child still running");
      } catch (err) {
        expect(err.code).toBe("ESRCH");
      }
    } finally {
      if (existsSync(marker)) {
        try {
          process.kill(JSON.parse(readFileSync(marker, "utf8")).pid, "SIGKILL");
        } catch {
          /* already dead */
        }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

async function withSalEnv(value, fn) {
  const had = Object.hasOwn(process.env, "SAL_USE_VCLPLUGIN");
  const previous = process.env.SAL_USE_VCLPLUGIN;
  if (value === undefined) delete process.env.SAL_USE_VCLPLUGIN;
  else process.env.SAL_USE_VCLPLUGIN = value;
  try {
    return await fn();
  } finally {
    if (had) process.env.SAL_USE_VCLPLUGIN = previous;
    else delete process.env.SAL_USE_VCLPLUGIN;
  }
}

describe("LibreOffice conversion child env", () => {
  test("defaults SAL_USE_VCLPLUGIN to osx on darwin only, without mutating the base", () => {
    const darwinBase = Object.freeze({ PATH: "/bin", HOME: "/tmp" });
    const darwinEnv = libreOfficeChildEnv(darwinBase, "darwin");
    expect(darwinEnv).not.toBe(darwinBase);
    expect(darwinEnv.SAL_USE_VCLPLUGIN).toBe("osx");
    expect(darwinEnv.PATH).toBe("/bin");
    expect(darwinEnv.HOME).toBe("/tmp");
    expect(Object.hasOwn(darwinBase, "SAL_USE_VCLPLUGIN")).toBe(false);

    const linuxEnv = libreOfficeChildEnv({ PATH: "/bin" }, "linux");
    expect(Object.hasOwn(linuxEnv, "SAL_USE_VCLPLUGIN")).toBe(false);

    const winEnv = libreOfficeChildEnv({ PATH: "C:\\Windows" }, "win32");
    expect(Object.hasOwn(winEnv, "SAL_USE_VCLPLUGIN")).toBe(false);
  });

  test("preserves an explicit SAL_USE_VCLPLUGIN value including empty string", () => {
    expect(
      libreOfficeChildEnv({ SAL_USE_VCLPLUGIN: "gtk3" }, "darwin").SAL_USE_VCLPLUGIN,
    ).toBe("gtk3");
    expect(
      libreOfficeChildEnv({ SAL_USE_VCLPLUGIN: "" }, "darwin").SAL_USE_VCLPLUGIN,
    ).toBe("");
    expect(
      libreOfficeChildEnv({ SAL_USE_VCLPLUGIN: "osx" }, "linux").SAL_USE_VCLPLUGIN,
    ).toBe("osx");
  });

  test("does not mutate process.env when computing a darwin default", async () => {
    await withSalEnv(undefined, () => {
      const pathBefore = process.env.PATH;
      const child = libreOfficeChildEnv(process.env, "darwin");
      expect(child).not.toBe(process.env);
      expect(child.SAL_USE_VCLPLUGIN).toBe("osx");
      expect(Object.hasOwn(process.env, "SAL_USE_VCLPLUGIN")).toBe(false);
      expect(process.env.PATH).toBe(pathBefore);
    });
  });

  test.skipIf(!posix)("sync converter child receives darwin default and unrelated env", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openppt-pdf-env-sync-"));
    try {
      const dump = join(dir, "child-env.json");
      const soffice = fakeSoffice(
        dir,
        `writeFileSync(${JSON.stringify(dump)}, JSON.stringify({
  sal: process.env.SAL_USE_VCLPLUGIN ?? null,
  sentinel: process.env.OPENPPT_ENV_SENTINEL ?? null,
}));
const outdir = args[args.indexOf('--outdir') + 1];
writeFileSync(join(outdir, basename(args.at(-1), '.pptx') + '.pdf'), '%PDF-1.4\\nenv\\n');`,
      );
      const src = dummyPptx(dir);
      const out = join(dir, "out.pdf");
      const hadSentinel = Object.hasOwn(process.env, "OPENPPT_ENV_SENTINEL");
      const prevSentinel = process.env.OPENPPT_ENV_SENTINEL;
      process.env.OPENPPT_ENV_SENTINEL = "keep-me";
      try {
        await withSalEnv(undefined, () => {
          convertPptxToPdf(src, out, { soffice });
          expect(Object.hasOwn(process.env, "SAL_USE_VCLPLUGIN")).toBe(false);
        });
      } finally {
        if (hadSentinel) process.env.OPENPPT_ENV_SENTINEL = prevSentinel;
        else delete process.env.OPENPPT_ENV_SENTINEL;
      }
      const observed = JSON.parse(readFileSync(dump, "utf8"));
      expect(observed.sentinel).toBe("keep-me");
      if (process.platform === "darwin") {
        expect(observed.sal).toBe("osx");
      } else {
        expect(observed.sal).toBe(null);
      }
      expect(readFileSync(out, "utf8")).toContain("%PDF-1.4");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.skipIf(!posix)("async converter child honors explicit override and skips global mutation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openppt-pdf-env-async-"));
    try {
      const dump = join(dir, "child-env.json");
      const soffice = fakeSoffice(
        dir,
        `writeFileSync(${JSON.stringify(dump)}, JSON.stringify({
  sal: process.env.SAL_USE_VCLPLUGIN ?? null,
}));
const outdir = args[args.indexOf('--outdir') + 1];
writeFileSync(join(outdir, basename(args.at(-1), '.pptx') + '.pdf'), '%PDF-1.4\\nenv\\n');`,
      );
      const src = dummyPptx(dir);
      const out = join(dir, "out.pdf");
      await withSalEnv("gen", async () => {
        await convertPptxToPdfAsync(src, out, { soffice });
        expect(process.env.SAL_USE_VCLPLUGIN).toBe("gen");
      });
      const observed = JSON.parse(readFileSync(dump, "utf8"));
      expect(observed.sal).toBe("gen");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("runConverter observes computed child env without process.env mutation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openppt-pdf-env-inject-"));
    try {
      const src = dummyPptx(dir);
      const out = join(dir, "out.pdf");
      let received = null;
      await withSalEnv(undefined, async () => {
        await convertPptxToPdfAsync(src, out, {
          soffice: "injected",
          runConverter: async (spec) => {
            received = spec.env;
            writeFileSync(join(spec.work, "deck.pdf"), "%PDF-1.4\ninject\n");
            return { status: 0 };
          },
        });
        expect(Object.hasOwn(process.env, "SAL_USE_VCLPLUGIN")).toBe(false);
      });
      expect(received).toBeTruthy();
      expect(received).not.toBe(process.env);
      if (process.platform === "darwin") {
        expect(received.SAL_USE_VCLPLUGIN).toBe("osx");
      } else {
        expect(Object.hasOwn(received, "SAL_USE_VCLPLUGIN")).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
