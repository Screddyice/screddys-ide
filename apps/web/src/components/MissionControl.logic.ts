import { resolveSidebarThreadStatus } from "./Sidebar.logic";

export type MissionControlThreadStatus =
  | ReturnType<typeof resolveSidebarThreadStatus>
  | "settled"
  | "offline";

export function resolveMissionControlThreadStatus(
  thread: Parameters<typeof resolveSidebarThreadStatus>[0] & {
    readonly settledOverride: "settled" | "active" | null;
  },
  connected: boolean,
): MissionControlThreadStatus {
  if (thread.settledOverride === "settled") return "settled";
  return connected ? resolveSidebarThreadStatus(thread) : "offline";
}
