Future Workbench Architecture

Ryewired should evolve from a virtual breadboard into a virtual guitar pedal prototyping workbench. The workbench provides the infrastructure; the user builds only the pedal circuit.

The application should always open with a permanent workbench already configured. These workbench devices are fixed, non-draggable parts of the environment.

Permanent Workbench Devices
Audio Input
Audio Output
Adjustable DC Power Supply
True Bypass Switch
Status LED
Current-Limiting Resistor (CLR)

The Status LED and CLR are permanent visual elements. Neither is editable nor movable.

The previous Signal Generator component should be removed from the component palette. Its functionality is absorbed into the permanent Input device.

Power Supply

The permanent power supply is permanently connected only to the upper power and ground rails.

The lower rails remain electrically isolated so users may power them independently using jumpers or additional Power Supply components.

The permanent power supply should expose configurable properties including:

Output voltage
Reverse polarity
Power on/off
Battery sag
Internal resistance
Maximum current/current limiting (future)
Battery health / discharge simulation (future)

Additional realistic power behaviors may be added provided they improve pedal prototyping without introducing unnecessary complexity.

Input

The Input represents the pedal's input jack.

It is the source of all audio entering the pedal.

Supported input sources include:

Sine
Square
Triangle
Sawtooth
White Noise
Pink Noise
Audio File
Live Audio Input (future)

Additional configurable properties may include:

Frequency
Amplitude
DC Offset
Phase
Looping

The Input replaces the former Signal Generator component.

Output

The Output represents the pedal's output jack.

Suggested properties include:

Master Volume
Mute
Output Device (future)
Record Audio (future)
True Bypass

The bypass switch affects only audio routing.

It never enables or disables electrical simulation.

Bypass OFF

Input → Output

The user hears the clean signal.

The Status LED is off.

Bypass ON

Input → User Circuit → Output

The Status LED is on.

If the user has not built a complete signal path, no processed audio is heard.

Electrical Simulation

Electrical simulation is independent of audio routing.

Running the simulation always evaluates the entire circuit, including:

Voltage
Current
LEDs
Diodes
Transistors
Capacitors
Resistors
Power distribution

The bypass switch changes only where the audio travels.

This mirrors the behavior of a real guitar pedal, where the circuit remains powered regardless of bypass state.

Default Workflow

A new project should require no setup.

The expected workflow is:

Create a new project.
Configure the Input source if desired.
Press Run Simulation.
With bypass OFF, the clean input signal is immediately audible at the Output.
Oscilloscope and FFT immediately display the signal.
Build a pedal circuit between the permanent Input and Output connection points.
Engage bypass to hear the processed signal.
Toggle bypass at any time for instant A/B comparison.

The user should never need to construct or wire the testing hardware before beginning circuit development.

Design Philosophy

Ryewired is not intended to be a SPICE simulator or schematic editor.

Its purpose is to reproduce the workflow of developing analog guitar pedals on a real breadboard while taking advantage of software.

Future development should follow these principles:

The workbench provides the infrastructure; the user builds only the circuit.
Audio routing and electrical simulation are separate systems.
Favor realistic pedal-building workflows over generic electronics workflows.
Favor behavioral realism over exhaustive electrical simulation.
Minimize setup and maximize experimentation.
Extend the existing architecture whenever practical.
Avoid unnecessary rewrites or duplicate systems.

North Star: Ryewired should feel like sitting at a dedicated guitar pedal development workstation, not like operating a generic circuit simulator.