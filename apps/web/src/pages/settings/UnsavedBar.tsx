import { TriangleAlert } from "lucide-react";
import {
  createContext,
  type ReactNode,
  type RefObject,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui";

interface SectionStatus {
  dirty: boolean;
  saving: boolean;
}

interface SectionActions {
  submit(): Promise<void>;
  cancel(): void;
}

interface RegistryApi {
  report(id: string, status: SectionStatus): void;
  setActions(id: string, actions: SectionActions): void;
  forget(id: string): void;
}

interface RegistryState {
  statuses: Record<string, SectionStatus>;
  actions: RefObject<Map<string, SectionActions>>;
}

const RegistryApiContext = createContext<RegistryApi | null>(null);
const RegistryStateContext = createContext<RegistryState | null>(null);

/**
 * Lets the sticky bar know which sections are dirty and drive them (save all, discard all)
 * without lifting the five forms into the page. Sections register through `useRegisterSection`.
 */
export function SectionRegistryProvider({ children }: { children: ReactNode }) {
  const [statuses, setStatuses] = useState<Record<string, SectionStatus>>({});
  const actions = useRef(new Map<string, SectionActions>());

  const registry = useMemo<RegistryApi>(
    () => ({
      report: (id, status) =>
        setStatuses((current) => {
          const known = current[id];
          if (known && known.dirty === status.dirty && known.saving === status.saving) {
            return current;
          }
          return { ...current, [id]: status };
        }),
      setActions: (id, value) => {
        actions.current.set(id, value);
      },
      forget: (id) => {
        actions.current.delete(id);
        setStatuses((current) =>
          Object.fromEntries(Object.entries(current).filter(([key]) => key !== id)),
        );
      },
    }),
    [],
  );
  const state = useMemo<RegistryState>(() => ({ statuses, actions }), [statuses]);

  return (
    <RegistryApiContext.Provider value={registry}>
      <RegistryStateContext.Provider value={state}>{children}</RegistryStateContext.Provider>
    </RegistryApiContext.Provider>
  );
}

interface RegisterableForm {
  dirty: boolean;
  saving: boolean;
  submit(): Promise<void>;
  cancel(): void;
}

/** Registers a section's form with the registry. A no-op outside a `SectionRegistryProvider`. */
export function useRegisterSection(id: string, form: RegisterableForm): void {
  const registry = useContext(RegistryApiContext);
  const latest = useRef(form);
  useEffect(() => {
    latest.current = form;
  });
  useEffect(() => {
    registry?.setActions(id, {
      submit: () => latest.current.submit(),
      cancel: () => latest.current.cancel(),
    });
    return () => registry?.forget(id);
  }, [registry, id]);
  const { dirty, saving } = form;
  useEffect(() => {
    registry?.report(id, { dirty, saving });
  }, [registry, id, dirty, saving]);
}

/**
 * Sticky "Unsaved changes" bar (UX doc §4): visible while any section is dirty, with Save changes
 * and Discard changes for all of them, and a `beforeunload` warning for the same period.
 */
export function UnsavedBar() {
  const { t } = useTranslation();
  const state = useContext(RegistryStateContext);
  const statuses = state?.statuses ?? {};
  const dirtyIds = Object.entries(statuses)
    .filter(([, status]) => status.dirty)
    .map(([id]) => id);
  const saving = Object.values(statuses).some((status) => status.saving);
  const anyDirty = dirtyIds.length > 0;

  useEffect(() => {
    if (!anyDirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [anyDirty]);

  if (!state || !anyDirty) return null;

  const saveAll = async () => {
    for (const id of dirtyIds) await state.actions.current?.get(id)?.submit();
  };
  const discardAll = () => {
    for (const id of dirtyIds) state.actions.current?.get(id)?.cancel();
  };

  return (
    <section aria-label={t("settings.unsaved.region")} className="sticky bottom-4 z-20 mt-6">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-subtle bg-surface px-4 py-3 shadow-xl">
        <p className="flex items-center gap-2 text-sm font-semibold text-fg">
          <TriangleAlert aria-hidden size={18} strokeWidth={1.75} className="text-warning" />
          {t("settings.unsaved.title")}
          <span className="font-normal text-muted">
            {t("settings.unsaved.sections", { count: dirtyIds.length })}
          </span>
        </p>
        <div className="flex gap-2">
          <Button variant="ghost" disabled={saving} onClick={discardAll}>
            {t("settings.unsaved.discard")}
          </Button>
          <Button loading={saving} onClick={() => void saveAll()}>
            {t("settings.unsaved.save")}
          </Button>
        </div>
      </div>
    </section>
  );
}
