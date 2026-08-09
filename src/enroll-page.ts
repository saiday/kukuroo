/**
 * The bundled enrolment page, for standalone deployments.
 *
 * Mounted deployments serve their own UI on their own origin and never reach
 * this. It exists because a push subscription is bound to an origin and on iOS
 * that origin must be installed to the Home Screen, so Kukuroo cannot be a pure
 * API: it has to be able to serve the surface that gets installed.
 *
 * The page is deliberately one file with no build step. It is the last thing
 * anyone wants to debug on a phone.
 */

export interface EnrolmentPageOptions {
  /**
   * Where the page posts the subscription: a path on the serving origin, or an
   * absolute URL when the page is served by a host on one origin and Kukuroo
   * runs on another (which needs KUKUROO_ALLOWED_ORIGINS set on the Worker).
   */
  subscribePath: string;
  /** Where the page fetches the VAPID public key; path or absolute URL, as above. */
  publicKeyPath: string;
  title?: string;
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

export function enrolmentPage(options: EnrolmentPageOptions): string {
  const title = escapeHtml(options.title ?? "Enrol this device");
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
<meta name="apple-mobile-web-app-title" content="${title}">
<meta name="mobile-web-app-capable" content="yes">
<meta name="robots" content="noindex, nofollow">
<title>${title}</title>
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

  /* One dot per step that applies to this browser, so the count is never a lie. */
  #rail { display: flex; gap: .45rem; justify-content: center; margin-bottom: 2.25rem }
  #rail span { width: .5rem; height: .5rem; border-radius: 50%; background: currentColor;
               opacity: .18; transition: opacity .2s }
  #rail span[data-done] { opacity: .5 }
  #rail span[data-on] { opacity: 1 }

  h1 { font-size: 1.5rem; line-height: 1.25; margin: 0 0 .75rem; letter-spacing: -.01em }
  #lede { margin: 0 0 1.75rem; opacity: .75 }

  input, button { font: inherit; width: 100%; padding: .8rem .9rem; border-radius: .6rem }
  input { border: 1px solid color-mix(in srgb, currentColor 30%, transparent); background: none;
          color: inherit; margin-bottom: .6rem }
  button { border: 0; background: currentColor; cursor: pointer }
  button span { color: Canvas; font-weight: 600 }
  button[disabled] { opacity: .4; cursor: default }

  #status { margin-top: 1.25rem; white-space: pre-wrap }
  #status[data-error] { padding: .8rem .9rem; border-radius: .6rem;
                        background: color-mix(in srgb, currentColor 8%, transparent) }
  noscript { display: block; opacity: .75 }
</style>

<main id="app">
  <div id="rail" aria-hidden="true" hidden></div>
  <h1 id="heading">${title}</h1>
  <p id="lede"></p>
  <form id="form" hidden>
    ${inviteField}<button type="submit"><span>Enable notifications</span></button>
  </form>
  <div id="status" role="status" aria-live="polite"></div>
  <noscript>This page needs JavaScript to enrol a device.</noscript>
</main>

<script type="module">
// A closing script tag ends this element even inside a JS string or a comment,
// because the HTML tokenizer never parses the JavaScript to find out. That is
// what the escaping below is for, and it is why no comment in here may spell one
// out: writing the tag to explain the precaution is itself the bug.
const SUBSCRIBE_PATH = ${JSON.stringify(options.subscribePath).replace(/</g, "\\u003c")};
const PUBLIC_KEY_PATH = ${JSON.stringify(options.publicKeyPath).replace(/</g, "\\u003c")};

const rail = document.getElementById("rail");
const heading = document.getElementById("heading");
const lede = document.getElementById("lede");
const form = document.getElementById("form");
const status = document.getElementById("status");
const invite = document.getElementById("invite");

// The operator's title, whatever they configured it to. Read off the rendered
// heading rather than re-escaped into this script, so there is one copy of it.
const TITLE = heading.textContent;

const installed = window.navigator.standalone === true ||
  window.matchMedia("(display-mode: standalone)").matches;
const iOS = /iPad|iPhone|iPod/.test(navigator.userAgent);

// iOS can only enrol from an installed web app, so it has a step that macOS does
// not, and the rail is built from the steps that actually apply. A fixed "1 of 3"
// would be wrong on half the devices that reach this page.
const steps = iOS ? ["install", "enrol"] : ["enrol"];

/** Fill the rail: everything before the current step is done, everything after pending. */
function paint(current) {
  rail.hidden = steps.length < 2 || current < 0;
  rail.replaceChildren();
  for (let i = 0; i < steps.length; i++) {
    const dot = document.createElement("span");
    if (i < current) dot.dataset.done = "";
    if (i === current) dot.dataset.on = "";
    rail.append(dot);
  }
}

/**
 * Show exactly one screen. Everything the operator's reader sees goes through
 * here, so there is never a half-state with a stale instruction above a fresh
 * form, which is the failure the old single-screen layout kept producing.
 */
function show({ step = -1, title, body, withForm = false }) {
  paint(step);
  heading.textContent = title;
  lede.textContent = body;
  form.hidden = !withForm;
  status.textContent = "";
  delete status.dataset.error;
}

function fail(message) {
  status.textContent = message;
  status.dataset.error = "";
}

// On iOS, push exists only in an installed web app. In a Safari tab
// window.pushManager is simply absent, so the failure looks like a broken page
// rather than a missing step. Say the step out loud instead.
if (iOS && !installed) {
  show({
    step: 0,
    title: "Add this to your Home Screen",
    body: "Tap the Share button, choose Add to Home Screen, then open this from the " +
      "new icon to carry on. Notifications cannot be enabled from a browser tab: " +
      "that is Apple's rule rather than this app's.",
  });
} else if (!("pushManager" in window)) {
  show({
    title: "This browser cannot enrol",
    body: "Declarative Web Push has only shipped in Safari so far. Receiving needs an " +
      "iPhone or iPad on iOS 18.4 or later with this page added to the Home Screen, or " +
      "macOS Safari 18.5 or later, where a normal tab works. Chrome, Firefox, and " +
      "Android cannot enrol.",
  });
} else {
  show({
    step: steps.length - 1,
    title: TITLE,
    body: invite === null
      ? "Allow notifications when your browser asks, and this device is enrolled."
      : "Enter your invite code, then allow notifications when your browser asks.",
    withForm: true,
  });
}

function b64urlToBytes(s) {
  const b64 = (s + "=".repeat((4 - s.length % 4) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
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

    const subscription = await window.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: b64urlToBytes(publicKey),
    });

    const response = await fetch(SUBSCRIBE_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // The field is absent when the deployment does not gate enrolment, so the
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

    // Every dot filled, no form, and the one thing that silently destroys a
    // subscription said out loud while the reader is still looking at the icon.
    show({
      step: steps.length,
      title: "This device is enrolled",
      body: "Notifications from this deployment will arrive here from now on." +
        (iOS ? " Keep the Home Screen icon: deleting it removes the subscription, and " +
          "nothing anywhere reports that it is gone." : ""),
    });
  } catch (error) {
    fail("Failed: " + error.message);
    button.disabled = false;
  }
});
</script>
`;
}
