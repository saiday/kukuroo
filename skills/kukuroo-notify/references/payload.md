# The payload, and every way a send fails

Reference for `POST <prefix>/send`. The prefix is `/push` unless the deployment moved it.

## The request

```
POST $KUKUROO_ORIGIN/push/send
authorization: Bearer $KUKUROO_SEND_TOKEN
content-type: application/json
```

```jsonc
{
  "notification": {
    "title":    "required, non-empty",
    "navigate": "required, absolute http(s) URL",
    "body":     "optional",
    "tag":      "optional. Notifications sharing a tag replace each other",
    "icon":     "optional, and absolute if present",
    "dir":      "auto | ltr | rtl",
    "lang":     "optional",
    "silent":   false,           // suppresses the sound, not the banner
    "data":     null             // anything JSON
  },
  "appBadge": 1,                 // non-negative integer, sets the Home Screen badge
  "mutable":  false,             // only if a service worker must replace the notification
  "topic":    "optional",        // push-service Topic header: coalesces undelivered messages
  "ttl":      14400              // seconds, default 4 hours
}
```

`/push/send` never receives CORS headers, whatever `KUKUROO_ALLOWED_ORIGINS` says. The send token is
a server secret, so a browser page holding one is meant to fail its first test rather than work
quietly.

## The response

```json
{ "delivered": 1, "removed": 0, "failures": [] }
```

- `delivered` counts subscriptions the push service **accepted** the message for. Not the same as
  displayed on a device, but a `delivered` of 0 means nothing was even accepted, and that is a
  failure.
- `removed` counts subscriptions deleted from KV because the push service answered 404 or 410. A dead
  subscription is only ever discovered this way, and re-enrolment is manual.
- `failures` carries `{ endpoint, status, detail }` per subscription that did not go out.

## Members WebKit ignores

These are in the W3C Notifications spec, are not implemented by WebKit, and are dropped without
complaint. Kukuroo rejects them at build time instead, so a caller reaching for one hears about it:

`image`, `badge`, `vibrate`, `timestamp`, `renotify`, `requireInteraction`, `actions`

Use `appBadge` for the number on the Home Screen icon; `badge` is a different, unimplemented thing.

## Size

The JSON budget is about **3900 bytes** (`PAYLOAD_BUDGET_BYTES`), from a 4096-byte wire limit for the
encrypted body less RFC 8188 framing and the GCM tag. Going over is not an error anywhere: the push
service accepts the message and it is never delivered. Keep `body` and `data` small.

## Status codes

| Status | Body | What it means |
|---|---|---|
| 200 | `{"delivered":0,...}` | Request fine, nothing enrolled. Re-enrol: open the origin in Safari, Add to Home Screen, open from the icon. |
| 400 | `{"error":"body must be JSON"}` | Malformed request body. |
| 400 | `{"error":"notification.<field> ..."}` | Validation, and the message names the field and why. |
| 401 | `{"error":"unauthorized"}` | Missing or stale bearer token. `kukuroo rotate send-token` replaces it, and the env file needs the new value. |
| 403 | `{"error":"invalid invite code"}` | Only `/subscribe`. Enrolment, not sending. |
| 405 | `{"error":"method not allowed"}` | `/send` is POST only. |
| 503 | `{"error":"KUKUROO_... is not configured..."}` | A Worker Secret is missing. `npx kukuroo init --secrets`. |

A 400 that names a field is the good case. The failure worth fearing is a 201 from the push service
with nothing on the phone, which is what an invalid `navigate`, a missing `title`, a relative `icon`,
or an oversize payload produce. Kukuroo checks all four before sending for exactly that reason.

## Sending from inside a Worker

Code running in a Worker that already has the bindings needs no token and no HTTP round trip:

```ts
import { send } from "kukuroo";

const result = await send(env, {
  notification: {
    title: "Deploy finished",
    body: "main to production, 42s",
    navigate: "https://push.example.com/deploys",
    tag: "deploys",
  },
  appBadge: 1,
});

if (result.delivered === 0) throw new Error("no devices are enrolled");
```

`send` takes the same options as the HTTP body and returns the same result. Also exported:
`buildDeclarativePayload` to validate a payload without sending, and `enrolmentPage()` to serve the
bundled enrolment UI from a route of your own.

## Where notifications land

`navigate` decides what opens when the notification is tapped, and it must be **absolute**. If the
deployment sets `KUKUROO_NAVIGATE_ORIGIN`, `navigate` must be on that origin, and a send that leaves
it is rejected with a 400 that says so. That restriction exists because tapping a notification
pointing off-origin ejects the user out of the installed web app and into a browser tab. `icon` is
deliberately not restricted, since it legitimately points at a CDN.

## Receiving, in one paragraph

Declarative Web Push has shipped only in Safari: iOS or iPadOS 18.4+, macOS Safari 18.5+. On iOS the
page must be added to the Home Screen and opened **from the icon** — a normal Safari tab cannot
subscribe, which is Apple's rule. There is no service worker; Safari 18.4 exposes
`window.pushManager`, and WebKit renders the notification itself from the payload. Deleting the Home
Screen icon destroys the subscription and nothing reports it, so the absence of a message you were
expecting is the only reliable signal that the channel has died. Full detail:
[docs/create-pwa-and-subscribe-to-push.md](https://github.com/saiday/kukuroo/blob/main/docs/create-pwa-and-subscribe-to-push.md).

## Device ceiling

`/push/send` does one encrypt-and-sign per subscription inside a single Worker invocation, so the
free plan's 50-subrequest limit is a hard ceiling of **50 enrolled devices**. CPU is the nearer wall
at scale: roughly 0.12 ms per subscription against a 10 ms budget.
