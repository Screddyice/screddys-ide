import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";

/**
 * Copies the bundled Token Speedometer into Token Monitor's plug-in folder and nothing else.
 * Token Monitor runs a plug-in only once its user approves that exact content, so a new copy
 * waits for approval there; trust settings and package installs stay Token Monitor's.
 */
const { logInfo, logWarning } = makeComponentLogger("desktop-token-monitor-plugin");

const BUNDLE_RESOURCE = "token-monitor-speedometer";
const BUNDLE_SOURCE = "integrations/token-monitor-speedometer";
const TOKEN_MONITOR_FOLDER = "Token Monitor";
// Token Monitor loads only folders named like an id, so the dot-prefixed staging folders below stay invisible to it.
const PLUGIN_ID = /^[a-z0-9][a-z0-9-]{1,39}$/;

type SkipReason =
  | "token-monitor-not-installed"
  | "package-managed"
  | "token-monitor-busy"
  | "registry-unreadable"
  | "installed-is-newer";

export type SyncResult =
  | { readonly status: "installed" | "updated" | "unchanged"; readonly version: string }
  | { readonly status: "skipped"; readonly reason: SkipReason };

interface Bundle {
  readonly id: string;
  readonly version: string;
  /** manifest.json first, then every file the manifest lists, which is all Token Monitor reads. */
  readonly files: ReadonlyArray<readonly [name: string, bytes: Uint8Array]>;
}

export class TokenMonitorPluginBundleError extends Schema.TaggedError<TokenMonitorPluginBundleError>()(
  "TokenMonitorPluginBundleError",
  { bundleDir: Schema.String },
) {
  override get message() {
    return `The bundled Token Monitor plug-in in ${this.bundleDir} has an invalid manifest.`;
  }
}

const safeFileName = (name: string) =>
  !name.includes("\\") &&
  name.split("/").every((part) => part !== "" && part !== "." && part !== "..");

const decodeBundleManifest = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.String,
      version: Schema.String,
      files: Schema.Array(Schema.String),
    }),
  ),
);
const decodeInstalledManifest = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ version: Schema.String })),
);
const decodeRegistry = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

const sameBytes = (a: Uint8Array, b: Uint8Array) => Buffer.compare(a, b) === 0;

/** Dotted-number versions only; anything else never counts as newer. */
export const isNewerVersion = (candidate: string, than: string) => {
  const parse = (version: string) =>
    /^\d+(\.\d+)*$/.test(version) ? version.split(".").map(Number) : undefined;
  const a = parse(candidate);
  const b = parse(than);
  if (!a || !b) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
};

const readBundle = Effect.fn("DesktopTokenMonitorPlugin.readBundle")(function* (bundleDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const manifestBytes = yield* fs.readFile(path.join(bundleDir, "manifest.json"));
  const invalid = new TokenMonitorPluginBundleError({ bundleDir });
  const manifest = yield* decodeBundleManifest(Buffer.from(manifestBytes).toString("utf8")).pipe(
    Effect.mapError(() => invalid),
  );
  if (!PLUGIN_ID.test(manifest.id) || !manifest.files.every(safeFileName)) {
    return yield* invalid;
  }
  const files: Array<readonly [string, Uint8Array]> = [["manifest.json", manifestBytes]];
  for (const name of manifest.files) {
    files.push([name, yield* fs.readFile(path.join(bundleDir, name))]);
  }
  return { id: manifest.id, version: manifest.version, files } satisfies Bundle;
});

/** Token Monitor installs and changes packages under a journal; never write beside one. */
const tokenMonitorBusy = Effect.fn("DesktopTokenMonitorPlugin.tokenMonitorBusy")(function* (
  tokenMonitorDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fs.exists(path.join(tokenMonitorDir, "plugin-manager", "transaction.json"));
});

