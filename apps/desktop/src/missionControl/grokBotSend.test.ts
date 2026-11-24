import { grokBotPromptLink } from "@t3tools/shared/grokBotPrompt";
import { describe, expect, it, vi } from "vite-plus/test";

import { grokBotSendScript, sendGrokBotPrompt, type GrokBotSendDeps } from "./grokBotSend.ts";

const task = 'Help me tackle this Mission Control task. Source: tasks; Task: "Renew passport"';
const link = grokBotPromptLink("bot", task)!;

type Element = {
  element_token: string;
  role: string;
  label?: string;
  value?: string;
  enabled?: boolean;
};

const sendButton: Element = { element_token: "s1:9", role: "button", label: "Send message" };
const box = (value: string): Element => ({
  element_token: "s1:4",
  role: "textarea",
  label: "Message Screddy",
  value,
});

/** Runs the real script against a stand-in for Cua Driver and Grok Bot's window. */
async function runAgainst(
  screens: readonly (readonly Element[])[],
  { refuseBackground = false } = {},
) {
  let clock = 0;
  let screen = 0;
  const clicks: string[] = [];
  const cua = {
    getApp: async () => ({
      getState: async () => ({
        pid: 7,
        window_id: 70,
        elements: screens[Math.min(screen++, screens.length - 1)],
      }),
      click: async (token: string) => {
        if (refuseBackground) throw new Error("background_unavailable");
        clicks.push(token);
      },
    }),
    call: async (tool: string, args: { element_token: string; delivery_mode: string }) => {
      clicks.push(`${tool}:${args.delivery_mode}:${args.element_token}`);
    },
    sleep: async (ms: number) => {
      clock += ms;
    },
  };
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const run = new AsyncFunction("cua", "Date", grokBotSendScript(task));
  const value = await run(cua, { now: () => clock });
  return { value, clicks };
}

describe("grokBotSendScript", () => {
  it("presses Send once the box holds exactly the task, after you confirm in Grok Bot", async () => {
    const result = await runAgainst([
      [sendButton, box("")],
      [sendButton, box(task.replace("; ", "; "))],
      [sendButton, box("")],
    ]);
    expect(result).toEqual({ value: "sent", clicks: ["s1:9"] });
  });

  it("presses Send in the front window when Grok Bot refuses a background press", async () => {
    const result = await runAgainst(
      [
        [sendButton, box(task)],
        [sendButton, box("")],
      ],
      {
        refuseBackground: true,
      },
    );
    expect(result).toEqual({ value: "sent", clicks: ["click:foreground:s1:9"] });
  });

  it("never sends a draft that is not this task", async () => {
    const result = await runAgainst([[sendButton, box("My own half-written note")]]);
    expect(result).toEqual({ value: "not-shown", clicks: [] });
  });

  it("does not press a disabled Send button", async () => {
    const result = await runAgainst([[{ ...sendButton, enabled: false }, box(task)]]);
    expect(result).toEqual({ value: "not-shown", clicks: [] });
  });

  it("reports when the task is still in the box after pressing Send", async () => {
    const result = await runAgainst([[sendButton, box(task)]]);
    expect(result).toEqual({ value: "not-confirmed", clicks: ["s1:9"] });
  });
});

describe("sendGrokBotPrompt", () => {
  const deps = (overrides: Partial<GrokBotSendDeps> = {}): GrokBotSendDeps => ({
    open: vi.fn(async () => true),
    helperBusy: vi.fn(async () => false),
    runScript: vi.fn(async () => ({ ok: true, value: "sent" })),
    ...overrides,
  });

  it("opens the link, then reports a sent task", async () => {
    const d = deps();
    await expect(sendGrokBotPrompt(link, d)).resolves.toEqual({ outcome: "sent" });
    expect(d.open).toHaveBeenCalledExactlyOnceWith(link);
    expect(d.runScript).toHaveBeenCalledOnce();
  });

  it("refuses a link Grok Bot would refuse, without opening anything", async () => {
    const d = deps();
    await expect(
      sendGrokBotPrompt("grokbot://app/v1/prompt?id=bot&text=a%0Ab", d),
    ).resolves.toEqual({ outcome: "failed", reason: "open-failed" });
    expect(d.open).not.toHaveBeenCalled();
  });

  it("stays out while Grok Bot's computer-use helper is running", async () => {
    const d = deps({ helperBusy: vi.fn(async () => true) });
    await expect(sendGrokBotPrompt(link, d)).resolves.toEqual({
      outcome: "typed",
      reason: "helper-busy",
    });
    expect(d.runScript).not.toHaveBeenCalled();
  });

  it.each([
    ["Cua Driver is missing", { runScript: null }, "driver-unavailable"],
    ["the script fails", { runScript: vi.fn(async () => ({ ok: false })) }, "driver-unavailable"],
    [
      "Cua Driver errors",
      { runScript: vi.fn(async () => Promise.reject(new Error("x"))) },
      "driver-unavailable",
    ],
    [
      "the task never appears",
      { runScript: vi.fn(async () => ({ ok: true, value: "not-shown" })) },
      "not-shown",
    ],
  ] as const)("leaves the typed task for you when %s", async (_, overrides, reason) => {
    await expect(sendGrokBotPrompt(link, deps(overrides))).resolves.toEqual({
      outcome: "typed",
      reason,
    });
  });

  it("reports a link Grok Bot could not open", async () => {
    const d = deps({ open: vi.fn(async () => false) });
    await expect(sendGrokBotPrompt(link, d)).resolves.toEqual({
      outcome: "failed",
      reason: "open-failed",
    });
    expect(d.runScript).not.toHaveBeenCalled();
  });
});
