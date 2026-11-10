import { useTranslation } from "react-i18next";
import { useSaveState } from "../feedback";
import { cn } from "./cn";

/** Green dot "Saved"; pulsing amber "Saving…" while a mutation runs or right after a toast. */
export function SaveIndicator() {
  const { t } = useTranslation();
  const state = useSaveState();
  const saving = state === "saving";
  return (
    <span data-state={state} className="inline-flex items-center gap-2 text-[13px] text-muted">
      <span
        aria-hidden
        className={cn("size-2 rounded-full", saving ? "animate-pulse bg-warning" : "bg-positive")}
      />
      <span className="max-sm:sr-only">{saving ? t("feedback.saving") : t("feedback.saved")}</span>
    </span>
  );
}
