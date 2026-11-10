import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";
import { ApiError, api } from "../api";
import { AuthNotice } from "../app/AuthShell";
import { Button, TextInput } from "../components/ui";
import { queryKeys } from "../lib/query-keys";

/** Sign-in with password and authenticator code. The guard sends the owner on to `next`. */
export function LoginPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const login = useMutation({
    mutationFn: api.login,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.authStatus }),
  });

  let errorMessage: string | null = null;
  if (login.error instanceof ApiError && login.error.status === 429)
    errorMessage = t("login.tooMany");
  else if (login.error) errorMessage = t("login.failed");
  const expired = searchParams.get("expired") === "1" && !login.isError;

  return (
    <>
      <h1 className="mb-1 font-display text-xl font-bold text-fg">{t("login.title")}</h1>
      <p className="mb-6 text-sm text-muted">{t("login.intro")}</p>
      {expired ? <AuthNotice tone="info">{t("login.sessionExpired")}</AuthNotice> : null}
      {errorMessage ? <AuthNotice tone="danger">{errorMessage}</AuthNotice> : null}
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          login.mutate({ password, code });
        }}
      >
        <TextInput
          label={t("login.password")}
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <TextInput
          label={t("login.code")}
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="\d{6}"
          maxLength={6}
          required
          value={code}
          onChange={(event) => setCode(event.target.value.trim())}
        />
        <Button type="submit" className="mt-2 w-full" loading={login.isPending}>
          {t("login.submit")}
        </Button>
      </form>
    </>
  );
}
