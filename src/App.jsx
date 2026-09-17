import { useState, useEffect, useRef, useCallback } from "react";
import Peer from "peerjs";

const g = (x,m,s,a) => a*Math.exp(-0.5*((x-m)/s)**2);
const normalQRST=t=>g(t,.13,.03,.11)+g(t,.225,.007,-.1)+g(t,.248,.013,1.1)+g(t,.272,.007,-.22)+g(t,.43,.055,.21);
const stemiQRST=t=>g(t,.13,.03,.11)+g(t,.225,.007,-.1)+g(t,.248,.013,1.1)+g(t,.272,.007,-.22)+g(t,.335,.05,.30)+g(t,.44,.06,.32);
const waveInterp=(t,pts)=>{
  const x=((t%1)+1)%1;
  for(let i=0;i<pts.length-1;i++){
    const[a,va]=pts[i],[b,vb]=pts[i+1];
    if(x>=a&&x<=b){
      const f=(x-a)/((b-a)||1),sf=f*f*(3-2*f);
      return va+(vb-va)*sf;
    }
  }
  return pts[0][1];
};
// Regular monomorphic VT: one smooth, very broad QRS complex per beat.
// No narrow mid-complex spike/notch: the contour stays rounded throughout the wide complex.
const VT_PTS=[[0,-.26],[.10,-1.05],[.22,-.30],[.36,.74],[.48,1.03],[.58,1.10],[.68,.98],[.78,.58],[.88,-.04],[1,-.26]];
const vtQRS=t=>waveInterp(t,VT_PTS);

// Deterministic, time-based smooth noise. Unlike Math.random(), the same time point always
// returns the same value, so an already-drawn trace does not "boil" or jitter between frames.
const fract=x=>x-Math.floor(x);
const noiseHash=x=>fract(Math.sin(x*127.1)*43758.5453123);
const noiseSmooth=f=>f*f*(3-2*f);
function smoothNoise(t,scale=1){
  const x=t*scale,i=Math.floor(x),f=x-i;
  const a=noiseHash(i),b=noiseHash(i+1);
  return ((a+(b-a)*noiseSmooth(f))-.5)*2;
}

// Coarse VF: irregular and chaotic, but continuous rather than frame-by-frame random.
// Elapsed time drives VF independently of the numeric HR readout.
const vfWave=t=>{
  // Continuous coarse-VF morphology without high-frequency random/micro jitter.
  // A few low-order oscillators keep the rhythm irregular while the trace itself stays visually stable.
  const a=Math.sin(t*24.8 + .42*Math.sin(t*4.1));
  const b=.52*Math.sin(t*16.2 + 1.7 + .18*Math.sin(t*2.7));
  const c=.24*Math.sin(t*31.6 + .55);
  const envelope=.90 + .12*Math.sin(t*.73) + .06*Math.sin(t*1.17+1.1);
  return (a+b+c)*.30*envelope;
};

// Asystole: essentially flat. A tiny slow baseline drift prevents a perfectly synthetic ruler-line
// without producing visible 'boiling' or fine tremor.
const flat=t=>Math.sin(t*.42)*.0009;

function ecgWave(t,rhythm,cprFrac,ta,cprRate){
  let v;
  if(rhythm==="nsr"||rhythm==="pea")v=normalQRST(t);
  else if(rhythm==="stemi")v=stemiQRST(t);
  else if(rhythm==="vt"||rhythm==="vtp")v=vtQRS(t);
  else if(rhythm==="vf")v=vfWave(ta||t); // VF uses elapsed time, not HR phase, so it never freezes when HR is 0
  else v=flat(ta||t); // asystole
  if(!cprFrac)return v;
  // Chest compressions don't erase the underlying electrical signal — they add a large motion
  // artifact on top of it. As compressions ramp in/out (cprFrac 0→1→0) the true rhythm gets
  // progressively swamped by, then re-emerges from under, the compression artifact.
  const artifact=cprEcgArtifact(ta||0,cprRate);
  return v*(1-cprFrac*.85)+artifact*cprFrac;
}
// Chest-compression artifact on the ECG trace — driven by real elapsed time (not the rhythm's
// own cycle), since compressions run at their own rate regardless of the underlying rhythm.
// Rate is passed in (AHA guideline is 100-120/min, not a fixed number) rather than hardcoded.
// Smooth, wide, rounded compression waves with just a little lead-motion noise on top.
function cprEcgArtifact(ta,rate=110){
  const per=60/rate,ct=((ta/per)%1+1)%1;
  const main=Math.pow(Math.sin(Math.PI*ct),1.15)*1.3; // one smooth wide arch per compression
  const notch=g(ct,.5,.05,-.22); // small notch at the crest for the gentle double-peak look
  return main+notch-.12; // stable compression artifact; no fine random tremor
}
const spo2W=t=>t<.22?Math.pow(Math.sin(t/.22*Math.PI/2),.68):Math.pow(Math.max(0,1-(t-.22)/.78),1.45)*.82+(t>.42&&t<.56?Math.sin((t-.42)/.14*Math.PI)*.12:0);
const etW=t=>t<.07?.01:t<.17?(t-.07)/.1:t<.68?1+.04*(t-.17)/.51:t<.82?1.04*(1-(t-.68)/.14):.01;
const rrW=t=>.5+.46*Math.sin(t*2*Math.PI-.1);
// The huge, flat-topped "square" deflection an ECG amplifier shows the instant a shock is
// delivered (the amplifier briefly saturates from the discharge) — rises fast, clips flat, falls fast.
function shockArtifact(dt){
  if(dt<0)return null;
  if(dt<.02)return 1.55*(dt/.02);
  if(dt<.11)return 1.55;
  if(dt<.16)return 1.55*(1-(dt-.11)/.05);
  return null;
}
const C={ecg:"#00FF00",spo2:"#FFD400",abp:"#FF4444",etco2:"#FFD700",rr:"#EEEEEE"};
const RL={nsr:"NSR",pea:"PEA",stemi:"STEMI",vt:"V-TACH (pulse)",vtp:"PULSELESS V-TACH",vf:"V-FIB",asystole:"ASYSTOLE"};
const DL={normal:"Normal",over:"Overdamped",under:"Underdamped"};
const DANGER=["vf","vtp"];
const WARN=["vt","stemi"];
const ALM={hr:{hi:110,lo:50},bps:{hi:180,lo:90},bpd:{hi:100,lo:50},spo2:{hi:100,lo:92},rr:{hi:20,lo:10},etco2:{hi:45,lo:35},temp:{hi:38.5,lo:36.0}};

// ---- ABP waveform shapes (normal / overdamped / underdamped) via keyframe interpolation ----
function keyInterp(t,pts){
  const n=pts.length;
  for(let i=0;i<n;i++){
    const[t0,v0]=pts[i],[t1r,v1]=pts[(i+1)%n];
    let t1=t1r;if(t1<=t0)t1+=1;
    let tt=t;if(tt<t0)tt+=1;
    if(tt>=t0&&tt<=t1){
      const f=t1===t0?0:(tt-t0)/(t1-t0);
      const cf=(1-Math.cos(f*Math.PI))/2;
      return v0+(v1-v0)*cf;
    }
  }
  return pts[0][1];
}
const ABP_PTS={
  normal:[[0,.05],[.06,.55],[.13,.95],[.18,1],[.24,.78],[.30,.52],[.35,.34],[.385,.22],[.42,.34],[.52,.24],[.68,.13],[.85,.06],[1,.05]],
  over:[[0,.30],[.15,.45],[.30,.68],[.42,.72],[.55,.58],[.70,.42],[.85,.32],[1,.30]],
  under:[[0,.05],[.04,.65],[.08,1.55],[.12,1.05],[.17,1.2],[.22,.75],[.29,.30],[.34,-.35],[.38,.10],[.42,1.05],[.46,.60],[.54,.15],[.60,-.30],[.70,.30],[.88,.08],[1,.05]],
};
const abpShape=(t,damp)=>keyInterp(t,ABP_PTS[damp]||ABP_PTS.normal);

// ---- alarm sound (Web Audio, no audio files needed) ----
// level: 'none' | 'med' | 'high'. Audio must be unlocked by a user tap first (browser autoplay rule).
// Each tone layers a triangle wave with a sub-octave sine underneath for weight/heaviness, with a
// short punchy decay (not a long musical ring) so it reads as urgent rather than melodic.
function playTone(ctx,t,freq,vol,decay){
  const osc=ctx.createOscillator(),gain=ctx.createGain();
  osc.type="triangle";osc.frequency.value=freq;
  gain.gain.setValueAtTime(0,t);
  gain.gain.linearRampToValueAtTime(vol,t+.008);
  gain.gain.exponentialRampToValueAtTime(.001,t+decay);
  osc.connect(gain);gain.connect(ctx.destination);
  osc.start(t);osc.stop(t+decay+.03);
  // sub-octave layer underneath for a heavier, less musical thump
  const sub=ctx.createOscillator(),subGain=ctx.createGain();
  sub.type="sine";sub.frequency.value=freq/2;
  subGain.gain.setValueAtTime(0,t);
  subGain.gain.linearRampToValueAtTime(vol*.6,t+.008);
  subGain.gain.exponentialRampToValueAtTime(.001,t+decay*.85);
  sub.connect(subGain);subGain.connect(ctx.destination);
  sub.start(t);sub.stop(t+decay+.03);
}
function useAlarmSound(enabled,level){
  const ctxRef=useRef(null);
  const nextRef=useRef(0);
  useEffect(()=>{
    let raf;
    const tick=()=>{
      const ctx=ctxRef.current;
      if(enabled&&ctx&&level!=="none"){
        const now=ctx.currentTime;
        if(now>=nextRef.current){
          if(level==="high"){
            playTone(ctx,now,370,.28,.26);
            playTone(ctx,now+.19,370,.28,.26);
            nextRef.current=now+.8;
          }else{
            playTone(ctx,now,520,.22,.32);
            playTone(ctx,now+.7,220,.26,.32);
            nextRef.current=now+1.7;
          }
        }
      }
      raf=requestAnimationFrame(tick);
    };
    raf=requestAnimationFrame(tick);
    return()=>cancelAnimationFrame(raf);
  },[enabled,level]);
  const unlock=()=>{
    if(!ctxRef.current){
      try{ctxRef.current=new(window.AudioContext||window.webkitAudioContext)();}catch(e){return;}
    }
    const ctx=ctxRef.current;
    const beep=()=>playTone(ctx,ctx.currentTime+.03,370,.28,.26);
    // iOS/Safari often creates contexts in a "suspended" state even from a tap — resume explicitly,
    // then play a short confirmation tone so the user immediately knows sound is working.
    if(ctx.state!=="running")ctx.resume().then(beep).catch(()=>{});
    else beep();
  };
  return unlock;
}

// ---- cumulative phase history: fixes the "roulette spinning" artifact ----
// Previously each frame recomputed every visible point's position using the CURRENT
// heart-rate cycle length, so the whole scrolling trace reflowed every time HR changed —
// looking like the waveform itself was spinning/accelerating. Instead we integrate a running
// beat-phase over real time (phase += dt / instantaneousCycleLength) and keep a short history
// of it. Each point on the trace then looks up the phase that was ACTUALLY active at its own
// historical instant, so already-drawn beats never retroactively change — only new beats,
// drawn from now on, reflect the new rate. That's what makes it look like a gradual speed-up.
function phaseAt(hist,ta){
  const n=hist.length;
  if(n===0)return 0;
  if(ta<=hist[0].t)return hist[0].ph;
  if(ta>=hist[n-1].t)return hist[n-1].ph;
  let lo=0,hi=n-1;
  while(hi-lo>1){
    const mid=(lo+hi)>>1;
    if(hist[mid].t<=ta)lo=mid;else hi=mid;
  }
  const a=hist[lo],b=hist[hi];
  const f=(ta-a.t)/((b.t-a.t)||1);
  return a.ph+(b.ph-a.ph)*f;
}

