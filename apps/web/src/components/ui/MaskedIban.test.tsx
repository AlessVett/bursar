import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n";
import { useUi } from "../../store/ui";
import { clearToasts } from "../feedback";
import { CopyButton } from "./CopyButton";
import { MaskedIban } from "./MaskedIban";
import { Toaster } from "./Toaster";

const MASKED = "IT89 •••• •••• 1001";
const FULL_IBAN = "IT89X9900101600000000001001";

function stubClipboard(writeText: (value: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  useUi.setState({ privacy: false });
  clearToasts();
});
afterEach(() => {
  useUi.setState({ privacy: false });
  clearToasts();
  Reflect.deleteProperty(navigator, "clipboard");
  vi.useRealTimers();
});

describe("MaskedIban", () => {
  it("shows the masked IBAN in monospace and no copy button unless asked", () => {
    render(<MaskedIban masked={MASKED} iban={FULL_IBAN} />);
    const text = screen.getByText(MASKED);
    expect(text.className).toContain("font-mono");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("hides every digit in privacy mode and labels the mask", () => {
    useUi.setState({ privacy: true });
    render(<MaskedIban masked={MASKED} />);
    const masked = screen.getByRole("img", { name: "IBAN hidden by privacy mode" });
    expect(masked.textContent).not.toMatch(/\d/);
    expect(screen.queryByText(MASKED)).toBeNull();
  });

  it("copies the full IBAN and confirms with an info toast that never shows it", async () => {
    const writeText = vi.fn(async (_value: string) => undefined);
    stubClipboard(writeText);
    render(
      <>
        <Toaster />
        <MaskedIban masked={MASKED} iban={FULL_IBAN} copyable />
      </>,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy IBAN" }));
    });
    expect(writeText).toHaveBeenCalledWith(FULL_IBAN);
    expect(screen.queryByText("Copied")).not.toBeNull();
    expect(screen.queryByText("The full IBAN is on your clipboard.")).not.toBeNull();
    expect(document.body.textContent).not.toContain(FULL_IBAN);
    expect(document.querySelector('[data-tone="info"]')).not.toBeNull();
  });

  it("hides the copy button when the full IBAN is not available", () => {
    render(<MaskedIban masked={MASKED} iban={null} copyable />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("CopyButton", () => {
  it("turns into a check for 1.5 seconds after copying", async () => {
    vi.useFakeTimers();
    stubClipboard(async () => undefined);
    const onCopied = vi.fn();
    render(<CopyButton value="abc" label="Copy code" onCopied={onCopied} />);
    const button = screen.getByRole("button", { name: "Copy code" });
    expect(button.getAttribute("data-copied")).toBeNull();
    await act(async () => {
      fireEvent.click(button);
    });
    expect(onCopied).toHaveBeenCalledTimes(1);
    expect(button.getAttribute("data-copied")).toBe("true");
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(button.getAttribute("data-copied")).toBeNull();
  });

  it("reports an error toast when the clipboard cannot be used", async () => {
    render(
      <>
        <Toaster />
        <CopyButton value="abc" label="Copy code" />
      </>,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    });
    expect(screen.queryByText("Copy failed")).not.toBeNull();
    expect(document.querySelector('[data-tone="error"]')).not.toBeNull();
  });
});
