import { type ComponentProps, type ReactNode, useId } from "react";
import { cn } from "./cn";

const CONTROL =
  "block w-full rounded-lg border border-subtle bg-surface px-3 text-sm text-fg placeholder:text-muted disabled:opacity-50 aria-[invalid=true]:border-danger h-10 max-sm:h-11";

export function FieldError({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p id={id} role="alert" className="mt-1 text-[13px] text-danger">
      {children}
    </p>
  );
}

interface FieldShellProps {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}

function FieldShell({ id, label, hint, error, children }: FieldShellProps) {
  return (
    <div className="mb-4">
      <label htmlFor={id} className="mb-1 block text-[13px] font-medium text-fg">
        {label}
      </label>
      {children}
      {hint && !error ? (
        <p id={`${id}-hint`} className="mt-1 text-[13px] text-muted">
          {hint}
        </p>
      ) : null}
      {error ? <FieldError id={`${id}-error`}>{error}</FieldError> : null}
    </div>
  );
}

function describedBy(id: string, hint?: string, error?: string): string | undefined {
  if (error) return `${id}-error`;
  return hint ? `${id}-hint` : undefined;
}

export interface TextInputProps extends ComponentProps<"input"> {
  label: string;
  error?: string;
  hint?: string;
}

export function TextInput({ label, error, hint, className, id, ...props }: TextInputProps) {
  const generated = useId();
  const inputId = id ?? generated;
  return (
    <FieldShell id={inputId} label={label} hint={hint} error={error}>
      <input
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(inputId, hint, error)}
        className={cn(CONTROL, className)}
        {...props}
      />
    </FieldShell>
  );
}

export interface SelectProps extends ComponentProps<"select"> {
  label: string;
  options: { value: string; label: string }[];
  error?: string;
  hint?: string;
}

export function Select({ label, options, error, hint, className, id, ...props }: SelectProps) {
  const generated = useId();
  const selectId = id ?? generated;
  return (
    <FieldShell id={selectId} label={label} hint={hint} error={error}>
      <select
        id={selectId}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(selectId, hint, error)}
        className={cn(CONTROL, className)}
        {...props}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </FieldShell>
  );
}

export interface SwitchProps {
  label: string;
  description?: string;
  checked: boolean;
  onChange(checked: boolean): void;
  disabled?: boolean;
}

export function Switch({ label, description, checked, onChange, disabled }: SwitchProps) {
  const id = useId();
  return (
    <div className="mb-4 flex items-start justify-between gap-4">
      <div>
        <span id={`${id}-label`} className="block text-sm font-medium text-fg">
          {label}
        </span>
        {description ? (
          <span id={`${id}-description`} className="block text-[13px] text-muted">
            {description}
          </span>
        ) : null}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={`${id}-label`}
        aria-describedby={description ? `${id}-description` : undefined}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50 max-sm:my-1",
          checked ? "bg-primary" : "bg-surface-2 border border-subtle",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "absolute top-0.5 size-5 rounded-full bg-surface shadow transition-all",
            checked ? "left-[calc(100%-1.375rem)]" : "left-0.5",
          )}
        />
      </button>
    </div>
  );
}
