import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";

export function Card({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto mt-16 w-full max-w-md rounded-xl border border-subtle bg-surface p-6 shadow-sm">
      {children}
    </main>
  );
}

export function Field({
  label,
  ...input
}: { label: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="mb-4 block text-sm font-medium text-fg">
      {label}
      <input
        className="mt-1 block w-full rounded-md border border-muted bg-surface px-3 py-2 text-base text-fg"
        {...input}
      />
    </label>
  );
}

export function Button({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className="w-full rounded-md bg-primary px-4 py-2 text-sm font-semibold text-bg hover:bg-primary/90 disabled:opacity-50"
      {...props}
    >
      {children}
    </button>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="mb-4 text-sm text-danger">
      {children}
    </p>
  );
}
