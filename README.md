# Kukuroo

Send Web Push notifications to your own devices from anything.

A Cloudflare Worker plus KV that stores push subscriptions, serves the iOS
Add-to-Home-Screen enrolment page, and exposes one authenticated `POST`.
TypeScript, Declarative Web Push, no third-party service.

You keep the keys. Nothing about your notifications passes through anyone else.

**Status: early.** The surface described below is what is being built. The code is
not here yet. The two permanence rules are here first because they are the two
mistakes that cannot be undone, and people hit them before they write any code.

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

So decide the final hostname **first**, attach it as a Custom Domain, and then
shut the other doors:

```jsonc
// wrangler.jsonc
"workers_dev": false,   // no *.workers.dev address for this Worker
"preview_urls": false   // no per-version preview address either
```

Those two lines matter more than they look. A preview URL is a real, working,
enrollable origin, and enrolling against one during a five-minute test produces a
subscription that appears to work and then never delivers anything again.

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

The order is the point. Steps 1 through 4 happen before any device is touched.

**1. Choose the origin and attach it.**
Pick the hostname you will still be using in three years. Add it as a Worker
Custom Domain. Set `workers_dev` and `preview_urls` to `false`. Confirm it serves:

```sh
curl -sI https://push.example.com    # expect: HTTP/2 200
```

**2. Generate every secret, once, in one command.**

```sh
npx kukuroo-init
```

This generates the VAPID keypair, a send token, and an invite code; installs the
three secrets into the Worker; and writes them all to `kukuroo.credentials.json`
at mode 0600. It prints the public key to paste into your `wrangler` config and
the invite code to type into your phone.

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

**3. Deploy.**

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
npx kukuroo-init --rotate send-token
npx kukuroo-init --rotate invite-code
```

Both require `kukuroo.credentials.json`. If you set your deployment up by hand
and have no such file, rotate with `wrangler secret put` directly and start
keeping the value somewhere yourself.

There is no `--rotate` for the VAPID keypair, on purpose. Asking for one prints
an explanation rather than doing it.

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
POST /push/send       bearer token   RFC 8291 aes128gcm + VAPID ES256, fans out
POST /push/subscribe  invite-gated   stores the subscription in KV
GET  /push/enroll     the enrolment page (standalone mode)
```

```ts
interface KukurooEnv {
  KUKUROO_SUBS:          KVNamespace
  KUKUROO_VAPID_PRIVATE: string   // Worker Secret
  KUKUROO_VAPID_PUBLIC:  string
  KUKUROO_SEND_TOKEN:    string   // Worker Secret
  KUKUROO_INVITE_CODE:   string   // Worker Secret
}

mountKukuroo(env, { prefix: "/push" })
send(env, { topic, notification })
```

**Mounted** into an existing Worker, the host serves its own enrolment UI and
posts to `/push/subscribe`. This is the recommended shape: same origin as the app
you already have, which sidesteps every question about where a notification is
allowed to navigate.

**Standalone**, Kukuroo serves the bundled enrolment page at `/push/enroll` and is
a pure notification sink.

---

## Licence

Not yet chosen. Until one is added, default copyright applies.
