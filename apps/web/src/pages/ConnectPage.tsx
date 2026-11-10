import type { AspspSummary, StartConnectionRequest } from "@bursar/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { KeyRound, TriangleAlert } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError, api } from "../api";
import { BackButton } from "../app/BackButton";
import { Breadcrumbs } from "../app/Breadcrumbs";
import { useSettingsQuery } from "../app/useSettingsQuery";
import { type FeedbackTone, feedback } from "../components/feedback";
import { Button, EmptyState, PageHeader } from "../components/ui";
import { useFormatters } from "../lib/format";
import { queryKeys } from "../lib/query-keys";
import { useUrlState } from "../lib/url-state";
import { BankStep } from "./connect/BankStep";
import { ConsentStep } from "./connect/ConsentStep";
import { CountryStep } from "./connect/CountryStep";
import { CURATED_COUNTRIES, countryName } from "./connect/countries";
import { isWizardStep, type WizardStepId, WizardSteps } from "./connect/WizardSteps";

/** Only web addresses are followed; the redirect comes from our server but costs nothing to check. */
function isNavigable(redirectUrl: string): boolean {
  try {
    const { protocol } = new URL(redirectUrl);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

interface StartNotice {
  title: string;
  detail: string;
  tone: FeedbackTone;
}

/** Toast for a failed `POST /api/connections`: the title names the outcome, the detail the fix. */
function startNotice(error: unknown, t: TFunction): StartNotice {
  if (error instanceof ApiError) {
    if (error.code === "banking_not_configured" || error.status === 503) {
      return {
        title: t("connect.errors.notConfigured.title"),
        detail: t("connect.errors.notConfigured.detail"),
        tone: "warning",
      };
    }
    switch (error.code) {
      case "unknown_bank":
        return {
          title: t("connect.errors.unknownBank.title"),
          detail: t("connect.errors.unknownBank.detail"),
          tone: "warning",
        };
      case "REDIRECT_URI_NOT_ALLOWED":
        return {
          title: t("connect.errors.redirectNotAllowed.title"),
          detail: t("connect.errors.redirectNotAllowed.detail"),
          tone: "error",
        };
      case "WRONG_ASPSP_PROVIDED":
        return {
          title: t("connect.errors.wrongBank.title"),
          detail: t("connect.errors.wrongBank.detail"),
          tone: "warning",
        };
      case "bank_error":
        return {
          title: t("connect.errors.bank.title"),
          detail: t("connect.errors.bank.detail"),
          tone: "error",
        };
    }
  }
  return {
    title: t("connect.errors.generic.title"),
    detail: t("connect.errors.generic.detail"),
    tone: "error",
  };
}

function isNotConfigured(error: unknown): boolean {
  return (
    error instanceof ApiError && (error.code === "banking_not_configured" || error.status === 503)
  );
}

function Notice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div
      role="status"
      className="mb-4 flex gap-3 rounded-2xl bg-warning-soft p-4 text-sm text-warning"
    >
      <TriangleAlert aria-hidden size={18} strokeWidth={1.75} className="mt-0.5 shrink-0" />
      <div className="min-w-0">
        <p className="font-semibold">{title}</p>
        <div className="mt-1 break-words">{children}</div>
      </div>
    </div>
  );
}

function WizardSkeleton() {
  const { t } = useTranslation();
  return (
    <div aria-busy="true" className="space-y-3">
      <span className="sr-only">{t("connect.loading")}</span>
      <div className="h-7 w-1/2 animate-pulse rounded-lg bg-surface-2" />
      <div className="h-11 w-full animate-pulse rounded-xl bg-surface-2" />
      <div className="h-11 w-1/3 animate-pulse rounded-xl bg-surface-2" />
    </div>
  );
}

