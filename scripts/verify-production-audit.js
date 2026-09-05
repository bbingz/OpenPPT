import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

const EXPECTED_FINDINGS = [
  {
    auditPackage: "image-size",
    finding: {
      id: 1138809,
      url: "https://github.com/advisories/GHSA-5p2g-fcmc-qvqq",
      title:
        "image-size: JXL and HEIF parsers allow denial of service through infinite loops",
      severity: "high",
      vulnerable_versions: "<=2.0.2",
      cwe: ["CWE-835"],
      cvss: {
        score: 7.5,
        vectorString: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H",
      },
    },
  },
  {
    auditPackage: "image-size",
    finding: {
      id: 1138808,
      url: "https://github.com/advisories/GHSA-w3rx-r6r6-pgpr",
      title:
        "image-size: ICNS parser allows denial of service through an infinite loop",
      severity: "high",
      vulnerable_versions: "<=2.0.2",
      cwe: ["CWE-835"],
      cvss: {
        score: 7.5,
        vectorString: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H",
      },
    },
  },
];

const EXPECTED_IMAGE_SIZE_LOCK = [
  "image-size@1.2.1",
  "",
  {
    dependencies: { queue: "6.0.2" },
    bin: { "image-size": "bin/image-size.js" },
  },
  "sha512-rH+46sQJ2dlwfjfhCyNx5thzrv+dtmBIhPHk0zgRUukHzZ/kRueTJXoYYsclBaKcSMBWuGbOFXtioLpzTb5euw==",
];
const EXPECTED_PPTXGENJS_LOCK = [
  "pptxgenjs@3.12.0",
  "",
  {
    dependencies: {
      "@types/node": "^18.7.3",
      https: "^1.0.0",
      "image-size": "^1.0.0",
      jszip: "^3.7.1",
    },
  },
  "sha512-ZozkYKWb1MoPR4ucw3/aFYlHkVIJxo9czikEclcUVnS4Iw/M+r+TEwdlB3fyAWO9JY1USxJDt0Y0/r15IR/RUA==",
];
const EXPECTED_ROOT_PACKAGE_SURFACE = {
  bin: { openppt: "bin/openppt.js" },
  exports: {
    ".": "./src/index.js",
    "./schema": "./schema/openppt-ir.schema.json",
  },
  files: [
    "bin/",
    "src/",
    "web/",
    "schema/",
    "fixtures/golden/deck.json",
    "fixtures/golden/media/accent.png",
    "themes/",
    "templates/README.md",
    "templates/pages/body.json",
    "templates/pages/cover.json",
    "templates/pages/final.json",
    "templates/pages/kpi-row.json",
    "templates/pages/narrative.json",
    "templates/pages/sequence.json",
    "templates/pages/three-card.json",
    "templates/pages/toc.json",
    "templates/pages/two-column.json",
    "templates/pitch-skeleton/deck.json",
    "skills/",
    "scripts/install-skill.sh",
    "README.md",
    "LICENSE",
    "NOTICE",
    "docs/IR.md",
    "docs/AGENT.md",
    "docs/BACKLOG.md",
    "CHANGELOG.md",
  ],
  scripts: {
    test: "bun test ./test/",
    "export:golden":
      "bun bin/openppt.js export fixtures/golden/deck.json -o fixtures/golden/out/deck.pptx --force",
    "export:chart":
      "bun bin/openppt.js export fixtures/chart-demo/deck.json -o fixtures/chart-demo/out/chart.pptx --force",
    "validate:golden":
      "bun bin/openppt.js validate fixtures/golden/deck.json",
    "export:pitch":
      "bun bin/openppt.js export templates/pitch-skeleton/deck.json -o templates/pitch-skeleton/out/pitch.pptx --force",
    "export:layout":
      "bun bin/openppt.js export fixtures/layout-demo/deck.json -o fixtures/layout-demo/out/layout.pptx --force",
    "export:table":
      "bun bin/openppt.js export fixtures/table-demo/deck.json -o fixtures/table-demo/out/table.pptx --force",
    "install:skill": "bash scripts/install-skill.sh",
    "preview:golden":
      "bun bin/openppt.js preview fixtures/golden/deck.json -o fixtures/golden/out/preview.html --force",
    serve: "bun bin/openppt.js serve",
    dogfood: "bun scripts/dogfood.js",
    "dogfood:random": "bun scripts/dogfood-random.js",
    "render:check": "bun scripts/render-check.js",
  },
  main: null,
  module: null,
  browser: null,
  imports: null,
};
const EXPECTED_DEPENDENCY_WHY = [
  "image-size@1.2.1",
  "pptxgenjs@3.12.0 (requires ^1.0.0)",
  "openppt (requires ^3.12.0)",
];
const DEPENDENCY_GROUPS = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
];

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function walkFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(path));
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      files.push(path);
    }
  }
  return files;
}

