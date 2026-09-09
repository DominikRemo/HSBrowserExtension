# HS Browser Extension

Utility-Browser-Extension für die Hacker School. Aktuell: Bulk-Delete für CodeHS-Sandbox-Programme.

Auf CodeHS-Seiten bekommt jede Programm-Tabelle eine Checkbox-Spalte, einen
Löschen-Button pro Zeile und einen „Delete selected“-Button in der Kopfzeile.

## Installation (Hacker School Mitarbeitende)

Alle Downloads liegen unter [Releases](https://github.com/DominikRemo/HSBrowserExtension/releases/latest).

**Firefox** — `hs-browser-extension-<version>.xpi` herunterladen und im Browser
öffnen (oder per Drag & Drop auf ein Firefox-Fenster ziehen). Die Datei ist von
Mozilla signiert und aktualisiert sich danach automatisch über `updates.json`.

**Chrome / Edge** — `hs-browser-extension-<version>-chrome.zip` herunterladen und
entpacken, dann unter `chrome://extensions` den Entwicklermodus aktivieren und
„Entpackte Erweiterung laden“ auf den entpackten Ordner zeigen lassen.
Chrome-Installationen aktualisieren sich nicht automatisch — bei einem neuen
Release den Ordner ersetzen und die Erweiterung neu laden.

## Entwicklung

```bash
npm install
npm run lint            # web-ext lint
npm run build           # baut dist/*.zip aus manifest.json + content.js + icons/
npm run start:firefox   # Firefox mit geladener Extension auf codehs.com
npm run start:chrome    # dasselbe für Chromium
```

Die Version steht **nur** in `manifest.json` und `package.json`; `scripts/check-version.sh`
erzwingt in CI, dass beide (und der Git-Tag) übereinstimmen.

## Release

1. Version in `manifest.json` **und** `package.json` erhöhen, auf `main` mergen.
2. Tag pushen: `git tag v0.2.0 && git push origin v0.2.0`

Der [Release-Workflow](.github/workflows/release.yml) baut daraufhin beide
Archive, lässt das `.xpi` von Mozilla signieren, veröffentlicht ein GitHub
Release mit beiden Assets und trägt die neue Version in `updates.json` ein,
sodass bestehende Firefox-Installationen das Update automatisch ziehen.

### Benötigte Repository-Secrets

| Secret | Wofür |
| --- | --- |
| `AMO_JWT_ISSUER` | AMO API Key (JWT issuer) für die Signierung |
| `AMO_JWT_SECRET` | AMO API Secret |

Beide werden unter <https://addons.mozilla.org/developers/addon/api/key/> erzeugt.
