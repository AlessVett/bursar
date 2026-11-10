import {
  type AccountDetailResponse,
  addDays,
  SETTINGS_DEFAULTS,
  toLocalDate,
} from "@bursar/shared";
import { useQuery } from "@tanstack/react-query";
import {
  ChartNoAxesCombined,
  CircleAlert,
  CircleCheck,
  Info,
  type LucideIcon,
  TriangleAlert,
} from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { ApiError, api } from "../../api";
import { buildPath } from "../../app/routes";
import { useSettingsQuery } from "../../app/useSettingsQuery";
import { BalanceChart } from "../../components/charts/BalanceChart";
import { CashFlowStrip } from "../../components/charts/CashFlowStrip";
import { NetChip } from "../../components/charts/NetChip";
import { Button, Card, InlineEmpty } from "../../components/ui";
import { useFormatters } from "../../lib/format";
import { queryKeys } from "../../lib/query-keys";
import { useUi } from "../../store/ui";
import { type AccountAlert, type AccountTab, type AlertTone, deriveAlerts } from "./account-state";
import { errorLabel } from "./labels";
import { useAccountActions } from "./useAccountActions";

const BALANCE_DAYS = 90;
const CASHFLOW_DAYS = 30;

const ALERT_STYLE: Record<AlertTone, { box: string; Icon: LucideIcon }> = {
  danger: { box: "bg-danger-soft text-danger", Icon: CircleAlert },
  warning: { box: "bg-warning-soft text-warning", Icon: TriangleAlert },
  info: { box: "bg-info-soft text-info", Icon: Info },
};

const CTA_CLASS =
  "mt-1.5 inline-flex min-h-8 items-center rounded-md text-sm font-semibold underline underline-offset-2 disabled:opacity-60";

interface OverviewTabProps {
  detail: AccountDetailResponse;
  onSelectTab(tab: AccountTab): void;
}

/** Overview: contextual alerts or "All good", the 90-day balance and the 30-day cash flow. */
export function OverviewTab({ detail, onSelectTab }: OverviewTabProps) {
  return (
    <div className="space-y-5">
      <Alerts detail={detail} onSelectTab={onSelectTab} />
      <BalanceCard accountId={detail.account.id} currency={detail.account.currency} />
      <CashFlowCard accountId={detail.account.id} currency={detail.account.currency} />
    </div>
  );
}

