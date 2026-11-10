import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { feedback } from "../feedback";
import { IconButton } from "./IconButton";

export interface CopyButtonProps {
  value: string;
  /** Accessible name, for example "Copy IBAN". */
  label: string;
  onCopied?: () => void;
}

async function writeToClipboard(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Fall through to the textarea fallback (insecure context or denied permission).
  }
  const area = document.createElement("textarea");
  area.value = value;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

export function CopyButton({ value, label, onCopied }: CopyButtonProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy(): Promise<void> {
    if (await writeToClipboard(value)) {
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
      onCopied?.();
    } else {
      feedback(t("copy.failed"), t("copy.failedDetail"), "error");
    }
  }

  return (
    <IconButton
      label={label}
      icon={copied ? Check : Copy}
      data-copied={copied || undefined}
      onClick={() => void copy()}
    />
  );
}
