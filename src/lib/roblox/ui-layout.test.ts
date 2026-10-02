import { describe, expect, it } from "vitest";
import { buildManifest, manifestMeta } from "@/server/roblox/manifest";
import { parseRobloxFile } from "@/server/roblox/parse";
import { R, writeBinaryModel, type WriteInstance } from "@/server/roblox/writer";
import type { RobloxManifest } from "./manifest";
import { layoutUiRoot, plainText, TOPBAR_INSET, uiRoots, type MeasureText, type UiBox } from "./ui-layout";

/** Deterministic test font: every character is half the text size wide; words wrap greedily. */
const measure: MeasureText = (text, style, size, maxWidth) => {
  const charW = size * 0.5;
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (maxWidth !== null && line && next.length * charW > maxWidth) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    lines.push(line);
  }
  return { width: Math.max(...lines.map((l) => l.length * charW)), height: lines.length * size * style.lineHeight };
};

const I = (className: string, props: WriteInstance["props"], children: WriteInstance[] = []): WriteInstance => ({ className, props, children });

function shopUi(): RobloxManifest {
  const file = writeBinaryModel([
    I("ScreenGui", { Name: R.str("ShopGui"), IgnoreGuiInset: R.bool(false) }, [
      I("Frame", { Name: R.str("Panel"), Size: R.udim2(0.5, 0, 0.5, 0), Position: R.udim2(0.5, 0, 0.5, 0), AnchorPoint: R.v2(0.5, 0.5), BackgroundColor3: R.color(0.1, 0.1, 0.2) }, [
        I("UIPadding", { PaddingTop: R.udim(0, 10), PaddingRight: R.udim(0, 10), PaddingBottom: R.udim(0, 10), PaddingLeft: R.udim(0, 10) }),
        I("UIListLayout", { FillDirection: R.enum(1), Padding: R.udim(0, 5), HorizontalAlignment: R.enum(0), SortOrder: R.enum(2) }),
        I("UICorner", { CornerRadius: R.udim(0, 12) }),
        I("TextLabel", { Name: R.str("B"), LayoutOrder: R.int(2), Size: R.udim2(1, 0, 0, 40), Text: R.str("Second"), TextScaled: R.bool(true), FontFace: R.font("GothamSSm", 700) }),
        // Different classes keep the writer from sharing property defaults between test instances.
        I("TextButton", { Name: R.str("A"), LayoutOrder: R.int(1), Size: R.udim2(1, 0, 0, 30), Text: R.str("<b>First</b> &amp; best"), RichText: R.bool(true), TextSize: R.f32(18), Font: R.enum(26) }),
        I("ImageLabel", { Name: R.str("Icon"), LayoutOrder: R.int(3), Size: R.udim2(0, 50, 0, 50), Image: R.str("rbxassetid://123"), ScaleType: R.enum(3) }, [
          I("UIAspectRatioConstraint", { AspectRatio: R.f32(2) }),
        ]),
      ]),
      I("Frame", { Name: R.str("Grid"), Size: R.udim2(0, 300, 0, 200) }, [
        I("UIGridLayout", { CellSize: R.udim2(0, 90, 0, 90), CellPadding: R.udim2(0, 10, 0, 10) }),
        ...["One", "Two", "Three", "Four"].map((n, k) => I("Frame", { Name: R.str(n), LayoutOrder: R.int(k) })),
      ]),
      I("Frame", { Name: R.str("Limited"), Size: R.udim2(1, 0, 1, 0) }, [I("UISizeConstraint", { MaxSize: R.v2(100, 50) })]),
      I("TextBox", { Name: R.str("Hidden"), Visible: R.bool(false), Text: R.str("x") }),
    ]),
  ]);
  return buildManifest(parseRobloxFile(file));
}

const find = (boxes: UiBox[], m: RobloxManifest, name: string): UiBox => {
  for (const b of boxes) {
    if (m.nodes[b.node]!.n === name) return b;
    const inner = b.children.length ? findOrNull(b.children, m, name) : null;
    if (inner) return inner;
  }
  throw new Error(`no box ${name}`);
};
const findOrNull = (boxes: UiBox[], m: RobloxManifest, name: string): UiBox | null => {
  try {
    return find(boxes, m, name);
  } catch {
    return null;
  }
};

describe("UI manifest", () => {
  it("extracts layout, text, fonts and images from a Roblox UI file", () => {
    const m = shopUi();
    expect(m.capabilities.ui).toBe(true);
    expect(manifestMeta(m).primary).toBe("ui");
    const node = (name: string) => m.nodes.find((n) => n.n === name)!;
    expect(node("Panel").r).toMatchObject({ g: 1, size: [0.5, 0, 0.5, 0], anchor: [0.5, 0.5] });
    expect(node("B").r).toMatchObject({ text: "Second", tScaled: true, font: "GothamSSm", fw: 700, fi: false });
    // Legacy Font enum (26 = FredokaOne) when there's no FontFace.
    expect(node("A").r).toMatchObject({ font: "FredokaOne", rich: true });
    expect(node("Icon").r).toMatchObject({ img: "rbxassetid://123", st: 3 });
    expect(m.resources).toEqual([expect.objectContaining({ contentId: "rbxassetid://123", kind: "texture", affectsPreview: true })]);
    expect(m.support.find((s) => s.className === "TextLabel")?.level).toBe("approximate");
  });
});

