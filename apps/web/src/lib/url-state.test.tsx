import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useUrlState } from "./url-state";

const DEFAULTS = { tab: "all", q: "", page: "1" };
const OPTIONS = {
  validate: {
    tab: (value: string) => ["all", "in", "out", "pending"].includes(value),
    page: (value: string) => /^[1-9]\d*$/.test(value),
  },
  resetOnChange: ["page" as const],
};

function useTransactionsState() {
  return useUrlState(DEFAULTS, OPTIONS);
}

beforeEach(() => {
  window.history.replaceState({ idx: 4 }, "", "/transactions");
});

describe("useUrlState", () => {
  it("returns the defaults for an empty query string", () => {
    const { result } = renderHook(useTransactionsState);
    expect(result.current[0]).toEqual(DEFAULTS);
  });

  it("reads valid values and falls back to the default for invalid ones", () => {
    window.history.replaceState(null, "", "/transactions?tab=bogus&page=0&q=coffee");
    const { result } = renderHook(useTransactionsState);
    expect(result.current[0]).toEqual({ tab: "all", q: "coffee", page: "1" });
    window.history.replaceState(null, "", "/transactions?tab=out&page=3");
    const second = renderHook(useTransactionsState);
    expect(second.result.current[0]).toEqual({ tab: "out", q: "", page: "3" });
  });

  it("treats an empty value as the default when the default is not empty", () => {
    window.history.replaceState(null, "", "/transactions?tab=&q=");
    const { result } = renderHook(useTransactionsState);
    expect(result.current[0]).toEqual(DEFAULTS);
  });

  it("writes with replace: no new history entry, state and hash kept, defaults omitted", () => {
    window.history.replaceState({ idx: 4 }, "", "/transactions#top");
    const entries = window.history.length;
    const { result } = renderHook(useTransactionsState);
    act(() => result.current[1]({ tab: "in", q: "rent" }));
    expect(window.location.pathname + window.location.search + window.location.hash).toBe(
      "/transactions?tab=in&q=rent#top",
    );
    expect(window.history.length).toBe(entries);
    expect(window.history.state).toEqual({ idx: 4 });
    expect(result.current[0]).toEqual({ tab: "in", q: "rent", page: "1" });

    act(() => result.current[1]({ tab: "all" }));
    expect(window.location.search).toBe("?q=rent");
    act(() => result.current[1]({ q: "" }));
    expect(window.location.search).toBe("");
  });

  it("never writes an invalid value", () => {
    const { result } = renderHook(useTransactionsState);
    act(() => result.current[1]({ tab: "bogus" }));
    expect(window.location.search).toBe("");
    expect(result.current[0].tab).toBe("all");
  });

  it("keeps parameters it does not own", () => {
    window.history.replaceState(null, "", "/transactions?account=12&tab=in");
    const { result } = renderHook(useTransactionsState);
    act(() => result.current[1]({ tab: "out" }));
    expect(window.location.search).toBe("?account=12&tab=out");
  });

  it("returns to the first page when another key changes, but not when only the page changes", () => {
    window.history.replaceState(null, "", "/transactions?page=4&tab=in");
    const { result } = renderHook(useTransactionsState);
    act(() => result.current[1]({ page: "5" }));
    expect(result.current[0].page).toBe("5");

    act(() => result.current[1]({ q: "gas" }));
    expect(result.current[0]).toEqual({ tab: "in", q: "gas", page: "1" });
    expect(window.location.search).toBe("?tab=in&q=gas");
  });

  it("lets an explicit page in the same patch win over the reset", () => {
    window.history.replaceState(null, "", "/transactions?page=4");
    const { result } = renderHook(useTransactionsState);
    act(() => result.current[1]({ tab: "out", page: "2" }));
    expect(result.current[0]).toEqual({ tab: "out", q: "", page: "2" });
  });

  it("does not reset the page when the other key is set to the value it already has", () => {
    window.history.replaceState(null, "", "/transactions?page=4&tab=in");
    const { result } = renderHook(useTransactionsState);
    act(() => result.current[1]({ tab: "in" }));
    expect(result.current[0].page).toBe("4");
  });

  it("follows the back and forward buttons", () => {
    const { result } = renderHook(useTransactionsState);
    act(() => {
      window.history.replaceState(null, "", "/transactions?tab=pending");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(result.current[0].tab).toBe("pending");
  });

  it("keeps two consumers in sync and gives a stable setter", () => {
    const first = renderHook(useTransactionsState);
    const second = renderHook(useTransactionsState);
    const setter = first.result.current[1];
    act(() => first.result.current[1]({ q: "milk" }));
    expect(second.result.current[0].q).toBe("milk");
    first.rerender();
    expect(first.result.current[1]).toBe(setter);
  });
});
