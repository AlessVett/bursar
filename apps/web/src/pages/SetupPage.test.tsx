import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import QRCode from "qrcode";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import { stubApi, testQueryClient } from "../test/router";
import { SetupPage } from "./SetupPage";

vi.mock("qrcode", () => ({ default: { toDataURL: vi.fn() } }));

const toDataURL = vi.mocked(QRCode.toDataURL) as unknown as ReturnType<typeof vi.fn>;

const enrolment = {
  setupToken: "setup-token",
  otpauthUri: "otpauth://totp/Bursar:owner?secret=JBSWY3DPEHPK3PXP&issuer=Bursar",
  secret: "JBSWY3DPEHPK3PXP",
};

function renderPage() {
  return render(
    <QueryClientProvider client={testQueryClient()}>
      <SetupPage />
    </QueryClientProvider>,
  );
}

function fillStart(password: string, confirm: string) {
  fireEvent.change(screen.getByLabelText("Setup code"), { target: { value: "code-123" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: password } });
  fireEvent.change(screen.getByLabelText("Repeat password"), { target: { value: confirm } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
}

describe("SetupPage", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    toDataURL.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("validates the password before calling the server", () => {
    const fetchMock = stubApi({});
    renderPage();
    fillStart("short", "short");
    expect(screen.getByRole("alert").textContent).toBe(
      "The password must be at least 12 characters.",
    );
    fillStart("a long enough password", "a different password");
    expect(screen.getByRole("alert").textContent).toBe("The passwords do not match.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the lockout text on 429", async () => {
    stubApi({
      "POST /api/auth/setup/start": () => ({ status: 429, body: { error: "Too many attempts" } }),
    });
    renderPage();
    fillStart("a long enough password", "a long enough password");
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Too many attempts. Wait 15 minutes and try again.",
    );
  });

  it("shows the QR code after a successful start", async () => {
    toDataURL.mockResolvedValue("data:image/png;base64,AAAA");
    stubApi({ "POST /api/auth/setup/start": () => ({ status: 200, body: enrolment }) });
    renderPage();
    fillStart("a long enough password", "a long enough password");
    const image = await screen.findByAltText("QR code for the authenticator app");
    expect(image.getAttribute("src")).toBe("data:image/png;base64,AAAA");
    expect(screen.getByText(/JBSWY3DPEHPK3PXP/)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("explains the manual key when the QR code cannot be drawn", async () => {
    toDataURL.mockRejectedValue(new Error("canvas unavailable"));
    stubApi({ "POST /api/auth/setup/start": () => ({ status: 200, body: enrolment }) });
    renderPage();
    fillStart("a long enough password", "a long enough password");
    expect((await screen.findByRole("alert")).textContent).toBe(
      "The QR code could not be drawn. Add the account in your authenticator app with the manual entry key below.",
    );
    expect(screen.queryByAltText("QR code for the authenticator app")).toBeNull();
    expect(screen.getByText(/JBSWY3DPEHPK3PXP/)).toBeTruthy();
  });
});
