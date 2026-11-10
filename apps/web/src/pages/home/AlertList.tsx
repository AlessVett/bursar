import type { HomeAlert } from "@bursar/shared";
import { CircleAlert, CircleCheck, Info, type LucideIcon, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { RouteId } from "../../app/routes";
import { ShippedLink } from "../../app/ShippedLink";
import { InlineEmpty } from "../../components/ui";
import { useFormatters } from "../../lib/format";
import { CONSENT_THRESHOLDS } from "../../lib/thresholds";

export type AlertSeverity = "danger" | "warning" | "info";

export function alertSeverity(alert: HomeAlert): AlertSeverity {
  switch (alert.kind) {
    case "consent_expired":
    case "connection_error":
    case "sync_failing":
    case "backup_failing":
      return "danger";
    case "consent_expiring":
      return alert.days <= CONSENT_THRESHOLDS.dangerDays ? "danger" : "warning";
    case "rate_limited":
      return "warning";
    default:
      return "info";
  }
}

const SEVERITY_RANK: Record<AlertSeverity, number> = { danger: 0, warning: 1, info: 2 };
const KIND_RANK: Record<HomeAlert["kind"], number> = {
  consent_expired: 0,
  connection_error: 1,
  sync_failing: 2,
  consent_expiring: 3,
  backup_failing: 4,
  rate_limited: 5,
  backup_local_only: 6,
};

/** Most urgent first: severity, then kind, then the nearest consent expiry. */
export function sortAlerts(alerts: readonly HomeAlert[]): HomeAlert[] {
  const days = (alert: HomeAlert) => (alert.kind === "consent_expiring" ? alert.days : 0);
  return [...alerts].sort(
    (a, b) =>
      SEVERITY_RANK[alertSeverity(a)] - SEVERITY_RANK[alertSeverity(b)] ||
      KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
      days(a) - days(b),
  );
}

export interface AlertTarget {
  route: RouteId;
  params?: Record<string, number>;
  hash?: string;
}

/** Where each alert is fixed. */
export function alertTarget(alert: HomeAlert): AlertTarget {
  switch (alert.kind) {
    case "consent_expiring":
    case "consent_expired":
    case "connection_error":
      return { route: "accounts" };
    case "sync_failing":
    case "rate_limited":
      return { route: "account", params: { accountId: alert.accountId } };
    default:
      return { route: "settings", hash: "backups" };
  }
}

export interface AlertCopy {
  title: string;
  description: string;
  action: string;
}

export function useAlertCopy(): (alert: HomeAlert) => AlertCopy {
  const { t } = useTranslation();
  const { relative, absolute } = useFormatters();
  return (alert) => {
    switch (alert.kind) {
      case "consent_expiring":
        return {
          title:
            alert.days <= 0
              ? t("alerts.consentExpiresToday", { bank: alert.bankName })
              : t("alerts.consentExpiring", { bank: alert.bankName, count: alert.days }),
          description: t("alerts.consentExpiringDetail"),
          action: t("alerts.renewConsent"),
        };
      case "consent_expired":
        return {
          title: t("alerts.consentExpired", { bank: alert.bankName }),
          description: t("alerts.consentExpiredDetail"),
          action: t("alerts.renewConsent"),
        };
      case "connection_error":
        return {
          title: t("alerts.connectionError", { bank: alert.bankName }),
          description: t("alerts.connectionErrorDetail"),
          action: t("alerts.reviewConnection"),
        };
      case "sync_failing":
        return {
          title: t("alerts.syncFailing", { account: alert.accountName }),
          description:
            alert.since === null
              ? t("alerts.syncFailingNeverDetail")
              : t("alerts.syncFailingDetail", { when: relative(alert.since) }),
          action: t("alerts.openAccount"),
        };
      case "rate_limited":
        return {
          title: t("alerts.rateLimited", {
            account: alert.accountName,
            time: absolute(alert.until, true),
          }),
          description: t("alerts.rateLimitedDetail"),
          action: t("alerts.openAccount"),
        };
      case "backup_local_only":
        return {
          title: t("alerts.backupLocalOnly"),
          description: t("alerts.backupLocalOnlyDetail"),
          action: t("alerts.openBackups"),
        };
      case "backup_failing":
        return {
          title: t("alerts.backupFailing", { count: alert.failures }),
          description: t("alerts.backupFailingDetail"),
          action: t("alerts.openBackups"),
        };
    }
  };
}

function alertKey(alert: HomeAlert): string {
  switch (alert.kind) {
    case "consent_expiring":
    case "consent_expired":
    case "connection_error":
      return `${alert.kind}-${alert.connectionId}`;
    case "sync_failing":
    case "rate_limited":
      return `${alert.kind}-${alert.accountId}`;
    default:
      return alert.kind;
  }
}

const SEVERITY_STYLE: Record<AlertSeverity, { icon: LucideIcon; classes: string }> = {
  danger: { icon: CircleAlert, classes: "text-danger bg-danger-soft" },
  warning: { icon: TriangleAlert, classes: "text-warning bg-warning-soft" },
  info: { icon: Info, classes: "text-info bg-info-soft" },
};

/** Home alert list: most urgent first, each with the action that fixes it. */
export function AlertList({ alerts }: { alerts: readonly HomeAlert[] }) {
  const { t } = useTranslation();
  const copy = useAlertCopy();
  const sorted = sortAlerts(alerts);
  return (
    <section
      aria-labelledby="home-alerts"
      className="rounded-2xl border border-subtle bg-surface p-4 sm:p-6"
    >
      <h2 id="home-alerts" className="font-display text-base font-semibold text-fg">
        {t("home.alerts.title")}
      </h2>
      {sorted.length === 0 ? (
        <div className="mt-4">
          <InlineEmpty icon={CircleCheck} title={t("home.alerts.empty")} />
        </div>
      ) : (
        <ul className="mt-4 flex flex-col gap-3">
          {sorted.map((alert) => {
            const style = SEVERITY_STYLE[alertSeverity(alert)];
            const Icon = style.icon;
            const text = copy(alert);
            const target = alertTarget(alert);
            return (
              <li key={alertKey(alert)} className="flex gap-3 rounded-xl bg-surface-2 p-3">
                <span
                  className={`flex size-8 shrink-0 items-center justify-center rounded-full ${style.classes}`}
                >
                  <Icon aria-hidden="true" size={16} strokeWidth={2} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-fg">{text.title}</p>
                  <p className="mt-0.5 text-xs text-muted">{text.description}</p>
                  <ShippedLink
                    route={target.route}
                    params={target.params}
                    hash={target.hash}
                    whenUnshipped="hide"
                    className="mt-2 inline-flex min-h-6 items-center text-xs font-medium text-primary underline-offset-4 hover:underline"
                  >
                    {text.action}
                  </ShippedLink>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
