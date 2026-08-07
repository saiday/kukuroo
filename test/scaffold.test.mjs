// What `kukuroo init` writes. Two things are worth pinning here.
//
// The first is drift: templates/standalone/src/worker.ts is on disk for people
// who copy the template by hand, and it is also the generator's output for the
// default answers. Nothing but this check keeps the two saying the same thing,
// and a template that has quietly fallen behind the wizard is worse than no
// template at all.
//
// The second is that the answer reaches the generated code at all. A wizard
// that asks a question and writes the same file either way is the failure this
// whole feature would be.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SCAFFOLD_GITIGNORE, TEMPLATE_ANSWERS, mountedSnippet, workerSource } from "../scripts/template.mjs";

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
ok("both mount the enrolment page", gated.includes("standalone: true") &&
  open.includes("standalone: true"));
ok("the open answer says so in the route list", open.includes("anyone with this URL"));
ok("the gated answer does not", !gated.includes("anyone with this URL"));

// No bundled front end: the page is not routed, so nothing should redirect to
// it, and the operator's own origin has to be told about instead.
const apiOnly = workerSource({ frontEnd: false, requireInvite: true });
ok("the no-front-end answer writes standalone: false", apiOnly.includes("standalone: false"));
ok("it does not route or advertise the enrolment page",
  !apiOnly.includes("/push/enroll"));
ok("it names the variable that lets another origin enrol",
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
