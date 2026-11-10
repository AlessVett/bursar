import { TriangleAlert } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { isRouteErrorResponse, useRouteError } from "react-router";

export const HOME_LINK_CLASS =
  "inline-flex min-h-10 items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-surface transition-colors hover:bg-primary/90";

const SECONDARY_BUTTON_CLASS =
  "inline-flex min-h-10 items-center justify-center gap-2 rounded-xl border border-subtle bg-surface px-4 text-sm font-semibold text-fg transition-colors hover:bg-surface-2";

/**
 * The styled message shown when a page crashes. It uses a plain link to Home (a full load) so it also
 * works outside the router. `data-error-boundary` lets the QA run detect it.
 */
export function ErrorFallback({ fullPage }: { fullPage: boolean }) {
  const { t } = useTranslation();
  return (
    <div
      data-error-boundary=""
      className={`grid place-items-center px-4 ${fullPage ? "min-h-dvh bg-bg" : "py-16"}`}
    >
      <div
        role="alert"
        className="w-full max-w-md rounded-2xl border border-subtle bg-surface p-8 text-center shadow-sm"
      >
        <span className="mx-auto mb-4 grid size-12 place-items-center rounded-2xl bg-danger-soft text-danger">
          <TriangleAlert aria-hidden size={24} strokeWidth={1.75} />
        </span>
        <h1 className="font-display text-xl font-bold text-fg">{t("errors.crash.title")}</h1>
        <p className="mt-2 text-sm text-muted">{t("errors.crash.body")}</p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <button
            type="button"
            className={SECONDARY_BUTTON_CLASS}
            onClick={() => window.location.reload()}
          >
            {t("errors.reload")}
          </button>
          <a href="/" className={HOME_LINK_CLASS}>
            {t("errors.backHome")}
          </a>
        </div>
      </div>
    </div>
  );
}

/** `errorElement` of the router: a loader, lazy import or render error inside a route. */
export function RouteErrorBoundary() {
  const error = useRouteError();
  if (!isRouteErrorResponse(error)) console.error(error);
  return <ErrorFallback fullPage={false} />;
}

interface AppErrorBoundaryState {
  failed: boolean;
}

/** The last safety net around the whole router: a crash outside any route shows the same message. */
export class AppErrorBoundary extends Component<{ children: ReactNode }, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(error, info.componentStack);
  }

  render(): ReactNode {
    return this.state.failed ? <ErrorFallback fullPage /> : this.props.children;
  }
}
