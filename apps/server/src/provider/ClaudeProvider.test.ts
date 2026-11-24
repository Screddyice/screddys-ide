import { describe, expect, it } from "@effect/vitest";

import { claudePlanAuthLabel, parseClaudePlanTier } from "./ClaudeProvider.ts";

describe("Claude plan label", () => {
  it("reads the plan tier that claude auth status reports", () => {
    const status = JSON.stringify({ loggedIn: true, subscriptionType: "max", planTier: "max_20x" });
    expect(parseClaudePlanTier(status)).toBe("max_20x");
    expect(parseClaudePlanTier("not json")).toBeUndefined();
    expect(
      parseClaudePlanTier(JSON.stringify({ loggedIn: false, planTier: null })),
    ).toBeUndefined();
  });

  it("names the 20x Max tier Ultra, which the subscription type alone cannot tell apart", () => {
    expect(claudePlanAuthLabel("max", "max_20x")).toBe("Claude Ultra Subscription");
    expect(claudePlanAuthLabel("max", "max_5x")).toBe("Claude Max Subscription");
    expect(claudePlanAuthLabel("max", undefined)).toBe("Claude Max Subscription");
    expect(claudePlanAuthLabel("pro", "max_20x")).toBe("Claude Pro Subscription");
  });
});
