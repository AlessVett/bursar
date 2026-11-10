import type { TransactionDetail } from "@bursar/shared";
import { useQuery } from "@tanstack/react-query";
import { CircleAlert, FileQuestionMark, RotateCw } from "lucide-react";
import { type ReactNode, useId } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { ApiError, api } from "../../api";
import { buildPath } from "../../app/routes";
import { feedback } from "../../components/feedback";
import {
  Button,
  CopyButton,
  Drawer,
  InlineEmpty,
  MaskedIban,
  Money,
  RelativeTime,
  StatusPill,
} from "../../components/ui";
import { useFormatters } from "../../lib/format";
import { queryKeys } from "../../lib/query-keys";

/** A link styled as the primary button (navigation, not an action). */
export const PRIMARY_LINK_CLASS =
  "inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-bg transition-opacity hover:opacity-90 max-sm:min-h-11";

export interface TransactionDrawerProps {
  /** The open transaction (`tx` in the URL), or null when the drawer is closed. */
  id: number | null;
  onClose(): void;
}

function bankCodeText(code: NonNullable<TransactionDetail["bankCode"]>): string | null {
  const codes = [code.code, code.subCode]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" · ");
  if (code.description && codes) return `${code.description} (${codes})`;
  return code.description ?? (codes.length > 0 ? codes : null);
}

interface DetailRow {
  id: string;
  label: string;
  value: ReactNode;
}

