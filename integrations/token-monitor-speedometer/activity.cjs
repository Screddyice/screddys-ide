const { execFile } = require("node:child_process");
const { constants } = require("node:fs");
const { open, readdir } = require("node:fs/promises");
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

exports.activate = () => {
  const configuredHome = process.env.T3CODE_HOME?.trim();
  const home =
    configuredHome && isAbsolute(configuredHome)
      ? configuredHome
      : join(homedir(), ".screddys-ide");
  const directory = join(home, "userdata", "computer-use-activity");
  return {
    async call(method) {
      if (method === "openWebsite") {
        await runFile("/usr/bin/open", ["https://shawn-reddy.com/"], { timeout: 10000 });
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
