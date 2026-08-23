import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertDependencyWhyOutput,
  assertReachabilityEvidence,
  collectLockImageSizeEdges,
  collectReachabilityEvidence,
  evaluateAuditReport,
} from "../scripts/verify-production-audit.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function knownAuditReport() {
  return {
    "image-size": [
      {
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
      {
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
    ],
  };
}

describe("production dependency audit gate", () => {
  it("accepts only the exact known unreachable advisory set", () => {
    const decision = evaluateAuditReport(knownAuditReport());
    assert.equal(decision.mode, "accepted-unreachable");
    assert.deepEqual(decision.advisories, [
      "GHSA-5p2g-fcmc-qvqq",
      "GHSA-w3rx-r6r6-pgpr",
    ]);

    const evidence = collectReachabilityEvidence(root);
    assert.doesNotThrow(() => assertReachabilityEvidence(evidence));
    assert.equal(evidence.pptxgenjsVersion, "3.12.0");
    assert.equal(evidence.imageSizeVersion, "1.2.1");
  });

  it("passes a genuinely clean audit without an exception", () => {
    assert.deepEqual(evaluateAuditReport({}), {
      mode: "clean",
      advisories: [],
    });
  });

  it("requires the unique reviewed dependency chain", () => {
    const why = [
      "image-size@1.2.1",
      "  └─ pptxgenjs@3.12.0 (requires ^1.0.0)",
      "     └─ openppt (requires ^3.12.0)",
    ].join("\n");
    assert.deepEqual(assertDependencyWhyOutput(why), [
      "image-size@1.2.1",
      "pptxgenjs@3.12.0 (requires ^1.0.0)",
      "openppt (requires ^3.12.0)",
    ]);
    assert.throws(
      () => assertDependencyWhyOutput(`${why}\n  └─ optional-wrapper@1.0.0`),
      /dependency chain changed/,
    );
    assert.deepEqual(
      collectLockImageSizeEdges({
        alias: [
          "alias@1.0.0",
          "",
          { peerDependencies: { img: "npm:image-size@1.2.1" } },
        ],
        wrapper: [
          "wrapper@1.0.0",
          "",
          { optionalDependencies: { "image-size": "^1.2.1" } },
        ],
      }),
      [
        {
          owner: "alias",
          group: "peerDependencies",
          name: "img",
          range: "npm:image-size@1.2.1",
        },
        {
          owner: "wrapper",
          group: "optionalDependencies",
          name: "image-size",
          range: "^1.2.1",
        },
      ],
    );
  });

  it("rejects every new package or advisory", () => {
    const report = knownAuditReport();
    report.yaml = [
      {
        url: "https://github.com/advisories/GHSA-new-finding",
        severity: "high",
        vulnerable_versions: "<99.0.0",
      },
    ];
    assert.throws(
      () => evaluateAuditReport(report),
      /Unexpected production audit findings/,
    );

    const extraImageSize = knownAuditReport();
    extraImageSize["image-size"].push({
      url: "https://github.com/advisories/GHSA-new-image-size",
      severity: "high",
      vulnerable_versions: "<=2.0.2",
    });
    assert.throws(
      () => evaluateAuditReport(extraImageSize),
      /Unexpected production audit findings/,
    );
  });

  it("rejects partial or changed advisory metadata", () => {
    const partial = knownAuditReport();
    partial["image-size"].pop();
    assert.throws(() => evaluateAuditReport(partial), /advisory set changed/);

    const changed = knownAuditReport();
    changed["image-size"][0].title = "Changed upstream metadata";
    assert.throws(() => evaluateAuditReport(changed), /metadata changed/);

    const added = knownAuditReport();
    added["image-size"][0].package = "image-size";
    assert.throws(() => evaluateAuditReport(added), /metadata changed/);
  });

  it("fails closed when a reachability assumption drifts", () => {
    const evidence = collectReachabilityEvidence(root);
    assert.throws(
      () =>
        assertReachabilityEvidence({
          ...evidence,
          pptxgenjsVersion: "4.0.1",
        }),
      /PptxGenJS version changed/,
    );
    assert.throws(
      () =>
        assertReachabilityEvidence({
          ...evidence,
          runtimeReferences: ["dist/pptxgen.cjs.js"],
        }),
      /runtime reference became reachable/,
    );
    assert.throws(
      () =>
        assertReachabilityEvidence({
          ...evidence,
          lockImageSizeEdges: [
            ...evidence.lockImageSizeEdges,
            {
              owner: "new-package",
              group: "optionalDependencies",
              name: "image-size",
              range: "^1.2.1",
            },
          ],
        }),
      /dependency path changed/,
    );
    assert.throws(
      () =>
        assertReachabilityEvidence({
          ...evidence,
          rootPackageSurface: {
            ...evidence.rootPackageSurface,
            exports: {
              ...evidence.rootPackageSurface.exports,
              "./extra": "./runtime/extra.ts",
            },
          },
        }),
      /package surface changed/,
    );
  });

  it("detects real image-size imports in dependency and application code", () => {
    const fixture = mkdtempSync(join(tmpdir(), "openppt-audit-gate-"));
    try {
      mkdirSync(join(fixture, "node_modules/pptxgenjs/dist"), {
        recursive: true,
      });
      mkdirSync(join(fixture, "node_modules/image-size"), { recursive: true });
      mkdirSync(join(fixture, "src"));
      mkdirSync(join(fixture, "bin"));
      mkdirSync(join(fixture, "scripts"));
      copyFileSync(join(root, "package.json"), join(fixture, "package.json"));
      copyFileSync(join(root, "bun.lock"), join(fixture, "bun.lock"));
      copyFileSync(
        join(root, "node_modules/pptxgenjs/package.json"),
        join(fixture, "node_modules/pptxgenjs/package.json"),
      );
      copyFileSync(
        join(root, "node_modules/image-size/package.json"),
        join(fixture, "node_modules/image-size/package.json"),
      );
      writeFileSync(
        join(fixture, "node_modules/pptxgenjs/dist/pptxgen.cjs.js"),
        'require("image-size");\n',
      );
      writeFileSync(
        join(fixture, "src/reachable.mts"),
        'import "image-size";\n',
      );
      writeFileSync(
        join(fixture, "scripts/install-skill.sh"),
        "bun image-size media/input.icns\n",
      );

      const evidence = collectReachabilityEvidence(fixture);
      assert.deepEqual(evidence.runtimeReferences, [
        "node_modules/pptxgenjs/dist/pptxgen.cjs.js",
      ]);
      assert.deepEqual(evidence.applicationReferences, [
        "scripts/install-skill.sh",
        "src/reachable.mts",
      ]);
      assert.throws(
        () => assertReachabilityEvidence(evidence),
        /runtime reference became reachable/,
      );
      assert.throws(
        () =>
          assertReachabilityEvidence({ ...evidence, runtimeReferences: [] }),
        /executable code now references image-size/,
      );
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
