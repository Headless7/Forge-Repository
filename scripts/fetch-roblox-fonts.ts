/**
 * Downloads the open-licensed (OFL / Apache-2.0) fonts that Roblox UI uses — or the closest
 * open substitutes for Roblox-only fonts — from Google Fonts into public/roblox-fonts/, with
 * each family's licence, and writes the @font-face rules the UI preview loads.
 *
 *   npx tsx scripts/fetch-roblox-fonts.ts
 *
 * Only the latin + latin-ext subsets are kept; browsers download a file only when a preview
 * actually uses that font.
 */
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve("public/roblox-fonts");
const CSS_OUT = path.resolve("src/components/roblox/roblox-fonts.css");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

/** Google Fonts family → axis spec (css2 syntax) and licence folder in github.com/google/fonts. */
const FAMILIES: Array<{ family: string; axes: string; license: string }> = [
  { family: "Source Sans 3", axes: "ital,wght@0,200..900;1,200..900", license: "ofl/sourcesans3" },
  { family: "Montserrat", axes: "ital,wght@0,100..900;1,100..900", license: "ofl/montserrat" },
  { family: "Oswald", axes: "wght@200..700", license: "ofl/oswald" },
  { family: "Fredoka", axes: "wght@300..700", license: "ofl/fredoka" },
  { family: "Josefin Sans", axes: "ital,wght@0,100..700;1,100..700", license: "ofl/josefinsans" },
  { family: "Roboto", axes: "ital,wght@0,100..900;1,100..900", license: "ofl/roboto" },
  { family: "Roboto Condensed", axes: "ital,wght@0,100..900;1,100..900", license: "ofl/robotocondensed" },
  { family: "Roboto Mono", axes: "ital,wght@0,100..700;1,100..700", license: "ofl/robotomono" },
  { family: "Creepster", axes: "", license: "ofl/creepster" },
  { family: "Comic Neue", axes: "ital,wght@0,300;0,400;0,700;1,300;1,400;1,700", license: "ofl/comicneue" },
  { family: "Titillium Web", axes: "ital,wght@0,200;0,300;0,400;0,600;0,700;0,900;1,400;1,700", license: "ofl/titilliumweb" },
  { family: "Special Elite", axes: "", license: "apache/specialelite" },
  { family: "Nunito", axes: "ital,wght@0,200..1000;1,200..1000", license: "ofl/nunito" },
  { family: "Arimo", axes: "ital,wght@0,400..700;1,400..700", license: "apache/arimo" },
  { family: "Luckiest Guy", axes: "", license: "apache/luckiestguy" },
  { family: "Bangers", axes: "", license: "ofl/bangers" },
  { family: "Press Start 2P", axes: "", license: "ofl/pressstart2p" },
  { family: "Michroma", axes: "", license: "ofl/michroma" },
  { family: "Amatic SC", axes: "wght@400;700", license: "ofl/amaticsc" },
  { family: "Denk One", axes: "", license: "ofl/denkone" },
  { family: "Fondamento", axes: "ital@0;1", license: "ofl/fondamento" },
  { family: "Grenze Gotisch", axes: "wght@100..900", license: "ofl/grenzegotisch" },
  { family: "Indie Flower", axes: "", license: "ofl/indieflower" },
  { family: "Jura", axes: "wght@300..700", license: "ofl/jura" },
  { family: "Kalam", axes: "wght@300;400;700", license: "ofl/kalam" },
  { family: "Merriweather", axes: "ital,wght@0,300..900;1,300..900", license: "ofl/merriweather" },
  { family: "Patrick Hand", axes: "", license: "ofl/patrickhand" },
  { family: "Permanent Marker", axes: "", license: "apache/permanentmarker" },
  { family: "Sarpanch", axes: "wght@400;500;600;700;800;900", license: "ofl/sarpanch" },
  { family: "Ubuntu", axes: "ital,wght@0,300;0,400;0,500;0,700;1,300;1,400;1,500;1,700", license: "ufl/ubuntu" },
  { family: "Inconsolata", axes: "wght@200..900", license: "ofl/inconsolata" },
  { family: "Balthazar", axes: "", license: "ofl/balthazar" },
  { family: "Bodoni Moda", axes: "ital,wght@0,400..900;1,400..900", license: "ofl/bodonimoda" },
  { family: "EB Garamond", axes: "ital,wght@0,400..800;1,400..800", license: "ofl/ebgaramond" },
  { family: "Overpass", axes: "ital,wght@0,100..900;1,100..900", license: "ofl/overpass" },
];

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");

async function main() {
  fs.mkdirSync(path.join(OUT, "licenses"), { recursive: true });
  const rules: string[] = [];
  for (const { family, axes, license } of FAMILIES) {
    const url = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, "+")}${axes ? `:${axes}` : ""}&display=swap`;
    const res = await fetch(url, { headers: { "user-agent": UA } });
    if (!res.ok) throw new Error(`${family}: ${res.status} ${await res.text()}`);
    const css = await res.text();
    // Blocks look like: /* latin */ @font-face { font-family; font-style; font-weight; font-display; src: url(...) format('woff2'); unicode-range }
    const blocks = [...css.matchAll(/\/\* ([a-z-]+) \*\/\s*@font-face \{([^}]+)\}/g)].filter(([, subset]) => subset === "latin" || subset === "latin-ext");
    let n = 0;
    for (const [, subset, body] of blocks) {
      const style = /font-style: (\w+)/.exec(body!)?.[1] ?? "normal";
      const weight = /font-weight: ([\d ]+)/.exec(body!)?.[1]?.trim() ?? "400";
      const src = /url\((https:[^)]+\.woff2)\)/.exec(body!)?.[1];
      const range = /unicode-range: ([^;]+);/.exec(body!)?.[1];
      if (!src) continue;
      const file = `${slug(family)}-${style}-${weight.replace(/\s+/g, "_")}-${subset}.woff2`;
      const bytes = Buffer.from(await (await fetch(src)).arrayBuffer());
      fs.writeFileSync(path.join(OUT, file), bytes);
      rules.push(
        `@font-face {\n  font-family: "Rbx ${family}";\n  font-style: ${style};\n  font-weight: ${weight};\n  font-display: swap;\n  src: url("/roblox-fonts/${file}") format("woff2");\n  unicode-range: ${range};\n}`,
      );
      n++;
    }
    // Families occasionally move between licence folders upstream; try each known location.
    const name = license.split("/")[1]!;
    const candidates = [`${license}/${license.startsWith("apache/") ? "LICENSE.txt" : "OFL.txt"}`, `ofl/${name}/OFL.txt`, `apache/${name}/LICENSE.txt`, `ufl/${name}/UFL.txt`, `ufl/${name}/LICENCE.txt`];
    let licenseText: string | null = null;
    for (const candidate of candidates) {
      const lic = await fetch(`https://raw.githubusercontent.com/google/fonts/main/${candidate}`);
      if (lic.ok) {
        licenseText = await lic.text();
        break;
      }
    }
    if (!licenseText) throw new Error(`${family}: licence not found`);
    fs.writeFileSync(path.join(OUT, "licenses", `${slug(family)}.txt`), licenseText);
    console.log(`${family}: ${n} files`);
  }
  fs.writeFileSync(
    CSS_OUT,
    `/* Generated by scripts/fetch-roblox-fonts.ts — open-licensed fonts used by the Roblox UI preview.\n   Licences: public/roblox-fonts/licenses/. Files download only when a preview uses the font. */\n\n${rules.join("\n\n")}\n`,
  );
  console.log(`wrote ${rules.length} @font-face rules`);
}

void main();
