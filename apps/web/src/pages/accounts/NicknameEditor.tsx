import { Check, Pencil, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { IconButton } from "../../components/ui";

export const NICKNAME_MAX_LENGTH = 80;

export interface NicknameEditorProps {
  /** The name shown now: the nickname, or the default name when there is none. */
  name: string;
  nickname: string | null;
  /** Shown in the empty field: what the name falls back to. */
  placeholder: string;
  disabled?: boolean;
  /** Where the name links to (the detail page), or `null`/omitted for plain text. */
  to?: string | null;
  /** Saves the nickname (`null` resets it). Reject to keep the editor open; the caller reports the failure. */
  onSave(nickname: string | null): Promise<void>;
}

/**
 * Inline rename: the pencil opens a field, Enter or the check saves, Escape or the cross cancels.
 * An empty field resets the name; an unchanged value closes without calling the API.
 */
export function NicknameEditor({
  name,
  nickname,
  placeholder,
  disabled = false,
  to = null,
  onSave,
}: NicknameEditorProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    } else if (returnFocus.current) {
      returnFocus.current = false;
      triggerRef.current?.focus();
    }
  }, [editing]);

  function start(): void {
    setValue(nickname ?? "");
    setEditing(true);
  }

  function cancel(): void {
    returnFocus.current = true;
    setEditing(false);
  }

  async function commit(): Promise<void> {
    if (saving) return;
    const trimmed = value.trim();
    const next = trimmed === "" ? null : trimmed;
    if (next === nickname) {
      cancel();
      return;
    }
    setSaving(true);
    try {
      await onSave(next);
      returnFocus.current = true;
      setEditing(false);
    } catch {
      // The caller already reported the failure; stay open so the typed text is not lost.
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    return (
      <div className="flex min-w-0 items-center gap-1">
        {to ? (
          <Link to={to} className="truncate font-medium text-fg hover:underline">
            {name}
          </Link>
        ) : (
          <span className="truncate font-medium text-fg">{name}</span>
        )}
        <IconButton
          ref={triggerRef}
          label={t("accounts.row.rename", { name })}
          icon={Pencil}
          disabled={disabled}
          onClick={start}
        />
      </div>
    );
  }

  return (
    <div className="flex min-w-0 items-center gap-1">
      <input
        ref={inputRef}
        type="text"
        value={value}
        maxLength={NICKNAME_MAX_LENGTH}
        placeholder={placeholder}
        aria-label={t("accounts.row.renameLabel")}
        enterKeyHint="done"
        disabled={saving}
        className="h-9 min-w-0 flex-1 rounded-lg border border-subtle bg-surface px-2 text-sm text-fg placeholder:text-muted"
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void commit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            cancel();
          }
        }}
      />
      <IconButton
        label={t("accounts.row.renameSave")}
        icon={Check}
        disabled={saving}
        onClick={() => void commit()}
      />
      <IconButton
        label={t("accounts.row.renameCancel")}
        icon={X}
        disabled={saving}
        onClick={cancel}
      />
    </div>
  );
}
