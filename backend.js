// Firebase backend: wraps Firestore and Auth in the small interface app.js uses.
import { firebaseConfig, ownerEmails } from "./config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, doc, collection, query, where,
  getDoc, getDocs, setDoc, deleteDoc, onSnapshot, connectFirestoreEmulator } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, onAuthStateChanged, signOut,
  signInWithEmailAndPassword, createUserWithEmailAndPassword }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

export function createBackend() {
  if (!firebaseConfig.projectId || firebaseConfig.projectId === "REPLACE_ME") return null;
  const app = initializeApp(firebaseConfig);
  let fs;
  try { fs = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) }); }
  catch (e) { fs = initializeFirestore(app, {}); }
  // Local testing only: http://localhost:PORT/?emulator uses the Firestore emulator on port 8089.
  if (location.hostname === "localhost" && new URLSearchParams(location.search).has("emulator")) connectFirestoreEmulator(fs, "127.0.0.1", 8089);
  const auth = getAuth(app);

  const wrap = (s) => ({ id: s.id, exists: s.exists(), data: () => s.data(), metadata: s.metadata });
  const docW = (ref) => ({
    id: ref.id, path: ref.path,
    get: async () => wrap(await getDoc(ref)),
    set: (d) => setDoc(ref, d),
    update: (d) => setDoc(ref, d, { merge: true }),
    delete: () => deleteDoc(ref),
    onSnapshot: (next, err) => onSnapshot(ref, (s) => next(wrap(s)), err),
    collection: (p) => colW(ref.path + "/" + p),
  });
  const colW = (path, q) => {
    const base = collection(fs, path);
    const qq = q || base;
    return {
      path,
      where: (f, op, v) => colW(path, query(qq, where(f, op, v))),
      get: async () => { const s = await getDocs(qq); return { docs: s.docs.map(wrap) }; },
      onSnapshot: (next, err) => onSnapshot(qq, (s) => next({ docs: s.docs.map(wrap), size: s.size, empty: s.empty }), err),
      doc: (id) => docW(id ? doc(base, id) : doc(base)),
      add: async (d) => { const r = doc(base); await setDoc(r, d); return docW(r); },
    };
  };
  const db = { doc: (p) => docW(doc(fs, p)), collection: (p) => colW(p) };

  // Username logins are Firebase email/password accounts at the project's own auth domain,
  // which nobody else can receive mail for, e.g. sam@lapboard-b6c98.firebaseapp.com.
  const loginDomain = firebaseConfig.authDomain;
  const toEmail = (u) => u.trim().toLowerCase() + "@" + loginDomain;
  return {
    db, ownerEmails, loginDomain,
    signInWithPassword: (u, pw) => signInWithEmailAndPassword(auth, toEmail(u), pw),
    // Creates the account in a second Firebase app so the owner stays signed in.
    createLogin: async (u, pw) => {
      const second = initializeApp(firebaseConfig, "login-" + Date.now());
      const a2 = getAuth(second);
      await createUserWithEmailAndPassword(a2, toEmail(u), pw);
      await signOut(a2);
    },
    onAuth: (fn) => onAuthStateChanged(auth, (u) => fn(u ? { email: u.email, uid: u.uid } : null)),
    signIn: async () => {
      const p = new GoogleAuthProvider();
      try { await signInWithPopup(auth, p); }
      catch (e) { if (e && (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment")) await signInWithRedirect(auth, p); else throw e; }
    },
    signOut: () => signOut(auth),
  };
}
