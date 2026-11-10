import { QueryClient, QueryClientProvider, useMutation } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import { clearToasts, feedback } from "./feedback";
import { SaveIndicator } from "./ui/SaveIndicator";
import { Toaster } from "./ui/Toaster";

function renderChrome(extra?: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Toaster />
      <SaveIndicator />
      {extra}
    </QueryClientProvider>,
  );
}

let finishMutation: () => void = () => undefined;

function Trigger() {
  const mutation = useMutation({
    mutationFn: () =>
      new Promise<void>((resolve) => {
        finishMutation = resolve;
      }),
  });
  return (
    <button type="button" onClick={() => mutation.mutate()}>
      Go
    </button>
  );
}

function saveState(container: HTMLElement): string | null {
  return container.querySelector("[data-state]")?.getAttribute("data-state") ?? null;
}

describe("feedback and Toaster", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    clearToasts();
    vi.useFakeTimers();
  });
  afterEach(() => {
    clearToasts();
    vi.useRealTimers();
  });

  it("shows a toast with title and detail and removes it after 4 seconds", () => {
    renderChrome();
    act(() => feedback("Account renamed", "The account is now called Household"));
    const region = screen.getByRole("status");
    expect(within(region).queryByText("Account renamed")).not.toBeNull();
    expect(within(region).queryByText("The account is now called Household")).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(3999);
    });
    expect(screen.queryByText("Account renamed")).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByText("Account renamed")).toBeNull();
  });

  it("keeps an error until it is closed and announces it in the assertive region", () => {
    renderChrome();
    act(() => feedback("Sync failed", "The bank did not answer", "error"));
    const region = screen.getByRole("alert");
    expect(region.getAttribute("aria-live")).toBe("assertive");
    expect(within(region).queryByText("Sync failed")).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.queryByText("Sync failed")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
    expect(screen.queryByText("Sync failed")).toBeNull();
  });

  it("uses the success tone when none is given and carries the tone on the toast", () => {
    renderChrome();
    act(() => feedback("Saved"));
    act(() => feedback("Sync started", undefined, "info"));
    const tones = Array.from(document.querySelectorAll("[data-tone]")).map((element) =>
      element.getAttribute("data-tone"),
    );
    expect(tones).toEqual(["success", "info"]);
  });

  it("keeps at most five toasts, dropping the oldest", () => {
    renderChrome();
    act(() => {
      for (let i = 1; i <= 7; i += 1) feedback(`Toast ${i}`);
    });
    expect(screen.queryByText("Toast 2")).toBeNull();
    expect(screen.queryByText("Toast 3")).not.toBeNull();
    expect(screen.queryByText("Toast 7")).not.toBeNull();
  });

  it("flips the save indicator to saving for one second after a toast", () => {
    const { container } = renderChrome();
    expect(saveState(container)).toBe("saved");
    expect(screen.queryByText("Saved")).not.toBeNull();

    act(() => feedback("Settings saved"));
    expect(saveState(container)).toBe("saving");
    expect(screen.queryByText("Saving…")).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(saveState(container)).toBe("saved");
  });

  it("shows saving while a mutation is in flight", async () => {
    const { container } = renderChrome(<Trigger />);
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(saveState(container)).toBe("saving");

    await act(async () => {
      finishMutation();
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(saveState(container)).toBe("saved");
  });
});
