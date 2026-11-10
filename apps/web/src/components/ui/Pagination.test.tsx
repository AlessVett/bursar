import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n";
import { Pagination } from "./Pagination";

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

describe("Pagination", () => {
  it("writes the range as '21–40 of 840' in English", () => {
    render(<Pagination page={2} pageSize={20} total={840} onPageChange={() => undefined} />);
    expect(screen.queryByText("21–40 of 840")).not.toBeNull();
    expect(screen.queryByText("Page 2 of 42")).not.toBeNull();
  });

  it("writes the range as '21–40 di 840' in Italian", async () => {
    await i18n.changeLanguage("it");
    render(<Pagination page={2} pageSize={20} total={840} onPageChange={() => undefined} />);
    expect(screen.queryByText("21–40 di 840")).not.toBeNull();
  });

  it("groups thousands with the locale and shortens the last page", () => {
    render(<Pagination page={62} pageSize={20} total={1235} onPageChange={() => undefined} />);
    expect(screen.queryByText("1,221–1,235 of 1,235")).not.toBeNull();
  });

  it("goes to the previous and next page, and disables the ends", () => {
    const onPageChange = vi.fn();
    const { rerender } = render(
      <Pagination page={1} pageSize={20} total={50} onPageChange={onPageChange} />,
    );
    const previous = screen.getByRole("button", { name: "Previous page" }) as HTMLButtonElement;
    const next = screen.getByRole("button", { name: "Next page" }) as HTMLButtonElement;
    expect(previous.disabled).toBe(true);
    fireEvent.click(next);
    expect(onPageChange).toHaveBeenLastCalledWith(2);

    rerender(<Pagination page={3} pageSize={20} total={50} onPageChange={onPageChange} />);
    expect(screen.queryByText("41–50 of 50")).not.toBeNull();
    expect((screen.getByRole("button", { name: "Next page" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
    expect(onPageChange).toHaveBeenLastCalledWith(2);
  });

  it("shows only the range when everything fits on one page", () => {
    render(<Pagination page={1} pageSize={20} total={12} onPageChange={() => undefined} />);
    expect(screen.queryByText("1–12 of 12")).not.toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders nothing for an empty list and clamps a page beyond the end", () => {
    const { container, rerender } = render(
      <Pagination page={1} pageSize={20} total={0} onPageChange={() => undefined} />,
    );
    expect(container.firstChild).toBeNull();
    rerender(<Pagination page={99} pageSize={20} total={50} onPageChange={() => undefined} />);
    expect(screen.queryByText("41–50 of 50")).not.toBeNull();
  });
});
