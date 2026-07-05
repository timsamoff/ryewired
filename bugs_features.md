- Make the germanium transistor body 2x bigger with flat shading.
- The spacing between all of the sections in the Properties panel is too great. I appreciate white space, but this could really be tightened up - especially with the rotate buttons. Also, the Remove Component button is weirdly formatted right now, where the trashcan icon isn't aligned with the text.
- Make the default pot Taper to be Linear.
- The capacitor math isn't quite right. Both 0.1 and 0.001 come out as 1mf, when 0.001 should be 1nf. 0.01 comes out as 10mf. Actually, I wonder if there's a better way to do this by allowing users to use a pull-down to select uf, nf, pf, etc...?
- Same with resistors (ohm, kilo, and mega pull-down)?
- The default power supply should be rotated 90 deg CW with the label reading l-to-r, since power on the board is up/down rather than side/side.
- Style the up/down arrows in the numerical entry fields?

Future:
- Board needs to be setup much more like a proto-board
    - Permanent power source (i.e., an editable power source should be permanently connected to one side of the power/ground rails)
    - Permanent in (signal generator)
    - Permanent out (audio out)
    - Permanent true bypass switch with permanent on/off LED indicator

Use case: I should be able to connect a jumper from in to out, Run Simulation and hear a bypassed tone (or audio file) from in to out. If bypass switch is turned on in this case, the LED indicator would turn on and it would still output the tone/audio. The OSC and FFT should show the tone/audio visually. At this point, I could add components between in and out (remove the original jumper) and either hear the bypassed tone (bypass switch off) or the effected tone (bypass switch on).