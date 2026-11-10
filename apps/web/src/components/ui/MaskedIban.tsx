import { maskIbanDigitsForPrivacy } from "@bursar/shared";
import { useTranslation } from "react-i18next";
import { useUi } from "../../store/ui";
import { feedback } from "../feedback";
import { CopyButton } from "./CopyButton";

export interface MaskedIbanProps {
  /** The server-masked form, for example `IT60 •••• •••• 1234`. */
  masked: string;
  /** The full IBAN, only needed when `copyable`. */
  iban?: string | null;
  copyable?: boolean;
}

export function MaskedIban({ masked, iban, copyable = false }: MaskedIbanProps) {
  const { t } = useTranslation();
  const privacy = useUi((state) => state.privacy);
  return (
    <span className="inline-flex items-center gap-1">
      <span
        className="font-mono text-[13px] tracking-tight whitespace-nowrap text-muted"
        {...(privacy ? { role: "img", "aria-label": t("privacy.maskedIban") } : {})}
      >
        {privacy ? maskIbanDigitsForPrivacy(masked) : masked}
      </span>
      {copyable && iban ? (
        <CopyButton
          value={iban}
          label={t("copy.iban")}
          onCopied={() => feedback(t("copy.done"), t("copy.ibanDetail"), "info")}
        />
      ) : null}
    </span>
  );
}
