# Kukuroo

Send Web Push notifications to your own devices from anything.

A Cloudflare Worker plus KV that stores push subscriptions, serves the iOS
Add-to-Home-Screen enrolment page, and exposes one authenticated `POST`.
TypeScript, Declarative Web Push, no third-party service.

You keep the keys. Nothing about your notifications passes through anyone else.

**Status: early.** The code works and is tested end to end against a real iPhone,
but it has been installed by exactly one person, who wrote it. Expect rough
edges, and please report them. The two permanence rules come first because they
are the two mistakes that cannot be undone, and people hit them before they write
any code.

---

## Two things are permanent

Both of these destroy every existing subscription **silently**. Nothing logs an
error, nothing returns a 4xx, no event fires on the device. Notifications simply
stop arriving, and you find out days later when you notice the quiet.

Read these before you deploy anything.

### 1. Choose the origin before anyone enrols, and never change it

A push subscription is bound to an **origin**. `https://push.example.com` and
`https://kukuroo.your-subdomain.workers.dev` are different origins, so a
subscription created against one is worthless against the other. There is no
migration path and no way to re-point an existing subscription: every device has
to be enrolled again by hand.

So decide the final hostname **first**, and then shut the doors you are not using.

**`preview_urls: false` is not optional.** A preview URL is a real, working,
enrollable origin, and it is *per version*. Enrol against one during a
five-minute test and you get a subscription that appears to work and then never
delivers anything again.

**A custom domain is recommended, but `workers.dev` is supported.** If you do not
have a domain on Cloudflare, `<worker>.<subdomain>.workers.dev` is a legitimate
permanent origin: it is stable indefinitely. Two things move it, and both are
under your control, so treat them as one-way doors:

- **never rename the Worker**, and
- **never change your account subdomain**.

```jsonc
// wrangler.jsonc — with a domain
"workers_dev": false,
"preview_urls": false,
"routes": [{ "pattern": "push.example.com", "custom_domain": true }]

// wrangler.jsonc — without one
"workers_dev": true,
"preview_urls": false
```

### 2. Generate the VAPID keypair once, and never rotate it

The VAPID keypair identifies your sender to the push service. Every stored
subscription is bound to the public key it was created with. Regenerate the
keypair and every one of them stops accepting your messages, silently, exactly as
in rule 1.

Generate it once. Store the private key as a Worker Secret. **Keep an offline copy
somewhere you will still have in three years**, because losing it forces
regeneration, and regeneration is the failure above. A password manager entry is
enough; the point is that it is not only in Cloudflare.

Do not put the private key on the machine that sends notifications. It calls
`/push/send` with a bearer token instead, so the key lives in exactly one place.

---

## Setup

The order is the point. Everything up to step 5 happens before any device is
touched.

**1. Copy the template and decide the origin.**

```sh
npm install kukuroo
cp -r node_modules/kukuroo/templates/standalone my-kukuroo && cd my-kukuroo
npm install
```

Open `wrangler.jsonc` and pick one of the two origin options it offers: your own
hostname, or `workers.dev`. Everything else in it is already set, including the
`KUKUROO_SUBS` KV binding, whose name is not configurable.

This is the decision that cannot be taken back once a device is enrolled.

*Mounting into a Worker you already have instead?* Skip the template. Import
`mountKukuroo`, leave `standalone` off, add the KV binding, and serve enrolment
from your own page. See **Surface** below.

**2. Generate every secret, once, in one command.**

```sh
npx kukuroo init
```

This generates the VAPID keypair, a send token, and an invite code; installs the
three secrets into the Worker; writes them all to `kukuroo.credentials.json` at
mode 0600; adds that file to your `.gitignore`; and prints the invite code.

**Nothing to paste into `wrangler.jsonc`.** The keypair is stored as a JWK, so
the public half is derived from it and served at `/push/public-key`. Two values
that have to agree forever is a failure waiting to happen, so there is one.

**Keep that file.** It is not a convenience, it is the only copy. A Worker Secret
is write-only: `wrangler secret list` returns names and never values, so once the
VAPID private key is in Cloudflare and nowhere else, it is gone. Back the file up
somewhere you will still have in three years.

The script refuses to run if `KUKUROO_VAPID_PRIVATE` already exists, because
`wrangler secret put` overwrites without asking and overwriting that one is the
silent-death failure above.

*Doing it by hand instead?* Generate all four values **before** you touch
Cloudflare, and write them down first. The trap is generating a send token,
piping it straight into `wrangler secret put`, and discovering at first send that
there is no way to read it back.

Run this **before** the first deploy if you like; `wrangler secret put` creates a
draft Worker on demand.

**3. Deploy.**

```sh
npx wrangler deploy
curl -sI https://push.example.com    # expect: HTTP/2 200
```

The deploy is what attaches the custom domain and provisions the KV namespace.
Give it a couple of minutes: for two to three minutes afterwards the origin
serves a mix of old and new versions, and newly added static assets 404.

**4. Put the send token where your sender can read it.**

```sh
node -p 'require("./kukuroo.credentials.json").sendToken' > ~/.kukuroo-send-token
chmod 600 ~/.kukuroo-send-token
```

Do this now rather than later. Every other step is about the device; this is the
one that makes `POST /push/send` usable, and it is easy to walk past.

**5. Now enrol a device.**
On iOS: open the origin in Safari, **Add to Home Screen**, **open it from the
icon**, then enable notifications and enter the invite code.

Enrolling from a Safari tab does not work on iOS. This is the step people get
wrong, which is why it is last.

