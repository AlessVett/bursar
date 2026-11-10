import { Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../components/ui/cn";

export type WizardStepId = "country" | "bank" | "consent";

/** The redirect to the bank is the action of the last step, not a step of its own. */
export const WIZARD_STEPS: readonly WizardStepId[] = ["country", "bank", "consent"];

export function isWizardStep(value: string): value is WizardStepId {
  return (WIZARD_STEPS as readonly string[]).includes(value);
}

export interface WizardStepsProps {
  current: WizardStepId;
  /** Steps the owner may jump to (completed ones). */
  reachable: readonly WizardStepId[];
  onSelect(step: WizardStepId): void;
}

/**
 * Step indicator that fits 390 px: numbered circles joined by lines; below `sm` only the current
 * label is drawn (the others stay readable for screen readers).
 */
export function WizardSteps({ current, reachable, onSelect }: WizardStepsProps) {
  const { t } = useTranslation();
  const currentIndex = WIZARD_STEPS.indexOf(current);
  return (
    <nav aria-label={t("connect.steps.label")} className="mb-6">
      <ol className="flex items-center gap-2">
        {WIZARD_STEPS.map((step, index) => {
          const label = t(`connect.steps.${step}`);
          const active = step === current;
          const done = index < currentIndex;
          const selectable = !active && reachable.includes(step);
          const content = (
            <>
              <span
                aria-hidden
                className={cn(
                  "inline-flex size-7 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold",
                  active
                    ? "bg-primary text-surface"
                    : done
                      ? "bg-primary-50 text-primary"
                      : "bg-surface-2 text-muted",
                )}
              >
                {done ? <Check size={14} strokeWidth={2.25} /> : index + 1}
              </span>
              <span
                className={cn(
                  "text-sm",
                  active ? "font-semibold text-fg" : "text-muted",
                  !active && "max-sm:sr-only",
                )}
              >
                {label}
              </span>
            </>
          );
          return (
            <li
              key={step}
              aria-current={active ? "step" : undefined}
              className="flex items-center gap-2"
            >
              {index > 0 ? <span aria-hidden className="h-px w-5 bg-subtle sm:w-8" /> : null}
              {selectable ? (
                <button
                  type="button"
                  onClick={() => onSelect(step)}
                  className="flex min-h-11 items-center gap-2 rounded-lg sm:min-h-0"
                >
                  {content}
                </button>
              ) : (
                <span className="flex items-center gap-2">{content}</span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
