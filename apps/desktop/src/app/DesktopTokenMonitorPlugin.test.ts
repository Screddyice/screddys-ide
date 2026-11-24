// @effect-diagnostics nodeBuiltinImport:off -- Hashes the shipped plug-in files to guard its version.
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as DesktopTokenMonitorPlugin from "./DesktopTokenMonitorPlugin.ts";

// The real plug-in the app ships, not a hand-made copy.
const bundleDir = (path: Path.Path) =>
  path.resolve(import.meta.dirname, "../../../../integrations/token-monitor-speedometer");

const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tokenMonitorDir = yield* fs.makeTempDirectoryScoped();
  const bundle = bundleDir(path);
  const manifest = JSON.parse(yield* fs.readFileString(path.join(bundle, "manifest.json"))) as {
    id: string;
    version: string;
    files: string[];
  };
  const target = path.join(tokenMonitorDir, "plugins", manifest.id);
  const sync = DesktopTokenMonitorPlugin.syncPlugin({ bundleDir: bundle, tokenMonitorDir });
  const sameAsBundle = Effect.gen(function* () {
    for (const name of ["manifest.json", ...manifest.files]) {
      const shipped = yield* fs.readFile(path.join(bundle, name));
      const installed = yield* fs.readFile(path.join(target, name));
      if (Buffer.compare(Buffer.from(shipped), Buffer.from(installed)) !== 0) return false;
    }
    return true;
  });
  return { fs, path, tokenMonitorDir, manifest, target, sync, sameAsBundle };
});

