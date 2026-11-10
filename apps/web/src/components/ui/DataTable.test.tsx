import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n";
import { type Column, DataTable, nextSort, type SortState } from "./DataTable";

interface Row {
  id: number;
  name: string;
}

const ROWS: Row[] = [
  { id: 1, name: "Coffee shop" },
  { id: 2, name: "Landlord" },
];

const COLUMNS: Column<Row>[] = [
  { id: "name", header: "Counterparty", cell: (row) => row.name, sortable: true },
  {
    id: "actions",
    header: "Actions",
    cell: () => <button type="button">Open menu</button>,
    hideBelow: "md",
  },
];

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

function SortHarness({ onSeen }: { onSeen: (sort: SortState) => void }) {
  const [sort, setSort] = useState<SortState>(null);
  return (
    <DataTable
      caption="Transactions"
      columns={COLUMNS}
      rows={ROWS}
      getRowKey={(row) => row.id}
      sort={sort}
      onSortChange={(next) => {
        onSeen(next);
        setSort(next);
      }}
    />
  );
}

describe("nextSort", () => {
  it("cycles ascending, descending, none, and restarts on another column", () => {
    const asc = nextSort(null, "name");
    expect(asc).toEqual({ columnId: "name", direction: "asc" });
    const desc = nextSort(asc, "name");
    expect(desc).toEqual({ columnId: "name", direction: "desc" });
    expect(nextSort(desc, "name")).toBeNull();
    expect(nextSort(desc, "amount")).toEqual({ columnId: "amount", direction: "asc" });
  });
});

describe("DataTable", () => {
  it("cycles the sort when the header is clicked and exposes aria-sort", () => {
    const seen: SortState[] = [];
    render(<SortHarness onSeen={(next) => seen.push(next)} />);
    const header = screen.getByRole("columnheader", { name: /Counterparty/ });
    const button = screen.getByRole("button", { name: /Counterparty/ });
    expect(header.getAttribute("aria-sort")).toBeNull();
    fireEvent.click(button);
    expect(header.getAttribute("aria-sort")).toBe("ascending");
    fireEvent.click(button);
    expect(header.getAttribute("aria-sort")).toBe("descending");
    fireEvent.click(button);
    expect(header.getAttribute("aria-sort")).toBeNull();
    expect(seen).toEqual([
      { columnId: "name", direction: "asc" },
      { columnId: "name", direction: "desc" },
      null,
    ]);
  });

  it("renders skeleton rows while loading and no spinner", () => {
    const { container } = render(
      <DataTable
        caption="Transactions"
        columns={COLUMNS}
        rows={ROWS}
        loading
        skeletonRows={5}
        getRowKey={(row) => row.id}
      />,
    );
    expect(container.querySelectorAll("[data-skeleton-row]").length).toBe(5);
    expect(screen.queryByText("Coffee shop")).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(container.querySelector("table")?.getAttribute("aria-busy")).toBe("true");
  });

  it("renders skeleton rows while rows are undefined", () => {
    const { container } = render(
      <DataTable
        caption="Transactions"
        columns={COLUMNS}
        rows={undefined}
        getRowKey={(row: Row) => row.id}
      />,
    );
    expect(container.querySelectorAll("[data-skeleton-row]").length).toBe(8);
  });

  it("shows the empty node when there are no rows", () => {
    render(
      <DataTable
        caption="Transactions"
        columns={COLUMNS}
        rows={[]}
        getRowKey={(row) => row.id}
        empty={<p>Nothing here</p>}
      />,
    );
    expect(screen.queryByText("Nothing here")).not.toBeNull();
  });

  it("opens a row on click and on Enter but ignores clicks on controls inside it", () => {
    const onRowClick = vi.fn();
    render(
      <DataTable
        caption="Transactions"
        columns={COLUMNS}
        rows={ROWS}
        getRowKey={(row) => row.id}
        onRowClick={onRowClick}
      />,
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Open menu" })[0] as HTMLElement);
    expect(onRowClick).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Coffee shop"));
    expect(onRowClick).toHaveBeenCalledTimes(1);
    expect(onRowClick).toHaveBeenLastCalledWith(ROWS[0]);

    const row = screen.getByText("Landlord").closest("tr") as HTMLElement;
    expect(row.getAttribute("tabindex")).toBe("0");
    fireEvent.keyDown(row, { key: "Enter" });
    expect(onRowClick).toHaveBeenCalledTimes(2);
    expect(onRowClick).toHaveBeenLastCalledWith(ROWS[1]);

    fireEvent.keyDown(screen.getAllByRole("button", { name: "Open menu" })[1] as HTMLElement, {
      key: "Enter",
    });
    expect(onRowClick).toHaveBeenCalledTimes(2);
  });

  it("marks the selected row and hides columns below their breakpoint", () => {
    render(
      <DataTable
        caption="Transactions"
        columns={COLUMNS}
        rows={ROWS}
        getRowKey={(row) => row.id}
        selectedKey={2}
        onRowClick={() => undefined}
      />,
    );
    expect(screen.getByText("Landlord").closest("tr")?.getAttribute("data-selected")).toBe("true");
    expect(screen.getByText("Coffee shop").closest("tr")?.getAttribute("data-selected")).toBeNull();
    expect(screen.getByRole("columnheader", { name: "Actions" }).className).toContain(
      "max-md:hidden",
    );
  });
});
