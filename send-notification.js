// ============================================================
// api/send-notification.js
// Deploy this on Vercel (free). It's the only "server" this app
// needs. It looks up the OTHER person's push subscription in
// Firestore and sends them a real push notification, even if
// their phone's screen is off / app is closed.
//
// Env vars needed (set in Vercel dashboard, free):
//   VAPID_PUBLIC_KEY
//   VAPID_PRIVATE_KEY
//   FIREBASE_SERVICE_ACCOUNT_JSON  (stringified service account key)
//
// npm packages needed (see package.json): web-push, firebase-admin
// ============================================================

import webpush from "web-push";
import admin from "firebase-admin";

// --- init firebase-admin once (reused across warm invocations) ---
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}
const db = admin.firestore();

webpush.setVapidDetails(
  "mailto:you@example.com",
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { household, excludeName, title, body } = req.body;

    if (!household || !title) {
      return res.status(400).json({ error: "Missing household or title" });
    }

    const subsSnap = await db
      .collection("households")
      .doc(household)
      .collection("subscriptions")
      .get();

    const sends = [];

    subsSnap.forEach((docSnap) => {
      const name = docSnap.id;
      if (name === excludeName) return; // don't notify yourself

      const { subscription } = docSnap.data();
      if (!subscription) return;

      sends.push(
        webpush
          .sendNotification(
            subscription,
            JSON.stringify({ title, body })
          )
          .catch((err) => {
            console.warn(`Push failed for ${name}:`, err.message);
          })
      );
    });

    await Promise.all(sends);

    return res.status(200).json({ ok: true, sentTo: sends.length });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}
