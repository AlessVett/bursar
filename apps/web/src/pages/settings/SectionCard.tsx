import { Pencil } from "lucide-react";
import type { FormEvent, KeyboardEvent, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button, Card, Cascade } from "../../components/ui";

/** The part of `useSectionForm`'s result the card needs. */
export interface SectionControls {
  editing: boolean;
  saving: boolean;
  startEdit(): void;
  cancel(): void;
  submit(): Promise<void>;
}

export interface SectionCardProps {
  /** Anchor id of the card; `backups` is the deep-link target of the notifications. */
  id: string;
  title: string;
  description: string;
  form: SectionControls;
  /** Position on the page, for the entry cascade. */
  index: number;
  children: ReactNode;
}

/**
 * A settings section: a titled card whose header switches between "Edit section" and
 * Cancel/Save (UX doc §4). The card is a form, so Enter saves and Escape cancels the edit.
 */
export function SectionCard({ id, title, description, form, index, children }: SectionCardProps) {
  const { t } = useTranslation();
  const titleId = `${id}-title`;

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void form.submit();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && form.editing && !form.saving) {
      event.stopPropagation();
      form.cancel();
    }
  };

  return (
    <Cascade index={index}>
      <Card id={id} role="region" aria-labelledby={titleId} padding="none" className="scroll-mt-24">
        <form noValidate onSubmit={onSubmit} onKeyDown={onKeyDown}>
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-subtle px-5 py-4">
            <div className="min-w-0">
              <h2 id={titleId} className="font-display text-base font-bold text-fg">
                {title}
              </h2>
              <p className="mt-0.5 text-[13px] text-muted">{description}</p>
            </div>
            {form.editing ? (
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={form.saving}
                  onClick={() => form.cancel()}
                >
                  {t("common.cancel")}
                </Button>
                <Button
                  size="sm"
                  type="submit"
                  loading={form.saving}
                  aria-label={t("settings.saveSectionNamed", { section: title })}
                >
                  {t("settings.saveSection")}
                </Button>
              </div>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                icon={Pencil}
                aria-label={t("settings.editSectionNamed", { section: title })}
                onClick={() => form.startEdit()}
              >
                {t("settings.editSection")}
              </Button>
            )}
          </div>
          <div className="px-5 py-4">{children}</div>
        </form>
      </Card>
    </Cascade>
  );
}

/** A label/value pair of the read-only view; place inside a `<dl>`. */
export function ReadRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted">{label}</dt>
      <dd className="mt-0.5 text-sm text-fg">{children}</dd>
    </div>
  );
}
