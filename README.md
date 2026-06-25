# Ryewired

An audio circuit breadboard simulator for hobbyists. Drop components, wire them up, press Play.

---

## Project Structure

```
ryewired/
├── app/                        # Main Electron app
│   ├── main.js                 # Electron main process, IPC, menu
│   ├── preload.js              # Secure context bridge
│   ├── renderer/
│   │   ├── index.html
│   │   ├── icon.png
│   │   ├── css/app.css         # Full variable-driven stylesheet
│   │   └── js/
│   │       ├── utils.js
│   │       ├── storage.js      # File System Access API + download fallback
│   │       ├── components-registry.js
│   │       ├── board.js        # Accurate 830-pt breadboard renderer
│   │       ├── wire.js
│   │       ├── simulation.js   # Behavioral nodal solver
│   │       ├── audio-engine.js # Web Audio API DSP chain
│   │       ├── oscilloscope.js
│   │       ├── properties-panel.js
│   │       ├── palette.js
│   │       └── app.js
│   └── package.json
│
├── admin/                      # Standalone maintainer tool (separate Electron app)
│   ├── main.js
│   ├── preload.js
│   ├── renderer/
│   │   ├── index.html
│   │   ├── icon.png
│   │   ├── css/admin.css
│   │   └── js/admin.js
│   └── package.json
│
└── data/                       # Shared, version-controlled
    ├── components/
    │   ├── manifest.json       # Ordered list of component filenames
    │   ├── resistor.json
    │   ├── capacitor.json
    │   ├── led.json
    │   ├── diode.json
    │   ├── potentiometer.json
    │   ├── transistor_npn.json
    │   ├── switch.json
    │   ├── power_supply.json
    │   └── signal_generator.json
    └── layouts/                # User .rw files — gitignored
```

---

## Setup

### Prerequisites
- Node.js 18+

### Install and run

```powershell
# Main app
cd app
npm install
npm start

# Admin tool (separate window)
cd admin
npm install
npm start
```

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| Space | Run / Stop simulation |
| W | Toggle wiring mode |
| Escape | Stop / cancel wiring / close menus |
| Del / Backspace | Remove selected component |
| Ctrl+N | New layout |
| Ctrl+O | Open layout |
| Ctrl+S | Save layout |
| Ctrl+Shift+S | Save As |
| Ctrl+D | Toggle oscilloscope |
| Ctrl+F | Focus component search |

---

## Board Geometry

Accurate 830-point breadboard:

- **Top rail strip:** blue (–) row above red (+) row, broken at column 32
- **Main grid top half:** rows f–j (columns 1–63), connected vertically per column
- **DIP center gap**
- **Main grid bottom half:** rows e–a (columns 1–63), connected vertically per column
- **Bottom rail strip:** blue (–) row above red (+) row, broken at column 32
- Row letters labeled both sides; column numbers labeled top and bottom of each half
- Holes grouped every 5 columns with visible spacing

---

## File Format (.rw)

Plain JSON, fully portable:

```json
{
  "components": [
    {
      "instanceId": "R1A2B",
      "defId": "resistor",
      "row": 2,
      "col": 10,
      "orientation": "horizontal",
      "props": { "resistance": 10000, "power_rating": "0.25W", "tolerance": "5%" }
    }
  ],
  "wires": [
    { "id": "W3F9A", "r1": 2, "c1": 10, "r2": 7, "c2": 10, "color": "#ff9900" }
  ]
}
```

---

## Adding Components (Admin Tool)

Run `cd admin && npm start`. The admin reads and writes `data/components/`.

1. Click **+ New Component** or select an existing one
2. Fill the Form tab — ID, label, category, behavior type, visual properties
3. Add editable properties (what the user sees in the Properties panel)
4. Add failure modes with thresholds and plain-English messages
5. Use the JSON tab for raw editing (color_map, model_params, etc.)
6. **Save Component** — file is written immediately

After saving, update `data/components/manifest.json` to include the new filename. The main app loads it on next launch.

---

## Component Behavior Types

| Type | Effect in simulation | Effect in audio chain |
|------|---------------------|----------------------|
| `resistor` | Ohm's law, power check | RC low-pass with adjacent cap |
| `capacitor` | Voltage rating check | High-pass (DC blocking) |
| `led` | Current-based brightness | — |
| `diode` | Forward/reverse check | Waveshaper (soft clip) |
| `potentiometer` | Wiper voltage divider | Gain node (real-time) |
| `bjt_npn` | Gain + saturation | Gain + waveshaper |
| `switch_spst` | Open/closed state | — |
| `dc_supply` | Sets Vsupply | — |
| `signal_generator` | — | Audio source |
| `passthrough` | No effect | No effect |

---

## Color System

All colors defined as CSS variables in `app/renderer/css/app.css` `:root`.
Source palette: Wood Grain Brown `#5C4033`, Breadboard White `#FDFDFD`,
Trace Red `#B0202E`, Trace Blue `#2B579A`.

No color values appear outside `:root` except via `var(--name)`.

---

## Roadmap

- [ ] Undo/redo stack
- [ ] Component rotation (vertical leg placement)
- [ ] IC package footprints (DIP-8, DIP-14, DIP-16)
- [ ] PT2399 delay behavioral model
- [ ] CD4069 inverter behavioral model
- [ ] NE5532 / 741 op-amp gain stage
- [ ] Right-click context menu
- [ ] Wire color picker
- [ ] Multiple board sizes
- [ ] Export board as PNG
- [ ] Custom DSP via AudioWorklet
