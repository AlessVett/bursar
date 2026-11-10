import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { describe, expect, it } from "vitest";
import { useUrlState } from "./url-state";

const DEFAULTS = { tab: "all", q: "", page: "1" };

function Probe() {
  const [state, setState] = useUrlState(DEFAULTS, {
    validate: { tab: (value) => ["all", "in", "out"].includes(value) },
    resetOnChange: ["page"],
  });
  const location = useLocation();
  return (
    <div>
      <output data-testid="state">{JSON.stringify(state)}</output>
      <output data-testid="search">{location.search}</output>
      <button type="button" onClick={() => setState({ tab: "in" })}>
        tab in
      </button>
      <button type="button" onClick={() => setState({ tab: "all" })}>
        tab all
      </button>
      <button type="button" onClick={() => setState({ page: "3" })}>
        page 3
      </button>
    </div>
  );
}

function renderAt(url: string) {
  render(
    <MemoryRouter initialEntries={[url]}>
      <Probe />
    </MemoryRouter>,
  );
}

const state = () => JSON.parse(screen.getByTestId("state").textContent ?? "{}");
const search = () => screen.getByTestId("search").textContent;

describe("useUrlState", () => {
  it("reads values and falls back to the default for invalid ones", () => {
    renderAt("/?tab=sideways&q=caff%C3%A8&page=2&other=keep");
    expect(state()).toEqual({ tab: "all", q: "caffè", page: "2" });
  });

  it("omits defaults, resets page when another key changes and keeps unknown parameters", () => {
    renderAt("/?page=2&other=keep");
    fireEvent.click(screen.getByRole("button", { name: "tab in" }));
    expect(search()).toBe("?other=keep&tab=in");
    fireEvent.click(screen.getByRole("button", { name: "page 3" }));
    expect(search()).toBe("?other=keep&tab=in&page=3");
    fireEvent.click(screen.getByRole("button", { name: "tab all" }));
    expect(search()).toBe("?other=keep");
    expect(state()).toEqual({ tab: "all", q: "", page: "1" });
  });
});
