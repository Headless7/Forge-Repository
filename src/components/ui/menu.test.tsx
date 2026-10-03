import { DropdownMenu as M } from "radix-ui";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DropdownMenuItem } from "./menu";

/** Renders an open menu inline (no portal) so the item's own render runs on the server. */
const renderOpen = (item: React.ReactNode) =>
  renderToStaticMarkup(
    <M.Root open modal={false}>
      <M.Trigger>Board settings</M.Trigger>
      <M.Content forceMount>{item}</M.Content>
    </M.Root>,
  );

describe("DropdownMenuItem", () => {
  // Regression: the board's settings menu (link items via asChild) crashed the page when opened
  // with "Primitive.div failed to slot onto its children", because the item always passed a
  // second (shortcut) child to the slot.
  it("renders a link item with asChild", () => {
    const html = renderOpen(
      <DropdownMenuItem asChild>
        <a href="/studio/project/settings">Board settings</a>
      </DropdownMenuItem>,
    );
    expect(html).toContain('href="/studio/project/settings"');
    expect(html).toContain('role="menuitem"');
  });

  it("still shows a keyboard shortcut on plain items", () => {
    const html = renderOpen(<DropdownMenuItem shortcut="⌘K">Search</DropdownMenuItem>);
    expect(html).toContain("⌘K");
  });
});
