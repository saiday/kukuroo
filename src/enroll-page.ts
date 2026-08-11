/**
 * The bundled enrollment page, for standalone deployments.
 *
 * Mounted deployments serve their own UI on their own origin and never reach
 * this. It exists because a push subscription is bound to an origin and on iOS
 * that origin must be installed to the Home Screen, so Kukuroo cannot be a pure
 * API: it has to be able to serve the surface that gets installed.
 *
 * The page is deliberately one file with no build step. It is the last thing
 * anyone wants to debug on a phone.
 */

export interface EnrollmentPageOptions {
  /**
   * Where the page posts the subscription: a path on the serving origin, or an
   * absolute URL when the page is served by a host on one origin and Kukuroo
   * runs on another (which needs KUKUROO_ALLOWED_ORIGINS set on the Worker).
   */
  subscribePath: string;
  /** Where the page fetches the VAPID public key; path or absolute URL, as above. */
  publicKeyPath: string;
  /** The page's first heading. An instruction, not a name. Default "Enroll this device". */
  title?: string;
  /**
   * What the installed web app is called: the document title, and the name iOS
   * writes under the icon on Add to Home Screen.
   *
   * This is separate from `title` because the two are read at different moments.
   * The heading is read once, mid-enrollment, by somebody who already knows what
   * they are enrolling in; the name is read every day afterwards, on a Home Screen
   * beside other apps, where "Enroll this device" says nothing about whose
   * notifications these are. `mountKukuroo` defaults it to the first label of the
   * hostname the request arrived on, so a deployment is named after itself.
   */
  appName?: string;
  /**
   * Whether to ask for the invite code. Default true, matching the Worker's
   * default gate. Set it to whatever `mountKukuroo` was given: a page that asks
   * for a code the endpoint ignores is confusing, and a page that does not ask
   * for one the endpoint demands is broken.
   */
  requireInvite?: boolean;
}

/** Kept out of the HTML so an operator-supplied title cannot close a tag. */
function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

export function enrollmentPage(options: EnrollmentPageOptions): string {
  const title = escapeHtml(options.title ?? "Enroll this device");
  const appName = escapeHtml(options.appName ?? options.title ?? "Enroll this device");
  const inviteField =
    options.requireInvite === false
      ? ""
      : `<input id="invite" type="text" placeholder="Invite code" autocomplete="off"
         autocapitalize="off" autocorrect="off" spellcheck="false" required>
  `;
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="${appName}">
<meta name="mobile-web-app-capable" content="yes">
<meta name="robots" content="noindex, nofollow">
<title>${appName}</title>
<style>
  :root { color-scheme: light dark }
  * { box-sizing: border-box }

  /* The page fills the window rather than sitting at the top of it. On a phone
     this is the whole screen, which is the point: one instruction at a time, at
     a size somebody can read while holding the device and following along. */
  body { margin: 0; min-height: 100dvh; display: grid; place-items: center;
         padding: max(1.5rem, env(safe-area-inset-top)) 1.25rem
                  max(1.5rem, env(safe-area-inset-bottom));
         font: 16px/1.55 -apple-system, system-ui, sans-serif }
  main { width: 100%; max-width: 26rem }

  /* A run of dots leading into one mark that says where this device stands:
     install it, cannot enroll, needs a code, needs permission, enrolled.

     The dots flash in sequence towards the mark while something is still
     expected to happen, and stop once the answer is final in either direction.
     So the rail is not decoration: motion means waiting, stillness means the
     device has arrived somewhere, and the mark says where. */
  #rail { display: flex; align-items: center; justify-content: center; gap: .4rem;
          height: 1.5rem; margin-bottom: 2.25rem }
  #rail span { width: .375rem; height: .375rem; border-radius: 50%; background: currentColor;
               opacity: .16; transition: opacity .3s }
  #glyph { width: 1.3rem; height: 1.3rem; margin-left: .25rem; opacity: .16;
           transition: opacity .3s }

  /* The wave: each dot in turn, then the mark, then a rest long enough that it
     reads as one thing travelling rather than five things blinking. */
  #rail[data-live] span, #rail[data-live] #glyph { animation: rail 2s ease-in-out infinite }
  #rail span:nth-of-type(2) { animation-delay: .15s }
  #rail span:nth-of-type(3) { animation-delay: .3s }
  #rail span:nth-of-type(4) { animation-delay: .45s }
  #rail[data-live] #glyph { animation-delay: .6s }
  @keyframes rail { 0%, 50%, 100% { opacity: .16 } 20% { opacity: 1 } }

  /* Settled. The mark is always legible; the dots behind it only light up when
     the device got where it was going. */
  #rail:not([data-live]) #glyph { opacity: 1 }
  #rail[data-lit] span { opacity: .5 }

  @media (prefers-reduced-motion: reduce) {
    #rail[data-live] span, #rail[data-live] #glyph { animation: none }
    #rail[data-live] #glyph { opacity: 1 }
  }

  h1 { font-size: 1.5rem; line-height: 1.25; margin: 0 0 .75rem; letter-spacing: -.01em }
  #lede { margin: 0 0 1.75rem; opacity: .75 }

  input, button { font: inherit; width: 100%; padding: .8rem .9rem; border-radius: .6rem }
  input { border: 1px solid color-mix(in srgb, currentColor 30%, transparent); background: none;
          color: inherit; margin-bottom: .6rem }
  button { border: 0; background: currentColor; cursor: pointer }
  button span { color: Canvas; font-weight: 600 }
  button[disabled] { opacity: .4; cursor: default }

  /* The repair, not the action. It is offered to somebody who is already
     enrolled and should not compete with the button they pressed to get there. */
  #again { width: auto; padding: 0; background: none; color: inherit; opacity: .6;
           text-decoration: underline; text-underline-offset: .2em }

  #status { margin-top: 1.25rem; white-space: pre-wrap }
  #status[data-error] { padding: .8rem .9rem; border-radius: .6rem;
                        background: color-mix(in srgb, currentColor 8%, transparent) }
  noscript { display: block; opacity: .75 }