function Alerts({ detail, onSelectTab }: OverviewTabProps) {
  const { t } = useTranslation();
  const { now, timeZone, relative, localDate } = useFormatters();
  const actions = useAccountActions(detail);
  const alerts = deriveAlerts(detail, now(), timeZone);

  if (alerts.length === 0) {
    const { lastSyncedAt } = detail.account;
    return (
      <div className="flex items-start gap-3 rounded-xl border border-subtle bg-surface-2 p-4">
        <CircleCheck aria-hidden size={18} className="mt-0.5 shrink-0 text-positive" />
        <p className="text-sm text-fg">
          {t("account.alerts.allGood", {
            when: lastSyncedAt === null ? "" : relative(lastSyncedAt),
            date: localDate(toLocalDate(detail.connection.validUntil, timeZone), "medium"),
          })}
        </p>
      </div>
    );
  }

  const text = (alert: AccountAlert): string =>
    t(`account.alerts.${alert.id}.text`, {
      bank: alert.values.bank,
      count: alert.values.count,
      when: alert.values.at === undefined ? "" : relative(alert.values.at),
      reason: errorLabel(t, alert.values.code ?? null),
    });

  const callToAction = (alert: AccountAlert): ReactNode => {
    const action = alert.action;
    if (action === null) return null;
    const label = `${t(`account.alerts.${alert.id}.cta`)} →`;
    if (action.kind === "accounts") {
      return (
        <Link to={buildPath("accounts")} className={CTA_CLASS}>
          {label}
        </Link>
      );
    }
    if (action.kind === "tab") {
      return (
        <button type="button" className={CTA_CLASS} onClick={() => onSelectTab(action.tab)}>
          {label}
        </button>
      );
    }
    return (
      <button
        type="button"
        className={CTA_CLASS}
        data-qa-skip={action.action === "renew" ? "" : undefined}
        disabled={actions.pending[action.action]}
        onClick={() => actions.run(action.action)}
      >
        {label}
      </button>
    );
  };

  return (
    <ul aria-label={t("account.alerts.label")} className="grid gap-3 md:grid-cols-2">
      {alerts.map((alert) => {
        const { box, Icon } = ALERT_STYLE[alert.tone];
        return (
          <li key={alert.id} className={`flex items-start gap-3 rounded-xl p-4 ${box}`}>
            <Icon aria-hidden size={18} className="mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{text(alert)}</p>
              {callToAction(alert)}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function SectionHeader({ title, aside }: { title: string; aside?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
      <h2 className="font-display text-base font-semibold text-fg">{title}</h2>
      {aside}
    </div>
  );
}

function ChartError({ onRetry }: { onRetry(): void }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
      <InlineEmpty
        icon={TriangleAlert}
        title={t("account.overview.chartErrorTitle")}
        description={t("account.overview.chartErrorDescription")}
      />
      <Button variant="secondary" size="sm" onClick={onRetry}>
        {t("account.retry")}
      </Button>
    </div>
  );
}

function BalanceCard({ accountId, currency }: { accountId: number; currency: string }) {
  const { t } = useTranslation();
  const { money, localDate } = useFormatters();
  const privacy = useUi((state) => state.privacy);
  const query = useQuery({
    queryKey: queryKeys.balanceHistory(accountId, BALANCE_DAYS),
    queryFn: () => api.balanceHistory(accountId, BALANCE_DAYS),
  });
  // A 404 means "no balance yet" (the API has nothing to compute the history from).
  const failed = query.isError && !(query.error instanceof ApiError && query.error.status === 404);
  const points = query.data?.points ?? [];
  const first = points[0];
  const last = points[points.length - 1];

  let summary = "";
  if (first && last) {
    const lowest = points.reduce((low, p) => (p.balanceMinor < low.balanceMinor ? p : low), first);
    const highest = points.reduce(
      (high, p) => (p.balanceMinor > high.balanceMinor ? p : high),
      first,
    );
    const masked = { masked: privacy };
    summary = t("account.overview.balanceSummary", {
      from: localDate(first.date, "medium"),
      to: localDate(last.date, "medium"),
      start: money(first.balanceMinor, currency, masked),
      end: money(last.balanceMinor, currency, masked),
      low: money(lowest.balanceMinor, currency, masked),
      high: money(highest.balanceMinor, currency, masked),
    });
  }

  return (
    <Card padding="lg">
      <SectionHeader
        title={t("account.overview.balanceTitle", { count: BALANCE_DAYS })}
        aside={
          first && last ? (
            <span className="inline-flex items-center gap-2 text-xs text-muted">
              <NetChip netMinor={last.balanceMinor - first.balanceMinor} currency={currency} />
              {t("account.overview.balanceChange", { count: BALANCE_DAYS })}
            </span>
          ) : null
        }
      />
      {query.isPending ? (
        <div aria-busy="true" className="h-60 animate-pulse rounded-xl bg-surface-2" />
      ) : failed ? (
        <ChartError onRetry={() => query.refetch()} />
      ) : points.length >= 2 ? (
        <BalanceChart points={points} currency={currency} summaryLabel={summary} />
      ) : (
        <InlineEmpty
          icon={ChartNoAxesCombined}
          title={t("account.overview.noBalanceTitle")}
          description={t("account.overview.noBalanceDescription")}
        />
      )}
    </Card>
  );
}

function CashFlowCard({ accountId, currency }: { accountId: number; currency: string }) {
  const { t } = useTranslation();
  const { money, localDate, now, timeZone } = useFormatters();
  const privacy = useUi((state) => state.privacy);
  const settings = useSettingsQuery();
  const to = toLocalDate(now(), timeZone);
  const from = addDays(to, 1 - CASHFLOW_DAYS);
  const query = useQuery({
    queryKey: queryKeys.cashflow({ accountId: String(accountId), currency, from, to }),
    queryFn: () => api.cashflow({ accountId, currency, from, to }),
  });
  const flow = query.data ?? null;
  const movements = flow !== null && flow.totals.count > 0 ? flow : null;

  return (
    <Card padding="lg">
      <SectionHeader
        title={t("account.overview.cashflowTitle", { count: CASHFLOW_DAYS })}
        aside={
          movements ? <NetChip netMinor={movements.totals.netMinor} currency={currency} /> : null
        }
      />
      {query.isPending ? (
        <div aria-busy="true" className="h-40 animate-pulse rounded-xl bg-surface-2" />
      ) : query.isError ? (
        <ChartError onRetry={() => query.refetch()} />
      ) : movements ? (
        <CashFlowStrip
          buckets={movements.buckets}
          currency={currency}
          variant="full"
          showBalance={false}
          highlightNegativeNet={
            settings.data?.values.highlightNegativeNet ?? SETTINGS_DEFAULTS.highlightNegativeNet
          }
          summaryLabel={t("account.overview.cashflowSummary", {
            from: localDate(movements.from, "medium"),
            to: localDate(movements.to, "medium"),
            net: money(movements.totals.netMinor, currency, { sign: "always", masked: privacy }),
            count: movements.totals.count,
          })}
        />
      ) : (
        <InlineEmpty
          icon={ChartNoAxesCombined}
          title={t("account.overview.cashflowEmptyTitle")}
          description={t("account.overview.cashflowEmptyDescription")}
        />
      )}
    </Card>
  );
}
