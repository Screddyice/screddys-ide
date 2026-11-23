// @effect-diagnostics nodeBuiltinImport:off -- Invokes the locally configured JEV MCP launcher.
import * as NodeChildProcess from "node:child_process";

import { obj } from "./sources.ts";

type Question =
  | { type: "choice"; instructions: string; criteria: Readonly<Record<string, string>> }
  | { type: "score"; instructions: string; criteria: readonly string[] };

export function decideMissionControl(
  home: string,
  command: string,
  text: string,
  questions: Readonly<Record<string, Question>>,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.execFile(
      command,
      [],
      {
        env: { HOME: home, PATH: "/opt/homebrew/bin:/usr/bin:/bin" },
        timeout: 34_000,
        maxBuffer: 64_000,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        try {
          const messages = stdout
            .trim()
            .split("\n")
            .map((line) => obj(JSON.parse(line)));
          const response = obj(messages.find(({ id }) => id === 2)?.result);
          if (response.isError) throw new Error("JEV request failed");
          resolve(
            response.structuredContent ??
              JSON.parse(
                obj(Array.isArray(response.content) ? response.content[0] : undefined)
                  .text as string,
              ),
          );
        } catch (cause) {
          reject(cause);
        }
      },
    );
    child.stdin?.on("error", reject);
    child.stdin?.end(
      [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "screddy-mission-control", version: "2" },
          },
        },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "jev_decide", arguments: { state: { text }, questions } },
        },
      ]
        .map((message) => JSON.stringify(message))
        .join("\n") + "\n",
    );
  });
}
