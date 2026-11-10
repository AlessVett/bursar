import type { ReactNode } from "react";
import { Modal } from "./Modal";

export interface DrawerProps {
  open: boolean;
  onClose(): void;
  title: string;
  /** Pixels; defaults to 520. Below 640 px the drawer is full width. */
  width?: number;
  footer?: ReactNode;
  children: ReactNode;
}

/** Side panel for a record preview: focus trap, Esc, focus restored to the opener. */
export function Drawer({ open, onClose, title, width = 520, footer, children }: DrawerProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      width={width}
      footer={footer}
      placement="right"
    >
      {children}
    </Modal>
  );
}
