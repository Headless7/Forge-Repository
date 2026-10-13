import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LinkedText, RichText, shortUrl } from "./rich-text";

const render = (text: string, mentions?: Set<string>) => renderToStaticMarkup(<RichText text={text} mentions={mentions} />);

describe("RichText", () => {
  it("never renders user HTML", () => {
    const html = render('<img src=x onerror="alert(1)"><script>alert(2)</script>');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
  });

  it("only links http(s) URLs", () => {
    expect(render("[click](javascript:alert(1))")).not.toContain('href="javascript');
    const safe = render("see [docs](https://example.com/a) and https://roblox.com/games");
    expect(safe).toContain('href="https://example.com/a"');
    expect(safe).toContain('rel="noopener noreferrer nofollow"');
    expect(safe).toContain('href="https://roblox.com/games"');
  });

  it("formats bold, italic, code, lists and known mentions", () => {
    const html = render("**Bold** and *soft* with `code`\n- one\n- two\n\nhi @james", new Set(["james"]));
    expect(html).toContain("<strong>Bold</strong>");
    expect(html).toContain("<em>soft</em>");
    expect(html).toContain("<code");
    expect(html).toContain("<li>one</li>");
    expect(html).toMatch(/<span class="[^"]*text-accent[^"]*">@james<\/span>/);
  });
});

describe("RichText Discord videos", () => {
  const cdn = "https://cdn.discordapp.com/attachments/1548444224318341161/1548444226054787212/XRecorder_20260912_14.mp4?ex=6acf4a50&is=6acdf8d0&hm=96b9&";

  it("plays a Discord video link inline and keeps the link", () => {
    const html = render(`Repro: ${cdn} see 0:12`);
    expect(html).toContain(`<video src="${cdn.replace(/&/g, "&amp;")}"`);
    expect(html).toContain('href="' + cdn.replace(/&/g, "&amp;") + '"');
    expect(html).toContain("XRecorder_20260912_14.mp4");
    // Once per link, even when it's pasted twice.
    expect(render(`${cdn}\n${cdn}`).match(/<video /g)).toHaveLength(1);
  });

  it("only embeds videos from Discord's CDN", () => {
    expect(render("https://cdn.discordapp.com/attachments/1/2/shot.png?ex=1&is=1&hm=1")).not.toContain("<video");
    expect(render("https://example.com/attachments/1/2/clip.mp4")).not.toContain("<video");
  });
});

describe("LinkedText", () => {
  const linked = (text: string) => renderToStaticMarkup(<LinkedText text={text} />);

  it("links http(s) addresses with short labels and leaves the rest as text", () => {
    const html = linked("Auto roll stops ( https://discord.com/channels/1242971459203235990/1558769408417996810 ) **not bold**");
    expect(html).toContain('href="https://discord.com/channels/1242971459203235990/1558769408417996810"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
    expect(html).toContain(">discord.com/channels/…/1558769408417996810</a> )");
    expect(html).toContain("**not bold**");
  });

  it("never links other schemes or renders HTML", () => {
    const html = linked('javascript:alert(1) <img src=x onerror="alert(1)">');
    expect(html).not.toContain("<a");
    expect(html).not.toContain("<img");
  });

  it("keeps short addresses whole", () => {
    expect(shortUrl("https://www.roblox.com/games/123")).toBe("roblox.com/games/123");
  });
});
