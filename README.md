# Kukuroo

Your own Web Push service, on a Cloudflare Worker.

Kukuroo stores push subscriptions in KV, serves the page a device enrols from, and
encrypts and signs every notification itself. There is no server to keep alive and no
notification vendor in the path: you hold the keys, and the push service relays
ciphertext it cannot read.

It uses **Declarative Web Push**, which so far has only shipped in Safari, so receiving
needs an iPhone or iPad on iOS 18.4+, or macOS Safari 18.5+. Chrome, Firefox, and Android
cannot enrol. Sending works from anything that can make a request: curl, cron, CI, or a
backend you already run.

**Requirements.** A Cloudflare account, Node 22.6 or later, and `npx wrangler login` once.

## Install

```sh
npx kukuroo init my-push
```

That is the whole of it. It asks what your deployment is for, then writes a Worker into
`my-push`, installs its dependencies, generates every secret, puts the secrets on
Cloudflare, and deploys. It also writes `my-push/kukuroo.credentials.json`, the only copy of
your keys: a Worker Secret cannot be read back, so back that file up.

One of the questions is where devices will enrol, either a `workers.dev` address or a domain
you already have on Cloudflare. It is asked before the deploy because that is the last
moment it is free to change.

Then, on the device: open the origin it printed in Safari, **Add to Home Screen**, and open
it **from the icon** to allow notifications. Enrolling from a Safari tab does not work on
iOS, which is Apple's rule rather than ours; [the enrolment
guide](docs/create-pwa-and-subscribe-to-push.md) covers the rest of the behaviour worth
knowing. From then on, a notification is one request:

```sh
curl -X POST https://push.example.com/push/send \
  -H "authorization: Bearer $SEND_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"notification":{"title":"hello","navigate":"https://push.example.com/"}}'
```

Every question also has a flag, so nothing has to be answered interactively: `npx kukuroo
init --help`. `--no-deploy` sets everything up and stops, if you would rather read the
generated Worker before it goes live.

## Two values worth settling first

Both are fixed once a device has enrolled. Changing either is not destructive, but it does
mean enrolling every device again by hand, and the two fail for different reasons.

- **The VAPID keypair.** The push service binds your public key to each subscription when
  it is created, and checks every send's signature against that stored key. Sign with a new
  keypair and it answers 401 or 403, so nothing is delivered. `kukuroo init` generates the
  keypair once and writes it to `kukuroo.credentials.json`, which is the only copy of it.
- **The origin devices enrol on.** The push service never sees or checks this, so devices
  already enrolled keep receiving after a move. What you lose is your own side of it: a page
  on a different origin cannot read or repair subscriptions created on the old one, so you
  can neither re-subscribe nor verify them, and a notification click navigates to an address
  you no longer serve. This is why `init` asks before it deploys. Leave
  `preview_urls: false` too, because a preview URL is a real enrollable origin and it is
  *per version*.

The send token and the invite code are bound to nothing and rotate freely.

## Standalone

Kukuroo runs as its own Worker at its own address, serving the enrolment page it ships
with. Nothing to build and nothing to write: `init` scaffolds the project, and the origin is
whatever you put in `wrangler.jsonc`.

This is the shape to pick when you do not already run a Cloudflare Worker, or when push can
live at its own address away from your site. Your website, wherever it is hosted, is not
involved at all: it only needs to hold the send token and POST to `/push/send` when
something happens.

Answering **no** to the bundled front end keeps the same shape but routes no enrolment page,
so you serve your own UI and add its origin to `KUKUROO_ALLOWED_ORIGINS`.

## Mounted

Mounting puts the push routes inside a Worker you already run, so they share your site's
origin and a notification click lands back inside your site.

```ts
import { mountKukuroo, type KukurooEnv } from "kukuroo";

const kukuroo = mountKukuroo({ prefix: "/push", standalone: false, requireInvite: true });

export default {
  async fetch(request: Request, env: KukurooEnv): Promise<Response> {
    const hit = await kukuroo.handle(request, env);
    if (hit !== null) return hit;
    return yourExistingRouter(request, env);
  },
};
```

`handle` returns `null` for every path outside `prefix`, so your own routing is untouched.
Add the KV binding, `"kv_namespaces": [{ "binding": "KUKUROO_SUBS" }]`, whose name is not
configurable; set `KUKUROO_NAVIGATE_ORIGIN`; then run `npx kukuroo init --secrets` from the
directory holding that `wrangler.jsonc`. Serve the bundled page from any route of yours with
the exported `enrolmentPage()`, or build your own UI against `POST /push/subscribe`.

Mounting is not the only way to get enrolment onto your own hostname, and Kukuroo does not
have to live on your domain at all. The only thing that matters is which origin devices
enrol on:

| Your setup | How enrolment happens on your own origin |
|---|---|
| Your site is a Cloudflare Worker | mount, as above |
| Your site's DNS is on Cloudflare, hosted anywhere | a standalone Worker on a route: `{ "pattern": "www.example.com/push/*", "zone_name": "example.com" }` |
| You run a proxy or CDN in front of your site | proxy `/push/*` to the Worker's `workers.dev` address |
| A static site, DNS elsewhere | set `KUKUROO_ALLOWED_ORIGINS` and call the Worker's absolute URLs from the browser |

Two traps in that table. The proxy row needs a real proxy that rewrites the `Host` header; a
bare DNS CNAME pointed at `workers.dev` is not one, and fails at Cloudflare's edge. And
`/push/send` never receives CORS headers whatever `KUKUROO_ALLOWED_ORIGINS` says, because
the send token is a server secret and a page holding one should fail its first test rather
than work quietly.

