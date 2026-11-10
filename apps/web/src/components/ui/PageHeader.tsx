import type { ReactNode } from "react";
import { Badge } from "./Badge";

export interface PageHeaderProps {
  title: string;
  /** Total shown in a neutral badge next to the title. */
  count?: number;
  subtitle?: string;
  actions?: ReactNode;
  breadcrumb?: ReactNode;
  back?: ReactNode;
}

export function PageHeader({ title, count, subtitle, actions, breadcrumb, back }: PageHeaderProps) {
  return (
    <header className="mb-6">
      {breadcrumb ? <div className="mb-2 text-[13px] text-muted">{breadcrumb}</div> : null}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          {back}
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate font-display text-2xl font-bold text-fg">{title}</h1>
              {count !== undefined ? <Badge tone="neutral" count={count} /> : null}
            </div>
            {subtitle ? <p className="mt-1 text-sm text-muted">{subtitle}</p> : null}
          </div>
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </header>
  );
}
