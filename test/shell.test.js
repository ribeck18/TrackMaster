import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { STATES } from "../js/router.js";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const css = await readFile(new URL("../css/app.css", import.meta.url), "utf8");
const main = await readFile(new URL("../js/main.js", import.meta.url), "utf8");
const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");

test("markup contains one screen for each state and opens on Enable", () => {
  const screenTags = [...html.matchAll(/<section\s+[^>]*data-screen="([^"]+)"[^>]*>/g)];
  assert.deepEqual(
    screenTags.map((match) => match[1]),
    STATES,
  );

  for (const match of screenTags) {
    const [, state] = match;
    assert.equal(match[0].includes(" hidden"), state !== "enable");
  }
});

test("owned assets are document-relative rather than root-absolute", () => {
  assert.match(html, /href="\.\/css\/app\.css"/);
  assert.match(html, /src="\.\/js\/main\.js"/);
  assert.doesNotMatch(html, /(?:href|src)="\//);
});

test("portrait CSS rotates a landscape-sized root and remaps safe areas", () => {
  assert.match(css, /@media \(orientation: portrait\)/);
  assert.match(css, /width: 100dvh;\s*height: 100dvw;/);
  assert.match(css, /rotate\(90deg\)/);
  assert.match(css, /--safe-inline-start: env\(safe-area-inset-top/);
  assert.match(css, /--safe-inline-end: env\(safe-area-inset-bottom/);
  assert.match(css, /--safe-block-start: env\(safe-area-inset-right/);
  assert.match(css, /--safe-block-end: env\(safe-area-inset-left/);
});

test("full-screen actions are native keyboard-operable buttons", () => {
  assert.match(
    html,
    /<button class="screen-action" type="button" data-action="start-race">/,
  );
  assert.match(
    html,
    /<button class="screen-action" type="button" data-action="complete-lap">/,
  );
  assert.match(main, /\[data-action="start-race"\]'\)\.addEventListener\("click"/);
  assert.match(main, /\[data-action="complete-lap"\]'\)\.addEventListener\("click"/);
  assert.doesNotMatch(html, /<button[^>]+(?:disabled|tabindex="-1")/);
});

test("END RACE stays above the lap action and stops propagation", () => {
  assert.match(css, /\.screen-action \{[\s\S]*?z-index: 1;/);
  assert.match(css, /\.end-button \{[\s\S]*?z-index: 2;/);
  assert.match(
    main,
    /\[data-action="end-race"\]'\)[\s\S]*?event\.stopPropagation\(\);[\s\S]*?dispatch\("END_RACE"\)/,
  );
});

test("secondary guidance text meets the requested contrast floor", () => {
  assert.match(css, /\.meta-note \{\s*color: rgba\(255, 255, 255, 0\.5\);/);
  assert.match(
    css,
    /\.rotation-lock-hint \{[\s\S]*?color: rgba\(255, 255, 255, 0\.5\);/,
  );
});

test("production markup excludes prototype-only phone chrome and switcher", () => {
  assert.doesNotMatch(html, /Dynamic Island/i);
  assert.doesNotMatch(html, /state switcher/i);
  assert.doesNotMatch(html, /phone bezel/i);
});

test("README documents branch deployment and the HTTPS phone URL", () => {
  assert.match(readme, /Settings → Pages/);
  assert.match(readme, /Deploy from a branch/);
  assert.match(readme, /https:\/\/ribeck18\.github\.io\/TrackMaster\//);
  assert.match(readme, /iPhone/i);
});