function DetailBody({ detail }: { detail: TransactionDetail }) {
  const { t } = useTranslation();
  const { localDate } = useFormatters();
  const detailsId = useId();
  const remittanceId = useId();
  const pending = detail.status === "pending";
  const name = detail.counterparty ?? detail.description ?? t("transactions.noCounterparty");

  const rows: DetailRow[] = [];
  if (detail.bookingDate) {
    rows.push({
      id: "booking",
      label: t("transactions.drawer.bookingDate"),
      value: localDate(detail.bookingDate, "long"),
    });
  }
  if (detail.valueDate) {
    rows.push({
      id: "value",
      label: t("transactions.drawer.valueDate"),
      value: localDate(detail.valueDate, "long"),
    });
  }
  if (detail.transactionDate) {
    rows.push({
      id: "transaction",
      label: t("transactions.drawer.transactionDate"),
      value: localDate(detail.transactionDate, "long"),
    });
  }
  if (detail.counterpartyAccount) {
    rows.push({
      id: "counterpartyAccount",
      label: t("transactions.drawer.counterpartyAccount"),
      value: <MaskedIban masked={detail.counterpartyAccount} />,
    });
  }
  rows.push({
    id: "account",
    label: t("transactions.drawer.account"),
    value: t("transactions.drawer.accountAndBank", {
      account: detail.accountName,
      bank: detail.bankName,
    }),
  });
  const bankCode = detail.bankCode ? bankCodeText(detail.bankCode) : null;
  if (bankCode) {
    rows.push({ id: "bankCode", label: t("transactions.drawer.bankCode"), value: bankCode });
  }
  if (detail.merchantCategoryCode) {
    rows.push({
      id: "mcc",
      label: t("transactions.drawer.merchantCategoryCode"),
      value: <span className="font-mono text-[13px]">{detail.merchantCategoryCode}</span>,
    });
  }
  if (detail.balanceAfter) {
    rows.push({
      id: "balanceAfter",
      label: t("transactions.drawer.balanceAfter"),
      value: (
        <Money
          minor={detail.balanceAfter.amountMinor}
          currency={detail.balanceAfter.currency}
          tone="auto-balance"
        />
      ),
    });
  }
  const reference = detail.providerReference;
  if (reference) {
    rows.push({
      id: "reference",
      label: t("transactions.drawer.reference"),
      value: (
        <span className="inline-flex max-w-full items-center gap-1">
          <span className="min-w-0 font-mono text-[13px] break-all">{reference}</span>
          <CopyButton
            value={reference}
            label={t("transactions.drawer.copyReference")}
            onCopied={() =>
              feedback(t("copy.done"), t("transactions.drawer.referenceCopied"), "info")
            }
          />
        </span>
      ),
    });
  }
  rows.push({
    id: "firstSeen",
    label: t("transactions.drawer.firstSeen"),
    value: <RelativeTime at={detail.firstSeenAt} />,
  });

  return (
    <div className="space-y-6">
      <div>
        <p className="font-display text-3xl font-bold">
          <Money
            minor={detail.amountMinor}
            currency={detail.currency}
            sign="always"
            tone="auto-flow"
          />
        </p>
        <div className="mt-2">
          <StatusPill
            tone={pending ? "info" : "neutral"}
            label={pending ? t("transactions.pending") : t("transactions.booked")}
          />
        </div>
        <p className="mt-3 text-base font-semibold break-words text-fg">{name}</p>
        {detail.counterparty && detail.description ? (
          <p className="text-sm break-words text-muted">{detail.description}</p>
        ) : null}
      </div>
      {pending ? (
        <p className="rounded-xl bg-info-soft px-3 py-2 text-[13px] text-info">
          {t("transactions.drawer.pendingNote")}
        </p>
      ) : null}
      <section aria-labelledby={detailsId}>
        <h3
          id={detailsId}
          className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase"
        >
          {t("transactions.drawer.details")}
        </h3>
        <dl className="divide-y divide-subtle rounded-xl border border-subtle">
          {rows.map((row) => (
            <div
              key={row.id}
              className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)] gap-3 px-3 py-2.5 text-sm"
            >
              <dt className="text-muted">{row.label}</dt>
              <dd className="min-w-0 break-words text-fg">{row.value}</dd>
            </div>
          ))}
        </dl>
      </section>
      {detail.remittanceLines.length > 0 ? (
        <section aria-labelledby={remittanceId}>
          <h3
            id={remittanceId}
            className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase"
          >
            {t("transactions.drawer.remittance")}
          </h3>
          <ul className="space-y-1 rounded-xl bg-surface-2 px-3 py-2.5 font-mono text-[13px] text-fg">
            {detail.remittanceLines.map((line, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: remittance lines can repeat and have no identity
              <li key={`${index}-${line}`} className="break-words">
                {line}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function DetailSkeleton({ label }: { label: string }) {
  return (
    <div aria-busy="true" className="space-y-4">
      <span className="sr-only">{label}</span>
      <div className="h-9 w-40 animate-pulse rounded-lg bg-surface-2" />
      <div className="h-5 w-24 animate-pulse rounded-full bg-surface-2" />
      <div className="h-4 w-3/4 animate-pulse rounded bg-surface-2" />
      <div className="h-48 animate-pulse rounded-xl bg-surface-2" />
    </div>
  );
}

function DrawerError({
  error,
  retrying,
  onRetry,
}: {
  error: unknown;
  retrying: boolean;
  onRetry(): void;
}) {
  const { t } = useTranslation();
  if (error instanceof ApiError && error.status === 404) {
    return (
      <InlineEmpty
        icon={FileQuestionMark}
        title={t("transactions.drawer.notFound")}
        description={t("transactions.drawer.notFoundDescription")}
      />
    );
  }
  return (
    <div className="space-y-3">
      <InlineEmpty icon={CircleAlert} title={t("transactions.drawer.error")} />
      <Button variant="secondary" icon={RotateCw} loading={retrying} onClick={onRetry}>
        {t("transactions.drawer.retry")}
      </Button>
    </div>
  );
}

/**
 * The 520 px detail drawer of a transaction (full width below 640 px). It is the only place that
 * shows the bank reference (UX doc §4, business codes). Closing it removes `tx` from the URL.
 */
export function TransactionDrawer({ id, onClose }: TransactionDrawerProps) {
  const { t } = useTranslation();
  const detail = useQuery({
    queryKey: queryKeys.transaction(id ?? 0),
    queryFn: () => api.transaction(id ?? 0),
    enabled: id !== null,
  });
  const data = id === null ? undefined : detail.data;

  let body: ReactNode;
  if (data) body = <DetailBody detail={data} />;
  else if (detail.isError) {
    body = (
      <DrawerError
        error={detail.error}
        retrying={detail.isFetching}
        onRetry={() => void detail.refetch()}
      />
    );
  } else body = <DetailSkeleton label={t("transactions.drawer.loading")} />;

  return (
    <Drawer
      open={id !== null}
      onClose={onClose}
      title={t("transactions.drawer.title")}
      footer={
        data ? (
          <Link
            to={buildPath("account", { accountId: data.accountId })}
            className={PRIMARY_LINK_CLASS}
          >
            {t("transactions.drawer.openAccount")}
          </Link>
        ) : undefined
      }
    >
      {body}
    </Drawer>
  );
}