</style>

<!-- The five marks the rail can end in, defined once and referenced by id. Line
     art rather than emoji: an emoji is somebody else's typeface at somebody
     else's weight, and these have to sit beside the dots as if drawn with them. -->
<svg aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden">
  <symbol id="g-install" viewBox="0 0 24 24">
    <path d="M12 3v11"/><path d="M8.5 6.5 12 3l3.5 3.5"/>
    <path d="M7.5 10.5H6a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-1.5"/>
  </symbol>
  <symbol id="g-blocked" viewBox="0 0 24 24"><path d="m7 7 10 10M17 7 7 17"/></symbol>
  <symbol id="g-invite" viewBox="0 0 24 24">
    <circle cx="7.5" cy="12" r="3.5"/><path d="M11 12h9"/>
    <path d="M17.5 12v3"/><path d="M20 12v2.5"/>
  </symbol>
  <symbol id="g-allow" viewBox="0 0 24 24">
    <path d="M12 3.5A5.5 5.5 0 0 0 6.5 9c0 4.2-1.5 5.5-1.5 5.5h14S17.5 13.2 17.5 9A5.5 5.5 0 0 0 12 3.5Z"/>
    <path d="M10 18a2 2 0 0 0 4 0"/>
  </symbol>
  <symbol id="g-enrolled" viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5"/></symbol>
</svg>

<main id="app">
  <div id="rail" aria-hidden="true"><span></span><span></span><span></span><span></span><svg
    id="glyph" fill="none" stroke="currentColor" stroke-width="1.7"
    stroke-linecap="round" stroke-linejoin="round"><use id="mark" href="#g-allow"/></svg></div>
  <h1 id="heading">${title}</h1>
  <p id="lede"></p>
  <form id="form" hidden>
    ${inviteField}<button type="submit"><span>Enable notifications</span></button>
  </form>
  <button id="again" type="button" hidden>Nothing arriving? Enroll again</button>
  <div id="status" role="status" aria-live="polite"></div>
  <noscript>This page needs JavaScript to enroll a device.</noscript>
</main>

<script type="module">
// A closing script tag ends this element even inside a JS string or a comment,
// because the HTML tokenizer never parses the JavaScript to find out. That is
// what the escaping below is for, and it is why no comment in here may spell one
// out: writing the tag to explain the precaution is itself the bug.
const SUBSCRIBE_PATH = ${JSON.stringify(options.subscribePath).replace(/</g, "\\u003c")};
const PUBLIC_KEY_PATH = ${JSON.stringify(options.publicKeyPath).replace(/</g, "\\u003c")};

