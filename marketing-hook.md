# Marketing hook

Source material for the landing page. Not the README: the README tells someone who
has already decided how to install it, this decides whether they want to.

A working document. Every claim here should be one we can defend, and the
"overreach" section exists so that stays true as the copy gets shorter.

Last updated: 2026-08-02.

---

## The hook

> **A Web Push gateway that runs entirely on a free Cloudflare Worker.**
> Nothing to host, nothing to install on your phone.
>
> Add one page to your Home Screen, and send yourself notifications with a single
> authenticated `POST`. Declarative Web Push by default. You keep the keys.

Shorter, for a repo description or a tagline:

> Self-hosted Web Push with no server to run. A Cloudflare Worker plus KV.

**Lead with the shape, not with the absence of an app.** "No iOS app needed" is a
property of Web Push itself, true since iOS 16.4 in March 2023, and every PWA
already has it. Opening on it signals that the field was never surveyed. The
thing nobody else can say is *there is no host*.

---

## The problem, in one paragraph

You have something that needs to tell you when it happens: a build finished, a
server fell over, a price dropped, a job queue backed up. You want it on your
phone, on the lock screen, now. Every route to that today asks you to either
install somebody's app and route your alerts through their servers, or spend a
weekend and $99 a year building an iOS app whose entire job is to display four
words. Meanwhile your phone has had a perfectly good push notification system
built into the browser since March 2025, and nobody is using it.

---

## Where this actually sits

Surveyed 2026-08-02. **The gap is narrower than it looks, and two projects
already ship the thing this was assumed to be first at.** Write the copy knowing
that, because a reader can falsify a gap claim in one search.

| | No dedicated app | Self-hosted | No server to run | Declarative-first | Ships enrolment page |
|---|---|---|---|---|---|
| **Kukuroo** | yes | yes | **yes** | **yes** | yes |
| **ntfy** (Web Push + PWA) | yes | yes | no | not established | its own UI only |
| **go-notify-server** | yes | yes | no | yes | no, bring your own PWA |
| **AlphaPush** | yes | yes | yes | not addressed | yes |
| **Bark** | no, App Store app | server yes | Worker, yes | n/a, APNs | n/a |
| **Gotify** | Android app, none on iOS | yes | no | n/a, WebSocket | n/a |
| **Pushover / Pushbullet** | no, their app | no | n/a | n/a | n/a |

The two that matter:

- **ntfy** (~25k stars) with `web-push-*-key` configured, added to the iOS Home
  Screen, is browser-native Web Push with no app and no ntfy.sh. It is the direct
  refutation of "this does not exist". It needs a host, a domain, TLS, and a
  process that stays up.
- **go-notify-server** is the closest in spirit: a thin RFC 8030 server for *your
  own* PWA, Declarative Web Push by default. Docker and SQLite, 3 stars. It
  predates us, so we are not first at declarative either.

**The differentiator, ranked by how well it holds up:**

1. **Zero infrastructure.** This is the strong one and the only axis where the
   nearest neighbours cannot follow. They are self-hosted; we are *serverless*.
   A Cloudflare account, no host, no TLS, no uptime.
2. **Declarative-first.** Defensible today: a GitHub code search for
   `"web_push": 8030` returns roughly a hundred files across the entire public
   corpus, nearly all individual apps' own service workers. The only reusable
   infrastructure in that set is go-notify-server, one Laravel channel class, and
   this. Say "one of the few", never "the first".
3. **Batteries included.** ntfy makes you use ntfy's UI; go-notify-server assumes
   you already have a PWA. Shipping the server *and* the Add-to-Home-Screen page
   is a real ergonomic win.

A comparison table naming these projects and saying plainly what each does better
buys more credibility than any gap claim.

## Claims we can defend

Each of these is checked, not assumed. Keep the evidence attached as the copy
gets shorter, because the shortest version is the one that starts to lie.

**No App Store, no Apple Developer Program.**
No $99/year membership, no APNs certificates, no provisioning profiles, no review
process, no TestFlight. The delivery mechanism is the one Safari ships with.

*Position this as why **Web Push** is worth using, not as why **Kukuroo** is. It
is true of every project in the table above. It belongs in the paragraph that
sells the approach to someone who has never considered it, and nowhere near the
paragraph that distinguishes us from ntfy.*

**No notification vendor.**
The VAPID keypair is generated on your machine and lives in your Worker. The push
service is a relay that sees an endpoint and an opaque ciphertext; the payload is
encrypted to a key only your device holds (RFC 8291). Nobody has a dashboard with
your notification history on it, because there is nowhere for one to be.

*Say "no notification vendor", not "no third party". You still depend on Apple's
`web.push.apple.com` to deliver and on Cloudflare to host. The honest claim is
that nobody sits in the middle of your alerts reading them, and it is strong
enough without being stretched.*

