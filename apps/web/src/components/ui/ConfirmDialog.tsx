import { type ReactNode, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./Button";
import { Modal } from "./Modal";

export interface ConfirmDialogProps {
  open: boolean;
  /** `danger` for permanent actions (UX doc §7 level 3), `primary` for reversible ones. */
  tone: "primary" | "danger";
  /** A question for destructive actions: "Disconnect this bank?". */
  title: string;
  /** What changes, with real counts. */
  body: ReactNode;
  /** Repeats the verb: "Yes, disconnect". */
  confirmLabel: string;
  cancelLabel?: string;
  /** Forces the busy state from outside (a mutation owned by the caller). */
  busy?: boolean;
  /**
   * May return a promise. When it resolves the dialog closes itself by calling `onCancel`; when it
   * rejects the dialog stays open and the caller is expected to have reported the failure.
   */
  onConfirm(): void | Promise<void>;
  onCancel(): void;
}

export function ConfirmDialog({
  open,
  tone,
  title,
  body,
  confirmLabel,
  cancelLabel,
  busy,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  const running = useRef(false);
  const isBusy = Boolean(busy) || pending;

  async function confirm(): Promise<void> {
    if (running.current) return;
    running.current = true;
    setPending(true);
    try {
      await onConfirm();
      onCancel();
    } catch {
      // The caller reports the failure; the dialog stays open so the action can be retried.
    } finally {
      running.current = false;
      setPending(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      placement="center"
      role="alertdialog"
      dismissible={!isBusy}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={isBusy}>
            {cancelLabel ?? t("common.cancel")}
          </Button>
          <Button
            variant={tone === "danger" ? "danger" : "primary"}
            loading={isBusy}
            onClick={() => void confirm()}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-sm text-fg">{body}</div>
    </Modal>
  );
}
