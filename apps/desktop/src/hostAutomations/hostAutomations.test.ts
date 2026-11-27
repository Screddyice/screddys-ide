import { describe, expect, it } from "vite-plus/test";

import {
  codexAutomation,
  commandLine,
  cronAutomations,
  launchdAutomation,
  parseDisabled,
  parseLaunchctlList,
  parseLaunchctlPrint,
} from "./hostAutomations.ts";

const none = new Map<string, { pid: number | null; status: number }>();
const agent = (
  plist: Record<string, unknown>,
  loaded: ReadonlyMap<string, { pid: number | null; status: number }> = none,
  disabled: ReadonlySet<string> = new Set(),
) =>
  launchdAutomation({
    plist,
    path: "/opt/example/LaunchAgents/job.plist",
    scope: "user",
    loaded,
    disabled,
  });

describe("launchdAutomation", () => {
  it("describes calendar schedules and the script they run", () => {
    const job = agent(
      {
        Label: "com.example.weekly",
        ProgramArguments: ["/bin/bash", "/opt/example/weekly.sh"],
        StartCalendarInterval: { Weekday: 0, Hour: 3, Minute: 0 },
      },
      new Map([["com.example.weekly", { pid: null, status: 0 }]]),
    );
    expect(job).toEqual({
      id: "launchd:user:com.example.weekly",
      source: "launchd",
      scope: "user",
      name: "com.example.weekly",
      kind: "scheduled",
      schedule: "Sundays at 03:00",
      command: "/bin/bash /opt/example/weekly.sh",
      path: "/opt/example/LaunchAgents/job.plist",
      state: "idle",
    });
    const schedule = (StartCalendarInterval: unknown) =>
      agent({ Label: "x", Program: "/opt/x", StartCalendarInterval })?.schedule;
    expect(schedule({ Hour: 8, Minute: 5 })).toBe("Daily at 08:05");
    expect(schedule({ Minute: 30 })).toBe("Hourly at :30");
    // launchd treats a missing Minute as every minute of that hour.
    expect(schedule({ Hour: 8 })).toBe("Daily, every minute 08:00–08:59");
    expect(schedule({ Weekday: 1, Hour: 8 })).toBe("Mondays, every minute 08:00–08:59");
    expect(schedule({ Day: 1, Hour: 9, Minute: 0 })).toBe("Monthly on day 1 at 09:00");
    // A month without a day runs on every matching day of that month, not once a year.
    expect(schedule({ Month: 12, Hour: 8, Minute: 0 })).toBe("Daily at 08:00 in December");
    expect(schedule({ Month: 12, Weekday: 1, Hour: 8, Minute: 0 })).toBe(
      "Mondays at 08:00 in December",
    );
    expect(schedule({ Month: 12, Day: 25, Hour: 8, Minute: 0 })).toBe(
      "Yearly on December 25 at 08:00",
    );
    expect(
      schedule([
        { Hour: 8, Minute: 0 },
        { Hour: 20, Minute: 0 },
      ]),
    ).toBe("Daily at 08:00; Daily at 20:00");
  });

  it("describes intervals", () => {
    const every = (StartInterval: number) =>
      agent({ Label: "x", Program: "/opt/x", StartInterval })?.schedule;
    expect(every(60)).toBe("Every minute");
    expect(every(90)).toBe("Every 90 seconds");
    expect(every(300)).toBe("Every 5 minutes");
    expect(every(3600)).toBe("Every hour");
    expect(every(21_600)).toBe("Every 6 hours");
  });

  it("marks background and login jobs with their run state", () => {
    const loaded = new Map([
      ["com.example.server", { pid: 123, status: 0 }],
      ["com.example.login", { pid: null, status: 78 }],
    ]);
    expect(
      agent(
        { Label: "com.example.server", Program: "/opt/s", KeepAlive: true, RunAtLoad: true },
        loaded,
      ),
    ).toMatchObject({
      kind: "background",
      schedule: "Always running",
      state: "running",
      detail: "PID 123",
    });
    expect(
      agent({ Label: "com.example.login", Program: "/opt/l", RunAtLoad: true }, loaded),
    ).toMatchObject({
      kind: "login",
      schedule: "At login",
      state: "failed",
      detail: "Last exit 78",
    });
    expect(agent({ Label: "com.example.helper", Program: "/opt/h" })).toMatchObject({
      kind: "on-demand",
      schedule: "When something asks for it",
      state: "not-loaded",
    });
  });

  it("reports disabled jobs, system daemons and skips files without a label", () => {
    expect(agent({ Label: "a", Program: "/opt/a", Disabled: true })?.state).toBe("disabled");
    expect(agent({ Label: "b", Program: "/opt/b" }, none, new Set(["b"]))?.state).toBe("disabled");
    const daemon = (
      loaded: ReadonlyMap<string, { pid: number | null; status: number }>,
      stateUnreadable = false,
    ) =>
      launchdAutomation({
        plist: { Label: "com.vendor.daemon", Program: "/opt/d", StartInterval: 3600 },
        path: "/opt/example/LaunchDaemons/d.plist",
        scope: "system",
        stateUnreadable,
        loaded,
        disabled: new Set(),
      });
    // A system daemon's state comes from `launchctl print system/<label>`.
    expect(daemon(new Map([["com.vendor.daemon", { pid: 843, status: 0 }]]))).toMatchObject({
      id: "launchd:system:com.vendor.daemon",
      scope: "system",
      state: "running",
      detail: "PID 843",
    });
    expect(daemon(new Map([["com.vendor.daemon", { pid: null, status: 3 }]]))?.state).toBe(
      "failed",
    );
    expect(daemon(new Map([["com.vendor.daemon", { pid: null, status: -9 }]]))).toMatchObject({
      state: "failed",
      detail: "Stopped by signal 9",
    });
    expect(daemon(none, true)?.state).toBe("unknown");
    expect(agent({ Program: "/opt/x" })).toBeNull();
  });
});

