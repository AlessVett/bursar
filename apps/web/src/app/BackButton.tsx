import { ChevronLeft } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { buildPath, type RouteId, routeById } from "./routes";

/** True when this page was the first one loaded in the tab (no in-app entry to go back to). */
function isFirstEntry(): boolean {
  const state: unknown = window.history.state;
  return (
    typeof state !== "object" ||
    state === null ||
    !("idx" in state) ||
    (state as { idx: unknown }).idx === 0
  );
}

/**
 * Back for an inner page. With in-app history it goes back one step; on a page opened directly
 * (`history.state.idx === 0`) it goes to the breadcrumb parent, so it never leaves the app.
 */
export function BackButton({ routeId }: { routeId: RouteId }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const parent = routeById(routeId).parent;
  return (
    <button
      type="button"
      className="inline-flex min-h-9 items-center gap-1 rounded-lg pr-2 text-sm font-medium text-muted transition-colors hover:text-fg"
      onClick={() => {
        if (isFirstEntry()) navigate(parent ? buildPath(parent) : "/", { replace: true });
        else navigate(-1);
      }}
    >
      <ChevronLeft aria-hidden size={16} />
      {t("shell.back")}
    </button>
  );
}
