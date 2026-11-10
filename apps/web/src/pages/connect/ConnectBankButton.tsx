import { Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { LinkButton } from "./LinkButton";

/** "Connect a bank": the entry point to the wizard from the Accounts header and the empty states. */
export function ConnectBankButton({ variant = "primary" }: { variant?: "primary" | "secondary" }) {
  const { t } = useTranslation();
  return (
    <LinkButton to="/connect" variant={variant} icon={Plus}>
      {t("connect.action")}
    </LinkButton>
  );
}
