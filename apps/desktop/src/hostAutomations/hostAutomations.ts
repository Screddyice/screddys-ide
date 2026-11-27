// @effect-diagnostics nodeBuiltinImport:off -- Reads launchd, cron and Codex job definitions on this Mac.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type { HostAutomation } from "@t3tools/contracts";

type Obj = Record<string, unknown>;
type LaunchctlEntry = { readonly pid: number | null; readonly status: number };

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const WEEKDAYS = [
  "Sundays",
  "Mondays",
  "Tuesdays",
  "Wednesdays",
  "Thursdays",
  "Fridays",
  "Saturdays",
  "Sundays",
];
const RRULE_DAYS: Record<string, string> = {
  SU: "Sundays",
  MO: "Mondays",
  TU: "Tuesdays",
  WE: "Wednesdays",
  TH: "Thursdays",
  FR: "Fridays",
  SA: "Saturdays",
};
const KIND_ORDER = ["scheduled", "background", "login", "on-demand"] as const;
const MAX_COMMAND = 240;
const SECRET = "(?:key|token|secret|password|passwd)";
const secretFlag = new RegExp(`^--?[\\w-]*${SECRET}[\\w-]*$`, "i");
const secretAssignment = new RegExp(`^(-{0,2}[\\w-]*${SECRET}[\\w-]*=).*$`, "i");
// One shell word: bare and quoted pieces in any mix, as in prefix"a b". An unclosed quote runs to
// the end of the line, so a malformed value hides more rather than less.
// Double-quoted text and bare text both take backslash escapes, so \" doesn't end a value.
const DOUBLE_QUOTED = `"(?:[^"\\\\]|\\\\.)*"?`;
const quotedValue = `(?:[^\\s'"\\\\]+|\\\\.|${DOUBLE_QUOTED}|'[^']*'?)+`;
// A program name stops at redirections and other operators, as in "/opt/run">/tmp/out.
const firstWord = new RegExp(`^(?:[^\\s'"\\\\<>|;&()]+|\\\\.|${DOUBLE_QUOTED}|'[^']*'?)+`);
const closedQuotes = /^(?:[^'"\\]|\\.|"(?:[^"\\]|\\.)*"|'[^']*')*$/;
const shellQuoting = /"((?:[^"\\]|\\.)*)"|'([^']*)'|\\(.)/g;