describe("UI layout", () => {
  const m = shopUi();
  const [root] = uiRoots(m);
  const ui = layoutUiRoot(m, root!, { screen: { width: 1000, height: 658 }, measure });

  it("sits below Roblox's top bar and resolves UDim2 + AnchorPoint", () => {
    expect(ui.inset).toBe(TOPBAR_INSET);
    expect(find(ui.children, m, "Panel")).toMatchObject({ x: 250, y: 150 + TOPBAR_INSET, w: 500, h: 300 });
  });

  it("stacks a UIListLayout by LayoutOrder inside UIPadding, with aspect-ratio constraints", () => {
    expect(find(ui.children, m, "A")).toMatchObject({ x: 10, y: 10, w: 480, h: 30 });
    expect(find(ui.children, m, "B")).toMatchObject({ x: 10, y: 45, w: 480, h: 40 });
    // 50×50 fitted to 2:1, centred horizontally.
    expect(find(ui.children, m, "Icon")).toMatchObject({ x: 225, y: 90, w: 50, h: 25 });
  });

  it("fits TextScaled text to its box (capped at 100)", () => {
    expect(find(ui.children, m, "B").textSize).toBe(40);
    expect(find(ui.children, m, "A").textSize).toBe(18);
  });

  it("wraps UIGridLayout cells onto rows", () => {
    expect(find(ui.children, m, "Three")).toMatchObject({ x: 200, y: 0, w: 90, h: 90 });
    expect(find(ui.children, m, "Four")).toMatchObject({ x: 0, y: 100 });
  });

  it("applies UISizeConstraint and keeps hidden objects out of layouts", () => {
    expect(find(ui.children, m, "Limited")).toMatchObject({ w: 100, h: 50 });
    expect(m.nodes[find(ui.children, m, "Hidden").node]!.r.vis).toBe(false);
  });

  it("ignores the top bar when the ScreenGui asks to", () => {
    const flat = buildManifest(parseRobloxFile(writeBinaryModel([I("ScreenGui", { IgnoreGuiInset: R.bool(true) }, [I("Frame", { Name: R.str("Full"), Size: R.udim2(1, 0, 1, 0) })])])));
    const laid = layoutUiRoot(flat, uiRoots(flat)[0]!, { screen: { width: 800, height: 600 }, measure });
    expect(laid.children[0]).toMatchObject({ x: 0, y: 0, w: 800, h: 600 });
  });

  it("wraps loose GuiObjects (a Frame exported on its own) in a virtual screen", () => {
    const loose = buildManifest(parseRobloxFile(writeBinaryModel([I("Frame", { Name: R.str("Card"), Size: R.udim2(0, 200, 0, 100) })])));
    const roots = uiRoots(loose);
    expect(roots).toEqual([{ node: -1, kind: "screen", name: "UI (no ScreenGui)" }]);
    expect(layoutUiRoot(loose, roots[0]!, { screen: { width: 800, height: 600 }, measure }).children[0]).toMatchObject({ w: 200, h: 100 });
  });

  it("strips rich text for measuring", () => {
    expect(plainText({ text: "<b>First</b> &amp; best<br/>line", rich: true })).toBe("First & best\nline");
  });
});

describe("rich text", () => {
  it("parses Roblox markup into a safe tree", async () => {
    const { parseRichText } = await import("./rich-text");
    const tree = parseRichText('Buy <font color="#FF7800" size="40" weight="bold">GEMS</font><br/>&lt;now&gt; <b><i>x</i></b><!-- note -->');
    expect(tree).toEqual([
      { type: "text", text: "Buy " },
      { type: "span", style: { color: [1, 120 / 255, 0], size: 40, weight: 700 }, children: [{ type: "text", text: "GEMS" }] },
      { type: "br" },
      { type: "text", text: "<now> " },
      { type: "span", style: { bold: true }, children: [{ type: "span", style: { italic: true }, children: [{ type: "text", text: "x" }] }] },
    ]);
  });
  it("keeps unknown tags and stray closers as text (never as HTML)", async () => {
    const { parseRichText } = await import("./rich-text");
    expect(parseRichText('<script>alert(1)</script></b>')).toEqual([{ type: "text", text: "<script>alert(1)</script></b>" }]);
    expect(parseRichText('<stroke color="rgb(0,0,0)" thickness="2">Hi</stroke>')[0]).toMatchObject({ style: { stroke: { color: [0, 0, 0], thickness: 2, transparency: 0 } } });
  });
});