// ---- rhythm / damping "hard cutover" transition: no shape-blending (avoids buzzy overlap artifacts).
// Old waveform keeps scrolling on the older part of the trace; new waveform appears from the
// current sweep point onward — exactly like a real monitor when the sim rhythm is changed.
const isHp=r=>!["asystole","vf","pea","vtp"].includes(r);
const isAlive=r=>r!=="asystole";
const hasRate=r=>!["asystole","vf"].includes(r); // ECG can count a rate even without a pulse (PEA, pulseless VT)
const CPR_RATE=110; // compressions/min shown as the HR readout while compressing an unshockable/no-rate rhythm
const CPR_BP={sys:70,dia:32}; // approximate pressure generated by effective compressions
function rhythmAt(ta,trans){
  const tr=trans.current;
  if(tr.from===tr.to)return tr.to;
  return ta*1000<tr.start?tr.from:tr.to;
}
const smoothstep=f=>f*f*(3-2*f);
// gradual envelope (0..1) for amplitude-based channels (ABP/SpO2/EtCO2/RR) — ramps over `dur` ms
// using each point's own elapsed time (ta), so the fade sweeps naturally across the trace as it scrolls.
function envAt(ta,trans,pred,dur=1600){
  const tr=trans.current;
  const fromV=pred(tr.from)?1:0,toV=pred(tr.to)?1:0;
  if(fromV===toV)return toV;
  const el=ta*1000-tr.start;
  if(el<=0)return fromV;
  return fromV+(toV-fromV)*smoothstep(Math.min(1,el/dur));
}
// ABP damping shape: smooth blend between old/new shape (low-frequency curves, safe to blend without buzz)
function abpShapeAt(t,ta,trans,dur=1300){
  const tr=trans.current;
  if(tr.from===tr.to)return abpShape(t,tr.to);
  const el=ta*1000-tr.start;
  if(el<=0)return abpShape(t,tr.from);
  const ef=smoothstep(Math.min(1,el/dur));
  if(ef>=1)return abpShape(t,tr.to);
  return abpShape(t,tr.from)*(1-ef)+abpShape(t,tr.to)*ef;
}
function useEngine(state){
  const stateRef=useRef(state);stateRef.current=state;
  const dispRef=useRef({hr:state.hr,spo2:state.spo2,rr:state.rr,etco2:state.etco2,abp:{...state.abp},nibp:{...state.nibp},cprRateDisp:state.cprRate||110});
  const transRef=useRef({from:state.rhythm,to:state.rhythm,start:0,cur:state.rhythm});
  const dampTransRef=useRef({from:state.damping,to:state.damping,start:0,cur:state.damping});
  const cprTransRef=useRef({from:state.cpr,to:state.cpr,start:0,cur:state.cpr});
  const t0=performance.now()/1000;
  const hrHist=useRef([{t:t0,ph:0}]);
  const rrHist=useRef([{t:t0,ph:0}]);
  const beatHrRef=useRef(state.hr);
  const beatRrRef=useRef(state.rr);
  const cprPhaseRef=useRef(0);
  const beatCprRef=useRef(state.cprRate||110);
  const[,setTick]=useState(0);
  useEffect(()=>{
    let raf,last=performance.now(),acc=0;
    const loop=now=>{
      const dt=Math.min((now-last)/1000,.05);last=now;acc+=dt;
      const nowSec=now/1000;
      const s=stateRef.current,d=dispRef.current;
      const lerp=(a,b,rate)=>a+(b-a)*Math.min(1,rate*dt);
      d.hr=lerp(d.hr,s.hr,.45);
      d.spo2=lerp(d.spo2,s.spo2,.7);
      d.rr=lerp(d.rr,s.rr,.45);
      d.etco2=lerp(d.etco2,s.etco2,1.0);
      d.abp.sys=lerp(d.abp.sys,s.abp.sys,1.4);
      d.abp.dia=lerp(d.abp.dia,s.abp.dia,1.4);
      // CPR-rate readout: don't snap straight to the compression rate the instant CPR starts,
      // and don't snap straight back either when compressions stop. Starting compressions seeds
      // the compression-rate readout from whatever the last real rate was; stopping compressions
      // seeds the real HR readout from the last compression rate — either way the number eases
      // over, like a monitor's rate algorithm re-locking onto a signal rather than teleporting.
      const wasCpr=cprTransRef.current.cur;
      if(s.cpr&&!wasCpr)d.cprRateDisp=d.hr;
      if(!s.cpr&&wasCpr)d.hr=d.cprRateDisp;
      if(s.cpr){
        d.cprRateDisp=lerp(d.cprRateDisp,s.cprRate||110,.8);
        const oldCprPh=cprPhaseRef.current,newCprPh=oldCprPh+dt/(60/Math.max(d.cprRateDisp,1));
        if(Math.floor(newCprPh)>Math.floor(oldCprPh))beatCprRef.current=Math.round(d.cprRateDisp);
        cprPhaseRef.current=newCprPh;
      }
      const hh=hrHist.current,rh=rrHist.current;
      const oldHrPh=hh[hh.length-1].ph,newHrPh=oldHrPh+dt/(60/Math.max(d.hr,1));
      if(Math.floor(newHrPh)>Math.floor(oldHrPh))beatHrRef.current=d.hr; // HR readout only updates once per detected beat, like a real monitor
      hh.push({t:nowSec,ph:newHrPh});
      const oldRrPh=rh[rh.length-1].ph,newRrPh=oldRrPh+dt/(60/Math.max(Math.max(d.rr,3),1));
      if(Math.floor(newRrPh)>Math.floor(oldRrPh))beatRrRef.current=d.rr; // same idea for RR, once per breath
      rh.push({t:nowSec,ph:newRrPh});
      const cutoff=nowSec-7;
      while(hh.length>2&&hh[1].t<cutoff)hh.shift();
      while(rh.length>2&&rh[1].t<cutoff)rh.shift();
      if(transRef.current.cur!==s.rhythm){
        transRef.current={from:transRef.current.cur,to:s.rhythm,start:now,cur:s.rhythm};
      }
      if(dampTransRef.current.cur!==s.damping){
        dampTransRef.current={from:dampTransRef.current.cur,to:s.damping,start:now,cur:s.damping};
      }
      if(cprTransRef.current.cur!==s.cpr){
        cprTransRef.current={from:cprTransRef.current.cur,to:s.cpr,start:now,cur:s.cpr};
      }
      if(acc>.09){acc=0;setTick(x=>x+1);}
      raf=requestAnimationFrame(loop);
    };
    raf=requestAnimationFrame(loop);
    return()=>cancelAnimationFrame(raf);
  },[]);
  return{dispRef,transRef,dampTransRef,cprTransRef,hrHist,rrHist,beatHrRef,beatRrRef,beatCprRef};
}

function Wave({getState,color,h=80,scale=.35,sw=1.8,grid=false}){
  const cvs=useRef(null),raf=useRef(null),gs=useRef(getState);
  gs.current=getState;
  useEffect(()=>{
    const el=cvs.current;
    let ctx=null,W=0,H=h,dpr=1,ro=null;
    const DS=6,EP=14;

    const setup=()=>{
      if(!el)return;
      dpr=Math.max(1,window.devicePixelRatio||1);
      W=Math.max(1,Math.round(el.getBoundingClientRect().width||1100));
      H=h;
      el.width=Math.round(W*dpr);
      el.height=Math.round(H*dpr);
      el.style.height=`${H}px`;
      ctx=el.getContext("2d");
      ctx.setTransform(dpr,0,0,dpr,0,0);
      ctx.lineJoin="round";
      ctx.lineCap="round";
      ctx.imageSmoothingEnabled=true;
    };

    const drawGrid=()=>{
      if(!grid||!ctx)return;
      // Very subtle monitor-style reference grid: visible enough to orient the trace, not ECG-paper red.
      const minor=10,major=50;
      ctx.save();
      ctx.lineWidth=.5;
      for(let x=0;x<=W;x+=minor){
        ctx.strokeStyle=(x%major===0)?"rgba(35,80,35,.16)":"rgba(35,80,35,.065)";
        ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,H);ctx.stroke();
      }
      for(let y=0;y<=H;y+=minor){
        ctx.strokeStyle=(y%major===0)?"rgba(35,80,35,.16)":"rgba(35,80,35,.065)";
        ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(W,y);ctx.stroke();
      }
      ctx.restore();
    };

    setup();
    if(typeof ResizeObserver!=="undefined"){
      ro=new ResizeObserver(()=>setup());
      ro.observe(el);
    }

    const f=()=>{
      if(!ctx){raf.current=requestAnimationFrame(f);return;}
      const now=performance.now()/1000;
      const{gen}=gs.current();
      // Quantize the sweep clock to the canvas pixel interval. This prevents the entire historical
      // trace from being re-sampled at a slightly different sub-pixel time on every animation frame.
      // Result: old ECG complexes stay visually locked in place instead of shimmering/vibrating.
      const sampleStep=DS/Math.max(W,1);
      const sampleNow=Math.floor(now/sampleStep)*sampleStep;
      ctx.fillStyle="#000";ctx.fillRect(0,0,W,H);
      drawGrid();
      const cx=Math.floor((sampleNow%DS)/DS*W);
      ctx.strokeStyle=color;
      ctx.lineWidth=sw;
      ctx.shadowColor=color;
      ctx.shadowBlur=.45; // crisp bedside-monitor trace; minimal glow
      ctx.beginPath();let first=true;
      for(let px=0;px<W;px++){
        if(((px-cx+W)%W)<EP){first=true;continue;}
        const ta=sampleNow-((cx-px+W)%W)/W*DS;if(ta<0){first=true;continue;}
        const val=gen(ta);
        const y=H/2-val*H*scale;
        if(first){ctx.moveTo(px,y);first=false;}else ctx.lineTo(px,y);
      }
      ctx.stroke();ctx.shadowBlur=0;raf.current=requestAnimationFrame(f);
    };
    raf.current=requestAnimationFrame(f);
    return()=>{cancelAnimationFrame(raf.current);if(ro)ro.disconnect();};
  },[color,sw,scale,h,grid]);
  return <canvas ref={cvs} style={{width:"100%",display:"block",height:h}}/>;
}

function ValCol({label,color,big,hi,lo,unit,sub,size=42}){
  return(
    <div style={{width:150,flexShrink:0,display:"flex",flexDirection:"column",justifyContent:"center",padding:"2px 10px",borderLeft:"1px solid #1c1c1c"}}>
      <div style={{display:"flex",gap:6,alignItems:"flex-start"}}>
        {(hi!==undefined)&&<div style={{textAlign:"right",fontSize:10,color:color,opacity:.55,lineHeight:1.35,paddingTop:3,fontWeight:"bold"}}><div>{hi}</div><div>{lo}</div></div>}
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontSize:12,fontWeight:"bold",color,letterSpacing:.5}}>{label}</div>
          <div style={{fontSize:size,fontWeight:900,color,lineHeight:.92,fontFamily:"Arial, sans-serif"}}>{big}</div>
          {sub&&<div style={{fontSize:11,color:"#888",marginTop:1}}>{sub}</div>}
        </div>
      </div>
      {unit&&<div style={{fontSize:10,color:"#555",textAlign:"right",marginTop:1}}>{unit}</div>}
    </div>
  );
}