it.layer(NodeServices.layer)("DesktopTokenMonitorPlugin", (it) => {
  it.effect("installs the speedometer into Token Monitor's plug-in folder", () =>
    Effect.gen(function* () {
      const { sync, sameAsBundle, manifest } = yield* setup;
      expect(yield* sync).toEqual({ status: "installed", version: manifest.version });
      expect(yield* sameAsBundle).toBe(true);
      expect(yield* sync).toEqual({ status: "unchanged", version: manifest.version });
    }).pipe(Effect.scoped),
  );

  it.effect("replaces an older copy, keeping nothing from it", () =>
    Effect.gen(function* () {
      const { fs, path, target, sync, sameAsBundle, manifest } = yield* setup;
      yield* fs.makeDirectory(target, { recursive: true });
      yield* fs.writeFileString(
        path.join(target, "manifest.json"),
        JSON.stringify({ ...manifest, version: "0.0.1" }),
      );
      yield* fs.writeFileString(path.join(target, "speedometer.css"), "/* old */");
      yield* fs.writeFileString(path.join(target, "leftover.js"), "old");

      expect(yield* sync).toEqual({ status: "updated", version: manifest.version });
      expect(yield* sameAsBundle).toBe(true);
      expect(yield* fs.exists(path.join(target, "leftover.js"))).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("repairs a copy whose files were changed at the same version", () =>
    Effect.gen(function* () {
      const { fs, path, target, sync, sameAsBundle, manifest } = yield* setup;
      yield* sync;
      yield* fs.writeFileString(path.join(target, "speedometer.css"), "/* edited */");
      expect(yield* sync).toEqual({ status: "updated", version: manifest.version });
      expect(yield* sameAsBundle).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("does nothing when Token Monitor is not installed", () =>
    Effect.gen(function* () {
      const { fs, path, tokenMonitorDir } = yield* setup;
      const missing = path.join(tokenMonitorDir, "not-here");
      const result = yield* DesktopTokenMonitorPlugin.syncPlugin({
        bundleDir: bundleDir(path),
        tokenMonitorDir: missing,
      });
      expect(result).toEqual({ status: "skipped", reason: "token-monitor-not-installed" });
      expect(yield* fs.exists(missing)).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("leaves a copy Token Monitor installed from a package alone", () =>
    Effect.gen(function* () {
      const { fs, path, tokenMonitorDir, target, sync, manifest } = yield* setup;
      yield* fs.makeDirectory(path.join(tokenMonitorDir, "plugin-manager"), { recursive: true });
      yield* fs.writeFileString(
        path.join(tokenMonitorDir, "plugin-manager", "installed.json"),
        JSON.stringify({ [manifest.id]: { version: "1.0.0" } }),
      );
      yield* fs.makeDirectory(target, { recursive: true });
      yield* fs.writeFileString(path.join(target, "manifest.json"), "{}");

      expect(yield* sync).toEqual({ status: "skipped", reason: "package-managed" });
      expect(yield* fs.readFileString(path.join(target, "manifest.json"))).toBe("{}");
    }).pipe(Effect.scoped),
  );

  it.effect("writes nothing when Token Monitor's package list cannot be read", () =>
    Effect.gen(function* () {
      const { fs, path, tokenMonitorDir, target, sync } = yield* setup;
      yield* fs.makeDirectory(path.join(tokenMonitorDir, "plugin-manager"), { recursive: true });
      yield* fs.writeFileString(
        path.join(tokenMonitorDir, "plugin-manager", "installed.json"),
        "not json",
      );

      expect(yield* sync).toEqual({ status: "skipped", reason: "registry-unreadable" });
      expect(yield* fs.exists(target)).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("waits while Token Monitor is in the middle of changing plug-ins", () =>
    Effect.gen(function* () {
      const { fs, path, tokenMonitorDir, target, sync } = yield* setup;
      yield* fs.makeDirectory(path.join(tokenMonitorDir, "plugin-manager"), { recursive: true });
      yield* fs.writeFileString(
        path.join(tokenMonitorDir, "plugin-manager", "transaction.json"),
        "{}",
      );

      expect(yield* sync).toEqual({ status: "skipped", reason: "token-monitor-busy" });
      expect(yield* fs.exists(target)).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("never downgrades a newer copy", () =>
    Effect.gen(function* () {
      const { fs, path, target, sync, manifest } = yield* setup;
      const newer = JSON.stringify({ ...manifest, version: "99.0.0" });
      yield* fs.makeDirectory(target, { recursive: true });
      yield* fs.writeFileString(path.join(target, "manifest.json"), newer);

      expect(yield* sync).toEqual({ status: "skipped", reason: "installed-is-newer" });
      expect(yield* fs.readFileString(path.join(target, "manifest.json"))).toBe(newer);
    }).pipe(Effect.scoped),
  );

  it.effect("replaces a broken copy and clears what an interrupted run left behind", () =>
    Effect.gen(function* () {
      const { fs, path, tokenMonitorDir, target, sync, sameAsBundle, manifest } = yield* setup;
      const plugins = path.join(tokenMonitorDir, "plugins");
      yield* fs.makeDirectory(target, { recursive: true });
      yield* fs.writeFileString(path.join(target, "manifest.json"), "not json");
      const staging = path.join(plugins, `.${manifest.id}.123.456.tmp`);
      const aside = path.join(plugins, `.${manifest.id}.123.456.old`);
      yield* fs.makeDirectory(staging, { recursive: true });
      yield* fs.makeDirectory(aside, { recursive: true });
      const theirs = path.join(plugins, "someone-elses-plugin");
      yield* fs.makeDirectory(theirs, { recursive: true });

      expect(yield* sync).toEqual({ status: "updated", version: manifest.version });
      expect(yield* sameAsBundle).toBe(true);
      expect(yield* fs.exists(staging)).toBe(false);
      expect(yield* fs.exists(aside)).toBe(false);
      expect(yield* fs.exists(theirs)).toBe(true);
    }).pipe(Effect.scoped),
  );

  // Token Monitor refuses a package update that keeps the same version, so changed files
  // need a new version. When this fails, bump manifest.json's version and record the hash.
  it.effect("ships a new version whenever the plug-in's files change", () =>
    Effect.gen(function* () {
      const { fs, path, manifest } = yield* setup;
      const released: Record<string, string> = {
        "1.6.5": "ab1a10537fb16b3cdbcd089ec0e730242aa8413cc06eb4fd616d726fb221c42c",
        "1.6.6": "b27e18125773cf44b8c67abea0a452a881bb7e35d71367482abc7a01ec07d08b",
      };
      const hash = NodeCrypto.createHash("sha256");
      const { version: _version, ...rest } = manifest as Record<string, unknown>;
      hash.update(JSON.stringify(rest));
      for (const name of [...manifest.files].sort()) {
        hash.update(name);
        hash.update(yield* fs.readFile(path.join(bundleDir(path), name)));
      }
      expect(released[manifest.version]).toBe(hash.digest("hex"));
    }).pipe(Effect.scoped),
  );

  it.effect("compares versions numerically", () =>
    Effect.sync(() => {
      const newer = DesktopTokenMonitorPlugin.isNewerVersion;
      expect(newer("1.10.0", "1.9.9")).toBe(true);
      expect(newer("1.6.4", "1.6.4")).toBe(false);
      expect(newer("1.6.3", "1.6.4")).toBe(false);
      expect(newer("2", "1.99.99")).toBe(true);
      expect(newer("not-a-version", "1.0.0")).toBe(false);
    }),
  );

  it.effect("finds the bundle in the packaged app and in a checkout", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const environment = {
        path,
        resourcesPath: "/Applications/Screddy.app/Contents/Resources",
        appRoot: "/repo",
        appDataDirectory: "/fake-home/Library/Application Support",
      };
      expect(DesktopTokenMonitorPlugin.bundleDirectory({ ...environment, isPackaged: true })).toBe(
        "/Applications/Screddy.app/Contents/Resources/token-monitor-speedometer",
      );
      expect(DesktopTokenMonitorPlugin.bundleDirectory({ ...environment, isPackaged: false })).toBe(
        "/repo/integrations/token-monitor-speedometer",
      );
      expect(DesktopTokenMonitorPlugin.tokenMonitorDirectory(environment)).toBe(
        "/fake-home/Library/Application Support/Token Monitor",
      );
    }),
  );
});
