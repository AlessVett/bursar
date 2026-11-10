import { useFormatters } from "../../lib/format";

export interface RelativeTimeProps {
  /** Epoch milliseconds. */
  at: number;
  /** Adds the time of day to the absolute date in the tooltip (always true when relative). */
  withTime?: boolean;
}

/** "2 hours ago" under 45 days, a date beyond; the absolute date with time is in `title`. */
export function RelativeTime({ at, withTime = true }: RelativeTimeProps) {
  const { relative, absolute } = useFormatters();
  if (!Number.isFinite(at)) return <span>—</span>;
  return (
    <time
      dateTime={new Date(at).toISOString()}
      title={absolute(at, withTime)}
      className="whitespace-nowrap"
    >
      {relative(at)}
    </time>
  );
}
