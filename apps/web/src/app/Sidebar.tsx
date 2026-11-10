import { PanelLeftClose, PanelLeftOpen, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { NavLink } from "react-router";
import { Badge } from "../components/ui";
import { useFocusTrap } from "../lib/focus-trap";
import { useUi } from "../store/ui";
import { ProductMark } from "./AuthShell";
import { type NavBadge, useNavBadges } from "./nav-badges";
import { NAV_GROUPS, type NavGroup, type RouteDef, shippedRoutes } from "./routes";

const LABELLED_GROUPS = new Set<NavGroup>(["money", "knowledge", "agents"]);

function NavItem({
  def,
  badge,
  collapsed,
}: {
  def: RouteDef;
  badge: NavBadge | undefined;
  collapsed: boolean;
}) {
  const { t } = useTranslation();
  const label = t(def.titleKey);
  const Icon = def.icon;
  return (
    <li>
      <NavLink
        to={def.path}
        end={def.path === "/"}
        title={collapsed ? label : undefined}
        aria-label={collapsed ? label : undefined}
        className={({ isActive }) =>
          [
            "relative flex min-h-11 items-center gap-3 rounded-xl text-sm transition-colors lg:min-h-10",
            collapsed ? "justify-center px-0" : "px-3",
            isActive
              ? "bg-primary-50 font-semibold text-primary before:absolute before:inset-y-2 before:left-0 before:w-[3px] before:rounded-full before:bg-accent"
              : "font-medium text-muted hover:bg-surface-2 hover:text-fg",
          ].join(" ")
        }
      >
        <Icon aria-hidden size={18} strokeWidth={1.75} className="shrink-0" />
        {collapsed ? null : <span className="min-w-0 flex-1 truncate">{label}</span>}
        {badge && !collapsed ? <Badge tone={badge.tone} count={badge.count} /> : null}
        {badge && collapsed && badge.tone === "accent" ? (
          <span className="absolute right-3 top-2 size-2 rounded-full bg-accent">
            <span className="sr-only">{t("nav.needsAction", { count: badge.count })}</span>
          </span>
        ) : null}
      </NavLink>
    </li>
  );
}

/** The navigation list (shipped routes only, grouped as in UX doc §2). */
function SidebarNav({ collapsed }: { collapsed: boolean }) {
  const { t } = useTranslation();
  const badges = useNavBadges();
  const routes = shippedRoutes().filter((def) => def.group !== null);
  const sections = NAV_GROUPS.map((group) => ({
    group,
    items: routes.filter((def) => def.group === group),
  })).filter((section) => section.items.length > 0);
  const main = sections.filter((section) => section.group !== "bottom");
  const bottom = sections.find((section) => section.group === "bottom");

  return (
    <nav aria-label={t("nav.label")} className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {main.map((section) => (
          <div key={section.group} className="pt-3 first:pt-1">
            {LABELLED_GROUPS.has(section.group) ? (
              collapsed ? (
                <div aria-hidden="true" className="mx-3 mb-2 border-t border-subtle" />
              ) : (
                <p className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-muted">
                  {t(`nav.groups.${section.group}`)}
                </p>
              )
            ) : null}
            <ul className="flex flex-col gap-0.5">
              {section.items.map((def) => (
                <NavItem key={def.id} def={def} badge={badges[def.id]} collapsed={collapsed} />
              ))}
            </ul>
          </div>
        ))}
      </div>
      {bottom ? (
        <ul className="flex flex-col gap-0.5 border-t border-subtle px-3 py-3">
          {bottom.items.map((def) => (
            <NavItem key={def.id} def={def} badge={badges[def.id]} collapsed={collapsed} />
          ))}
        </ul>
      ) : null}
    </nav>
  );
}

function Brand({ collapsed }: { collapsed: boolean }) {
  const { t } = useTranslation();
  return (
    <div
      className={`flex h-16 shrink-0 items-center gap-3 ${collapsed ? "justify-center" : "px-5"}`}
    >
      <ProductMark size="sm" />
      {collapsed ? (
        <span className="sr-only">{t("app.name")}</span>
      ) : (
        <span className="font-display text-lg font-bold text-primary">{t("app.name")}</span>
      )}
    </div>
  );
}

/**
 * Desktop sidebar (from `lg`): 264 px, or a 76 px rail with native tooltips. Below `lg` the same
 * navigation opens as a drawer over a blurred backdrop; the shell closes it on every route change.
 */
export function Sidebar({
  drawerOpen,
  onCloseDrawer,
}: {
  drawerOpen: boolean;
  onCloseDrawer(): void;
}) {
  const { t } = useTranslation();
  const collapsed = useUi((state) => state.sidebarCollapsed);
  const toggleSidebar = useUi((state) => state.toggleSidebar);
  const drawerRef = useRef<HTMLDivElement>(null);
  useFocusTrap(drawerRef, drawerOpen);

  useEffect(() => {
    if (!drawerOpen) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onCloseDrawer();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [drawerOpen, onCloseDrawer]);

  const ToggleIcon = collapsed ? PanelLeftOpen : PanelLeftClose;
  const toggleLabel = collapsed ? t("nav.expand") : t("nav.collapse");

  return (
    <>
      <aside
        className={`fixed inset-y-0 left-0 z-30 hidden flex-col border-r border-subtle bg-surface lg:flex ${
          collapsed ? "w-19" : "w-66"
        }`}
      >
        <Brand collapsed={collapsed} />
        <SidebarNav collapsed={collapsed} />
        <div className={`border-t border-subtle p-3 ${collapsed ? "flex justify-center" : ""}`}>
          <button
            type="button"
            aria-label={toggleLabel}
            title={toggleLabel}
            className="grid size-9 place-items-center rounded-xl text-muted transition-colors hover:bg-surface-2 hover:text-fg"
            onClick={toggleSidebar}
          >
            <ToggleIcon aria-hidden size={18} strokeWidth={1.75} />
          </button>
        </div>
      </aside>
      {drawerOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            aria-hidden="true"
            className="absolute inset-0 bg-fg/30 backdrop-blur-sm"
            onClick={onCloseDrawer}
          />
          <div
            ref={drawerRef}
            role="dialog"
            aria-modal="true"
            aria-label={t("nav.label")}
            className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col bg-surface shadow-xl"
          >
            <div className="flex items-center justify-between pr-3">
              <Brand collapsed={false} />
              <button
                type="button"
                aria-label={t("nav.close")}
                title={t("nav.close")}
                className="grid size-11 place-items-center rounded-xl text-muted hover:bg-surface-2 hover:text-fg"
                onClick={onCloseDrawer}
              >
                <X aria-hidden size={20} />
              </button>
            </div>
            <SidebarNav collapsed={false} />
          </div>
        </div>
      ) : null}
    </>
  );
}
