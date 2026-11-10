import { describe, expect, it } from "vitest";
import * as ui from "./index";

describe("components/ui barrel", () => {
  it("exports every primitive", () => {
    const names = [
      "Badge",
      "Button",
      "Card",
      "Cascade",
      "ConfirmDialog",
      "CopyButton",
      "DataTable",
      "DeadlineChip",
      "Dialog",
      "Drawer",
      "EmptyState",
      "FieldError",
      "FilterChips",
      "IconButton",
      "InlineEmpty",
      "MaskedIban",
      "Money",
      "PageHeader",
      "Pagination",
      "RelativeTime",
      "SaveIndicator",
      "SearchInput",
      "Select",
      "SkeletonRows",
      "StatusPill",
      "Switch",
      "Tabs",
      "TextInput",
      "Toaster",
      "nextSort",
    ] as const;
    const exported = new Map(Object.entries(ui));
    for (const name of names) expect(typeof exported.get(name), name).toBe("function");
  });
});
