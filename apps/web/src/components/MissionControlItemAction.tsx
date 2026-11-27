import type {
  MissionControlActionResult,
  MissionControlItem,
  MissionControlReplyPreview,
} from "@t3tools/contracts";
import { CheckIcon, ReplyIcon } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Textarea } from "./ui/textarea";
import { toastManager } from "./ui/toast";

type ReplyPreview = Extract<MissionControlReplyPreview, { ok: true }>;

const replyCopy = {
  email: {
    title: "Reply to email",
    checking: "Checking the email…",
    loadFailed: "Could not load this email from Gmail.",
    unconfirmed: "Gmail did not confirm the send. Check Sent in Gmail before sending again.",
    open: "Open in Gmail",
    review: "Review latest email",
    send: "Send reply",
    sending: "Sending…",
  },
  slack: {
    title: "Reply in Slack",
    checking: "Checking the Slack thread…",
    loadFailed: "Could not load this thread from Slack.",
    unconfirmed: "Slack did not confirm the reply. Check the thread in Slack before sending again.",
    open: "Open in Slack",
    review: "Review latest message",
    send: "Post reply",
    sending: "Posting…",
  },
};

export function MissionControlItemAction({
  item,
  onDone,
}: {
  item: MissionControlItem;
  onDone: (result: Extract<MissionControlActionResult, { ok: true }>) => void;
}) {
  const bridge = window.desktopBridge;
  const [open, setOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<ReplyPreview>();
  const [body, setBody] = useState("");
  const [error, setError] = useState("");
  const pending = useRef(false);

  if (!bridge?.runMissionControlAction) return null;

  const complete = async () => {
    if (pending.current) return;
    pending.current = true;
    setWorking(true);
    try {
      const result = await bridge.runMissionControlAction({
        kind: item.source === "tasks" ? "complete-task" : "complete-linear",
        itemId: item.id,
      });
      if (result.ok) onDone(result);
      else
        toastManager.add({
          type: "error",
          title: item.source === "tasks" ? "Could not complete task" : "Could not complete issue",
          description: result.error,
        });
    } catch {
      toastManager.add({
        type: "error",
        title: item.source === "tasks" ? "Could not complete task" : "Could not complete issue",
        description:
          item.source === "tasks"
            ? "Check the task in Google Tasks."
            : "Check the issue in Linear.",
      });
    } finally {
      pending.current = false;
      setWorking(false);
    }
  };

  if (item.source === "linear" || item.source === "tasks") {
    return (
      <Button
        variant="outline"
        size="sm"
        className="my-2 shrink-0"
        disabled={working}
        onClick={() => void complete()}
      >
        <CheckIcon aria-hidden />
        {working ? "Completing…" : "Mark complete"}
      </Button>
    );
  }

  if (
    (item.source !== "email" && item.source !== "slack") ||
    !item.canReply ||
    !bridge.getMissionControlReply
  )
    return null;
  const copy = replyCopy[item.source];

  const loadPreview = async () => {
    setOpen(true);
    setLoading(true);
    setError("");
    setPreview(undefined);
    try {
      const result = await bridge.getMissionControlReply(item.id);
      if (result.ok) setPreview(result);
      else setError(result.error);
    } catch {
      setError(copy.loadFailed);
    } finally {
      setLoading(false);
    }
  };

  const send = async () => {
    if (!preview || !body.trim() || pending.current) return;
    pending.current = true;
    setWorking(true);
    setError("");
    try {
      const result = await bridge.runMissionControlAction({
        kind: "reply",
        itemId: item.id,
        revision: preview.revision,
        body,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setBody("");
      setOpen(false);
      onDone(result);
    } catch {
      setError(copy.unconfirmed);
    } finally {
      pending.current = false;
      setWorking(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!pending.current) setOpen(value);
      }}
    >
      <Button
        variant="outline"
        size="sm"
        className="my-2 shrink-0"
        disabled={loading}
        onClick={() => void loadPreview()}
      >
        <ReplyIcon aria-hidden /> Reply
      </Button>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{preview?.subject || item.title}</DialogDescription>
        </DialogHeader>
        {loading && (
          <p role="status" className="text-sm text-muted-foreground">
            {copy.checking}
          </p>
        )}
        {preview && (
          <div className="space-y-3 text-sm">
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
              <dt>From</dt>
              <dd className="break-all" dir="ltr">
                {preview.from}
              </dd>
              <dt>To</dt>
              <dd className="break-all" dir="ltr">
                {preview.to}
              </dd>
            </dl>
            {preview.snippet && (
              <blockquote
                className="max-h-24 overflow-auto border-l pl-3 text-muted-foreground"
                dir="auto"
              >
                {preview.snippet}
              </blockquote>
            )}
            <label className="grid gap-1.5">
              Your reply
              <Textarea
                value={body}
                onChange={(event) => setBody(event.target.value)}
                disabled={working}
                maxLength={12000}
                rows={6}
                dir="auto"
              />
            </label>
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-error-foreground">
            {error}
          </p>
        )}
        <DialogFooter>
          {item.url && (
            <Button variant="outline" onClick={() => void bridge.openExternal(item.url!)}>
              {copy.open}
            </Button>
          )}
          {error && (
            <Button
              variant="outline"
              disabled={working || loading}
              onClick={() => void loadPreview()}
            >
              {copy.review}
            </Button>
          )}
          <Button
            disabled={!preview || !body.trim() || working || loading}
            onClick={() => void send()}
          >
            {working ? copy.sending : copy.send}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
