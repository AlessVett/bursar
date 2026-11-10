import { TriangleAlert } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router";
import { useSettingsQuery } from "../app/useSettingsQuery";
import { Button, EmptyState, PageHeader } from "../components/ui";
import { BackupsSection } from "./settings/BackupsSection";
import { BankingSection } from "./settings/BankingSection";
import { DisplaySection } from "./settings/DisplaySection";
import { GeneralSection } from "./settings/GeneralSection";
import { NotificationsSection } from "./settings/NotificationsSection";
import { SectionRegistryProvider, UnsavedBar } from "./settings/UnsavedBar";

const SKELETON_CARDS = ["first", "second", "third"] as const;

/** Scrolls to the element named by the URL hash once the cards exist (`/settings#backups`). */
function useScrollToHash(hash: string, ready: boolean): void {
  useEffect(() => {
    if (!ready || hash.length < 2) return;
    let id = hash.slice(1);
    try {
      id = decodeURIComponent(id);
    } catch {
      // A malformed escape: use the raw text.
    }
    document.getElementById(id)?.scrollIntoView?.({ block: "start" });
  }, [hash, ready]);
}

export function SettingsPage() {
  const { t } = useTranslation();
  const settings = useSettingsQuery();
  const { hash } = useLocation();
  useScrollToHash(hash, settings.isSuccess);

  return (
    <SectionRegistryProvider>
      <PageHeader title={t("routes.settings.title")} subtitle={t("settings.subtitle")} />
      {settings.isPending ? (
        <div aria-busy="true" className="flex max-w-3xl flex-col gap-5">
          {SKELETON_CARDS.map((id) => (
            <div
              key={id}
              className="h-40 animate-pulse rounded-2xl border border-subtle bg-surface-2"
            />
          ))}
        </div>
      ) : settings.isError ? (
        <EmptyState
          kind="state"
          icon={TriangleAlert}
          title={t("settings.loadFailed.title")}
          description={t("settings.loadFailed.body")}
          action={
            <Button variant="secondary" onClick={() => void settings.refetch()}>
              {t("shell.retry")}
            </Button>
          }
        />
      ) : (
        <div className="flex max-w-3xl flex-col gap-5">
          <GeneralSection settings={settings.data} index={0} />
          <BankingSection settings={settings.data} index={1} />
          <NotificationsSection settings={settings.data} index={2} />
          <DisplaySection settings={settings.data} index={3} />
          <BackupsSection settings={settings.data} index={4} />
          <UnsavedBar />
        </div>
      )}
    </SectionRegistryProvider>
  );
}