/** The word as the shell passes it on: quotes removed, backslash escapes resolved. */
function unquote(word: string): string {
  return word.replace(shellQuoting, (_, double?: string, single?: string, escaped?: string) =>
    // Inside double quotes a backslash escapes only $ ` " \ and newline; elsewhere it stays.
    double !== undefined ? double.replace(/\\([$`"\\\n])/g, "$1") : (single ?? escaped ?? ""),
  );
}
const leadingAssignments = new RegExp(`^(?:[A-Za-z_]\\w*=(?:${quotedValue})?(?:\\s+|$))+`);
const secretFlagInText = new RegExp(
  `(^|\\s)(--?[\\w-]*${SECRET}[\\w-]*)(=|\\s+)${quotedValue}`,
  "gi",
);
const secretName = new RegExp(SECRET, "i");
// A URL query parameter's name, as in ?token= or &api_key=, and the value that follows it.
const QUERY_NAME = /[?&]([^=&#?\s"']+)=/g;
const QUERY_VALUE = /[^&#\s"']*/y;

function decodedName(name: string): string {
  try {
    return decodeURIComponent(name.replace(/\+/g, " "));
  } catch {
    return name;
  }
}

/**
 * Hides a query value whose name, once URL-decoded (so %74oken is token), looks like a secret.
 * Other values are scanned too, so a URL nested in one (?next=…?token=…) is still covered.
 */
function hideSecretQueryValues(text: string): string {
  const names = new RegExp(QUERY_NAME);
  const value = new RegExp(QUERY_VALUE);
  let shown = "";
  let copied = 0;
  for (let match = names.exec(text); match; match = names.exec(text)) {
    if (!secretName.test(decodedName(match[1]!))) continue;
    const valueStart = match.index + match[0].length;
    value.lastIndex = valueStart;
    const valueEnd = valueStart + (value.exec(text)?.[0].length ?? 0);
    shown += `${text.slice(copied, valueStart)}[hidden]`;
    copied = valueEnd;
    names.lastIndex = valueEnd;
  }
  return shown + text.slice(copied);
}
// The name may start with the secret word itself, as in TOKEN=…
const secretAssignmentInText = new RegExp(
  `(^|\\s)((?:[A-Za-z_][\\w-]*)?${SECRET}[\\w-]*=)${quotedValue}`,
  "gi",
);

const pad = (value: number | string) => String(value).padStart(2, "0");
const cap = (text: string) =>
  text.length > MAX_COMMAND ? `${text.slice(0, MAX_COMMAND - 1)}…` : text;
const numberField = (entry: Obj, key: string) =>
  typeof entry[key] === "number" ? (entry[key] as number) : undefined;

/** The program and its arguments, with the value after a secret-looking flag hidden. */
export function commandLine(args: readonly string[]): string {
  let hideNext = false;
  const shown = args.map((arg) => {
    if (hideNext) {
      hideNext = false;
      return "[hidden]";
    }
    if (secretFlag.test(arg)) hideNext = true;
    return hideSecretQueryValues(arg.replace(secretAssignment, "$1[hidden]"));
  });
  return cap(shown.join(" "));
}

/** The same for a whole shell command line, as cron stores it; quoted values stay whole. */
function shellCommand(command: string): string {
  return cap(
    hideSecretQueryValues(
      command
        .replace(secretFlagInText, "$1$2$3[hidden]")
        .replace(secretAssignmentInText, "$1$2[hidden]"),
    ),
  );
}

function describeCalendarEntry(entry: Obj): string {
  const minute = numberField(entry, "Minute");
  const hour = numberField(entry, "Hour");
  const day = numberField(entry, "Day");
  const weekday = numberField(entry, "Weekday");
  const month = numberField(entry, "Month");
  // launchd treats a missing key as "every", so an hour without a minute runs each minute of it.
  const at =
    hour === undefined
      ? ""
      : minute === undefined
        ? `, every minute ${pad(hour)}:00–${pad(hour)}:59`
        : ` at ${pad(hour)}:${pad(minute)}`;
  if (month !== undefined) {
    const name = MONTHS[month - 1] ?? `month ${month}`;
    if (day !== undefined) return `Yearly on ${name} ${day}${at}`;
    // launchd treats a missing Day as every day, so the job repeats all month.
    return `${describeCalendarEntry({ ...entry, Month: undefined })} in ${name}`;
  }
  if (weekday !== undefined) return `${WEEKDAYS[weekday] ?? `Weekday ${weekday}`}${at}`;
  if (day !== undefined) return `Monthly on day ${day}${at}`;
  if (hour !== undefined) return `Daily${at}`;
  return minute === undefined ? "Every minute" : `Hourly at :${pad(minute)}`;
}

function describeInterval(seconds: number): string {
  if (seconds % 3600 === 0)
    return seconds === 3600 ? "Every hour" : `Every ${seconds / 3600} hours`;
  if (seconds % 60 === 0) return seconds === 60 ? "Every minute" : `Every ${seconds / 60} minutes`;
  return `Every ${seconds} seconds`;
}

export function parseLaunchctlList(text: string): Map<string, LaunchctlEntry> {
  const entries = new Map<string, LaunchctlEntry>();
  for (const line of text.split("\n").slice(1)) {
    const [pid, status, label] = line.split("\t");
    if (!label) continue;
    entries.set(label.trim(), {
      pid: pid && /^\d+$/.test(pid) ? Number(pid) : null,
      status: Number(status) || 0,
    });
  }
  return entries;
}

/** One service's state from `launchctl print <domain>/<label>`; null when there is no output. */
export function parseLaunchctlPrint(text: string): LaunchctlEntry | null {
  // Only the service's own lines sit one tab in; deeper lines belong to nested sections.
  const fields = new Map(
    [...text.matchAll(/^\t([a-z][a-z ]*?) = (.*)$/gm)].map((match) => [
      match[1]!,
      match[2]!.trim(),
    ]),
  );
  if (!fields.has("state")) return null;
  const pid = fields.get("pid");
  const status = Number(fields.get("last exit code"));
  // A job a signal stopped reports that instead; launchctl list shows it as a negative status.
  const signal = /(\d+)\s*$/.exec(fields.get("last terminating signal") ?? "")?.[1];
  return {
    pid: fields.get("state") === "running" && pid && /^\d+$/.test(pid) ? Number(pid) : null,
    status: Number.isInteger(status) ? status : signal ? -Number(signal) : 0,
  };
}

export function parseDisabled(text: string): Set<string> {
  return new Set(
    [...text.matchAll(/"([^"]+)"\s*=>\s*(disabled|true)\b/g)].map((match) => match[1]!),
  );
}

export function launchdAutomation(input: {
  readonly plist: Obj;
  readonly path: string;
  readonly scope: "user" | "system";
  /** True when launchctl could not say whether the job is loaded. */
  readonly stateUnreadable?: boolean;
  readonly loaded: ReadonlyMap<string, LaunchctlEntry>;
  readonly disabled: ReadonlySet<string>;
}): HostAutomation | null {
  const { plist } = input;
  const label = typeof plist.Label === "string" ? plist.Label : "";
  if (!label) return null;
  const calendar = plist.StartCalendarInterval;
  const interval = typeof plist.StartInterval === "number" ? plist.StartInterval : undefined;
  const atLogin = plist.RunAtLoad === true;
  const keepAlive =
    plist.KeepAlive === true || (!!plist.KeepAlive && typeof plist.KeepAlive === "object");
  let kind: HostAutomation["kind"];
  let schedule: string;
  if (calendar && typeof calendar === "object") {
    kind = "scheduled";
    const entries = (Array.isArray(calendar) ? calendar : [calendar]) as Obj[];
    schedule = entries.map(describeCalendarEntry).join("; ");
  } else if (interval !== undefined) {
    kind = "scheduled";
    schedule = describeInterval(interval);
  } else if (keepAlive) {
    kind = "background";
    schedule = "Always running";
  } else if (atLogin) {
    kind = "login";
    schedule = "At login";
  } else {
    kind = "on-demand";
    schedule = plist.WatchPaths ? "When watched files change" : "When something asks for it";
  }
  if (kind === "scheduled" && atLogin) schedule += ", and at login";

  const args = Array.isArray(plist.ProgramArguments)
    ? plist.ProgramArguments.filter((arg): arg is string => typeof arg === "string")
    : typeof plist.Program === "string"
      ? [plist.Program]
      : [];
  const entry = input.loaded.get(label);
  const status: Pick<HostAutomation, "state" | "detail"> =
    plist.Disabled === true || input.disabled.has(label)
      ? { state: "disabled" }
      : input.stateUnreadable
        ? { state: "unknown" }
        : entry === undefined
          ? { state: "not-loaded" }
          : entry.pid !== null
            ? { state: "running", detail: `PID ${entry.pid}` }
            : entry.status !== 0
              ? {
                  state: "failed",
                  detail:
                    entry.status < 0
                      ? `Stopped by signal ${-entry.status}`
                      : `Last exit ${entry.status}`,
                }
              : { state: "idle" };
  return {
    id: `launchd:${input.scope}:${label}`,
    source: "launchd",
    scope: input.scope,
    name: label,
    kind,
    schedule,
    command: args.length ? commandLine(args) : null,
    path: input.path,
    ...status,
  };
}

function describeCron([minute, hour, day, month, weekday]: readonly string[]): string {
  const numeric = (field: string | undefined) => !!field && /^\d+$/.test(field);
  const at = `at ${pad(hour!)}:${pad(minute!)}`;
  if (month !== "*") return `Cron ${[minute, hour, day, month, weekday].join(" ")}`;
  if (day === "*" && weekday === "*" && hour === "*") {
    if (minute === "*") return "Every minute";
    const every = /^\*\/(\d+)$/.exec(minute!)?.[1];
    if (every) return every === "1" ? "Every minute" : `Every ${every} minutes`;
    if (numeric(minute)) return `Hourly at :${pad(minute!)}`;
  }
  if (numeric(minute) && numeric(hour)) {
    if (day === "*" && weekday === "*") return `Daily ${at}`;
    if (day === "*" && /^[0-7]$/.test(weekday!)) return `${WEEKDAYS[Number(weekday)]} ${at}`;
    if (numeric(day) && weekday === "*") return `Monthly on day ${Number(day)} ${at}`;
  }
  return `Cron ${[minute, hour, day, month, weekday].join(" ")}`;
}

const CRON_MACROS: Record<string, string> = {
  "@hourly": "Every hour",
  "@daily": "Daily at 00:00",
  "@midnight": "Daily at 00:00",
  "@weekly": "Sundays at 00:00",
  "@monthly": "Monthly on day 1 at 00:00",
  "@yearly": "Yearly on January 1 at 00:00",
  "@annually": "Yearly on January 1 at 00:00",
};

/** One item per job line of `crontab -l`; comments, blank lines and settings are skipped. */
export function cronAutomations(text: string): HostAutomation[] {
  const jobs: HostAutomation[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || /^[A-Za-z_]\w*\s*=/.test(line)) continue;
    let kind: HostAutomation["kind"] = "scheduled";
    let schedule: string;
    let command: string;
    const macro = /^(@\w+)\s+(.*)$/.exec(line);
    if (macro) {
      command = macro[2]!;
      if (macro[1] === "@reboot") {
        kind = "login";
        schedule = "At startup";
      } else {
        schedule = CRON_MACROS[macro[1]!] ?? macro[1]!;
      }
    } else {
      const fields = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line);
      if (!fields) continue;
      schedule = describeCron(fields.slice(1, 6));
      command = fields[6]!;
    }
    // Leading NAME=value assignments are environment, not the program, and may hold secrets.
    const word = firstWord.exec(command.replace(leadingAssignments, ""))?.[0] ?? "";
    // Balanced quotes are shell syntax and come off; an unclosed one means the line didn't parse.
    const program = word && closedQuotes.test(word) ? unquote(word) : "command";
    jobs.push({
      id: `cron:${jobs.length}`,
      source: "cron",
      scope: "user",
      name: NodePath.basename(program),
      kind,
      schedule,
      command: shellCommand(command),
      path: "crontab",
      state: "idle",
    });
  }
  return jobs;
}

function describeRrule(rrule: string): string {
  const parts = Object.fromEntries(
    rrule.split(";").map((part) => part.split("=") as [string, string | undefined]),
  );
  const interval = Number(parts.INTERVAL ?? 1);
  const hour = parts.BYHOUR;
  if (hour !== undefined && !/^\d+$/.test(hour)) return rrule;
  const at = hour === undefined ? "" : ` at ${pad(hour)}:${pad(parts.BYMINUTE ?? 0)}`;
  switch (parts.FREQ) {
    case "MINUTELY":
      return interval === 1 ? "Every minute" : `Every ${interval} minutes`;
    case "HOURLY":
      return interval === 1 ? "Every hour" : `Every ${interval} hours`;
    case "DAILY":
      return interval === 1 ? `Daily${at}` : `Every ${interval} days${at}`;
    case "WEEKLY": {
      const days = (parts.BYDAY ?? "").split(",").filter(Boolean);
      if (!days.length) return `Weekly${at}`;
      if (days.some((day) => !RRULE_DAYS[day])) return rrule;
      return `${days.map((day) => RRULE_DAYS[day]).join(", ")}${at}`;
    }
    default:
      return rrule;
  }
}

/** A Codex automation from its `automation.toml`. */
export function codexAutomation(toml: string, path: string): HostAutomation | null {
  const field = (key: string) =>
    new RegExp(`^${key}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`, "m").exec(toml)?.[1];
  const id = field("id");
  if (!id) return null;
  const rrule = field("rrule");
  return {
    id: `codex:${id}`,
    source: "codex",
    scope: "user",
    name: field("name") ?? id,
    kind: "scheduled",
    schedule: rrule ? describeRrule(rrule) : "No schedule",
    command: null,
    path,
    state: field("status") === "PAUSED" ? "paused" : "idle",
  };
}

function run(command: string, args: readonly string[]) {
  return new Promise<string>((resolve) => {
    NodeChildProcess.execFile(
      command,
      args,
      { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => resolve(error ? "" : stdout),
    );
  });
}

function runWithError(command: string, args: readonly string[]) {
  return new Promise<{ stdout: string; stderr: string }>((resolve) => {
    NodeChildProcess.execFile(
      command,
      args,
      { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
      (_error, stdout, stderr) => resolve({ stdout: String(stdout), stderr: String(stderr) }),
    );
  });
}

async function listDirectory(directory: string) {
  return NodeFSP.readdir(directory).catch(() => [] as string[]);
}

async function readPlist(path: string): Promise<Obj | null> {
  const json = await run("/usr/bin/plutil", ["-convert", "json", "-o", "-", path]);
  try {
    const value: unknown = JSON.parse(json);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : null;
  } catch {
    return null;
  }
}

/**
 * Every launchd job (yours and system-wide), cron line and Codex automation on this Mac, timed or
 * always running. Read-only; nothing is started, stopped or changed.
 */
export async function readHostAutomations(home: string): Promise<HostAutomation[]> {
  const uid = process.getuid?.();
  const [launchctlList, disabledList, systemDisabledList, crontab] = await Promise.all([
    run("/bin/launchctl", ["list"]),
    uid === undefined
      ? Promise.resolve("")
      : run("/bin/launchctl", ["print-disabled", `gui/${uid}`]),
    run("/bin/launchctl", ["print-disabled", "system"]),
    run("/usr/bin/crontab", ["-l"]),
  ]);
  const loaded = parseLaunchctlList(launchctlList);
  const disabled = parseDisabled(disabledList);
  const systemDisabled = parseDisabled(systemDisabledList);
  // `launchctl list` covers only your own domain, so each daemon is asked for by name.
  const daemonState = async (label: string) => {
    const { stdout, stderr } = await runWithError("/bin/launchctl", ["print", `system/${label}`]);
    const entry = parseLaunchctlPrint(stdout);
    if (entry) return { loaded: new Map([[label, entry]]), stateUnreadable: false };
    return {
      loaded: new Map<string, LaunchctlEntry>(),
      stateUnreadable: !/Could not find service/.test(stderr),
    };
  };
  const folders = [
    { directory: NodePath.join(home, "Library", "LaunchAgents"), scope: "user", daemon: false },
    { directory: "/Library/LaunchAgents", scope: "system", daemon: false },
    { directory: "/Library/LaunchDaemons", scope: "system", daemon: true },
  ] as const;
  const launchd = await Promise.all(
    folders.flatMap(({ directory, scope, daemon }) => [
      listDirectory(directory).then((names) =>
        Promise.all(
          names
            .filter((name) => name.endsWith(".plist"))
            .map(async (name) => {
              const path = NodePath.join(directory, name);
              const plist = await readPlist(path);
              if (!plist) return null;
              if (!daemon) return launchdAutomation({ plist, path, scope, loaded, disabled });
              const label = typeof plist.Label === "string" ? plist.Label : "";
              return launchdAutomation({
                plist,
                path,
                scope,
                disabled: systemDisabled,
                ...(label ? await daemonState(label) : { loaded, stateUnreadable: true }),
              });
            }),
        ),
      ),
    ]),
  );
  const codexFolder = NodePath.join(home, ".codex", "automations");
  const codex = await Promise.all(
    (await listDirectory(codexFolder)).map(async (name) => {
      const path = NodePath.join(codexFolder, name, "automation.toml");
      const toml = await NodeFSP.readFile(path, "utf8").catch(() => "");
      return toml ? codexAutomation(toml, path) : null;
    }),
  );
  const unique = new Map<string, HostAutomation>();
  for (const item of [...launchd.flat(), ...cronAutomations(crontab), ...codex]) {
    if (item && !unique.has(item.id)) unique.set(item.id, item);
  }
  return [...unique.values()].sort(
    (a, b) =>
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.name.localeCompare(b.name),
  );
}
