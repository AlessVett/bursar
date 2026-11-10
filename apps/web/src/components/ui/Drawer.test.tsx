import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n";
import { Drawer } from "./Drawer";

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

function Harness({ onClose }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open details
      </button>
      <Drawer
        open={open}
        title="Transaction details"
        onClose={() => {
          onClose?.();
          setOpen(false);
        }}
        footer={<button type="button">Footer action</button>}
      >
        <button type="button">First action</button>
        <button type="button">Second action</button>
      </Drawer>
    </>
  );
}

describe("Drawer", () => {
  it("renders nothing while closed", () => {
    render(
      <Drawer open={false} title="Details" onClose={() => undefined}>
        content
      </Drawer>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("is a labelled modal dialog 520 px wide by default", () => {
    render(
      <Drawer open title="Transaction details" onClose={() => undefined}>
        content
      </Drawer>,
    );
    const dialog = screen.getByRole("dialog", { name: "Transaction details" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.style.getPropertyValue("--drawer-width")).toBe("520px");
  });

  it("moves focus inside, closes on Escape and gives focus back to the opener", () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const opener = screen.getByRole("button", { name: "Open details" });
    opener.focus();
    fireEvent.click(opener);

    const dialog = screen.getByRole("dialog");
    expect(dialog.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("traps Tab and Shift+Tab inside the drawer", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Open details" }));
    const close = screen.getByRole("button", { name: "Close" });
    const footer = screen.getByRole("button", { name: "Footer action" });

    footer.focus();
    fireEvent.keyDown(footer, { key: "Tab" });
    expect(document.activeElement).toBe(close);

    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(footer);
  });

  it("closes from the close button and from a click on the backdrop", () => {
    const onClose = vi.fn();
    render(
      <Drawer open title="Details" onClose={onClose}>
        content
      </Drawer>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(document.querySelector("[data-backdrop]") as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("locks the page scroll while open and restores it on close", () => {
    const { rerender } = render(
      <Drawer open title="Details" onClose={() => undefined}>
        content
      </Drawer>,
    );
    expect(document.body.style.overflow).toBe("hidden");
    rerender(
      <Drawer open={false} title="Details" onClose={() => undefined}>
        content
      </Drawer>,
    );
    expect(document.body.style.overflow).toBe("");
  });
});