### Rotating

Only the VAPID keypair is permanent. The other two are not bound to anything and
can be replaced whenever you like, with no device re-enrolling:

```sh
npx kukuroo rotate send-token
npx kukuroo rotate invite-code
```

Both require `kukuroo.credentials.json`. If you set your deployment up by hand
and have no such file, rotate with `wrangler secret put` directly and start
keeping the value somewhere yourself.

There is no rotate for the VAPID keypair, on purpose. Asking for one prints
an explanation rather than doing it.

### If setup is interrupted

```sh
npx kukuroo init --resume
```

Finishes the job from the local credentials file. The file is written **before**
anything is uploaded, precisely so this is possible: were it the other way round,
a failure partway would leave the VAPID key in Cloudflare, which cannot be read
back, with no copy anywhere else — and the overwrite guard would then refuse the
retry, locking the safe with the only key inside it.

---

## iOS notes

- **Requires iOS 18.4 or later.** Declarative Web Push shipped in Safari 18.4 in
  March 2025. Any claim that it needs iOS 26 is wrong.
- **Add to Home Screen is required.** Web push does not work in a normal Safari
  tab on iOS, though it does on macOS.
- **There is no service worker.** Safari 18.4 exposes `window.pushManager`, so a
  subscription exists without one. That also means there is no
  `pushsubscriptionchange` handler: a dead subscription is discovered from a 410
  on the next send, and re-enrolment is manual.
- **Deleting the Home Screen icon destroys the subscription.** Nothing reports
  this. If notifications matter to you, send yourself a daily "still alive" ping,
  because absence of a scheduled message is the only reliable signal that the
  channel has died.
- **`app_badge` moved position between Safari versions**, and Apple never
  documented the move: inside `notification` on 18.4 through 18.6, top level on
  26.0 and later. Kukuroo emits it in **both** positions, so callers never have
  to know which iOS a device is on. Measured on iOS 26.5.2: the top-level
  position sets the badge and the one inside `notification` is ignored entirely,
  so this is not theoretical tidiness.
- **There is no badge-only or silent update.** `title` and `navigate` are
  required on every message, so every push displays a notification. `silent: true`
  suppresses sound, not the banner. If you want to change the badge, you are also
  showing the user something.

---

## Surface

```
POST /push/send        bearer token   RFC 8291 aes128gcm + VAPID ES256, fans out
POST /push/subscribe   invite-gated   stores the subscription in KV
GET  /push/public-key  open           the VAPID public key, for the client
GET  /push/enroll      open           the bundled enrolment page (standalone only)
```

```ts
interface KukurooEnv {
  KUKUROO_SUBS:          KVNamespace
  KUKUROO_VAPID_PRIVATE: string   // Worker Secret. A JWK; see below
  KUKUROO_SEND_TOKEN:    string   // Worker Secret
  KUKUROO_INVITE_CODE:   string   // Worker Secret
  KUKUROO_VAPID_PUBLIC?: string   // only if the key is a bare 32-byte scalar
}

// `env` is supplied per request, not at construction, because that is how
// Workers hand it to you.
const kukuroo = mountKukuroo({ prefix: "/push", standalone: false })
await kukuroo.handle(request, env)   // Response, or null if the path is not ours
```

Two optional vars:

- `KUKUROO_VAPID_SUBJECT` — the VAPID `sub` claim, a `mailto:` or `https:` URI.
  Defaults to the push service's own origin, which is accepted but identifies
  nobody.
- `KUKUROO_NAVIGATE_ORIGIN` — if set, every notification's `navigate` must be on
  this origin. **Set it.** Mounting Kukuroo into your own Worker is what keeps
  taps inside the installed web app, but mounting alone only makes that likely;
  this makes it enforced. A `navigate` that leaves the origin ejects the user
  into a browser tab. It does not restrict `icon`, which legitimately points at
  a CDN.

### Sending

```ts
import { send } from "kukuroo";

const result = await send(env, {
  notification: {
    title: "Deploy finished",
    body: "main → production, 42s",
    navigate: "https://push.example.com/deploys",  // required, and absolute
    tag: "deploys",                                 // replaces its predecessor
  },
  appBadge: 1,
});

// { delivered: 1, removed: 0, failures: [] }
if (result.delivered === 0) throw new Error("no devices are enrolled");
```

Or over HTTP, from anything at all:

```sh
curl -X POST https://push.example.com/push/send \
  -H "authorization: Bearer $(cat ~/.kukuroo-send-token)" \
  -H 'content-type: application/json' \
  -d '{"notification":{"title":"hello","navigate":"https://push.example.com/"}}'
```

`navigate` is **required and must be absolute**; so is a non-empty `title`. An
`icon`, if present, must be a valid absolute URL. Get any of those wrong and
WebKit discards the entire message with no error anywhere, so Kukuroo rejects
them before sending rather than letting the failure be silent.

`delivered` counts subscriptions the push service *accepted* the message for.
That is not "displayed on the phone", and nothing in the protocol reports the
latter. **A `delivered` of 0 is a failure, not a quiet success** — it is the only
signal you get that nothing is enrolled.

**Mounted** into an existing Worker, the host serves its own enrolment UI and
posts to `/push/subscribe`. This is the recommended shape: same origin as the app
you already have, which sidesteps every question about where a notification is
allowed to navigate.

**Standalone**, Kukuroo serves the bundled enrolment page at `/push/enroll` and is
a pure notification sink.

---

## Licence

MIT. See [LICENSE](LICENSE).
