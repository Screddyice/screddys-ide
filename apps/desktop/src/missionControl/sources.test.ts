// @effect-diagnostics nodeBuiltinImport:off -- Run the connector against an isolated executable and its output files.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

import { connector, readMail, readSlack, sourceHints, sourceStatus } from "./sources.ts";

it("explains why a source failed with fixed text, never the provider's own message", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "screddy-composio-test-"));
  try {
    const bin = NodePath.join(directory, ".composio");
    await NodeFSP.mkdir(bin);
    // `composio proxy <url> --toolkit <kit> --account <selector>` exits 0 and prints the provider body.
    await NodeFSP.writeFile(NodePath.join(bin, "composio"), '#!/bin/sh\ncat "$PWD/$6.json"\n', {
      mode: 0o700,
    });
    const api = connector(directory);
    const failed = async (account: string, body: unknown, slack = false) => {
      await NodeFSP.writeFile(NodePath.join(directory, `${account}.json`), JSON.stringify(body));
      const [outcome] = await Promise.allSettled([
        slack
          ? readSlack(api, account, "2026-11-27")
          : readMail(
              api,
              { label: "Consulting", email: "consult@example.com", selector: account },
              null,
              "inbox-replies",
            ),
      ]);
      return sourceStatus(slack ? "slack" : "email", "Consulting", outcome!);
    };
    const google = [
      {
        account: "disabled",
        code: 400,
        status: "FAILED_PRECONDITION",
        message: "Mail service not enabled",
        reason: "failedPrecondition",
        detail: /Google Workspace.*Admin console/,
      },
      {
        account: "expired",
        code: 401,
        status: "UNAUTHENTICATED",
        message: "Request had invalid authentication credentials.",
        detail: /expired.*Reconnect/,
      },
      {
        account: "denied",
        code: 403,
        status: "PERMISSION_DENIED",
        message: "Request had insufficient authentication scopes.",
        detail: /not allowed/,
      },
      {
        account: "limited",
        code: 403,
        status: "PERMISSION_DENIED",
        message: "User-rate limit exceeded.",
        reason: "userRateLimitExceeded",
        detail: /limiting requests/,
      },
      {
        account: "precondition",
        code: 400,
        status: "FAILED_PRECONDITION",
        message: "Precondition check failed.",
        reason: "failedPrecondition",
        detail: /^The existing connection did not return usable data\.$/,
      },
      {
        account: "unknown",
        code: 500,
        status: "INTERNAL",
        message: "Backend Error",
        detail: /^The existing connection did not return usable data\.$/,
      },
    ];
    const fixed = Object.values(sourceHints);
    for (const { account, detail, reason, ...error } of google) {
      const status = await failed(account, {
        error: { ...error, ...(reason && { errors: [{ reason }] }) },
      });
      expect(status.state).toBe("unavailable");
      expect(status.detail).toMatch(detail);
      expect(fixed).toContain(status.detail);
    }
    const slack = await failed("revoked", { ok: false, error: "token_revoked" }, true);
    expect(slack.state).toBe("unavailable");
    expect(slack.detail).toMatch(/expired.*Reconnect/);
    expect(fixed).toContain(slack.detail);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("reads a Composio result file only from that execution's temporary directory", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "screddy-composio-test-"));
  try {
    const outside = NodePath.join(directory, "outside.json");
    await NodeFSP.writeFile(
      outside,
      JSON.stringify({ successful: true, logId: "fixture", data: { result: [] } }),
    );
    const bin = NodePath.join(directory, ".composio");
    await NodeFSP.mkdir(bin);
    await NodeFSP.writeFile(
      NodePath.join(bin, "composio"),
      [
        "#!/bin/sh",
        'p="$TMPDIR/result.json"',
        'if [ "$4" = outside ]; then p="$PWD/outside.json"; fi',
        'if [ "$4" = link ]; then ln -s "$PWD/outside.json" "$p"; fi',
        'if [ "$4" = inside ]; then printf \'%s\' \'{"successful":true,"logId":"fixture","data":{"result":[1,2]}}\' > "$p"; fi',
        'printf \'{"successful":true,"storedInFile":true,"logId":"fixture","outputFilePath":"%s"}\\n\' "$p"',
      ].join("\n"),
      { mode: 0o700 },
    );
    const api = connector(directory);
    await expect(api.action("CUSTOM_NEBOS_LIST_WORKSTREAMS", "inside")).resolves.toEqual({
      result: [1, 2],
    });
    await expect(api.action("CUSTOM_NEBOS_LIST_WORKSTREAMS", "outside")).rejects.toThrow(/outside/);
    await expect(api.action("CUSTOM_NEBOS_LIST_WORKSTREAMS", "link")).rejects.toThrow(/outside/);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});
