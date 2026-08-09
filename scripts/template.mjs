//
// What `kukuroo init` writes, and the snippets it prints.
//
// worker.ts and wrangler.jsonc both vary with the answers, so they are generated
// here rather than copied and patched: patching somebody's TypeScript or config
// with a regular expression is a promise that breaks the first time the file is
// edited. package.json and tsconfig.json are copied from templates/standalone
// verbatim.
//
// Both generated files are also on disk under templates/standalone, so the
// template stays a working example for anyone who copies it by hand, and
// test/scaffold.test.mjs pins each against the function that writes it.
//

export const TEMPLATE_ANSWERS = { frontEnd: true, requireInvite: true };

/**
 * What the checked-in wrangler.jsonc is: the custom-domain answer.
 *
 * Not the wizard's default, which is workers.dev, because that one cannot name
 * its own origin until a deploy has revealed the account subdomain. The file on
 * disk is for the person copying it by hand, and they are better served by the
 * complete shape, with a route and a navigate origin both visible.
 */
export const TEMPLATE_WRANGLER = {
  name: "kukuroo",
  origin: { kind: "domain", hostname: "push.example.com" },
};

/** Where the README explains whatever the operator just chose. */
export const README = "https://github.com/saiday/kukuroo";
export const README_SECTIONS = {
  standalone: `${README}#standalone`,
  mounted: `${README}#mounted`,
  // The origins table lives under Mounted: choosing where devices enrol is the
  // same decision as choosing whether to mount, so the README tells it once.
  ownUi: `${README}#mounted`,
  api: `${README}#api`,
};

/**
 * The origin, as the operator answered it.
 *
 *   { kind: "workers-dev", url: null }   before the first deploy names it
 *   { kind: "workers-dev", url: "https://my-push.acme.workers.dev" }
 *   { kind: "domain", hostname: "push.example.com" }
 *
 * A workers.dev address is `<worker>.<account-subdomain>.workers.dev`, and there
 * is no wrangler command that reports the account subdomain, so the first render
 * genuinely does not know the origin. `url` is null then, and the only honest
 * thing to do is leave KUKUROO_NAVIGATE_ORIGIN out: enforcement is off until the
 * second deploy switches it on, which is true, whereas a placeholder would be a
 * wrong value quietly live on a real Worker.
 */
export function originUrl(origin) {
  return origin.kind === "domain" ? `https://${origin.hostname}` : origin.url;
}

/** The Worker's config, with the origin answer already written into it. */
export function wranglerSource({ name, origin }) {
  const url = originUrl(origin);

  const address =
    origin.kind === "domain"
      ? `  // Your own hostname. The zone is already on Cloudflare, so \`wrangler deploy\`
  // provisions the DNS record and the certificate itself.
  "workers_dev": false,
  "routes": [{ "pattern": "${origin.hostname}", "custom_domain": true }],`
      : `  // A workers.dev address, which Cloudflare provides. It is stable indefinitely,
  // so it is a legitimate permanent origin, but only as long as this Worker keeps
  // its name and the account keeps its subdomain: either one moves the origin.
  //
  // To move to a hostname of your own instead, before anyone enrols, replace this
  // line with a route and set KUKUROO_NAVIGATE_ORIGIN to match:
  //   "workers_dev": false,
  //   "routes": [{ "pattern": "push.example.com", "custom_domain": true }],
  "workers_dev": true,`;

  // With no origin yet there is nothing to put in `vars`, and an empty object is
  // the accurate way to say so.
  const vars =
    url === null
      ? `  // KUKUROO_NAVIGATE_ORIGIN is written here by \`kukuroo init\` once the first
  // deploy has revealed this Worker's workers.dev hostname. Until then the
  // navigate origin is not enforced, and the second deploy is what turns it on.
  "vars": {}`
      : `  "vars": {
    // Every notification's \`navigate\` must be on this origin. Serving enrolment
    // and push from one origin is what keeps a notification click inside the
    // installed web app, but that only makes same-origin *likely*: without this,
    // the guarantee rests on every future caller remembering. It does not
    // restrict \`icon\`, which legitimately points at a CDN.
    "KUKUROO_NAVIGATE_ORIGIN": "${url}"

    // If pages on another origin call subscribe and public-key from the browser,
    // list their exact origins. There is no wildcard:
    //
    // ,"KUKUROO_ALLOWED_ORIGINS": "https://www.example.com"
  }`;

  return `{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "${name}",
  "main": "src/worker.ts",
  "compatibility_date": "2026-03-17",

  // ---------------------------------------------------------------------------
  // The origin devices enrol on, answered during \`kukuroo init\`.
  //
  // Moving it later does not stop delivery to devices already enrolled, because
  // the push service never sees this hostname. What it costs is your own side of
  // it: a page on a different origin cannot read or repair subscriptions created
  // on the old one, so you can neither re-subscribe nor verify them, and a
  // notification click navigates to an address you no longer serve. Which is why
  // the wizard asks before it deploys, rather than leaving it to be discovered.
  //
  // \`preview_urls: false\` is the one that catches people. A preview URL is a
  // real, working, enrollable origin, and it is *per version*, so a subscription
  // created against one during a five-minute test appears to work and then never
  // delivers again. Leave it false.
  // ---------------------------------------------------------------------------
  "preview_urls": false,

${address}

  // Subscriptions. The binding name is not configurable; Kukuroo looks for
  // exactly this. Leaving out "id" lets wrangler create the namespace on the
  // first deploy.
  "kv_namespaces": [{ "binding": "KUKUROO_SUBS" }],

${vars}

  // Note there is no KUKUROO_VAPID_PUBLIC here. The keypair is stored as a JWK
  // in the KUKUROO_VAPID_PRIVATE secret, so the public half is derived from it
  // and served at /push/public-key. Two values that must agree forever is a
  // failure waiting to happen, so there is only one.
}
`;
}

