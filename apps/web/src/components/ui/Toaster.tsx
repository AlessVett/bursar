import { Check, CircleAlert, Info, type LucideIcon, TriangleAlert, X } from "lucide-react";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { dismissToast, type FeedbackTone, type Toast, useToasts } from "../feedback";
import { cn } from "./cn";
import { IconButton } from "./IconButton";

const ICONS: Record<FeedbackTone, LucideIcon> = {
  success: Check,
  info: Info,
  warning: TriangleAlert,
  error: CircleAlert,
};

const ICON_TONES: Record<FeedbackTone, string> = {
  success: "text-positive",
  info: "text-info",
  warning: "text-warning",
  error: "text-danger",
};

function ToastCard({ toast }: { toast: Toast }) {
  const { t } = useTranslation();
  const Icon = ICONS[toast.tone];
  return (
    <motion.div
      data-tone={toast.tone}
      initial={{ opacity: 0, x: 16 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.18 }}
      className="pointer-events-auto flex items-start gap-3 rounded-xl border border-subtle bg-surface p-3 shadow-lg"
    >
      <Icon
        aria-hidden
        size={18}
        strokeWidth={2}
        className={cn("mt-0.5 shrink-0", ICON_TONES[toast.tone])}
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-fg">{toast.title}</p>
        {toast.detail ? <p className="mt-0.5 text-[13px] text-muted">{toast.detail}</p> : null}
      </div>
      <IconButton
        label={t("feedback.dismiss")}
        icon={X}
        className="-my-1 -mr-1 size-8"
        onClick={() => dismissToast(toast.id)}
      />
    </motion.div>
  );
}

/**
 * Mounted once by the app shell. The polite region carries success, info and warning toasts; the
 * assertive one carries errors, which stay until they are closed. Both regions always exist so
 * screen readers announce what is added to them.
 */
export function Toaster() {
  const { t } = useTranslation();
  const toasts = useToasts();
  return (
    <div className="pointer-events-none fixed top-4 right-4 z-[60] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2">
      <div
        role="status"
        aria-live="polite"
        aria-label={t("feedback.region")}
        className="flex flex-col gap-2"
      >
        {toasts
          .filter((toast) => toast.tone !== "error")
          .map((toast) => (
            <ToastCard key={toast.id} toast={toast} />
          ))}
      </div>
      <div
        role="alert"
        aria-live="assertive"
        aria-label={t("feedback.region")}
        className="flex flex-col gap-2"
      >
        {toasts
          .filter((toast) => toast.tone === "error")
          .map((toast) => (
            <ToastCard key={toast.id} toast={toast} />
          ))}
      </div>
    </div>
  );
}
