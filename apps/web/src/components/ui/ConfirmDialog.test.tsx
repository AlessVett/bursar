import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n";
import { ConfirmDialog } from "./ConfirmDialog";
import { Drawer } from "./Drawer";

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

function Nested({ onDrawerClose }: { onDrawerClose: () => void }) {
  const [confirming, setConfirming] = useState(true);
  return (
    <Drawer open title="Account" onClose={onDrawerClose}>
      <button type="button">Remove</button>
      <ConfirmDialog
        open={confirming}
        tone="danger"
        title="Remove this account?"
        body="It disappears from the list."
        confirmLabel="Yes, remove"
        onConfirm={() => undefined}
        onCancel={() => setConfirming(false)}
      />
    </Drawer>
  );
}

function setup(overrides: Partial<React.ComponentProps<typeof ConfirmDialog>> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <ConfirmDialog
      open
      tone="danger"
      title="Disconnect this bank?"
      body={<p>2 accounts and 840 transactions stay in Bursar.</p>}
      confirmLabel="Yes, disconnect"
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...overrides}
    />,
  );
  return { onConfirm, onCancel };
}

describe("ConfirmDialog", () => {
  it("asks the question, shows the counts and repeats the verb on the button", () => {
    setup();
    const dialog = screen.getByRole("alertdialog", { name: "Disconnect this bank?" });
    expect(dialog.textContent).toContain("2 accounts and 840 transactions");
    const buttons = screen
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label") ?? button.textContent);
    expect(buttons).toEqual(["Close", "Cancel", "Yes, disconnect"]);
  });

  it("styles a destructive confirmation as danger and a reversible one as primary", () => {
    setup();
    expect(screen.getByRole("button", { name: "Yes, disconnect" }).className).toContain(
      "bg-danger",
    );
  });

  it("uses the primary style for the primary tone", () => {
    setup({ tone: "primary", confirmLabel: "Yes, disable" });
    expect(screen.getByRole("button", { name: "Yes, disable" }).className).toContain("bg-primary");
  });

  it("calls onConfirm and then closes itself through onCancel", async () => {
    const { onConfirm, onCancel } = setup({ onConfirm: vi.fn(async () => undefined) });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Yes, disconnect" }));
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).toBeDefined();
  });

  it("stays open and busy while onConfirm is pending, and ignores a second click", async () => {
    let finish: () => void = () => undefined;
    const onConfirm = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const { onCancel } = setup({ onConfirm });
    const confirm = screen.getByRole("button", { name: "Yes, disconnect" });
    await act(async () => {
      fireEvent.click(confirm);
    });
    expect(confirm.getAttribute("aria-busy")).toBe("true");
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(confirm);
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();

    await act(async () => {
      finish();
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("stays open when onConfirm rejects so the action can be retried", async () => {
    const onConfirm = vi.fn(async () => {
      throw new Error("network");
    });
    const { onCancel } = setup({ onConfirm });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Yes, disconnect" }));
    });
    expect(onCancel).not.toHaveBeenCalled();
    const confirm = screen.getByRole("button", { name: "Yes, disconnect" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(confirm);
    });
    expect(onConfirm).toHaveBeenCalledTimes(2);
  });

  it("cancels with the Cancel button and with Escape", () => {
    const { onCancel } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it("honours a custom cancel label", () => {
    setup({ cancelLabel: "Keep connected" });
    expect(screen.queryByRole("button", { name: "Keep connected" })).not.toBeNull();
  });

  it("closes alone when opened from a drawer: Escape does not reach the drawer", () => {
    const onDrawerClose = vi.fn();
    render(<Nested onDrawerClose={onDrawerClose} />);
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Account" })).not.toBeNull();
    expect(onDrawerClose).not.toHaveBeenCalled();
  });
});
