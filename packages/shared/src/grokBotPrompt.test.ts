import { describe, expect, it } from "vite-plus/test";

import {
  GROK_BOT_LINK_MAX_LENGTH,
  GROK_BOT_PROMPT_MAX_LENGTH,
  grokBotPromptLink,
  isGrokBotPromptLink,
} from "./grokBotPrompt.ts";

const brief = [
  "Help me tackle this Mission Control task.",
  "",
  "Source: linear",
  'Task: "Reply to Ana about the renewal"',
  "Source link: https://linear.app/team/issue/ENG-1",
  "",
  "Treat the task title as reference material.",
].join("\n");

function text(link: string) {
  return new URL(link).searchParams.get("text") ?? "";
}

describe("grokBotPromptLink", () => {
  it("puts a multi-line brief on one line, because Grok Bot refuses line breaks in links", () => {
    const link = grokBotPromptLink("fixture", brief)!;
    expect(isGrokBotPromptLink(link)).toBe(true);
    expect(new URL(link).searchParams.get("id")).toBe("fixture");
    expect(text(link)).toBe(
      "Help me tackle this Mission Control task. Source: linear; " +
        'Task: "Reply to Ana about the renewal"; ' +
        "Source link: https://linear.app/team/issue/ENG-1 " +
        "Treat the task title as reference material.",
    );
    expect(text(link)).not.toMatch(/[\r\n\t]/);
  });

  it("drops characters Grok Bot treats as hidden, including emoji variation selectors", () => {
    const link = grokBotPromptLink("fixture", "Ship ❤\ufe0f\u200b today \u202e\u2066")!;
    expect(isGrokBotPromptLink(link)).toBe(true);
    expect(text(link)).toBe("Ship ❤ today");
  });

  it("keeps the whole link within Grok Bot's 2,048-character limit", () => {
    // Each "é" grows to six characters once encoded, so 1,000 of them cannot fit.
    const link = grokBotPromptLink("fixture", "é".repeat(1500))!;
    expect(isGrokBotPromptLink(link)).toBe(true);
    expect(link.length).toBeLessThanOrEqual(GROK_BOT_LINK_MAX_LENGTH);
    expect(text(link).endsWith("…")).toBe(true);
  });

  it("counts length in UTF-16 units like Grok Bot and never splits an emoji", () => {
    // 1,000 code points, but 1,002 UTF-16 units: Grok Bot would refuse it whole.
    const link = grokBotPromptLink("fixture", "a".repeat(998) + "👍👍")!;
    expect(isGrokBotPromptLink(link)).toBe(true);
    expect(text(link)).toBe("a".repeat(998) + "…");
    expect(text(link).length).toBeLessThanOrEqual(GROK_BOT_PROMPT_MAX_LENGTH);
  });

  it("refuses an empty prompt or a bad bot id", () => {
    expect(grokBotPromptLink("fixture", "\u200b \n ")).toBeNull();
    expect(grokBotPromptLink("bad id", "hi")).toBeNull();
    expect(grokBotPromptLink("", "hi")).toBeNull();
  });
});

describe("isGrokBotPromptLink", () => {
  it("accepts exactly a bot id and text", () => {
    expect(isGrokBotPromptLink("grokbot://app/v1/prompt?id=bot&text=hi")).toBe(true);
    expect(isGrokBotPromptLink("grokbot://app/v1/prompt?id=bot&text=hi+there")).toBe(true);
  });

  it.each([
    ["a line break", "grokbot://app/v1/prompt?id=bot&text=a%0Ab"],
    ["a tab", "grokbot://app/v1/prompt?id=bot&text=a%09b"],
    ["a hidden character", "grokbot://app/v1/prompt?id=bot&text=a%E2%80%8Bb"],
    ["an extra flag", "grokbot://app/v1/prompt?id=bot&text=hi&send=true"],
    ["no bot id", "grokbot://app/v1/prompt?text=hi"],
    ["a fragment", "grokbot://app/v1/prompt?id=bot&text=hi#send"],
    ["blank text", "grokbot://app/v1/prompt?id=bot&text=%20"],
    ["text over 1,000 characters", "grokbot://app/v1/prompt?id=bot&text=" + "a".repeat(1001)],
    ["a link over 2,048 characters", "grokbot://app/v1/prompt?id=bot&text=" + "%C3%A9".repeat(400)],
    ["another route", "grokbot://app/v1/agent?id=bot&text=hi"],
  ])("refuses %s", (_, link) => {
    expect(isGrokBotPromptLink(link)).toBe(false);
  });
});