const rail = document.getElementById("rail");
const mark = document.getElementById("mark");
const heading = document.getElementById("heading");
const lede = document.getElementById("lede");
const form = document.getElementById("form");
const again = document.getElementById("again");
const status = document.getElementById("status");
const invite = document.getElementById("invite");

// The operator's title, whatever they configured it to. Read off the rendered
// heading rather than re-escaped into this script, so there is one copy of it.
const TITLE = heading.textContent;

const installed = window.navigator.standalone === true ||
  window.matchMedia("(display-mode: standalone)").matches;
const iOS = /iPad|iPhone|iPod/.test(navigator.userAgent);

// Where the rail stops. "blocked" and "enrolled" are the two answers nothing
// further is going to change, so those are the two where the dots hold still;
// the other three are all waiting on the person holding the phone.
const FINAL = { blocked: true, enrolled: true };

/**
 * Show exactly one screen. Everything the operator's reader sees goes through
 * here, so there is never a half-state with a stale instruction above a fresh
 * form, which is the failure the old single-screen layout kept producing.
 *
 * The mark names the rail's end: install, blocked, invite, allow, enrolled.
 */
function show({ mark: at, title, body, withForm = false, withAgain = false }) {
  mark.setAttribute("href", "#g-" + at);
  rail.toggleAttribute("data-live", FINAL[at] !== true);
  rail.toggleAttribute("data-lit", at === "enrolled");
  heading.textContent = title;
  lede.textContent = body;
  form.hidden = !withForm;
  again.hidden = !withAgain;
  status.textContent = "";
  delete status.dataset.error;
}

function fail(message) {
  status.textContent = message;
  status.dataset.error = "";
}

// Deleting the icon is the one action that destroys a subscription with nothing
// anywhere reporting it, so it is worth saying on every screen that follows one.
const KEEP_ICON = iOS
  ? " Keep the Home Screen icon: deleting it removes the subscription, and nothing " +
    "anywhere reports that it is gone."
  : "";

/** The screen that asks. Reached on a first visit, and again from "Enroll again". */
function askToEnrol() {
  show({
    mark: invite === null ? "allow" : "invite",
    title: TITLE,
    body: invite === null
      ? "Allow notifications when your browser asks, and this device is enrolled."
      : "Enter your invite code, then allow notifications when your browser asks.",
    withForm: true,
  });
}

// On iOS, push exists only in an installed web app. In a Safari tab
// window.pushManager is simply absent, so the failure looks like a broken page
// rather than a missing step. Say the step out loud instead.
if (iOS && !installed) {
  show({
    mark: "install",
    title: "Add this to your Home Screen",
    body: "Tap the Share button, choose Add to Home Screen, then open this from the " +
      "new icon to carry on. Notifications cannot be enabled from a browser tab: " +
      "that is Apple's rule rather than this app's.",
  });
} else if (!("pushManager" in window)) {
  show({
    mark: "blocked",
    title: "This browser cannot enroll",
    // What to do instead, and nothing else. The version numbers earn their place
    // because without them an old Safari reads "use Safari" while already being
    // Safari; the Home Screen step does not, because it is what the screen above
    // says at the moment it applies, to somebody who has already got there.
    body: "Open this page in Safari, on an iPhone or iPad running iOS 18.4 or later, " +
      "or on a Mac running Safari 18.5 or later. No other browser can receive these " +
      "notifications yet.",
  });
} else {
  // Whether this device is already enrolled is the one thing this page cannot
  // answer without asking. The browser keeps the subscription with the installed
  // app, so a device that enrolled last week arrives holding one, and asking it
  // to "Enable notifications" it enabled long ago reads as though the enrollment
  // did not take. Permission is checked alongside it because a subscription
  // whose permission was revoked afterwards is not going to display anything.
  // try/catch rather than a rejection handler: a Safari that has pushManager but
  // not getSubscription would throw synchronously, and an uncaught throw at
  // module top level leaves this page rendered with no instruction on it at all.
  let existing = null;
  if (Notification.permission === "granted") {
    try {
      existing = await window.pushManager.getSubscription();
    } catch {
      existing = null;
    }
  }

  if (existing) {
    // Enrolled here is not quite proof of enrolled there: the deployment could
    // have lost the row, and nothing on this side would know. Hence the repair
    // below, which re-posts the same subscription. The store keys on the
    // endpoint, so doing it twice costs nothing and changes nothing.
    show({
      mark: "enrolled",
      title: "This device is already enrolled",
      body: "Notifications from this deployment arrive here." + KEEP_ICON,
      withAgain: true,
    });
  } else {
    askToEnrol();
  }
}