function Monitor({state,disp,trans,dampTrans,cprTrans,hrHist,rrHist,beatHrRef,beatRrRef,beatCprRef,onChange,toggle,open}){
  const{rhythm,cpr,damping,etco2On,bagging,nibpMeasuring,nibpResult,cprRate,abpOn,nibp,visible}=state;
  const rate=cprRate||CPR_RATE;
  const d=disp.current;
  const hrN=Math.round(beatHrRef.current),spo2N=Math.round(d.spo2),rrN=Math.round(beatRrRef.current),etN=Math.round(d.etco2);
  const absN=Math.round(d.abp.sys),abdN=Math.round(d.abp.dia);
  const nibSys=Math.round(nibpResult&&nibpResult!=="fail"?nibpResult.sys:nibp.sys);
  const nibDia=Math.round(nibpResult&&nibpResult!=="fail"?nibpResult.dia:nibp.dia);
  const hp=isHp(rhythm),alive=isAlive(rhythm);
  const[clock,setClock]=useState(()=>new Date());
  useEffect(()=>{const iv=setInterval(()=>setClock(new Date()),1000);return()=>clearInterval(iv);},[]);
  const timeStr=clock.toLocaleTimeString("ko-KR",{hour:"2-digit",minute:"2-digit",second:"2-digit"});
  const[blink,setBlink]=useState(true);
  useEffect(()=>{const iv=setInterval(()=>setBlink(b=>!b),650);return()=>clearInterval(iv);},[]);

  const etDisplay=!etco2On?"---":(cpr?Math.max(etN,10):etN);
  const rrDisplay=bagging?10:(hp?rrN:"---");
  const nibpMap=Math.round((nibSys+2*nibDia)/3);
  const nibpInline=nibpMeasuring?"NIBP 측정중...":nibpResult==="fail"?"NIBP 측정 실패":`NIBP ${nibSys}/${nibDia} (${nibpMap}) mmHg`;
  const vis={hr:true,spo2:true,rr:true,nibp:true,etco2:true,...(visible||{})};

  // ---- alarms ----
  const critical=DANGER.includes(rhythm)||rhythm==="asystole";
  const hrAlarm=hasRate(rhythm)&&(hrN>ALM.hr.hi||hrN<ALM.hr.lo);
  const spo2Alarm=hp&&spo2N<ALM.spo2.lo;
  const bpAlarm=hp&&((abpOn?(absN>ALM.bps.hi||absN<ALM.bps.lo||abdN>ALM.bpd.hi||abdN<ALM.bpd.lo):(nibSys>ALM.bps.hi||nibSys<ALM.bps.lo||nibDia>ALM.bpd.hi||nibDia<ALM.bpd.lo)));
  const rrAlarm=alive&&!bagging&&(rrN>ALM.rr.hi||rrN<ALM.rr.lo);
  const etco2Alarm=etco2On&&etDisplay!=="---"&&(etDisplay>ALM.etco2.hi||etDisplay<ALM.etco2.lo);
  const anyAlarm=critical||spo2Alarm||bpAlarm||hrAlarm||rrAlarm||etco2Alarm;
  const alarmMsg=critical?"CRISIS ALARM":anyAlarm?"CHECK PATIENT":null; // generic on purpose — don't hand the student the diagnosis
  const level=critical?"high":alarmMsg?"med":"none";
  const[soundOn,setSoundOn]=useState(false);
  const unlockAudio=useAlarmSound(soundOn,level);
  const toggleSound=()=>{unlockAudio();setSoundOn(v=>!v);};

  const rows=[
    {key:"ecg",lead:"II",c:C.ecg,h:104,sc:.27,sw:2,g:()=>({gen:ta=>ecgWave(phaseAt(hrHist.current,ta)%1,rhythmAt(ta,trans),envAt(ta,cprTrans,x=>x,450),ta,rate)}),
      val:<ValCol label="HR" color={C.ecg} big={vis.hr?(cpr?beatCprRef.current:(hasRate(rhythm)?hrN:"---")):"---"} hi={ALM.hr.hi} lo={ALM.hr.lo} unit="bpm" sub={abpOn?(vis.hr&&hp?`PR (${hrN}) bpm`:undefined):(vis.nibp?nibpInline:undefined)}/> },
    ...(abpOn?[{key:"abp",scale:true,c:C.abp,h:82,sc:.34,sw:1.8,g:()=>({gen:ta=>{const hf=envAt(ta,trans,isHp),ph=phaseAt(hrHist.current,ta)%1;if(hf>.02)return abpShapeAt(ph,ta,dampTrans)*hf;if(cpr){const per=60/rate,cph=((ta/per)%1+1)%1;return abpShape(cph,"normal")*.32;}return 0;}}),
      val:<ValCol label="ABP" color={C.abp} big={vis.nibp?(hp?`${absN}/${abdN}`:cpr?`${CPR_BP.sys}/${CPR_BP.dia}`:"---/---"):"---/---"} hi={ALM.bps.hi} lo={ALM.bps.lo} unit="mmHg" sub={vis.nibp?(hp?`(${Math.round((absN+2*abdN)/3)})${damping!=="normal"?" "+DL[damping]:""}`:cpr?`(${Math.round((CPR_BP.sys+2*CPR_BP.dia)/3)})`:undefined):undefined}/>}]:[]),
    {key:"spo2",c:C.spo2,h:78,sc:.35,sw:1.8,g:()=>({gen:ta=>{const hf=envAt(ta,trans,isHp),ph=phaseAt(hrHist.current,ta)%1;if(hf>.02)return spo2W(ph)*hf+(1-hf)*flat(ta);if(cpr){const per=60/rate,cph=((ta/per)%1+1)%1;return spo2W(cph)*.45+smoothNoise(ta,9)*.018;}return flat(ta);}}),
      val:<ValCol label="SpO₂" color={C.spo2} big={vis.spo2?(hp?`${spo2N}`:"---"):"---"} hi={ALM.spo2.hi} lo={ALM.spo2.lo} unit="%"/>},
    ...(etco2On?[{key:"etco2",c:C.etco2,h:60,sc:.38,sw:1.6,g:()=>({gen:ta=>{if(!etco2On)return .01;const af=envAt(ta,trans,isAlive),ph=phaseAt(rrHist.current,ta)%1;return(af>.02||cpr)?etW(ph)*Math.max(af,cpr?.5:0):.01;}}),
      val:<ValCol label="EtCO₂" color={C.etco2} big={vis.etco2?etDisplay:"---"} hi={ALM.etco2.hi} lo={ALM.etco2.lo} unit="mmHg" size={32}/>}]:[]),
    {key:"rr",c:C.rr,h:52,sc:.4,sw:1.6,g:()=>({gen:ta=>{if(bagging){const per=6,cph=((ta/per)%1+1)%1;return rrW(cph)*.85;}const af=envAt(ta,trans,isHp),ph=phaseAt(rrHist.current,ta)%1;return af>.02?rrW(ph)*af+(1-af)*flat(ta):flat(ta);}}),
      val:<ValCol label="RR" color={C.rr} big={vis.rr?rrDisplay:"---"} hi={ALM.rr.hi} lo={ALM.rr.lo} unit="/min" size={32}/> },
  ];

  return(
    <div style={{background:"#000",height:"100%",display:"flex",flexDirection:"column",overflow:"hidden",fontFamily:"'Segoe UI',Arial,sans-serif"}}>
      <div style={{background:"#161616",borderBottom:"1px solid #222",display:"flex",alignItems:"center",justifyContent:"space-between",padding:"7px 14px",flexShrink:0}}>
        <button onClick={toggleSound} style={{background:"none",border:"1px solid #333",borderRadius:6,padding:"4px 9px",color:soundOn?"#4dcc4d":"#666",fontSize:12,cursor:"pointer",fontFamily:"inherit"}}>{soundOn?"🔔 알람 켜짐":"🔕 알람 꺼짐"}</button>
        <div/>
        <div style={{display:"flex",gap:10,alignItems:"center"}}>
          <span style={{background:"#2a2a2a",padding:"4px 10px",borderRadius:6,fontSize:11,fontWeight:"bold",color:"#ddd"}}>Adult</span>
          <span style={{fontSize:12,color:"#999",fontFamily:"monospace"}}>{timeStr}</span>
        </div>
      </div>
      {alarmMsg&&(
        <div style={{background:critical?(blink?"#3a0000":"#0d0d0d"):(blink?"#4a3a00":"#1a1500"),color:critical?"#FF5555":"#FFD24d",textAlign:"center",padding:"4px 0",fontSize:12,fontWeight:"bold",letterSpacing:1,flexShrink:0}}>⚠ {alarmMsg}</div>
      )}
      {rhythm==="stemi"&&(
        <div style={{background:blink?"#3a0000":"#0d0d0d",color:"#FF5555",textAlign:"center",padding:"4px 0",fontSize:12,fontWeight:"bold",letterSpacing:1,flexShrink:0}}>🚨 ST ELEVATION — STEMI ALERT 🚨</div>
      )}

      <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden",minHeight:0}}>
        {rows.map(r=>(
          <div key={r.key} style={{flex:r.key==="ecg"?2.6:r.key==="rr"||r.key==="etco2"?1.3:2,display:"flex",borderBottom:"1px solid #111",minHeight:0,position:"relative"}}>
            {r.lead&&<span style={{position:"absolute",top:2,left:6,color:"#333",fontSize:10,fontWeight:"bold",zIndex:2}}>{r.lead}</span>}
            {r.scale&&<>
              <span style={{position:"absolute",top:2,left:4,color:"#555",fontSize:10,zIndex:2}}>150</span>
              <span style={{position:"absolute",bottom:2,left:4,color:"#555",fontSize:10,zIndex:2}}>0</span>
            </>}
            <div style={{flex:1,minWidth:0}}><Wave getState={r.g} color={r.c} h={r.h} scale={r.sc} sw={r.sw} grid={r.key==="ecg"}/></div>
            {r.val}
          </div>
        ))}
      </div>

      {abpOn&&(
      <div style={{display:"flex",borderTop:"1px solid #1c1c1c",background:"#0a0a0a",padding:"10px 16px",flexShrink:0,alignItems:"center",gap:10}}>
        <span style={{color:C.abp,fontSize:16,fontWeight:"bold"}}>NIBP</span>
        <span style={{color:nibpResult==="fail"?"#ff6666":C.abp,fontSize:nibpResult==="fail"?26:44,fontWeight:900,lineHeight:1}}>
          {nibpMeasuring?"측정중...":nibpResult==="fail"?"측정 실패":`${nibSys}/${nibDia}`}
        </span>
        {nibpResult!=="fail"&&!nibpMeasuring&&<span style={{color:C.abp,fontSize:20,fontWeight:"bold"}}>({nibpMap})</span>}
        <span style={{color:"#666",fontSize:13}}>mmHg</span>
      </div>
      )}

    </div>
  );
}

