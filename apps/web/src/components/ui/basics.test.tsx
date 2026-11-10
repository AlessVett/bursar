import { fireEvent, render, screen } from "@testing-library/react";
import { Landmark } from "lucide-react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n";
import { Badge } from "./Badge";
import { Button } from "./Button";
import { Card } from "./Card";
import { Select, Switch, TextInput } from "./Field";
import { IconButton } from "./IconButton";
import { PageHeader } from "./PageHeader";
import { StatusPill } from "./StatusPill";

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

function SwitchHarness() {
  const [on, setOn] = useState(false);
  return (
    <Switch label="Email alerts" description="Sent to the owner" checked={on} onChange={setOn} />
  );
}

describe("Button", () => {
  it("is a plain button by default, with the variant and size classes", () => {
    render(<Button variant="secondary">Cancel</Button>);
    const button = screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement;
    expect(button.type).toBe("button");
    expect(button.className).toContain("bg-surface");
  });

  it("is disabled and busy while loading, and does not fire clicks", () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Sync now
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Sync now" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("renders its icon hidden from assistive technology", () => {
    const { container } = render(<Button icon={Landmark}>Connect a bank</Button>);
    expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("IconButton", () => {
  it("uses the label as accessible name and tooltip", () => {
    const onClick = vi.fn();
    render(<IconButton label="Close panel" icon={Landmark} onClick={onClick} />);
    const button = screen.getByRole("button", { name: "Close panel" });
    expect(button.getAttribute("title")).toBe("Close panel");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("Badge, StatusPill, Card and PageHeader", () => {
  it("renders a count badge in the neutral and accent tones", () => {
    const { container } = render(
      <>
        <Badge tone="neutral" count={4} />
        <Badge tone="accent" count={2} />
      </>,
    );
    const [neutral, accent] = Array.from(container.querySelectorAll("[data-tone]"));
    expect(neutral?.textContent).toBe("4");
    expect(accent?.textContent).toBe("2");
    expect(accent?.className).toContain("bg-accent");
    expect(neutral?.className).toContain("bg-surface-2");
  });

  it("names the state in the pill", () => {
    render(<StatusPill tone="warning" label="Expiring" />);
    expect(screen.getByText("Expiring").getAttribute("data-tone")).toBe("warning");
  });

  it("pads a card by size", () => {
    const { container } = render(
      <>
        <Card padding="none">a</Card>
        <Card padding="lg">b</Card>
      </>,
    );
    const [none, lg] = Array.from(container.children) as HTMLElement[];
    expect(none?.className).not.toContain("p-");
    expect(lg?.className).toContain("p-6");
  });

  it("writes the page title as a level-one heading with a count badge and actions", () => {
    render(
      <PageHeader
        title="Transactions"
        count={840}
        subtitle="Everything that moved"
        breadcrumb={<span>Money</span>}
        actions={<button type="button">Export</button>}
      />,
    );
    expect(screen.getByRole("heading", { level: 1, name: "Transactions" })).not.toBeNull();
    expect(screen.queryByText("840")).not.toBeNull();
    expect(screen.queryByText("Everything that moved")).not.toBeNull();
    expect(screen.queryByText("Money")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Export" })).not.toBeNull();
  });
});

describe("form fields", () => {
  it("links the label, hint and error to the input", () => {
    const { rerender } = render(<TextInput label="Account name" hint="Shown in the sidebar" />);
    const input = screen.getByLabelText("Account name");
    expect(input.getAttribute("aria-invalid")).toBeNull();
    expect(document.getElementById(input.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      "Shown in the sidebar",
    );

    rerender(<TextInput label="Account name" hint="Shown in the sidebar" error="Required" />);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(input.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      "Required",
    );
    expect(screen.getByRole("alert").textContent).toBe("Required");
  });

  it("offers the options of a select", () => {
    render(
      <Select
        label="Country"
        defaultValue="it"
        options={[
          { value: "it", label: "Italy" },
          { value: "de", label: "Germany" },
        ]}
      />,
    );
    const select = screen.getByLabelText("Country") as HTMLSelectElement;
    expect(select.value).toBe("it");
    expect(select.options.length).toBe(2);
  });

  it("toggles a switch with a click and exposes its state", () => {
    render(<SwitchHarness />);
    const toggle = screen.getByRole("switch", { name: "Email alerts" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });
});
