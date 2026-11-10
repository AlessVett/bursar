import { useState } from "react";

/**
 * Thrown by a section's `save` to place messages next to fields. The keys are field names of the
 * section's values. An empty map means "the server refused, nothing to point at".
 */
export class SectionFormError extends Error {
  readonly fields: Readonly<Record<string, string>>;

  constructor(fields: Record<string, string>) {
    super("The section has invalid values");
    this.name = "SectionFormError";
    this.fields = fields;
  }
}

export interface SectionForm<T extends object> {
  /** The draft while editing, the saved values otherwise. */
  values: T;
  /** Changes one field of the draft; ignored when the section is not being edited. */
  set<K extends keyof T>(key: K, value: T[K]): void;
  /** True when the draft differs from the saved values. */
  dirty: boolean;
  editing: boolean;
  startEdit(): void;
  /** Throws the draft and the errors away. */
  cancel(): void;
  /**
   * Saves the draft. Never rejects: a `SectionFormError` fills `errors`, any other failure leaves
   * the section in edit mode and `save` is responsible for reporting it (a toast).
   */
  submit(): Promise<void>;
  saving: boolean;
  errors: Partial<Record<keyof T, string>>;
}

function sameValues<T extends object>(a: T, b: T): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof T>;
  for (const key of keys) {
    if (!Object.is(a[key], b[key])) return false;
  }
  return true;
}

/**
 * Inline edit state of one settings section (UX doc §4): read-only until `startEdit()`, a draft
 * while editing, and one `save` call on `submit()`. `initial` is the saved state; the parent
 * passes the new values after a successful save, which is what returns the card to read mode with
 * the saved values showing.
 */
export function useSectionForm<T extends object>(
  initial: T,
  save: (values: T) => Promise<void>,
): SectionForm<T> {
  const [draft, setDraft] = useState<T | null>(null);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<keyof T, string>>>({});

  const set = <K extends keyof T>(key: K, value: T[K]): void => {
    setDraft((current) => (current === null ? current : ({ ...current, [key]: value } as T)));
    setErrors((current) => {
      if (!(key in current)) return current;
      return Object.fromEntries(
        Object.entries(current).filter(([name]) => name !== String(key)),
      ) as Partial<Record<keyof T, string>>;
    });
  };

  const startEdit = (): void => {
    setDraft((current) => current ?? { ...initial });
    setErrors({});
  };

  const cancel = (): void => {
    setDraft(null);
    setErrors({});
  };

  const submit = async (): Promise<void> => {
    if (draft === null || saving) return;
    setSaving(true);
    try {
      await save(draft);
      setDraft(null);
      setErrors({});
    } catch (error) {
      if (error instanceof SectionFormError) {
        setErrors({ ...error.fields } as Partial<Record<keyof T, string>>);
      }
    } finally {
      setSaving(false);
    }
  };

  return {
    values: draft ?? initial,
    set,
    dirty: draft !== null && !sameValues(draft, initial),
    editing: draft !== null,
    startEdit,
    cancel,
    submit,
    saving,
    errors,
  };
}
