// @effect-diagnostics nodeBuiltinImport:off -- Runs Cua Driver and pgrep on this Mac.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

import type { GrokBotPromptResult } from "@t3tools/contracts";
import { isGrokBotPromptLink } from "@t3tools/shared/grokBotPrompt";

const CUA_DRIVER = "/Applications/CuaDriver.app/Contents/MacOS/cua-driver";
/** Grok Bot asks before filling the box until "Don't show again" is ticked, so allow time to confirm. */
const WAIT_FOR_TASK_MS = 60_000;
const SEND_SCRIPT_TIMEOUT_MS = WAIT_FOR_TASK_MS + 20_000;

export interface GrokBotSendDeps {
  readonly open: (link: string) => Promise<boolean>;
  /** True while Grok Bot's own computer-use helper drives the Mac; Screddy then stays out. */
  readonly helperBusy: () => Promise<boolean>;
  /** Runs a Cua Driver script and returns its JSON output, or null when Cua Driver is absent. */
  readonly runScript: ((script: string, timeoutMs: number) => Promise<unknown>) | null;
}

/**
 * A Cua Driver script that waits for Grok Bot's message box to hold exactly `text`, then
 * presses "Send message". It never sends anything else, such as a draft already in the box.
 */
export function grokBotSendScript(text: string): string {
  return `
const want = ${JSON.stringify(text.replace(/\s+/g, " ").trim())};
const norm = (value) => String(value ?? "").replace(/\\s+/g, " ").trim();
const app = await cua.getApp("com.anysphere.sand");
const read = async () => {
  const state = await app.getState({
    tree_format: "elements",
    include_screenshot: false,
    max_elements: 4000,
    timeout_ms: 4000,
  });
  const elements = state.elements ?? [];
  return {
    state,
    box: elements.find((e) => e.element_token && norm(e.value) === want),
    send: elements.find(
      (e) => e.element_token && /button/i.test(e.role ?? "") && norm(e.label) === "Send message",
    ),
  };
};
const deadline = Date.now() + ${WAIT_FOR_TASK_MS};
while (Date.now() < deadline) {
  const { state, box, send } = await read();
  if (box && send && send.enabled !== false) {
    try {
      await app.click(send.element_token);
    } catch {
      // Grok Bot's buttons live in web content, which can refuse a background press.
      await cua.call("click", {
        target: { kind: "window", pid: state.pid, window_id: state.window_id },
        element_token: send.element_token,
        delivery_mode: "foreground",
      });
    }
    for (let i = 0; i < 10; i++) {
      await cua.sleep(300);
      if (!(await read()).box) return "sent";
    }
    return "not-confirmed";
  }
  await cua.sleep(700);
}
return "not-shown";
`;
}

function scriptOutcome(output: unknown): GrokBotPromptResult {
  const value =
    typeof output === "object" && output !== null && "ok" in output && output.ok === true
      ? (output as { value?: unknown }).value
      : undefined;
  if (value === "sent") return { outcome: "sent" };
  if (value === "not-shown" || value === "not-confirmed")
    return { outcome: "typed", reason: value };
  return { outcome: "typed", reason: "driver-unavailable" };
}

/** Opens a Grok Bot prompt link, then presses Send once the bot's box holds exactly that task. */
export async function sendGrokBotPrompt(
  link: string,
  deps: GrokBotSendDeps,
): Promise<GrokBotPromptResult> {
  if (!isGrokBotPromptLink(link)) return { outcome: "failed", reason: "open-failed" };
  const text = new URL(link).searchParams.get("text") ?? "";
  if (!(await deps.open(link))) return { outcome: "failed", reason: "open-failed" };
  if (!deps.runScript) return { outcome: "typed", reason: "driver-unavailable" };
  if (await deps.helperBusy()) return { outcome: "typed", reason: "helper-busy" };
  try {
    return scriptOutcome(await deps.runScript(grokBotSendScript(text), SEND_SCRIPT_TIMEOUT_MS));
  } catch {
    return { outcome: "typed", reason: "driver-unavailable" };
  }
}

/** The real Mac wiring: pgrep for Grok Bot's helper and the Cua Driver command line. */
export function macGrokBotSendDeps(open: GrokBotSendDeps["open"]): GrokBotSendDeps {
  return {
    open,
    // pgrep exits 1 when nothing matches; any other failure keeps Screddy out to be safe.
    helperBusy: () =>
      new Promise((resolve) =>
        NodeChildProcess.execFile(
          "/usr/bin/pgrep",
          ["-x", "CUGrokBotService"],
          { timeout: 5_000 },
          (error) => resolve(error?.code !== 1),
        ),
      ),
    runScript: NodeFS.existsSync(CUA_DRIVER)
      ? (script, timeoutMs) =>
          new Promise((resolve, reject) =>
            NodeChildProcess.execFile(
              CUA_DRIVER,
              [
                "call",
                "run_script",
                JSON.stringify({ script, timeout_ms: timeoutMs, max_calls: 500 }),
              ],
              { timeout: timeoutMs + 10_000, maxBuffer: 4 * 1024 * 1024 },
              (error, stdout) => {
                if (error) return reject(error);
                try {
                  resolve(JSON.parse(stdout));
                } catch (cause) {
                  reject(cause);
                }
              },
            ),
          )
      : null,
  };
}
