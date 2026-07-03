- Transistors legs get wonky if dragged around a lot
- Electrolytic capacitor stripe need to be straight
- Need DPST, DPDT, and 3PDT switches
- Need to add germanium transistor (silver circle with tab on one side and three legs)
- All transistors need Leakage value
- Need to add germanium diode (clear glass diode with black line on one side)
- All diodes need Leakage value (IR)
- Pot and trans ghost drag images are correct now, but the tops are getting cut off.
- Trans bodies should have pinout on them, not the name of the trans

Future:
- Board needs to be setup much more like a proto-board
    - Permanent power source (i.e., an editable power source should be permanently connected to one side of the power/ground rails)
    - Permanent in (signal generator)
    - Permanent out (audio out)
    - Permanent true bypass switch with permanent on/off LED indicator

Use case: I should be able to connect a jumper from in to out, Run Simulation and hear a bypassed tone (or audio file) from in to out. If bypass switch is turned on in this case, the LED indicator would turn on and it would still output the tone/audio. The OSC and FFT should show the tone/audio visually. At this point, I could add components between in and out (remove the original jumper) and either hear the bypassed tone (bypass switch off) or the effected tone (bypass switch on).