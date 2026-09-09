# HS Browser Extension

Utility-Browser-Extension für die Hacker School. Aktuell: Bulk-Delete für CodeHS-Sandbox-Programme.

Auf CodeHS-Seiten bekommt jede Programm-Tabelle eine Checkbox-Spalte, einen
Löschen-Button pro Zeile und einen „Delete selected“-Button in der Kopfzeile.

## Installation (Hacker School Mitarbeitende)

Alle Downloads liegen unter [Releases](https://github.com/DominikRemo/HSBrowserExtension/releases/latest).

**Firefox** — `hs-browser-extension-<version>.xpi` herunterladen und im Browser
öffnen (oder per Drag & Drop auf ein Firefox-Fenster ziehen). Die Datei ist von
Mozilla signiert und aktualisiert sich danach automatisch über `updates.json`.

> **Umstieg von der alten Version (vor 0.2.0):** Ab 0.2.0 hat die Erweiterung
> eine neue Add-on-ID (`hs-browser-extension@hacker-school.de` statt
> `CodeHSDelte@hacker-school.de`). Firefox behandelt sie deshalb als komplett
> neue Erweiterung: Die alte Version aktualisiert sich **nicht** von selbst und
> muss einmalig manuell deinstalliert werden, bevor die neue installiert wird.
> Chrome ist davon nicht betroffen.

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

Beim Entwickeln als entpackte Erweiterung gilt: Änderungen an `content.js` landen
**nicht** automatisch im Browser. Nach jeder Änderung unter `chrome://extensions`
auf das ⟳-Symbol der Erweiterung klicken und danach den CodeHS-Tab neu laden.

### Testdaten

[`scripts/seed-test-data.js`](scripts/seed-test-data.js) füllt die Sandbox mit
Wegwerf-Ordnern und -Programmen, damit man zum Testen nicht alles einzeln
anklicken muss. Kein Teil der Erweiterung — Inhalt der Datei in die
DevTools-Konsole auf <https://codehs.com/sandbox> einfügen (eingeloggt), dann:

```js
await seedTestData()                      // 5 Ordner, 40 Programme (Standard)
await seedTestData({folders: 2, programs: 10})
await seedTestData({loose: 0})            // alle Programme in Ordner legen
await deleteEverything()                  // Sandbox wieder leeren
```

Standardmäßig liegen ~70 % der Programme in Ordnern und der Rest auf oberster
Ebene. Das ist die Konstellation, die die Erweiterung wirklich fordert: Ordner-
und Programmzeilen gemischt in einem Grid und mehr Zeilen, als auf den Bildschirm
passen, sodass Virtualisierung und „Alle auswählen“ getestet werden.

`deleteEverything()` löscht nur die aktuell geladenen Zeilen — Programme aus
gelöschten Ordnern rutschen auf die oberste Ebene, daher ggf. zweimal ausführen.

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
