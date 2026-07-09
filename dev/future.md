# Before You Begin

Before proposing architectural changes:

1. Read the project.
2. Understand the existing systems.
3. Extend existing code whenever practical.
4. Avoid replacing working implementations.
5. This project values maintainability and realism over cleverness.

If documentation and implementation disagree, assume the implementation is newer unless instructed otherwise.

## Future Direction: Ryewired as a Virtual Pedal Prototyping Workbench

Ryewired should evolve from a virtual breadboard into a complete **virtual guitar pedal prototyping workbench**. While the breadboard remains the centerpiece of the application, the surrounding infrastructure should resemble a purpose-built pedal prototyping station similar to the CopperSound DIY Breadboard. The goal is to eliminate unnecessary setup so users can focus on designing and experimenting with circuits rather than assembling test equipment.

Unlike a generic electronics simulator, Ryewired should provide a permanent workbench environment where the user builds only the pedal circuit. The application supplies the supporting hardware.

### Permanent Workbench Hardware

A shallow, integrated strip should span the top of the breadboard. This strip should appear to be part of the breadboard itself—not a separate toolbar or floating panel. It should share the same plastic color, subtle texture, rounded corners, and understated appearance as the breadboard, preserving the clean, elegant aesthetic of the existing interface.

The strip should contain the following permanently mounted hardware:

* Permanent audio input (signal generator and future audio sources)
* Permanent audio output
* Permanent true-bypass footswitch
* Permanent status LED
* Permanent editable current-limiting resistor (CLR) for the bypass LED
* Permanent adjustable DC power supply
* Small Ryewired logo (icon only, no title)

These devices are part of the workbench and are **not draggable components**.

### Permanent Power Supply

The permanent power supply should be permanently connected only to the **top** power and ground rails.

Users who wish to power the lower rails independently should continue using jumpers or place additional power supply components onto the breadboard.

The power supply should expose editable properties such as:

* Output voltage
* Reverse polarity

Future enhancements may include battery sag, current limiting, and other power-related simulation features.

### Input and Output

The permanent Input and Output should represent the audio jacks of a pedal testing station.

Each should visibly connect to a dedicated breadboard connection point through a short printed trace or other subtle visual indicator. The corresponding breadboard hole should clearly indicate where the signal enters and exits the user's circuit.

Ground connections do not need separate indicators because they are implied by the sleeve connections of the audio jacks.

The connection should feel like a real prototyping board rather than software UI.

### Bypass Switch

The permanent bypass switch controls the signal routing of the entire workbench.

When **Bypass OFF**:

* Audio routes directly from Input to Output.
* The user circuit is bypassed.
* The status LED is off.

When **Bypass ON**:

* Audio routes through the user-built circuit.
* The status LED turns on.
* The bypass LED's CLR remains editable so users can observe and experiment with realistic LED behavior.

### Status LED and CLR

The status LED should be permanently mounted adjacent to the bypass switch.

Immediately beside it should be a permanently mounted current-limiting resistor (CLR).

Unlike decorative indicators, the CLR should appear as an actual resistor, reinforcing real-world pedal construction practices. Although permanently positioned, its resistance value should remain editable through the Properties panel.

### Intended Workflow

A new project should be immediately functional.

The user should be able to:

1. Create a new board.
2. Connect a jumper from Input directly to Output.
3. Run the simulation.
4. Immediately hear the clean signal (generated waveform or loaded audio).
5. Observe the signal on both the Oscilloscope and FFT displays.

With only the jumper installed:

* **Bypass OFF**

  * Audio travels directly from Input to Output.
  * LED remains off.

* **Bypass ON**

  * LED turns on.
  * Audio still reaches Output because no effect circuit has been inserted yet.

The user can then remove the Input→Output jumper, construct a pedal circuit between the permanent Input and Output connection points, and instantly compare the clean and effected signals simply by toggling the bypass switch.

### Visual Design

The workbench should remain visually minimal.

The integrated hardware strip should occupy only enough vertical space to house the permanent devices, avoiding the appearance of a bulky control panel.

The breadboard should remain the dominant visual element.

The hardware strip should feel like molded plastic integrated into the breadboard itself rather than software controls layered on top.

The Ryewired logo should appear only as a small icon, subtly embossed or printed on the strip. The application name should not be displayed.

All permanent hardware should resemble actual pedal prototyping equipment rather than abstract UI widgets.

### User Experience Goals

A new user should be producing audio within seconds.

The software should encourage experimentation rather than configuration.

Users should spend their time designing circuits—not building test infrastructure.

Switching between bypassed and effected audio should be immediate, allowing rapid A/B comparison while prototyping.

The overall experience should feel less like operating a circuit simulator and more like sitting at a dedicated guitar pedal development workstation.

### Long-Term Vision

Ryewired is **not** intended to become a schematic editor or a SPICE simulator.

Its purpose is to recreate—and improve upon—the real-world workflow of breadboarding guitar pedals by combining a realistic solderless breadboard with integrated power, signal routing, bypass switching, visual analysis, and audio playback.

Every future feature should support one guiding principle:

> **The workbench provides the infrastructure. The user builds only the circuit.**

Every design decision should reduce the friction between having an idea and hearing that idea through a virtual pedal while preserving the realism, clarity, and simplicity of working at a physical electronics bench.