again.addEventListener("click", askToEnrol);

function b64urlToBytes(s) {
  const b64 = (s + "=".repeat((4 - s.length % 4) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

/**
 * Whether a subscription this browser already holds was created under the key
 * the deployment serves today.
 *
 * Answering "no" costs the caller a subscription, so this answers "yes" only
 * about bytes it has actually compared. A browser that does not expose
 * PushSubscription.options gives it nothing to compare, and the caller must
 * treat that as unknown rather than as a mismatch.
 */
function sameKey(held, wanted) {
  if (!held) return false;
  const bytes = new Uint8Array(held);
  if (bytes.length !== wanted.length) return false;
  return bytes.every((byte, i) => byte === wanted[i]);
}

/**
 * Drop a subscription that was created under a VAPID key this deployment no
 * longer has, so that subscribe() below has a clean slate to work on.
 *
 * A subscription is bound to the key that created it. Calling subscribe() with
 * a different one does not replace it, it throws InvalidStateError: "Provided
 * applicationServerKey does not match the key in the existing subscription."
 * A device reaches that state whenever the deployment's keypair is replaced,
 * which is the one and only way Kukuroo offers to move off a keypair, and it
 * reaches it with no way out: the error repeats on every attempt, and the only
 * remaining fix is deleting the installed app, which is not something an
 * enrollment page can ask for.
 *
 * Unsubscribing loses nothing that still worked. The push service signs against
 * the key that created the subscription, so one made under the old key already
 * rejects everything this deployment sends. The row it left in the store is
 * deleted by the next send, which prunes on 404 and 410.
 *
 * Returns whatever subscription this browser is still holding afterwards, for
 * the caller to fall back on if subscribe() throws anyway.
 */
async function clearMismatchedSubscription(key) {
  let existing = null;
  try {
    existing = await window.pushManager.getSubscription();
  } catch {
    return null;
  }
  if (existing === null) return null;

  // Deliberately not "if we cannot tell, unsubscribe". Re-subscribing mints a
  // fresh endpoint, so guessing wrong here silently re-enrolls a device that was
  // fine and leaves its old row for a later send to sweep up. Where the key
  // cannot be read, the mismatch is left to announce itself as a throw.
  const held = existing.options ? existing.options.applicationServerKey : null;
  if (held === null) return existing;
  if (sameKey(held, key)) return existing;

  await existing.unsubscribe();
  return null;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = form.querySelector("button");
  button.disabled = true;
  status.textContent = "";
  delete status.dataset.error;

  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") throw new Error("Notification permission was " + permission);

    const keyResponse = await fetch(PUBLIC_KEY_PATH);
    if (!keyResponse.ok) throw new Error("could not read the server's VAPID public key");
    const { publicKey } = await keyResponse.json();

    const key = b64urlToBytes(publicKey);
    const stillHeld = await clearMismatchedSubscription(key);

    const subscribe = () => window.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: key,
    });

    let subscription;
    try {
      subscription = await subscribe();
    } catch (error) {
      // The mismatch the check above could not see, because this browser keeps
      // PushSubscription.options to itself. Now it is not a guess: the browser
      // has said which state it is in, so the subscription can go and the one
      // attempt that was refused can be made again. Once. A second throw is
      // about something else and belongs in front of the reader.
      if (error.name !== "InvalidStateError" || stillHeld === null) throw error;
      await stillHeld.unsubscribe();
      subscription = await subscribe();
    }

    const response = await fetch(SUBSCRIBE_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // The field is absent when the deployment does not gate enrollment, so the
      // key is absent too rather than sent empty. One code path, either way.
      body: JSON.stringify({
        ...(invite === null ? {} : { invite: invite.value.trim() }),
        subscription: subscription.toJSON(),
        label: navigator.platform || "device",
      }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || ("subscribe failed: HTTP " + response.status));
    }

    // The rail comes to rest with every dot lit, no form, and the one thing that
    // silently destroys a subscription said out loud while the reader is still
    // looking at the icon.
    show({
      mark: "enrolled",
      title: "This device is enrolled",
      body: "Notifications from this deployment will arrive here from now on." + KEEP_ICON,
    });
  } catch (error) {
    fail("Failed: " + error.message);
    button.disabled = false;
  }
});
</script>
`;
}
