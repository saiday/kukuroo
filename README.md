# Kukuroo

Your own Web Push service, on a Cloudflare Worker.

Kukuroo stores push subscriptions in KV, serves the page a device enrolls from, and
encrypts and signs every notification itself. There is no server to keep alive and no
notification vendor in the path: you hold the keys, and the push service relays
ciphertext it cannot read.

It uses **Declarative Web Push**, which so far has only shipped in Safari, so receiving
needs an iPhone or iPad on iOS 18.4+, or macOS Safari 18.5+. Chrome, Firefox, and Android
cannot enroll. Sending works from anything that can make a request: curl, cron, CI, or a
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

One of the questions is where devices will enroll, either a `workers.dev` address or a domain
you already have on Cloudflare. Settle it before you deploy: it is fixed once a device has
enrolled.

Then, on the device: open the origin it printed in Safari, **Add to Home Screen**, and open
it **from the icon** to allow notifications. Enrolling from a Safari tab does not work on
iOS. [The enrollment guide](docs/create-pwa-and-subscribe-to-push.md) covers the rest of the
behaviour worth knowing. From then on, a notification is one request:

```sh
curl -X POST https://push.example.com/push/send \
  -H "authorization: Bearer $SEND_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"notification":{"title":"hello","navigate":"https://push.example.com/"}}'
```

Every question also has a flag, so nothing has to be answered interactively: `npx kukuroo
init --help`. `--no-deploy` stops after writing the project and the keys locally, touching
nothing on your Cloudflare account; `npx wrangler deploy` then `npx kukuroo init --resume`
picks it up when you are ready.

### Self-Hosted Module

**Standalone** is what `init` scaffolds: Kukuroo as its own Worker at its own address,
serving the enrollment page it ships with. Pick it when you do not already run a Cloudflare
Worker. Your website is not involved at all; it only needs the send token and a POST to
`/push/send`. Answering **no** to the bundled front end keeps the same shape but routes no
enrollment page, so you serve your own UI and add its origin to `KUKUROO_ALLOWED_ORIGINS`.

**Mounted** puts the push routes inside a Worker you already run, so they share your site's
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
the exported `enrollmentPage()`, or build your own UI against `POST /push/subscribe`.

Kukuroo ships TypeScript source rather than a build, so your `tsconfig.json` needs
`"allowImportingTsExtensions": true` or `tsc` reports errors from inside
`node_modules/kukuroo`. The scaffolded project sets this already.

Mounting is not the only way to get enrollment onto your own hostname: a standalone Worker
on a route (`{ "pattern": "www.example.com/push/*", "zone_name": "example.com" }`) reaches
the same place, and so does a real proxy in front of your site, one that rewrites the `Host`
header rather than a bare DNS CNAME. All that matters is which origin devices enroll on.

## Agents

> Ask your agent to read this section.

Your coding agent can send these, which is most of the point of having a phone in the
loop. For Claude Code that is a plugin, and this repository is its own marketplace:

```sh
claude plugin marketplace add saiday/kukuroo
claude plugin install kukuroo@kukuroo
```

From then on "ping me on my phone when the tests finish" works in any project, and so
does naming a time. Setup is two questions, asked the first time it fires on a machine:
the origin and the send token. It caches the answers in `~/.config/kukuroo/env` at 0600,
never the VAPID key. That file is shell-sourceable, so no later send has to name the
token:

```sh
set -a; . ~/.config/kukuroo/env; set +a
curl -fsS -X POST "$KUKUROO_ORIGIN/push/send" -H "authorization: Bearer $KUKUROO_SEND_TOKEN" ...
```

Cursor and anything else that reads a rules file gets the same contract from
`rules/kukuroo.mdc`.

[The agents guide](docs/agents.md) covers the rest: what makes it fire, what it is told
about the payload, and why a scheduled push needs the session to stay open.

## API

```
POST /push/send        bearer token   RFC 8291 aes128gcm + VAPID ES256, fans out
POST /push/subscribe   invite-gated   stores the subscription in KV
GET  /push/public-key  open           the VAPID public key, for the client
GET  /push/enroll      open           the bundled enrollment page (standalone only)
```

`/push/send` does one encrypt-and-sign per subscription inside a single invocation, which
has [a ceiling on the free plan](docs/free-plan-device-limits.md).

Sending from inside your own Worker needs no token, since it already holds the bindings:

```ts
import { send } from "kukuroo";

const result = await send(env, {
  notification: { title: "Deploy finished", navigate: "https://push.example.com/deploys" },
});

if (result.delivered === 0) throw new Error("no devices are enrolled");
```

`navigate` and a non-empty `title` are required, and an `icon`, if present, must be an
absolute URL. WebKit discards a message that breaks any of these without an error anywhere,
so Kukuroo rejects them before sending.

Every binding is documented where it is declared, [`KukurooEnv` in `src/env.ts`](src/env.ts),
as are [`MountOptions`](src/mount.ts) and [`SendOptions` and `SendResult`](src/send.ts). One
option is worth reading before you set it: `requireInvite: false` opens enrollment to anyone
who reaches the URL, and everyone who enrolls receives everything you send.

Also exported: `enrollmentPage(options)`, `buildDeclarativePayload`, and `importVapidKeys`.
The send token and invite code rotate with `npx kukuroo rotate send-token` and `npx kukuroo
rotate invite-code`; both read `kukuroo.credentials.json`, and neither re-enrolls anything.

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
