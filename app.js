// ============================================================
// PILL TRACKER — app.js
// This file is the "brain". It talks to Firestore for data +
// sync, handles the take/undo logic with race-condition
// protection, and fires push notifications to the other person.
//
// Your job (per the request) is styling: pill-tracker.css and
// the markup/rendering inside renderPillbox(). The DATA and
// SYNC logic below is complete and functional once you fill in
// firebase-config.js with your own project's keys (see README).
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore,
  doc,
  onSnapshot,
  runTransaction,
  setDoc,
  deleteDoc,
  updateDoc,
  serverTimestamp,
  collection,
  addDoc,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

import { firebaseConfig, VAPID_PUBLIC_KEY } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// ------------------------------------------------------------
// CONFIG YOU CAN CHANGE
// ------------------------------------------------------------
const TOTAL_PILLS = 28; // e.g. a 28-day pack. Change to whatever her case holds.

// ------------------------------------------------------------
// IDENTITY: just a shared household code (no names/logins).
//
// We don't ask who you are anymore — the UI only shows taken/
// not-taken + the date/time, never a person's name. Internally
// each device still gets a random, invisible ID (auto-generated,
// nothing to type) used only to (a) avoid notifying yourself and
// (b) know which push subscription belongs to which device.
//
// The household code is the one thing that still has to match on
// both phones. iOS can occasionally clear localStorage after a
// week of the app being unused (Intelligent Tracking Prevention),
// which used to look like "it forgot my code". To survive that,
// the code can also travel in the URL (?household=...), and the
// app shows a one-tap "copy your saved link" box below once it's
// set — see the panel that appears after you enter your code.
// ------------------------------------------------------------
const urlParams = new URLSearchParams(window.location.search);

function getOrCreateDeviceId() {
  let id = localStorage.getItem("pt_device_id");
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
    localStorage.setItem("pt_device_id", id);
  }
  return id;
}

function getOrAskHouseholdCode() {
  const fromUrl = urlParams.get("household");
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

const ME = getOrCreateDeviceId();
const HOUSEHOLD = getOrAskHouseholdCode();
const householdRef = doc(db, "households", HOUSEHOLD);

// ------------------------------------------------------------
// INITIALIZE the pillbox document if it doesn't exist yet
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
    await setDoc(householdRef, {
      slots,
      totalPills: TOTAL_PILLS,
      water: { pink: 100, black: 100 },
    });
  } else if (!snap.data().water) {
    // Upgrading a household document created before the water
    // feature existed — add default levels without touching pills.
    await setDoc(householdRef, { water: { pink: 100, black: 100 } }, { merge: true });
  }
}

// ------------------------------------------------------------
// REAL-TIME SYNC: this listener fires instantly on BOTH phones
// whenever either person logs or undoes a pill.
// ------------------------------------------------------------
function listenForChanges(onUpdate) {
  return onSnapshot(householdRef, (snap) => {
    if (snap.exists()) {
      onUpdate(snap.data());
    }
  });
}

// ------------------------------------------------------------
// TAKE A PILL — race-condition safe.
// Uses a Firestore transaction: it re-reads the slot at the
// moment of writing. If the other person already logged it
// a split second earlier, this throws and we tell the UI
// "already taken" instead of silently double-logging.
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
        takenAt: new Date().toISOString(), // stored as ISO so both phones show it identically
      };

      tx.update(householdRef, { slots });
    });

    // Fire a push notification to the other person (see notifications.js)
    notifyOtherPerson(`Pill logged 💊`, `Taken at ${new Date().toLocaleTimeString()}`);
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
// UNDO — puts the slot back to "not taken" so it can be logged
// again. Either person can undo (matches "cancel the log if we
// made a mistake").
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

  notifyOtherPerson(`Pill log undone`, `Slot ${slotIndex + 1} is available again`);
}

