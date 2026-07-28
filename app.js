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
// IDENTITY: "who am I" (her or you), and the shared household code
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
    await setDoc(householdRef, { slots, totalPills: TOTAL_PILLS });
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
    notifyOtherPerson(`${ME} logged a pill 💊`, `Taken at ${new Date().toLocaleTimeString()}`);
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

  notifyOtherPerson(`${ME} undid a pill log`, `Slot ${slotIndex + 1} is available again`);
}

// ------------------------------------------------------------
// PUSH SUBSCRIPTIONS: register this device to receive pushes,
// store the subscription in Firestore so the *other* person's
// device can find it and send to it.
// ------------------------------------------------------------
async function registerForPush() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    console.warn("Push not supported on this browser/device.");
    return;
  }

  const reg = await navigator.serviceWorker.register("./service-worker.js");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return;

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
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
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
  registerForPush,
};

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
  });

  // Ask for notification permission once, ideally after a user tap
  // (iOS requires a user gesture — see README for the button pattern).
})();
