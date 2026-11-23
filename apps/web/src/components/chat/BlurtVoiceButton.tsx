import type {
  MessageId,
  OrchestrationV2ConversationMessage,
  OrchestrationV2Run,
} from "@t3tools/contracts";
import { AudioLinesIcon, SquareIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { newMessageId } from "~/lib/utils";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useStableCallback } from "../../hooks/useStableCallback";

type Phase = "connecting" | "listening" | "waiting" | "speaking" | "paused";
const phaseLabel = {
  connecting: "Connecting to Blurt",
  listening: "Blurt is listening",
  waiting: "Waiting for the IDE",
  speaking: "Blurt is speaking",
  paused: "Blurt is paused",
} satisfies Record<Phase, string>;

function getReply(
  messageId: MessageId,
  runs: readonly OrchestrationV2Run[],
  messages: readonly OrchestrationV2ConversationMessage[],
) {
  const run = runs.find((item) => item.userMessageId === messageId);
  if (!run) return;
  switch (run.status) {
    case "interrupted":
    case "failed":
    case "cancelled":
    case "rolled_back":
      return { error: "The IDE turn ended before it produced a spoken reply." };
    case "completed":
      return {
        text:
          messages
            .filter(
              (message) =>
                message.runId === run.id && message.role === "assistant" && !message.streaming,
            )
            .map((message) => message.text.trim())
            .filter(Boolean)
            .at(-1)
            ?.slice(0, 8_000) ?? "",
      };
  }
}

export function BlurtVoiceButton({
  canStart,
  splitPane = false,
  needsAttention,
  runs,
  messages,
  onSend,
}: {
  readonly canStart: boolean;
  readonly splitPane?: boolean;
  readonly needsAttention: boolean;
  readonly runs: readonly OrchestrationV2Run[];
  readonly messages: readonly OrchestrationV2ConversationMessage[];
  readonly onSend: (messageId: MessageId, text: string) => Promise<void>;
}) {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  const open = bridge?.openBlurtVoice;
  const turn = bridge?.turnBlurtVoice;
  const close = bridge?.closeBlurtVoice;
  const active = useRef<string | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const [phase, setPhase] = useState<Phase | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ id: MessageId; accepted: boolean } | null>(null);
  const reply = pending?.accepted ? getReply(pending.id, runs, messages) : undefined;

  function disconnect() {
    const id = active.current;
    if (id && close) void close(id).catch(() => {});
    active.current = null;
  }

  function end(failure?: string) {
    disconnect();
    setPhase(null);
    setPending(null);
    setError(failure ?? null);
  }

  async function listen(id: string) {
    if (!turn || active.current !== id) return;
    setPhase("listening");
    const result = await turn({ id, request: { action: "listen" } }).catch(() => ({
      error: "Could not receive audio from Blurt.",
    }));
    if (active.current !== id) return;
    if ("error" in result) {
      end(result.error);
      return;
    }
    if (!("text" in result) || !result.text.trim()) {
      setPhase("paused");
      return;
    }
    setPhase("waiting");
    const messageId = newMessageId();
    setPending({ id: messageId, accepted: false });
    try {
      await onSend(messageId, result.text.trim());
    } catch {
      if (active.current === id) end("Could not send the voice turn to this IDE thread.");
      return;
    }
    if (active.current === id) setPending({ id: messageId, accepted: true });
  }

  async function start(fromShortcut = false) {
    if (!open || !canStart || active.current) return;
    const id = newMessageId();
    active.current = id;
    setError(null);
    setPhase("connecting");
    const result = await open(id, fromShortcut).catch(() => ({
      error: "Could not connect to Blurt.",
    }));
    if (active.current !== id) return;
    if ("error" in result) end(result.error);
    else await listen(id);
  }

  const deliverReply = useStableCallback((outcome: NonNullable<typeof reply>) => {
    const id = active.current;
    if (!id || !turn) return;
    setPending(null);
    if ("error" in outcome) {
      end(outcome.error);
      return;
    }
    if (!outcome.text) {
      setPhase("paused");
      return;
    }
    setPhase("speaking");
    void turn({ id, request: { action: "speak", text: outcome.text } }).then(
      (result) => {
        if (active.current !== id) return;
        if ("error" in result) end(result.error);
        else if (needsAttention) setPhase("paused");
        else void listen(id);
      },
      () => {
        if (active.current === id) end("Blurt could not play the reply.");
      },
    );
  });

  const toggleVoice = useStableCallback((fromShortcut: boolean) => {
    if (active.current) end();
    else void start(fromShortcut);
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- connects the native shortcut to the selected pane's control
  useEffect(() => {
    const target = button.current;
    if (!target) return;
    const onShortcut = () => toggleVoice(true);
    target.addEventListener("blurt-toggle-voice", onShortcut);
    return () => target.removeEventListener("blurt-toggle-voice", onShortcut);
  }, [toggleVoice]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the local connection owns the microphone and closes on unmount
  useEffect(
    () => () => {
      const id = active.current;
      if (id && close) void close(id).catch(() => {});
      active.current = null;
    },
    [close],
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- delivers the completed, matching IDE run to Blurt once
  useEffect(() => {
    if (reply) deliverReply(reply);
  }, [deliverReply, reply]);

  if (!open || !turn || !close || !/mac/i.test(window.navigator.platform)) return null;
  const label = phase ? "End Blurt voice mode" : "Start Blurt voice mode";
  return (
    <>
      {error || phase ? (
        <span role={error ? "alert" : "status"} className="max-w-44 text-xs text-muted-foreground">
          {error ?? (phase ? phaseLabel[phase] : null)}
        </span>
      ) : null}
      {phase === "paused" ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={!canStart}
          onClick={() => {
            if (active.current) void listen(active.current);
          }}
        >
          Resume
        </Button>
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              ref={button}
              size="icon-sm"
              type="button"
              variant={phase ? "secondary" : "ghost"}
            />
          }
          data-blurt-voice={splitPane ? "split" : "main"}
          data-blurt-voice-active={phase ? "true" : undefined}
          aria-label={label}
          aria-pressed={phase !== null}
          disabled={!phase && !canStart}
          onClick={() => toggleVoice(false)}
        >
          {phase ? <SquareIcon aria-hidden="true" /> : <AudioLinesIcon aria-hidden="true" />}
        </TooltipTrigger>
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
    </>
  );
}
