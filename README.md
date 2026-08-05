# Ryewired

An audio circuit breadboard simulator for hobbyists.
Drop components, wire them up, press Run.

**Live:** `samoff.com/ryewired`

---

## Structure

```
ryewired/                    ← repo root / web root
├── index.html               ← served at samoff.com/ryewired
├── icon.png
├── css/
│   ├── tokens.css           ← shared design tokens (both app + admin)
│   └── app.css              ← app-specific styles (@import tokens.css)
├── js/
│   ├── utils.js
│   ├── storage.js           ← File System Access API + download fallback
│   ├── components-registry.js
│   ├── board.js             ← accurate 830-pt breadboard renderer
│   ├── wire.js
│   ├── simulation.js
│   ├── audio-engine.js
│   ├── oscilloscope.js
│   ├── properties-panel.js
│   ├── palette.js
│   └── app.js
├── data/
│   └── components/
│       ├── manifest.json    ← auto-updated by admin tool
│       └── *.json           ← one file per component definition
├── admin/                   ← standalone Electron admin tool
│   ├── main.js
│   ├── preload.js
│   ├── package.json
│   └── renderer/
│       ├── index.html
│       ├── icon.png
│       ├── css/
│       │   └── admin.css    ← admin styles (@import ../../css/tokens.css)
│       └── js/admin.js
├── package.json
└── setup.sh
```

---

## Running locally

### As a web app
Serve the repo root over HTTP — VS Code Live Server, or:
```
npx serve .
```
Then open `http://localhost:3000`.

### Admin tool
```
cd admin
npm install
npm start
```
The admin auto-updates `data/components/manifest.json` when you save or delete components.

---

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| Space | Run / Stop |
| W | Toggle wiring mode |
| Esc | Cancel wire / stop sim / close modal |
| Del | Delete selected component |
| + / – | Zoom in / out |
| Ctrl+0 | Fit board to window |
| Ctrl+N/O/S | New / Open / Save |
| Ctrl+D | Toggle oscilloscope |
| Ctrl+F | Search components |

---

## Wiring

Press **W** to enter wiring mode (status bar shows ⬡ WIRING).
Click any hole to start a wire. Click a second hole to complete it.
Press **W** or **Esc** to exit wiring mode.

---

## Reset vs Clear

- **Reset Failures** — clears burned/blown component states but leaves all components and wires in place. Use after a failure to fix the circuit and try again.
- **Clear Board** — removes everything.

---

## CSS tokens

All colors, fonts, and sizing live in `css/tokens.css` as CSS variables.
Both the app (`css/app.css`) and admin (`admin/renderer/css/admin.css`) import this file.
No color values appear outside `:root` in any stylesheet.

---

## Adding components

Run the admin tool. When you save a component it writes the JSON file and auto-regenerates `manifest.json`. Reload the main app to see the new component in the palette.
