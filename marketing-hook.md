# Marketing hook

Source material for the landing page. Not the README: the README tells someone who
has already decided how to install it, this decides whether they want to.

A working document. Every claim here should be one we can defend, and the
"overreach" section exists so that stays true as the copy gets shorter.

Last updated: 2026-08-02.

---

## The hook

> **Push notifications to your iPhone. No app, no Apple Developer account, no
> third-party service.**
>
> Host one page on a Cloudflare Worker, add it to your Home Screen once, and send
> yourself notifications with a single authenticated `POST`. You keep the keys.

Shorter, for a repo description or a tagline:

> Send Web Push notifications to your own devices from anything. A Cloudflare
> Worker plus KV. You keep the keys.

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

## Claims we can defend

Each of these is checked, not assumed. Keep the evidence attached as the copy
gets shorter, because the shortest version is the one that starts to lie.

**No App Store, no Apple Developer Program.**
No $99/year membership, no APNs certificates, no provisioning profiles, no review
process, no TestFlight. The delivery mechanism is the one Safari ships with.

**No third-party service.**
The VAPID keypair is generated on your machine and lives in your Worker. Apple's
push service is a relay that sees an endpoint and an opaque ciphertext; the
payload is encrypted to a key only your device holds (RFC 8291). Nobody has a
dashboard with your notification history on it, because there is nowhere for one
to be.

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
- **"The only project that does this."** Not verified. Do not write it until it
  is, and prefer a specific difference to a superlative anyway.
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
