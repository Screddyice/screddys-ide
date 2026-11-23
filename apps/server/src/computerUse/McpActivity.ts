const ACTIVE_TOOLS = new Set([
  "agent_display",
  "bring_to_front",
  "click",
  "clipboard_read",
  "clipboard_write",
  "double_click",
  "drag",
  "get_accessibility_tree",
  "get_desktop_state",
  "get_window_state",
  "hotkey",
  "invoke_menu",
  "kill_app",
  "launch_app",
  "list_apps",
  "list_windows",
  "move_cursor",
  "page",
  "parse_visual_regions",
  "press_key",
  "replay_trajectory",
  "right_click",
  "run_script",
  "run_steps",
  "scroll",
  "set_value",
  "set_window_frame",
  "type_text",
  "verify_state",
  "zoom",
]);

const IDLE_MS = 10_000;
type MessageId = string | number;
type Fields = Record<string, unknown>;
type Activity = { application: string | null; startedAt: number };
type Call = {
  tool: string;
  session: string;
  activity: Activity;
};

function fields(value: unknown): Fields {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Fields)
    : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function applicationName(value: unknown): string | undefined {
  const name = text(value)?.trim();
  return name && name.length <= 120 && !/[\p{C}/\\]/u.test(name) ? name : undefined;
}

function recordId(value: unknown): string | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? String(value)
    : text(value);
}

function messageId(value: unknown): MessageId | undefined {
  return typeof value === "number" || typeof value === "string" ? value : undefined;
}

/** Observes tool envelopes only. Its output contains no window, page, or prompt content. */
export function makeMcpActivity() {
  const identities = new Map<string, string>();
  const pending = new Map<MessageId, Call>();
  const endings = new Map<MessageId, string>();
  const recentlyFinished = new Map<string, Activity & { until: number }>();

  function remember(key: string | undefined, name: string | undefined) {
    if (!key || !name) return;
    identities.delete(key);
    identities.set(key, name);
    if (identities.size > 512) {
      const oldest = identities.keys().next().value;
      if (oldest !== undefined) identities.delete(oldest);
    }
  }

  function key(kind: string, id: unknown, owner = ""): string | undefined {
    const value = recordId(id);
    return value === undefined ? undefined : JSON.stringify([kind, owner, value]);
  }

  function get(kind: string, id: unknown, owner?: string) {
    const identity = key(kind, id, owner);
    return identity === undefined ? undefined : identities.get(identity);
  }

  function knownTarget(args: Fields, session: string) {
    const bundle = applicationName(args.bundle_id);
    const name = applicationName(args.app) ?? bundle;
    return (
      get("snapshot", text(args.element_token)?.split(":")[0]) ??
      get("browser", args.target_id, session) ??
      get("pid", args.pid) ??
      (name === undefined ? undefined : (get("bundle", name) ?? name))
    );
  }

  function requestedTarget(tool: string, args: Fields, session: string): string | null {
    if (tool === "get_desktop_state") return "Desktop";
    if (tool === "run_script" || tool === "replay_trajectory") return null;
    if (tool === "launch_app") {
      return knownTarget(args, session) ?? applicationName(args.name) ?? null;
    }
    if (tool === "run_steps" && Array.isArray(args.steps)) {
      const targets = new Set<string>();
      const defaultApp = knownTarget(args, session);
      for (const stepValue of args.steps) {
        const step = fields(stepValue);
        const namedAction = Object.keys(step).find((name) => ACTIVE_TOOLS.has(name));
        const action = fields(namedAction === undefined ? step.args : step[namedAction]);
        const name = knownTarget(action, session) ?? defaultApp;
        if (name !== undefined) targets.add(name);
      }
      if (targets.size > 0) return [...targets].join(", ").slice(0, 120);
    }
    return knownTarget(args, session) ?? null;
  }

  function observedTarget(call: Call, result: Fields): string | undefined {
    // Only these driver-owned fields can name an application. Script results, window titles,
    // accessibility trees, screenshots and browser page metadata are never used.
    if (call.tool === "run_script" || call.tool === "replay_trajectory") return undefined;
    for (const entries of [result.apps, result.windows]) {
      if (!Array.isArray(entries)) continue;
      for (const value of entries) {
        const row = fields(value);
        const name = applicationName(row.app_name) ?? applicationName(row.name);
        remember(key("pid", row.pid), name);
        remember(key("bundle", row.bundle_id), name);
      }
    }
    const observed = call.tool === "run_steps" ? fields(result.observation) : result;
    const name =
      applicationName(observed.app_name) ??
      (call.tool === "launch_app" ? applicationName(result.name) : undefined) ??
      call.activity.application ??
      undefined;
    remember(key("pid", observed.pid), name);
    remember(key("bundle", observed.bundle_id), name);
    remember(key("snapshot", observed.snapshot_id), name);
    remember(key("browser", result.target_id, call.session), name);
    return name;
  }

  return {
    request(value: unknown, now: number) {
      const request = fields(value);
      const params = fields(request.params);
      if (request.method === "notifications/cancelled") {
        const cancelled = messageId(params.requestId);
        if (cancelled !== undefined) {
          pending.delete(cancelled);
          endings.delete(cancelled);
        }
        return;
      }
      const id = messageId(request.id);
      if (id === undefined || request.method !== "tools/call") return;
      const tool = text(params.name);
      const args = fields(params.arguments);
      const session = text(args.session) ?? "";
      if (tool === "end_session") {
        endings.set(id, session);
      } else if (
        tool &&
        (ACTIVE_TOOLS.has(tool) || tool.startsWith("browser_") || tool === "get_browser_state")
      ) {
        pending.set(id, {
          tool,
          session,
          activity: { application: requestedTarget(tool, args, session), startedAt: now },
        });
      }
    },
    response(value: unknown, now: number) {
      const response = fields(value);
      const id = messageId(response.id);
      if (id === undefined) return;
      const result = fields(response.result);
      const ended = endings.get(id);
      endings.delete(id);
      if (ended !== undefined && response.error === undefined && result.isError !== true) {
        recentlyFinished.delete(ended);
        for (const [pendingId, call] of pending) {
          if (call.session === ended) pending.delete(pendingId);
        }
      }
      const call = pending.get(id);
      if (!call) return;
      pending.delete(id);
      if (response.error !== undefined || result.isError === true) return;
      const name = observedTarget(call, fields(result.structuredContent));
      if ((recentlyFinished.get(call.session)?.startedAt ?? 0) <= call.activity.startedAt) {
        recentlyFinished.set(call.session, {
          ...call.activity,
          application: name ?? call.activity.application,
          until: now + IDLE_MS,
        });
      }
    },
    current(now: number): Activity | undefined {
      let active: Activity | undefined;
      for (const [session, entry] of recentlyFinished) {
        if (entry.until <= now) recentlyFinished.delete(session);
        else if (active === undefined || entry.startedAt >= active.startedAt) active = entry;
      }
      let running: Activity | undefined;
      for (const { activity } of pending.values()) {
        if (running === undefined || activity.startedAt >= running.startedAt) running = activity;
      }
      return running ?? active;
    },
  };
}
