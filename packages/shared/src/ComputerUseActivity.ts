export const DIRECTORY_NAME = "computer-use-activity";
export const HEARTBEAT_MS = 1_000;
export const EXPIRES_AFTER_MS = 4_000;

export interface ComputerUseActivity {
  readonly application: string | null;
  readonly startedAt: number;
  readonly heartbeatAt: number;
}

export function decodeActivity(contents: string): ComputerUseActivity | undefined {
  try {
    const value: unknown = JSON.parse(contents);
    if (value === null || typeof value !== "object") return undefined;
    const { application, startedAt, heartbeatAt } = value as Record<string, unknown>;
    if (
      (application !== null &&
        (typeof application !== "string" ||
          application.length === 0 ||
          application.length > 120 ||
          /\p{C}/u.test(application))) ||
      typeof startedAt !== "number" ||
      !Number.isFinite(startedAt) ||
      typeof heartbeatAt !== "number" ||
      !Number.isFinite(heartbeatAt)
    ) {
      return undefined;
    }
    return { application, startedAt, heartbeatAt };
  } catch {
    return undefined;
  }
}