function isImageSizeReference(name, range) {
  return (
    name === "image-size" ||
    (typeof range === "string" && /^npm:image-size(?:@|$)/.test(range))
  );
}

function manifestImageSizeDeclarations(owner, manifest) {
  return DEPENDENCY_GROUPS.flatMap((group) =>
    Object.entries(manifest?.[group] ?? {})
      .filter(([name, range]) => isImageSizeReference(name, range))
      .map(([name, range]) => ({ owner, group, name, range })),
  );
}

export function collectLockImageSizeEdges(packages) {
  return Object.entries(packages ?? {})
    .flatMap(([owner, record]) =>
      manifestImageSizeDeclarations(owner, record?.[2]),
    )
    .sort((left, right) =>
      `${left.owner}\0${left.group}\0${left.name}`.localeCompare(
        `${right.owner}\0${right.group}\0${right.name}`,
      ),
    );
}

export function assertDependencyWhyOutput(output) {
  if (typeof output !== "string") {
    throw new Error("Unexpected bun pm why output");
  }
  const chain = output
    .split(/\r?\n/)
    .map((line) => line.replace(/^[\s│├└─]+/, "").trim())
    .filter(Boolean);
  if (!isDeepStrictEqual(chain, EXPECTED_DEPENDENCY_WHY)) {
    throw new Error(`The reviewed image-size dependency chain changed: ${chain.join(" -> ")}`);
  }
  return chain;
}

function filesContaining(directory, literal, root) {
  return pathsContaining(walkFiles(directory), literal, root);
}

function pathsContaining(paths, literal, root) {
  // Literal substring scan only. Concatenated or computed requires such as
  // require("image" + "-size") or require(dynamicName) are not detected.
  const canonicalRoot = realpathSync(root);
  return paths
    .filter((path) => readFileSync(path, "utf8").includes(literal))
    .map((path) =>
      relative(canonicalRoot, realpathSync(path)).replace(/\\/g, "/"),
    );
}

/**
 * Accept a clean audit or the exact, reviewed unreachable advisory set.
 * Every new package, advisory, or metadata change fails closed.
 * @param {Record<string, Array<object>>} report
 */
export function evaluateAuditReport(report) {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    throw new Error("Unexpected production audit findings: invalid JSON shape");
  }
  const packages = Object.keys(report);
  if (packages.length === 0) {
    return { mode: "clean", advisories: [] };
  }
  if (
    packages.length !== 1 ||
    packages[0] !== "image-size" ||
    !Array.isArray(report["image-size"]) ||
    report["image-size"].length > EXPECTED_FINDINGS.length
  ) {
    throw new Error("Unexpected production audit findings");
  }
  const findings = packages.flatMap((packageName) => {
    const packageFindings = report[packageName];
    if (!Array.isArray(packageFindings)) {
      throw new Error("Unexpected production audit findings: invalid package entry");
    }
    return packageFindings.map((finding) => ({
      auditPackage: packageName,
      finding,
    }));
  });
  findings.sort((left, right) =>
    `${left.auditPackage}\0${left.finding.url}`.localeCompare(
      `${right.auditPackage}\0${right.finding.url}`,
    ),
  );
  if (!isDeepStrictEqual(findings, EXPECTED_FINDINGS)) {
    throw new Error(
      "The reviewed production advisory set changed or its metadata changed",
    );
  }
  return {
    mode: "accepted-unreachable",
    advisories: EXPECTED_FINDINGS.map((finding) =>
      finding.finding.url.split("/").pop(),
    ),
  };
}

/**
 * Collect the installed dependency and executable-code assumptions that make
 * the two reviewed parser advisories unreachable in OpenPPT.
 * @param {string} root
 */
