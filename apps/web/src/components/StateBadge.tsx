export function StateBadge({ state }: { state: string }) {
  return <span className={`badge badge-${state} mono`}>{state}</span>;
}
