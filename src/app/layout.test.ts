import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const LAYOUT_PATH = fileURLToPath(new URL("./layout.tsx", import.meta.url));
const source = readFileSync(LAYOUT_PATH, "utf8");

describe("root layout stylesheet contract", () => {
  it("loads no more than the three global stylesheets and no workspace sheet", () => {
    const stylesheets = Array.from(
      source.matchAll(/^import\s+["']([^"']+\.css)["'];?$/gm),
      ([, stylesheet]) => stylesheet,
    );

    expect(stylesheets).toHaveLength(3);
    expect(stylesheets).toEqual([
      "@xyflow/react/dist/style.css",
      "./tokens.css",
      "./globals.css",
    ]);
    expect(stylesheets.some((stylesheet) => /(^|\/)workspace[^/]*\.css$/i.test(stylesheet))).toBe(false);
  });
});
