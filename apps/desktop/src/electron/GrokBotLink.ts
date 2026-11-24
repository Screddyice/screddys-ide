import { isGrokBotPromptLink } from "@t3tools/shared/grokBotPrompt";

function hasGrokBotId(url: URL): boolean {
  return (
    url.protocol === "grokbot:" &&
    url.host === "app" &&
    !url.username &&
    !url.password &&
    !url.hash &&
    /^[A-Za-z0-9_-]{1,128}$/.test(url.searchParams.get("id") ?? "")
  );
}

export function isGrokBotConversationUrl(url: URL): boolean {
  return hasGrokBotId(url) && url.pathname === "/v1/agent" && url.searchParams.size === 1;
}

// A prompt link only fills the named bot's message box; Grok Bot asks before filling it and
// the user still presses Send. Accept exactly id + text, and only text Grok Bot itself accepts.
export function isGrokBotPromptUrl(url: URL): boolean {
  return hasGrokBotId(url) && isGrokBotPromptLink(url.href);
}
