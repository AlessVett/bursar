import {
  formatLocalDate,
  type HomeAlert,
  type HomeSummary,
  localTimeOfDay,
  toLocalDate,
} from "@bursar/shared";
import { CircleCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ShippedLink } from "../../app/ShippedLink";
import { useFormatters } from "../../lib/format";
import { alertSeverity, alertTarget, sortAlerts, useAlertCopy } from "./AlertList";

export type GreetingPeriod = "morning" | "afternoon" | "evening";

export function greetingPeriod(now: number, timeZone: string): GreetingPeriod {
  const hour = Number(localTimeOfDay(now, timeZone).slice(0, 2));
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 18) return "afternoon";
  return "evening";
}

export type SummaryStatus =
  | { kind: "attention"; count: number; top: HomeAlert }
  | { kind: "allGood" }
  | { kind: "calm"; oldest: number | null }
  | { kind: "none" };

/** The one-sentence summary: urgent alerts first (info alerts never block "All good"). */
export function summaryStatus(summary: HomeSummary, now: number, timeZone: string): SummaryStatus {
  if (!summary.hasConnections || summary.accounts.length === 0) return { kind: "none" };
  const urgent = sortAlerts(summary.alerts).filter((alert) => alertSeverity(alert) !== "info");
  const top = urgent[0];
  if (top) return { kind: "attention", count: urgent.length, top };
  const today = toLocalDate(now, timeZone);
  const synced = summary.accounts.map((account) => account.lastSyncedAt);
  if (synced.every((at) => at !== null && toLocalDate(at, timeZone) === today)) {
    return { kind: "allGood" };
  }
  const known = synced.filter((at): at is number => at !== null);
  return { kind: "calm", oldest: known.length === synced.length ? Math.min(...known) : null };
}

function SummarySentence({ status }: { status: SummaryStatus }) {
  const { t } = useTranslation();
  const { relative } = useFormatters();
  const copy = useAlertCopy();
  switch (status.kind) {
    case "attention": {
      const target = alertTarget(status.top);
      return (
        <p className="text-sm text-muted sm:text-base">
          <span>{t("home.summary.attention", { count: status.count })}</span>{" "}
          <ShippedLink
            route={target.route}
            params={target.params}
            hash={target.hash}
            className="font-medium text-primary underline underline-offset-4"
            plainClassName="font-medium text-fg"
          >
            {copy(status.top).title}
          </ShippedLink>
        </p>
      );
    }
    case "allGood":
      return (
        <p className="flex items-center gap-2 text-sm text-positive sm:text-base">
          <CircleCheck aria-hidden="true" size={16} strokeWidth={2} />
          <span>{t("home.summary.allGood")}</span>
        </p>
      );
    case "calm":
      return (
        <p className="text-sm text-muted sm:text-base">
          {status.oldest === null
            ? t("home.summary.calmNever")
            : t("home.summary.calm", { when: relative(status.oldest) })}
        </p>
      );
    default:
      return null;
  }
}

/** Greeting with the local date and, once the summary is in, what needs attention. */
export function Greeting({ summary }: { summary: HomeSummary | undefined }) {
  const { t } = useTranslation();
  const { locale, timeZone, now } = useFormatters();
  const current = now();
  const today = formatLocalDate(toLocalDate(current, timeZone), locale, {
    style: "long",
    weekday: true,
  });
  const status = summary ? summaryStatus(summary, current, timeZone) : null;
  return (
    <header className="flex flex-col gap-1.5">
      <p className="text-sm text-muted first-letter:uppercase">{today}</p>
      <h1 className="font-display text-2xl font-semibold tracking-tight text-fg sm:text-3xl">
        {t(`home.greeting.${greetingPeriod(current, timeZone)}`)}
      </h1>
      {status ? <SummarySentence status={status} /> : null}
    </header>
  );
}