describe("commandLine", () => {
  it("hides values that look like secrets and caps the length", () => {
    expect(
      commandLine([
        "node",
        "server.js",
        "--api-key",
        "sk-123",
        "TOKEN=abc",
        "--password=hunter2",
        "--port",
        "3774",
      ]),
    ).toBe("node server.js --api-key [hidden] TOKEN=[hidden] --password=[hidden] --port 3774");
    expect(commandLine(["/usr/bin/curl", "https://example.test/hook?secret=s1&id=2"])).toBe(
      "/usr/bin/curl https://example.test/hook?secret=[hidden]&id=2",
    );
    // Names are compared after URL decoding: %77 is "w".
    expect(commandLine(["/usr/bin/curl", "https://example.test/c?pass%77ord=p&id=3"])).toBe(
      "/usr/bin/curl https://example.test/c?pass%77ord=[hidden]&id=3",
    );
    const long = commandLine(["/opt/run", "x".repeat(400)]);
    expect(long.length).toBeLessThanOrEqual(240);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("launchctl output", () => {
  it("reads the job list and the disabled list", () => {
    expect(parseLaunchctlList("PID\tStatus\tLabel\n123\t0\tcom.a\n-\t78\tcom.b\n")).toEqual(
      new Map([
        ["com.a", { pid: 123, status: 0 }],
        ["com.b", { pid: null, status: 78 }],
      ]),
    );
    expect(
      parseDisabled(
        'disabled services = {\n\t"com.a" => disabled\n\t"com.b" => enabled\n\t"com.c" => true\n}\n',
      ),
    ).toEqual(new Set(["com.a", "com.c"]));
  });

  it("reads one service's state from launchctl print, ignoring nested sections", () => {
    const service = (lines: string) => `system/com.v = {\n${lines}\t\tstate = active\n}\n`;
    expect(
      parseLaunchctlPrint(
        service("\tstate = running\n\tpid = 843\n\tlast exit code = (never exited)\n"),
      ),
    ).toEqual({ pid: 843, status: 0 });
    expect(parseLaunchctlPrint(service("\tstate = not running\n\tlast exit code = 78\n"))).toEqual({
      pid: null,
      status: 78,
    });
    // A daemon stopped by a signal reports it instead of an exit code.
    expect(
      parseLaunchctlPrint(
        service("\tstate = not running\n\tlast terminating signal = Killed: 9\n"),
      ),
    ).toEqual({ pid: null, status: -9 });
    expect(parseLaunchctlPrint("")).toBeNull();
  });
});

describe("cronAutomations", () => {
  it("lists each job line with a readable schedule", () => {
    const jobs = cronAutomations(
      [
        "PATH=/usr/bin:/bin",
        "# nightly",
        "*/15 * * * * /opt/example/poll.sh",
        "0 3 * * 0 /opt/example/weekly.sh --secret abc",
        "@reboot /opt/example/start.sh",
        "30 2 1 * * /opt/example/monthly.sh",
        "5 4 * * 1-5 /opt/example/weekdays.sh",
        `0 6 * * * /opt/example/send.sh --api-key "two words" API_TOKEN='x y' --port 1`,
        "",
      ].join("\n"),
    );
    expect(jobs.map(({ kind, schedule, command }) => [kind, schedule, command])).toEqual([
      ["scheduled", "Every 15 minutes", "/opt/example/poll.sh"],
      ["scheduled", "Sundays at 03:00", "/opt/example/weekly.sh --secret [hidden]"],
      ["login", "At startup", "/opt/example/start.sh"],
      ["scheduled", "Monthly on day 1 at 02:30", "/opt/example/monthly.sh"],
      ["scheduled", "Cron 5 4 * * 1-5", "/opt/example/weekdays.sh"],
      [
        "scheduled",
        "Daily at 06:00",
        "/opt/example/send.sh --api-key [hidden] API_TOKEN=[hidden] --port 1",
      ],
    ]);
    expect(jobs[0]).toMatchObject({
      source: "cron",
      scope: "user",
      path: "crontab",
      state: "idle",
    });
    expect(new Set(jobs.map(({ id }) => id)).size).toBe(jobs.length);
  });

  it("hides secret values in URL query strings", () => {
    const [job] = cronAutomations(
      "*/5 * * * * curl -s 'https://example.test/hook?id=7&token=abc123&x=1' https://example.test/?api_key=k\n",
    );
    expect(job?.command).toBe(
      "curl -s 'https://example.test/hook?id=7&token=[hidden]&x=1' https://example.test/?api_key=[hidden]",
    );
  });

  it("hides a secret nested in another parameter's URL", () => {
    const [job] = cronAutomations(
      "0 1 * * * open https://example.test/?next=https://other.test/?token=abc&id=4\n",
    );
    expect(job?.command).toBe(
      "open https://example.test/?next=https://other.test/?token=[hidden]&id=4",
    );
  });

  it("compares query parameter names after URL decoding", () => {
    const [job] = cronAutomations(
      "*/5 * * * * curl https://example.test/hook?%74oken=abc123&ok=1&%6Bey=k2\n",
    );
    expect(job?.command).toBe(
      "curl https://example.test/hook?%74oken=[hidden]&ok=1&%6Bey=[hidden]",
    );
  });

  it("hides bare secret assignments at the start of a word", () => {
    const [job] = cronAutomations(
      "0 7 * * * TOKEN=abc PASSWORD='p w' KEY=k /opt/example/run.sh --port 2\n",
    );
    expect(job?.command).toBe(
      "TOKEN=[hidden] PASSWORD=[hidden] KEY=[hidden] /opt/example/run.sh --port 2",
    );
    // The name skips leading assignments, so their values never reach it.
    expect(job?.name).toBe("run.sh");
    // A value can mix bare and quoted text; none of it may reach the name or the command.
    const [mixed] = cronAutomations('0 8 * * * MODE=prod TOKEN=prefix"secret value" /opt/run\n');
    expect(mixed?.name).toBe("run");
    expect(mixed?.command).toBe("MODE=prod TOKEN=[hidden] /opt/run");
    // An unclosed quote hides the rest of the line rather than half the value.
    const [open] = cronAutomations('0 8 * * * TOKEN="secret value /opt/run\n');
    expect(open?.command).toBe("TOKEN=[hidden]");
    expect(open?.name).toBe("command");
    // A quoted program path is valid shell; its quotes come off and it keeps its name.
    const quoted = cronAutomations(
      "0 8 * * * MODE=prod \"/opt/tasks/backup\"\n0 9 * * * '/opt/my tasks/sync' --all\n",
    );
    expect(quoted.map((job) => job.name)).toEqual(["backup", "sync"]);
    // A redirection right after the program is not part of its name, and an escaped quote
    // inside double quotes is a literal quote.
    const shell = cronAutomations(
      [
        '0 8 * * * "/opt/tasks/backup">/tmp/out',
        "0 9 * * * /opt/run>/tmp/out 2>&1",
        String.raw`0 10 * * * "/opt/tasks/say\"hi"`,
      ].join("\n"),
    );
    expect(shell.map((job) => job.name)).toEqual(["backup", "run", 'say"hi']);
    // An escaped quote must not end a hidden value early.
    const [escaped] = cronAutomations(String.raw`0 8 * * * TOKEN="a\"b c" /opt/run` + "\n");
    expect(escaped?.command).toBe("TOKEN=[hidden] /opt/run");
    expect(escaped?.name).toBe("run");
  });
});

describe("codexAutomation", () => {
  it("reads a Codex automation's name, status and schedule", () => {
    const toml = (status: string, rrule: string) =>
      `version = 1\nid = "daily-email"\nkind = "heartbeat"\nname = "Daily Email"\nstatus = "${status}"\nrrule = "${rrule}"\n`;
    expect(
      codexAutomation(
        toml("PAUSED", "FREQ=DAILY;BYHOUR=8;BYMINUTE=0;BYSECOND=0"),
        "/opt/example/a.toml",
      ),
    ).toEqual({
      id: "codex:daily-email",
      source: "codex",
      scope: "user",
      name: "Daily Email",
      kind: "scheduled",
      schedule: "Daily at 08:00",
      command: null,
      path: "/opt/example/a.toml",
      state: "paused",
    });
    const schedule = (rrule: string) => codexAutomation(toml("ACTIVE", rrule), "/opt/a")?.schedule;
    expect(schedule("FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=9;BYMINUTE=30")).toBe(
      "Mondays, Wednesdays at 09:30",
    );
    expect(schedule("FREQ=HOURLY;INTERVAL=2")).toBe("Every 2 hours");
    expect(schedule("FREQ=MINUTELY;INTERVAL=30")).toBe("Every 30 minutes");
    expect(schedule("FREQ=YEARLY;BYMONTH=1")).toBe("FREQ=YEARLY;BYMONTH=1");
    expect(codexAutomation(toml("ACTIVE", "FREQ=DAILY"), "/opt/a")?.state).toBe("idle");
    expect(codexAutomation('version = 1\nname = "No id"\n', "/opt/a")).toBeNull();
  });
});
