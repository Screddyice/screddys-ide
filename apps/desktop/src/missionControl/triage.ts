import type { MissionControlItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { contextOrder } from "./context.ts";

type GmailMessage = {
  readonly id?: string;
  readonly internalDate?: string;
  readonly labelIds?: readonly string[];
  readonly snippet?: string;
  readonly payload?: { readonly headers?: readonly { name: string; value: string }[] };
};

const ignoreLabels = new Set(["DRAFT", "SPAM", "TRASH"]);
const automated = /\b(?:no[-_. ]?reply|do[-_. ]?not[-_. ]?reply|mailer-daemon|notifications)\b/i;
const cold =
  /\b(?:cold outreach|quick intro(?:duction)?|reaching out (?:to introduce|because I noticed)|following up on my previous email|thought (?:I|we)(?:'d| would) reach out|noticed your (?:profile|company|website)|open to (?:a quick|a 15|a 10)|(?:book|schedule) (?:a|your) (?:demo|discovery call)|(?:grow|scale) your (?:pipeline|business)|qualified leads|guest post|link exchange|backlink|pay per lead|free (?:seo|website) audit)\b/i;
const request =
  /\?|\b(?:please|can you|could you|would you|let me know|need your|waiting on|respond|reply|approval|confirm|review|sign|thoughts|feedback)\b/i;

export function gmailHeader(message: GmailMessage, name: string) {
  return message.payload?.headers?.find((item) => item.name.toLowerCase() === name)?.value ?? "";
}

export function orderedGmailMessages(messages: readonly GmailMessage[]) {
  return messages
    .filter((message) => !message.labelIds?.some((label) => ignoreLabels.has(label)))
    .toSorted((a, b) => Number(b.internalDate) - Number(a.internalDate));
}

export function gmailThread(
  messages: readonly GmailMessage[],
  address: string,
):
  | {
      title: string;
      sender: string;
      activity: string;
      canReply: boolean;
      needsReply: boolean;
      important: boolean;
    }
  | undefined {
  const ordered = orderedGmailMessages(messages);
  const newest = ordered[0];
  const timestamp = Number(newest?.internalDate);
  if (!newest || !Number.isFinite(timestamp) || timestamp <= 0) return undefined;
  const title = gmailHeader(newest, "subject").trim() || "(No subject)";
  const sender = gmailHeader(newest, "from").trim();
  const labels = newest.labelIds ?? [];
  const sent = (message: GmailMessage) =>
    message.labelIds?.includes("SENT") ||
    gmailHeader(message, "from")
      .trim()
      .toLowerCase()
      .replace(/^.*<([^>]+)>$/, "$1") === address.toLowerCase();
  const established = ordered.slice(1).some(sent);
  const important = labels.includes("STARRED") || labels.includes("IMPORTANT");
  const text = `${title} ${newest.snippet ?? ""}`;
  const bulk = ["list-unsubscribe", "list-id", "auto-submitted", "precedence"].some((name) => {
    const value = gmailHeader(newest, name);
    return name === "auto-submitted" ? Boolean(value && value !== "no") : Boolean(value);
  });
  const canReply = Boolean(sender) && !sent(newest) && !automated.test(sender);
  return {
    title: title.slice(0, 220),
    sender: sender.replace(/\s*<[^>]+>$/, "").slice(0, 120),
    activity: DateTime.formatIso(DateTime.makeUnsafe(timestamp)),
    important,
    canReply,
    needsReply:
      canReply &&
      !bulk &&
      (established || (!cold.test(text) && !labels.includes("CATEGORY_PROMOTIONS"))) &&
      (established || request.test(text) || labels.includes("STARRED")),
  };
}

export function prioritize(
  items: readonly MissionControlItem[],
  today: string,
  lanes: readonly string[] = [],
  scores?: ReadonlyMap<string, number>,
) {
  const soon = DateTime.formatIsoDateUtc(DateTime.makeUnsafe(Date.parse(today) + 3 * 86_400_000));
  const rank = (item: MissionControlItem) =>
    item.due && item.due <= today
      ? 0
      : item.urgency === "urgent"
        ? 1
        : item.due && item.due <= soon
          ? 2
          : item.urgency === "high"
            ? 3
            : 4;
  return items.toSorted(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.due || "9999").localeCompare(b.due || "9999") ||
      contextOrder(a, lanes) - contextOrder(b, lanes) ||
      (scores?.get(b.id) ?? 1) - (scores?.get(a.id) ?? 1) ||
      b.activity.localeCompare(a.activity) ||
      a.id.localeCompare(b.id),
  );
}

export function safeProviderUrl(value: unknown, host: string, subdomains = false): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      (url.hostname === host || (subdomains && url.hostname.endsWith(`.${host}`)))
      ? url.href
      : null;
  } catch {
    return null;
  }
}
