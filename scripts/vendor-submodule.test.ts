// @effect-diagnostics nodeBuiltinImport:off -- Reads the repo's own .gitmodules.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import config from "../vite.config.ts";

const repoRoot = NodePath.resolve(import.meta.dirname, "..");

describe("vendored submodules", () => {
  it("declares the Token Monitor fork at vendor/token-monitor", () => {
    const gitmodules = NodeFS.readFileSync(NodePath.join(repoRoot, ".gitmodules"), "utf8");
    expect(gitmodules).toContain('[submodule "vendor/token-monitor"]');
    expect(gitmodules).toContain("path = vendor/token-monitor");
    expect(gitmodules).toContain("url = https://github.com/Screddyice/token-monitor.git");
  });

  // A checked-out submodule brings its own lint and format setup and thousands of files.
  it("keeps Screddy's fmt and lint out of vendor/", () => {
    expect(config.fmt?.ignorePatterns).toContain("vendor/**");
    expect(config.lint?.ignorePatterns).toContain("vendor/**");
  });
});
