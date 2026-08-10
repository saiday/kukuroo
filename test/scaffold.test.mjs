// What `kukuroo init` writes. Two things are worth pinning here.
//
// The first is drift: templates/standalone/ carries worker.ts and wrangler.jsonc
// on disk for people who copy the template by hand, and both are also generator
// output. Nothing but these checks keeps the two saying the same thing, and a
// template that has quietly fallen behind the wizard is worse than no template
// at all.
//
// The second is that the answer reaches the generated code at all. A wizard
// that asks a question and writes the same file either way is the failure this
// whole feature would be.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SCAFFOLD_GITIGNORE,
  TEMPLATE_ANSWERS,
  TEMPLATE_WRANGLER,
  mountedSnippet,
  originUrl,
  workerSource,
  wranglerSource,
} from "../scripts/template.mjs";

const ok = (label, cond) => {
  console.log(`${cond ? "  ok" : "FAIL"}  ${label}`);
  if (!cond) process.exitCode = 1;
};

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const onDisk = readFileSync(join(root, "templates/standalone/src/worker.ts"), "utf8");

ok(
  "the checked-in template is the generator's default-answers output",
  workerSource(TEMPLATE_ANSWERS) === onDisk,
);

const gated = workerSource({ frontEnd: true, requireInvite: true });
const open = workerSource({ frontEnd: true, requireInvite: false });

ok("the gated answer writes requireInvite: true", gated.includes("requireInvite: true"));
ok("the open answer writes requireInvite: false", open.includes("requireInvite: false"));
ok("neither answer writes the other one", !gated.includes("requireInvite: false") &&
  !open.includes("requireInvite: true"));
ok("both mount the enrollment page", gated.includes("standalone: true") &&
  open.includes("standalone: true"));
ok("the open answer says so in the route list", open.includes("anyone with this URL"));
ok("the gated answer does not", !gated.includes("anyone with this URL"));

// No bundled front end: the page is not routed, so nothing should redirect to
// it, and the operator's own origin has to be told about instead.
const apiOnly = workerSource({ frontEnd: false, requireInvite: true });
ok("the no-front-end answer writes standalone: false", apiOnly.includes("standalone: false"));
ok("it does not route or advertise the enrollment page",
  !apiOnly.includes("/push/enroll"));
ok("it names the variable that lets another origin enroll",
  apiOnly.includes("KUKUROO_ALLOWED_ORIGINS"));
ok("the bundled-page answer needs no such warning",
  !gated.includes("KUKUROO_ALLOWED_ORIGINS"));

ok("the mounted snippet carries both answers",
  mountedSnippet({ frontEnd: false, requireInvite: false }).includes("requireInvite: false") &&
  mountedSnippet({ frontEnd: false, requireInvite: false }).includes("standalone: false"));
ok("mounted with the bundled page says where the page is served",
  mountedSnippet({ frontEnd: true, requireInvite: true }).includes("/push/enroll"));
ok("mounted without it points at the two calls a UI has to make",
  mountedSnippet({ frontEnd: false, requireInvite: true }).includes("/push/public-key"));

// The credentials file is the only copy of a key that cannot be regenerated, and
// the scaffolded project is the directory it lands in.
ok("the scaffolded .gitignore excludes the credentials file",
  SCAFFOLD_GITIGNORE.includes("kukuroo.credentials.json"));

// ---------------------------------------------------------------------------
// wrangler.jsonc, which now carries the origin answer.
//
// The checked-in file is the custom-domain output rather than the wizard's
// default, because the default is workers.dev and that one cannot name its own
// origin until a deploy has revealed the account subdomain. A hand-copier is
// better served by the complete shape.

const wranglerOnDisk = readFileSync(join(root, "templates/standalone/wrangler.jsonc"), "utf8");
ok(
  "the checked-in wrangler.jsonc is the generator's custom-domain output",
  wranglerSource(TEMPLATE_WRANGLER) === wranglerOnDisk,
);

const domain = wranglerSource({ name: "my-push", origin: { kind: "domain", hostname: "push.example.com" } });
const pending = wranglerSource({ name: "my-push", origin: { kind: "workers-dev", url: null } });
const settled = wranglerSource({
  name: "my-push",
  origin: { kind: "workers-dev", url: "https://my-push.acme.workers.dev" },
});

ok("the domain answer routes a custom domain",
  domain.includes('"routes": [{ "pattern": "push.example.com", "custom_domain": true }]') &&
  domain.includes('"workers_dev": false'));
ok("the domain answer enforces its own origin",
  domain.includes('"KUKUROO_NAVIGATE_ORIGIN": "https://push.example.com"'));

ok("the workers.dev answer takes a workers.dev address", pending.includes('"workers_dev": true') &&
  settled.includes('"workers_dev": true'));
// Matched as a live key rather than as a string, because both workers.dev renders
// carry a commented `"routes"` line showing how to move to a hostname of your own.
const routesKey = /^\s*"routes"/m;
ok("neither workers.dev render routes a domain", !routesKey.test(pending) &&
  !routesKey.test(settled));
ok("the domain render does route one", routesKey.test(domain));

// The first of the two workers.dev deploys genuinely does not know the origin. An
// absent navigate origin means unenforced, which is true; a placeholder would be a
// wrong value live on a real Worker, and every send would be rejected against it.
ok("before the deploy names it, no navigate origin is invented",
  !pending.includes('"KUKUROO_NAVIGATE_ORIGIN"'));
ok("after the deploy names it, the navigate origin is written",
  settled.includes('"KUKUROO_NAVIGATE_ORIGIN": "https://my-push.acme.workers.dev"'));

// preview_urls is per version and every preview URL is a real enrollable origin,
// so a subscription made against one during a test never delivers again.
ok("every answer leaves preview URLs off",
  [domain, pending, settled].every((s) => s.includes('"preview_urls": false')));
ok("every answer binds the subscription store",
  [domain, pending, settled].every((s) => s.includes('"binding": "KUKUROO_SUBS"')));

ok("the origin's URL is derived for a domain and read back for workers.dev",
  originUrl({ kind: "domain", hostname: "push.example.com" }) === "https://push.example.com" &&
  originUrl({ kind: "workers-dev", url: null }) === null &&
  originUrl({ kind: "workers-dev", url: "https://x.y.workers.dev" }) === "https://x.y.workers.dev");
