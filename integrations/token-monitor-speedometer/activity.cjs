const { execFile } = require("node:child_process");
const { constants } = require("node:fs");
const { mkdir, open, readdir, rename, writeFile } = require("node:fs/promises");
const { homedir } = require("node:os");
const { isAbsolute, join } = require("node:path");
const runFile = require("node:util").promisify(execFile);

// The Screddy MCP bridge publishes only an application name and two timestamps.
const markerName = /^activity-[0-9a-f-]{36}\.json$/u;
const expiryMs = 4000;
const maxBytes = 1024;

async function readMarker(file, now) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > maxBytes) return;
    const data = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(data);
    const { application, startedAt, heartbeatAt } = JSON.parse(data.toString("utf8", 0, bytesRead));
    if (
      Number.isFinite(startedAt) &&
      Number.isFinite(heartbeatAt) &&
      startedAt <= heartbeatAt &&
      heartbeatAt <= now &&
      now - heartbeatAt < expiryMs &&
      (application === null ||
        (typeof application === "string" &&
          application.length > 0 &&
          application.length <= 120 &&
          !/[\p{C}/\\]/u.test(application)))
    ) {
      return { application, startedAt };
    }
  } finally {
    await handle.close();
  }
}

// Screddy's menu bar shows Token Monitor's numbers from this file (tokenMonitorSection.ts).
const snapshotEveryMs = 30000;
const finite = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
const text = (...values) =>
  values
    .find((value) => typeof value === "string" && value.trim())
    ?.trim()
    .slice(0, 40);

function todayFrom(result) {
  const row = result?.availability === "available" ? result.rows?.[0] : undefined;
  const totalTokens = finite(row?.totalTokens);
  if (totalTokens === null) return null;
  return {
    totalTokens,
    knownUsd: finite(row.cost?.knownUsd),
    costComplete: row.cost?.completeness === "complete",
  };
}

function limitsFrom(result) {
  if (result?.availability !== "available" || !Array.isArray(result.rows)) return [];
  return result.rows.slice(0, 8).flatMap((row) => {
    const label = text(row?.label, row?.providerLabel, row?.provider);
    const windows = (Array.isArray(row?.windows) ? row.windows : []).slice(0, 4).flatMap((w) => {
      const used = finite(w?.usedPercent);
      const remainingPercent = finite(w?.remainingPercent) ?? (used === null ? null : 100 - used);
      const name = text(w?.displayLabel, w?.label, w?.kind);
      return remainingPercent === null || !name ? [] : [{ label: name, remainingPercent }];
    });
    return label && windows.length > 0 ? [{ label, windows }] : [];
  });
}

async function writeSnapshot(host, directory, trayIcon) {
  const [usage, limits] = await Promise.all(
    ["usage", "limits"].map((resource) =>
      host.call("data.query", { resource, period: "today" }).catch(() => null),
    ),
  );
  const snapshot = {
    version: 1,
    writtenAt: Date.now(),
    // While true, Screddy leaves its own SR icon out so this one opens Token Monitor.
    trayIcon,
    today: todayFrom(usage),
    limits: limitsFrom(limits),
  };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, "snapshot.json");
  const staging = `${file}.${process.pid}.tmp`;
  await writeFile(staging, JSON.stringify(snapshot), { mode: 0o600 });
  await rename(staging, file);
}

exports.activate = ({ host, log } = {}) => {
  const configuredHome = process.env.T3CODE_HOME?.trim();
  const home =
    configuredHome && isAbsolute(configuredHome)
      ? configuredHome
      : join(homedir(), ".screddys-ide");
  const directory = join(home, "userdata", "computer-use-activity");
  const snapshotDirectory = join(home, "userdata", "token-monitor");
  let trayIcon = false;
  const share = () =>
    host?.call
      ? writeSnapshot(host, snapshotDirectory, trayIcon).catch((error) =>
          log?.(`Could not share Token Monitor numbers with Screddy: ${error?.message ?? error}`),
        )
      : undefined;
  void share();
  const timer = setInterval(share, snapshotEveryMs);
  return {
    dispose() {
      clearInterval(timer);
    },
    async call(method) {
      if (method === "openWebsite") {
        await runFile("/usr/bin/open", ["https://shawn-reddy.com/"], { timeout: 10000 });
        return true;
      }
      if (method === "trayShown") {
        if (!trayIcon) {
          trayIcon = true;
          await share();
        }
        return true;
      }
      if (method !== "activeApplications") throw new Error("Unknown operation");
      const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
      const now = Date.now();
      const reads = entries
        .filter((entry) => entry.isFile() && markerName.test(entry.name))
        .map((entry) => readMarker(join(directory, entry.name), now).catch(() => undefined));
      const active = (await Promise.all(reads)).filter(Boolean);
      active.sort((left, right) => right.startedAt - left.startedAt);
      return [...new Set(active.map((reading) => reading.application))];
    },
  };
};
