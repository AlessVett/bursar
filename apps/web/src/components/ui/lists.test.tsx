import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n";
import { FilterChips } from "./FilterChips";
import { SearchInput } from "./SearchInput";
import { Tabs } from "./Tabs";

beforeEach(async () => {
  await i18n.changeLanguage("en");
});
afterEach(() => {
  vi.useRealTimers();
});

const ITEMS = [
  { id: "all", label: "All", count: 840 },
  { id: "in", label: "Inflows", count: 120 },
  { id: "out", label: "Outflows", count: 700 },
];

describe("Tabs", () => {
  it("renders a labelled tablist with the selected tab focusable and counts shown", () => {
    render(<Tabs items={ITEMS} value="in" onChange={() => undefined} ariaLabel="Direction" />);
    expect(screen.getByRole("tablist", { name: "Direction" })).not.toBeNull();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual([
      "false",
      "true",
      "false",
    ]);
    expect(tabs.map((tab) => tab.getAttribute("tabindex"))).toEqual(["-1", "0", "-1"]);
    expect(tabs[0]?.textContent).toBe("All840");
  });

  it("moves with the arrow keys, wraps around and supports Home and End", () => {
    const onChange = vi.fn();
    render(<Tabs items={ITEMS} value="out" onChange={onChange} ariaLabel="Direction" />);
    const list = screen.getByRole("tablist");
    fireEvent.keyDown(list, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("all");
    fireEvent.keyDown(list, { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith("in");
    fireEvent.keyDown(list, { key: "Home" });
    expect(onChange).toHaveBeenLastCalledWith("all");
    fireEvent.keyDown(list, { key: "End" });
    expect(onChange).toHaveBeenLastCalledWith("out");
  });

  it("selects a tab on click", () => {
    const onChange = vi.fn();
    render(<Tabs items={ITEMS} value="all" onChange={onChange} ariaLabel="Direction" />);
    fireEvent.click(screen.getByRole("tab", { name: /Outflows/ }));
    expect(onChange).toHaveBeenCalledWith("out");
  });
});

describe("FilterChips", () => {
  it("renders nothing without chips", () => {
    const { container } = render(<FilterChips chips={[]} onClearAll={() => undefined} />);
    expect(container.firstChild).toBeNull();
  });

  it("removes one chip or clears all, with a descriptive label on each remove button", () => {
    const onRemove = vi.fn();
    const onClearAll = vi.fn();
    render(
      <FilterChips
        summary="2 filters"
        chips={[
          { id: "account", label: "Account: Household", onRemove },
          { id: "q", label: "“coffee”", onRemove: () => undefined },
        ]}
        onClearAll={onClearAll}
      />,
    );
    expect(screen.queryByText("2 filters")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove filter Account: Household" }));
    expect(onRemove).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(onClearAll).toHaveBeenCalledTimes(1);
  });
});

describe("SearchInput", () => {
  function setup(value = "") {
    const onChange = vi.fn();
    const view = render(
      <SearchInput
        value={value}
        onChange={onChange}
        placeholder="Search"
        label="Search transactions"
      />,
    );
    const input = screen.getByRole("searchbox", {
      name: "Search transactions",
    }) as HTMLInputElement;
    return { onChange, input, ...view };
  }

  it("waits 250 ms after the last keystroke and reports only the final value", () => {
    vi.useFakeTimers();
    const { onChange, input } = setup();
    fireEvent.change(input, { target: { value: "co" } });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    fireEvent.change(input, { target: { value: "coffee" } });
    act(() => {
      vi.advanceTimersByTime(249);
    });
    expect(onChange).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("coffee");
  });

  it("commits at once on Enter, and clears on Escape and on the clear button", () => {
    vi.useFakeTimers();
    const { onChange, input } = setup();
    fireEvent.change(input, { target: { value: "rent" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenLastCalledWith("rent");

    fireEvent.keyDown(input, { key: "Escape" });
    expect(onChange).toHaveBeenLastCalledWith("");
    expect(input.value).toBe("");

    fireEvent.change(input, { target: { value: "gas" } });
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(onChange).toHaveBeenLastCalledWith("");
    expect(input.value).toBe("");
  });

  it("follows the committed value when it changes from outside (Clear filters)", () => {
    const { input, rerender } = setup("coffee");
    expect(input.value).toBe("coffee");
    rerender(
      <SearchInput
        value=""
        onChange={() => undefined}
        placeholder="Search"
        label="Search transactions"
      />,
    );
    expect(input.value).toBe("");
  });
});
