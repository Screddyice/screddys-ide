// Grok Bot caps prefilled prompt text at 1,000 characters.
const GROK_BOT_PROMPT_MAX_LENGTH = 1000;

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
// the user still presses Send. Accept exactly id + text, never extra flags.
export function isGrokBotPromptUrl(url: URL): boolean {
  const text = url.searchParams.get("text") ?? "";
  return (
    hasGrokBotId(url) &&
    url.pathname === "/v1/prompt" &&
    url.searchParams.size === 2 &&
    text.trim().length > 0 &&
    [...text].length <= GROK_BOT_PROMPT_MAX_LENGTH
  );
}
