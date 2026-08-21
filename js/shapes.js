// ── Shapes ─────────────────────────────────────────────────────────────────────
// Single source of truth for how every component body is drawn. Used by
// board.js (real placed components + the in-canvas hover ghost) and
// palette.js (the OS-level drag-cursor image) — so a fix here always
// applies everywhere. This exists specifically because we kept getting bugs
// where a shape was fixed in one file's hand-copied duplicate and not the
// other's; now there is only one copy of "what a pot looks like."
//
// Every function takes `ctx` explicitly as its first argument. Nothing here
// depends on any caller's private state.

const Shapes = (() => {

  function roundRect(ctx,x,y,w,h,r){
    ctx.beginPath();ctx.moveTo(x+r,y);ctx.lineTo(x+w-r,y);ctx.quadraticCurveTo(x+w,y,x+w,y+r);
    ctx.lineTo(x+w,y+h-r);ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h);
    ctx.lineTo(x+r,y+h);ctx.quadraticCurveTo(x,y+h,x,y+h-r);
    ctx.lineTo(x,y+r);ctx.quadraticCurveTo(x,y,x+r,y);ctx.closePath();
  }

  const BANDS=['#000','#8B4513','#f00','#f80','#ff0','#0a0','#00f','#808','#999','#fff'];
  // Standard resistor tolerance color-band code — brown=1%, red=2%,
  // gold=5%, silver=10%; 20% traditionally has no 4th band at all on a
  // real part, but this app always renders 4 band slots, so a neutral
  // gray stands in for "no precision band" rather than a real color.
  const TOLERANCE_BAND_COLORS = { '1%':'#8B4513', '2%':'#f00', '5%':'#c8a000', '10%':'#aaa', '20%':'#666' };
  function resBands(ohms, tolerance){
    const m=parseFloat(ohms.toPrecision(2)),s=m.toString().replace('.','').padStart(2,'0').split('').map(Number);
    return[BANDS[s[0]%10],BANDS[s[1]%10],BANDS[Math.max(0,Math.floor(Math.log10(ohms)-1))%10],TOLERANCE_BAND_COLORS[tolerance]||TOLERANCE_BAND_COLORS['5%']];
  }

  function drawResistor(ctx,res,bw,bh,tolerance){
    ctx.fillStyle='#d4b896';roundRect(ctx,-bw/2,-bh/2,bw,bh,3);ctx.fill();
    ctx.strokeStyle='#b09070';ctx.lineWidth=0.5;ctx.stroke();
    resBands(res||10000,tolerance).forEach((h,i)=>{ctx.fillStyle=h;ctx.fillRect(-bw/2+6+i*6,-(bh-2)/2,4,bh-2);});
  }

  const CAP_COLORS = {
    Film:       { fill: '#e8c860', stroke: '#c8a840' },
    Ceramic:    { fill: '#b5502a', stroke: '#8a3a1c' }, // brick-orange
    Monolithic: { fill: '#e0932a', stroke: '#b5721c' }, // yellow-orange
  };
  function drawFilmCap(ctx,bw,bh,capType){
    const c = CAP_COLORS[capType] || CAP_COLORS.Film;
    ctx.fillStyle=c.fill;roundRect(ctx,-bw/2,-bh/2,bw,bh,2);ctx.fill();
    ctx.strokeStyle=c.stroke;ctx.lineWidth=0.5;ctx.stroke();
  }

  function drawElectroCap(ctx,color,bw){
    const r=bw/2;
    ctx.beginPath();ctx.arc(0,0,r,0,Math.PI*2);ctx.fillStyle=color;ctx.fill();
    ctx.strokeStyle='rgba(255,255,255,0.15)';ctx.lineWidth=0.8;ctx.stroke();
    // Polarity stripe: a circular segment (straight chord + arc), NOT a
    // wedge through center — real caps have a straight-edged band.
    // On the RIGHT (leg[last]'s side) — board.js's ang = atan2(leg[last]
    // - leg[0]) means local +x always points toward leg[last], and
    // leg_labels=['+','-'] means leg[last] is the '-' (stripe) leg. This
    // used to be drawn on the LEFT (leg[0]'s side) unconditionally, which
    // misrepresented every electrolytic cap's real wiring regardless of
    // rotation — the stripe must track the actual polarity data, not a
    // fixed geometric side.
    ctx.beginPath();ctx.arc(0,0,r,-Math.PI*0.4,Math.PI*0.4);ctx.closePath();
    ctx.fillStyle='rgba(255,255,255,0.55)';ctx.fill();
    ctx.fillStyle='rgba(20,20,40,0.9)';
    ctx.font=`bold ${Math.max(8,r*0.65)}px monospace`;ctx.textAlign='center';
    ctx.fillText('–',r*0.55,r*0.22);
  }

  // hex '#rrggbb' -> [r,g,b], 0-255 each.
  function hexToRgb(hex){
    const n=parseInt(hex.slice(1),16);
    return [(n>>16)&255,(n>>8)&255,n&255];
  }
  // Blends an [r,g,b] toward white by `amount` (0 = no change, 1 = pure white).
  function mixWhite(rgb,amount){
    return rgb.map(c=>Math.round(c+(255-c)*amount));
  }
  function rgba(rgb,a){ return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`; }

  function drawLED(ctx,hex,bw,bh,brightness){
    brightness=brightness||0;
    const rgb=hexToRgb(hex);
    const lit=brightness>0.05;

    // Ambient bloom: a soft, wide wash on the board surface AROUND the LED
    // (drawn first, so the body sits on top of it). This alone used to read
    // as a drop shadow — per direct feedback comparing against a reference
    // LED simulator, because the LED's own opaque body then completely
    // covered the glow's brightest point, leaving only a dim outer ring
    // visible peeking past the body's silhouette. Kept, but as only HALF
    // the effect now (see the overlay pass below, drawn after the body,
    // which is what actually fixes that).
    if(lit){
      // ONE continuous fade, not a separate bright-color "plateau" partway
      // out — an earlier version had a core stop, a saturated-color mid
      // stop, THEN a lighter outer stop before transparent, and at high
      // brightness that created a visible dim ring: the additive overlay
      // pass below (which brightens the LED's own case) and this bloom's
      // own bright zone didn't hand off smoothly, leaving a gap of
      // relatively low combined brightness between them. Per direct
      // feedback: the overlay already makes the LED itself read as bright
      // enough, so this bloom only needs to fade smoothly outward from
      // there, not carry its own separate hot zone. Lightens toward white
      // as it goes (not just fading the LED's raw saturated hue toward
      // transparent) so the tail blends cleanly into the board's light tan
      // surface instead of desaturating toward gray.
      const radius=bw*(1.3+brightness*1.9);
      const g=ctx.createRadialGradient(0,0,0,0,0,radius);
      g.addColorStop(0, rgba(mixWhite(rgb,0.6), brightness*0.55));
      g.addColorStop(1, rgba(mixWhite(rgb,0.85),0));
      ctx.beginPath();ctx.arc(0,0,radius,0,Math.PI*2);ctx.fillStyle=g;ctx.fill();
    }

    const r=bw/2,h=bh/2;
    // Body mirrored horizontally from a plain left-flat/right-dome LED:
    // dome (anode, '+') on the LEFT, flat face (cathode, '–') on the
    // RIGHT — default orientation reads '+' on the left. Mirrored via
    // transform so the geometry can't drift out of sync with itself; text
    // is drawn afterward, outside the mirror, so glyphs stay upright.
    //
    // domeR clamped to min(r,h): the arc drawn below always starts/ends at
    // (0,±domeR) regardless of what x-offset the straight sides use, so the
    // two MUST match or the path silently draws a straight connecting
    // segment between whatever mismatched points were given — which is
    // exactly what produced a visible diagonal notch at the seam once
    // body_width and body_height stopped being equal (this shape was
    // apparently only ever tuned by eye at a roughly-square size; the old
    // code connected to (r*0.3, ±h), a point that only coincides with the
    // arc's real (0, ±r) start/end when r===h). Using the shared domeR for
    // BOTH the straight-side endpoint and the arc radius keeps the path
    // geometrically closed for any body_width/body_height combination.
    const domeR=Math.min(r,h);
    ctx.save();
    ctx.scale(-1,1);
    ctx.beginPath();ctx.moveTo(-r,-h);ctx.lineTo(-r,h);ctx.lineTo(0,h);
    ctx.arc(0,0,domeR,Math.PI*0.5,-Math.PI*0.5,true);ctx.lineTo(0,-h);ctx.closePath();
    ctx.fillStyle=lit?hex:hex+'88';ctx.fill();
    ctx.strokeStyle='rgba(0,0,0,0.4)';ctx.lineWidth=0.8;ctx.stroke();
    ctx.strokeStyle='rgba(255,255,255,0.6)';ctx.lineWidth=1.5;
    ctx.beginPath();ctx.moveTo(-r,-h);ctx.lineTo(-r,h);ctx.stroke();
    ctx.restore();

    // Overlay glow: drawn AFTER the body with an ADDITIVE blend mode
    // ('lighter' — pixel colors sum rather than replace), so light appears
    // to wash OVER the case itself rather than stopping at its silhouette —
    // this is the actual fix for the "looks like a drop shadow" complaint,
    // since a shadow, by definition, never brightens the object casting it.
    // Smaller/tighter than the ambient bloom above (the case itself is what
    // should look lit, not just its surroundings), same white-core-to-hue
    // gradient shape so it still reads as THIS LED's color, not a generic
    // white flash.
    if(lit){
      ctx.save();
      ctx.globalCompositeOperation='lighter';
      const overlayRgb=mixWhite(rgb,0.7+brightness*0.25);
      const overlayRadius=bw*(0.55+brightness*0.55);
      const og=ctx.createRadialGradient(0,0,0,0,0,overlayRadius);
      og.addColorStop(0,   rgba(overlayRgb, brightness*0.9));
      og.addColorStop(0.6, rgba(rgb,        brightness*0.45));
      og.addColorStop(1,   'transparent');
      ctx.beginPath();ctx.arc(0,0,overlayRadius,0,Math.PI*2);ctx.fillStyle=og;ctx.fill();
      ctx.restore();
    }

    ctx.font='bold 7px monospace';ctx.textAlign='center';
    ctx.fillStyle='rgba(255,255,255,0.7)';ctx.fillText('+',-r*0.35,3);
    ctx.fillStyle='rgba(255,255,255,0.5)';ctx.fillText('–',r*0.5,3);
  }

  // Potentiometer: filled circle body + a bottom bracket that always spans
  // the true leg width, so the part visually reaches all three legs
  // regardless of knob size.
  function drawPot(ctx,color,bw,bh,wiper,halfLen){
    const r=bw/2;
    const legW=(halfLen?halfLen*2:bw)+6;
    ctx.fillStyle='#3a3a3a';
    ctx.fillRect(-legW/2,0,legW,bh/2);
    ctx.strokeStyle='rgba(255,255,255,0.15)';ctx.lineWidth=0.8;ctx.strokeRect(-legW/2,0,legW,bh/2);
    ctx.beginPath();ctx.arc(0,0,r,0,Math.PI*2);ctx.fillStyle=color;ctx.fill();
    ctx.strokeStyle='rgba(255,255,255,0.2)';ctx.lineWidth=0.8;ctx.stroke();
    ctx.beginPath();ctx.arc(0,0,r*0.3,0,Math.PI*2);ctx.fillStyle='#555';ctx.fill();
    const a=Utils.mapRange(wiper,0,1,180,360)*(Math.PI/180);
    ctx.strokeStyle='#fff';ctx.lineWidth=2;
    ctx.beginPath();ctx.moveTo(0,0);ctx.lineTo(Math.cos(a)*r*0.25,Math.sin(a)*r*0.25);ctx.stroke();
  }

  function drawDiode(ctx,def,inst,bw,bh){
    const model=inst.props?.model||'1N4148';
    const isGerm=(def.model_params?.[model]?.type)==='germanium';
    if(isGerm){
      ctx.fillStyle='rgba(220,230,240,0.35)';roundRect(ctx,-bw/2,-bh/2,bw,bh,2);ctx.fill();
      ctx.strokeStyle='rgba(80,80,80,0.7)';ctx.lineWidth=1;ctx.stroke();
      ctx.fillStyle='rgba(30,30,30,0.85)';ctx.fillRect(bw/2-5,-bh/2,4,bh);
    }else{
      ctx.fillStyle='#1a1a1a';roundRect(ctx,-bw/2,-bh/2,bw,bh,2);ctx.fill();
      ctx.fillStyle='#ffffff';ctx.fillRect(bw/2-5,-bh/2,3,bh);
    }
  }

  // Zener: same glass-body silhouette and cathode-stripe layout as a plain
  // diode, but with the real, distinct color scheme these parts actually
  // ship in — a burnt-orange/amber body with a black cathode band, unlike a
  // signal diode's near-black body and white band. Same body_color/
  // cathode_color reads from def.visual as every other part's colors do,
  // rather than hardcoding the hex here, so a future model with a different
  // real-world color could override it without touching this function.
  function drawZener(ctx,def,bw,bh){
    const bodyColor = def.visual?.body_color || '#b5651d';
    const cathodeColor = def.visual?.cathode_color || '#111111';
    ctx.fillStyle=bodyColor;roundRect(ctx,-bw/2,-bh/2,bw,bh,2);ctx.fill();
    ctx.fillStyle=cathodeColor;ctx.fillRect(bw/2-5,-bh/2,4,bh);
  }

  // DIP-8 IC package: black body, bright pin-1 marker dot near the +x edge
  // in LOCAL (post-rotation) space — this always lines up with pin 1
  // (legs[0]) because drawIcInst rotates into local space before calling
  // here, buildDipLegs always anchors legs[0] (pin 1) at the highest
  // column of the 8, and holeX(col) increases with col, so localPts[0].x
  // is always the most-positive x. rotateIc180 flips the instance's own
  // leg columns/rows, so this body art never needs to know the current
  // rotation itself.
  //
  // bw/bh are the REAL pin-span width and lead-row height (see drawBody's
  // 'opamp' case), not a static guess — the body silhouette is sized to
  // exactly reach the four pin columns and sit just short of the lead
  // rows, leaving room for drawIcInst's flush pin stubs outside the body
  // edge rather than overlapping it.
  function drawOpamp(ctx,def,bw,bh){
    const bodyColor = def.visual?.body_color || '#1a1a1a';
    ctx.fillStyle=bodyColor;roundRect(ctx,-bw/2,-bh/2,bw,bh,2);ctx.fill();
    ctx.strokeStyle='#000';ctx.lineWidth=0.75;ctx.stroke();
    // Pin-1 marker: a round bright dot near the top-right corner (legs[0]
    // is always the +x corner in this local space — see the module comment
    // above), scaled off the body's own height so it reads clearly at this
    // package's small real-world size without being oversized relative to
    // the body the way a fixed pixel radius would at different zoom levels.
    const markerR = bh*0.18*0.9 - 2; // -2px radius (-4px diameter) on top of the earlier 10%-smaller pass, per direct feedback
    ctx.fillStyle='#cfcfcf';
    ctx.beginPath();ctx.arc(bw/2-bh*0.32,-bh*0.15,markerR,0,Math.PI*2);ctx.fill();
  }

  // Germanium transistor bodies render at 2x the diameter of a standard
  // flat-bottomed part, flat-shaded. Shared so board.js's leg-attachment
  // math and the body drawing here can never drift apart.
  function germCircleGeom(bh){
    const hh=bh/2, r=bh*0.75; // 75% of the previous 2x-diameter size
    return { r, cy: hh-r }; // cy keeps the circle's bottom point anchored at y=+hh (touches the legs)
  }

  // Transistor: D-shape, flat edge at the bottom (touching the legs), dome
  // curving up — sized independently by bw/bh so it always meets the legs
  // exactly. Germanium models get a true circle with a locating tab on the
  // emitter side instead.
  function drawTransistor(ctx,def,inst,color,bw,bh){
    const model=inst.props?.model||'';
    const isGerm=(def.model_params?.[model]?.type)==='germanium';
    const hw=bw/2, hh=bh/2;
    const pinout=(inst.props?.pinout==='CBE')?['C','B','E']:['E','B','C'];

    if(isGerm){
      // Round metal-can package (TO-1/TO-18 style) — 2x diameter of a
      // standard flat-bottomed part, flat-shaded (no gradient) to read as
      // a plain metal case rather than a glossy render.
      const {r,cy}=germCircleGeom(bh);
      const germColor='#a8a8a8';
      ctx.beginPath();ctx.arc(0,cy,r,0,Math.PI*2);ctx.fillStyle=germColor;ctx.fill();
      ctx.strokeStyle='#787878';ctx.lineWidth=0.8;ctx.stroke();

      const eSide = pinout[0]==='E' ? -1 : 1;
      const tabSize = r*0.26;
      const tabPush = 3.5;
      const tabX = eSide*(r+tabPush);
      ctx.fillStyle=germColor;
      ctx.fillRect(tabX-tabSize/2, cy-tabSize/2, tabSize, tabSize);
      ctx.strokeStyle='#787878';ctx.lineWidth=0.6;
      ctx.strokeRect(tabX-tabSize/2, cy-tabSize/2, tabSize, tabSize);
    }else{
      ctx.fillStyle='#111';ctx.beginPath();
      ctx.ellipse(0,hh,hw,bh,0,Math.PI,Math.PI*2);
      ctx.lineTo(-hw,hh);ctx.closePath();ctx.fill();
      ctx.strokeStyle='rgba(255,255,255,0.12)';ctx.lineWidth=0.8;ctx.stroke();
      ctx.strokeStyle='rgba(255,255,255,0.25)';ctx.lineWidth=1;
      ctx.beginPath();ctx.moveTo(-hw,hh);ctx.lineTo(hw,hh);ctx.stroke();
    }
    // Pinout labels: dark text reads better on germanium's light metal
    // body; light text reads better on silicon's black body.
    ctx.fillStyle=isGerm?'rgba(30,30,30,0.75)':'rgba(255,255,255,0.65)';
    ctx.font=`bold ${Math.max(6,hw*0.24)}px IBM Plex Mono,monospace`;ctx.textAlign='center';
    ctx.fillText(pinout[0],-hw*0.55,hh*0.55);
    ctx.fillText(pinout[1],0,hh*0.55);
    ctx.fillText(pinout[2],hw*0.55,hh*0.55);
  }

  // A JFET's package looks like an ordinary silicon transistor's (J201
  // ships TO-92, same as most small BJTs), so this reuses that body shape —
  // but the pin labels are S/G/D, not E/B/C, so it can't just call
  // drawTransistor with a relabeled pinout array: that function's germanium
  // tab-side logic is keyed specifically on 'E', which has no JFET meaning.
  function drawJfet(ctx,def,inst,bw,bh){
    const hw=bw/2, hh=bh/2;
    const JFET_LABELS = { SGD:['S','G','D'], DGS:['D','G','S'], GSD:['G','S','D'] };
    const pinout = JFET_LABELS[inst.props?.pinout] || JFET_LABELS.SGD;
    ctx.fillStyle='#111';ctx.beginPath();
    ctx.ellipse(0,hh,hw,bh,0,Math.PI,Math.PI*2);
    ctx.lineTo(-hw,hh);ctx.closePath();ctx.fill();
    ctx.strokeStyle='rgba(255,255,255,0.12)';ctx.lineWidth=0.8;ctx.stroke();
    ctx.strokeStyle='rgba(255,255,255,0.25)';ctx.lineWidth=1;
    ctx.beginPath();ctx.moveTo(-hw,hh);ctx.lineTo(hw,hh);ctx.stroke();
    ctx.fillStyle='rgba(255,255,255,0.65)';
    ctx.font=`bold ${Math.max(6,hw*0.24)}px IBM Plex Mono,monospace`;ctx.textAlign='center';
    ctx.fillText(pinout[0],-hw*0.55,hh*0.55);
    ctx.fillText(pinout[1],0,hh*0.55);
    ctx.fillText(pinout[2],hw*0.55,hh*0.55);
  }

  // Same TO-92 body as drawJfet — the pin labels differ (D/G/S, and only two
  // pinout options rather than JFET's three, per transistor_mosfet_n.json).
  function drawMosfet(ctx,def,inst,bw,bh){
    const hw=bw/2, hh=bh/2;
    const MOSFET_LABELS = { DGS:['D','G','S'], SGD:['S','G','D'] };
    const pinout = MOSFET_LABELS[inst.props?.pinout] || MOSFET_LABELS.DGS;
    ctx.fillStyle='#111';ctx.beginPath();
    ctx.ellipse(0,hh,hw,bh,0,Math.PI,Math.PI*2);
    ctx.lineTo(-hw,hh);ctx.closePath();ctx.fill();
    ctx.strokeStyle='rgba(255,255,255,0.12)';ctx.lineWidth=0.8;ctx.stroke();
    ctx.strokeStyle='rgba(255,255,255,0.25)';ctx.lineWidth=1;
    ctx.beginPath();ctx.moveTo(-hw,hh);ctx.lineTo(hw,hh);ctx.stroke();
    ctx.fillStyle='rgba(255,255,255,0.65)';
    ctx.font=`bold ${Math.max(6,hw*0.24)}px IBM Plex Mono,monospace`;ctx.textAlign='center';
    ctx.fillText(pinout[0],-hw*0.55,hh*0.55);
    ctx.fillText(pinout[1],0,hh*0.55);
    ctx.fillText(pinout[2],hw*0.55,hh*0.55);
  }

  function drawSwitch(ctx,bw,bh,onColor,offColor,closed){
    ctx.fillStyle='#3a3a3a';roundRect(ctx,-bw/2,-bh/2,bw,bh,3);ctx.fill();
    ctx.strokeStyle=closed?onColor:offColor;ctx.lineWidth=2.5;
    ctx.beginPath();ctx.moveTo(-bw/2+6,0);ctx.lineTo(bw/2-6,closed?0:-bh/2+4);ctx.stroke();
    ctx.fillStyle=closed?onColor:offColor;
    ctx.font='8px IBM Plex Mono,monospace';ctx.textAlign='center';ctx.fillText(closed?'ON':'OFF',0,bh/2-2);
  }

  function drawPower(ctx,color,bw,bh,v,reversed,ang){
    const hw=bw/2,hh=bh/2;
    const blue='rgba(43,87,154,0.85)', red='rgba(176,32,46,0.85)';
    ctx.fillStyle=reversed?red:blue; ctx.fillRect(-hw,-hh,bw/2,bh);
    ctx.fillStyle=reversed?blue:red; ctx.fillRect(0,-hh,bw/2,bh);
    ctx.strokeStyle='rgba(255,255,255,0.2)';ctx.lineWidth=0.8;roundRect(ctx,-hw,-hh,bw,bh,3);ctx.stroke();

    // Text always reads upright/left-to-right on screen, regardless of how
    // the component itself is rotated — cancel the ambient rotation just
    // for the glyphs, at each label's own anchor point.
    const upright=(x,y,draw)=>{ctx.save();ctx.translate(x,y);ctx.rotate(-(ang||0));draw();ctx.restore();};

    ctx.fillStyle='#fff';ctx.font=`bold ${Math.max(7,bh*0.45)}px IBM Plex Mono,monospace`;ctx.textAlign='center';
    upright(0,3,()=>ctx.fillText(`${v}V`,0,0));

    ctx.font='bold 8px monospace';
    upright(hw*0.6,-hh+9,()=>{ctx.fillStyle='rgba(255,255,255,0.8)';ctx.fillText(reversed?'–':'+',0,0);});
    upright(-hw*0.6,-hh+9,()=>{ctx.fillStyle='rgba(255,255,255,0.8)';ctx.fillText(reversed?'+':'–',0,0);});
  }

  function miniWave(ctx,type,x,y,w,h){
    ctx.beginPath();
    for(let i=0;i<=40;i++){
      const t=i/40,px=x+t*w,ph=t*Math.PI*4;
      let v;switch(type){case'Sine':v=Math.sin(ph);break;case'Square':v=Math.sign(Math.sin(ph));break;
        case'Sawtooth':v=((ph/(Math.PI*2))%1)*2-1;break;case'Triangle':v=Math.asin(Math.sin(ph))*(2/Math.PI);break;default:v=(Math.random()*2-1)*0.5;}
      i===0?ctx.moveTo(px,y-v*h/2):ctx.lineTo(px,y-v*h/2);
    }
    ctx.stroke();
  }

  function drawSigGen(ctx,color,bw,bh,waveform,scopeTraceColor){
    ctx.fillStyle=color;roundRect(ctx,-bw/2,-bh/2,bw,bh,4);ctx.fill();
    ctx.strokeStyle=scopeTraceColor||'#33ff99';ctx.lineWidth=1.5;
    miniWave(ctx,waveform,-bw/2+4,-3,bw-8,8);
  }

  function drawDefault(ctx,def,bw,bh,col){
    ctx.fillStyle=col;roundRect(ctx,-bw/2,-bh/2,bw,bh,3);ctx.fill();
    ctx.fillStyle='#fff';ctx.font='bold 9px IBM Plex Mono,monospace';ctx.textAlign='center';
    ctx.fillText(def.symbol||def.id.slice(0,4).toUpperCase(),0,3);
  }

  // ── Dispatcher ─────────────────────────────────────────────────────────────\

  function drawBody(ctx,def,inst,theme,halfLen,ang){
    const bw=def.visual?.body_width||28, bh=def.visual?.body_height||14, col=def.visual?.body_color||'#888';
    switch(def.id){
      case 'resistor':              drawResistor(ctx,inst.props.resistance,bw,bh,inst.props.tolerance); break;
      case 'capacitor':             drawFilmCap(ctx,bw,bh,inst.props.type); break;
      case 'capacitor_electrolytic':drawElectroCap(ctx,col,bw); break;
      case 'led':{const cm=def.color_map?.[inst.props.color]||{};drawLED(ctx,cm.hex||'#ff2200',bw,bh,inst._brightness||0);break;}
      case 'potentiometer':  drawPot(ctx,col,bw,bh,inst.props.wiper??0.5,halfLen); break;
      case 'diode':          drawDiode(ctx,def,inst,bw,bh); break;
      case 'zener_diode':    drawZener(ctx,def,bw,bh); break;
      case 'transistor_npn':
      case 'transistor_pnp': drawTransistor(ctx,def,inst,col,bw,bh); break;
      case 'transistor_jfet_n': drawJfet(ctx,def,inst,bw,bh); break;
      case 'transistor_mosfet_n': drawMosfet(ctx,def,inst,bw,bh); break;
      case 'switch_spst':    drawSwitch(ctx,bw,bh,theme?.success||'#33cc66',theme?.alert||'#e6394a',Utils.isSwitchClosed(inst)); break;
      case 'power_supply':   drawPower(ctx,col,bw,bh,inst.props.voltage,!!inst.props.reverse_polarity,ang); break;
      case 'signal_generator':drawSigGen(ctx,col,bw,bh,inst.props.waveform,theme?.scopeTrace); break;
      default:
        if (def.category === 'ic') {
          // Any DIP-shaped IC (op-amp, PT2399, future parts) shares one real
          // body renderer, dispatched by category rather than a hardcoded
          // 'opamp' id — that hardcoding was a real bug: it meant PT2399
          // silently fell through to this generic drawDefault box (a static
          // def.visual-sized rounded rect with no relationship to its actual
          // pin span), not the real DIP body shape every other IC gets.
          // drawIcInst passes the REAL pin-span width and lead-row height
          // through halfLen/ang (otherwise unused for an IC) so the body
          // always matches where the leads actually terminate, rather than a
          // static def.visual guess unrelated to this instance's real leg
          // geometry. Falls back to the static size only for contexts that
          // call drawBody without going through drawIcInst (e.g. a palette
          // preview with no real placed legs yet).
          const icW = halfLen || bw, icH = ang || bh;
          drawOpamp(ctx,def,icW,icH);
        } else {
          drawDefault(ctx,def,bw,bh,col);
        }
    }
  }

  return {
    roundRect, resBands,
    drawResistor, drawFilmCap, drawElectroCap, drawLED, drawPot,
    drawDiode, drawZener, drawOpamp, drawTransistor, drawSwitch, drawPower, drawSigGen, miniWave,
    drawDefault, drawBody, germCircleGeom
  };
})();