// Adds the current manifest version to updates.json, the Firefox update manifest
// that self-distributed installs poll (see browser_specific_settings.gecko.update_url).
// Run after a release has published the signed .xpi as a release asset.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const REPO = "DominikRemo/HSBrowserExtension";
const ASSET = "hs-browser-extension";

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { version } = manifest;
const id = manifest.browser_specific_settings.gecko.id;

const updates = existsSync("updates.json")
  ? JSON.parse(readFileSync("updates.json", "utf8"))
  : { addons: {} };

const entries = updates.addons[id]?.updates ?? [];
const link = `https://github.com/${REPO}/releases/download/v${version}/${ASSET}-${version}.xpi`;

const existing = entries.find((e) => e.version === version);
if (existing) {
  existing.update_link = link;
} else {
  entries.push({ version, update_link: link });
}

updates.addons[id] = { updates: entries };
writeFileSync("updates.json", JSON.stringify(updates, null, 2) + "\n");
console.log(`updates.json now advertises ${version}`);
