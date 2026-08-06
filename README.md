# Kukuroo

Send Web Push notifications to your own devices from anything.

A Cloudflare Worker plus KV that stores push subscriptions, serves the iOS
Add-to-Home-Screen enrolment page, and exposes one authenticated `POST`.
TypeScript, zero runtime dependencies, Declarative Web Push, no third-party
service.

There is no server to run: no host, no TLS to renew, no process to keep alive.
You keep the keys. The push service relays ciphertext it cannot read, and no
notification vendor sits in the middle.

```
anything holding the send token              the platform push service
(curl, cron, CI, your backend)               (web.push.apple.com)
         |                                             ^
         |  POST /push/send                            |  RFC 8291 ciphertext,
         v                                             |  VAPID ES256 signed
  +------------------+   one encrypt+sign per device   |
  | Kukuroo (Worker) |---------------------------------+
  +------------------+
         |
  [ KV: subscriptions ]  <--  POST /push/subscribe  <--  the enrolment page,
                                                         on your Home Screen
```

**Status: early, and not yet on npm.** The code works and is tested end to end
against a real iPhone, but it has been installed by exactly one person, who
wrote it. Until `0.1.0` is published, substitute `github:saiday/kukuroo`
wherever the instructions say `kukuroo` (including the copied template's
dependency). Expect rough edges, and please report them.

The two permanence rules come first because they are the two mistakes that
cannot be undone, and people hit them before they write any code.