/**
 * The Worker's entry point, for either scaffolded shape.
 *
 * Every answer is written out explicitly, including the ones that match the
 * library defaults. This file is the only place the deployment's shape is
 * visible, and an option that is absent because it defaults correctly reads,
 * six months later, exactly like an option nobody considered.
 */
export function workerSource({ frontEnd, requireInvite }) {
  const enrolRoute = frontEnd
    ? " *   GET  /push/enroll      the enrolment page you add to your Home Screen\n"
    : "";
  const subscribeGate = requireInvite
    ? " *   POST /push/subscribe   invite-gated"
    : " *   POST /push/subscribe   open: anyone with this URL can enrol a device";

  const purpose = frontEnd
    ? `/**
 * A standalone Kukuroo deployment: a notification sink and nothing else.
 *`
    : `/**
 * A standalone Kukuroo deployment with no enrolment page of its own: the push
 * API at its own address, for a UI you serve somewhere else.
 *`;

  const frontEndNote = frontEnd
    ? `// \`standalone: true\` is what serves the bundled enrolment page. Without it
// /push/enroll is not routed at all, on the assumption that the host has its own.`
    : `// \`standalone: false\`: no enrolment page is served here, because you said you
// would bring your own. The page that calls /push/subscribe lives on another
// origin, so that origin has to be listed in KUKUROO_ALLOWED_ORIGINS in
// wrangler.jsonc, or the browser will refuse the call before it is made.
// See ${README_SECTIONS.ownUi}.`;

  const gateNote = requireInvite
    ? `// \`requireInvite: true\` keeps the code on /push/subscribe: a stranger who finds
// this URL cannot enrol their own device and start reading your notifications.
// Turn it off only if enrolment is meant to be open to whoever turns up.`
    : `// \`requireInvite: false\` means enrolment is open: anyone who reaches this URL
// can add their own device and will receive everything you send afterwards. The
// code still exists, generated and stored as KUKUROO_INVITE_CODE, so closing the
// gate is one word here and a deploy. Nothing re-enrols.`;

  // With no page of ours to send people to, / is not a redirect: it is a 404
  // like any other unrouted path, and saying so beats bouncing them at a route
  // that is not mounted.
  const fallthrough = frontEnd
    ? `    // Send people to the page that does something, rather than a bare 404.
    if (new URL(request.url).pathname === "/") {
      return Response.redirect(new URL("/push/enroll", request.url).toString(), 302);
    }

    return new Response("Not found\\n", { status: 404 });`
    : `    return new Response("Not found\\n", { status: 404 });`;

  return `${purpose}
${enrolRoute} *   GET  /push/public-key  the VAPID public key, for the enrolment page
${subscribeGate}
 *   POST /push/send        bearer-gated, encrypts and fans out
 *
 * If you already have a Worker, you do not need this file. Import
 * \`mountKukuroo\` there instead and put the routes on the origin you already own.
 */

import { mountKukuroo, type KukurooEnv } from "kukuroo";

${frontEndNote}
//
${gateNote}
const kukuroo = mountKukuroo({
  prefix: "/push",
  standalone: ${frontEnd},
  requireInvite: ${requireInvite},
});

export default {
  async fetch(request: Request, env: KukurooEnv): Promise<Response> {
    // \`handle\` returns null for anything outside its prefix, so a host Worker
    // keeps control of its own routing. Here there is nothing else to route.
    const response = await kukuroo.handle(request, env);
    if (response !== null) return response;

${fallthrough}
  },
} satisfies ExportedHandler<KukurooEnv>;
`;
}

/** Written into the scaffolded project, before anything can be committed. */
export const SCAFFOLD_GITIGNORE = `node_modules/
.wrangler/

# Holds a VAPID private key that can never be rotated. Losing it means
# re-enrolling every device by hand; publishing it means anyone can notify them.
kukuroo.credentials.json
`;

/** What the mounted answer prints instead of a project. */
export function mountedSnippet({ frontEnd, requireInvite }) {
  const ui = frontEnd
    ? `\`standalone: true\` serves the bundled enrolment page at /push/enroll, on your
own origin, which is where a notification tap should land anyway.`
    : `You said you would serve your own enrolment UI. It needs two calls:
GET /push/public-key for the VAPID key, then POST /push/subscribe with what
\`pushManager.subscribe()\` handed back${requireInvite ? ' and an "invite" field' : ""}.
src/enroll-page.ts in this package is the fifteen lines of client JS to copy.
On iOS the page must carry the installability metadata, because a subscription
only exists once it has been added to the Home Screen and opened from the icon.`;

  return `  import { mountKukuroo, type KukurooEnv } from "kukuroo";

  const kukuroo = mountKukuroo({
    prefix: "/push",
    standalone: ${frontEnd},
    requireInvite: ${requireInvite},
  });

  export default {
    async fetch(request: Request, env: KukurooEnv): Promise<Response> {
      const hit = await kukuroo.handle(request, env);
      return hit ?? yourExistingRouter(request, env);
    },
  };

Bind the KV namespace in your wrangler.jsonc. The binding name is not
configurable, and leaving out "id" lets wrangler create the namespace:

  "kv_namespaces": [{ "binding": "KUKUROO_SUBS" }]

${ui}`;
}
