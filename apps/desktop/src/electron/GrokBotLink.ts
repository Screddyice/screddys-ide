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
