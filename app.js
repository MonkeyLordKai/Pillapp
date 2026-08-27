// ============================================================
// PILL TRACKER — app.js
// Talks to Firestore for data + sync, handles pills, water
// levels, and push notification subscribe/unsubscribe.
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore,
  doc,
  onSnapshot,
  runTransaction,
  setDoc,
  updateDoc,
  deleteDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

import { firebaseConfig, VAPID_PUBLIC_KEY } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const TOTAL_PILLS = 28;
const DEFAULT_WATER = { pink: 100, black: 100 };

// ------------------------------------------------------------
// IDENTITY: name + shared household code.
// Household code can arrive via ?household=xxx in the URL
// (the "save link" feature) — that always wins and gets saved,
// so opening the saved link can never land you on the wrong code.
// ------------------------------------------------------------
function getOrAskName() {
  let name = localStorage.getItem("pt_name");
  if (!name) {
    name = prompt("What's your name? (so logs show who took/logged the pill)");
    localStorage.setItem("pt_name", name || "Someone");
  }
  return name;
}

function getOrAskHouseholdCode() {
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get("household");
  if (fromUrl) {
    localStorage.setItem("pt_household", fromUrl);
    return fromUrl;
  }

  let code = localStorage.getItem("pt_household");
  if (!code) {
    code = prompt(
      "Enter your shared household code (make one up, e.g. 'pill-abc123'). Use the exact same code on both phones."
    );
    localStorage.setItem("pt_household", code);
  }
  return code;
}

const ME = getOrAskName();
const HOUSEHOLD = getOrAskHouseholdCode();
const householdRef = doc(db, "households", HOUSEHOLD);

// ------------------------------------------------------------
// INITIALIZE the household doc if it doesn't exist yet.
// If it exists but predates the water feature, backfill it.
// ------------------------------------------------------------
async function ensurePillboxExists() {
  const snap = await new Promise((resolve) => {
    const unsub = onSnapshot(householdRef, (s) => {
      unsub();
      resolve(s);
    });
  });

  if (!snap.exists()) {
    const slots = Array.from({ length: TOTAL_PILLS }, (_, i) => ({
      index: i,
      taken: false,
      takenBy: null,
      takenAt: null,
    }));
    await setDoc(householdRef, { slots, totalPills: TOTAL_PILLS, water: DEFAULT_WATER });
  } else if (!snap.data().water) {
    await updateDoc(householdRef, { water: DEFAULT_WATER });
  }
}

// ------------------------------------------------------------
// REAL-TIME SYNC — fires on BOTH phones whenever anything changes.
// ------------------------------------------------------------
function listenForChanges(onUpdate) {
  return onSnapshot(householdRef, (snap) => {
    if (snap.exists()) {
      onUpdate(snap.data());
    }
  });
}

// ------------------------------------------------------------
// TAKE A PILL — race-condition safe via Firestore transaction.
// ------------------------------------------------------------
async function takePill(slotIndex) {
  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(householdRef);
      const data = snap.data();
      const slots = [...data.slots];

      if (slots[slotIndex].taken) {
        throw new Error("ALREADY_TAKEN");
      }

      slots[slotIndex] = {
        ...slots[slotIndex],
        taken: true,
        takenBy: ME,
        takenAt: new Date().toISOString(),
      };

      tx.update(householdRef, { slots });
    });

    notifyOtherPerson(`${ME} logged a pill`, `Taken at ${new Date().toLocaleTimeString()}`);
    return { ok: true };
  } catch (err) {
    if (err.message === "ALREADY_TAKEN") {
      return { ok: false, reason: "already-taken" };
    }
    console.error(err);
    return { ok: false, reason: "error" };
  }
}

