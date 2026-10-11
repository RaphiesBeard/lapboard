# Lapboard

Lap timing and results for informal cyclocross races and series.

- **Public results** at `/#/`: series, published race results and series standings. No sign-in.
- **Organisers** at `/#/admin`: sign in with Google to set up series, register riders, create races, review laps and publish results.
- **Timekeepers** use a link per race (`/#/t/RACE/KEY`) sent by text or WhatsApp. It allows check-in and timing for that race only, with no account.

It is a static site (plain HTML, CSS and JavaScript, no build step) using Firebase Firestore for data and Firebase Auth for organiser sign-in.

## Setup

1. **Firebase project.** In the [Firebase console](https://console.firebase.google.com): create a project, create a Firestore database (production mode), enable the Google and Email/Password sign-in providers under Authentication, and register a Web app. Paste its `firebaseConfig` into `config.js`.
2. **Owner.** Put the owner's Google email in `ownerEmails` in `config.js` and in `isOwner()` in `firestore.rules` (lower case).
3. **Security rules.** In the console, open Firestore → Rules, replace everything with the contents of `firestore.rules`, and publish.
4. **Hosting.** In the GitHub repository, Settings → Pages → Deploy from a branch → `main` / `(root)`.
5. **Sign-in domain.** In Firebase, Authentication → Settings → Authorized domains, add `YOURNAME.github.io`.

Other organisers are added by the owner on the Organisers page in the app, either by Google email or with a username and password the owner creates there (stored as `USERNAME@<authDomain>` accounts).

A how-to guide for riders, timekeepers and organisers is built in at `/#/help`.

## How data is stored

| Path | Who can read | Who can write |
| --- | --- | --- |
| `series/{id}`: name, points table, riders | everyone | organisers |
| `races/{id}`: name, date, review edits, published results | everyone | organisers |
| `raceKeys/{id}`: the timekeeper link key | organisers | organisers |
| `races/{id}/live/{key}`: start time, laps target, check-in, DNFs, riders a timekeeper registered (`newRiders`, copied into the series next time an organiser opens Lapboard) | link holders, organisers | link holders, organisers |
| `races/{id}/live/{key}/taps/{device}`: each phone's lap taps | link holders, organisers | link holders, organisers |
| `config/organisers`: extra organiser emails and usernames | organisers | owner |

Replacing a race's timekeeper link moves its timing data to a new key, so the old link stops working.

## Tests

```
npm i -g playwright            # browser tests use Chromium
node test/e2e.js               # app logic against an in-memory backend (test/mock.html)
```

`firestore.rules` was also checked against the Firestore emulator (public, timekeeper, organiser and owner access).
