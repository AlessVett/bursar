import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearToasts, useToasts } from "../components/feedback";
import i18n from "../i18n";
import { announceBackupFinished } from "./backup-toast";

describe("announceBackupFinished", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    clearToasts();
  });

  it("announces a finished backup as a success toast", () => {
    const { result } = renderHook(() => useToasts());
    act(() => announceBackupFinished("succeeded"));
    expect(result.current).toHaveLength(1);
    expect(result.current[0]).toMatchObject({
      title: "Backup completed",
      tone: "success",
    });
  });

  it("announces a failed backup as an error toast", () => {
    const { result } = renderHook(() => useToasts());
    act(() => announceBackupFinished("failed"));
    expect(result.current[0]).toMatchObject({ title: "Backup failed", tone: "error" });
  });

  it("speaks the current language", async () => {
    await i18n.changeLanguage("it");
    const { result } = renderHook(() => useToasts());
    act(() => announceBackupFinished("succeeded"));
    expect(result.current[0]?.title).toBe("Backup completato");
  });
});
