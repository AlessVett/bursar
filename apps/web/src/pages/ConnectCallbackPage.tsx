import {
  type CompleteConnectionRequest,
  type CompleteConnectionResponse,
  completeConnectionRequestSchema,
} from "@bursar/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Ban,
  CircleAlert,
  CircleCheck,
  Clock,
  Info,
  KeyRound,
  type LucideIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError, api } from "../api";
import { BackButton } from "../app/BackButton";
import { Breadcrumbs } from "../app/Breadcrumbs";
import { Badge, Card, MaskedIban, PageHeader } from "../components/ui";
import { cn } from "../components/ui/cn";
import { queryKeys } from "../lib/query-keys";
import { ConnectBankButton } from "./connect/ConnectBankButton";
import { LinkButton } from "./connect/LinkButton";

/**
 * Parameters of the bank's redirect (`state`, `code`, `error`, `error_description`) as a request
 * body, or `null` when the URL does not carry a usable response. Bank-supplied text is truncated to
 * what the API accepts; `state` is never truncated, a state of the wrong length is simply unusable.
 */
export function parseCallbackSearch(search: string): CompleteConnectionRequest | null {
  const params = new URLSearchParams(search);
  const candidate: Record<string, string> = {};
  const state = params.get("state");
  if (state) candidate.state = state;
  const code = params.get("code");
  if (code) candidate.code = code.slice(0, 512);
  const error = params.get("error");
  if (error) candidate.error = error.slice(0, 200);
  const description = params.get("error_description");
  if (description) candidate.errorDescription = description.slice(0, 512);
  if (!candidate.state || (!candidate.code && !candidate.error)) return null;
  const parsed = completeConnectionRequestSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/** Removes the one-time parameters from the address bar without adding a history entry. */
function stripParameters(): void {
  window.history.replaceState(window.history.state, "", window.location.pathname);
}

function restoreParameters(search: string): void {
  window.history.replaceState(window.history.state, "", `${window.location.pathname}${search}`);
}

type Tone = "success" | "warning" | "danger" | "info";

const TONE_CLASSES: Record<Tone, string> = {
  success: "bg-primary-50 text-positive",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
  info: "bg-info-soft text-info",
};

interface OutcomeCardProps {
  outcome: string;
  tone: Tone;
  icon: LucideIcon;
  title: string;
  description?: string;
  busy?: boolean;
  /** Move focus to the heading when the card appears (every result, not the pending card). */
  focus?: boolean;
  actions?: ReactNode;
  children?: ReactNode;
}

function OutcomeCard({
  outcome,
  tone,
  icon: Icon,
  title,
  description,
  busy = false,
  focus = true,
  actions,
  children,
}: OutcomeCardProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focus) heading.current?.focus();
  }, [focus]);
  return (
    <Card
      padding="lg"
      role="status"
      aria-live="polite"
      aria-busy={busy || undefined}
      data-outcome={outcome}
    >
      <div className="flex items-start gap-4">
        <span
          className={cn(
            "inline-flex size-11 shrink-0 items-center justify-center rounded-2xl",
            TONE_CLASSES[tone],
          )}
        >
          <Icon aria-hidden size={22} strokeWidth={1.75} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 ref={heading} tabIndex={-1} className="font-display text-xl font-bold text-fg">
            {title}
          </h2>
          {description ? <p className="mt-1 text-sm text-muted">{description}</p> : null}
          {children}
          {actions ? <div className="mt-5 flex flex-wrap gap-2">{actions}</div> : null}
        </div>
      </div>
    </Card>
  );
}