export function ConnectPage() {
  const { t } = useTranslation();
  const { locale } = useFormatters();
  const queryClient = useQueryClient();
  const [url, setUrl] = useUrlState(
    { step: "country", country: "", bank: "" },
    {
      validate: {
        step: isWizardStep,
        country: (value) => /^[A-Z]{2}$/.test(value),
        bank: (value) => value.length <= 200,
      },
    },
  );

  const status = useQuery({
    queryKey: queryKeys.bankStatus,
    queryFn: () => api.bankStatus(),
    staleTime: 60_000,
  });
  const settings = useSettingsQuery();
  const configured = status.data?.configured === true;
  const hasCountry = url.country !== "";
  const requestedStep: WizardStepId = isWizardStep(url.step) ? url.step : "country";
  const aspsps = useQuery({
    queryKey: queryKeys.aspsps(url.country),
    queryFn: () => api.aspsps(url.country),
    enabled: configured && hasCountry && requestedStep !== "country",
    staleTime: 5 * 60_000,
  });
  const bank: AspspSummary | null =
    aspsps.data?.aspsps.find((item) => item.name === url.bank) ?? null;

  // The step that is shown never depends on data the URL cannot vouch for.
  let step: WizardStepId = requestedStep;
  if (!hasCountry) step = "country";
  else if (requestedStep === "consent" && url.bank === "") step = "bank";
  else if (requestedStep === "consent" && (aspsps.isError || (aspsps.isSuccess && bank === null)))
    step = "bank";
  const reachable: WizardStepId[] = ["country"];
  if (hasCountry) reachable.push("bank");
  if (bank) reachable.push("consent");

  const countries =
    status.data && status.data.countries.length > 0 ? status.data.countries : CURATED_COUNTRIES;
  const preselected = settings.data?.values.country ?? "";
  const [picked, setPicked] = useState<string | null>(null);
  const countryValue =
    picked ?? (hasCountry ? url.country : countries.includes(preselected) ? preselected : "");

  const start = useMutation({
    mutationFn: async (body: StartConnectionRequest) => {
      const response = await api.startConnection(body);
      if (!isNavigable(response.redirectUrl)) throw new Error("Unexpected redirect address");
      return response;
    },
    onSuccess: ({ redirectUrl }) => {
      window.location.assign(redirectUrl);
    },
    onError: (error) => {
      const notice = startNotice(error, t);
      feedback(notice.title, notice.detail, notice.tone);
      if (error instanceof ApiError && error.code === "unknown_bank") {
        setUrl({ step: "bank", bank: "" });
        void queryClient.invalidateQueries({ queryKey: queryKeys.aspsps(url.country) });
      }
      if (isNotConfigured(error)) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.bankStatus });
      }
    },
  });
  const submitting = start.isPending || start.isSuccess;

  // Back from the bank through the back-forward cache: the page comes back as it was left.
  const { reset: resetStart } = start;
  useEffect(() => {
    const onShow = (event: PageTransitionEvent) => {
      if (event.persisted) resetStart();
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, [resetStart]);

  const callbackUrl = (() => {
    const publicUrl = settings.data?.system.publicUrl;
    if (!publicUrl) return null;
    try {
      return new URL("/api/banks/callback", publicUrl).toString();
    } catch {
      return null;
    }
  })();

  let body: ReactNode;
  if (status.isPending || (settings.isPending && step === "country")) {
    body = <WizardSkeleton />;
  } else if (status.isError) {
    body = (
      <EmptyState
        kind="state"
        title={t("connect.statusError.title")}
        description={t("connect.statusError.description")}
        action={
          <Button variant="secondary" onClick={() => void status.refetch()}>
            {t("connect.retry")}
          </Button>
        }
      />
    );
  } else if (!configured || isNotConfigured(aspsps.error)) {
    body = (
      <EmptyState
        kind="state"
        icon={KeyRound}
        title={t("connect.notConfigured.title")}
        description={t("connect.notConfigured.description")}
      />
    );
  } else {
    let content: ReactNode;
    if (step === "country") {
      content = (
        <CountryStep
          countries={countries}
          value={countryValue}
          onChange={setPicked}
          onContinue={() => setUrl({ step: "bank", country: countryValue, bank: "" })}
        />
      );
    } else if (step === "bank") {
      content = (
        <BankStep
          countryLabel={countryName(url.country, locale)}
          query={aspsps}
          onPick={(chosen) => setUrl({ step: "consent", bank: chosen.name })}
          onChangeCountry={() => setUrl({ step: "country" })}
        />
      );
    } else if (bank) {
      content = (
        <ConsentStep
          key={`${bank.country}:${bank.name}`}
          bank={bank}
          settingsDays={settings.data?.values.consentDays ?? 180}
          submitting={submitting}
          onStart={(days) =>
            start.mutate({ aspspName: bank.name, aspspCountry: bank.country, consentDays: days })
          }
          onBack={() => setUrl({ step: "bank" })}
        />
      );
    } else {
      content = <WizardSkeleton />;
    }
    body = (
      <>
        {status.data?.active === false ? (
          <Notice title={t("connect.inactive.title")}>{t("connect.inactive.description")}</Notice>
        ) : null}
        {status.data?.redirectUrlAllowed === false ? (
          <Notice title={t("connect.redirectNotAllowed.title")}>
            {callbackUrl ? (
              <>
                <p>{t("connect.redirectNotAllowed.description")}</p>
                <code className="mt-2 block break-all rounded-lg bg-surface px-2 py-1 font-mono text-[13px] text-fg">
                  {callbackUrl}
                </code>
              </>
            ) : (
              <p>{t("connect.redirectNotAllowed.descriptionNoUrl")}</p>
            )}
          </Notice>
        ) : null}
        <WizardSteps
          current={step}
          reachable={reachable}
          onSelect={(target) => setUrl({ step: target })}
        />
        {content}
      </>
    );
  }

  return (
    <div className="max-w-2xl">
      <PageHeader
        title={t("connect.title")}
        subtitle={t("connect.subtitle")}
        breadcrumb={<Breadcrumbs routeId="connect" />}
        back={<BackButton routeId="connect" />}
      />
      {body}
    </div>
  );
}
