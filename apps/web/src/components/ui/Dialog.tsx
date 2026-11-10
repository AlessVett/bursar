import type { ReactNode } from "react";
import { Modal } from "./Modal";

export interface DialogProps {
  open: boolean;
  onClose(): void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}

export function Dialog({ open, onClose, title, children, footer }: DialogProps) {
  return (
    <Modal open={open} onClose={onClose} title={title} footer={footer} placement="center">
      {children}
    </Modal>
  );
}
