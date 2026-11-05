# Kuhit

Kuhit (poke) people nearby who also have the app, so making the first move feels light.
Built in Cagayan de Oro, 18+ only. An installable PWA: no build step, no dependencies.

**The loop:** take today's selfie → show up to people nearby as a blurred photo and a one-line
status → send a **Friendly** or **Crush** kuhit → if they kuhit back, both selfies unblur and a chat
opens.

Screens follow the Kuhit Figma file ("MVP screens", sections 1-8): onboarding and sign-up,
verification, daily check-in, nearby, sending a kuhit, receiving and mutual, chats and safety,
me and settings. Brand: Jeepney Pop (Archivo Black + Space Grotesk; red `#E63946`, yellow
`#FFD60A`, blue `#1D4ED8`, ink `#111111`, cream `#FFF8E1`).

## Run it

```bash
python3 -m http.server 8000
```

Open http://localhost:8000. Camera and location need `localhost` or HTTPS (GitHub Pages is fine).
On a phone, open the site and use **Add to Home Screen** to install it.

## Demo mode

While [`firebase-config.js`](firebase-config.js) is `null`, Kuhit runs in demo mode: data stays in
this browser, any 6-digit code signs you in, and six simulated people around you kuhit you, kuhit
back and reply in chat. Where there's no camera (desktop), demo mode offers stand-in selfies and ID
photos so every screen can still be reached.

## Going live with Firebase

1. Create a project at https://console.firebase.google.com (Analytics not needed).
2. **Build → Authentication → Get started**, enable **Phone** (and **Google** as a fallback).
   Phone sign-in sends real SMS only on the **Blaze** (pay as you go) plan; on the free plan,
   add test numbers under **Phone → Phone numbers for testing**, or use Google.
3. **Authentication → Settings → Authorized domains**: add your GitHub Pages domain.
4. **Build → Firestore Database → Create database** (production mode, region `asia-southeast1`),
   then paste [`firestore.rules`](firestore.rules) into the **Rules** tab and publish.
5. **Project settings → Your apps → Web (`</>`)**: register an app and paste its `firebaseConfig`
   into [`firebase-config.js`](firebase-config.js). Bump the `?v=` numbers in `index.html` and
   `VERSION` in `sw.js`.

The nearby query (`profiles` where `cell in [...]`) needs no composite index.

## How the privacy rules are enforced

There is no server and no Cloud Functions: [`firestore.rules`](firestore.rules) is the backend.

| Rule from the proposal | How |
| --- | --- |
| Sender hidden until mutual | `kuhits/<from>_<to>` is readable only by the sender. The receiver gets `inbox/<to>/items/<from>` with the type and time, and sees only a blurred photo. |
| Blurred selfie until mutual | People nearby get a 12 × 12 pixel thumbnail (`profiles.blur`). The clear selfie (`selfies/<uid>`) is readable only by the owner and their matches. |
| Selfies expire after 24 h | Matches can't read a selfie older than 24 h; you can't be seen or send kuhits without a fresh one. |
| No gallery uploads | Selfies come from the in-app camera only (`getUserMedia`); there is no file picker. |
| Daily kuhit limit (5) | `limits/<uid>` must go up by exactly one with each new kuhit, resets on a new day (Philippine time), and can't be deleted. |
| Mutual reveal | `matches/<a>_<b>` can only be created when both kuhits exist; names (`names/<uid>`) are readable only by matches. |
| Approximate location | Coordinates are rounded to 3 decimals (~110 m) on the device; distance shows as `~50m`, `~100m`… never a pin. Only the latest spot is kept, and **Delete my location now** clears it. |
| Notification copy | Always "Someone kuhit you!" + the type, never the sender, never "Naay nikuhit nimo". |
| Block and report | On every chat. Blocking deletes the match and stops that person's kuhits (`blocks/<uid>`); reports go to `reports/`. |
| 18+ only | Birthdate under 18 can't sign up (checked in the app and in the rules). |

## Not real yet (needs a server or a partner)

- **Face (liveness) and ID checks** are placeholders: the camera steps run, but nothing is checked,
  and the app marks the account verified itself. Before launch, connect Yoti, Persona or Veriff so
  the partner, through a small server, sets `users/<uid>.verified` (and lock that field in the rules).
  The ID photo is never uploaded.
- **Push notifications while the app is closed** need Firebase Cloud Messaging plus a server to
  send them. Today notifications show while Kuhit is open or in the background.
- **Location history auto-delete**: only the latest spot is stored. To also purge stale profiles
  after 24 h, add a Firestore TTL policy on `profiles.seenAt`.
- Later features from the proposal (Nakasabay, chat expiry, Hotspots, Kuhit+, Kuhit spots).

## Files

- `index.html`, `css/app.css`: shell and Jeepney Pop styles
- `js/app.js`: every screen, routing and flows
- `js/backend-firebase.js`, `js/backend-demo.js`: same interface, Firebase or on-device demo
- `js/geo.js`: geohash cells, rounding, distance buckets; `js/camera.js`: in-app camera and blur
- `firestore.rules`: the privacy and safety rules
- `manifest.webmanifest`, `sw.js`, `icons/`: installable PWA
