import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n";
import { NICKNAME_MAX_LENGTH, NicknameEditor } from "./NicknameEditor";

function setup(props: Partial<Parameters<typeof NicknameEditor>[0]> = {}) {
  const onSave = vi.fn(async (_nickname: string | null) => undefined);
  render(
    <NicknameEditor
      name="Household"
      nickname="Household"
      placeholder="Conto Esempio"
      onSave={onSave}
      {...props}
    />,
  );
  return { onSave };
}

function openEditor(): HTMLInputElement {
  fireEvent.click(screen.getByRole("button", { name: "Rename Household" }));
  return screen.getByRole("textbox", { name: "Account name" }) as HTMLInputElement;
}

describe("NicknameEditor", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("shows the name and opens an input holding the current nickname", () => {
    setup();
    expect(screen.getByText("Household")).toBeTruthy();
    const input = openEditor();
    expect(input.value).toBe("Household");
    expect(input.placeholder).toBe("Conto Esempio");
    expect(document.activeElement).toBe(input);
  });

  it("saves the trimmed value on Enter, closes and gives the focus back", async () => {
    const { onSave } = setup();
    const input = openEditor();
    fireEvent.change(input, { target: { value: "  Everyday  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onSave).toHaveBeenCalledWith("Everyday"));
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Rename Household" }));
  });

  it("saves null when the field is emptied, which resets the name", async () => {
    const { onSave } = setup();
    const input = openEditor();
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(null));
  });

  it("cancels on Escape without saving", () => {
    const { onSave } = setup();
    const input = openEditor();
    fireEvent.change(input, { target: { value: "Something else" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText("Household")).toBeTruthy();
  });

  it("closes without calling the API when nothing changed", async () => {
    const { onSave } = setup();
    const input = openEditor();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
    expect(onSave).not.toHaveBeenCalled();
  });

  it("treats an empty field as unchanged when there is no nickname yet", async () => {
    const { onSave } = setup({ name: "Conto Esempio", nickname: null });
    fireEvent.click(screen.getByRole("button", { name: "Rename Conto Esempio" }));
    const input = screen.getByRole("textbox", { name: "Account name" });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
    expect(onSave).not.toHaveBeenCalled();
  });

  it("stays open with the typed text when saving fails", async () => {
    const onSave = vi.fn(async () => {
      throw new Error("boom");
    });
    setup({ onSave });
    const input = openEditor();
    fireEvent.change(input, { target: { value: "Everyday" } });
    fireEvent.click(screen.getByRole("button", { name: "Save the name" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        (screen.getByRole("textbox", { name: "Account name" }) as HTMLInputElement).disabled,
      ).toBe(false),
    );
    const still = screen.getByRole("textbox", { name: "Account name" }) as HTMLInputElement;
    expect(still.value).toBe("Everyday");
  });

  it("limits the length of the nickname", () => {
    setup();
    const input = openEditor();
    expect(NICKNAME_MAX_LENGTH).toBe(80);
    expect(input.maxLength).toBe(80);
  });
});
