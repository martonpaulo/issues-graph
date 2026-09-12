import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * `index.html` carries the page's Content-Security-Policy as a meta tag, and the policy allows no
 * inline script or style. Both halves of that live in the same file and are easy to break from it:
 * a meta policy governs only what the document loads after the tag, and one inline snippet — a
 * theme-flash script, a `style` attribute — is silently refused in the browser while every other
 * test still passes. This suite holds the shell to what the policy needs.
 * https://www.w3.org/TR/CSP3/#meta-element
 */

const html = readFileSync(
  fileURLToPath(new URL("../index.html", import.meta.url)),
  "utf8",
).replace(/<!--[\s\S]*?-->/g, "");

const CSP_META =
  /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/g;

describe("the Content-Security-Policy in index.html", () => {
  it("is declared once, before anything it governs", () => {
    const metas = [...html.matchAll(CSP_META)];
    expect(metas).toHaveLength(1);
    const first = html.search(/<(script|link|style)\b/);
    expect(first).toBeGreaterThan(-1);
    expect(metas[0].index).toBeLessThan(first);
  });

  it("refuses inline script and inline style", () => {
    const policy = [...html.matchAll(CSP_META)][0][1];
    const directive = (name: string) =>
      policy
        .split(";")
        .map((part) => part.trim().split(/\s+/))
        .find(([key]) => key === name)
        ?.slice(1);
    expect(directive("script-src")).not.toContain("'unsafe-inline'");
    expect(directive("style-src")).not.toContain("'unsafe-inline'");
  });

  it("leaves the shell no inline script the policy would refuse", () => {
    for (const [tag, body] of html.matchAll(
      /<script\b[^>]*>([\s\S]*?)<\/script>/g,
    )) {
      // JSON-LD is data, not script: script-src does not govern it.
      if (/type="application\/ld\+json"/.test(tag)) continue;
      expect(tag).toMatch(/\bsrc=/);
      expect(body.trim()).toBe("");
    }
  });

  it("leaves the shell no inline style the policy would refuse", () => {
    expect(html).not.toMatch(/<style\b/);
    expect(html).not.toMatch(/\sstyle=/);
  });
});
