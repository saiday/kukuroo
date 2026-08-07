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
wherever the instructions say `kukuroo`, in both the top-level install and the
`dependencies` of the copied template's `package.json`. Expect rough edges,
and please report them.

- [Setup](#setup)
  - [Standalone](#standalone)
  - [Mounted](#mounted)
- [Using Kukuroo with an existing website](#using-kukuroo-with-an-existing-website)
- [Two things you cannot undo](#two-things-you-cannot-undo)
- [iOS notes](#ios-notes)
- [API](#api)
- [Alternatives](#alternatives)
- [Development](#development)
- [Contributing](#contributing)

---

## Setup

You need a Cloudflare account (the free plan is enough; see
[the fan-out ceiling](#how-many-devices-one-send-can-reach)), Node 22.6 or
later, and a device on iOS 18.4+ or macOS Safari 18.5+ to receive.

### Do you already serve a site from a Cloudflare Worker?

One question decides the rest.

**No** → [**Standalone**](#standalone). Kukuroo deploys as its own Worker at its
own address and serves the enrolment page it ships with. Five commands, no code
to write.

**Yes** → [**Mounted**](#mounted). Three lines in the Worker you already have.
The push routes join your site's origin, so a notification tap lands back inside
your site.

Neither shape has to live on your website's domain, and a static site with no
Worker at all can still enrol devices cross-origin. If neither answer fits,
[Using Kukuroo with an existing
website](#using-kukuroo-with-an-existing-website) lays out all five topologies.

Two values are permanent whichever shape you pick: the **origin** devices enrol
on, and the **VAPID keypair**. Changing either kills every subscription with no
error anywhere. The steps below carry the reminder where it applies; [Two things
you cannot undo](#two-things-you-cannot-undo) is the why.

### Standalone

The order is the point. Everything up to step 5 happens before any device is
touched.

**1. Copy the template and decide the origin.**

```sh
npm install kukuroo
cp -r node_modules/kukuroo/templates/standalone my-kukuroo && cd my-kukuroo
npm install
```

Open `wrangler.jsonc` and pick one of the origin options it offers: your own
hostname, or `workers.dev`. Everything else in it is already set, including
`preview_urls: false` (leave it there: a preview URL is a real, enrollable
origin, and it is *per version*) and the `KUKUROO_SUBS` KV binding, whose name
is not configurable; the namespace itself is provisioned automatically on the
first deploy.

This is the decision that cannot be taken back once a device is enrolled. With
no domain on Cloudflare, `workers.dev` is a legitimate permanent origin, as long
as you never rename the Worker and never change your account subdomain.

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

### Mounted

There is no template to copy here: the origin, the domain, and the deploy
pipeline already exist, and the origin question is already answered, because
your site's hostname is the origin. What is missing is a KV namespace, three
secrets, four routes, and a page a phone can install.

**1. Install it, and hand it your requests first.**

```sh
npm install kukuroo
```

```ts
import { mountKukuroo, type KukurooEnv } from "kukuroo";

// No `standalone`, so `/push/enroll` is not routed at all: you serve your own
// enrolment page, on your own origin, in step 4.
const kukuroo = mountKukuroo({ prefix: "/push" });

export default {
  async fetch(request: Request, env: KukurooEnv): Promise<Response> {
    const hit = await kukuroo.handle(request, env);
    if (hit !== null) return hit;
    return yourExistingRouter(request, env);
  },
};
```

`handle` returns `null` for every path outside `prefix`, so your own routing is
untouched. Pick a `prefix` that does not collide with a route you already serve;
`/push` is the default.

**2. Add the KV binding and the navigate origin.**

```jsonc
// your existing wrangler.jsonc
"kv_namespaces": [{ "binding": "KUKUROO_SUBS" }],
"vars": {
  "KUKUROO_NAVIGATE_ORIGIN": "https://www.example.com"
}
```

`KUKUROO_SUBS` is not configurable; Kukuroo looks for exactly that name. Leaving
out `id` lets wrangler create the namespace on your next deploy.
`KUKUROO_NAVIGATE_ORIGIN` is what keeps a notification tap inside the installed
web app: mounting makes same-origin *likely*, and this makes it enforced.

**3. Generate every secret, once, in one command.**

```sh
npx kukuroo init
```

Run it from the directory holding your `wrangler.jsonc`, so it talks to the
Worker you mean. It generates the VAPID keypair, a send token, and an invite
code; installs the three secrets into the Worker; writes them all to
`kukuroo.credentials.json` at mode 0600; adds that file to your `.gitignore`;
and prints the invite code.

**Keep that file.** It is not a convenience, it is the only copy. A Worker Secret
is write-only: `wrangler secret list` returns names and never values, so once the
VAPID private key is in Cloudflare and nowhere else, it is gone. Back it up
somewhere you will still have in three years.

**4. Serve an enrolment page on your own origin.**

The page Kukuroo ships, from any route of yours:

```ts
import { enrolmentPage } from "kukuroo";

if (url.pathname === "/notifications") {
  return new Response(
    enrolmentPage({
      subscribePath: "/push/subscribe",
      publicKeyPath: "/push/public-key",
    }),
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}
```

Or build your own UI against `POST /push/subscribe`; `src/enroll-page.ts` is the
fifteen lines of client JS to copy. Either way, on iOS the page has to be
installable (`apple-mobile-web-app-capable`, or a web app manifest), because
enrolment only works from the Home Screen icon.

**5. Deploy, probe, then enrol.**

```sh
npx wrangler deploy
curl -s https://www.example.com/push/public-key
# expect: {"publicKey":"BA..."}
```

That one probe proves three things at once: the routes are mounted, the secrets
are installed, and the VAPID key imports cleanly. An error body here names the
missing piece.

Then the phone, and only then: open your enrolment page in Safari, **Add to Home
Screen**, **open it from the icon**, and enter the invite code. Enrolling from a
Safari tab does not work on iOS.

**To send from your own Worker, skip the token entirely.** It already holds the
bindings, so `import { send } from "kukuroo"` and call `send(env, ...)` in
process; see [Sending](#sending). The send token exists for callers *outside* the
Worker, and it is in `kukuroo.credentials.json` under `sendToken`.

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

A push subscription is bound to exactly two things, and they are [the two you
cannot undo](#two-things-you-cannot-undo): the origin of the page the device
enrolled from, and the VAPID keypair. The Worker's own address is neither. Whatever sends notifications only needs to reach
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
`enrolmentPage()`, or build your own UI against `/push/subscribe`. Steps in
[Mounted](#mounted).

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
`workers.dev` is on an origin you are not going to keep serving from, which is
the [permanent](#two-things-you-cannot-undo) mistake.

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

- The enrolled origin becomes **your site's** hostname, so the
  [permanence](#two-things-you-cannot-undo) applies to it. Site hostnames are
  things nobody renames, which is exactly why this is the recommended place to
  be.
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

## Two things you cannot undo

Two values are permanent, and changing either destroys every existing
subscription **silently**: nothing logs an error, nothing returns a 4xx, no event
fires on the device. Notifications simply stop arriving, and you find out days
later when you notice the quiet.

- **The origin devices enrol on.** A subscription is bound to it and cannot be
  re-pointed, so moving hostnames means enrolling every device again by hand.
  Anyone who has changed a domain can fill in the rest. Pick the final one before
  anyone enrols, and leave `preview_urls: false`, since a preview URL is a real,
  enrollable origin and it is *per version*. Without a domain, `workers.dev` is
  stable indefinitely; only renaming the Worker or changing your account
  subdomain moves it.
- **The VAPID keypair.** It is what identifies you to Apple's push service, and
  every stored subscription is bound to the public key it was created with, so a
  new keypair is accepted by the push service and delivered to nobody.
  `kukuroo init` generates it once and writes it to `kukuroo.credentials.json`.
  A Worker Secret cannot be read back, which makes that file the only copy: back
  it up somewhere you will still have in three years, and keep the private key
  off the machine that sends notifications, which needs nothing but the bearer
  token.

There is no rotate for either, on purpose; asking for one prints an explanation
instead. The send token and the invite code are bound to nothing and rotate
freely: see [Rotating](#rotating).

---

## iOS notes

- **Requires iOS 18.4 or later.** Declarative Web Push shipped in Safari 18.4 in
  March 2025. Any claim that it needs iOS 26 is wrong.
- **Add to Home Screen is required.** Web push does not work in a normal Safari
  tab on iOS, though it does on macOS (Safari 18.5, macOS 15.5, or later:
  Declarative Web Push reached the desktop one release after iOS).
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
Crypto as the user agent. A green run proves the cryptography round-trips byte
for byte and the HTTP contract holds; the end-to-end check against a real
iPhone is a manual pass, recorded in the status line above, and not something
the suite can claim.

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