// Draggable rotary energy dial (drag anywhere on the dial to sweep the pointer to the nearest tick).
// Knob is a round brushed-metal cylinder with a bright diagonal stripe across its face — like a
// stove/appliance selector knob — and the value labels sit outside the dial ring, not inside it.
function RotaryDial({value,levels,onChange,size=190}){
  const idx=Math.max(0,levels.indexOf(value));
  const N=levels.length;
  const angleFor=i=>-135+(270*i/(N-1));
  const curAngle=angleFor(idx);
  const cx=size/2,cy=size/2,R=size*.38;
  const svgRef=useRef(null);
  const draggingRef=useRef(false);
  const uid=useRef("dial"+Math.random().toString(36).slice(2,8)).current;

  const angleFromEvent=e=>{
    const rect=svgRef.current.getBoundingClientRect();
    const pt=e.touches?e.touches[0]:e;
    const px=pt.clientX-rect.left,py=pt.clientY-rect.top;
    const dx=px-cx,dy=py-cy;
    let ang=Math.atan2(dx,-dy)*180/Math.PI;
    if(ang>135)ang=135;
    if(ang<-135)ang=-135;
    return ang;
  };
  const applyAngle=ang=>{
    const i=Math.round((ang+135)/270*(N-1));
    onChange(levels[Math.max(0,Math.min(N-1,i))]);
  };
  const onDown=e=>{draggingRef.current=true;applyAngle(angleFromEvent(e));e.preventDefault();};

  useEffect(()=>{
    const mv=e=>{if(draggingRef.current){applyAngle(angleFromEvent(e));e.preventDefault();}};
    const up=()=>{draggingRef.current=false;};
    window.addEventListener("mousemove",mv);window.addEventListener("mouseup",up);
    window.addEventListener("touchmove",mv,{passive:false});window.addEventListener("touchend",up);
    return()=>{
      window.removeEventListener("mousemove",mv);window.removeEventListener("mouseup",up);
      window.removeEventListener("touchmove",mv);window.removeEventListener("touchend",up);
    };
  },[levels,onChange]);

  const knobR=R*.7; // round metal cylinder head, viewed head-on
  const stripeLen=knobR*1.7, stripeW=size*.07;

  return(
    <svg ref={svgRef} width={size} height={size} onMouseDown={onDown} onTouchStart={onDown} style={{touchAction:"none",cursor:"grab",display:"block",overflow:"visible"}}>
      <defs>
        <radialGradient id={uid+"bezel"} cx="35%" cy="30%" r="80%">
          <stop offset="0%" stopColor="#3a4249"/>
          <stop offset="60%" stopColor="#1b2126"/>
          <stop offset="100%" stopColor="#05070a"/>
        </radialGradient>
        {/* brushed metal: multiple gradient bands so it reads as a cylindrical, reflective knob */}
        <linearGradient id={uid+"knob"} x1="15%" y1="0%" x2="85%" y2="100%">
          <stop offset="0%" stopColor="#f6f8f9"/>
          <stop offset="20%" stopColor="#c9d0d5"/>
          <stop offset="45%" stopColor="#eef1f3"/>
          <stop offset="65%" stopColor="#9aa3aa"/>
          <stop offset="85%" stopColor="#dde2e5"/>
          <stop offset="100%" stopColor="#7d868d"/>
        </linearGradient>
        <linearGradient id={uid+"stripe"} x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#ffffff"/>
          <stop offset="50%" stopColor="#f0f2f3"/>
          <stop offset="100%" stopColor="#c7ced3"/>
        </linearGradient>
        <filter id={uid+"knobShadow"} x="-60%" y="-60%" width="220%" height="220%">
          <feDropShadow dx="0" dy="3" stdDeviation="3.4" floodColor="#000" floodOpacity="0.55"/>
        </filter>
      </defs>
      <circle cx={cx} cy={cy} r={R} fill={`url(#${uid}bezel)`} stroke="#000" strokeWidth="1"/>
      <circle cx={cx} cy={cy} r={R-2.5} fill="none" stroke="#565f66" strokeWidth="1" opacity=".6"/>
      {levels.map((v,i)=>{
        const a=angleFor(i),rad=a*Math.PI/180;
        const active=i===idx;
        const big=typeof v==="number"&&v>=100;
        const tick1=R-2,tick2=active?R+8:R+5;
        const x1=cx+tick1*Math.sin(rad),y1=cy-tick1*Math.cos(rad);
        const x2=cx+tick2*Math.sin(rad),y2=cy-tick2*Math.cos(rad);
        const tx=cx+(R+15)*Math.sin(rad),ty=cy-(R+15)*Math.cos(rad);
        return(
          <g key={v}>
            <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={active?"#ff5252":"#8b95a0"} strokeWidth={active?2.6:1.3}/>
            <text x={tx} y={ty} fontSize={active?13:v===0?9.5:big?10:8.5} fontWeight={active||v===0?"bold":"normal"} fill={active?"#ff5252":v===0?"#33414d":big?"#c62828":"#5a6a78"} textAnchor="middle" dominantBaseline="middle">{v===0?"OFF":v}</text>
          </g>
        );
      })}
      {/* round metal knob head */}
      <circle cx={cx} cy={cy} r={knobR} fill={`url(#${uid}knob)`} stroke="#5f6870" strokeWidth="1.5" filter={`url(#${uid}knobShadow)`}/>
      <circle cx={cx} cy={cy} r={knobR} fill="none" stroke="#fff" strokeWidth="1" opacity=".4"/>
      {/* diagonal indicator stripe, rotating with the selected value */}
      <g transform={`rotate(${curAngle} ${cx} ${cy})`}>
        <rect x={cx-stripeW/2} y={cy-stripeLen/2} width={stripeW} height={stripeLen} rx={stripeW/2} fill={`url(#${uid}stripe)`} stroke="#8b939a" strokeWidth="1"/>
      </g>
      <circle cx={cx} cy={cy} r={knobR*.16} fill="#4a5359" stroke="#2a3136" strokeWidth="1"/>
    </svg>
  );
}






const DIAL_LEVELS=[0,1,2,3,5,7,10,15,20,30,50,70,100,150,200,270];

