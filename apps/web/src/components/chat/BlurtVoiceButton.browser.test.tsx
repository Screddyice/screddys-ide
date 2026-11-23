import { MessageId, RunId } from "@t3tools/contracts";
import type {
  DesktopBridge,
  OrchestrationV2ConversationMessage,
  OrchestrationV2Run,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { BlurtVoiceButton } from "./BlurtVoiceButton";

it("routes speech only through the current thread's matching run and closes on stop", async () => {
  const openBlurtVoice = vi
    .fn<NonNullable<DesktopBridge["openBlurtVoice"]>>()
    .mockResolvedValue({ ok: true });
  const closeBlurtVoice = vi
    .fn<NonNullable<DesktopBridge["closeBlurtVoice"]>>()
    .mockResolvedValue(undefined);
  const turnBlurtVoice = vi
    .fn<NonNullable<DesktopBridge["turnBlurtVoice"]>>()
    .mockResolvedValueOnce({ text: "Test this thread." })
    .mockResolvedValueOnce({ ok: true })
    .mockResolvedValueOnce({ text: "" });
  const originalBridge = window.desktopBridge;
  const platform = Object.getOwnPropertyDescriptor(navigator, "platform");
  window.desktopBridge = {
    ...originalBridge,
    openBlurtVoice,
    closeBlurtVoice,
    turnBlurtVoice,
  } as DesktopBridge;
  Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
  try {
    let sentMessageId: MessageId | undefined;
    const onSend = vi.fn(async (id: MessageId, _text: string) => {
      sentMessageId = id;
    });
    const otherRun = {
      id: RunId.make("other-run"),
      status: "completed",
      userMessageId: MessageId.make("other-message"),
    } as OrchestrationV2Run;
    const runId = RunId.make("voice-run");
    const assistant = (id: RunId, text: string) =>
      ({
        runId: id,
        role: "assistant",
        streaming: false,
        text,
      }) as OrchestrationV2ConversationMessage;
    await using screen = await render(
      <BlurtVoiceButton
        canStart
        needsAttention={false}
        runs={[otherRun]}
        messages={[assistant(otherRun.id, "Unrelated answer.")]}
        onSend={onSend}
      />,
    );
    await screen.getByRole("button", { name: "Start Blurt voice mode" }).click();
    await expect.poll(() => onSend.mock.calls.length).toBe(1);
    expect(turnBlurtVoice.mock.calls).toHaveLength(1);
    expect(onSend).toHaveBeenCalledWith(sentMessageId, "Test this thread.");
    const voiceRun = {
      id: runId,
      status: "completed",
      userMessageId: sentMessageId,
    } as OrchestrationV2Run;
    await screen.rerender(
      <BlurtVoiceButton
        canStart
        needsAttention={false}
        runs={[otherRun, voiceRun]}
        messages={[
          assistant(otherRun.id, "Unrelated answer."),
          assistant(runId, "This thread passed."),
        ]}
        onSend={onSend}
      />,
    );
    await expect.element(screen.getByRole("button", { name: "Resume" })).toBeVisible();
    const id = openBlurtVoice.mock.calls.at(0)?.[0];
    expect(turnBlurtVoice.mock.calls.map(([input]) => input.request)).toEqual([
      { action: "listen" },
      { action: "speak", text: "This thread passed." },
      { action: "listen" },
    ]);
    await screen.getByRole("button", { name: "End Blurt voice mode" }).click();
    expect(closeBlurtVoice).toHaveBeenCalledWith(id);
  } finally {
    if (originalBridge) window.desktopBridge = originalBridge;
    else Reflect.deleteProperty(window, "desktopBridge");
    if (platform) Object.defineProperty(navigator, "platform", platform);
    else Reflect.deleteProperty(navigator, "platform");
  }
});
