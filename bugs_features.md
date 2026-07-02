- Transistors and potentiometers still don't have three legs.
- Tranistor image needs to be 3x larger
- Potentiometer image needs to be 3x larger
- Electrolytic capacitor image needs t be 3x larger
- Need to add germanium transistor (silver circle with tab on one side and three legs)
- All transistors need Leakage value
- Need to add germanium diode (clear glass diode with black line on one side)
- All diodes need Leakage value (IR)

Future:
- Board needs to be setup much more like a proto-board
    - Permanent power source (i.e., an editable power source should be permanently connected to one side of the power/ground rails)
    - Permanent in (signal generator)
    - Permanent out (audio out)
    - Permanent true bypass switch with permanent on/off LED indicator

Use case: I should be able to connect a jumper from in to out, Run Simulation and hear a bypassed tone (or audio file) from in to out. If bypass switch is turned on in this case, the LED indicator would turn on and it would still output the tone/audio. The OSC and FFT should show the tone/audio visually. At this point, I could add components between in and out (remove the original jumper) and either hear the bypassed tone (bypass switch off) or the effected tone (bypass switch on).