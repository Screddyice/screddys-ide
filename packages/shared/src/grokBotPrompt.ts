// Mirrors Grok Bot 1.2.3's prompt-link parser, which drops the whole link (filling nothing)
// unless the encoded link fits 2,048 characters and the text fits 1,000 UTF-16 units with no
// line breaks, control or hidden characters. A link never sends: the person presses Send.
export const GROK_BOT_PROMPT_MAX_LENGTH = 1000;
export const GROK_BOT_LINK_MAX_LENGTH = 2048;

const PROMPT_ROUTE = "grokbot://app/v1/prompt";
const BOT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const HIDDEN =
  /[\p{Cf}\p{Default_Ignorable_Code_Point}\u{E0000}-\u{E007F}\u202a-\u202e\u2066-\u2069]/u;
const HIDDEN_ALL = new RegExp(HIDDEN.source, "gu");
const ALLOWED = /^[\p{L}\p{M}\p{N}\p{P}\p{S}\p{Z}]+$/u;
const DISALLOWED_ALL = /[^\p{L}\p{M}\p{N}\p{P}\p{S}\p{Z}]/gu;
const LINE_BREAK = /\r\n|[\r\n\u2028\u2029\v\f\u0085]/g;
const ELLIPSIS = "…";

function canonicalLink(id: string, text: string) {
  return `${PROMPT_ROUTE}?id=${encodeURIComponent(id)}&text=${encodeURIComponent(text)}`;
}

function isPromptText(text: string) {
  return (
    text.trim().length > 0 &&
    text.length <= GROK_BOT_PROMPT_MAX_LENGTH &&
    ALLOWED.test(text) &&
    !HIDDEN.test(text)
  );
}

/** True when Grok Bot would accept this link and fill the bot's message box. */
export function isGrokBotPromptLink(link: string): boolean {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return false;
  }
  const id = url.searchParams.get("id") ?? "";
  const text = url.searchParams.get("text") ?? "";
  return (
    url.protocol === "grokbot:" &&
    url.host === "app" &&
    url.pathname === "/v1/prompt" &&
    !url.username &&
    !url.password &&
    !link.includes("#") &&
    url.searchParams.size === 2 &&
    BOT_ID.test(id) &&
    isPromptText(text) &&
    link.length <= GROK_BOT_LINK_MAX_LENGTH &&
    canonicalLink(id, text).length <= GROK_BOT_LINK_MAX_LENGTH
  );
}

/** Puts multi-line text on one line: paragraphs join with a space, lines with "; ". */
function oneLine(text: string) {
  return text
    .replace(LINE_BREAK, "\n")
    .split(/\n[^\S\n]*\n\s*/)
    .map((paragraph) =>
      paragraph
        .split("\n")
        .map((line) => line.replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .join("; "),
    )
    .filter(Boolean)
    .join(" ");
}

/**
 * Builds a link that types `text` into the named bot's message box, rewritten so Grok Bot
 * accepts it: one line, hidden characters dropped, and clipped with "…" to fit both limits.
 */
export function grokBotPromptLink(id: string, text: string): string | null {
  if (!BOT_ID.test(id)) return null;
  const clean = oneLine(text.replace(HIDDEN_ALL, "").replace(/\t/g, " "))
    .replace(DISALLOWED_ALL, "")
    .trim();
  if (!clean) return null;
  const budget = GROK_BOT_LINK_MAX_LENGTH - canonicalLink(id, "").length;
  if (clean.length <= GROK_BOT_PROMPT_MAX_LENGTH && encodeURIComponent(clean).length <= budget) {
    return canonicalLink(id, clean);
  }
  const ellipsisEncoded = encodeURIComponent(ELLIPSIS).length;
  let units = 0;
  let encoded = 0;
  let kept = "";
  for (const char of clean) {
    const charEncoded = encodeURIComponent(char).length;
    if (
      units + char.length + ELLIPSIS.length > GROK_BOT_PROMPT_MAX_LENGTH ||
      encoded + charEncoded + ellipsisEncoded > budget
    )
      break;
    kept += char;
    units += char.length;
    encoded += charEncoded;
  }
  const clipped = kept.trimEnd();
  return clipped ? canonicalLink(id, clipped + ELLIPSIS) : null;
}
