import { describe, expect, it } from "vitest";
import { buildDiscordMessage, dmSentence, escapeMarkdown, eventSummary, truncate } from "./discord-message";

describe("Discord messages", () => {
  it("escape what people typed so it can't format, link or ping", () => {
    expect(escapeMarkdown("**bold** [x](http://evil) @everyone")).toBe("\\*\\*bold\\*\\* \\[x\\]\\(http://evil\\) @​everyone");
    const summary = eventSummary({ type: "APPROVED", actor: "@here *Lena*", versionNumber: 3, deliverable: "Rig_v2" });
    expect(summary).toBe("**@​here \\*Lena\\*** approved **V3** of Rig\\_v2.");
  });

  it("describe each event in one line", () => {
    expect(eventSummary({ type: "REVIEW_SUBMITTED", actor: "James", versionNumber: 2, resubmission: true })).toBe("**James** resubmitted **V2** for review.");
    expect(eventSummary({ type: "CHANGES_REQUESTED", actor: "Lena", versionNumber: null, deliverable: "Model" })).toBe("**Lena** requested changes on Model.");
    expect(eventSummary({ type: "PUBLISHED", actor: null })).toMatch(/^Someone marked it \*\*Published\*\*.*doesn't deploy/);
  });

  it("disable mentions, link back to Forge and respect Discord's limits", () => {
    const message = buildDiscordMessage({ type: "APPROVED", title: "x".repeat(400), url: "https://forge.example/s/p/b/1?card=P-1", description: "y".repeat(5000), footer: "Project · Board" });
    expect(message.allowed_mentions).toEqual({ parse: [] });
    expect(message.embeds[0]!.title!.length).toBe(256);
    expect(message.embeds[0]!.description!.length).toBe(4000);
    expect(message.components[0]!.components[0]).toEqual({ type: 2, style: 5, label: "Open in Forge", url: "https://forge.example/s/p/b/1?card=P-1" });
    expect(truncate("abc", 5)).toBe("abc");
  });

  it("word direct messages without repeating the card, which is the title", () => {
    const card = { cardKey: "UTD-4", cardTitle: "Sword" };
    expect(dmSentence("REVIEW_REQUESTED", { ...card, versionNumber: 2, deliverable: "Rig", resubmission: true }, "James")).toBe("**James** resubmitted **V2** of **Rig** for your review.");
    expect(dmSentence("ASSIGNED", { ...card, role: "contributor" }, "Lena")).toBe("**Lena** made you a contributor to this card.");
    expect(dmSentence("MENTIONED", card, "*Lena*")).toBe("**\\*Lena\\*** mentioned you in a comment.");
    expect(dmSentence("OVERDUE", { ...card, dueAt: "2026-10-04T12:00:00.000Z" }, null)).toBe("Was due <t:1791115200:R> (<t:1791115200:f>).");
    for (const type of ["ASSIGNED", "REVIEWER_ASSIGNED", "REVIEW_REQUESTED", "CHANGES_REQUESTED", "APPROVED", "UNBLOCKED", "BLOCKED", "MENTIONED", "REPLY", "DUE_SOON", "OVERDUE"]) {
      expect(dmSentence(type, card, "Lena")).not.toMatch(/UTD-4|Sword/);
    }
  });
});
