export function StateBadge({
  state,
  degraded = false,
}: {
  state: string;
  degraded?: boolean;
}) {
  const label = degraded && state === "ready" ? "ready (degraded)" : state;
  const className =
    degraded && state === "ready"
      ? "badge badge-ready mono"
      : `badge badge-${state} mono`;
  return <span className={className}>{label}</span>;
}
