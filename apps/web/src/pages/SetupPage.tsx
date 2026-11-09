import { PASSWORD_MIN_LENGTH, type SetupStartResponse } from "@bursar/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AUTH_STATUS_KEY, api } from "../api";
import { Button, Card, ErrorText, Field } from "../components/ui";

export function SetupPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [setupCode, setSetupCode] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [enrolment, setEnrolment] = useState<SetupStartResponse | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [code, setCode] = useState("");

  const start = useMutation({ mutationFn: api.setupStart, onSuccess: setEnrolment });
  const confirm = useMutation({
    mutationFn: api.setupConfirm,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: AUTH_STATUS_KEY }),
  });

  useEffect(() => {
    if (!enrolment) return;
    let cancelled = false;
    QRCode.toDataURL(enrolment.otpauthUri, { margin: 1, width: 224 }).then((url) => {
      if (!cancelled) setQrDataUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [enrolment]);

  if (!enrolment) {
    const error = localError ?? (start.error ? t("setup.startFailed") : null);
    return (
      <Card>
        <h1 className="mb-2 text-xl font-semibold">{t("setup.title")}</h1>
        <p className="mb-6 text-sm text-slate-600">{t("setup.intro")}</p>
        <form
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
          {error && <ErrorText>{error}</ErrorText>}
          <Field
            label={t("setup.setupCode")}
            autoComplete="off"
            required
            value={setupCode}
            onChange={(event) => setSetupCode(event.target.value)}
          />
          <Field
            label={t("setup.password")}
            type="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <Field
            label={t("setup.passwordConfirm")}
            type="password"
            autoComplete="new-password"
            required
            value={passwordConfirm}
            onChange={(event) => setPasswordConfirm(event.target.value)}
          />
          <Button type="submit" disabled={start.isPending}>
            {t("setup.continue")}
          </Button>
        </form>
      </Card>
    );
  }

  return (
    <Card>
      <h1 className="mb-2 text-xl font-semibold">{t("setup.scanTitle")}</h1>
      <p className="mb-4 text-sm text-slate-600">{t("setup.scanHelp")}</p>
      {qrDataUrl && (
        <img src={qrDataUrl} alt={t("setup.qrAlt")} className="mx-auto mb-4 h-56 w-56" />
      )}
      <p className="mb-6 break-all rounded-md bg-slate-100 p-2 font-mono text-xs">
        {t("setup.manualSecret")}: {enrolment.secret}
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          confirm.mutate({ setupToken: enrolment.setupToken, code });
        }}
      >
        {confirm.error && <ErrorText>{t("setup.confirmFailed")}</ErrorText>}
        <Field
          label={t("setup.code")}
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="\d{6}"
          maxLength={6}
          required
          value={code}
          onChange={(event) => setCode(event.target.value.trim())}
        />
        <Button type="submit" disabled={confirm.isPending}>
          {t("setup.confirm")}
        </Button>
      </form>
    </Card>
  );
}