function DC({state,disp,trans,cprTrans,hrHist,rrHist,beatHrRef,beatCprRef,onCharge,onShock,onChange}){
  const{rhythm,cpr,dc,cprRate}=state;
  const rate=cprRate||CPR_RATE;
  const{energy,charged,charging,shockDelivered,shockCount,mode,pacer,sync}=dc;
  const[flash,setFlash]=useState(false);
  const[clock,setClock]=useState(()=>new Date());
  useEffect(()=>{const iv=setInterval(()=>setClock(new Date()),1000);return()=>clearInterval(iv);},[]);
  const timeStr=clock.toLocaleTimeString("ko-KR",{hour:"2-digit",minute:"2-digit",second:"2-digit"});
  const hrN=Math.round(beatHrRef.current);
  const doShock=()=>{if(!charged)return;setFlash(true);setTimeout(()=>setFlash(false),500);onShock();};
  const st=charging?`Charging... ${energy}J`:charged?`Charged ✓ ${energy}J`:shockDelivered?`${energy}J delivered`:energy===0?"Select energy":"READY";
  const sc=charging?"#FFB300":charged?"#2fbf2f":shockDelivered?"#FF8800":"#607080";
  const setEnergy=v=>onChange("dc",{...dc,energy:v,charged:false,charging:false});
  const pacerStep=(k,mn,mx,delta)=>onChange("dc",{...dc,pacer:{...pacer,[k]:Math.max(mn,Math.min(mx,pacer[k]+delta))}});

  const chargeAudioRef=useRef(null);
  const unlockChargeAudio=()=>{
    if(!chargeAudioRef.current){
      try{chargeAudioRef.current=new(window.AudioContext||window.webkitAudioContext)();}catch(e){}
    }else if(chargeAudioRef.current.state!=="running"){
      chargeAudioRef.current.resume().catch(()=>{});
    }
  };
  useEffect(()=>{
    const ctx=chargeAudioRef.current;
    if(!charging||!ctx)return;
    const osc=ctx.createOscillator(),gain=ctx.createGain();
    const now=ctx.currentTime;
    osc.type="sine";
    osc.frequency.setValueAtTime(200,now);
    osc.frequency.exponentialRampToValueAtTime(1050,now+2.65);
    gain.gain.setValueAtTime(0,now);
    gain.gain.linearRampToValueAtTime(.16,now+.08);
    osc.connect(gain);gain.connect(ctx.destination);
    osc.start(now);
    return()=>{
      try{
        const t=ctx.currentTime;
        gain.gain.cancelScheduledValues(t);
        gain.gain.setValueAtTime(gain.gain.value,t);
        gain.gain.linearRampToValueAtTime(0,t+.02);
        osc.stop(t+.03);
      }catch(e){}
    };
  },[charging]);
  useEffect(()=>{
    const ctx=chargeAudioRef.current;
    if(!charged||!ctx)return;
    const now=ctx.currentTime;
    [[0,880],[.12,1100]].forEach(([dt,freq])=>{
      const osc=ctx.createOscillator(),gain=ctx.createGain();
      osc.type="sine";osc.frequency.value=freq;
      gain.gain.setValueAtTime(0,now+dt);
      gain.gain.linearRampToValueAtTime(.22,now+dt+.01);
      gain.gain.exponentialRampToValueAtTime(.001,now+dt+.16);
      osc.connect(gain);gain.connect(ctx.destination);
      osc.start(now+dt);osc.stop(now+dt+.17);
    });
  },[charged]);
  useEffect(()=>{
    if(!charged)return;
    const ctx=chargeAudioRef.current;
    if(!ctx)return;
    let raf,next=0;
    const tone=(t,freq)=>{
      const osc=ctx.createOscillator(),gain=ctx.createGain();
      osc.type="sine";osc.frequency.value=freq;
      gain.gain.setValueAtTime(0,t);
      gain.gain.linearRampToValueAtTime(.22,t+.015);
      gain.gain.exponentialRampToValueAtTime(.02,t+.62);
      osc.connect(gain);gain.connect(ctx.destination);
      osc.start(t);osc.stop(t+.65);
      const sub=ctx.createOscillator(),subGain=ctx.createGain();
      sub.type="sine";sub.frequency.value=freq/2;
      subGain.gain.setValueAtTime(0,t);
      subGain.gain.linearRampToValueAtTime(.18,t+.015);
      subGain.gain.exponentialRampToValueAtTime(.015,t+.62);
      sub.connect(subGain);subGain.connect(ctx.destination);
      sub.start(t);sub.stop(t+.65);
    };
    const tick=()=>{
      const now=ctx.currentTime;
      if(now>=next){tone(now,960);next=now+.72;}
      raf=requestAnimationFrame(tick);
    };
    raf=requestAnimationFrame(tick);
    return()=>cancelAnimationFrame(raf);
  },[charged]);

  const shockTimeRef=useRef(-1);
  useEffect(()=>{if(shockDelivered)shockTimeRef.current=performance.now()/1000;},[shockDelivered]);
  const handleChargeClick=()=>{unlockChargeAudio();onCharge();};

  const[chargeNum,setChargeNum]=useState(0);
  useEffect(()=>{
    if(!charging)return;
    let raf;const start=performance.now(),dur=2650;
    const loop=now=>{
      const t=Math.min(1,(now-start)/dur);
      setChargeNum(Math.round(t*energy));
      if(t<1)raf=requestAnimationFrame(loop);
    };
    raf=requestAnimationFrame(loop);
    return()=>cancelAnimationFrame(raf);
  },[charging,energy]);

  const currentJ=charging?chargeNum:(energy||0);
  const panelStatus=charging?"Charging":charged?"Charged":shockDelivered?"Delivered":"Standby";
  const smallBtn=(active=false)=>({
    padding:"5px 9px",
    fontSize:9,
    lineHeight:1,
    borderRadius:4,
    border:`1px solid ${active?"#f6d8c2":"#9ba2a7"}`,
    background:active?"linear-gradient(180deg,#ff8a4a,#d66125)":"linear-gradient(180deg,#8e979d,#737b81)",
    color:active?"#fff":"#f2f2f2",
    boxShadow:active?"inset 0 1px 0 rgba(255,255,255,.25)":"inset 0 1px 0 rgba(255,255,255,.18)"
  });
  const RoundStepButton=({num,label,onClick,disabled,accent,icon,activeGlow})=>(
    <button onClick={onClick} disabled={disabled} style={{background:"none",border:"none",padding:0,cursor:disabled?"not-allowed":"pointer",opacity:disabled?.75:1,display:"block"}}>
      <div style={{display:"flex",alignItems:"center",gap:8}}>
        <div style={{fontSize:12,fontWeight:700,color:"#ffffff",width:50,textAlign:"right",lineHeight:1.1,whiteSpace:"pre-line"}}>{label}</div>
        <div style={{position:"relative",width:62,height:62,borderRadius:"50%",border:`4px solid ${accent}`,background:`linear-gradient(160deg,#f8f8f4,#d9d9d4 60%,#c7c7c2)`,boxShadow:activeGlow?`0 0 0 3px rgba(255,153,0,.18), 0 0 14px rgba(255,102,0,.35), inset 0 1px 2px rgba(255,255,255,.9)`:`0 2px 6px rgba(0,0,0,.25), inset 0 1px 2px rgba(255,255,255,.85)`}}>
          <div style={{position:"absolute",inset:9,borderRadius:"50%",background:disabled?"linear-gradient(160deg,#e7e7e1,#d3d3ce)":`linear-gradient(160deg,${accent==="#ff8a00"?"#ffd6a3,#ff9a2b":"#ffc2b7,#ff6255"})`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:26,fontWeight:900,color:disabled?"#9ba3aa":"#fff",textShadow:disabled?"none":"0 1px 1px rgba(0,0,0,.35)"}}>{icon}</div>
          <div style={{position:"absolute",right:-6,bottom:-5,width:24,height:24,borderRadius:"50%",background:"#3c8bd9",border:"2px solid #fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,fontWeight:900,color:"#fff",boxShadow:"0 1px 3px rgba(0,0,0,.35)"}}>{num}</div>
        </div>
      </div>
    </button>
  );

  return(
    <div style={{background:"linear-gradient(180deg,#efefeb,#d8dad7 32%,#babdc0 100%)",height:"100%",display:"flex",fontFamily:"Arial,'Segoe UI',sans-serif",overflow:"hidden",boxShadow:"inset 0 0 34px rgba(0,0,0,.13)",border:"10px solid #e7e8e5",boxSizing:"border-box",position:"relative"}}>
      <div style={{position:"absolute",top:0,left:"36%",transform:"translateX(-50%)",width:160,height:16,background:"linear-gradient(180deg,#ffffff,#e9ebef)",borderBottomLeftRadius:18,borderBottomRightRadius:18,opacity:.95}}/>

      <div style={{flex:1,background:"#000",display:"flex",flexDirection:"column",margin:"18px 8px 18px 18px",borderRadius:3,overflow:"hidden",minWidth:0,boxShadow:"0 0 0 2px #1b2024, 0 0 0 7px #333b42, 0 0 0 9px #aab3ba, inset 0 0 16px rgba(0,0,0,.75)"}}>
        <div style={{height:26,background:"#05080a",display:"flex",justifyContent:"space-between",alignItems:"center",padding:"0 10px",borderBottom:"1px solid #1f262c",flexShrink:0}}>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <span style={{color:"#dce3e8",fontSize:10,fontWeight:700,letterSpacing:.4}}>NIHON KOHDEN</span>
            <span style={{color:"#82909c",fontSize:8}}>Adult</span>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <span style={{color:"#5a6772",fontSize:8}}>cardiolife</span>
            <span style={{color:"#556",fontSize:9}}>{timeStr}</span>
          </div>
        </div>
        <div style={{flex:1,position:"relative",minHeight:0,paddingTop:6}}>
          <div style={{position:"absolute",top:6,left:10,display:"flex",gap:6,zIndex:2}}>
            {[["Report",false],["Large",false],["12-lead ECG",true]].map(([txt,active])=><div key={txt} style={{padding:"4px 7px",borderRadius:3,border:`1px solid ${active?"#69bce8":"#3b5165"}`,background:active?"#173a55":"#0f161d",color:active?"#dff6ff":"#8aa1b5",fontSize:8,lineHeight:1}}>{txt}</div>)}
          </div>
          <div style={{position:"absolute",top:14,left:16,color:"#7cff47",fontSize:10,fontWeight:700,zIndex:2}}>HR</div>
          <div style={{position:"absolute",top:18,right:14,width:16,height:10,border:"2px solid #35ff35",borderRadius:2,zIndex:2}}><div style={{position:"absolute",right:-4,top:2,width:2,height:4,background:"#35ff35"}}/></div>
          <div style={{position:"absolute",top:28,right:16,color:"#7cff47",fontSize:8,zIndex:2}}>15%</div>
          <div style={{position:"absolute",top:52,left:8,right:8,bottom:64}}>
            <Wave getState={()=>({gen:ta=>{const sa=shockArtifact(ta-shockTimeRef.current);return sa!==null?sa:ecgWave(phaseAt(hrHist.current,ta)%1,rhythmAt(ta,trans),envAt(ta,cprTrans,x=>x,450),ta,rate);}})} color="#00FF00" h={190} scale={.30} sw={1.5}/>
          </div>
          <div style={{position:"absolute",top:40,left:84,color:"#7cff47",fontSize:11,fontWeight:700,lineHeight:1.05,zIndex:2}}>{cpr?beatCprRef.current:(hasRate(rhythm)?hrN:"---")}<br/><span style={{fontSize:8,fontWeight:400}}>bpm</span><br/><span style={{fontSize:8}}>30</span></div>

          {mode==="manual"&&(
            <div style={{position:"absolute",left:112,bottom:10,width:390,height:156,border:"2px solid #ff6e35",borderRadius:4,background:"#040404",boxShadow:"0 0 0 1px rgba(255,110,53,.35) inset"}}>
              <div style={{display:"grid",gridTemplateColumns:"150px repeat(4,1fr)",alignItems:"stretch",height:30}}>
                <div style={{background:"#ff7b3c",color:"#fff",fontSize:22,padding:"4px 14px",display:"flex",alignItems:"center"}}>Manual</div>
                <button style={{...smallBtn(true),margin:2}} onClick={()=>onChange("dc",{...dc,mode:"manual"})}>Defib</button>
                <button style={{...smallBtn(sync),margin:2}} onClick={()=>onChange("dc",{...dc,sync:!sync})}>Sync</button>
                <button style={{...smallBtn(false),margin:2}}>ECG Sens/<br/>Lead</button>
                <button style={{...smallBtn(false),margin:2}}>Wave2<br/>Select</button>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",borderTop:"2px solid #ff6e35",color:"#fff",height:32}}>
                <div style={{borderRight:"2px solid #ff6e35",display:"flex",alignItems:"center",justifyContent:"center",gap:8,fontSize:12}}><span style={{opacity:.8}}>Shocks</span><span style={{fontSize:18}}>{shockCount}</span></div>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"0 12px",fontSize:12}}><span style={{opacity:.8}}>Energy</span><span style={{fontSize:18}}>{energy||0}J</span></div>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 140px 118px",height:92,borderTop:"2px solid #ff6e35"}}>
                <div style={{borderRight:"2px solid #ff6e35",background:"#060606"}}/>
                <div style={{borderRight:"2px solid #ff6e35",background:"#ff7b3c",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:8}}>
                  <div style={{fontSize:12,color:"#444"}}>OP Sound</div>
                  <button style={{width:76,height:26,border:"none",borderRadius:4,background:"#8d959b",color:"#fff",fontSize:12}}>On</button>
                </div>
                <div style={{background:"#ff7b3c",display:"flex",flexDirection:"column",justifyContent:"space-between",padding:"8px 10px 10px 10px"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",fontSize:11,color:"#542c11",fontWeight:700}}><span>{panelStatus}</span><span style={{width:14,height:22,background:"#111",display:"inline-block"}}/></div>
                  <div style={{fontSize:28,color:"#000",fontWeight:700,textAlign:"right"}}>{currentJ}J</div>
                </div>
              </div>
            </div>
          )}

          {mode==="aed"&&(
            <div style={{position:"absolute",left:140,bottom:24,width:250,height:80,border:"2px solid #ff6e35",background:"#121212",display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",color:"#fff"}}>
              <div style={{fontSize:20,color:"#ff7b3c",fontWeight:700}}>AED</div>
              <div style={{fontSize:12,color:"#ccc",marginTop:6}}>Pads analysis standby</div>
            </div>
          )}

          {mode==="pacer"&&(
            <div style={{position:"absolute",left:104,bottom:12,width:408,height:140,border:"2px solid #2e73b5",background:"#05080f",borderRadius:4,padding:10,color:"#d1e6ff"}}>
              <div style={{fontSize:18,fontWeight:700,marginBottom:8,color:"#53a2ff"}}>Pacing</div>
              <div style={{display:"flex",gap:18,alignItems:"center",justifyContent:"space-between"}}>
                {[{k:"rate",l:"RATE (ppm)",mn:30,mx:200,st:5},{k:"output",l:"OUTPUT (mA)",mn:0,mx:200,st:10}].map(x=>(
                  <div key={x.k} style={{display:"flex",flexDirection:"column",gap:6}}>
                    <div style={{fontSize:11,color:"#8fbae3"}}>{x.l}</div>
                    <div style={{display:"flex",alignItems:"center",gap:6}}>
                      <button onClick={()=>pacerStep(x.k,x.mn,x.mx,-x.st)} style={{width:28,height:28,borderRadius:4,border:"1px solid #21486f",background:"#0f2237",color:"#fff",fontSize:16}}>−</button>
                      <div style={{width:62,textAlign:"center",fontSize:24,fontWeight:700,color:"#53a2ff"}}>{pacer[x.k]}</div>
                      <button onClick={()=>pacerStep(x.k,x.mn,x.mx,x.st)} style={{width:28,height:28,borderRadius:4,border:"1px solid #21486f",background:"#0f2237",color:"#fff",fontSize:16}}>+</button>
                    </div>
                  </div>
                ))}
                <button onClick={()=>onChange("dc",{...dc,pacer:{...pacer,on:!pacer.on}})} style={{padding:"10px 16px",background:pacer.on?"#003300":"#0c0c0c",border:`2px solid ${pacer.on?"#00CC00":"#1e1e1e"}`,color:pacer.on?"#00FF00":"#7d8791",cursor:"pointer",fontSize:14,fontWeight:"bold",borderRadius:6}}>{pacer.on?"⚡ PACING ON":"PACING OFF"}</button>
              </div>
            </div>
          )}
        </div>
        <div style={{display:"flex",justifyContent:"space-around",alignItems:"center",height:54,background:"#2f3942",borderTop:"1px solid #68737c",padding:"0 10px",flexShrink:0,position:"relative"}}>
          {[["⏭","Event"],["⌂","Home"],["▣","Menu"],["◉","Start/Stop"],["◔","Interval"],["△","Silence Alarms"]].map(([icon,label])=><div key={label} style={{display:"flex",flexDirection:"column",alignItems:"center",gap:4,color:"#ebf0f5",fontSize:9}}><div style={{width:24,height:24,borderRadius:"50%",border:"1px solid #d2dae1",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12}}>{icon}</div><div>{label}</div></div>)}
          <div style={{position:"absolute",bottom:16,left:"50%",transform:"translateX(-50%)",color:"#dce6ef",fontSize:9,borderBottom:"2px solid #dce6ef",padding:"0 22px 2px 22px"}}>NIBP</div>
        </div>
      </div>

      <div style={{width:244,flexShrink:0,background:flash?"linear-gradient(180deg,#6f7580,#4a5260 16%,#3b4550 100%)":"linear-gradient(180deg,#75808a,#57606b 16%,#454f59 100%)",display:"flex",flexDirection:"column",alignItems:"center",padding:"12px 10px",transition:"background .15s",overflowY:"auto",boxShadow:"inset 1px 0 0 rgba(255,255,255,.25), inset 10px 0 14px rgba(255,255,255,.06)"}}>
        <div style={{width:"100%",display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:4}}>
          <div style={{display:"flex",alignItems:"center",gap:6}}>
            <div style={{width:16,height:16,borderRadius:"50%",border:"2px solid #9cc9ef",display:"flex",alignItems:"center",justifyContent:"center",fontSize:9,color:"#d8efff"}}>↔</div>
            <div style={{width:28,height:28,borderRadius:"50%",background:"radial-gradient(circle at 35% 30%,#79ff6d,#38af2e 70%)",boxShadow:"0 0 0 2px rgba(255,255,255,.35), 0 0 8px rgba(130,255,120,.55)"}}/>
          </div>
          <div style={{fontSize:11,color:"#f1f1f1",fontWeight:700,marginTop:2}}>cardiolife</div>
        </div>
        <div style={{display:"flex",alignItems:"center",justifyContent:"center",position:"relative",marginTop:2}}>
          <div style={{position:"absolute",left:-8,top:88,fontSize:11,color:"#fff",fontWeight:700}}>Defib</div>
          <div style={{position:"absolute",left:-4,top:106,fontSize:11,color:"#dce2e7"}}>Monitor</div>
          <div style={{position:"absolute",left:12,top:134,fontSize:11,color:"#fff",fontWeight:700}}>AED</div>
          <div style={{position:"absolute",left:80,top:156,fontSize:12,color:"#fff",fontWeight:700}}>Off</div>
          <div style={{position:"absolute",right:12,top:134,fontSize:11,color:"#fff",fontWeight:700}}>Test</div>
          <div style={{position:"absolute",right:-2,top:106,fontSize:11,color:"#ffb066",fontWeight:700}}>Pacing</div>
          <div style={{position:"absolute",right:16,bottom:14,fontSize:46,color:"#ff9b44",fontWeight:800,lineHeight:1}}>1</div>
          <div style={{padding:6,borderRadius:"50%",background:"radial-gradient(circle at 35% 30%,#fff,#b5bdc7 68%,#949da8 100%)",boxShadow:"0 3px 8px rgba(0,0,0,.35), inset 0 1px 2px rgba(255,255,255,.85)"}}>
            <RotaryDial value={energy} levels={DIAL_LEVELS} onChange={setEnergy} size={174}/>
          </div>
        </div>
        <div style={{display:"flex",flexDirection:"column",gap:10,marginTop:2}}>
          <RoundStepButton num="2" label={mode==="aed"?"Charge\nAED":"Charge"} onClick={handleChargeClick} disabled={charged||charging||energy===0} accent="#ff8a00" icon={charging?"⏳":"⚡"} activeGlow={charging||charged}/>
          <RoundStepButton num="3" label="Shock" onClick={doShock} disabled={!charged} accent="#ff8a00" icon="⚡" activeGlow={charged}/>
        </div>
        <div style={{marginTop:10,width:"100%",padding:"8px 10px",borderRadius:8,background:"rgba(0,0,0,.18)",boxShadow:"inset 0 1px 0 rgba(255,255,255,.12)"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",fontSize:11,color:"#f4f4f4"}}><span>Status</span><span style={{color:sc,fontWeight:700}}>{st}</span></div>
          <div style={{display:"flex",justifyContent:"space-between",marginTop:5,fontSize:11,color:"#d7dde3"}}><span>Energy</span><span style={{fontSize:18,fontWeight:700,color:"#ffb14b"}}>{charging?chargeNum:(energy||0)}J</span></div>
          <div style={{display:"flex",justifyContent:"space-between",marginTop:4,fontSize:11,color:"#d7dde3"}}><span>Shocks</span><span>{shockCount}</span></div>
        </div>
      </div>
    </div>
  );
}

// Circular button with its label curved around the outside of the rim (like a stove-knob badge).
function ArcButton({size=108,num,label,onClick,disabled,bg,ring,textColor,icon,sub,glow}){
  const uid=useRef("arc"+Math.random().toString(36).slice(2,8)).current;
  const cx=size/2,cy=size/2+16,r=size/2-6,arcR=r+15;
  const badgeR=size*.19,badgeX=cx+r*.74,badgeY=cy-r*.74;
  return(
    <button onClick={onClick} disabled={disabled} style={{background:"none",border:"none",padding:0,cursor:disabled?"not-allowed":"pointer",touchAction:"manipulation"}}>
      <svg width={size+badgeR} height={size+32} style={{overflow:"visible",display:"block"}}>
        <defs>
          <path id={uid} d={`M ${cx-arcR} ${cy-2} A ${arcR} ${arcR} 0 0 1 ${cx+arcR} ${cy-2}`} fill="none"/>
        </defs>
        <circle cx={cx} cy={cy} r={r} fill={bg} stroke={ring} strokeWidth="3" style={glow?{filter:"drop-shadow(0 0 10px rgba(211,47,47,.7))"}:undefined}/>
        <circle cx={cx-r*.3} cy={cy-r*.35} r={r*.35} fill="#fff" opacity=".25"/>
        <text fontSize={size*.24} textAnchor="middle" x={cx} y={cy+size*.06}>{icon}</text>
        {sub&&<text fontSize="10" fontWeight="bold" fill={textColor} textAnchor="middle" x={cx} y={cy+size*.30}>{sub}</text>}
        <text fontSize="15" fontWeight="900" fill={textColor} letterSpacing="1.5">
          <textPath href={`#${uid}`} startOffset="50%" textAnchor="middle">{label}</textPath>
        </text>
        {/* big, unmistakable step-number badge sitting on the rim */}
        <circle cx={badgeX} cy={badgeY} r={badgeR} fill="#1a5fa8" stroke="#fff" strokeWidth="2.5" style={{filter:"drop-shadow(0 1px 3px rgba(0,0,0,.4))"}}/>
        <text x={badgeX} y={badgeY+badgeR*.35} fontSize={badgeR*1.15} fontWeight="900" fill="#fff" textAnchor="middle">{num}</text>
      </svg>
    </button>
  );
}

const PR=[
  {n:"🟠 PEA Arrest",r:"pea",hr:62,spo2:87,rr:0,etco2:13},
  {n:"🔴 Pulseless V-Tach",r:"vtp",hr:190,spo2:80,rr:0,etco2:9},
  {n:"🔴 V-Fibrillation",r:"vf",hr:180,spo2:76,rr:0,etco2:6},
  {n:"⚫ Asystole",r:"asystole",hr:0,spo2:70,rr:0,etco2:0},
];

function Panel({state,onChange,open,toggle,fullScreen}){
  const{displayMode,rhythm,hr,spo2,rr,nibp,abp,etco2,cpr,temp,etco2On,bagging,nibpMeasuring,abpOn,visible}=state;
  const[draft,setDraft]=useState({hr,spo2,rr,etco2,temp,nibp:{...nibp},abp:{...abp}});
  useEffect(()=>{setDraft({hr,spo2,rr,etco2,temp,nibp:{...nibp},abp:{...abp}});},[hr,spo2,rr,etco2,temp,nibp.sys,nibp.dia,abp.sys,abp.dia]);
  const dirty=draft.hr!==hr||draft.spo2!==spo2||draft.rr!==rr||draft.etco2!==etco2||draft.temp!==temp||draft.nibp.sys!==nibp.sys||draft.nibp.dia!==nibp.dia;
  const apply=()=>{
    onChange("hr",draft.hr);onChange("spo2",draft.spo2);onChange("rr",draft.rr);onChange("etco2",draft.etco2);onChange("temp",draft.temp);
    onChange("nibp",draft.nibp);
    // One BP control drives both cuff BP and invasive ABP target values, so the operator does not
    // have to enter two almost-identical pressures separately.
    onChange("abp",{sys:draft.nibp.sys,dia:draft.nibp.dia});
  };
  // switching rhythm also drives the ABP damping automatically — arrest rhythms progressively
  // reshape toward an overdamped waveform as they flatten, rather than staying "normal" until flat.
  const setRhythm=r=>{onChange("rhythm",r);onChange("damping",isHp(r)?"normal":"over");};
  const nibpTimer=useRef(null);
  const startNibp=()=>{
    onChange("nibpMeasuring",true);
    if(nibpTimer.current)clearTimeout(nibpTimer.current);
    const willFail=!isHp(rhythm); // no pulse → cuff can't get a reading, same as a real monitor
    nibpTimer.current=setTimeout(()=>{
      onChange("nibpResult",willFail?"fail":{sys:draft.nibp.sys,dia:draft.nibp.dia});
      onChange("nibpMeasuring",false);
    },4000);
  };
  const sl=(l,k,v,mn,mx,st=1,col="#ccc")=>(
    <div style={{marginBottom:8}}>
      <div style={{display:"flex",justifyContent:"space-between",marginBottom:1}}><span style={{color:"#555",fontSize:10}}>{l}</span><span style={{color:col,fontSize:14,fontWeight:"bold",fontFamily:"monospace"}}>{v}</span></div>
      <input type="range" min={mn} max={mx} step={st} value={v} onChange={e=>setDraft(p=>({...p,[k]:Number(e.target.value)}))} style={{width:"100%",accentColor:col,cursor:"pointer",height:20}}/>
    </div>
  );
  const eyeBtn=(key,label,color)=>{
    const on=(visible&&visible[key])!==false;
    return <button key={key} onClick={()=>onChange("visible",{...(visible||{}),[key]:!on})} style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,width:"100%",padding:"8px 10px",marginBottom:6,background:on?"#11161a":"#0d0d0d",border:`1px solid ${on?color:"#222"}`,borderRadius:6,color:on?color:"#666",cursor:"pointer",fontFamily:"monospace",fontSize:11,touchAction:"manipulation"}}>
      <span>{label}</span><span style={{fontSize:15}}>{on?"👁":"🙈"}</span>
    </button>;
  };
  const body=(
    <div style={fullScreen
      ?{width:"100%",height:"100%",background:"#0b0b0b",overflowY:"auto",padding:"14px",fontFamily:"monospace",boxSizing:"border-box"}
      :{position:"fixed",right:0,top:0,bottom:0,width:290,background:"#0b0b0b",borderLeft:"2px solid #1a1a1a",overflowY:"auto",zIndex:999,padding:"12px",fontFamily:"monospace"}}>
          <div style={{marginBottom:14}}>
            <div style={{color:"#444",fontSize:10,marginBottom:6}}>빠른 시나리오 전환 (Arrest)</div>
            {PR.map((p,idx)=><button key={p.n+idx} onClick={()=>{setRhythm(p.r);onChange("hr",p.hr);onChange("spo2",p.spo2);onChange("rr",p.rr);onChange("etco2",p.etco2);}} style={{width:"100%",padding:"8px 10px",marginBottom:4,background:"#0a0a0a",border:`1px solid ${DANGER.includes(p.r)?"#330a0a":"#1a1a1a"}`,color:DANGER.includes(p.r)?"#CC4444":p.r==="asystole"?"#666":"#888",cursor:"pointer",fontSize:11,fontFamily:"monospace",textAlign:"left",borderRadius:4,touchAction:"manipulation"}}>▶ {p.n}</button>)}
          </div>
          <div style={{color:"#aaa",fontSize:14,fontWeight:"bold",marginBottom:12,borderBottom:"1px solid #1a1a1a",paddingBottom:8}}>⚙ OPERATOR</div>
          <div style={{marginBottom:12}}>
            <div style={{color:"#444",fontSize:10,marginBottom:6}}>DISPLAY 전환</div>
            <div style={{display:"flex",gap:6}}>
              {[["monitor","📟 Patient Monitor"],["dc","⚡ DC TEC-5600"]].map(([m,l])=><button key={m} onClick={()=>onChange("displayMode",m)} style={{flex:1,padding:"10px 4px",background:displayMode===m?"#0c2a0c":"#111",border:`2px solid ${displayMode===m?"#1a5a1a":"#222"}`,color:displayMode===m?"#4dcc4d":"#444",cursor:"pointer",fontSize:10,fontFamily:"monospace",borderRadius:5,touchAction:"manipulation"}}>{displayMode===m?"▶ ":""}{l}</button>)}
            </div>
          </div>
          <div style={{marginBottom:12}}>
            <div style={{color:"#444",fontSize:10,marginBottom:6}}>RHYTHM 선택 (클릭 즉시, 부드럽게 전환)</div>
            <select value={rhythm} onChange={e=>setRhythm(e.target.value)} style={{width:"100%",background:"#111",border:"1px solid #333",color:DANGER.includes(rhythm)?"#FF6666":"#4dcc4d",padding:"8px",fontFamily:"monospace",fontSize:12,borderRadius:5,cursor:"pointer"}}>
              <option value="nsr">Normal Sinus Rhythm (NSR)</option>
              <option value="pea">PEA</option>
              <option value="stemi">STEMI (ST Elevation)</option>
              <option value="vt">V-Tach (맥박 있음)</option>
              <option value="vtp">Pulseless V-Tach</option>
              <option value="vf">V-Fibrillation</option>
              <option value="asystole">Asystole</option>
            </select>
          </div>
          <div style={{color:"#444",fontSize:10,marginBottom:6,marginTop:14,borderTop:"1px solid #1a1a1a",paddingTop:10}}>수치 조절 (아래 값을 바꾼 뒤 '적용'을 눌러야 반영됩니다)</div>
          {sl("Heart Rate (bpm)","hr",draft.hr,0,220,1,C.ecg)}
          {sl("SpO₂ (%)","spo2",draft.spo2,70,100,1,C.spo2)}
          {sl("RR (/min)","rr",draft.rr,0,40,1,C.rr)}
          {sl("EtCO₂ (mmHg)","etco2",draft.etco2,0,70,1,C.etco2)}
          <div style={{marginBottom:12,padding:"10px",background:"#0d0d0d",border:"1px solid #202020",borderRadius:7}}>
            <div style={{color:"#777",fontSize:10,fontWeight:"bold",marginBottom:8}}>👁 수치 표시 / 숨기기</div>
            {eyeBtn("hr","HR",C.ecg)}
            {eyeBtn("nibp",abpOn?"BP (ABP/NIBP)":"NIBP",C.abp)}
            {eyeBtn("spo2","SpO₂",C.spo2)}
            {eyeBtn("etco2","EtCO₂",C.etco2)}
            {eyeBtn("rr","RR",C.rr)}
          </div>
          <div style={{marginBottom:12,padding:"10px",background:"#0d0d0d",border:"1px solid #202020",borderRadius:7}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
              <div>
                <div style={{color:"#777",fontSize:10,fontWeight:"bold"}}>BLOOD PRESSURE</div>
                <div style={{color:C.abp,fontSize:18,fontWeight:"bold",marginTop:2}}>{draft.nibp.sys}/{draft.nibp.dia} <span style={{fontSize:10,color:"#555"}}>mmHg</span></div>
              </div>
              <button onClick={()=>onChange("abpOn",!abpOn)} style={{padding:"7px 10px",background:abpOn?"#2b0909":"#111",border:`2px solid ${abpOn?"#a52a2a":"#333"}`,color:abpOn?"#ff6666":"#777",borderRadius:6,fontSize:10,fontWeight:"bold",cursor:"pointer",fontFamily:"monospace"}}>
                ABP {abpOn?"ON":"OFF"}
              </button>
            </div>
            {[{k:"sys",l:"SYS",mn:60,mx:240},{k:"dia",l:"DIA",mn:30,mx:140}].map(x=>(
              <div key={x.k} style={{marginBottom:8}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:2}}><span style={{color:"#555",fontSize:9}}>{x.l}</span><span style={{color:C.abp,fontSize:14,fontWeight:"bold"}}>{draft.nibp[x.k]}</span></div>
                <input type="range" min={x.mn} max={x.mx} step="1" value={draft.nibp[x.k]} onChange={e=>{const v=Number(e.target.value);setDraft(p=>({...p,nibp:{...p.nibp,[x.k]:v},abp:{...p.abp,[x.k]:v}}));}} style={{width:"100%",accentColor:C.abp,cursor:"pointer",height:22}}/>
              </div>
            ))}
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8,paddingTop:2}}>
              <span style={{fontSize:9,color:"#444"}}>MAP</span><span style={{fontSize:13,color:"#888",fontWeight:"bold"}}>{Math.round((draft.nibp.sys+2*draft.nibp.dia)/3)}</span>
            </div>
            <div style={{fontSize:9,color:"#555",lineHeight:1.45,marginBottom:8}}>NIBP 값을 조절하면 ABP 목표값도 같은 값으로 자동 연동됩니다. ABP OFF 시에는 ABP 파형이 숨겨지고 NIBP만 표시됩니다.</div>
            <button onClick={startNibp} disabled={nibpMeasuring} style={{width:"100%",padding:"9px 8px",background:nibpMeasuring?"#111":"#0c2a2a",border:`2px solid ${nibpMeasuring?"#222":"#2a6a6a"}`,color:nibpMeasuring?"#444":"#4de0e0",borderRadius:6,fontSize:12,fontWeight:"bold",cursor:nibpMeasuring?"not-allowed":"pointer",fontFamily:"monospace",touchAction:"manipulation"}}>{nibpMeasuring?"측정 중...":"🩺 NIBP 측정"}</button>
          </div>
          <button onClick={apply} style={{width:"100%",padding:"12px",marginBottom:14,background:dirty?"#0c2a0c":"#111",border:`2px solid ${dirty?"#2fbf2f":"#222"}`,color:dirty?"#4dff4d":"#444",cursor:"pointer",fontSize:13,fontWeight:"bold",fontFamily:"monospace",borderRadius:6,touchAction:"manipulation"}}>
            {dirty?"✅ 적용 (서서히 변동 적용)":"적용됨 — 변경 없음"}
          </button>
          <div style={{borderTop:"1px solid #1a1a1a",paddingTop:10,marginBottom:12}}>
            <div style={{color:"#444",fontSize:10,marginBottom:6}}>처치 / 장비 연결</div>
            <button onClick={()=>{const turningOn=!cpr;onChange("cpr",turningOn);if(turningOn)onChange("cprRate",Math.floor(100+Math.random()*21));}} style={{width:"100%",padding:"14px",marginBottom:6,background:cpr?"#220000":"#111",border:`2px solid ${cpr?"#990000":"#222"}`,color:cpr?"#FF4444":"#555",cursor:"pointer",fontSize:14,fontWeight:"bold",fontFamily:"monospace",borderRadius:6,touchAction:"manipulation"}}>
              {cpr?"🫀 CPR 진행 중 [눌러서 정지]":"🫀 CPR 시작"}
            </button>
            <button onClick={()=>onChange("etco2On",!etco2On)} style={{width:"100%",padding:"10px 8px",marginBottom:6,background:etco2On?"#2a2200":"#111",border:`2px solid ${etco2On?"#bfa02f":"#222"}`,color:etco2On?"#ffe14d":"#666",borderRadius:6,fontSize:12,fontWeight:"bold",cursor:"pointer",fontFamily:"monospace",touchAction:"manipulation"}}>🌬️ EtCO₂ {etco2On?"연결됨 (해제)":"연결"}</button>
            <button onClick={()=>onChange("bagging",!bagging)} style={{width:"100%",padding:"10px 8px",background:bagging?"#0c2a0c":"#111",border:`2px solid ${bagging?"#2fbf2f":"#222"}`,color:bagging?"#4dff4d":"#666",borderRadius:6,fontSize:12,fontWeight:"bold",cursor:"pointer",fontFamily:"monospace",touchAction:"manipulation"}}>🫁 Ambu Bagging {bagging?"중 (정지)":""}</button>
          </div>
    </div>
  );
  if(fullScreen)return body;
  return(
    <>
      <button onClick={toggle} style={{position:"fixed",bottom:16,right:16,zIndex:1000,background:open?"#222":"#0f2f0f",border:`2px solid ${open?"#333":"#1a5a1a"}`,color:"#ddd",padding:"12px 18px",borderRadius:10,cursor:"pointer",fontSize:14,fontWeight:"bold",fontFamily:"monospace",boxShadow:"0 4px 24px rgba(0,0,0,.9)",touchAction:"manipulation"}}>{open?"✕ 닫기":"⚙ OPERATOR"}</button>
      {open&&body}
    </>
  );
}

const storeGet=(k,fallback)=>{try{const v=localStorage.getItem(k);return v?JSON.parse(v):fallback;}catch(e){return fallback;}};
const storeSet=(k,v)=>{try{localStorage.setItem(k,JSON.stringify(v));}catch(e){}};
const STORE={role:"acls-role-v2",code:"acls-code-v2",state:"acls-state-v2"};

const INIT={displayMode:"monitor",rhythm:"nsr",hr:72,spo2:98,rr:16,nibp:{sys:120,dia:78},abp:{sys:120,dia:78},abpOn:true,visible:{hr:true,spo2:true,rr:true,nibp:true,etco2:true},etco2:35,temp:37.0,cpr:false,cprRate:110,damping:"normal",etco2On:false,bagging:false,nibpMeasuring:false,nibpResult:null,dc:{energy:0,charged:false,charging:false,shockDelivered:false,shockCount:0,mode:"manual",sync:false,pacer:{on:false,rate:60,output:50}}};
const PEER_PREFIX="acls-mon-"; // PeerJS ids must be alphanumeric-ish; prefix avoids collisions with other apps on the public broker

function SimDisplay({state,set,charge,shock}){
  const[open,setOpen]=useState(false);
  const{dispRef,transRef,dampTransRef,cprTransRef,hrHist,rrHist,beatHrRef,beatRrRef,beatCprRef}=useEngine(state);
  return(
    <div style={{flex:1,overflow:"hidden",display:"flex",flexDirection:"column",minHeight:0}}>
      <div style={{flex:1,overflow:"hidden",marginRight:open?290:0,transition:"margin-right .2s"}}>
        {state.displayMode==="monitor"?<Monitor state={state} disp={dispRef} trans={transRef} dampTrans={dampTransRef} cprTrans={cprTransRef} hrHist={hrHist} rrHist={rrHist} beatHrRef={beatHrRef} beatRrRef={beatRrRef} beatCprRef={beatCprRef} onChange={set} toggle={()=>setOpen(v=>!v)} open={open}/>:<DC state={state} disp={dispRef} trans={transRef} cprTrans={cprTransRef} hrHist={hrHist} beatHrRef={beatHrRef} beatCprRef={beatCprRef} onCharge={charge} onShock={shock} onChange={set}/>}
      </div>
      <Panel state={state} onChange={set} open={open} toggle={()=>setOpen(v=>!v)}/>
    </div>
  );
}

// Monitor-only host: display alone, no operator controls (those live on the paired Operator device).
// charge/shock/onDcChange still work locally — the defib itself is operated on this device.
function MonitorOnlyDisplay({state,charge,shock,onDcChange}){
  const{dispRef,transRef,dampTransRef,cprTransRef,hrHist,rrHist,beatHrRef,beatRrRef,beatCprRef}=useEngine(state);
  return state.displayMode==="monitor"
    ?<Monitor state={state} disp={dispRef} trans={transRef} dampTrans={dampTransRef} cprTrans={cprTransRef} hrHist={hrHist} rrHist={rrHist} beatHrRef={beatHrRef} beatRrRef={beatRrRef} beatCprRef={beatCprRef} onChange={()=>{}} toggle={()=>{}} open={false}/>
    :<DC state={state} disp={dispRef} trans={transRef} cprTrans={cprTransRef} hrHist={hrHist} beatHrRef={beatHrRef} beatCprRef={beatCprRef} onCharge={charge} onShock={shock} onChange={onDcChange}/>;
}

function RoleSelect({onPick}){
  const box={flex:1,background:"#0d0d0d",border:"2px solid #1e1e1e",borderRadius:12,padding:"22px 16px",color:"#ddd",cursor:"pointer",fontFamily:"monospace",textAlign:"center",touchAction:"manipulation"};
  return(
    <div style={{background:"#000",height:"100vh",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:18,padding:24,fontFamily:"monospace"}}>
      <div style={{color:"#4dcc4d",fontSize:15,fontWeight:"bold",marginBottom:6}}>ACLS 시뮬레이터 — 이 기기는 무엇으로 쓸까요?</div>
      <div style={{display:"flex",gap:14,width:"100%",maxWidth:520}}>
        <div style={box} onClick={()=>onPick("monitor")}>
          <div style={{fontSize:30,marginBottom:8}}>🖥️</div>
          <div style={{fontWeight:"bold",marginBottom:4}}>Monitor</div>
          <div style={{fontSize:11,color:"#777"}}>iPad 등에서 환자 모니터 화면만 표시.<br/>코드를 발급해서 폰과 연결합니다.</div>
        </div>
        <div style={box} onClick={()=>onPick("operator")}>
          <div style={{fontSize:30,marginBottom:8}}>📱</div>
          <div style={{fontWeight:"bold",marginBottom:4}}>Operator</div>
          <div style={{fontSize:11,color:"#777"}}>폰 등에서 조작만 담당.<br/>Monitor 기기의 코드를 입력해 연결합니다.</div>
        </div>
      </div>
      <div style={{...box,flex:"none",width:"100%",maxWidth:520,padding:"14px 16px"}} onClick={()=>onPick("solo")}>
        <div style={{fontWeight:"bold",fontSize:13}}>🧪 한 기기에서 모두 (테스트용)</div>
        <div style={{fontSize:11,color:"#777",marginTop:2}}>이전처럼 한 화면에서 모니터+조작 패널을 같이 사용</div>
      </div>
    </div>
  );
}

function MonitorHost(){
  const[code]=useState(()=>{
    const saved=storeGet(STORE.code,null);
    const c=saved&&String(saved).match(/^\d{4}$/)?String(saved):String(Math.floor(1000+Math.random()*9000));
    storeSet(STORE.code,c);return c;
  });
  const[state,setState]=useState(()=>{const v=storeGet(STORE.state,INIT);return {...INIT,...v,nibp:{...INIT.nibp,...(v.nibp||{})},abp:{...INIT.abp,...(v.abp||{})},visible:{...INIT.visible,...(v.visible||{})},dc:{...INIT.dc,...(v.dc||{}),pacer:{...INIT.dc.pacer,...((v.dc&&v.dc.pacer)||{})}}};});
  const[status,setStatus]=useState({connected:false,lastRecv:0,err:""});
  const ct=useRef(null);
  const peerRef=useRef(null);
  useEffect(()=>{storeSet(STORE.state,state);},[state]);
  const charge=()=>{setState(p=>({...p,dc:{...p.dc,charging:true,charged:false}}));if(ct.current)clearTimeout(ct.current);ct.current=setTimeout(()=>setState(p=>({...p,dc:{...p.dc,charging:false,charged:true}})),2800);};
  const shock=()=>{setState(p=>({...p,dc:{...p.dc,charged:false,shockDelivered:true,shockCount:p.dc.shockCount+1}}));setTimeout(()=>setState(p=>({...p,dc:{...p.dc,shockDelivered:false}})),3500);};
  const setDc=useCallback((k,v)=>setState(p=>({...p,[k]:v})),[]); // e.g. pacer knob changes on the DC screen itself

  useEffect(()=>{
    let stopped=false,retryTimer=null;
    const startPeer=()=>{
      if(stopped)return;
      try{if(peerRef.current&&!peerRef.current.destroyed)peerRef.current.destroy();}catch(e){}
      const peer=new Peer(PEER_PREFIX+code);
      peerRef.current=peer;
      peer.on("open",()=>setStatus(s=>({...s,err:""})));
      peer.on("disconnected",()=>{
        setStatus(s=>({...s,connected:false,err:"연결 복구 중..."}));
        try{peer.reconnect();}catch(e){}
      });
      peer.on("error",err=>{
        const type=String(err&&err.type||err);
        setStatus(s=>({...s,connected:false,err:type}));
        if(!stopped&&["network","server-error","socket-error","unavailable-id"].includes(err&&err.type)){
          clearTimeout(retryTimer);retryTimer=setTimeout(startPeer,1800);
        }
      });
      peer.on("connection",conn=>{
        conn.on("open",()=>setStatus(s=>({...s,connected:true,err:"",lastRecv:Date.now()})));
        conn.on("data",data=>{
          if(data&&data._heartbeat){setStatus(s=>({...s,connected:true,lastRecv:Date.now(),err:""}));return;}
          // keep this device's own defibrillator state (charge/shock/pacer) local.
          const{_ts,...next}=data||{};
          setState(p=>({...next,dc:p.dc}));
          setStatus(s=>({...s,connected:true,lastRecv:Date.now(),err:""}));
        });
        conn.on("close",()=>setStatus(s=>({...s,connected:false,err:"Operator 재연결 대기 중..."})));
        conn.on("error",err=>setStatus(s=>({...s,connected:false,err:String(err&&err.type||err)})));
      });
    };
    startPeer();
    const resume=()=>{
      const p=peerRef.current;
      if(!p||p.destroyed)startPeer();
      else if(p.disconnected){try{p.reconnect();}catch(e){startPeer();}}
    };
    window.addEventListener("online",resume);window.addEventListener("focus",resume);
    document.addEventListener("visibilitychange",resume);
    return()=>{stopped=true;clearTimeout(retryTimer);window.removeEventListener("online",resume);window.removeEventListener("focus",resume);document.removeEventListener("visibilitychange",resume);try{peerRef.current&&peerRef.current.destroy();}catch(e){}};
  },[code]);

  const[,force]=useState(0);
  useEffect(()=>{const iv=setInterval(()=>force(x=>x+1),1000);return()=>clearInterval(iv);},[]);
  const secsAgo=status.lastRecv?Math.round((Date.now()-status.lastRecv)/1000):null;
  return(
    <div style={{background:"#000",height:"100vh",display:"flex",flexDirection:"column",overflow:"hidden"}}>
      <div style={{background:"#0d1a0d",color:"#4dcc4d",textAlign:"center",padding:"5px 0",fontSize:12,fontFamily:"monospace",fontWeight:"bold",flexShrink:0}}>
        📟 MONITOR — 연결 코드: {code} (Operator 기기에 이 코드를 입력하세요)
        {" · "}{status.err?<span style={{color:"#FF5555"}}>⚠ {status.err}</span>:secsAgo===null?<span style={{color:"#996600"}}>Operator 연결 대기 중...</span>:<span style={{color:secsAgo>3?"#FFAA33":"#4dcc4d"}}>수신 {secsAgo}s 전</span>}
      </div>
      <MonitorOnlyDisplay state={state} charge={charge} shock={shock} onDcChange={setDc}/>
    </div>
  );
}

function OperatorHost(){
  const[code,setCode]=useState(()=>String(storeGet(STORE.code,"")||""));
  const[joined,setJoined]=useState(false);
  const[state,setState]=useState(()=>{const v=storeGet(STORE.state,INIT);return {...INIT,...v,nibp:{...INIT.nibp,...(v.nibp||{})},abp:{...INIT.abp,...(v.abp||{})},visible:{...INIT.visible,...(v.visible||{})},dc:{...INIT.dc,...(v.dc||{}),pacer:{...INIT.dc.pacer,...((v.dc&&v.dc.pacer)||{})}}};});
  const[status,setStatus]=useState({lastSent:0,err:"",connecting:false});
  const set=useCallback((k,v)=>setState(p=>({...p,[k]:v})),[]);
  const peerRef=useRef(null);
  const connRef=useRef(null);
  const reconnectTimer=useRef(null);
  const manualClose=useRef(false);
  useEffect(()=>{storeSet(STORE.code,code);},[code]);
  useEffect(()=>{storeSet(STORE.state,state);},[state]);

  const connect=()=>{
    if(code.length!==4)return;
    manualClose.current=false;
    setStatus(s=>({...s,err:"",connecting:true}));
    try{if(peerRef.current&&!peerRef.current.destroyed)peerRef.current.destroy();}catch(e){}
    const peer=new Peer();
    peerRef.current=peer;
    const attach=()=>{
      if(manualClose.current||peer.destroyed)return;
      const conn=peer.connect(PEER_PREFIX+code,{reliable:true,serialization:"json"});
      connRef.current=conn;
      conn.on("open",()=>{setJoined(true);setStatus(s=>({...s,connecting:false,err:""}));try{conn.send({...state,_ts:Date.now()});}catch(e){}});
      conn.on("close",()=>{setJoined(false);setStatus(s=>({...s,connecting:true,err:"연결 복구 중..."}));clearTimeout(reconnectTimer.current);reconnectTimer.current=setTimeout(attach,1200);});
      conn.on("error",err=>{setStatus(s=>({...s,err:String(err&&err.type||err),connecting:true}));clearTimeout(reconnectTimer.current);reconnectTimer.current=setTimeout(attach,1600);});
    };
    peer.on("open",attach);
    peer.on("disconnected",()=>{try{peer.reconnect();}catch(e){}});
    peer.on("error",err=>setStatus(s=>({...s,err:String(err&&err.type||err),connecting:false})));
  };

  useEffect(()=>{
    if(!joined||!connRef.current)return;
    try{
      connRef.current.send({...state,_ts:Date.now()});
      setStatus(s=>({...s,lastSent:Date.now(),err:""}));
    }catch(e){setStatus(s=>({...s,err:String(e&&e.message||e)}));}
  },[state,joined]);

  useEffect(()=>{
    const iv=setInterval(()=>{
      const c=connRef.current;
      if(c&&c.open){try{c.send({_heartbeat:true,_ts:Date.now()});setStatus(s=>({...s,lastSent:Date.now()}));}catch(e){}}
    },1000);
    const resume=()=>{
      if(code.length!==4)return;
      const p=peerRef.current,c=connRef.current;
      if(c&&c.open)return;
      if(p&&!p.destroyed&&p.open){
        try{const nc=p.connect(PEER_PREFIX+code,{reliable:true,serialization:"json"});connRef.current=nc;nc.on("open",()=>{setJoined(true);setStatus(s=>({...s,connecting:false,err:""}));nc.send({...state,_ts:Date.now()});});nc.on("close",()=>setJoined(false));}catch(e){}
      }else if(!status.connecting)connect();
    };
    window.addEventListener("online",resume);window.addEventListener("focus",resume);document.addEventListener("visibilitychange",resume);
    setTimeout(resume,50);
    return()=>{manualClose.current=true;clearInterval(iv);clearTimeout(reconnectTimer.current);window.removeEventListener("online",resume);window.removeEventListener("focus",resume);document.removeEventListener("visibilitychange",resume);try{peerRef.current&&peerRef.current.destroy();}catch(e){}};
  },[]);

  const[,force]=useState(0);
  useEffect(()=>{const iv=setInterval(()=>force(x=>x+1),1000);return()=>clearInterval(iv);},[]);
  const secsAgo=status.lastSent?Math.round((Date.now()-status.lastSent)/1000):null;

  if(!joined){
    return(
      <div style={{background:"#000",height:"100vh",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:16,padding:24,fontFamily:"monospace"}}>
        <div style={{color:"#4dcc4d",fontSize:14,fontWeight:"bold"}}>📱 Operator — Monitor 기기의 코드를 입력하세요</div>
        <input value={code} onChange={e=>setCode(e.target.value.replace(/\D/g,"").slice(0,4))} placeholder="1234" inputMode="numeric" style={{fontSize:32,letterSpacing:8,textAlign:"center",width:180,padding:"10px 0",background:"#111",border:"2px solid #333",color:"#4dcc4d",borderRadius:8,fontFamily:"monospace"}}/>
        <button onClick={connect} disabled={code.length!==4||status.connecting} style={{padding:"12px 28px",background:code.length===4?"#0c2a0c":"#111",border:`2px solid ${code.length===4?"#2fbf2f":"#222"}`,color:code.length===4?"#4dff4d":"#444",borderRadius:8,fontSize:14,fontWeight:"bold",cursor:code.length===4?"pointer":"not-allowed",fontFamily:"monospace"}}>{status.connecting?"연결 중...":"연결"}</button>
        {status.err&&<div style={{color:"#FF5555",fontSize:12}}>⚠ {status.err}</div>}
      </div>
    );
  }
  return(
    <div style={{background:"#000",height:"100vh",display:"flex",flexDirection:"column",overflow:"hidden"}}>
      <div style={{background:"#0d1a0d",color:"#4dcc4d",textAlign:"center",padding:"5px 0",fontSize:12,fontFamily:"monospace",fontWeight:"bold",flexShrink:0}}>
        📱 OPERATOR — 코드 {code}
        {" · "}{status.err?<span style={{color:"#FF5555"}}>⚠ 전송 실패: {status.err}</span>:secsAgo===null?"전송 대기 중...":<span style={{color:"#4dcc4d"}}>마지막 전송 {secsAgo}s 전</span>}
      </div>
      <Panel state={state} onChange={set} open={true} toggle={()=>{}} fullScreen/>
    </div>
  );
}

function SoloHost(){
  const[state,setState]=useState(INIT);
  const ct=useRef(null);
  const set=useCallback((k,v)=>setState(p=>({...p,[k]:v})),[]);
  const charge=()=>{set("dc",{...state.dc,charging:true,charged:false});if(ct.current)clearTimeout(ct.current);ct.current=setTimeout(()=>setState(p=>({...p,dc:{...p.dc,charging:false,charged:true}})),2800);};
  const shock=()=>{setState(p=>({...p,dc:{...p.dc,charged:false,shockDelivered:true,shockCount:p.dc.shockCount+1}}));setTimeout(()=>setState(p=>({...p,dc:{...p.dc,shockDelivered:false}})),3500);};
  return <div style={{background:"#000",height:"100vh",display:"flex",flexDirection:"column",overflow:"hidden"}}><SimDisplay state={state} set={set} charge={charge} shock={shock}/></div>;
}

export default function App(){
  const[role,setRoleState]=useState(()=>storeGet(STORE.role,null));
  const setRole=r=>{storeSet(STORE.role,r);setRoleState(r);};
  if(role==="monitor")return <MonitorHost/>;
  if(role==="operator")return <OperatorHost/>;
  if(role==="solo")return <SoloHost/>;
  return <RoleSelect onPick={setRole}/>;
}