export const syncPlugin = Effect.fn("DesktopTokenMonitorPlugin.syncPlugin")(function* (input: {
  readonly bundleDir: string;
  readonly tokenMonitorDir: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skip = (reason: SkipReason): SyncResult => ({ status: "skipped", reason });

  if (!(yield* fs.exists(input.tokenMonitorDir))) return skip("token-monitor-not-installed");
  const bundle = yield* readBundle(input.bundleDir);
  if (yield* tokenMonitorBusy(input.tokenMonitorDir)) return skip("token-monitor-busy");

  // A copy installed from a package belongs to Token Monitor's package manager, which
  // fingerprints it; changing its files would break that install.
  const registryFile = path.join(input.tokenMonitorDir, "plugin-manager", "installed.json");
  if (yield* fs.exists(registryFile)) {
    const registry = yield* fs
      .readFileString(registryFile)
      .pipe(Effect.flatMap(decodeRegistry), Effect.option);
    if (Option.isNone(registry)) return skip("registry-unreadable");
    if (Object.hasOwn(registry.value, bundle.id)) return skip("package-managed");
  }

  const plugins = path.join(input.tokenMonitorDir, "plugins");
  yield* fs.makeDirectory(plugins, { recursive: true });
  // An interrupted run leaves dot-prefixed folders; the copy itself is rewritten below.
  for (const name of yield* fs.readDirectory(plugins)) {
    if (name.startsWith(`.${bundle.id}.`) && (name.endsWith(".tmp") || name.endsWith(".old"))) {
      yield* fs.remove(path.join(plugins, name), { recursive: true, force: true });
    }
  }

  const target = path.join(plugins, bundle.id);
  const existed = yield* fs.exists(target);
  if (existed) {
    // A missing or unreadable manifest is a broken copy, replaced below.
    const installed = yield* fs
      .readFileString(path.join(target, "manifest.json"))
      .pipe(Effect.flatMap(decodeInstalledManifest), Effect.option);
    if (Option.isSome(installed) && isNewerVersion(installed.value.version, bundle.version)) {
      return skip("installed-is-newer");
    }
    let unchanged = true;
    for (const [name, bytes] of bundle.files) {
      const current = yield* fs.readFile(path.join(target, name)).pipe(Effect.option);
      if (Option.isNone(current) || !sameBytes(current.value, bytes)) {
        unchanged = false;
        break;
      }
    }
    if (unchanged) return { status: "unchanged", version: bundle.version } satisfies SyncResult;
  }

  const suffix = `${process.pid}.${yield* Random.nextIntBetween(0, 0xffffff)}`;
  const staging = path.join(plugins, `.${bundle.id}.${suffix}.tmp`);
  const aside = path.join(plugins, `.${bundle.id}.${suffix}.old`);
  return yield* Effect.gen(function* () {
    for (const [name, bytes] of bundle.files) {
      const file = path.join(staging, name);
      yield* fs.makeDirectory(path.dirname(file), { recursive: true });
      yield* fs.writeFile(file, bytes);
    }
    // Token Monitor may have started a package change while the files were written.
    if (yield* tokenMonitorBusy(input.tokenMonitorDir)) return skip("token-monitor-busy");
    if (existed) {
      yield* fs.rename(target, aside);
      yield* fs
        .rename(staging, target)
        .pipe(Effect.tapError(() => fs.rename(aside, target).pipe(Effect.ignore)));
      yield* fs.remove(aside, { recursive: true, force: true });
    } else {
      yield* fs.rename(staging, target);
    }
    return {
      status: existed ? "updated" : "installed",
      version: bundle.version,
    } satisfies SyncResult;
  }).pipe(
    Effect.ensuring(fs.remove(staging, { recursive: true, force: true }).pipe(Effect.ignore)),
  );
});

export const bundleDirectory = (environment: {
  readonly path: Path.Path;
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly appRoot: string;
}) =>
  environment.isPackaged
    ? environment.path.join(environment.resourcesPath, BUNDLE_RESOURCE)
    : environment.path.join(environment.appRoot, BUNDLE_SOURCE);

/** Token Monitor's Electron user-data folder: same app-data root on every platform. */
export const tokenMonitorDirectory = (environment: {
  readonly path: Path.Path;
  readonly appDataDirectory: string;
}) => environment.path.join(environment.appDataDirectory, TOKEN_MONITOR_FOLDER);

/** Best effort at startup: a failure is logged and never holds up the app. */
export const sync = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const bundleDir = bundleDirectory(environment);
  const tokenMonitorDir = tokenMonitorDirectory(environment);
  const result = yield* syncPlugin({ bundleDir, tokenMonitorDir });
  if (result.status === "installed" || result.status === "updated") {
    yield* logInfo(
      "copied the Token Speedometer into Token Monitor; approve it there to turn it on",
      {
        ...result,
        tokenMonitorDir,
      },
    );
  } else {
    yield* logInfo("Token Speedometer sync", { ...result, tokenMonitorDir });
  }
}).pipe(
  Effect.catchCause((cause) =>
    logWarning("could not copy the Token Speedometer into Token Monitor", {
      cause: Cause.pretty(cause),
    }),
  ),
  Effect.withSpan("desktop.tokenMonitorPlugin.sync"),
);
