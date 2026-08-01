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
  /** Where the page posts the subscription. */
  subscribePath: string;
  /** Where the page fetches the VAPID public key `subscribe()` needs. */
  publicKeyPath: string;
  title?: string;
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
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="robots" content="noindex, nofollow">
<title>${title}</title>
<style>
  :root { color-scheme: light dark }
  body { margin: 0; padding: 2rem 1.25rem; font: 16px/1.55 -apple-system, system-ui, sans-serif;
         max-width: 32rem; margin-inline: auto }
  h1 { font-size: 1.25rem; margin: 0 0 1rem }
  input, button { font: inherit; width: 100%; padding: .7rem .8rem; border-radius: .5rem;
                  box-sizing: border-box }
  input { border: 1px solid color-mix(in srgb, currentColor 30%, transparent); background: none;
          color: inherit; margin-bottom: .75rem }
  button { border: 0; background: currentColor; cursor: pointer }
  button span { color: Canvas; font-weight: 600 }
  button[disabled] { opacity: .4 }
  #status { margin-top: 1rem; white-space: pre-wrap }
  .warn { padding: .8rem; border-radius: .5rem;
          background: color-mix(in srgb, currentColor 8%, transparent) }
</style>

<h1>${title}</h1>
<div id="gate" class="warn" hidden></div>
<form id="form">
  <input id="invite" type="text" placeholder="Invite code" autocomplete="off"
         autocapitalize="off" autocorrect="off" spellcheck="false" required>
  <button type="submit"><span>Enable notifications</span></button>
</form>
<div id="status"></div>

<script type="module">
// JSON.stringify does not escape "</script>", so the closing bracket is split.
const SUBSCRIBE_PATH = ${JSON.stringify(options.subscribePath).replace(/</g, "\\u003c")};
const PUBLIC_KEY_PATH = ${JSON.stringify(options.publicKeyPath).replace(/</g, "\\u003c")};

const gate = document.getElementById("gate");
const form = document.getElementById("form");
const status = document.getElementById("status");

const installed = window.navigator.standalone === true ||
  window.matchMedia("(display-mode: standalone)").matches;
const iOS = /iPad|iPhone|iPod/.test(navigator.userAgent);

// On iOS, push exists only in an installed web app. In a Safari tab
// window.pushManager is simply absent, so the failure looks like a broken page
// rather than a missing step. Say the step out loud instead.
if (iOS && !installed) {
  gate.hidden = false;
  gate.textContent = "Open the Share menu, choose Add to Home Screen, then open this " +
    "page from the new icon. Notifications cannot be enabled from a Safari tab.";
  form.hidden = true;
} else if (!("pushManager" in window)) {
  gate.hidden = false;
  gate.textContent = "This browser does not support Declarative Web Push. " +
    "iOS 18.4 or later is required.";
  form.hidden = true;
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
      body: JSON.stringify({
        invite: document.getElementById("invite").value.trim(),
        subscription: subscription.toJSON(),
        label: navigator.platform || "device",
      }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || ("subscribe failed: HTTP " + response.status));
    }

    status.textContent = "Enrolled. This device will now receive notifications.";
    form.hidden = true;
  } catch (error) {
    status.textContent = "Failed: " + error.message;
    button.disabled = false;
  }
});
</script>
`;
}
