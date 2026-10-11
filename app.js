// Lapboard: cyclocross lap timing and results.
// Three modes, picked from the address:
//   #/            public results (anyone)
//   #/admin       organiser, signed in with Google (series, riders, races, review, publish)
//   #/t/RACE/KEY  timekeeper link (check-in and timing for one race, no account)
const DEDUP_MS = 20000;            // two taps on one rider closer than this count once
const DEFAULT_POINTS = [25,20,16,13,11,10,9,8,7,6,5,4,3,2,1];
const CATS = {M:"Men", F:"Women"};
// Race fields that change during a race live in races/RACE/live/KEY, which timekeepers can write.
const LIVE_FIELDS = new Set(["startAt","status","targetLaps","lapsFrom","checkedIn","dnf","durationMin","newRiders"]);
// Riders a timekeeper registers go in the live doc (newRiders) until an organiser's app copies them into the series.

let backend=null, db=null, canWrite=false;
let mode="public", isAdmin=null, authUser=null, tkKey=null, loaded=false, seriesLoaded=false;
const series={}, races={}, keys={}, lives={}, liveUnsubs={};
let tapDocs={};                    // deviceId -> {device, taps:[]}
let tapsUnsub=null, tapsRaceId=null, keysUnsub=null, orgUnsub=null;
let organisers={emails:[]}, ownerEmails=[];
const openDetails={};              // keeps <details> sections open across re-renders
document.addEventListener("toggle",e=>{ if(e.target.id) openDetails[e.target.id]=e.target.open },true);
let view={screen:"home", seriesId:null, raceId:null, tab:null};
let ownTaps=[], ownRemoved=new Set(), ownDirty=false, ownFlushing=false;
let timingKey="", stripKey="", dnfMode=false, armed=null, armTimer=null;
const pendingRace={};              // raceId -> fields not yet written
const qs={};                       // per-path write queues

const deviceId=(()=>{let id=null;try{id=localStorage.getItem("lb-device")}catch(e){}
  if(!id){id="d"+Math.random().toString(36).slice(2,9);try{localStorage.setItem("lb-device",id)}catch(e){}}return id})();
let myFilter=(()=>{try{return localStorage.getItem("lb-filter")||"all"}catch(e){return "all"}})();

/* ---------- helpers ---------- */
const $=s=>document.querySelector(s);
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const uid=()=>Math.random().toString(36).slice(2,10);
function fmt(ms){ if(ms==null||isNaN(ms))return "–"; const neg=ms<0; ms=Math.abs(Math.round(ms/1000));
  const h=Math.floor(ms/3600), m=Math.floor(ms%3600/60), s=ms%60;
  return (neg?"−":"")+(h?h+":"+String(m).padStart(2,"0"):m)+":"+String(s).padStart(2,"0"); }
const median=a=>{if(!a.length)return null;const b=[...a].sort((x,y)=>x-y),m=b.length>>1;return b.length%2?b[m]:(b[m-1]+b[m])/2};
const mean=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:null;
function toast(msg){const t=$("#toast");t.textContent=msg;t.hidden=false;clearTimeout(toast.t);toast.t=setTimeout(()=>t.hidden=true,1800)}
function buzz(){try{navigator.vibrate&&navigator.vibrate(25)}catch(e){}}
function enqueue(path,fn){qs[path]=(qs[path]||Promise.resolve()).then(fn).catch(e=>{console.error(e);
  if(e&&e.code==="permission-denied")toast(mode==="tk"?"This timekeeper link no longer works. Ask the organiser for a new one":"You don't have permission to change this");
  else toast("Couldn't save. Check your signal and try again")});return qs[path]}
const keyFor=rid=>mode==="tk"?(view.raceId===rid?tkKey:null):keys[rid]||null;
const livePath=rid=>`races/${rid}/live/${keyFor(rid)}`;
function getRace(id){const r=races[id];return r?{...r,...(lives[id]||{}),...(pendingRace[id]||{}),id}:null}
function setRace(id,fields){pendingRace[id]={...(pendingRace[id]||{}),...fields};
  enqueue("races/"+id,async()=>{const f=pendingRace[id];if(!f)return;delete pendingRace[id];
    const live={},rest={}; for(const k in f)(LIVE_FIELDS.has(k)?live:rest)[k]=f[k];
    if(Object.keys(live).length){ if(!keyFor(id))throw new Error("no key for race"); await db.doc(livePath(id)).update(live) }
    if(Object.keys(rest).length) await db.doc("races/"+id).update(rest);
  });render()}
function nextName(n){ const m=String(n).match(/^(.*?)(\d+)(\D*)$/); return m?m[1]+(+m[2]+1)+m[3]:n+" (copy)" }
function seriesName(s){return s?s.name:"Series"}
function ridersOf(s){return Object.entries((s&&s.riders)||{}).map(([id,r])=>({id,...r})).sort((a,b)=>a.num-b.num)}
function arm(key,fn){ if(armed===key){armed=null;clearTimeout(armTimer);fn();return;}
  armed=key;clearTimeout(armTimer);armTimer=setTimeout(()=>{armed=null;render()},3500);render(); }
const armLabel=(key,label,armedLabel)=>armed===key?armedLabel:label;

/* ---------- race maths ---------- */
function allTapsFor(race){
  const out=[]; const removed=new Set(((race.edits||{}).removed)||[]);
  for(const [docId,d] of Object.entries(tapDocs)){
    const list = docId===deviceId ? ownTaps : (d.taps||[]);
    for(const t of list) if(!removed.has(t.id)) out.push(t);
  }
  if(tapDocs[deviceId]===undefined) for(const t of ownTaps) if(!removed.has(t.id)) out.push(t);
  for(const t of ((race.edits||{}).added||[])) if(!removed.has(t.id)) out.push({...t,added:true});
  return out;
}
function compute(race, s, now){
  const start=race.startAt, riders=(s&&s.riders)||{};
  const ids=new Set(race.checkedIn||[]);
  const taps=start?allTapsFor(race):[];
  for(const t of taps) if(riders[t.r]) ids.add(t.r);
  const by={}; ids.forEach(id=>{ if(riders[id]) by[id]=[] });
  for(const t of taps){ if(t.t<start||!by[t.r])continue; by[t.r].push(t) }
  const R={};
  for(const id in by){
    const list=by[id].sort((a,b)=>a.t-b.t), cr=[], dupes=[];
    for(const t of list){ if(cr.length&&t.t-cr[cr.length-1].t<DEDUP_MS) dupes.push(t); else cr.push(t) }
    R[id]={id, rider:riders[id], all:cr, dupes};
  }
  let finishAt=null;
  if(race.targetLaps){ for(const id in R){const c=R[id].all; if(c.length>=race.targetLaps){const t=c[race.targetLaps-1].t; if(finishAt==null||t<finishAt)finishAt=t}} }
  const firstLaps=[];
  for(const id in R){
    const x=R[id]; let counted=x.all, fin=false, finishT=null;
    if(finishAt!=null){const i=x.all.findIndex(c=>c.t>=finishAt); if(i>=0){counted=x.all.slice(0,i+1);fin=true;finishT=x.all[i].t}}
    x.cr=counted; x.laps=counted.length; x.fin=fin; x.finishT=finishT;
    x.lapTimes=counted.map((c,i)=>c.t-(i?counted[i-1].t:start));
    x.last=x.laps?counted[x.laps-1].t:start;
    x.dnf=(race.dnf||[]).includes(id);
    if(x.laps) firstLaps.push(x.lapTimes[0]);
  }
  const fl=median(firstLaps);
  for(const id in R){ const x=R[id];
    x.avg = x.laps>=2 ? median(x.lapTimes.slice(1)) : x.laps===1 ? x.lapTimes[0]*0.95 : fl;
    x.expected = x.avg!=null ? x.last + x.avg : null;
    x.overdue = !x.fin && !x.dnf && x.avg!=null && now - x.last > x.avg*1.4 && x.laps>0;
  }
  let leader=null;
  for(const id in R){const x=R[id]; if(!x.laps)continue; if(!leader||x.laps>leader.laps||(x.laps===leader.laps&&x.last<leader.last))leader=x}
  // Lap count: worked out once from the leader's 2nd lap (the start sprint skews lap 1), then locked in race.targetLaps
  let pred=null;
  const D=(race.durationMin||45)*60000;
  if(leader&&start&&leader.laps>=2){
    const lt=leader.lapTimes, lap2=lt[1], e2=leader.cr[1].t-start;
    let best=null;
    for(let N=2;N<=80;N++){const proj=e2+(N-2)*lap2; if(!best||Math.abs(proj-D)<Math.abs(best.proj-D))best={N,proj}}
    const recent=lt.length>=2?mean(lt.slice(Math.max(1,lt.length-3))):lt[0];
    pred={lap2, N:Math.max(best.N,leader.laps+1), recent};
  }
  return {R, leader, finishAt, pred, start};
}
function flagsFor(x){
  const out=[]; const lt=x.lapTimes; if(lt.length<3)return out;
  const med=median(lt.slice(1));
  lt.forEach((v,i)=>{ const ref=i===0?med*1.1:med;
    if(v>ref*1.65) out.push({type:"missed",lap:i,at:(i?x.cr[i-1].t:null),insertT:Math.round((i?x.cr[i-1].t:x.cr[0].t-v)+v/2)});
    else if(i>0&&v<med*0.5) out.push({type:"short",lap:i,tapId:x.cr[i].id});
  });
  return out;
}
function rankings(race,s,now){
  const c=compute(race,s,now); const done=race.status==="done"||race.status==="published";
  const out={};
  for(const cat of Object.keys(CATS)){
    const xs=Object.values(c.R).filter(x=>x.rider.cat===cat);
    const fin=xs.filter(x=>x.fin&&!x.dnf).sort((a,b)=>b.laps-a.laps||a.finishT-b.finishT);
    const run=xs.filter(x=>!x.fin&&!x.dnf&&x.laps>0).sort((a,b)=>b.laps-a.laps||a.last-b.last);
    const dnf=xs.filter(x=>x.dnf).sort((a,b)=>b.laps-a.laps||a.last-b.last);
    const dns=xs.filter(x=>!x.dnf&&!x.fin&&x.laps===0).sort((a,b)=>a.rider.num-b.rider.num);
    const win=fin[0]||run[0];
    const rows=[]; let pos=0;
    for(const x of [...fin,...run]){ pos++;
      const behind=win?win.laps-x.laps:0; const t=(x.fin?x.finishT:x.last)-c.start;
      const gap=!win||x===win?"":behind?`−${behind} lap${behind>1?"s":""}`:"+"+fmt(t-((win.fin?win.finishT:win.last)-c.start));
      rows.push({x,pos:String(pos),status:x.fin?"fin":(done?"nofin":"run"),laps:x.laps,behind,time:t,gap});
    }
    for(const x of dnf) rows.push({x,pos:"DNF",status:"dnf",laps:x.laps,behind:null,time:null,gap:""});
    for(const x of dns) rows.push({x,pos:"DNS",status:"dns",laps:0,behind:null,time:null,gap:""});
    out[cat]=rows;
  }
  return {c,out};
}

