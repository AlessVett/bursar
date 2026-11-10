import { PASSWORD_MIN_LENGTH, type SetupStartResponse } from "@bursar/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError, api } from "../api";
import { AuthNotice } from "../app/AuthShell";
import { Button, TextInput } from "../components/ui";
import { queryKeys } from "../lib/query-keys";

function startErrorMessage(error: unknown, t: (key: string) => string): string | null {
  if (!error) return null;
  if (error instanceof ApiError && error.status === 429) return t("setup.tooMany");
  return t("setup.startFailed");
}

/** First run: setup code and password, then the authenticator enrolment (QR or manual key). */
export function SetupPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [setupCode, setSetupCode] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [enrolment, setEnrolment] = useState<SetupStartResponse | null>(null);
  const [qr, setQr] = useState<{ url: string | null; failed: boolean }>({
    url: null,
    failed: false,
  });
  const [code, setCode] = useState("");

  const start = useMutation({ mutationFn: api.setupStart, onSuccess: setEnrolment });
  const confirm = useMutation({
    mutationFn: api.setupConfirm,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.authStatus }),
  });

  useEffect(() => {
    if (!enrolment) return;
    let cancelled = false;
    QRCode.toDataURL(enrolment.otpauthUri, { margin: 1, width: 224 })
      .then((url) => {
        if (!cancelled) setQr({ url, failed: false });
      })
      .catch(() => {
        if (!cancelled) setQr({ url: null, failed: true });
      });
    return () => {
      cancelled = true;
    };
  }, [enrolment]);

  if (!enrolment) {
    const error = localError ?? startErrorMessage(start.error, t);
    return (
      <>
        <h1 className="mb-1 font-display text-xl font-bold text-fg">{t("setup.title")}</h1>
        <p className="mb-6 text-sm text-muted">{t("setup.intro")}</p>
        {error ? <AuthNotice tone="danger">{error}</AuthNotice> : null}
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (password.length < PASSWORD_MIN_LENGTH) {
              setLocalError(t("setup.passwordTooShort", { min: PASSWORD_MIN_LENGTH }));
            } else if (password !== passwordConfirm) {
              setLocalError(t("setup.passwordMismatch"));
            } else {
              setLocalError(null);
              start.mutate({ setupCode, password });
            }
          }}
        >
          <TextInput
            label={t("setup.setupCode")}
            autoComplete="off"
            required
            value={setupCode}
            onChange={(event) => setSetupCode(event.target.value)}
          />
          <TextInput
            label={t("setup.password")}
            type="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            hint={t("setup.passwordHint", { min: PASSWORD_MIN_LENGTH })}
          />
          <TextInput
            label={t("setup.passwordConfirm")}
            type="password"
            autoComplete="new-password"
            required
            value={passwordConfirm}
            onChange={(event) => setPasswordConfirm(event.target.value)}
          />
          <Button type="submit" className="mt-2 w-full" loading={start.isPending}>
            {t("setup.continue")}
          </Button>
        </form>
      </>
    );
  }

  return (
    <>
      <h1 className="mb-1 font-display text-xl font-bold text-fg">{t("setup.scanTitle")}</h1>
      <p className="mb-4 text-sm text-muted">{t("setup.scanHelp")}</p>
      {qr.failed ? <AuthNotice tone="danger">{t("setup.qrFailed")}</AuthNotice> : null}
      {qr.url ? (
        <img
          src={qr.url}
          alt={t("setup.qrAlt")}
          className="mx-auto mb-4 size-56 rounded-xl border border-subtle bg-surface p-2"
        />
      ) : null}
      <p className="mb-6 break-all rounded-xl bg-surface-2 p-3 font-mono text-xs text-fg">
        {t("setup.manualSecret")}: {enrolment.secret}
      </p>
      {confirm.error ? <AuthNotice tone="danger">{t("setup.confirmFailed")}</AuthNotice> : null}
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          confirm.mutate({ setupToken: enrolment.setupToken, code });
        }}
      >
        <TextInput
          label={t("setup.code")}
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="\d{6}"
          maxLength={6}
          required
          value={code}
          onChange={(event) => setCode(event.target.value.trim())}
        />
        <Button type="submit" className="mt-2 w-full" loading={confirm.isPending}>
          {t("setup.confirm")}
        </Button>
      </form>
    </>
  );
}
