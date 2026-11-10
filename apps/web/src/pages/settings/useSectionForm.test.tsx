import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SectionFormError, useSectionForm } from "./useSectionForm";

interface Values {
  name: string;
  days: number;
}

const INITIAL: Values = { name: "Main", days: 30 };

function setup(save: (values: Values) => Promise<void> = async () => undefined) {
  const saveSpy = vi.fn(save);
  const view = renderHook(() => useSectionForm(INITIAL, saveSpy));
  return { ...view, saveSpy };
}

describe("useSectionForm", () => {
  it("starts read-only and clean", () => {
    const { result } = setup();
    expect(result.current.values).toEqual(INITIAL);
    expect(result.current.editing).toBe(false);
    expect(result.current.dirty).toBe(false);
    expect(result.current.saving).toBe(false);
    expect(result.current.errors).toEqual({});
  });

  it("ignores set() while the section is not being edited", () => {
    const { result } = setup();
    act(() => result.current.set("name", "Other"));
    expect(result.current.values).toEqual(INITIAL);
    expect(result.current.editing).toBe(false);
    expect(result.current.dirty).toBe(false);
  });

  it("is editing but clean after startEdit, dirty after a change and clean again when restored", () => {
    const { result } = setup();
    act(() => result.current.startEdit());
    expect(result.current.editing).toBe(true);
    expect(result.current.dirty).toBe(false);
    act(() => result.current.set("days", 90));
    expect(result.current.values).toEqual({ name: "Main", days: 90 });
    expect(result.current.dirty).toBe(true);
    act(() => result.current.set("days", 30));
    expect(result.current.dirty).toBe(false);
    expect(result.current.editing).toBe(true);
  });

  it("discards the draft and the errors on cancel", async () => {
    const { result } = setup(async () => {
      throw new SectionFormError({ days: "Too long" });
    });
    act(() => result.current.startEdit());
    act(() => result.current.set("days", 999));
    await act(async () => {
      await result.current.submit();
    });
    expect(result.current.errors).toEqual({ days: "Too long" });
    act(() => result.current.cancel());
    expect(result.current.editing).toBe(false);
    expect(result.current.dirty).toBe(false);
    expect(result.current.values).toEqual(INITIAL);
    expect(result.current.errors).toEqual({});
  });

  it("saves the draft and returns to read mode", async () => {
    const { result, saveSpy } = setup();
    act(() => result.current.startEdit());
    act(() => result.current.set("name", "Renamed"));
    await act(async () => {
      await result.current.submit();
    });
    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy).toHaveBeenCalledWith({ name: "Renamed", days: 30 });
    expect(result.current.editing).toBe(false);
    expect(result.current.saving).toBe(false);
    expect(result.current.errors).toEqual({});
    // The parent passes the saved values back as `initial`; here it is unchanged.
    expect(result.current.values).toEqual(INITIAL);
  });

  it("keeps the draft and shows the field errors when save throws a SectionFormError", async () => {
    const { result } = setup(async () => {
      throw new SectionFormError({ days: "Enter a number between 1 and 365." });
    });
    act(() => result.current.startEdit());
    act(() => result.current.set("days", 0));
    await act(async () => {
      await result.current.submit();
    });
    expect(result.current.editing).toBe(true);
    expect(result.current.dirty).toBe(true);
    expect(result.current.errors).toEqual({ days: "Enter a number between 1 and 365." });
    act(() => result.current.set("days", 10));
    expect(result.current.errors).toEqual({});
  });

  it("keeps editing without field errors when save fails for another reason", async () => {
    const { result } = setup(async () => {
      throw new Error("network down");
    });
    act(() => result.current.startEdit());
    act(() => result.current.set("name", "Renamed"));
    await act(async () => {
      await result.current.submit();
    });
    expect(result.current.editing).toBe(true);
    expect(result.current.dirty).toBe(true);
    expect(result.current.saving).toBe(false);
    expect(result.current.errors).toEqual({});
  });

  it("reports saving while the save is pending and ignores a second submit", async () => {
    let release: () => void = () => undefined;
    const { result, saveSpy } = setup(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    act(() => result.current.startEdit());
    act(() => result.current.set("name", "Renamed"));
    let first: Promise<void> = Promise.resolve();
    act(() => {
      first = result.current.submit();
    });
    expect(result.current.saving).toBe(true);
    act(() => {
      void result.current.submit();
    });
    expect(saveSpy).toHaveBeenCalledTimes(1);
    await act(async () => {
      release();
      await first;
    });
    expect(result.current.saving).toBe(false);
    expect(result.current.editing).toBe(false);
  });
});
