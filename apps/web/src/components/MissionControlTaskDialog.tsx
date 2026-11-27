import type {
  MissionControlActionRequest,
  MissionControlActionResult,
  MissionControlItem,
} from "@t3tools/contracts";
import { PencilIcon, PlusIcon } from "lucide-react";
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
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";

type Saved = Extract<MissionControlActionResult, { ok: true }>;

/** Adds a Google Task, or edits the given one, through the desktop app's Mission Control actions. */
export function MissionControlTaskButton({
  item,
  onSaved,
}: {
  item?: MissionControlItem;
  onSaved: (result: Saved) => void;
}) {
  const bridge = window.desktopBridge;
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [due, setDue] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);

  if (!bridge?.runMissionControlAction || (item && item.source !== "tasks")) return null;

  const initial = { title: item?.title ?? "", notes: item?.notes ?? "", due: item?.due ?? "" };
  // An edit sends only what changed, so it never overwrites a newer value made elsewhere.
  const request: MissionControlActionRequest | null = item
    ? {
        kind: "update-task",
        itemId: item.id,
        ...(title !== initial.title && { title }),
        ...(notes !== initial.notes && { notes }),
        ...(due !== initial.due && { due: due || null }),
      }
    : {
        kind: "create-task",
        title,
        ...(notes.trim() && { notes }),
        ...(due && { due }),
      };
  const changed = item ? Object.keys(request).length > 2 : true;
  const canSave = Boolean(title.trim()) && changed && !working;

  const show = () => {
    setTitle(initial.title);
    setNotes(initial.notes);
    setDue(initial.due);
    setError("");
    setOpen(true);
  };

  const save = async () => {
    if (!canSave || pending.current) return;
    pending.current = true;
    setWorking(true);
    setError("");
    try {
      const result = await bridge.runMissionControlAction(request);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      onSaved(result);
    } catch {
      setError("Google Tasks did not confirm this. Check Google Tasks before trying again.");
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
        className={item ? "my-2 shrink-0" : undefined}
        onClick={show}
      >
        {item ? <PencilIcon aria-hidden /> : <PlusIcon aria-hidden />}
        {item ? "Edit" : "Add task"}
      </Button>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{item ? "Edit task" : "Add a task"}</DialogTitle>
          <DialogDescription>
            {item ? "Changes save to Google Tasks." : "Adds to your default Google Tasks list."}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 text-sm">
          <label className="grid gap-1.5">
            Title
            <Input
              nativeInput
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              disabled={working}
              maxLength={1024}
              dir="auto"
            />
          </label>
          <label className="grid gap-1.5">
            Notes
            <Textarea
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              disabled={working}
              maxLength={8192}
              rows={4}
              dir="auto"
            />
          </label>
          <label className="grid gap-1.5">
            Due date
            <Input
              nativeInput
              type="date"
              value={due}
              onChange={(event) => setDue(event.target.value)}
              disabled={working}
            />
          </label>
        </div>
        {error && (
          <p role="alert" className="text-sm text-error-foreground">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button disabled={!canSave} onClick={() => void save()}>
            {working ? "Saving…" : item ? "Save changes" : "Add task"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