- [Two things are permanent](#two-things-are-permanent)
- [Setup](#setup)
- [Using Kukuroo with an existing website](#using-kukuroo-with-an-existing-website)
- [iOS notes](#ios-notes)
- [API](#api)
- [Alternatives](#alternatives)
- [Development](#development)
- [Contributing](#contributing)

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
// wrangler.jsonc, with a domain
"workers_dev": false,
"preview_urls": false,
"routes": [{ "pattern": "push.example.com", "custom_domain": true }]

// wrangler.jsonc, without one
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

You need a Cloudflare account (the free plan is enough; see
[the fan-out ceiling](#how-many-devices-one-send-can-reach)), Node 22.6 or
later, and a device on iOS 18.4+ or macOS Safari 18.4+ to receive.

The order is the point. Everything up to step 5 happens before any device is
touched.

**1. Copy the template and decide the origin.**

```sh
npm install kukuroo
cp -r node_modules/kukuroo/templates/standalone my-kukuroo && cd my-kukuroo
npm install
```

Open `wrangler.jsonc` and pick one of the origin options it offers: your own
hostname, or `workers.dev`. Everything else in it is already set, including the
`KUKUROO_SUBS` KV binding, whose name is not configurable; the namespace itself
is provisioned automatically on the first deploy.

This is the decision that cannot be taken back once a device is enrolled.

*Mounting into a Worker you already have instead?* Skip the template. Import
`mountKukuroo`, leave `standalone` off, add the KV binding, and serve enrolment
from your own page. See [API](#api).

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

**3. Deploy, and probe it.**

```sh
npx wrangler deploy
curl -s https://push.example.com/push/public-key
# expect: {"publicKey":"BA..."}
```

That one probe proves three things at once: the deploy reached the origin, the
secrets are installed, and the VAPID key imports cleanly. An error body here
names the missing piece.

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
back, with no copy anywhere else, and the overwrite guard would then refuse the
retry, locking the safe with the only key inside it.

---

## Using Kukuroo with an existing website

The short version: **Kukuroo does not need to live on your website's domain.**

A push subscription is bound to exactly two things: the origin of the page the
device enrolled from (rule 1), and the VAPID keypair (rule 2). The Worker's own
address is neither. Whatever sends notifications only needs to reach
`/push/send` over HTTPS, and the push service neither knows nor cares where that
request came from. So the real question is not "how do I bind Kukuroo to my
domain" but "which origin should devices enrol on", and there are five shapes:

**1. Its own origin, notifying you.** The default, and what the template
deploys. Kukuroo lives at `push.example.com` or `workers.dev`, you add its
enrolment page to your Home Screen, and your website is not involved at all.
Your site's backend on AWS, GCP, or anywhere else is just one more thing holding
the send token and calling `POST /push/send` when something happens. For "my
server should be able to page me", this shape is complete.

**2. Mounted into a Worker you already have.** Your site is itself a Cloudflare
Worker: import `mountKukuroo` and the push routes share your site's origin.
Serve the bundled page from any route of yours with the exported
`enrolmentPage()`, or build your own UI against `/push/subscribe`.

**3. On your site's own hostname, via a route.** Your site is hosted anywhere,
but its DNS is proxied through Cloudflare: attach the standalone Worker to a
path on the hostname you already have, and Cloudflare intercepts those requests
before they reach your origin server, which never sees them.

```jsonc
// wrangler.jsonc, replacing the custom_domain route
"routes": [{ "pattern": "www.example.com/push/*", "zone_name": "example.com" }]
```

Enrolment then happens at `https://www.example.com/push/enroll`, on your site's
own origin, so a notification tap lands back inside your site. Set
`KUKUROO_NAVIGATE_ORIGIN` to match. This asks nothing of your origin server, but
it does require the zone: Worker routes only exist on domains active on
Cloudflare. If your DNS lives elsewhere, use shape 4.

**4. Behind your own reverse proxy.** You control a server or CDN in front of
your site: proxy `/push/*` to the Worker's `workers.dev` hostname (an nginx
`location`, a CloudFront behavior), with `workers_dev` left on so the Worker has
an address to proxy to. Same result as shape 3, with the proxied hop owned by
you instead of Cloudflare. It must be a real proxy that rewrites the Host
header; a bare DNS CNAME pointed at `workers.dev` is not one, and fails at
Cloudflare's edge. The `workers.dev` address is plumbing in this shape: enrol
only through your site's hostname, because a device enrolled directly at
`workers.dev` is on the wrong origin, which is rule 1's mistake.

**5. Anywhere, cross-origin from the browser.** A fully static site (GitHub
Pages, an S3 bucket), no proxy, DNS not on Cloudflare: set
`KUKUROO_ALLOWED_ORIGINS` to your site's exact origin and have your page call
the Worker's absolute URLs. `subscribe` and `public-key` then answer
cross-origin requests from exactly those origins, on every response including
the error ones, so your page can show what went wrong. `/push/send` never gets
CORS headers, whatever the list says: the send token is a server secret, and a
page that holds one should fail its first test, not work quietly until someone
views source.

Four caveats for shapes 2 to 5:

- The enrolled origin becomes **your site's** hostname, so rule 1 now applies to
  it. Site hostnames are things nobody renames, which is exactly why this is the
  recommended place to be.
- Receiving is a Safari-family affair today: no other engine has shipped
  Declarative Web Push yet (Chromium is implementing, Mozilla's position is
  positive), so visitors on other browsers are turned away by the enrolment
  check rather than left half-working.
- On iOS the enrolling page must still be installed to the Home Screen, so the
  site needs the installability metadata (`apple-mobile-web-app-capable`, or a
  web app manifest). If you build your own UI, `src/enroll-page.ts` is the
  fifteen lines of client JS to copy.
- The invite code is one shared secret, designed for devices *you invite*, not
  for anonymous visitor signup. Before pointing any crowd at an enrolment page,
  read [the fan-out ceiling](#how-many-devices-one-send-can-reach).

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

## API

```
POST /push/send        bearer token   RFC 8291 aes128gcm + VAPID ES256, fans out
POST /push/subscribe   invite-gated   stores the subscription in KV
GET  /push/public-key  open           the VAPID public key, for the client
GET  /push/enroll      open           the bundled enrolment page (standalone only)
```

With `KUKUROO_ALLOWED_ORIGINS` set, `subscribe` and `public-key` also answer
`OPTIONS` preflights from the listed origins; `send` never does.

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

Three optional vars:

- `KUKUROO_VAPID_SUBJECT`: the VAPID `sub` claim, a `mailto:` or `https:` URI.
  Defaults to the push service's own origin, which is accepted but identifies
  nobody.
- `KUKUROO_ALLOWED_ORIGINS`: comma-separated exact origins whose pages may call
  `subscribe` and `public-key` from the browser, for shape 5 of
  [the website section](#using-kukuroo-with-an-existing-website). Unset, no
  CORS headers are sent. There is no wildcard: the list of pages that may enrol
  a device is short, and writing it out is the point.
- `KUKUROO_NAVIGATE_ORIGIN`: if set, every notification's `navigate` must be on
  this origin. **Set it.** Mounting Kukuroo into your own Worker is what keeps
  taps inside the installed web app, but mounting alone only makes that likely;
  this makes it enforced. A `navigate` that leaves the origin ejects the user
  into a browser tab. It does not restrict `icon`, which legitimately points at
  a CDN.

Also exported: `enrolmentPage(options)` returns the bundled enrolment page as an
HTML string, so a mounted deployment can serve it from any route on its own
origin instead of building a UI. `buildDeclarativePayload` and `importVapidKeys`
are exported individually too, for callers that want the validation or the key
handling without the routes.

### Sending

```ts
import { send } from "kukuroo";

const result = await send(env, {
  notification: {
    title: "Deploy finished",
    body: "main to production, 42s",
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
latter. **A `delivered` of 0 is a failure, not a quiet success**: it is the only
signal you get that nothing is enrolled.

**Mounted** into an existing Worker, the host serves its own enrolment UI and
posts to `/push/subscribe`. This is the recommended shape: same origin as the app
you already have, which sidesteps every question about where a notification is
allowed to navigate.

**Standalone**, Kukuroo serves the bundled enrolment page at `/push/enroll` and is
a pure notification sink.

### How many devices one send can reach

Two Cloudflare limits apply to a single `/push/send`.

**Subrequests.** Every push POST is an external `fetch`, and the free plan
allows 50 of those per invocation, so **a free-plan send tops out at 50
devices**. (KV traffic is metered separately, as internal-service calls with a
1,000-per-request budget on free, which this arithmetic never approaches.) Past
the 50th device the remaining sends fail into `failures`, and `delivered` says
honestly how far the fan-out got. On the paid plan the limit is 10,000 and
configurable beyond, which moves this ceiling out of a personal deployment's
range.

**CPU.** `/push/send` does one ES256 signature and one aes128gcm encryption per
subscription, all inside a single invocation, against the free plan's 10 ms CPU
budget. Measured against local `workerd` (`wrangler dev`) on an Apple M2 Max,
median of 41 requests per row, with the identical request minus the
per-subscription crypto subtracted so what is left is the fan-out itself:

| subscriptions | fan-out CPU |
|---|---|
| 1 | 0.12 ms |
| 5 | 0.65 ms |
| 20 | 2.4 ms |
| 50 | 6.1 ms |
| 100 | 11.9 ms |

It is linear: about 0.12 ms per subscription, on top of roughly 0.2 ms of fixed
work. The crypto alone crosses 10 ms around 80 subscriptions on that desktop
CPU; Cloudflare's edge hardware is generally slower per core, so on the free
plan's 10 ms budget the CPU ceiling lands in the same region as the subrequest
one. The failure modes differ: running out of subrequests still returns an
honest `SendResult`, while running out of CPU terminates the invocation partway
through the loop and returns an error, so the `delivered` count that would have
told you is gone.

**So: the free plan is comfortable to about 20 devices and has real margin to
50, and 50 is the hard edge, set by subrequests with CPU close behind.** Past
that, the paid plan is required, and it is the plan rather than the code that is
the limit.

There is deliberately no batching of the fan-out across invocations. Splitting
it would trade a limit you can read off a table for a partial-delivery failure
mode you would have to debug, and the honest fix for "more devices than the free
plan allows" is a plan that allows more.

---

## Alternatives

Surveyed 2026-08-02, because "nothing else does this" is the kind of claim a
reader can falsify in one search. The axis that separates Kukuroo is
**serverless**: everything below either runs a process you keep alive or routes
your notifications through a vendor.

- **[ntfy](https://ntfy.sh)**, ~25k stars: self-hosted or hosted pub-sub
  notifications, with Web Push and an installable PWA on iOS. Mature and
  polished; wants a host, a domain, TLS, and a process that stays up. If you are
  happy hosting and want a full app-like UI, use ntfy.
- **[go-notify-server](https://github.com/mpizenberg/go-notify-server)**: the
  closest in spirit, a thin declarative-first Web Push server for your own PWA.
  Docker and SQLite, bring your own enrolment UI.
- **[AlphaPush](https://github.com/alkinum/alphapush)**: the nearest
  architectural twin, also Cloudflare Workers with KV plus D1.
- **[Bark](https://github.com/Finb/Bark)**: iOS notifications through an App
  Store app and APNs rather than Web Push; the server half can run on a Worker.
- **Gotify, Pushover**: an Android-first self-hosted server, and a paid hosted
  service; both deliver through their own apps.

What none of them offer together: no server to run, no vendor in the path, and
the enrolment page ships in the box.

---

## Development

```sh
git clone https://github.com/saiday/kukuroo && cd kukuroo
npm install
npm test            # RFC 8291 + 8292 round-trip, no network needed
npm run typecheck
```

There is no build step. The package ships TypeScript source, and the consumer's
`wrangler` bundles it; that is also why `engines` asks for Node 22.6+, whose
type stripping runs the tests directly.

The test suite plays the part of the device: it decrypts what `encryptPayload`
produced and verifies the VAPID token against the public key, using Node's Web
Crypto as the user agent. A green run means a phone would have displayed the
message, not merely that functions returned.

---

## Contributing

The most valuable report right now is a setup-flow failure. The crypto is
round-trip tested; the installation path has been walked by one person. If
`init`, the first deploy, or enrolment fights you, [an issue][issues] naming the
exact step and what it said is a gift.

Before a pull request: `npm test` and `npm run typecheck` must pass, and two
things are load-bearing everywhere: nothing may fail silently, and nothing may
make either permanent value (the origin, the VAPID keypair) silently
replaceable. Comments in this codebase say *why*, and name the failure mode
their line prevents; new code should too.

[issues]: https://github.com/saiday/kukuroo/issues

---

## Licence

MIT. See [LICENSE](LICENSE).