// ------------------------------------------------------------
// UNDO — resets a slot back to untaken.
// ------------------------------------------------------------
async function undoPill(slotIndex) {
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(householdRef);
    const data = snap.data();
    const slots = [...data.slots];

    slots[slotIndex] = {
      ...slots[slotIndex],
      taken: false,
      takenBy: null,
      takenAt: null,
    };

    tx.update(householdRef, { slots });
  });

  notifyOtherPerson(`${ME} undid a pill log`, `Slot ${slotIndex + 1} is available again`);
}

// ------------------------------------------------------------
// NEW PACK — resets every slot to untaken (called by "New pack" button).
// ------------------------------------------------------------
async function resetPack() {
  const slots = Array.from({ length: TOTAL_PILLS }, (_, i) => ({
    index: i,
    taken: false,
    takenBy: null,
    takenAt: null,
  }));
  await updateDoc(householdRef, { slots });
  notifyOtherPerson(`${ME} started a new pack`, `All ${TOTAL_PILLS} pills reset`);
}

// ------------------------------------------------------------
// WATER LEVELS — synced the same way as pills.
// ------------------------------------------------------------
async function setWaterLevel(bottleKey, percent) {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  await updateDoc(householdRef, { [`water.${bottleKey}`]: clamped });
}

async function refillWater(bottleKey) {
  await setWaterLevel(bottleKey, 100);
  notifyOtherPerson(`${ME} refilled the ${bottleKey} bottle`, `Back to 100%`);
}

// ------------------------------------------------------------
// PUSH: register / unregister this device.
// Returns a structured result so the UI can show the right message.
// ------------------------------------------------------------
function isIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}
function isStandalone() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true
  );
}

async function registerForPush() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    return { ok: false, reason: "unsupported" };
  }
  if (isIOS() && !isStandalone()) {
    return { ok: false, reason: "ios-not-installed" };
  }

  const reg = await navigator.serviceWorker.register("./service-worker.js");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    return { ok: false, reason: "permission-denied" };
  }

  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
  });

  await setDoc(doc(db, "households", HOUSEHOLD, "subscriptions", ME), {
    subscription: sub.toJSON(),
    updatedAt: serverTimestamp(),
  });

  return { ok: true };
}

async function unregisterPush() {
  try {
    if ("serviceWorker" in navigator) {
      const reg = await navigator.serviceWorker.getRegistration("./service-worker.js");
      if (reg) {
        const sub = await reg.pushManager.getSubscription();
        if (sub) await sub.unsubscribe();
      }
    }
    await deleteDoc(doc(db, "households", HOUSEHOLD, "subscriptions", ME));
  } catch (err) {
    console.warn("Unregister push failed (non-fatal):", err);
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

// ------------------------------------------------------------
// SEND NOTIFICATION via our Vercel serverless function.
// ------------------------------------------------------------
async function notifyOtherPerson(title, body) {
  try {
    await fetch("/api/send-notification", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ household: HOUSEHOLD, excludeName: ME, title, body }),
    });
  } catch (err) {
    console.warn("Notification send failed (non-fatal):", err);
  }
}

// ------------------------------------------------------------
// PUBLIC API
// ------------------------------------------------------------
window.PillTracker = {
  ME,
  HOUSEHOLD,
  TOTAL_PILLS,
  ensurePillboxExists,
  listenForChanges,
  takePill,
  undoPill,
  resetPack,
  setWaterLevel,
  refillWater,
  registerForPush,
  unregisterPush,
};

// Let index.html's inline script know PillTracker is ready to use
// (it's a module script, so it always runs after the inline script).
window.dispatchEvent(new CustomEvent("pilltracker-ready"));

// ------------------------------------------------------------
// BOOT
// ------------------------------------------------------------
(async function boot() {
  await ensurePillboxExists();

  listenForChanges((data) => {
    if (typeof window.renderPillbox === "function") {
      window.renderPillbox(data.slots, { me: ME, takePill, undoPill });
    }
    if (typeof window.renderWaterTab === "function") {
      window.renderWaterTab(data.water);
    }
  });
})();