export function collectReachabilityEvidence(root) {
  const rootPackage = readJson(join(root, "package.json"));
  const requireFromRoot = createRequire(join(root, "package.json"));
  const pptxgenjsPackagePath = requireFromRoot.resolve("pptxgenjs/package.json");
  const pptxgenjsPackageRoot = dirname(pptxgenjsPackagePath);
  const requireFromPptxgenjs = createRequire(pptxgenjsPackagePath);
  const imageSizePackagePath = requireFromPptxgenjs.resolve(
    "image-size/package.json",
  );
  const pptxgenjsPackage = readJson(pptxgenjsPackagePath);
  const imageSizePackage = readJson(imageSizePackagePath);
  const lock = Bun.JSONC.parse(readFileSync(join(root, "bun.lock"), "utf8"));
  const executableDirectories = [join(root, "src"), join(root, "bin")];
  const imageSizePackages = Object.entries(lock.packages ?? {})
    .filter(([, record]) =>
      typeof record?.[0] === "string"
        ? record[0].startsWith("image-size@")
        : false,
    )
    .map(([name, record]) => ({ name, identity: record[0] }))
    .sort((left, right) =>
      `${left.name}\0${left.identity}`.localeCompare(
        `${right.name}\0${right.identity}`,
      ),
    );

  return {
    rootPackageSurface: {
      bin: rootPackage.bin ?? null,
      exports: rootPackage.exports ?? null,
      files: rootPackage.files ?? null,
      scripts: rootPackage.scripts ?? null,
      main: rootPackage.main ?? null,
      module: rootPackage.module ?? null,
      browser: rootPackage.browser ?? null,
      imports: rootPackage.imports ?? null,
    },
    rootImageSizeDeclarations: manifestImageSizeDeclarations(
      "openppt",
      rootPackage,
    ),
    rootPptxgenjsRange: rootPackage.dependencies?.pptxgenjs ?? null,
    rootImageSizeRange: rootPackage.dependencies?.["image-size"] ?? null,
    pptxgenjsVersion: pptxgenjsPackage.version,
    pptxgenjsImageSizeRange:
      pptxgenjsPackage.dependencies?.["image-size"] ?? null,
    imageSizeName: imageSizePackage.name,
    imageSizeVersion: imageSizePackage.version,
    pptxgenjsEntry: relative(
      pptxgenjsPackageRoot,
      requireFromRoot.resolve("pptxgenjs"),
    ).replace(/\\/g, "/"),
    lockfileVersion: lock.lockfileVersion,
    lockRootPptxgenjsRange:
      lock.workspaces?.[""]?.dependencies?.pptxgenjs ?? null,
    lockRootImageSizeRange:
      lock.workspaces?.[""]?.dependencies?.["image-size"] ?? null,
    lockImageSizeRecord: lock.packages?.["image-size"] ?? null,
    lockPptxgenjsRecord: lock.packages?.pptxgenjs ?? null,
    lockImageSizeEdges: collectLockImageSizeEdges(lock.packages),
    lockImageSizePackages: imageSizePackages,
    lockRootImageSizeDeclarations: manifestImageSizeDeclarations(
      "openppt",
      lock.workspaces?.[""],
    ),
    runtimeReferences: filesContaining(
      join(pptxgenjsPackageRoot, "dist"),
      "image-size",
      root,
    ),
    applicationReferences: [
      ...executableDirectories.flatMap((directory) =>
        filesContaining(directory, "image-size", root),
      ),
      ...pathsContaining(
        [join(root, "scripts/install-skill.sh")],
        "image-size",
        root,
      ),
    ].sort(),
  };
}

/** @param {ReturnType<typeof collectReachabilityEvidence>} evidence */
export function assertReachabilityEvidence(evidence) {
  if (!isDeepStrictEqual(evidence.rootPackageSurface, EXPECTED_ROOT_PACKAGE_SURFACE)) {
    throw new Error("OpenPPT runtime entrypoint or package surface changed");
  }
  if (evidence.rootPptxgenjsRange !== "^3.12.0") {
    throw new Error("OpenPPT PptxGenJS dependency range changed");
  }
  if (
    evidence.rootImageSizeRange !== null ||
    !isDeepStrictEqual(evidence.rootImageSizeDeclarations, [])
  ) {
    throw new Error("OpenPPT gained a direct image-size dependency");
  }
  if (evidence.pptxgenjsVersion !== "3.12.0") {
    throw new Error("PptxGenJS version changed; reachability must be re-reviewed");
  }
  if (evidence.pptxgenjsImageSizeRange !== "^1.0.0") {
    throw new Error("PptxGenJS image-size dependency range changed");
  }
  if (evidence.pptxgenjsEntry !== "dist/pptxgen.cjs.js") {
    throw new Error("PptxGenJS runtime entry changed; reachability must be re-reviewed");
  }
  if (
    evidence.imageSizeName !== "image-size" ||
    evidence.imageSizeVersion !== "1.2.1"
  ) {
    throw new Error("Installed image-size identity changed");
  }
  if (
    evidence.lockfileVersion !== 2 ||
    evidence.lockRootPptxgenjsRange !== "^3.12.0" ||
    evidence.lockRootImageSizeRange !== null ||
    !isDeepStrictEqual(
      evidence.lockImageSizeRecord,
      EXPECTED_IMAGE_SIZE_LOCK,
    ) ||
    !isDeepStrictEqual(
      evidence.lockPptxgenjsRecord,
      EXPECTED_PPTXGENJS_LOCK,
    ) ||
    !isDeepStrictEqual(evidence.lockRootImageSizeDeclarations, []) ||
    !isDeepStrictEqual(evidence.lockImageSizeEdges, [
      {
        owner: "pptxgenjs",
        group: "dependencies",
        name: "image-size",
        range: "^1.0.0",
      },
    ]) ||
    !isDeepStrictEqual(evidence.lockImageSizePackages, [
      { name: "image-size", identity: "image-size@1.2.1" },
    ])
  ) {
    throw new Error("The reviewed image-size dependency path changed");
  }
  if (evidence.runtimeReferences.length > 0) {
    throw new Error(
      `An image-size runtime reference became reachable: ${evidence.runtimeReferences.join(", ")}`,
    );
  }
  if (evidence.applicationReferences.length > 0) {
    throw new Error(
      `OpenPPT executable code now references image-size: ${evidence.applicationReferences.join(", ")}`,
    );
  }
}

