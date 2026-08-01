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

**2. Generate the VAPID keypair, once.**
Store the private key as the `KUKUROO_VAPID_PRIVATE` Worker Secret and the public
key as the `KUKUROO_VAPID_PUBLIC` plain var, since the enrolment page needs it
client-side. Back the private key up offline before you continue.

**3. Generate a send token and an invite code.**
Both are Worker Secrets: `KUKUROO_SEND_TOKEN` and `KUKUROO_INVITE_CODE`.

Enrolment is invite-gated for a reason. Without it, anyone who finds the URL can
enrol their own phone and start receiving your notification titles.

**4. Deploy.**

**5. Now enrol a device.**
On iOS: open the origin in Safari, **Add to Home Screen**, **open it from the
icon**, then enable notifications and enter the invite code.

Enrolling from a Safari tab does not work on iOS. This is the step people get
wrong, which is why it is last.

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
