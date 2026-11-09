import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError, AUTH_STATUS_KEY, api } from "../api";
import { Button, Card, ErrorText, Field } from "../components/ui";

export function LoginPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const login = useMutation({
    mutationFn: api.login,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: AUTH_STATUS_KEY }),
  });

  let errorMessage: string | null = null;
  if (login.error instanceof ApiError && login.error.status === 429)
    errorMessage = t("login.tooMany");
  else if (login.error) errorMessage = t("login.failed");

  return (
    <Card>
      <h1 className="mb-6 text-xl font-semibold">{t("login.title")}</h1>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          login.mutate({ password, code });
        }}
      >
        {errorMessage && <ErrorText>{errorMessage}</ErrorText>}
        <Field
          label={t("login.password")}
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <Field
          label={t("login.code")}
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="\d{6}"
          maxLength={6}
          required
          value={code}
          onChange={(event) => setCode(event.target.value.trim())}
        />
        <Button type="submit" disabled={login.isPending}>
          {t("login.submit")}
        </Button>
      </form>
    </Card>
  );
}
