```text
# Ryewired AI Project Specification

## Project Overview

Ryewired is a virtual guitar pedal prototyping workbench built around an interactive breadboard environment.

The goal is not to create a generic circuit simulator or schematic editor. Ryewired should simulate the workflow of building and experimenting with analog guitar pedals on a physical prototyping bench while providing software advantages:

- Instant audio feedback
- Visual circuit construction
- Simulation inspection tools
- Easy experimentation
- Non-destructive debugging

## Central Design Philosophy

The workbench provides the infrastructure. The user builds only the pedal circuit.

---

# Current Development Priority

Before adding major new features:

1. Restore lost core workflow behavior.
2. Fix existing simulation bugs.
3. Preserve current architecture whenever possible.
4. Avoid unnecessary rewrites.
5. Extend existing systems rather than creating parallel implementations.

---

# Critical Regression

## Default Audio Workflow Was Removed

A previous version supported this workflow:

1. User opens Ryewired.
2. User selects an input waveform or audio file.
3. User presses Run Simulation.
4. Audio immediately outputs through the Output.
5. Oscilloscope and FFT display the signal.

This worked before any components were placed.

The clean audio path existed because the workbench itself provided:

Input → Output

when bypass was not engaged.

This behavior was unintentionally removed.

---

# Required Restoration

A new project must allow:

Input → Output

without requiring:

- Components
- Jumpers
- Additional wiring

The user should not be blocked by an empty breadboard.

---

# Workbench Architecture

Ryewired should have a permanent hardware layer above the breadboard.

These are not draggable components.

## Permanent Workbench Devices

- Input
- Output
- Power Supply
- True Bypass Switch
- Status LED
- Current Limiting Resistor (CLR)

The workbench should always exist and be immediately usable.

---

# Input System

The Signal Generator component should no longer exist as a user-placeable component.

The Input jack becomes the audio source.

## Supported Sources

- Sine wave
- Square wave
- Triangle wave
- Sawtooth wave
- White noise
- Pink noise
- Audio file
- Future live input

## Input Properties

- Frequency
- Amplitude
- DC offset
- Phase
- Looping

The Input represents what would physically be connected to the pedal input jack.

---

# Output System

The Output represents the pedal output jack.

## Output Properties

- Master volume
- Mute
- Future output device selection
- Future recording/export

---

# True Bypass Behavior

The bypass switch controls only audio routing.

It does not disable electrical simulation.

---

## Bypass OFF

Clean signal path:

Input → Output

Expected behavior:

- Audio passes through immediately.
- Status LED is OFF.

---

## Bypass ON

Effect signal path:

Input → Circuit → Output

Expected behavior:

- Status LED turns ON.
- Audio passes through the user circuit.
- If no valid circuit path exists, output is silent.

---

# Electrical Simulation

Electrical simulation and audio routing are separate systems.

Running simulation evaluates:

- Voltage
- Current
- Component states
- LEDs
- Diodes
- Transistors
- Capacitors
- Resistors

The bypass switch does not stop electrical behavior.

## Example

A user builds:

Power → Resistor → LED → Ground

The LED should simulate whether bypass is on or off.

Bypass only changes the audio path.

---

# Power Supply

The permanent power supply is connected only to the upper power/ground rail.

The bottom rail remains user-controlled.

Users can:

- Add jumpers
- Place additional power supplies
- Create alternate power configurations

---

# Editable Power Supply Properties

- Voltage
- Reverse polarity
- Power on/off
- Battery sag
- Internal resistance

## Future Possibilities

- Maximum current limiting
- Battery discharge
- Battery health
- Power noise
- Voltage ripple

---

# Fixed Hardware

## Status LED

The bypass indicator LED is permanent.

Properties:

- Not editable
- Not movable

Its state is controlled only by bypass.

---

## CLR

The bypass LED current-limiting resistor is permanent.

Properties:

- Not editable
- Not movable

---

# Workbench Tools

Ryewired should use a tool-based interaction model.

Only one tool is active at a time.

Tools should change:

- Cursor appearance
- Hover behavior
- Interaction behavior

---

# Existing Tools

## Selection Tool

Used for:

- Selecting components
- Editing properties
- Moving components

---

## Jumper Tool

Used for:

- Creating electrical connections

---

# New Tools

## Voltage Meter

Purpose:

Measure voltage at any node.

Behavior:

- Selecting the tool changes the cursor to measurement mode.
- Hovering over a breadboard hole displays voltage.
- Display appears near cursor.
- Measurement updates continuously.
- Clicking is not required.

Empty/no-voltage nodes display:

0V

The tool is read-only.

---

## Audio Probe

Purpose:

Listen to audio at any circuit node.

Behavior:

- Selecting the tool changes cursor to probe mode.
- Hovering over a node outputs the audio signal present there.
- Nodes without audio output silence.
- Updates continuously while hovering.
- Independent from main Output.

This should function like probing a real pedal circuit with an oscilloscope/audio probe.

---

# Component Duplication

## Shortcut

Windows:

Ctrl + D

Mac:

Cmd + D

---

# Duplication Behavior

When a component is selected:

1. Duplicate the component.
2. Preserve all editable settings.
3. Create a ghost component attached to the cursor.
4. Allow normal placement.
5. Original component remains unchanged.

---

# Copied Properties

Duplicate:

- Component type
- Rotation
- Orientation
- Electrical values
- Custom settings
- Labels

Do not copy runtime simulation state:

- Current voltage
- Current
- LED brightness
- Cached simulation values

---

# Ghost Component Behavior

Ghost components should:

- Follow cursor position.
- Preview placement.
- Snap according to existing placement rules.
- Confirm placement on click.
- Cancel on Escape.

Duplicate placement should use the same system.

---

# Hover Interaction

All permanent workbench controls should provide hover feedback.

Examples:

- Input jack
- Output jack
- Power supply
- Bypass switch
- Tools

Hover should communicate:

"This is interactive."

---

# Future Workbench Instruments

Possible future tools:

- Current meter
- Continuity tester
- Oscilloscope probe
- Frequency counter
- Logic probe
- Virtual multimeter

All should follow the same tool architecture.

---

# Design Constraints

## Do Not

- Turn Ryewired into a schematic editor.
- Require users to wire basic infrastructure.
- Make permanent hardware draggable.
- Add complexity that reduces experimentation speed.

## Do

- Preserve the physical pedal-building workflow.
- Provide immediate audio feedback.
- Make invisible circuit behavior inspectable.
- Keep the breadboard as the primary creative space.

---

# North Star

Ryewired should feel like sitting at a dedicated guitar pedal development workstation.

The user should open the application and immediately be able to:

1. Generate a signal.
2. Hear output.
3. Build a circuit.
4. Compare bypass/effect.
5. Inspect voltage.
6. Probe audio.
7. Experiment.

The environment should always be ready.

The user's job is to invent the pedal.
```
