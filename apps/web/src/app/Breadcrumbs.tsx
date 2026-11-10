import { ChevronRight } from "lucide-react";
import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { breadcrumbTrail, buildPath, type RouteId } from "./routes";

/**
 * Breadcrumb for an inner page: shipped ancestors as links, then the current page. `current`
 * replaces the route title for the last item (for example the account's display name).
 */
export function Breadcrumbs({ routeId, current }: { routeId: RouteId; current?: string }) {
  const { t } = useTranslation();
  const trail = breadcrumbTrail(routeId);
  const ancestors = trail.slice(0, -1).filter((def) => def.shipped);
  const self = trail[trail.length - 1];
  return (
    <nav aria-label={t("shell.breadcrumb")}>
      <ol className="flex flex-wrap items-center gap-1 text-sm text-muted">
        {ancestors.map((def) => (
          <Fragment key={def.id}>
            <li>
              <Link to={buildPath(def.id)} className="rounded-md hover:text-fg hover:underline">
                {t(def.titleKey)}
              </Link>
            </li>
            <li aria-hidden="true">
              <ChevronRight size={14} />
            </li>
          </Fragment>
        ))}
        <li aria-current="page" className="min-w-0 truncate font-medium text-fg">
          {current ?? (self ? t(self.titleKey) : "")}
        </li>
      </ol>
    </nav>
  );
}
