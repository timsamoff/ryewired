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
  function resBands(ohms){
    const m=parseFloat(ohms.toPrecision(2)),s=m.toString().replace('.','').padStart(2,'0').split('').map(Number);
    return[BANDS[s[0]%10],BANDS[s[1]%10],BANDS[Math.max(0,Math.floor(Math.log10(ohms)-1))%10],'#c8a000'];
  }

  function drawResistor(ctx,res,bw,bh){
    ctx.fillStyle='#d4b896';roundRect(ctx,-bw/2,-bh/2,bw,bh,3);ctx.fill();
    ctx.strokeStyle='#b09070';ctx.lineWidth=0.5;ctx.stroke();
    resBands(res||10000).forEach((h,i)=>{ctx.fillStyle=h;ctx.fillRect(-bw/2+6+i*6,-(bh-2)/2,4,bh-2);});
  }

  function drawFilmCap(ctx,bw,bh){
    ctx.fillStyle='#e8c860';roundRect(ctx,-bw/2,-bh/2,bw,bh,2);ctx.fill();
    ctx.strokeStyle='#c8a840';ctx.lineWidth=0.5;ctx.stroke();
  }

  function drawElectroCap(ctx,color,bw){
    const r=bw/2;
    ctx.beginPath();ctx.arc(0,0,r,0,Math.PI*2);ctx.fillStyle=color;ctx.fill();
    ctx.strokeStyle='rgba(255,255,255,0.15)';ctx.lineWidth=0.8;ctx.stroke();
    // Polarity stripe: a circular segment (straight chord + arc), NOT a
    // wedge through center — real caps have a straight-edged band.
    ctx.beginPath();ctx.arc(0,0,r,Math.PI*0.6,Math.PI*1.4);ctx.closePath();
    ctx.fillStyle='rgba(255,255,255,0.55)';ctx.fill();
    ctx.fillStyle='rgba(20,20,40,0.9)';
    ctx.font=`bold ${Math.max(8,r*0.65)}px monospace`;ctx.textAlign='center';
    ctx.fillText('–',-r*0.55,r*0.22);
  }

  function drawLED(ctx,hex,bw,bh,brightness){
    brightness=brightness||0;
    if(brightness>0.05){
      const g=ctx.createRadialGradient(0,0,0,0,0,bw*(1+brightness*1.5));
      g.addColorStop(0,hex+Math.round(brightness*200).toString(16).padStart(2,'0'));
      g.addColorStop(1,'transparent');
      ctx.beginPath();ctx.arc(0,0,bw*(1+brightness*1.5),0,Math.PI*2);ctx.fillStyle=g;ctx.fill();
    }
    const r=bw/2,h=bh/2;
    // Body mirrored horizontally from a plain left-flat/right-dome LED:
    // dome (anode, '+') on the LEFT, flat face (cathode, '–') on the
    // RIGHT — default orientation reads '+' on the left. Mirrored via
    // transform so the geometry can't drift out of sync with itself; text
    // is drawn afterward, outside the mirror, so glyphs stay upright.
    ctx.save();
    ctx.scale(-1,1);
    ctx.beginPath();ctx.moveTo(-r,-h);ctx.lineTo(-r,h);ctx.lineTo(r*0.3,h);
    ctx.arc(0,0,r,Math.PI*0.5,-Math.PI*0.5,true);ctx.lineTo(r*0.3,-h);ctx.closePath();
    ctx.fillStyle=brightness>0.05?hex:hex+'88';ctx.fill();
    ctx.strokeStyle='rgba(0,0,0,0.4)';ctx.lineWidth=0.8;ctx.stroke();
    ctx.strokeStyle='rgba(255,255,255,0.6)';ctx.lineWidth=1.5;
    ctx.beginPath();ctx.moveTo(-r,-h);ctx.lineTo(-r,h);ctx.stroke();
    ctx.restore();
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
      // Locating tab on the emitter side — real metal cans have a small
      // rim tab marking pin orientation. Same color as the body, pushed
      // outward past the circle's edge rather than straddling it.
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

  // ── Dispatcher ─────────────────────────────────────────────────────────────
  // The one place that maps a component id to its drawing function. `theme`
  // is a small color object: { success, alert, scopeTrace }. Board.js passes
  // its real CSS-variable-driven theme; palette.js passes a plain fallback
  // (the drag-cursor icon doesn't need to track live theme changes).
  function drawBody(ctx,def,inst,theme,halfLen,ang){
    const bw=def.visual?.body_width||28, bh=def.visual?.body_height||14, col=def.visual?.body_color||'#888';
    switch(def.id){
      case 'resistor':              drawResistor(ctx,inst.props.resistance,bw,bh); break;
      case 'capacitor':             drawFilmCap(ctx,bw,bh); break;
      case 'capacitor_electrolytic':drawElectroCap(ctx,col,bw); break;
      case 'led':{const cm=def.color_map?.[inst.props.color]||{};drawLED(ctx,cm.hex||'#ff2200',bw,bh,inst._brightness||0);break;}
      case 'potentiometer':  drawPot(ctx,col,bw,bh,inst.props.wiper??0.5,halfLen); break;
      case 'diode':          drawDiode(ctx,def,inst,bw,bh); break;
      case 'transistor_npn':
      case 'transistor_pnp': drawTransistor(ctx,def,inst,col,bw,bh); break;
      case 'switch_spst':    drawSwitch(ctx,bw,bh,theme?.success||'#33cc66',theme?.alert||'#e6394a',Utils.isSwitchClosed(inst)); break;
      case 'power_supply':   drawPower(ctx,col,bw,bh,inst.props.voltage,!!inst.props.reverse_polarity,ang); break;
      case 'signal_generator':drawSigGen(ctx,col,bw,bh,inst.props.waveform,theme?.scopeTrace); break;
      default: drawDefault(ctx,def,bw,bh,col);
    }
  }

  return {
    roundRect, resBands,
    drawResistor, drawFilmCap, drawElectroCap, drawLED, drawPot,
    drawDiode, drawTransistor, drawSwitch, drawPower, drawSigGen, miniWave,
    drawDefault, drawBody, germCircleGeom
  };
})();