/* ---------- own tap writes ---------- */
function flushOwn(){ ownDirty=true; if(ownFlushing||!view.raceId)return; const rid=view.raceId;
  ownFlushing=true;
  (async()=>{ try{ while(ownDirty){ ownDirty=false;
      await db.doc(livePath(rid)+"/taps/"+deviceId).set({device:deviceId, taps:ownTaps}); } }
    catch(e){ console.error(e); toast("Tap not saved yet. Retrying…"); setTimeout(()=>{ownFlushing=false;flushOwn()},3000); return; }
    ownFlushing=false; })();
}
function tap(riderId){
  const race=getRace(view.raceId), s=series[race.seriesId];
  if(dnfMode){ toggleDnf(riderId); dnfMode=false; render(); return; }
  const t={id:deviceId+"-"+uid(), r:riderId, t:Date.now()};
  ownTaps=[...ownTaps,t]; flushOwn(); buzz();
  const c=compute(race,s,Date.now()), x=c.R[riderId];
  const r=s.riders[riderId];
  toast(x&&x.dupes.some(d=>d.id===t.id)?`#${r.num} already counted`:x&&x.fin&&x.finishT===t.t?`#${r.num} finished`:`#${r.num} lap ${x?x.laps:"?"}`);
  const b=document.querySelectorAll(`[data-tap="${riderId}"]`); b.forEach(el=>{el.classList.add("flash");setTimeout(()=>el.classList.remove("flash"),180)});
  liveUpdate();
}
function undoTap(id){ ownTaps=ownTaps.filter(t=>t.id!==id); ownRemoved.add(id); flushOwn(); liveUpdate(); toast("Tap removed") }
function toggleDnf(id){ const race=getRace(view.raceId); const d=new Set(race.dnf||[]); d.has(id)?d.delete(id):d.add(id);
  setRace(race.id,{dnf:[...d]}); const r=series[race.seriesId].riders[id]; toast(`#${r.num} ${d.has(id)?"marked DNF":"back in the race"}`) }

/* ---------- subscriptions ---------- */
function subTaps(raceId){
  if(tapsRaceId===raceId)return;
  if(tapsUnsub)tapsUnsub(); tapDocs={}; ownTaps=[]; ownRemoved=new Set(); tapsRaceId=raceId;
  if(!keyFor(raceId)){ tapsRaceId=null; return }
  tapsUnsub=db.collection(livePath(raceId)+"/taps").onSnapshot(snap=>{
    const next={};
    snap.docs.forEach(d=>{ next[d.id]=d.data() });
    const mine=next[deviceId];
    if(mine){ const have=new Set(ownTaps.map(t=>t.id)); const add=(mine.taps||[]).filter(t=>!have.has(t.id)&&!ownRemoved.has(t.id));
      if(add.length) ownTaps=[...ownTaps,...add].sort((a,b)=>a.t-b.t); }
    tapDocs=next; onData();
  },e=>console.error(e));
}
function mergeNewRiders(){
  for(const rid in races){ const race=getRace(rid), nr=race&&race.newRiders, s=race&&series[race.seriesId];
    if(!nr||!nr.length||!s) continue;
    const missing=nr.filter(r=>!(s.riders||{})[r.id]);
    if(missing.length){ const add={}; missing.forEach(r=>add[r.id]={name:r.name,num:r.num,cat:r.cat});
      series[race.seriesId]={...s,riders:{...add,...(s.riders||{})}};
      if(admin()) enqueue("series/"+race.seriesId,()=>db.doc("series/"+race.seriesId).update({riders:add})); }
    if(admin()&&keyFor(rid)&&!pendingRace[rid]?.newRiders) { const path=livePath(rid); enqueue("series/"+race.seriesId,()=>db.doc(path).update({newRiders:[]})); lives[rid]={...(lives[rid]||{}),newRiders:[]}; }
  }
}
function onData(){ mergeNewRiders(); if(view.screen==="race"&&view.tab==="timing"&&$("#grid")){ if(timingRenderKey()!==timingKey)render(); else liveUpdate(); } else render(); }

/* ---------- navigation ---------- */
const admin=()=>mode==="admin"&&isAdmin===true;
// Navigation uses the browser history, so the phone's back gesture and the browser's
// back and forward buttons move between screens and tabs.
const NAV_KEYS=["screen","seriesId","raceId","tab","back","editRider"];
const navState=()=>{ const o={}; NAV_KEYS.forEach(k=>o[k]=view[k]??null); return o };
const navHash=()=>mode!=="public"?location.hash:view.screen==="race"?"#/r/"+view.raceId:view.screen==="series"?"#/s/"+view.seriesId:view.screen==="help"?"#/help"+(view.tab?"/"+view.tab:""):view.screen==="find"?"#/find":"#/";
let navDepth=0;
function go(v,opts={}){ const before=JSON.stringify(navState());
  view={...view,madeLogin:null,editRider:null,...v}; armed=null; dnfMode=false;
  if(!opts.fromHistory&&JSON.stringify(navState())!==before){
    const h=navHash();
    if(opts.replace) history.replaceState({lb:navState(),depth:navDepth},"",h);
    else { navDepth++; history.pushState({lb:navState(),depth:navDepth},"",h); } }
  if(view.screen==="race"&&view.raceId){ subLive(view.raceId); subTaps(view.raceId); }
  if(!opts.keepScroll) window.scrollTo(0,0); render(); }
window.addEventListener("popstate",e=>{ const st=e.state; if(!st||!st.lb)return;
  navDepth=st.depth||0; go(st.lb,{fromHistory:true}); });