async function probeRuntimeReachability(root) {
  const { compileToBuffer, loadDeck } = await import("../src/index.js");
  for (const fixture of [
    "fixtures/golden/deck.json",
    "fixtures/chart-demo/deck.json",
  ]) {
    const { deck, projectRoot } = loadDeck(join(root, fixture));
    const bytes = await compileToBuffer(deck, { projectRoot });
    if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
      throw new Error(
        `Runtime reachability probe did not produce a PPTX ZIP for ${fixture}`,
      );
    }
  }

  const requireFromRoot = createRequire(join(root, "package.json"));
  const pptxgenjsPackagePath = requireFromRoot.resolve("pptxgenjs/package.json");
  const pptxgenjsEntry = realpathSync(requireFromRoot.resolve("pptxgenjs"));
  const imageSizePackageRoot = realpathSync(
    dirname(
      createRequire(pptxgenjsPackagePath).resolve("image-size/package.json"),
    ),
  );
  const loadedModules = Object.keys(requireFromRoot.cache)
    .filter((path) => isAbsolute(path))
    .map((path) => realpathSync(path));
  if (!loadedModules.includes(pptxgenjsEntry)) {
    throw new Error("Runtime reachability probe did not observe PptxGenJS loading");
  }
  const imageSizePrefix = `${imageSizePackageRoot}${sep}`;
  const loadedImageSizeModules = loadedModules.filter(
    (path) => path.startsWith(imageSizePrefix),
  );
  if (loadedImageSizeModules.length > 0) {
    throw new Error(
      `OpenPPT loaded image-size during export: ${loadedImageSizeModules.join(", ")}`,
    );
  }
}

function assertRuntimeUnreachable(root) {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(import.meta.url), "--runtime-probe"],
    { cwd: root, encoding: "utf8" },
  );
  if (result.error) throw result.error;
  if (result.signal || result.status !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(
      `Runtime reachability probe failed (${result.signal ?? result.status}): ${detail}`,
    );
  }
}

function assertDependencyChain(root) {
  const result = spawnSync(process.execPath, ["pm", "why", "image-size"], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.signal || result.status !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(
      `Dependency-chain probe failed (${result.signal ?? result.status}): ${detail}`,
    );
  }
  assertDependencyWhyOutput(result.stdout);
}

export function verifyProductionAudit(root) {
  const result = spawnSync(
    process.execPath,
    ["audit", "--prod", "--audit-level=low", "--json"],
    { cwd: root, encoding: "utf8" },
  );
  if (result.error) throw result.error;
  if (result.signal) {
    throw new Error(`Production audit terminated by ${result.signal}`);
  }
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    throw new Error(
      `Production audit returned invalid JSON (exit ${result.status}): ${result.stderr.trim()}`,
    );
  }
  const decision = evaluateAuditReport(report);
  if (decision.mode === "clean") {
    if (result.status !== 0) {
      throw new Error(
        `Production audit failed with no parsed findings (exit ${result.status})`,
      );
    }
    assertReachabilityEvidence(collectReachabilityEvidence(root));
    assertDependencyChain(root);
    assertRuntimeUnreachable(root);
    return decision;
  }
  if (result.status !== 1) {
    throw new Error(`Production audit failed unexpectedly (exit ${result.status})`);
  }
  assertReachabilityEvidence(collectReachabilityEvidence(root));
  assertDependencyChain(root);
  assertRuntimeUnreachable(root);
  return decision;
}

if (import.meta.main) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  try {
    if (process.argv[2] === "--runtime-probe") {
      await probeRuntimeReachability(root);
    } else {
      const decision = verifyProductionAudit(root);
      if (decision.mode === "clean") {
        console.log("Production dependency audit is clean.");
      } else {
        console.log(
          `Production dependency audit accepted reviewed runtime-unreachable advisories: ${decision.advisories.join(", ")}`,
        );
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
