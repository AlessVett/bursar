import { Compass } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { HOME_LINK_CLASS } from "../app/ErrorBoundary";
import { EmptyState } from "../components/ui";

/** Unknown in-app path (also every route that is not shipped yet). Never shows the path or an id. */
export function NotFoundPage() {
  const { t } = useTranslation();
  return (
    <div className="py-12">
      <EmptyState
        kind="notFound"
        icon={Compass}
        title={t("errors.notFound.title")}
        description={t("errors.notFound.body")}
        action={
          <Link to="/" className={HOME_LINK_CLASS}>
            {t("errors.backHome")}
          </Link>
        }
      />
    </div>
  );
}
