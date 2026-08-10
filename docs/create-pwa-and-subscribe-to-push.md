# Creating the PWA and subscribing to push

Everything Safari does differently, in the order you will meet it. Kukuroo's bundled
enrollment page already handles all of this; the notes matter when you build your own UI, or
when something has stopped working and nothing said why.

## Enrolling

**iOS 18.4 or later is the floor.** Declarative Web Push shipped in Safari 18.4 in March
2025. Any claim that it needs iOS 26 is wrong. macOS got it one release later, in Safari
18.5.

**On iOS the page must be added to the Home Screen, and opened from the icon.** Web push does
not work in a normal Safari tab. This is the step people get wrong, and the failure is a
`subscribe()` call that rejects rather than anything that explains itself. On macOS a normal
Safari window is fine from 18.5.

**So your page needs the installability metadata** if you are serving your own: either
`apple-mobile-web-app-capable`, or a web app manifest. Without it the Add to Home Screen
result is a bookmark, not an installed web app, and it cannot subscribe.
[`src/enroll-page.ts`](../src/enroll-page.ts) is the fifteen lines of client JS to copy.

**There is no service worker.** Safari 18.4 exposes `window.pushManager`, so a subscription
exists without one. That is what "declarative" means here: the payload describes the
notification, and WebKit displays it with no JavaScript of yours involved.

## When a subscription dies

**There is no `pushsubscriptionchange` handler,** because there is no service worker to host
one. A dead subscription is discovered from a 410 on the next send, at which point Kukuroo
removes it from KV and reports it in `removed`. Re-enrollment is manual: the device has to open
the page and subscribe again.

**Deleting the Home Screen icon destroys the subscription,** and nothing reports it. Neither
does anything report a device left in a drawer for a month. If notifications matter to you,
send yourself a daily "still alive" ping, because the absence of a message you were expecting
is the only reliable signal that the channel has died.

## What a payload may contain

`title` and `navigate` are required on every message, `navigate` must be absolute, and an
`icon`, if present, must be a valid absolute URL. Get any of them wrong and WebKit discards
the entire message with no error anywhere, which is why Kukuroo rejects them before sending
rather than letting the failure be silent.

**`app_badge` moved position between Safari versions,** and Apple never documented the move:
inside `notification` on 18.4 through 18.6, top level on 26.0 and later. Kukuroo emits it in
**both** positions, so callers never have to know which iOS a device is on. Measured on iOS
26.5.2, the top-level position sets the badge and the one inside `notification` is ignored
entirely, so this is not theoretical tidiness.

**There is no badge-only or silent update.** Every push displays a notification, because
`title` and `navigate` are required on all of them. `silent: true` suppresses the sound, not
the banner. If you want to change the badge, you are also showing the user something.