// ------------------------------------------------------------
// NEW PACK — resets every slot back to untaken. Use this once
// a pack/case is finished and you're starting a fresh one.
// ------------------------------------------------------------
async function resetPack() {
  const slots = Array.from({ length: TOTAL_PILLS }, (_, i) => ({
    index: i,
    taken: false,
    takenBy: null,
    takenAt: null,
  }));
  // merge:true so this only touches pill slots, not water levels
  await setDoc(householdRef, { slots, totalPills: TOTAL_PILLS }, { merge: true });
  notifyOtherPerson(`New pack started 💊`, `All ${TOTAL_PILLS} pills are back online`);
}

// ------------------------------------------------------------
// WATER TRACKER — two independent bottles (pink / black), each
// 0-100%. Dragging a bottle on one phone writes here, which
// pushes the update to the other phone via the same onSnapshot
// listener that already drives the pillbox.
// ------------------------------------------------------------
async function setWaterLevel(bottleKey, percent) {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  await updateDoc(householdRef, { [`water.${bottleKey}`]: clamped });
}

async function refillWater(bottleKey) {
  await setWaterLevel(bottleKey, 100);
}

// ------------------------------------------------------------
// PUSH SUBSCRIPTIONS: register this device to receive pushes,
// store the subscription in Firestore so the *other* person's
// device can find it and send to it.
// ------------------------------------------------------------
async function registerForPush() {
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const isStandalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true;

  // iOS only exposes PushManager/Notification permission inside an
  // installed (Add to Home Screen) app, opened from its own icon —
  // never inside a regular Safari tab. Detect this specifically so
  // the UI can tell the person what to do, instead of failing silently.
  if (isIOS && !isStandalone) {
    return { ok: false, reason: "ios-not-installed" };
  }

  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    return { ok: false, reason: "unsupported" };
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

  // Save this device's subscription under its owner's name,
  // so the other person can send pushes to it.
  await setDoc(doc(db, "households", HOUSEHOLD, "subscriptions", ME), {
    subscription: sub.toJSON(),
    updatedAt: serverTimestamp(),
  });

  return { ok: true };
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

// ------------------------------------------------------------
// UNSUBSCRIBE this device from push (used when muting). Removes
// the browser-level subscription AND the Firestore record so the
// other person's device stops trying to send to it.
// ------------------------------------------------------------
async function unregisterPush() {
  if (!("serviceWorker" in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration("./service-worker.js");
    const sub = reg && (await reg.pushManager.getSubscription());
    if (sub) await sub.unsubscribe();
  } catch (err) {
    console.warn("Failed to unsubscribe push:", err);
  }
  try {
    await deleteDoc(doc(db, "households", HOUSEHOLD, "subscriptions", ME));
  } catch (err) {
    console.warn("Failed to remove subscription doc:", err);
  }
}

// ------------------------------------------------------------
// SEND NOTIFICATION: calls our tiny serverless function
// (api/send-notification.js) which does the actual Web Push
// send server-side (browsers can't push directly to each other).
// ------------------------------------------------------------
async function notifyOtherPerson(title, body) {
  try {
    await fetch("/api/send-notification", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        household: HOUSEHOLD,
        excludeName: ME, // don't notify yourself
        title,
        body,
      }),
    });
  } catch (err) {
    console.warn("Notification send failed (non-fatal):", err);
  }
}

// ------------------------------------------------------------
// PUBLIC API for your UI code (style.css / your rendering) to use
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
  registerForPush,
  unregisterPush,
  setWaterLevel,
  refillWater,
};

// Let the classic (non-module) script in index.html know it's safe
// to read window.PillTracker now — module scripts run after the
// page has parsed, so anything relying on this can't just run
// top-level in that script; it has to wait for this event.
window.dispatchEvent(new CustomEvent("pilltracker-ready"));

// ------------------------------------------------------------
// BOOT
// ------------------------------------------------------------
(async function boot() {
  await ensurePillboxExists();

  listenForChanges((data) => {
    // Call into your rendering function — you control the look.
    if (typeof window.renderPillbox === "function") {
      window.renderPillbox(data.slots, { me: ME, takePill, undoPill });
    }
    if (typeof window.renderWaterTab === "function") {
      window.renderWaterTab(data.water);
    }
  });

  // Ask for notification permission once, ideally after a user tap
  // (iOS requires a user gesture — see README for the button pattern).
})();
