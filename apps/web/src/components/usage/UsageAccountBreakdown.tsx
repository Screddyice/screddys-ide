import type { UsageProviderKind } from "@t3tools/contracts";
import { formatCount, formatPercent, formatTokens, formatUsd } from "@t3tools/shared/usageFormat";
import { useNavigate } from "@tanstack/react-router";

import type { EnvironmentUsageStatus } from "../../state/usage";
import { InlineButton } from "../ui/button";
import { usageAccountRows, usageSourceName } from "./usageAccounts";
import { PROVIDER_PRESENTATION } from "./usageProviders";

/** Tokens or cost per account folder in the shown window, with a way to add more accounts. */
export function UsageAccountBreakdown({
  environments,
  hiddenProviders,
  metric,
}: {
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly hiddenProviders: ReadonlySet<UsageProviderKind>;
  readonly metric: "tokens" | "cost";
}) {
  const navigate = useNavigate();
  const rows = usageAccountRows(environments, hiddenProviders);
  const valueOf = (row: (typeof rows)[number]) =>
    metric === "tokens" ? row.totalTokens : row.costUsd;
  const total = rows.reduce((sum, row) => sum + valueOf(row), 0);
  const showEnvironment = new Set(rows.map((row) => row.environmentLabel)).size > 1;

  return (
    <div className="flex flex-col gap-3">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-right text-xs text-muted-foreground">
            <th className="py-2 pr-3 pl-2 text-left font-normal">#</th>
            <th className="w-full py-2 text-left font-normal">Account</th>
            <th className="hidden py-2 pl-6 font-normal sm:table-cell">Sessions</th>
            <th className="hidden py-2 pl-6 font-normal sm:table-cell">Share</th>
            <th className="py-2 pr-2 pl-6 font-normal">
              {metric === "tokens" ? "Tokens" : "Cost"}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={5} className="py-6 text-center text-muted-foreground">
                No activity in this window.
              </td>
            </tr>
          ) : (
            rows.map((row, index) => {
              // An unnamed row is already named by its home; a named account also shows where it lives.
              const where = row.account ? usageSourceName(row.provider, row.dir, undefined) : null;
              return (
                <tr
                  key={row.key}
                  className="border-b border-border/50 text-right whitespace-nowrap text-muted-foreground tabular-nums"
                >
                  <td className="py-2.5 pr-3 pl-2 text-left text-xs">{index + 1}</td>
                  <td className="py-2.5 text-left whitespace-normal">
                    <span className="flex items-center gap-2 text-foreground">
                      <span
                        aria-hidden
                        className="size-2 shrink-0 rounded-full"
                        style={{ backgroundColor: PROVIDER_PRESENTATION[row.provider].color }}
                      />
                      {row.name}
                    </span>
                    <span className="block text-xs break-all text-muted-foreground">
                      {PROVIDER_PRESENTATION[row.provider].label}
                      {row.status === "missing"
                        ? " · folder not found"
                        : where
                          ? ` · ${where}`
                          : ""}
                      {showEnvironment ? ` · ${row.environmentLabel}` : ""}
                    </span>
                  </td>
                  <td className="hidden py-2.5 pl-6 sm:table-cell">{formatCount(row.sessions)}</td>
                  <td className="hidden py-2.5 pl-6 sm:table-cell">
                    {total > 0 ? formatPercent(valueOf(row) / total) : ""}
                  </td>
                  <td className="py-2.5 pr-2 pl-6 text-foreground">
                    {metric === "tokens" ? formatTokens(row.totalTokens) : formatUsd(row.costUsd)}
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
      <div>
        <InlineButton onClick={() => void navigate({ to: "/settings/providers" })}>
          Add or manage usage accounts
        </InlineButton>
      </div>
    </div>
  );
}
