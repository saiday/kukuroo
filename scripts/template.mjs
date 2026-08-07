//
// What `kukuroo init` writes, and the snippets it prints.
//
// The generated worker.ts is the only scaffolded file that varies with the
// answers, so it lives here rather than being copied and patched: patching
// somebody's TypeScript with a regular expression is a promise that breaks the
// first time the file is edited. wrangler.jsonc, package.json and tsconfig.json
// are copied from templates/standalone verbatim.
//
// templates/standalone/src/worker.ts is the default-answers output of the
// function below, kept on disk so the template stays a working example for
// anyone who copies it by hand. test/scaffold.test.mjs pins them together.
//

export const TEMPLATE_ANSWERS = { frontEnd: true, requireInvite: true };

/** Where the README explains the shape somebody just chose. */
export const README = "https://github.com/saiday/kukuroo";
export const README_SECTIONS = {
  standalone: `${README}#standalone`,
  mounted: `${README}#mounted`,
  ownUi: `${README}#using-kukuroo-with-an-existing-website`,
};

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