## Agents

Your coding agent can send these, which is most of the point of having a phone in the
loop. For Claude Code that is a plugin, and this repository is its own marketplace:

```sh
claude plugin marketplace add saiday/kukuroo
claude plugin install kukuroo@kukuroo
```

From then on "ping me on my phone when the tests finish" works in any project, and so
does naming a time. Setup is two questions, asked the first time it fires on a machine:
the origin and the send token. It has to ask, because a deployment is set up on one
machine and sent to from any number of others, so nothing `init` wrote is anywhere the
agent can see.

It caches the answers in `~/.config/kukuroo/env` at 0600, holding those two values and
not the VAPID key. That file is shell-sourceable, so no later send has to name the
token:

```sh
set -a; . ~/.config/kukuroo/env; set +a
curl -fsS -X POST "$KUKUROO_ORIGIN/push/send" -H "authorization: Bearer $KUKUROO_SEND_TOKEN" ...
```

The file is written only after a notification has actually arrived, and a warm-up goes
out before any promise of a later one, because a subscription dies silently and an
untested promise is a promise made on faith. Cursor and anything else that reads a rules
file gets the same contract from `rules/kukuroo.mdc`.

[The agents guide](docs/agents.md) covers the rest: what makes it fire, what it is told
about the payload, and why a scheduled push needs the session to stay open.

## API

```
POST /push/send        bearer token   RFC 8291 aes128gcm + VAPID ES256, fans out
POST /push/subscribe   invite-gated   stores the subscription in KV
GET  /push/public-key  open           the VAPID public key, for the client
GET  /push/enroll      open           the bundled enrolment page (standalone only)
```

`/push/send` does one encrypt-and-sign per subscription inside a single invocation, which
has [a ceiling on the free plan](docs/free-plan-device-limits.md).

```ts
interface KukurooEnv {
  KUKUROO_SUBS:          KVNamespace
  KUKUROO_VAPID_PRIVATE: string   // Worker Secret. A JWK
  KUKUROO_SEND_TOKEN:    string   // Worker Secret
  KUKUROO_INVITE_CODE:   string   // Worker Secret
  KUKUROO_VAPID_PUBLIC?: string   // only if the key is a bare 32-byte scalar
}

const kukuroo = mountKukuroo({
  prefix: "/push",          // where the route set lives. Default "/push"
  standalone: false,        // serve the bundled enrolment page at <prefix>/enroll
  requireInvite: true,      // demand the code on <prefix>/subscribe. Default true
})
await kukuroo.handle(request, env)   // Response, or null if the path is not ours
```

`requireInvite` is the one option that is a decision rather than a detail. Off, enrolment is
open to anyone who reaches the URL, and everyone who enrols receives everything you send.
Only an explicit `false` opens it, and `KUKUROO_INVITE_CODE` is generated and installed
either way, so closing an open gate is one word and a deploy, with nothing re-enrolling.

Three optional vars:

- `KUKUROO_NAVIGATE_ORIGIN`: every notification's `navigate` must be on this origin. **Set
  it.** Serving push and enrolment from one origin only makes same-origin likely, and this
  makes it enforced; a `navigate` that leaves the origin ejects the user into a browser tab.
  It does not restrict `icon`, which legitimately points at a CDN.
- `KUKUROO_ALLOWED_ORIGINS`: comma-separated exact origins whose pages may call `subscribe`
  and `public-key` from the browser. Unset, no CORS headers are sent. There is no wildcard.
- `KUKUROO_VAPID_SUBJECT`: the VAPID `sub` claim, a `mailto:` or `https:` URI. Defaults to
  the push service's own origin, which is accepted but identifies nobody.

Sending from inside your own Worker needs no token, since it already holds the bindings:

```ts
import { send } from "kukuroo";

const result = await send(env, {
  notification: {
    title: "Deploy finished",
    body: "main to production, 42s",
    navigate: "https://push.example.com/deploys",  // required, and absolute
    tag: "deploys",                                // replaces its predecessor
  },
  appBadge: 1,
});

if (result.delivered === 0) throw new Error("no devices are enrolled");
```

`navigate` and a non-empty `title` are required, and an `icon`, if present, must be an
absolute URL. Get any of them wrong and WebKit discards the whole message with no error
anywhere, so Kukuroo rejects them before sending. `delivered` counts subscriptions the push
service accepted the message for, which is not the same as displayed on a device; a
`delivered` of 0 is a failure, not a quiet success.

Also exported: `enrolmentPage(options)`, `buildDeclarativePayload`, and `importVapidKeys`.
The send token and invite code rotate with `npx kukuroo rotate send-token` and `npx kukuroo
rotate invite-code`; both read `kukuroo.credentials.json`, and neither re-enrols anything.

## Alternatives

| | Server to run | Vendor in the path | How it reaches iOS |
|---|---|---|---|
| **Kukuroo** | none | none | Web Push, a page on your Home Screen |
| [ntfy](https://ntfy.sh) | host, domain, TLS, a process | none, self-hosted | Web Push, installable PWA |
| [Bark](https://github.com/Finb/Bark) | yes, though it can be a Worker | none | App Store app via APNs |
| [Gotify](https://gotify.net) | yes | none | its own app |
| [Pushover](https://pushover.net) | none | yes, paid hosted | its own app |

If you are happy hosting and want a full app-like UI, use ntfy. It is mature, polished, and
does considerably more than this.

## Licence

MIT. See [LICENSE](LICENSE).
