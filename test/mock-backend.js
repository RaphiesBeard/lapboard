// In-memory stand-in for backend.js, used by the browser tests. Loads example data from seed.json.
(function(){
  const store=new Map(); const subs=new Set();
  const clone=x=>x===undefined?undefined:JSON.parse(JSON.stringify(x));
  const state={user:null, authFns:[], denyKeys:()=>!(state.user&&(state.user.email==="organiser@example.com"||((store.get("config/organisers")||{}).emails||[]).includes(state.user.email)))};
  const seed=window.__SEED;
  for(const [k,v] of Object.entries(seed)) store.set(k,v);
  const notify=()=>setTimeout(()=>subs.forEach(f=>f()),5);
  const snap=p=>({id:p.split("/").pop(),exists:store.has(p),data:()=>clone(store.get(p)),metadata:{}});
  function merge(a,b){for(const k in b){if(b[k]&&typeof b[k]==="object"&&!Array.isArray(b[k])&&a[k]&&typeof a[k]==="object"&&!Array.isArray(a[k]))merge(a[k],b[k]);else a[k]=b[k]}return a}
  const docW=p=>({id:p.split("/").pop(),path:p,get:async()=>snap(p),
    set:async d=>{store.set(p,clone(d));notify()},
    update:async d=>{store.set(p,merge(store.get(p)||{},clone(d)));notify()},
    delete:async()=>{store.delete(p);notify()},
    onSnapshot(n,e){const f=()=>n(snap(p));subs.add(f);setTimeout(f,5);return()=>subs.delete(f)},
    collection:c=>colW(p+"/"+c)});
  function colW(c,filters=[]){
    const run=()=>{const depth=c.split("/").length+1;const docs=[...store.keys()].filter(k=>k.startsWith(c+"/")&&k.split("/").length===depth)
      .filter(k=>filters.every(([f,v])=>store.get(k)[f]===v)).sort().map(snap);return{docs,size:docs.length,empty:!docs.length}};
    return{path:c,where:(f,op,v)=>colW(c,[...filters,[f,v]]),get:async()=>run(),
      onSnapshot(n,e){ if(c==="raceKeys"&&state.denyKeys()){setTimeout(()=>e&&e({code:"permission-denied"}),5);return()=>{}}
        const f=()=>n(run());subs.add(f);setTimeout(f,5);return()=>subs.delete(f)},
      doc:id=>docW(c+"/"+(id||Math.random().toString(36).slice(2,12))),
      add:async d=>{const r=docW(c+"/"+Math.random().toString(36).slice(2,12));await r.set(d);return r}};
  }
  window.__store=store; window.__mockState=state;
  window.__MOCK_BACKEND={ownerEmails:["organiser@example.com"],db:{doc:docW,collection:c=>colW(c)},
    onAuth:fn=>{state.authFns.push(fn);setTimeout(()=>fn(state.user),5)},
    signIn:async()=>{state.user={email:"organiser@example.com",uid:"u1"};state.authFns.forEach(f=>f(state.user))},
    signOut:async()=>{state.user=null;state.authFns.forEach(f=>f(null))}};
})();