/* ---------- render ---------- */
function header(crumbs,title,right,tabs){
  return `<div class="top"><div class="crumbs">${navDepth>0?`<button class="navback" data-act="navback" aria-label="Back">‹ Back</button><span class="sep" aria-hidden="true">·</span>`:""}${crumbs.map(c=>c.go?`<button data-go='${esc(JSON.stringify(c.go))}'>${esc(c.label)}</button>`:`<span>${esc(c.label)}</span>`).join("<span>/</span>")}</div>
  <div class="titlerow"><h1>${esc(title)}</h1>${right||""}</div>
  ${tabs?`<div class="tabs" role="tablist">${tabs.map(t=>`<button data-tab="${t.id}" aria-current="${view.tab===t.id}">${t.label}</button>`).join("")}</div>`:""}</div>`;
}
function render(){
  const app=$("#app");
  if(!db){ app.innerHTML=`<div class="stack"><h1>Lapboard</h1><div class="card"><p>Lapboard isn't connected to its database yet. Add the Firebase settings to <code>config.js</code>.</p></div></div>`;return }
  if(mode==="admin"&&isAdmin!==true){ app.innerHTML=renderSignIn(); return }
  if(mode==="tk"&&(!races[view.raceId]||lives[view.raceId]===null||!lives[view.raceId]||!series[races[view.raceId].seriesId])){ app.innerHTML=`<div class="signin card"><h1>Timekeeper link</h1><p>${lives[view.raceId]===null||(loaded&&!races[view.raceId])?"This link isn't valid any more. Ask the organiser to send you a new one.":"Loading the race…"}</p></div>`; return }
  if(!loaded||!seriesLoaded){ app.innerHTML=`<div class="empty" style="margin-top:40vh">Loading…</div>`; return }
  if(view.screen==="series"&&(!series[view.seriesId]||(series[view.seriesId].archived&&!admin()))) view.screen="home";
  if(view.screen==="race"&&races[view.raceId]&&races[view.raceId].archived&&mode==="public") view.screen="home";
  if(view.screen==="race"&&!races[view.raceId]) view.screen=view.seriesId&&series[view.seriesId]?"series":"home";
  timingKey="";
  if(view.screen==="help") app.innerHTML=renderHelp();
  else if(view.screen==="home") app.innerHTML=renderHome();
  else if(view.screen==="orgs") app.innerHTML=admin()?renderOrgs():renderHome();
  else if(view.screen==="series") app.innerHTML=renderSeries();
  else if(view.screen==="find") app.innerHTML=renderFind();
  else app.innerHTML=renderRace();
  app.insertAdjacentHTML("beforeend",footer());
  if(view.screen==="race"&&view.tab==="timing") { timingKey=timingRenderKey(); stripKey=""; liveUpdate(); }
}
function renderHome(){
  const list=Object.entries(series).filter(([,s])=>!s.archived).sort((a,b)=>(b[1].createdAt||0)-(a[1].createdAt||0));
  return header([{label:admin()?"Lapboard · organiser":"Lapboard"}],admin()?"Your series":"Race results",admin()?`<button class="btn sm" data-go='${esc(JSON.stringify({screen:"orgs"}))}'>Organisers</button>`:null)+`<div class="stack">
  ${list.length?`<div class="card list">${list.map(([id,s])=>{const n=Object.keys(s.riders||{}).length, rc=Object.values(races).filter(r=>r.seriesId===id&&!r.archived&&(admin()||r.published)).length;
    return `<div class="item"><button class="link grow" data-go='${esc(JSON.stringify({screen:"series",seriesId:id,tab:"races"}))}'>
      <div style="font-family:var(--display);font-size:21px;font-weight:700">${esc(s.name)}</div>
      <div class="small muted">${s.kind==="oneday"?"One-day race":"Series"} · ${n} riders · ${rc} race${rc===1?"":"s"}</div></button>
      <span class="muted" aria-hidden="true">›</span></div>`}).join("")}</div>`
    :`<div class="card empty">${admin()?"No series yet. Create one below, for example “Biscuit Cup 2026”.":"No results yet."}</div>`}
  <div class="row"><button class="btn" data-go='${esc(JSON.stringify({screen:"find"}))}'>Find a rider</button></div>
  ${admin()?`<form class="card" id="newSeries"><h2>New series or one-day race</h2>
    <div class="row" style="margin-top:10px;align-items:flex-end">
      <label class="f">Name<input type="text" id="ns-name" required placeholder="Die Goldene Ananas 2026"></label>
      <label class="f" style="flex:0 1 170px">Type<select id="ns-kind"><option value="series">Series (several races)</option><option value="oneday">One-day race</option></select></label>
      ${list.length?`<label class="f" style="flex:0 1 220px">Riders<select id="ns-copy"><option value="">Start with no riders</option>${list.map(([id,s])=>`<option value="${id}">Copy riders from ${esc(s.name)}</option>`).join("")}</select></label>`:""}
      <button class="btn primary" type="submit">Create</button></div></form>`:""}
  ${admin()?`<div class="row"><button class="btn sm ghost" data-act="example">Add an example series to practise with</button></div>`:""}
  ${admin()?renderArchive():""}
  </div>`;
}
// Riders are matched across series by name, so someone keeps one history even with different numbers.
const personKey=n=>String(n||"").trim().toLowerCase().replace(/\s+/g," ");
function renderFind(){
  const q=personKey(view.fq), people={};
  if(q) for(const rid of Object.keys(races)){ const r=getRace(rid), s=series[r.seriesId];
    if(!r.published||r.archived||!s||s.archived) continue;
    for(const cat in r.published.rows) for(const row of r.published.rows[cat]){
      if(!personKey(row.name).includes(q)&&String(row.num)!==q) continue;
      const k=personKey(row.name); (people[k]=people[k]||{name:row.name,res:[]}).res.push({rid,race:r,s,cat,row}) } }
  const list=Object.values(people).sort((a,b)=>a.name.localeCompare(b.name));
  list.forEach(p=>p.res.sort((a,b)=>String(b.race.date).localeCompare(String(a.race.date))));
  const wins=p=>p.res.filter(x=>x.row.pos==="1").length;
  return header([{label:"Lapboard",go:{screen:"home"}}],"Find a rider")+`<div class="stack">
  <input type="text" id="find-q" placeholder="Type a name or number" value="${esc(view.fq||"")}" autocomplete="off">
  ${!q?`<p class="note">Search every published result, across all series and one-day races.</p>`:list.length?list.slice(0,30).map(p=>`<div class="card"><div class="spread"><h2>${esc(p.name)}</h2><span class="small muted">${p.res.length} race${p.res.length===1?"":"s"} · ${wins(p)} win${wins(p)===1?"":"s"}</span></div>
    <div class="tbl-wrap"><table><thead><tr><th>Race</th><th>Pos</th><th class="r">Gap</th></tr></thead><tbody>
    ${p.res.map(x=>`<tr><td><button class="link" style="text-align:left" data-go='${esc(JSON.stringify({screen:"race",raceId:x.rid,seriesId:x.race.seriesId,tab:"results"}))}'><b>${esc(x.race.name)}</b><div class="small muted">${esc(x.s.name)} · ${esc(x.race.date||"")} · ${CATS[x.cat]} · #${x.row.num}</div></button></td><td class="pos">${esc(x.row.pos)}</td><td class="r t">${esc(x.row.gap)}</td></tr>`).join("")}
    </tbody></table></div></div>`).join(""):`<div class="card empty">No published results match “${esc(view.fq)}”.</div>`}
  </div>`;
}
function renderArchive(){
  const as=Object.entries(series).filter(([,s])=>s.archived);
  const ar=Object.entries(races).filter(([,r])=>r.archived&&series[r.seriesId]&&!series[r.seriesId].archived);
  if(!as.length&&!ar.length) return "";
  const row=(label,sub,restore,del,delKey)=>`<div class="item"><div class="grow"><div style="font-weight:600">${esc(label)}</div><div class="small muted">${esc(sub)}</div></div>
    <button class="btn sm" ${restore}>Restore</button><button class="btn sm ${armed===delKey?"arm":"danger"}" ${del}>${armLabel(delKey,"Delete forever","Tap again")}</button></div>`;
  return `<details class="card" id="d-archive" ${openDetails["d-archive"]?"open":""}><summary style="cursor:pointer"><h3 style="display:inline">Archive (${as.length+ar.length})</h3></summary><div class="list" style="margin-top:8px">
    ${as.map(([id,s])=>row(s.name,`Series · ${Object.values(races).filter(r=>r.seriesId===id).length} races`,`data-restoreseries="${id}"`,`data-delseries="${id}"`,"delseries-"+id)).join("")}
    ${ar.map(([rid,r])=>row(r.name,`${series[r.seriesId].name} · ${r.date||""}`,`data-restorerace="${rid}"`,`data-delrace="${rid}"`,"delrace-"+rid)).join("")}
  </div></details>`;
}
const loginDomain=()=>(backend&&backend.loginDomain)||"";
const isUsername=e=>!!loginDomain()&&e.endsWith("@"+loginDomain());
const displayLogin=e=>isUsername(e)?e.slice(0,-(loginDomain().length+1)):e;
function renderOrgs(){
  const me=(authUser&&authUser.email||"").toLowerCase(), owner=ownerEmails.includes(me);
  const list=(organisers.emails||[]);
  const made=view.madeLogin;
  return header([{label:"Lapboard",go:{screen:"home"}}],"Organisers",null)+`<div class="stack">
  <div class="card"><p class="note" style="margin-bottom:8px">Organisers can manage series, riders, races and results.</p>
  <div class="list">${ownerEmails.map(e=>`<div class="item"><div class="grow">${esc(e)}</div><span class="pill">Owner</span></div>`).join("")}
  ${list.map(e=>`<div class="item"><div class="grow">${esc(displayLogin(e))}</div><span class="pill">${isUsername(e)?"Username":"Google"}</span>${owner?`<button class="btn sm ${armed==="rmorg-"+e?"arm":"ghost"}" data-rmorg="${esc(e)}">${armLabel("rmorg-"+e,"Remove","Confirm")}</button>`:""}</div>`).join("")}</div></div>
  ${made?`<div class="card" style="border-color:var(--ok)"><h2>Login created</h2><p class="note" style="margin:6px 0 10px">Send these to ${esc(made.username)}. They sign in at the organiser page. You won't be able to see the password again.</p>
    <div class="linkbox"><code>${esc(made.text)}</code><button class="btn sm primary" data-act="sharelogin">Share</button><button class="btn sm" data-act="copylogin">Copy</button></div></div>`:""}
  ${owner?`<form class="card" id="addLogin"><h2>Create a username and password</h2><p class="note" style="margin:6px 0 10px">For organisers who don't want to use a Google account.</p>
    <div class="row" style="align-items:flex-end">
    <label class="f">Username<input type="text" id="lg-user" required autocomplete="off" autocapitalize="none" placeholder="sam"></label>
    <label class="f">Password<input type="text" id="lg-pass" required autocomplete="off" minlength="8" value="${esc(suggestPassword())}"></label>
    <button class="btn primary" type="submit">Create login</button></div></form>
  <form class="card" id="addOrg"><h2>Add a Google account</h2><div class="row" style="margin-top:10px;align-items:flex-end">
    <label class="f">Their Google account email<input type="email" id="org-email" required autocomplete="off" placeholder="friend@gmail.com"></label>
    <button class="btn primary" type="submit">Add</button></div></form>
  <p class="note">Organisers sign in at ${esc(location.origin+location.pathname)}#/admin</p>`
    :`<p class="note">Only the owner can add or remove organisers.</p>`}
  </div>`;
}
function suggestPassword(){ if(!suggestPassword.v){ const w=["mud","crank","spoke","bell","cowbell","barrier","sandpit","frites","wafel","knobby","flyover","runup","plank","tubular"];
  const r=n=>crypto.getRandomValues(new Uint32Array(1))[0]%n; suggestPassword.v=w[r(w.length)]+"-"+w[r(w.length)]+"-"+(100+r(900)); } return suggestPassword.v }
function renderSeries(){
  const s=series[view.seriesId], id=view.seriesId;
  const tabs=[{id:"races",label:"Races"},{id:"riders",label:"Riders"},{id:"standings",label:s.kind==="oneday"?"Results":"Standings"}];
  if(admin()) tabs.push({id:"settings",label:"Settings"});
  if(!tabs.some(t=>t.id===view.tab)) view.tab="races";
  let body="";
  const rl=Object.entries(races).filter(([,r])=>r.seriesId===id&&!r.archived&&(admin()||r.published)).sort((a,b)=>String(a[1].date).localeCompare(String(b[1].date)));
  if(view.tab==="races"){
    body=`${rl.length?`<div class="card list">${rl.map(([rid,r])=>{r=getRace(rid);
      const st=!admin()?"":r.status==="running"?`<span class="pill live">Racing</span>`:r.status==="done"?`<span class="pill warn">To review</span>`:r.status==="published"?`<span class="pill ok">Published</span>`:`<span class="pill">Not started</span>`;
      return `<div class="item"><button class="link grow" data-go='${esc(JSON.stringify({screen:"race",raceId:rid,tab:r.status==="published"||!admin()?"results":r.status==="done"?"review":r.status==="running"?"timing":"checkin"}))}'>
        <div style="font-weight:600">${esc(r.name)}</div><div class="small muted">${esc(r.date||"")}${admin()?` · ${r.durationMin||45} min · ${(r.checkedIn||[]).length} checked in`:""}</div></button>${st}</div>`}).join("")}</div>`
      :`<div class="card empty">${admin()?"No races yet.":"No published results yet."}</div>`}
    ${admin()?`<form class="card" id="newRace"><h2>Add a race</h2><div class="row" style="margin-top:10px;align-items:flex-end">
      <label class="f">Name<input type="text" id="nr-name" required value="Round ${rl.length+1}"></label>
      <label class="f" style="flex:0 1 150px">Date<input type="date" id="nr-date" value="${new Date().toISOString().slice(0,10)}"></label>
      <label class="f" style="flex:0 1 100px">Minutes<input type="number" id="nr-min" min="5" max="180" value="45"></label>
      <button class="btn primary" type="submit">Add race</button></div></form>`:""}`;
  } else if(view.tab==="riders"){
    const rs=ridersOf(s);
    body=`${admin()?riderForm("addRider","Register a rider",s):""}
    <div class="card"><div class="spread"><h3>${rs.length} registered</h3><span class="small muted">${rs.filter(r=>r.cat==="M").length} men · ${rs.filter(r=>r.cat==="F").length} women</span></div>
    <div class="list" style="margin-top:6px">${rs.map(r=>view.editRider===r.id?`<form class="item" id="editRider" data-rid="${r.id}" style="flex-wrap:wrap">
        <label class="f" style="flex:0 1 80px">Number<input type="number" id="er-num" min="1" value="${r.num}"></label>
        <label class="f">Name<input type="text" id="er-name" value="${esc(r.name)}" required></label>
        <label class="f" style="flex:0 1 110px">Category<select id="er-cat"><option value="M" ${r.cat==="M"?"selected":""}>Men</option><option value="F" ${r.cat==="F"?"selected":""}>Women</option></select></label>
        <div class="row"><button class="btn sm primary" type="submit">Save</button><button class="btn sm ghost" type="button" data-act="canceledit">Cancel</button>
        <button class="btn sm ${armed==="del-"+r.id?"arm":"danger"}" type="button" data-delrider="${r.id}">${armLabel("del-"+r.id,"Remove rider","Tap again to remove")}</button></div></form>`
      :`<div class="item"><span class="plate-sm">${r.num}</span><div class="grow">${esc(r.name)}</div><span class="pill">${CATS[r.cat]||r.cat}</span>
      ${admin()?`<button class="btn sm ghost" data-editrider="${r.id}">Edit</button>`:""}</div>`).join("")||`<div class="empty">No riders yet.</div>`}</div>
    ${admin()?`<p class="note" style="margin-top:8px">Changes apply to future results. Published results keep the details they were published with until you republish.</p>`:""}</div>`;
  } else if(view.tab==="standings"){
    body=renderStandings(s,id,rl.map(([rid])=>getRace(rid)));
  } else {
    body=`<form class="card" id="seriesSettings"><h2>Settings</h2><div class="stack" style="margin-top:8px">
      <label class="f">Name<input type="text" id="ss-name" value="${esc(s.name)}"></label>
      <label class="f">Points for 1st, 2nd, 3rd… (comma separated, per category)<input type="text" id="ss-points" value="${esc((s.points||DEFAULT_POINTS).join(", "))}"></label>
      <p class="note">Positions beyond the list score 0. DNF and DNS score 0. This is a placeholder table until the series scoring is decided.</p>
      <div><button class="btn primary" type="submit">Save settings</button></div></div></form>
    <form class="card" id="copySeries"><h2>Copy this series</h2><p class="note" style="margin:6px 0 10px">Starts a new series with the same riders, numbers and points table, but no races. Handy for next season.</p>
      <div class="row" style="align-items:flex-end"><label class="f">New name<input type="text" id="cs-name" value="${esc(nextName(s.name))}" required></label><button class="btn primary" type="submit">Copy</button></div></form>
    <div class="card"><h2>Archive</h2><p class="note" style="margin:6px 0 10px">Archived races and series disappear from the lists and public pages. You can restore them from the Archive on the home screen.</p>
      <div class="list">${rl.map(([rid])=>{const r=getRace(rid);return `<div class="item"><div class="grow">${esc(r.name)} <span class="small muted">${esc(r.date||"")}</span></div>
        <button class="btn sm" data-archrace="${rid}">Archive race</button></div>`}).join("")||`<div class="small muted">No races in this series.</div>`}</div>
      <div class="row" style="margin-top:14px"><button class="btn danger" data-archseries="${id}">Archive the whole series</button></div></div>`;
  }
  return header([{label:"Lapboard",go:{screen:"home"}}],s.name,null,tabs)+`<div class="stack">${body}</div>`;
}
function riderForm(fid,title,s){
  const used=new Set(Object.values(s.riders||{}).map(r=>r.num)); let n=1; while(used.has(n))n++;
  return `<form class="card" id="${fid}"><h2>${title}</h2><div class="row" style="margin-top:10px;align-items:flex-end">
    <label class="f">Name<input type="text" id="${fid}-name" required autocomplete="off"></label>
    <label class="f" style="flex:0 1 90px">Number<input type="number" id="${fid}-num" min="1" value="${n}"></label>
    <label class="f" style="flex:0 1 110px">Category<select id="${fid}-cat"><option value="M">Men</option><option value="F">Women</option></select></label>
    <button class="btn primary" type="submit">Add</button></div></form>`;
}
function renderStandings(s,sid,rl){
  const pub=rl.filter(r=>r.published);
  if(!pub.length) return `<div class="card empty">Standings appear here once a race result is published.</div>`;
  const pts=s.points||DEFAULT_POINTS;
  return Object.entries(CATS).map(([cat,label])=>{
    const tot={};
    pub.forEach((r,ri)=>{ (r.published.rows[cat]||[]).forEach(row=>{ const p=/^\d+$/.test(row.pos)?(pts[+row.pos-1]||0):0;
      const t=tot[row.rid]||(tot[row.rid]={rid:row.rid,name:row.name,num:row.num,total:0,per:{}}); t.total+=p; t.per[ri]=p; }) });
    const rows=Object.values(tot).sort((a,b)=>b.total-a.total||a.num-b.num);
    if(!rows.length) return "";
    let last=null,pos=0; rows.forEach((r,i)=>{ if(r.total!==last){pos=i+1;last=r.total} r.pos=pos });
    return `<div class="card"><h2>${label}</h2><div class="tbl-wrap"><table><thead><tr><th>Pos</th><th>Rider</th>${pub.map((r,i)=>`<th class="r" title="${esc(r.name)}">R${i+1}</th>`).join("")}<th class="r">Pts</th></tr></thead><tbody>
    ${rows.map(r=>`<tr><td class="pos">${r.pos}</td><td><span class="plate-sm">${r.num}</span> ${esc(r.name)}</td>${pub.map((_,i)=>`<td class="r t">${r.per[i]??"–"}</td>`).join("")}<td class="r t" style="font-weight:700">${r.total}</td></tr>`).join("")}
    </tbody></table></div></div>`;
  }).join("") + `<p class="note">${pub.length} published race${pub.length>1?"s":""}: ${pub.map((r,i)=>`R${i+1} ${esc(r.name)}`).join(" · ")}</p>`;
}
function renderRace(){
  const race=getRace(view.raceId), s=series[race.seriesId];
  const tabs=admin()?[{id:"checkin",label:"Check-in"},{id:"timing",label:"Timing"},{id:"review",label:"Review"},{id:"results",label:"Results"}]
    :mode==="tk"?[{id:"checkin",label:"Check-in"},{id:"timing",label:"Timing"}]:[{id:"results",label:"Results"}];
  if(!tabs.some(t=>t.id===view.tab)) view.tab=tabs[0].id;
  const crumbs=mode==="tk"?[{label:"Timekeeper"},{label:s.name}]:[{label:"Lapboard",go:{screen:"home"}},{label:s.name,go:{screen:"series",seriesId:race.seriesId,tab:"races"}}];
  let body="";
  if(view.tab==="checkin") body=renderCheckin(race,s);
  else if(view.tab==="timing") body=renderTiming(race,s);
  else if(view.tab==="review") body=renderReview(race,s);
  else body=renderResults(race,s);
  return header(crumbs,race.name,`<span class="small muted">${esc(race.date||"")}${mode==="public"?"":` · ${race.durationMin||45} min`}</span>`,tabs)+body;
}
function tkUrl(race){ return location.origin+location.pathname+"#/t/"+race.id+"/"+keyFor(race.id) }
function tkLinkCard(race){
  if(!keyFor(race.id)) return "";
  return `<div class="card"><div class="spread"><h2>Timekeeper link</h2><span class="small muted">No account needed</span></div>
  <p class="note" style="margin:6px 0 10px">Anyone with this link can check riders in and record laps for this race only. Send it to your helpers by text or WhatsApp.</p>
  <div class="linkbox"><code>${esc(tkUrl(race))}</code><button class="btn sm primary" data-act="sharelink">Share</button><button class="btn sm" data-act="copylink">Copy</button></div>
  <div class="row" style="margin-top:8px"><button class="btn sm ${armed==="rekey"?"arm":"ghost"}" data-act="rekey">${armLabel("rekey","Make a new link (old one stops working)","Tap again to replace the link")}</button></div></div>`;
}
function renderSignIn(){
  if(isAdmin===false&&authUser) return `<div class="signin card stack"><h1>Not an organiser account</h1><p>${esc(displayLogin(authUser.email))} can't manage races. Sign in with an organiser's Google account, or ask an organiser to add you.</p>
    <div class="row" style="justify-content:center"><button class="btn" data-act="signout">Sign out</button><a class="btn ghost" href="#/">Public results</a></div></div>`;
  if(authUser) return `<div class="signin"><p class="muted">Checking your account…</p></div>`;
  return `<div class="signin card stack"><h1>Lapboard organiser</h1><p>Sign in to set up series, register riders, run races and publish results.</p>
    <div class="row" style="justify-content:center"><button class="btn primary" data-act="signin">Sign in with Google</button></div>
    <form id="pwSignin" class="stack" style="gap:8px;text-align:left;border-top:1px solid var(--line);padding-top:14px">
      <span class="small muted">Or with a username from the organiser</span>
      <label class="f">Username<input type="text" id="si-user" autocomplete="username" autocapitalize="none" required></label>
      <label class="f">Password<input type="password" id="si-pass" autocomplete="current-password" required></label>
      <button class="btn dark" type="submit">Sign in</button></form>
    <p class="note"><a href="#/">See public results</a></p></div>`;
}
function footer(){
  const help=t=>`<button class="btn sm ghost" data-go='${esc(JSON.stringify({screen:"help",tab:t,back:{screen:view.screen,tab:view.tab}}))}'>How to use Lapboard</button>`;
  if(mode==="tk") return `<div class="foot">${help("timekeepers")}<span>This phone records as ${esc(deviceId)}</span></div>`;
  if(mode==="admin") return `<div class="foot">${help("organisers")}<span>Signed in as ${esc(authUser&&displayLogin(authUser.email))}</span><button class="btn sm ghost" data-act="signout">Sign out</button><a href="#/">Public view</a></div>`;
  return `<div class="foot">${help("riders")}<a href="#/admin">Organiser sign-in</a></div>`;
}
function renderHelp(){
  const tabs=[{id:"riders",label:"Riders"},{id:"timekeepers",label:"Timekeepers"},{id:"organisers",label:"Organisers"}];
  if(!tabs.some(t=>t.id===view.tab)) view.tab=mode==="tk"?"timekeepers":mode==="admin"?"organisers":"riders";
  const back=view.back&&view.back.screen!=="help"?{...view.back,back:null}:{screen:mode==="tk"?"race":"home",tab:mode==="tk"?"timing":null};
  const step=(title,body)=>`<li><b>${title}</b><br>${body}</li>`;
  const sec=(title,items)=>`<div class="card"><h2>${title}</h2><ol class="help">${items.join("")}</ol></div>`;
  let body="";
  if(view.tab==="riders") body=sec("Finding your results",[
    step("Open the results page","Use the link the organisers share. No account is needed."),
    step("Pick your series and race","Each published race lists Men and Women separately, with your position, total time and gap to the winner."),
    step("Reading the gap","<i>+0:42</i> means you finished on the same lap as the winner, 42 seconds behind. <i>−1 lap</i> means the leader lapped you once. The winner's lap count is shown above each table."),
    step("DNF and DNS","DNF means you started but didn't finish. DNS means you were checked in but never crossed the line."),
    step("Find yourself","Tap <i>Find a rider</i> on the home page and type your name or number to see all your results, across every series."),
    step("Series standings","Open the Standings tab of a series to see points from every published race (R1, R2…) and the running total."),
  ]);
  else if(view.tab==="timekeepers") body=sec("Before the start",[
    step("Open the timekeeper link","The organiser sends it by text or WhatsApp. It works only for that race and needs no account. Tip: add it to your home screen."),
    step("Check riders in","On the Check-in tab, tick everyone who is racing. Only checked-in riders appear on the timing screen. Search by name or number, or tap <i>Check in everyone</i>."),
    step("New rider on the day","Someone not on the list? Use <i>New rider today</i> at the bottom of Check-in. Give them the next free number. They are checked in straight away and kept in the series for next time."),
    step("Two timekeepers? Split the riders","On the Timing tab, each phone picks a group: Men / Women, or Odd # / Even #. Both phones record into the same race."),
    step("Start the race","Tap <i>Start race</i>, then tap again to confirm, as the riders go. Only one phone needs to do this."),
  ])+sec("During the race",[
    step("Tap each number as it crosses the line","A message confirms it, for example <i>#12 lap 3</i>. If both phones tap the same rider within 20 seconds, it only counts once, so double taps are safe."),
    step("Made a mistake?","Tap <i>Undo</i> next to it under <i>Your last taps</i>."),
    step("Watch the Coming up strip","Riders due at the line in the next minute appear at the top, soonest first, so you can tap them there. A dashed outline means a rider is overdue: you may have missed them, or they may have stopped."),
    step("Number of laps and the bell","After the leader's second lap, Lapboard sets the number of laps so the race finishes close to the target time. It tells you when to ring the bell. You can add or remove a lap before the bell."),
    step("Someone stops?","Tap <i>Mark DNF</i>, then tap their number."),
    step("Patchy signal","Keep tapping. Taps are saved on the phone and sent when the signal comes back. The screen stays awake while timing."),
  ])+sec("At the finish",[
    step("The leader finishes","After the leader crosses on the last lap, every rider's next crossing is their finish. The banner counts how many are in. Lapped riders finish on fewer laps."),
    step("End the race","When everyone is in, tap <i>End race</i> twice. The organiser checks the laps and publishes the results."),
  ]);
  else body=sec("Setting up",[
    step("Sign in",`Go to the organiser page (<i>${esc(location.origin+location.pathname)}#/admin</i>) and sign in with your Google account, or with the username and password the owner gave you.`),
    step("Practise first","On the home screen, tap <i>Add an example series to practise with</i>. It has 30 made-up riders, a finished race with three mistakes to fix on the Review tab, and a race ready to time. Archive it when you are done."),
    step("Create a series","For example <i>Biscuit Cup 2026</i>. Choose <i>One-day race</i> for a single event like the Intergalactics."),
    step("Register riders","On the Riders tab, add each rider's name, number and category. Tap <i>Edit</i> next to a rider to fix a name, number or category. Riders keep their number for the whole series."),
    step("Set the points","On the Settings tab, enter the points for 1st, 2nd, 3rd and so on. They apply to Men and Women separately."),
    step("Add a race","On the Races tab, give it a name, date and length in minutes (for example 45)."),
    step("Send the timekeeper link","Open the race. The Check-in tab has a <i>Timekeeper link</i> card. Tap <i>Share</i> to send it. If a link gets passed around, make a new one and the old one stops working."),
  ])+sec("Race day",[
    step("Check-in and timing","You can do these yourself or leave them to your timekeepers. The steps are the same: see the Timekeepers guide."),
    step("New rider on the day","On the Check-in tab, use <i>New rider today</i>. They are added to the series and checked in. Timekeepers can do this too, and their new riders appear in the series as soon as you open Lapboard."),
  ])+sec("After the race",[
    step("Review","The Review tab shows every rider's laps and flags anything odd. <i>Lap looks like 2 laps</i>: tap <i>Add missed lap</i>. <i>Lap is very short</i>: tap <i>Remove that tap</i>. <i>No finish recorded</i>: tap <i>Mark DNF</i> or <i>Add finish now</i>."),
    step("Publish","Tap <i>Publish results</i>. The race appears on the public results page and the series standings update. If you change anything later, tap <i>Republish results</i>."),
    step("Share the results","Send riders the results page address. Each race and series has its own link you can copy from the address bar."),
  ])+sec("Managing",[
    step("Other organisers","On the home screen, tap <i>Organisers</i>. The owner can create a username and password for someone (tap <i>Share</i> to send them by text or WhatsApp), or add their Gmail address so they sign in with Google. Either way they can manage everything."),
    step("Next season","In a series' Settings, use <i>Copy this series</i>. The copy keeps every rider, number and the points table, with no races. To repeat a race, open it, then <i>Race details</i> › <i>Duplicate this race</i>."),
    step("Archive","In a series' Settings, archive a race or the whole series. Archived items are hidden from everyone. Restore them from <i>Archive</i> on the home screen, which is also the only place to delete something for good."),
  ]);
  return header([{label:"Lapboard",go:back}],"How to use Lapboard",null,tabs)+`<div class="stack">${body}<div><button class="btn" data-go='${esc(JSON.stringify(back))}'>Back</button></div></div>`;
}
function renderCheckin(race,s){
  const rs=ridersOf(s), inn=new Set(race.checkedIn||[]);
  const q=(view.q||"").toLowerCase();
  const shown=rs.filter(r=>!q||r.name.toLowerCase().includes(q)||String(r.num)===q);
  return `<div class="stack">
  ${admin()?tkLinkCard(race):""}
  ${admin()?`<details class="card" id="d-racedetails" ${openDetails["d-racedetails"]?"open":""}><summary style="cursor:pointer;font-weight:600">Race details</summary>
    <form id="raceDetails" class="row" style="margin-top:10px;align-items:flex-end">
      <label class="f">Name<input type="text" id="rd-name" value="${esc(race.name)}" required></label>
      <label class="f" style="flex:0 1 150px">Date<input type="date" id="rd-date" value="${esc(race.date||"")}"></label>
      <label class="f" style="flex:0 1 100px">Minutes<input type="number" id="rd-min" min="5" max="180" value="${race.durationMin||45}"></label>
      <button class="btn primary" type="submit">Save</button></form>
    <div class="row" style="margin-top:10px"><button class="btn sm" data-act="duprace">Duplicate this race</button><span class="small muted">Same length and the same riders checked in, with no times.</span></div></details>`:""}
  <div class="spread"><div><b class="num" style="font-family:var(--display);font-size:26px">${inn.size}</b> <span class="muted">of ${rs.length} checked in · ${rs.filter(r=>inn.has(r.id)&&r.cat==="M").length} men, ${rs.filter(r=>inn.has(r.id)&&r.cat==="F").length} women</span></div>
  <div class="row"><button class="btn sm" data-act="checkall">Check in everyone</button><button class="btn sm ghost" data-act="checknone">Clear</button></div></div>
  <input type="text" id="ci-search" placeholder="Search name or number" value="${esc(view.q||"")}" autocomplete="off">
  <div class="card list">${shown.map(r=>`<label class="item" style="cursor:pointer"><input type="checkbox" data-check="${r.id}" ${inn.has(r.id)?"checked":""} style="width:22px;height:22px"><span class="plate-sm">${r.num}</span><span class="grow">${esc(r.name)}</span><span class="pill">${CATS[r.cat]}</span></label>`).join("")||`<div class="empty">No riders match.</div>`}</div>
  ${riderForm("newAtCheckin","New rider today",s)}
  <p class="note">New riders are added to the series with their number${admin()?"":" (the organiser sees them too)"} and checked in to this race.</p>
  ${race.status==="setup"||!race.status?`<div><button class="btn dark" data-go='${esc(JSON.stringify({tab:"timing"}))}'>Go to timing</button></div>`:""}
  </div>`;
}
function filterRiders(list){
  if(myFilter==="M"||myFilter==="F") return list.filter(r=>r.cat===myFilter);
  if(myFilter==="odd") return list.filter(r=>r.num%2===1);
  if(myFilter==="even") return list.filter(r=>r.num%2===0);
  return list;
}
function timingRenderKey(){ const race=getRace(view.raceId); if(!race)return ""; return [race.status,!!race.startAt,(race.checkedIn||[]).join(","),myFilter,dnfMode,armed].join("|") }
function renderTiming(race,s){
  const inn=new Set(race.checkedIn||[]);
  const rs=filterRiders(ridersOf(s).filter(r=>inn.has(r.id)));
  const started=!!race.startAt;
  const ended=race.status==="done"||race.status==="published";
  return `<div class="stack" style="gap:12px">
  <div class="clockbar"><div><div class="tag">Race time</div><div class="clock" id="clock">${started?"0:00":"–:––"}<small>/ ${race.durationMin||45}:00</small></div></div>
    <div class="row" style="justify-content:flex-end">
      ${!started?`<button class="btn ${armed==="start"?"arm":"primary"}" data-act="start" ${inn.size?"":"disabled"}>${armLabel("start","Start race","Tap again to start")}</button>`:""}
      ${started&&!ended?`<button class="btn sm ${armed==="end"?"arm":""}" data-act="end">${armLabel("end","End race","Tap again to end")}</button>`:""}
    </div></div>
  ${!inn.size?`<div class="card empty">Check riders in first. Only checked-in riders appear here.</div>`:""}
  <div id="banner"></div>
  <div><div class="spread" style="margin-bottom:6px"><span class="tag">Coming up</span><span class="small muted" id="leaderline"></span></div><div class="strip" id="strip"></div></div>
  <div class="spread"><div class="seg" role="group" aria-label="Riders on this phone">
    ${[["all","All"],["M","Men"],["F","Women"],["odd","Odd #"],["even","Even #"]].map(([k,l])=>`<button data-filter="${k}" aria-pressed="${myFilter===k}">${l}</button>`).join("")}</div>
    ${started&&!ended?`<button class="btn sm ${dnfMode?"arm":"danger"}" data-act="dnfmode">${dnfMode?"Tap the rider who stopped":"Mark DNF"}</button>`:""}</div>
  <div class="grid ${dnfMode?"dnfmode":""}" id="grid">${rs.map(r=>`<button class="plate" data-tap="${r.id}" ${started&&!ended?"":"disabled"} aria-label="Rider ${r.num} ${esc(r.name)}"><span class="cat">${r.cat}</span>${r.num}<span class="lp" data-lp="${r.id}"></span></button>`).join("")}</div>
  <div><div class="tag" style="margin-bottom:6px">Your last taps</div><div class="recent" id="recent"></div></div>
  ${started?`<details class="card" id="d-controls" ${openDetails["d-controls"]?"open":""}><summary class="small" style="cursor:pointer;font-weight:600">Race controls</summary><div class="stack" style="margin-top:10px">
    <label class="f">Race length in minutes<input type="number" id="dur" min="5" max="180" value="${race.durationMin||45}"></label>
    <div class="row"><button class="btn sm ${armed==="reset"?"arm":"danger"}" data-act="reset">${armLabel("reset","Reset race and delete all taps","Tap again to delete every tap")}</button></div>
    <p class="note">Two phones can time together. Each picks a group above (for example Men and Women) so neither list is crowded. If both tap the same rider within ${DEDUP_MS/1000} seconds, it counts once.</p></div></details>`:
    `<p class="note">Tip: with two timekeepers, each phone picks a group above. Taps from both phones go into the same race.</p>`}
  </div>`;
}
function liveUpdate(){
  if(view.screen!=="race"||view.tab!=="timing"||!$("#grid"))return;
  const race=getRace(view.raceId), s=series[race.seriesId], now=Date.now();
  const c=compute(race,s,now), started=!!race.startAt, ended=race.status==="done"||race.status==="published";
  const el=started?now-race.startAt:0;
  $("#clock").firstChild.nodeValue=started?fmt(ended&&c.finishAt?c.finishAt-race.startAt:el):"–:––";
  // banner
  let b="";
  if(!started) b=`<div class="banner"><p>Press <b>Start race</b> as the riders go. Then tap each number as it crosses the line.</p></div>`;
  else if(ended) b=admin()?`<div class="banner fin"><p>Race ended. Check the <b>Review</b> tab, then publish.</p><button class="btn sm dark" data-go='${esc(JSON.stringify({tab:"review"}))}'>Review</button></div>`
    :`<div class="banner fin"><p><b>Race ended.</b> Thanks for timing. The organiser will check the laps and publish the results.</p></div>`;
  else if(c.finishAt){ const xs=Object.values(c.R).filter(x=>!x.dnf&&x.laps>0), fin=xs.filter(x=>x.fin).length;
    b=`<div class="banner fin"><p><b>Finishing.</b> ${fin} of ${xs.length} riders in. Every rider's next crossing is their finish.</p><button class="btn sm ${armed==="end"?"arm":"dark"}" data-act="end">${armLabel("end","End race","Tap again to end")}</button></div>`; }
  else if(race.targetLaps&&c.leader){ const T=race.targetLaps, L=c.leader.laps, avg=c.pred?c.pred.recent:c.leader.avg;
    if(L>=T-1) b=`<div class="banner hot"><p><b>Last lap. Ring the bell.</b> Leader #${c.leader.rider.num} finishes on lap ${T}, at about ${fmt(c.leader.last-race.startAt+avg)}.</p></div>`;
    else b=`<div class="banner"><p>Race is <b>${T} laps</b>${race.lapsFrom?` (set from the leader's lap 2 of ${fmt(race.lapsFrom)})`:""}. Ring the bell when the leader completes lap ${T-1}, at about ${fmt(c.leader.last-race.startAt+(T-1-L)*avg)}.</p>
      <div class="row"><button class="btn sm" data-act="lapsminus" ${T-1>L+1?"":"disabled"} aria-label="One lap fewer">−1 lap</button><button class="btn sm" data-act="lapsplus" aria-label="One lap more">+1 lap</button></div></div>`; }
  else if(c.leader&&c.leader.laps>=1){ b=`<div class="banner"><p>The number of laps is set when the leader finishes lap 2. Leader's lap 1: ${fmt(c.leader.lapTimes[0])}.</p><button class="btn sm ${armed==="bellnow"?"arm":""}" data-act="bellnow">${armLabel("bellnow","Call last lap now","Tap again")}</button></div>`; }
  else b=`<div class="banner"><p>The number of laps is set when the leader finishes lap 2.</p></div>`;
  if(!ended&&!race.targetLaps&&c.pred&&!liveUpdate.locking){ liveUpdate.locking=true;
    setRace(race.id,{targetLaps:c.pred.N,lapsFrom:Math.round(c.pred.lap2)}); setTimeout(()=>liveUpdate.locking=false,5000); toast(`Race set to ${c.pred.N} laps`); }
  const bn=$("#banner"); if(bn.dataset.k!==b){bn.innerHTML=b;bn.dataset.k=b}
  $("#leaderline").textContent=c.leader?`Leader #${c.leader.rider.num} · lap ${c.leader.laps}${race.targetLaps?" of "+race.targetLaps:""}`:"";
  // plates
  const inView=new Set();
  document.querySelectorAll("#grid .plate").forEach(btn=>{ const id=btn.dataset.tap, x=c.R[id]; inView.add(id); if(!x)return;
    const due=started&&!ended&&!x.fin&&!x.dnf&&x.expected!=null&&x.expected-now<45000;
    btn.classList.toggle("due",due&&!x.overdue); btn.classList.toggle("over",x.overdue&&!ended); btn.classList.toggle("fin",x.fin); btn.classList.toggle("dnf",x.dnf);
    const lp=btn.querySelector(".lp"); lp.textContent=x.dnf?"DNF":x.fin?"✓ "+x.laps+" laps":x.overdue?"overdue":x.laps?"lap "+x.laps:"–";
    if(!dnfMode) btn.disabled=!started||ended||x.fin||x.dnf; });
  // strip: due riders, soonest first
  const up=started&&!ended?Object.values(c.R).filter(x=>inView.has(x.id)&&!x.fin&&!x.dnf&&x.expected!=null&&x.expected-now<75000).sort((a,b)=>a.expected-b.expected).slice(0,8):[];
  const k=up.map(x=>x.id+(x.overdue?"o":"")).join(",");
  if(k!==stripKey){ stripKey=k; $("#strip").innerHTML=up.length?up.map(x=>`<button class="plate ${x.overdue?"over":"due"}" data-tap="${x.id}"><span class="cat">${x.rider.cat}</span>${x.rider.num}<span class="lp">${x.overdue?"overdue":"lap "+(x.laps+1)}</span></button>`).join("")
      :`<span class="strip-empty">${started&&!ended?"Riders due in the next minute appear here.":"–"}</span>`; }
  // recent own taps
  const rec=[...ownTaps].sort((a,b)=>b.t-a.t).slice(0,6);
  const rk=rec.map(t=>t.id).join(",");
  const re=$("#recent"); if(re.dataset.k!==rk){ re.dataset.k=rk; re.innerHTML=rec.length?rec.map(t=>{const r=s.riders[t.r];return `<span class="tap">#${r?r.num:"?"} <span class="muted t">${started?fmt(t.t-race.startAt):""}</span><button data-undo="${t.id}">Undo</button></span>`}).join(""):`<span class="small muted">None yet</span>`; }
}
function renderReview(race,s){
  if(!race.startAt) return `<div class="stack"><div class="card empty">Nothing to review until the race has started.</div></div>`;
  const now=Date.now(), {c,out}=rankings(race,s,now), ended=race.status==="done"||race.status==="published";
  let flags=0;
  const sec=Object.entries(CATS).map(([cat,label])=>{ const rows=out[cat]; if(!rows.length)return "";
    return `<div class="card"><h2>${label}</h2><div class="tbl-wrap"><table><thead><tr><th>Pos</th><th>Rider</th><th class="r">Laps</th><th class="r">Time</th><th class="r">Gap</th></tr></thead><tbody>
    ${rows.map(row=>{ const x=row.x, fl=flagsFor(x); flags+=fl.length;
      const possibleDnf=ended&&!x.fin&&!x.dnf&&x.laps>0;
      if(possibleDnf)flags++;
      const missedLaps=new Set(fl.filter(f=>f.type==="missed").map(f=>f.lap)), shortLaps=new Set(fl.filter(f=>f.type==="short").map(f=>f.lap));
      return `<tr><td class="pos">${row.pos}</td><td><span class="plate-sm">${x.rider.num}</span> ${esc(x.rider.name)}
        ${x.lapTimes.length?`<div class="laps">${x.lapTimes.map((v,i)=>`<span class="${missedLaps.has(i)?"flag":shortLaps.has(i)?"short":""}">L${i+1} ${fmt(v)}</span>`).join("")}</div>`:""}
        ${fl.map(f=>f.type==="missed"?`<div class="flagrow"><span class="pill warn">Lap ${f.lap+1} looks like 2 laps</span><button class="btn sm" data-addtap="${x.id}|${f.insertT}">Add missed lap</button></div>`
          :`<div class="flagrow"><span class="pill warn">Lap ${f.lap+1} is very short</span><button class="btn sm" data-rmtap="${f.tapId}">Remove that tap</button></div>`).join("")}
        ${possibleDnf?`<div class="flagrow"><span class="pill warn">No finish recorded</span><button class="btn sm" data-dnf="${x.id}">Mark DNF</button><button class="btn sm ghost" data-addfinish="${x.id}">Add finish now</button></div>`:""}
        ${x.dnf?`<div class="flagrow"><button class="btn sm ghost" data-dnf="${x.id}">Undo DNF</button></div>`:""}
      </td><td class="r t">${row.status==="dnf"||row.status==="dns"?(row.laps||"–"):row.laps}</td><td class="r t">${row.time!=null?fmt(row.time):"–"}</td><td class="r t">${esc(row.gap)}</td></tr>`}).join("")}
    </tbody></table></div></div>` }).join("");
  const pub=race.published;
  return `<div class="stack">
    <div class="banner ${flags?"":"fin"}"><p>${!ended?"The race is still running. Results here update live.":flags?`<b>${flags} thing${flags>1?"s":""} to check</b> before publishing. Highlighted laps are about twice or half the rider's usual lap.`:"<b>No problems spotted.</b> Ready to publish."}</p>
    ${ended?`<button class="btn sm primary" data-act="publish">${pub?"Republish results":"Publish results"}</button>`:""}</div>
    ${pub?`<p class="note">Published ${new Date(pub.at).toLocaleString()}. Changes here go public only when you republish.</p>`:""}
    ${sec}
    ${ended?`<div class="row"><button class="btn sm ghost" data-act="reopen">Reopen timing</button></div>`:""}
  </div>`;
}
function renderResults(race,s){
  const pub=race.published;
  if(!pub) return `<div class="stack"><div class="card empty">${admin()?"Results show here once you publish them from the Review tab.":"Results for this race haven't been published yet."}</div></div>`;
  return `<div class="stack">${Object.entries(CATS).map(([cat,label])=>{ const rows=pub.rows[cat]||[]; if(!rows.length)return "";
    const win=rows[0];
    return `<div class="card"><div class="spread"><h2>${label}</h2>${win&&/^\d+$/.test(win.pos)?`<span class="small muted">Winner: ${win.laps} laps</span>`:""}</div><div class="tbl-wrap"><table><thead><tr><th>Pos</th><th>Rider</th><th class="r">Time</th><th class="r">Gap</th></tr></thead><tbody>
    ${rows.map(r=>`<tr><td class="pos">${esc(r.pos)}</td><td><span class="plate-sm">${r.num}</span> ${esc(r.name)}</td><td class="r t">${r.time!=null?fmt(r.time):"–"}</td><td class="r t">${esc(r.gap)}</td></tr>`).join("")}
    </tbody></table></div></div>`}).join("")}
    <p class="note">Published ${new Date(pub.at).toLocaleDateString()} · ${race.durationMin||45} minute race</p></div>`;
}

/* ---------- example series ---------- */
// Made-up riders and a finished race with a few planted mistakes, so organisers can practise reviewing.
function buildExample(){
  let seed=7; const rnd=()=>{seed=(seed*16807)%2147483647;return seed/2147483647};
  const first=["Ada","Bram","Cleo","Dirk","Elsa","Finn","Greta","Hugo","Ines","Joost","Kaat","Lars","Mila","Noor","Otto","Pia","Quinn","Ruud","Saar","Tijn","Uma","Vince","Wies","Xander","Yara","Zeb","Fleur","Joep","Lotte","Mats"];
  const last=["Kettle","Spoke","Mudd","Crank","Biscotti","Sprocket","Derailleur","Tubular","Cantilever","Barrier","Runup","Plank","Puddle","Chainring","Sandpit","Hopper","Bell","Flyover","Gravel","Cowbell","Frites","Wafel","Knobby","Dismount","Remount","Shoulder","Slick","Clincher","Toeclip","Bonk"];
  const fem=new Set(["Ada","Cleo","Elsa","Greta","Ines","Kaat","Mila","Noor","Pia","Saar","Uma","Wies","Yara","Fleur","Lotte"]);
  const riders={}, ids=[];
  first.forEach((f,i)=>{const id="ex"+String(i+1).padStart(2,"0"); ids.push(id); riders[id]={name:`${f} ${last[i]}`,num:i+1+(i>=20?10:0),cat:fem.has(f)?"F":"M"}});
  const d=new Date(); d.setDate(d.getDate()-7); d.setHours(10,0,0,0); const start=d.getTime();
  const pace={}, cr={}; ids.forEach(id=>pace[id]=270000+rnd()*90000+(riders[id].cat==="F"?20000:0));
  ids.forEach(id=>{ let t=start; cr[id]=[]; for(let l=0;l<20;l++){ t+=(l===0?pace[id]*1.15:pace[id])*(0.97+rnd()*0.06); cr[id].push(Math.round(t)) } });
  const leader=ids.reduce((a,b)=>cr[a][1]<cr[b][1]?a:b), lap2=cr[leader][1]-cr[leader][0], e2=cr[leader][1]-start;
  let N=2,best=Infinity; for(let k=2;k<40;k++){const x=Math.abs(e2+(k-2)*lap2-2700000); if(x<best){best=x;N=k}}
  const finishAt=cr[leader][N-1], absent=["ex29","ex30"], taps=[]; let n=0;
  ids.forEach(id=>{ if(absent.includes(id))return;
    for(let i=0;i<cr[id].length;i++){ const t=cr[id][i];
      if(id==="ex17"&&i>=3)break;                      // stops after 3 laps: no finish
      if(id==="ex05"&&i===4)continue;                   // timekeeper missed a lap
      taps.push({id:"ex-"+(n++),r:id,t}); if(id==="ex12"&&i===2)taps.push({id:"ex-"+(n++),r:id,t:t+60000}); // stray extra tap
      if(t>=finishAt)break; } });
  return {riders, start, N, lap2:Math.round(lap2), date:d.toISOString().slice(0,10), checked:ids.filter(id=>!absent.includes(id)), practice:ids.slice(0,26), taps};
}
async function loadExample(){
  const ex=buildExample();
  const ref=db.collection("series").doc();
  await ref.set({name:"Biscuit Cup (example)",kind:"series",points:DEFAULT_POINTS,riders:ex.riders,createdAt:Date.now()});
  series[ref.id]={name:"Biscuit Cup (example)",kind:"series",points:DEFAULT_POINTS,riders:ex.riders,createdAt:Date.now()};
  const r1=await createRace({seriesId:ref.id,name:"Round 1 (example)",date:ex.date,durationMin:45});
  await db.doc(livePath(r1)).update({status:"done",startAt:ex.start,targetLaps:ex.N,lapsFrom:ex.lap2,checkedIn:ex.checked});
  await db.doc(livePath(r1)+"/taps/example").set({device:"example",taps:ex.taps});
  const r2=await createRace({seriesId:ref.id,name:"Practice round",date:new Date().toISOString().slice(0,10),durationMin:45});
  await db.doc(livePath(r2)).update({checkedIn:ex.practice});
  return ref.id;
}

/* ---------- races and keys ---------- */
const newKey=()=>Array.from(crypto.getRandomValues(new Uint8Array(15)),b=>"abcdefghijkmnpqrstuvwxyz23456789"[b%32]).join("");
async function createRace(fields){
  const rr=db.collection("races").doc(), key=newKey(), rid=rr.id;
  const {durationMin}=fields;
  await rr.set({...fields,createdAt:Date.now(),edits:{added:[],removed:[]}});
  await db.doc("raceKeys/"+rid).set({key});
  keys[rid]=key;
  const live={status:"setup",startAt:null,targetLaps:null,lapsFrom:null,checkedIn:[],dnf:[],durationMin};
  await db.doc(`races/${rid}/live/${key}`).set(live);
  races[rid]=races[rid]||{id:rid,...fields,edits:{added:[],removed:[]}}; lives[rid]=lives[rid]||live;
  subLive(rid);
  return rid;
}
async function rekey(rid){
  const old=keys[rid], key=newKey();
  try{
    const live=await db.doc(`races/${rid}/live/${old}`).get();
    await db.doc(`races/${rid}/live/${key}`).set(live.exists?live.data():{status:"setup",checkedIn:[],dnf:[]});
    for(const [dev,d] of Object.entries(tapDocs)) await db.doc(`races/${rid}/live/${key}/taps/${dev}`).set(d);
    await db.doc("raceKeys/"+rid).set({key});
    for(const dev of Object.keys(tapDocs)) await db.doc(`races/${rid}/live/${old}/taps/${dev}`).delete();
    await db.doc(`races/${rid}/live/${old}`).delete();
    keys[rid]=key; if(liveUnsubs[rid]){liveUnsubs[rid]();delete liveUnsubs[rid]} subLive(rid);
    tapsRaceId=null; subTaps(rid); toast("New link made. The old one no longer works");
  }catch(e){ console.error(e); toast("Couldn't make a new link. Try again") }
}
async function deleteRace(rid){
  const key=keys[rid];
  if(liveUnsubs[rid]){ liveUnsubs[rid](); delete liveUnsubs[rid] }
  if(key){ const taps=await db.collection(`races/${rid}/live/${key}/taps`).get();
    for(const d of taps.docs) await db.doc(`races/${rid}/live/${key}/taps/${d.id}`).delete();
    await db.doc(`races/${rid}/live/${key}`).delete(); await db.doc("raceKeys/"+rid).delete(); }
  await db.doc("races/"+rid).delete();
  delete races[rid]; delete lives[rid]; delete keys[rid];
}
function subLive(rid){
  if(liveUnsubs[rid]||!keyFor(rid))return;
  liveUnsubs[rid]=db.doc(livePath(rid)).onSnapshot(sn=>{ lives[rid]=sn.exists?sn.data():null; onData() },
    e=>{ console.error(e); lives[rid]=null; render() });
}

/* ---------- actions ---------- */
document.addEventListener("click",e=>{
  const t=e.target.closest("button,[data-check]"); if(!t)return;
  if(t.dataset.go){ go(JSON.parse(t.dataset.go)); return }
  if(t.dataset.tab){ go({tab:t.dataset.tab}); return }
  if(t.dataset.tap){ if(!t.disabled) tap(t.dataset.tap); return }
  if(t.dataset.undo){ undoTap(t.dataset.undo); return }
  if(t.dataset.filter){ myFilter=t.dataset.filter; try{localStorage.setItem("lb-filter",myFilter)}catch(e){} render(); return }
  if(t.dataset.editrider){ view.editRider=t.dataset.editrider; armed=null; render(); const el=$("#er-name"); if(el)el.focus(); return }
  if(t.dataset.delrider){ const id=t.dataset.delrider; arm("del-"+id,()=>{ const s=series[view.seriesId]; const riders={...s.riders}; delete riders[id];
      enqueue("series/"+view.seriesId,()=>db.doc("series/"+view.seriesId).set({...s,riders})); series[view.seriesId]={...s,riders}; render(); }); return }
  if(t.dataset.dnf){ toggleDnf(t.dataset.dnf); return }
  if(t.dataset.archrace||t.dataset.restorerace){ const rid=t.dataset.archrace||t.dataset.restorerace, a=!!t.dataset.archrace;
    races[rid]={...races[rid],archived:a}; enqueue("races/"+rid,()=>db.doc("races/"+rid).update({archived:a})); toast(a?"Race moved to the archive":"Race restored"); render(); return }
  if(t.dataset.archseries||t.dataset.restoreseries){ const sid=t.dataset.archseries||t.dataset.restoreseries, a=!!t.dataset.archseries;
    series[sid]={...series[sid],archived:a}; enqueue("series/"+sid,()=>db.doc("series/"+sid).update({archived:a})); toast(a?"Series moved to the archive":"Series restored");
    if(a) go({screen:"home",seriesId:null}); else render(); return }
  if(t.dataset.delseries){ const sid=t.dataset.delseries; arm("delseries-"+sid,async()=>{ const name=series[sid].name;
      try{ for(const rid of Object.keys(races).filter(r=>races[r].seriesId===sid)) await deleteRace(rid);
        await db.doc("series/"+sid).delete(); delete series[sid]; toast(`${name} deleted for good`) }
      catch(e){ console.error(e); toast("Couldn't delete everything. Try again") } render() }); return }
  if(t.dataset.rmorg){ const e=t.dataset.rmorg; arm("rmorg-"+e,()=>{ const emails=(organisers.emails||[]).filter(x=>x!==e); organisers={emails};
      enqueue("config/organisers",()=>db.doc("config/organisers").set({emails})); toast(e+" removed"); render() }); return }
  if(t.dataset.delrace){ const rid=t.dataset.delrace; arm("delrace-"+rid,async()=>{ const n=races[rid]&&races[rid].name;
      try{ await deleteRace(rid); toast(`${n} deleted for good`) }catch(e){ console.error(e); toast("Couldn't delete the race. Try again") } render() }); return }
  if(t.dataset.addtap){ const [r,tt]=t.dataset.addtap.split("|"); const race=getRace(view.raceId); const ed=race.edits||{};
    setRace(race.id,{edits:{removed:ed.removed||[],added:[...(ed.added||[]),{id:"e-"+uid(),r,t:+tt}]}}); toast("Lap added"); return }
  if(t.dataset.addfinish){ const race=getRace(view.raceId), c=compute(race,series[race.seriesId],Date.now()), x=c.R[t.dataset.addfinish];
    const at=Math.max(c.finishAt||0,x.last+DEDUP_MS)+1000; const ed=race.edits||{};
    setRace(race.id,{edits:{removed:ed.removed||[],added:[...(ed.added||[]),{id:"e-"+uid(),r:x.id,t:at}]}}); toast("Finish added"); return }
  if(t.dataset.rmtap){ const race=getRace(view.raceId); const ed=race.edits||{};
    setRace(race.id,{edits:{added:ed.added||[],removed:[...(ed.removed||[]),t.dataset.rmtap]}}); toast("Tap removed"); return }
  const act=t.dataset.act; if(!act)return;
  const race=view.raceId?getRace(view.raceId):null;
  if(act==="signin"){ backend.signIn().catch(e=>{console.error(e);toast("Sign-in didn't complete. Try again")}); return }
  if(act==="signout"){ backend.signOut().then(()=>location.hash="#/"); return }
  if(act==="copylogin"||act==="sharelogin"){ const txt=view.madeLogin&&view.madeLogin.text; if(!txt)return;
    if(act==="sharelogin"&&navigator.share){ navigator.share({title:"Lapboard organiser login",text:txt}).catch(()=>{}); return }
    (navigator.clipboard?navigator.clipboard.writeText(txt):Promise.reject()).then(()=>toast("Login copied"),()=>toast("Select the text and copy it")); return }
  if(act==="copylink"){ const u=tkUrl(race); (navigator.clipboard?navigator.clipboard.writeText(u):Promise.reject()).then(()=>toast("Link copied"),()=>toast("Select the link and copy it")); return }
  if(act==="sharelink"){ const u=tkUrl(race);
    if(navigator.share) navigator.share({title:"Lapboard timekeeper: "+race.name,text:"Timekeeping link for "+race.name+":",url:u}).catch(()=>{});
    else (navigator.clipboard?navigator.clipboard.writeText(u):Promise.reject()).then(()=>toast("Link copied"),()=>toast("Select the link and copy it")); return }
  if(act==="canceledit"){ view.editRider=null; render(); return }
  if(act==="navback"){ history.back(); return }
  if(act==="duprace"){ const race=getRace(view.raceId); toast("Duplicating…");
    enqueue("races/new",async()=>{ const rid=await createRace({seriesId:race.seriesId,name:nextName(race.name.replace(/\(copy\)$/,"").trim()),date:new Date().toISOString().slice(0,10),durationMin:race.durationMin||45});
      lives[rid]={...lives[rid],checkedIn:[...(race.checkedIn||[])]}; await db.doc(livePath(rid)).update({checkedIn:[...(race.checkedIn||[])]});
      toast("Race duplicated"); go({screen:"race",raceId:rid,tab:"checkin"}) }); return }
  if(act==="example"){ toast("Adding example series…"); enqueue("example",async()=>{ const sid=await loadExample(); toast("Example series added"); go({screen:"series",seriesId:sid,tab:"races"}) }); return }
  if(act==="rekey"){ arm("rekey",()=>rekey(race.id)); return }
  if(act==="start") arm("start",()=>{ setRace(race.id,{startAt:Date.now(),status:"running",targetLaps:null}); requestWake(); toast("Race started") });
  else if(act==="end") arm("end",()=>{ setRace(race.id,{status:"done"}); go({tab:admin()?"review":"timing"}) });
  else if(act==="bellnow") arm("bellnow",()=>{ const c=compute(race,series[race.seriesId],Date.now()); setRace(race.id,{targetLaps:(c.leader?c.leader.laps:0)+1,lapsFrom:null}); });
  else if(act==="lapsplus") setRace(race.id,{targetLaps:race.targetLaps+1});
  else if(act==="lapsminus"){ const c=compute(race,series[race.seriesId],Date.now()); if(race.targetLaps-1>(c.leader?c.leader.laps:0)+1) setRace(race.id,{targetLaps:race.targetLaps-1}); }
  else if(act==="dnfmode"){ dnfMode=!dnfMode; render(); }
  else if(act==="reopen") { setRace(race.id,{status:"running"}); go({tab:"timing"}) }
  else if(act==="reset") arm("reset",async()=>{ const ids=Object.keys(tapDocs); ownTaps=[]; ownRemoved=new Set();
      setRace(race.id,{startAt:null,status:"setup",targetLaps:null,lapsFrom:null,dnf:[],...(admin()?{edits:{added:[],removed:[]}}:{})});
      for(const id of ids) await enqueue("taps/"+id,()=>db.doc(livePath(race.id)+"/taps/"+id).delete()); toast("Race reset") });
  else if(act==="checkall"){ const s=series[race.seriesId]; setRace(race.id,{checkedIn:Object.keys(s.riders||{})}) }
  else if(act==="checknone") setRace(race.id,{checkedIn:[]});
  else if(act==="publish"){ const s=series[race.seriesId]; const {out}=rankings(race,s,Date.now()); const rows={};
    for(const cat in out) rows[cat]=out[cat].map(r=>({rid:r.x.id,pos:r.pos,num:r.x.rider.num,name:r.x.rider.name,laps:r.laps,
      lapsText:r.status==="dns"?"–":r.behind?`${r.laps} (−${r.behind})`:String(r.laps),time:r.status==="fin"||r.status==="nofin"?r.time:null,gap:r.gap}));
    setRace(race.id,{published:{at:Date.now(),rows},status:"published"}); toast("Results published"); go({tab:"results"}); }
});
document.addEventListener("change",e=>{
  const t=e.target;
  if(t.dataset.check){ const race=getRace(view.raceId); const set=new Set(race.checkedIn||[]); t.checked?set.add(t.dataset.check):set.delete(t.dataset.check); setRace(race.id,{checkedIn:[...set]}) }
  if(t.id==="dur"){ const v=Math.max(5,Math.min(180,+t.value||45)); setRace(view.raceId,{durationMin:v}) }
});
document.addEventListener("input",e=>{ if(e.target.id==="ci-search"||e.target.id==="find-q"){ const id=e.target.id; view[id==="find-q"?"fq":"q"]=e.target.value; const pos=e.target.selectionStart; render(); const el=$("#"+id); el.focus(); try{el.setSelectionRange(pos,pos)}catch(_){} } });
document.addEventListener("submit",async e=>{
  e.preventDefault(); const f=e.target;
  if(f.id==="newSeries"||f.id==="copySeries"){ const copy=f.id==="copySeries";
    const name=$(copy?"#cs-name":"#ns-name").value.trim(), from=series[copy?view.seriesId:($("#ns-copy")||{}).value], kind=copy?from.kind:$("#ns-kind").value; if(!name)return;
    const riders=from?JSON.parse(JSON.stringify(from.riders||{})):{}, points=from&&copy?from.points||DEFAULT_POINTS:DEFAULT_POINTS;
    const ref=db.collection("series").doc(); await enqueue("series/"+ref.id,()=>ref.set({name,kind,points,riders,createdAt:Date.now()}));
    series[ref.id]=series[ref.id]||{name,kind,points,riders,createdAt:Date.now()};
    if(from) toast(`${Object.keys(riders).length} riders copied with their numbers`);
    if(kind==="oneday") await enqueue("races/new",()=>createRace({seriesId:ref.id,name,date:new Date().toISOString().slice(0,10),durationMin:45}));
    go({screen:"series",seriesId:ref.id,tab:"riders"}); }
  if(f.id==="newRace"){ let rid=null;
    await enqueue("races/new",async()=>{ rid=await createRace({seriesId:view.seriesId,name:$("#nr-name").value.trim()||"Race",date:$("#nr-date").value,durationMin:+$("#nr-min").value||45}) });
    if(rid) go({screen:"race",raceId:rid,tab:"checkin"}); }
  if(f.id==="addRider"||f.id==="newAtCheckin"){ const sid=f.id==="addRider"?view.seriesId:getRace(view.raceId).seriesId, s=series[sid];
    const name=$("#"+f.id+"-name").value.trim(), num=+$("#"+f.id+"-num").value, cat=$("#"+f.id+"-cat").value; if(!name||!num)return;
    if(Object.values(s.riders||{}).some(r=>r.num===num)){ toast(`Number ${num} is already taken`); return }
    const rid="r"+uid(); series[sid]={...s,riders:{...(s.riders||{}),[rid]:{name,num,cat}}};
    if(mode==="tk"){ const race=getRace(view.raceId); setRace(race.id,{newRiders:[...(race.newRiders||[]),{id:rid,name,num,cat}],checkedIn:[...(race.checkedIn||[]),rid]}) }
    else { enqueue("series/"+sid,()=>db.doc("series/"+sid).update({riders:{[rid]:{name,num,cat}}}));
      if(f.id==="newAtCheckin"){ const race=getRace(view.raceId); setRace(race.id,{checkedIn:[...(race.checkedIn||[]),rid]}) } }
    toast(`#${num} ${name} added`); render(); const nf=$("#"+f.id+"-name"); if(nf) nf.focus(); }
  if(f.id==="editRider"){ const rid=f.dataset.rid, sid=view.seriesId, s=series[sid];
    const name=$("#er-name").value.trim(), num=+$("#er-num").value, cat=$("#er-cat").value; if(!name||!num)return;
    if(Object.entries(s.riders||{}).some(([id,r])=>id!==rid&&r.num===num)){ toast(`Number ${num} is already taken`); return }
    series[sid]={...s,riders:{...s.riders,[rid]:{name,num,cat}}};
    enqueue("series/"+sid,()=>db.doc("series/"+sid).update({riders:{[rid]:{name,num,cat}}}));
    view.editRider=null; toast(`#${num} ${name} saved`); render(); return }
  if(f.id==="raceDetails"){ const race=getRace(view.raceId); const name=$("#rd-name").value.trim()||race.name, date=$("#rd-date").value, dur=Math.max(5,Math.min(180,+$("#rd-min").value||45));
    races[race.id]={...races[race.id],name,date};
    enqueue("races/"+race.id+"/details",()=>db.doc("races/"+race.id).update({name,date}));
    if(dur!==race.durationMin) setRace(race.id,{durationMin:dur}); toast("Race details saved"); render(); return }
  if(f.id==="pwSignin"){ const u=$("#si-user").value.trim().toLowerCase(), pw=$("#si-pass").value;
    backend.signInWithPassword(u,pw).catch(e=>{ console.error(e); toast(e&&/invalid|wrong|not-found|credential/.test(e.code||"")?"Username or password is wrong":"Sign-in didn't work. Try again") }); return }
  if(f.id==="addLogin"){ const u=$("#lg-user").value.trim().toLowerCase(), pw=$("#lg-pass").value;
    if(!/^[a-z0-9._-]{2,30}$/.test(u)){ toast("Usernames use letters, numbers, dots, dashes or underscores"); return }
    if(pw.length<8){ toast("Use a password of at least 8 characters"); return }
    const email=u+"@"+loginDomain();
    if((organisers.emails||[]).includes(email)){ toast(u+" already exists"); return }
    try{ await backend.createLogin(u,pw); }
    catch(e){ console.error(e); toast(e&&e.code==="auth/email-already-in-use"?"That username is taken. Pick another":e&&e.code==="auth/operation-not-allowed"?"Username sign-in is switched off in Firebase (Authentication → Sign-in method → Email/Password)":"Couldn't create the login. Try again"); return }
    const emails=[...(organisers.emails||[]),email]; organisers={emails};
    await enqueue("config/organisers",()=>db.doc("config/organisers").set({emails}));
    const text=`Lapboard organiser login\n${location.origin+location.pathname}#/admin\nUsername: ${u}\nPassword: ${pw}`;
    view.madeLogin={username:u,text}; suggestPassword.v=null; render(); return }
  if(f.id==="addOrg"){ const e=$("#org-email").value.trim().toLowerCase(); if(!e||!e.includes("@"))return;
    if(ownerEmails.includes(e)||(organisers.emails||[]).includes(e)){ toast(e+" is already an organiser"); return }
    const emails=[...(organisers.emails||[]),e]; organisers={emails};
    enqueue("config/organisers",()=>db.doc("config/organisers").set({emails})); toast(e+" added"); render(); }
  if(f.id==="seriesSettings"){ const pts=$("#ss-points").value.split(/[,\s]+/).map(Number).filter(n=>!isNaN(n)&&n>=0);
    const name=$("#ss-name").value.trim()||series[view.seriesId].name;
    enqueue("series/"+view.seriesId,()=>db.doc("series/"+view.seriesId).update({name,points:pts})); series[view.seriesId]={...series[view.seriesId],name,points:pts}; toast("Settings saved"); render(); }
});

/* ---------- wake lock while timing ---------- */
let wake=null;
async function requestWake(){ try{ if(navigator.wakeLock&&!wake){ wake=await navigator.wakeLock.request("screen"); wake.addEventListener("release",()=>wake=null) } }catch(e){} }
document.addEventListener("visibilitychange",()=>{ if(document.visibilityState==="visible"&&view.tab==="timing")requestWake() });
setInterval(liveUpdate,1000);

/* ---------- boot ---------- */

function parseHash(){ const h=location.hash.replace(/^#\/?/,"").split("/");
  if(h[0]==="admin") return {mode:"admin"};
  if(h[0]==="t"&&h[1]&&h[2]) return {mode:"tk",raceId:h[1],key:h[2]};
  if(h[0]==="r"&&h[1]) return {mode:"public",view:{screen:"race",raceId:h[1],tab:"results"}};
  if(h[0]==="s"&&h[1]) return {mode:"public",view:{screen:"series",seriesId:h[1],tab:"races"}};
  if(h[0]==="find") return {mode:"public",view:{screen:"find"}};
  if(h[0]==="help") return {mode:"public",view:{screen:"help",tab:h[1]||"riders"}};
  return {mode:"public",view:{screen:"home"}};
}
// pushState never fires hashchange, and after a back/forward the hash already matches the view.
window.addEventListener("hashchange",()=>{ if(location.hash===navHash()) return; const p=parseHash();
  if(p.mode!==mode||(p.mode==="tk"&&(p.key!==tkKey||p.raceId!==view.raceId))){ location.reload(); return }
  if(p.view) go(p.view,{replace:true}); });
function startAdmin(){
  backend.onAuth(u=>{ authUser=u; isAdmin=null; if(keysUnsub){keysUnsub();keysUnsub=null}
    if(!u){ render(); return }
    render();
    keysUnsub=db.collection("raceKeys").onSnapshot(snap=>{ isAdmin=true; canWrite=true;
      snap.docs.forEach(d=>{ const k=d.data().key; if(keys[d.id]!==k){ keys[d.id]=k; if(liveUnsubs[d.id]){liveUnsubs[d.id]();delete liveUnsubs[d.id]} } subLive(d.id) });
      if(view.screen==="race")subTaps(view.raceId);
      if(!orgUnsub) orgUnsub=db.doc("config/organisers").onSnapshot(sn=>{ organisers=sn.exists?sn.data():{emails:[]}; onData() },e=>console.error(e));
      onData(); },
      e=>{ console.error(e); isAdmin=false; render() });
  });
}
(async()=>{
  const p=parseHash(); mode=p.mode;
  try{
    if(window.__MOCK_BACKEND) backend=window.__MOCK_BACKEND;
    else { const m=await import("./backend.js"); backend=m.createBackend(); }
    ownerEmails=((backend&&backend.ownerEmails)||[]).map(e=>e.toLowerCase());
  }catch(e){ console.error(e); backend=null }
  db=backend&&backend.db;
  if(!db){ render(); return }
  if(mode==="tk"){ tkKey=p.key; canWrite=true; view={screen:"race",raceId:p.raceId,seriesId:null,tab:"timing"}; subLive(p.raceId); subTaps(p.raceId) }
  else if(p.view) view={...view,...p.view};
  db.collection("series").onSnapshot(snap=>{ for(const k in series)delete series[k]; snap.docs.forEach(d=>series[d.id]=d.data()); seriesLoaded=true; onData() },e=>console.error(e));
  db.collection("races").onSnapshot(snap=>{ for(const k in races)delete races[k]; snap.docs.forEach(d=>races[d.id]={id:d.id,...d.data()}); loaded=true;
    if(mode==="tk"&&races[view.raceId]&&lives[view.raceId]&&!view.seriesId) view.seriesId=races[view.raceId].seriesId; onData() },e=>console.error(e));
  if(mode==="admin") startAdmin();
  history.replaceState({lb:navState(),depth:0},"",location.hash||"#/");
  render();
})();