**Runs on the free tier, in practice.**
Static asset requests to Cloudflare are free and unlimited and do not invoke the
Worker at all, so only the push endpoints cost anything. Confirmed end to end on
a real device, not inferred from the pricing page. *(The one number still to
measure is how many subscriptions a single fan-out can encrypt inside the free
plan's 10 ms CPU budget. State it plainly once measured; do not imply it is
unlimited.)*

**Not marketplace-specific, and not a library you have to embed.**
Mount it into a Worker you already have, or deploy it standalone as a pure
notification sink. Either way the thing that sends notifications only needs a
bearer token and an HTTP client. It never holds a signing key.

**It works, and the sharp edges are documented.**
Declarative Web Push fails silently and spectacularly: a relative `navigate`, an
unreachable `icon`, or an oversize payload discards the entire message with a 201
and no error anywhere. Kukuroo rejects all three before sending. It also emits
`app_badge` in both of the positions Apple moved it between without documenting
the move. This is the kind of thing you would otherwise lose an afternoon to,
twice.

---

## The friction, stated honestly

Do not bury this. Someone who discovers it after installing feels tricked;
someone who reads it up front sees a project that respects them.

**On iOS you must add the page to your Home Screen and open it from the icon.**
Web push does not work in a Safari tab, at all. `window.pushManager` is simply
absent there, so the failure looks like a broken page rather than a missing step.
This is an Apple constraint, it cannot be scripted around, and it is the one
manual step in the whole thing.

Frame it as what it is: **a one-time, thirty-second setup**, not a limitation
being apologised for. It is also the honest reason the pitch is not literally
"just host a page".

**Deleting the Home Screen icon destroys the subscription**, silently, and
re-enrolment is manual. Anyone relying on this for alerts should send themselves
a daily ping, because the absence of a scheduled message is the only reliable
signal that the channel died.

**iOS 18.4 or later.** Declarative Web Push shipped in Safari 18.4, March 2025.
Any claim that it needs iOS 26 is wrong.

---

## Overreach: claims to avoid

- **"No setup"** or **"one click"**. There is a Cloudflare account, a deploy, and
  the Home Screen step. Say "one-time setup", never "no setup".
- **"Unlimited"** or **"free forever"**. Free tier limits are real; the fan-out
  CPU ceiling in particular. Give the number instead of the adjective.
- **"Private"** or **"end-to-end encrypted"** without qualification. The payload
  is encrypted to the device, which is genuinely good, but Apple's push service
  sees timing, size, and endpoint. Say what is true and let it be enough.
- **"Replaces Pushover / ntfy / OneSignal."** Different trade. Those ship an app
  that works everywhere with no install ceremony; this uses the OS's own push and
  asks for one manual step in exchange for no app and no service. Name the trade,
  do not claim the win.
- **"The only project that does this", "the first", "fills a gap".** Checked, and
  false. ntfy and go-notify-server both ship self-hosted Web Push to an iOS Home
  Screen web app with no dedicated app and no third party. Writing any of these
  is falsifiable in one search and costs more credibility than the phrase buys.
- **"No iOS app needed" as the headline.** Table stakes since iOS 16.4, 2023.
  Fine as a benefit of the approach, fatal as the thesis.
- **"Self-hosted" as the differentiator.** ntfy and Gotify are self-hosted too.
  The axis is *serverless*.
- Anything implying it is a hosted service. It is not. Nobody is running this for
  you, and that is the point.

---

## Who it is for

- People running personal automation who want alerts on their phone and object to
  routing them through a stranger's server.
- Developers who already have a Cloudflare Worker and want notifications from it
  without adding a dependency on a notification vendor.
- Anyone who has looked at the cost of an iOS app for one notification and
  decided it was absurd.

Not for: consumer-scale product notifications, multi-tenant systems, or anyone
who needs Android and iOS parity today. Say so; the disqualifiers make the fit
sharper for everyone else.

---

## Proof points worth showing

- The whole payload, on screen. It is small enough to read, and seeing
  `{"web_push": 8030, "notification": {...}}` makes the concept click faster than
  a paragraph will.
- The `curl` that sends a notification. One command, visible bearer token, real
  output. This is the moment someone decides it is simple.
- A screenshot of the notification on a real lock screen, with the Home Screen
  icon badged.

---

## Open, pending research

- How the landscape actually looks: ntfy, Gotify, Pushover, Bark, Apprise, and
  whether anything already does self-hosted Web Push to an iOS Home Screen web
  app. The differentiator paragraph should name the nearest neighbour and the
  specific difference, rather than gesturing at a gap.
- Whether "gateway" is the right word. It implies other systems point at it,
  which the bearer-gated endpoint supports, but the install experience has been
  exercised by exactly one person so far.
- The measured fan-out CPU number.