function AccountsFound({ response }: { response: CompleteConnectionResponse }) {
  const { t } = useTranslation();
  if (response.accounts.length === 0) return null;
  return (
    <div className="mt-4">
      <p className="text-[13px] font-medium text-muted">
        {t("connect.callback.accountsFound", { count: response.accounts.length })}
      </p>
      <ul className="mt-2 divide-y divide-subtle rounded-xl border border-subtle">
        {response.accounts.map((account) => (
          <li key={account.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5">
            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-fg">
              {account.name}
            </span>
            {account.maskedIdentifier ? <MaskedIban masked={account.maskedIdentifier} /> : null}
            <Badge tone="neutral">{account.currency}</Badge>
          </li>
        ))}
      </ul>
      <p className="mt-3 flex items-start gap-2 text-sm text-fg">
        <Info aria-hidden size={16} strokeWidth={1.75} className="mt-0.5 shrink-0 text-info" />
        {t("connect.callback.syncStarted")}
      </p>
    </div>
  );
}

export function ConnectCallbackPage() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  // Read once: the first render sees the parameters, the first effect strips them.
  const [initial] = useState(() => ({
    search: window.location.search,
    body: parseCallbackSearch(window.location.search),
  }));

  const mutation = useMutation({
    mutationFn: async (body: CompleteConnectionRequest) => {
      try {
        return await api.completeConnection(body);
      } catch (error) {
        // Session expired on the way back: restore the address so login can resume with `next`.
        if (error instanceof ApiError && error.status === 401) restoreParameters(initial.search);
        throw error;
      }
    },
    onSuccess: (response) => {
      if (response.outcome === "connected" || response.outcome === "renewed") {
        void queryClient.invalidateQueries({ queryKey: queryKeys.connections });
        void queryClient.invalidateQueries({ queryKey: queryKeys.summary });
        void queryClient.invalidateQueries({ queryKey: ["accounts"] });
      }
    },
  });

  const started = useRef(false);
  const { mutate } = mutation;
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    stripParameters();
    if (initial.body) mutate(initial.body);
  }, [initial.body, mutate]);

  const tryAgain = <LinkButton to="/connect">{t("connect.callback.tryAgain")}</LinkButton>;
  const startAgain = <LinkButton to="/connect">{t("connect.callback.startAgain")}</LinkButton>;

  let card: ReactNode;
  if (!initial.body) {
    card = (
      <OutcomeCard
        outcome="missing"
        tone="info"
        icon={Info}
        title={t("connect.callback.missing.title")}
        description={t("connect.callback.missing.description")}
        actions={
          <>
            <ConnectBankButton />
            <LinkButton to="/accounts" variant="secondary">
              {t("connect.callback.openAccounts")}
            </LinkButton>
          </>
        }
      />
    );
  } else if (mutation.isError) {
    const error = mutation.error;
    if (error instanceof ApiError && error.status === 401) {
      card = (
        <OutcomeCard
          outcome="pending"
          tone="info"
          icon={Clock}
          busy
          focus={false}
          title={t("connect.callback.pending.title")}
        />
      );
    } else if (
      error instanceof ApiError &&
      (error.status === 410 || error.code === "state_invalid")
    ) {
      card = (
        <OutcomeCard
          outcome="state_invalid"
          tone="warning"
          icon={Clock}
          title={t("connect.callback.stateInvalid.title")}
          description={t("connect.callback.stateInvalid.description")}
          actions={startAgain}
        />
      );
    } else if (
      error instanceof ApiError &&
      (error.code === "banking_not_configured" || error.status === 503)
    ) {
      card = (
        <OutcomeCard
          outcome="unavailable"
          tone="warning"
          icon={KeyRound}
          title={t("connect.callback.unavailable.title")}
          description={t("connect.callback.unavailable.description")}
          actions={startAgain}
        />
      );
    } else {
      card = (
        <OutcomeCard
          outcome="error"
          tone="danger"
          icon={CircleAlert}
          title={t("connect.callback.error.title")}
          description={t("connect.callback.error.description")}
          actions={startAgain}
        />
      );
    }
  } else if (mutation.data) {
    const response = mutation.data;
    if (response.outcome === "connected" || response.outcome === "renewed") {
      card = (
        <OutcomeCard
          outcome={response.outcome}
          tone="success"
          icon={CircleCheck}
          title={t(`connect.callback.${response.outcome}.title`)}
          description={t(`connect.callback.${response.outcome}.description`, {
            bank: response.bankName,
          })}
          actions={<LinkButton to="/accounts">{t("connect.callback.openAccounts")}</LinkButton>}
        >
          <AccountsFound response={response} />
        </OutcomeCard>
      );
    } else if (response.outcome === "no_accounts") {
      card = (
        <OutcomeCard
          outcome="no_accounts"
          tone="warning"
          icon={CircleAlert}
          title={t("connect.callback.noAccounts.title")}
          description={t("connect.callback.noAccounts.description", { bank: response.bankName })}
          actions={tryAgain}
        >
          <ol className="mt-4 list-decimal space-y-2 pl-5 text-sm text-fg">
            <li>{t("connect.callback.noAccounts.step1")}</li>
            <li>{t("connect.callback.noAccounts.step2")}</li>
            <li>{t("connect.callback.noAccounts.step3")}</li>
          </ol>
        </OutcomeCard>
      );
    } else if (response.outcome === "denied") {
      card = (
        <OutcomeCard
          outcome="denied"
          tone="info"
          icon={Ban}
          title={t("connect.callback.denied.title")}
          description={t("connect.callback.denied.description")}
          actions={tryAgain}
        />
      );
    } else {
      const code = response.errorCode;
      const key =
        code && /^[A-Z_]{3,64}$/.test(code) ? `connect.callback.failed.codes.${code}` : null;
      card = (
        <OutcomeCard
          outcome="failed"
          tone="danger"
          icon={CircleAlert}
          title={t("connect.callback.failed.title")}
          description={key && i18n.exists(key) ? t(key) : t("connect.callback.failed.generic")}
          actions={tryAgain}
        />
      );
    }
  } else {
    card = (
      <OutcomeCard
        outcome="pending"
        tone="info"
        icon={Clock}
        busy
        focus={false}
        title={t("connect.callback.pending.title")}
        description={t("connect.callback.pending.description")}
      />
    );
  }

  return (
    <div className="max-w-2xl">
      <PageHeader
        title={t("routes.connectCallback.title")}
        breadcrumb={<Breadcrumbs routeId="connectCallback" />}
        back={<BackButton routeId="connectCallback" />}
      />
      {card}
    </div>
  );
}
