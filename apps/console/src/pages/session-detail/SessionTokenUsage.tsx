import { useI18n } from "../../i18n";
import { formatTokens, readTokenUsage } from "./token-usage";

/** Session token consumption only — no dollar cost, no budget editor. */
export function SessionTokenUsage({ usage }: { usage: unknown }) {
  const { t } = useI18n();
  const tokens = readTokenUsage(usage);
  if (tokens === null) return null;
  const items: Array<[string, number]> = [
    [t.sessions.tokensInput, tokens.input],
    [t.sessions.tokensOutput, tokens.output],
    [t.sessions.tokensCacheRead, tokens.cacheRead],
    [t.sessions.tokensCacheWrite, tokens.cacheWrite],
  ];
  return (
    <div className="flex items-center gap-3 text-xs text-fg-muted flex-wrap" data-testid="session-token-usage">
      {items.map(([label, value]) => (
        <span key={label}>
          {label}: <span className="text-fg tabular-nums">{formatTokens(value)}</span>
        </span>
      ))}
    </div>
  );
}
