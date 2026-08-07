#!/usr/bin/env node
//
// One-time setup. Asks two questions, writes a deployable Worker, generates
// every secret Kukuroo needs, writes them to a local 0600 file, and installs
// them into the Worker.
//
// The two questions between them decide whether this deployment is a personal
// one. They are asked here, once, rather than left as options nobody discovers:
// an invite gate added after a stranger has enrolled is not the same thing as
// one that was there first, and an enrolment page is either the reason the
// Worker exists or a route that should never have been mounted.
//
// This exists because a Worker Secret is write-only. `wrangler secret list`
// returns names, never values, so a setup flow that says "generate a send token
// and store it as a secret" has quietly destroyed the token by the time anything
// needs to send. The operator then discovers this halfway through enrolling a
// phone, which is the worst possible moment.
//
// So: generate all of it here, at the start, and keep a copy the operator owns.
//
//   npx kukuroo init my-push          first-time setup, scaffold included
//   npx kukuroo rotate send-token
//   npx kukuroo rotate invite-code
//
// The bin is named after the package, not after the command. `npx <name>`
// resolves <name> as a *package*, so a bin called `kukuroo-init` inside package
// `kukuroo` is only reachable as `npx --package kukuroo kukuroo-init`, and a
// README that says `npx kukuroo-init` is telling people to install a package
// that does not exist.
//
// There is deliberately no rotate for the VAPID keypair. See refuseVapidRotation.

import { webcrypto as crypto } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  README_SECTIONS,
  SCAFFOLD_GITIGNORE,
  mountedSnippet,
  workerSource,
} from "./template.mjs";

// Where the credentials file goes and where wrangler runs. It is the current
// directory for every command except a scaffolded init, which moves both into
// the project it just created, so that `wrangler secret put` reads that
// project's config and the credentials land beside the Worker they belong to.
let workDir = process.cwd();
const credentialsPath = () => resolve(workDir, "kukuroo.credentials.json");

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE_DIR = join(PACKAGE_ROOT, "templates", "standalone");

const SECRET_NAMES = {
  vapidPrivateKey: "KUKUROO_VAPID_PRIVATE",
  sendToken: "KUKUROO_SEND_TOKEN",
  inviteCode: "KUKUROO_INVITE_CODE",
};

const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
const die = (message) => {
  console.error("\n" + message + "\n");
  process.exit(1);
};

// ---------------------------------------------------------------------------

async function generateVapidKeypair() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return {
    // Recorded for the operator's reference and for interoperability with tools
    // that want the raw point. Kukuroo derives it from the key below and does
    // not need it configured.
    vapidPublicKey: b64url(await crypto.subtle.exportKey("raw", pair.publicKey)),
    // Stored as a JWK rather than the bare 32-byte scalar, because a JWK carries
    // `x` and `y` too. That means the deployment has one VAPID value instead of
    // two, and two values that must agree forever is a failure waiting to
    // happen: a mismatched pair sends cleanly and delivers nothing.
    vapidPrivateKey: JSON.stringify({ kty: "EC", crv: "P-256", d: jwk.d, x: jwk.x, y: jwk.y }),
  };
}

const randomToken = () => b64url(crypto.getRandomValues(new Uint8Array(32)));

/**
 * Somebody types this on a phone keyboard, once. So: no mixed case, and no
 * characters that argue with each other in a sans-serif font. Crockford's
 * alphabet minus the vowels, which also means it cannot accidentally spell
 * anything. 10 characters of a 27-symbol alphabet is a little over 47 bits,
 * which is far more than enough for a code that gates one manual enrolment.
 */
const INVITE_ALPHABET = "23456789bcdfghjkmnpqrstvwxyz";
const randomInviteCode = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(10)))
    // Modulo bias over a 28-symbol alphabet is negligible here and the
    // alternative is rejection sampling for no security benefit.
    .map((byte) => INVITE_ALPHABET[byte % INVITE_ALPHABET.length])
    .join("");

// ---------------------------------------------------------------------------

function wrangler(args, { stdin, captureStderr = false } = {}) {
  return execFileSync("npx", ["wrangler", ...args], {
    cwd: workDir,
    input: stdin,
    encoding: "utf8",
    // stderr is inherited by default so wrangler's own diagnostics reach the
    // operator. The probe below captures it instead, because there it is an
    // expected answer rather than a problem worth showing.
    stdio: ["pipe", "pipe", captureStderr ? "pipe" : "inherit"],
  });
}

/**
 * Which secrets the Worker already holds, or null if the Worker does not exist
 * yet. This is the guard that makes the script safe to run twice: `wrangler
 * secret put` overwrites without asking, and overwriting KUKUROO_VAPID_PRIVATE
 * destroys every enrolled device with no error anywhere.
 *
 * `wrangler secret list` does *not* return an empty array for a Worker that has
 * never been deployed. It exits non-zero with "Worker ... not found" on stderr
 * and writes nothing at all to stdout, so treating any failure as fatal would
 * reject every genuine first-time user, which is the only case this script
 * really exists for. A Worker that does not exist holds no secrets; that is not
 * an error, it is the answer.
 *
 * `secret put` creates a draft Worker on demand, so setup legitimately runs
 * before the first deploy.
 */
function existingSecretNames() {
  let output;
  try {
    output = wrangler(["secret", "list"], { captureStderr: true });
  } catch (error) {
    // Distinguish "no Worker yet" from "wrangler cannot talk to Cloudflare at
    // all". Only the second is worth stopping for, and the difference matters:
    // one is a normal first run, the other is a misconfiguration that would
    // otherwise be silently reinterpreted as "no secrets exist" and walked past.
    const stderr = String(error.stderr ?? "");
    if (/not found/i.test(stderr)) return null;
    die(
      "Could not read the Worker's secret list. wrangler said:\n\n" +
        stderr.trim() +
        "\n\nRun this from the directory holding your wrangler config, with wrangler\n" +
        "authenticated (`npx wrangler login`).",
    );
  }

  try {
    return JSON.parse(output).map((s) => s.name);
  } catch {
    die(`Could not parse the output of \`wrangler secret list\`:\n\n${output}`);
  }
}

function putSecret(name, value) {
  // Piped on stdin, never as an argument, so the value stays out of the process
  // table and out of shell history.
  wrangler(["secret", "put", name], { stdin: value });
  console.log(`  set ${name}`);
}

/**
 * Make sure the credentials file cannot be committed.
 *
 * It holds a private key that can never be rotated, and it is written into
 * whatever directory the operator happened to run this from, which is usually a
 * git repository. "Pushed my VAPID private key to GitHub on the first day" is a
 * very achievable outcome, and a printed warning is not a control: people skim
 * printed warnings. So do it for them.
 */
function ensureGitignored() {
  const name = "kukuroo.credentials.json";
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: workDir, stdio: "ignore" });
  } catch {
    return; // Not a repository. Nothing to protect against.
  }

  try {
    execFileSync("git", ["check-ignore", "-q", name], { cwd: workDir, stdio: "ignore" });
    return; // Already ignored.
  } catch {
    // Not ignored; fall through and fix it.
  }

  const gitignore = resolve(workDir, ".gitignore");
  const existing = existsSync(gitignore) ? readFileSync(gitignore, "utf8") : "";
  const separator = existing === "" || existing.endsWith("\n") ? "" : "\n";
  writeFileSync(
    gitignore,
    `${existing}${separator}\n# Kukuroo: holds a VAPID private key that can never be rotated.\n${name}\n`,
  );
  console.log(`  added ${name} to .gitignore`);
}

function writeCredentials(credentials) {
  writeFileSync(credentialsPath(), JSON.stringify(credentials, null, 2) + "\n", { mode: 0o600 });
  console.log(`  wrote ${credentialsPath()} (0600)`);
  ensureGitignored();
}

function refuseVapidRotation() {
  die(
    "There is no rotate for the VAPID keypair, on purpose.\n\n" +
      "Every stored subscription is bound to the public key it was created with. A new\n" +
      "keypair does not invalidate them visibly; it just stops matching, and every send\n" +
      "afterwards is accepted by the push service and delivered to nobody.\n\n" +
      "If you have genuinely lost the private key, the only honest path is to generate a\n" +
      "new one and re-enrol every device by hand. Delete kukuroo.credentials.json and the\n" +
      "KUKUROO_VAPID_PRIVATE secret first, so this script knows you meant it.",
  );
}

// ---------------------------------------------------------------------------

async function rotate(what) {
  if (what === "vapid" || what === "vapid-keypair") refuseVapidRotation();
  if (what !== "send-token" && what !== "invite-code") {
    die(`rotate takes send-token or invite-code; got ${JSON.stringify(what)}`);
  }
  if (!existsSync(credentialsPath())) {
    die(`No ${credentialsPath()}. Run \`npx kukuroo init\` to do first-time setup.`);
  }

  const credentials = JSON.parse(readFileSync(credentialsPath(), "utf8"));
  const field = what === "send-token" ? "sendToken" : "inviteCode";
  const value = what === "send-token" ? randomToken() : randomInviteCode();

  credentials[field] = value;
  credentials.rotatedAt = { ...credentials.rotatedAt, [field]: new Date().toISOString() };

  putSecret(SECRET_NAMES[field], value);
  writeCredentials(credentials);

  console.log(`\nRotated ${what}. Safe: nothing is bound to it, and no device re-enrols.`);
  if (what === "send-token") {
    console.log("Update whatever sends notifications; it will get 401 until you do.");
  }
}

/**
 * Upload all three secrets, and say something useful if it goes wrong partway.
 *
 * The local file is already on disk before this runs, so a failure here is
 * recoverable: nothing has been lost, and `--resume` finishes the job.
 */
function uploadSecrets(credentials) {
  try {
    putSecret(SECRET_NAMES.vapidPrivateKey, credentials.vapidPrivateKey);
    putSecret(SECRET_NAMES.sendToken, credentials.sendToken);
    putSecret(SECRET_NAMES.inviteCode, credentials.inviteCode);
  } catch (error) {
    die(
      `Upload failed partway: ${error instanceof Error ? error.message : String(error)}\n\n` +
        `Your keys are safe. They were written to ${credentialsPath()} before any\n` +
        "upload started, which is the whole reason that ordering exists.\n\n" +
        "Fix whatever broke, then finish the job from that directory:\n" +
        `  cd ${workDir} && npx kukuroo init --resume`,
    );
  }
}

/**
 * Re-upload from the local file. Idempotent: putting the same VAPID key back is
 * not a rotation, so nothing re-enrols.
 */
function resumeSetup() {
  if (!existsSync(credentialsPath())) {
    die(`No ${credentialsPath()} to resume from. Run \`npx kukuroo init\`.`);
  }
  const credentials = JSON.parse(readFileSync(credentialsPath(), "utf8"));
  console.log(`\nResuming from ${credentialsPath()}.\n`);
  uploadSecrets(credentials);
  console.log(`\nDone. Your invite code is:\n\n     ${credentials.inviteCode}\n`);
}

// ---------------------------------------------------------------------------
// The two questions.
//
// Both are printed with what they set, because the answer is a line of
// TypeScript in a file the operator owns. A wizard that hides the option it
// wrote leaves them unable to change their mind without asking us.

async function confirm(rl, question, defaultYes) {
  const suffix = defaultYes ? "[Y/n]" : "[y/N]";
  for (;;) {
    let answer;
    try {
      answer = (await rl.question(`${question} ${suffix} `)).trim().toLowerCase();
    } catch {
      // Ctrl+D, or a pipe that ended. Nothing has been created at this point,
      // so leaving is free; a stack trace would only suggest otherwise.
      console.log("");
      die("Cancelled. Nothing was created and no key was generated.");
    }
    if (answer === "") return defaultYes;
    if (answer === "y" || answer === "yes") return true;
    if (answer === "n" || answer === "no") return false;
    console.log("  y or n.");
  }
}

/** The shape question. Two answers, so not a yes/no, so not `confirm`. */
async function chooseShape(rl) {
  for (;;) {
    let answer;
    try {
      answer = (await rl.question("Its own Worker, or mounted into yours? [1/2] "))
        .trim()
        .toLowerCase();
    } catch {
      console.log("");
      die("Cancelled. Nothing was created and no key was generated.");
    }
    if (answer === "1" || answer === "own" || answer === "standalone") return "standalone";
    if (answer === "2" || answer === "mounted" || answer === "mount") return "mounted";
    console.log("  1 or 2.");
  }
}

const FRONT_END = {
  prompt: "Use the bundled front end?",
  default: true,
  intro: `  Kukuroo ships one page: the thing a phone opens, adds to its Home Screen,
  and enrols from. It is a single file with no build step, and it is the whole
  front end most deployments ever need.

  Answer no if you are building your own enrolment UI, or already have a site
  that should host it. Kukuroo cannot be a pure API on iOS, so something has to
  serve a page either way; this asks whether that something is us.

  Sets \`standalone\` on mountKukuroo().`,
};

const SHAPE = {
  intro: `  Then where do the push routes live?

  1) Its own Worker, at its own address. This script writes the project; you
     deploy it and point your UI at it.
  2) Mounted into a Worker you already run, three lines inside your own fetch
     handler, so the routes sit on your site's origin and a tap lands back
     inside your site. Nothing is scaffolded.`,
  default: "standalone",
};

const INVITE = {
  prompt: "Require an invite code to enrol a device?",
  default: false,
  intro: `  A one-time code, typed once on the phone. Without it, anyone who reaches
  the enrolment page can add their own device and will receive everything you
  send afterwards. With it, they cannot.

  Answer yes if this deployment is for you and your own devices. The code is
  generated and installed either way, so the answer is not permanent: it is
  \`requireInvite\` on mountKukuroo(), one word in a file you own.`,
};

/**
 * Answers from flags, from the prompts, or from the defaults if nobody is
 * watching. Anything already given on the command line is never asked about,
 * which is what makes the flag form and the wizard the same flow rather than
 * two.
 */
async function askAnswers(flags) {
  const answers = {
    frontEnd: flags.frontEnd,
    shape: flags.shape,
    requireInvite: flags.requireInvite,
  };
  const interactive = process.stdin.isTTY && !flags.yes;
  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  const fallback = (label, value) => {
    console.log(`  ${label} ${value === true ? "yes" : value === false ? "no" : value} (default)`);
    return value;
  };

  try {
    if (interactive && Object.values(answers).some((v) => v === undefined)) {
      console.log("\nA few questions. Every answer is an option you can change later.\n");
    }

    if (answers.frontEnd === undefined) {
      if (!interactive) answers.frontEnd = fallback(FRONT_END.prompt, FRONT_END.default);
      else {
        console.log(FRONT_END.intro + "\n");
        answers.frontEnd = await confirm(rl, FRONT_END.prompt, FRONT_END.default);
        console.log("");
      }
    }

    // With our page, the shape is settled: it is served by a Worker of its own.
    // Someone who wants the bundled page inside a Worker they already run can
    // still say so with --mounted, which is why this only fills a blank.
    if (answers.shape === undefined && answers.frontEnd) answers.shape = "standalone";

    if (answers.shape === undefined) {
      if (!interactive) answers.shape = fallback("Its own Worker, or mounted?", SHAPE.default);
      else {
        console.log(SHAPE.intro + "\n");
        answers.shape = await chooseShape(rl);
        console.log("");
      }
    }

    if (answers.requireInvite === undefined) {
      if (!interactive) answers.requireInvite = fallback(INVITE.prompt, INVITE.default);
      else {
        console.log(INVITE.intro + "\n");
        answers.requireInvite = await confirm(rl, INVITE.prompt, INVITE.default);
        console.log("");
      }
    }
  } finally {
    rl?.close();
  }

  return answers;
}

// ---------------------------------------------------------------------------
// The scaffold.

/** Cloudflare Worker names are lowercase, dashes, digits. The origin depends on it. */
function workerName(from) {
  const cleaned = from.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned === "" ? "kukuroo" : cleaned;
}

/**
 * What the scaffolded package.json should depend on.
 *
 * A checkout carries a .git; an npm install does not. So when this script is
 * running from a clone or from `npx github:saiday/kukuroo`, the project it
 * writes points back at the same place rather than at a registry version that
 * may not be published yet, and the very first `npm install` succeeds.
 */
function dependencySpec() {
  if (existsSync(join(PACKAGE_ROOT, ".git"))) return "github:saiday/kukuroo";
  const { version } = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"));
  return `^${version}`;
}

/**
 * Checked before the questions when a directory was named, and again before the
 * first file is written. Asking two questions and only then refusing is a waste
 * of the operator's attention.
 */
function assertWritableTarget(dir) {
  const target = resolve(process.cwd(), dir);
  if (existsSync(target) && readdirSync(target).length > 0) {
    die(
      `${target} already exists and is not empty.\n\n` +
        "Refusing to write into it. Pick a name that does not exist yet:\n" +
        "  npx kukuroo init my-push",
    );
  }
  return target;
}

function scaffold(dir, answers) {
  const target = assertWritableTarget(dir);
  const name = workerName(basename(target));
  const spec = dependencySpec();

  mkdirSync(join(target, "src"), { recursive: true });
  copyFileSync(join(TEMPLATE_DIR, "tsconfig.json"), join(target, "tsconfig.json"));

  // The Worker's name is the workers.dev hostname, so it follows the directory
  // rather than staying "kukuroo" for everyone who ever runs this.
  const wranglerConfig = readFileSync(join(TEMPLATE_DIR, "wrangler.jsonc"), "utf8").replace(
    /^(\s*"name":\s*)"[^"]*"/m,
    `$1"${name}"`,
  );
  const pkg = readFileSync(join(TEMPLATE_DIR, "package.json"), "utf8")
    .replace(/^(\s*"name":\s*)"[^"]*"/m, `$1"${name}"`)
    .replace(/^(\s*"kukuroo":\s*)"[^"]*"/m, `$1"${spec}"`);

  writeFileSync(join(target, "wrangler.jsonc"), wranglerConfig);
  writeFileSync(join(target, "package.json"), pkg);
  writeFileSync(join(target, "src", "worker.ts"), workerSource(answers));
  writeFileSync(join(target, ".gitignore"), SCAFFOLD_GITIGNORE);

  console.log(`\n  wrote ${dir}/wrangler.jsonc        the Worker's name and origin`);
  console.log(`  wrote ${dir}/src/worker.ts         mountKukuroo({ prefix: "/push",`);
  console.log(`                                      standalone: ${answers.frontEnd},`);
  console.log(`                                      requireInvite: ${answers.requireInvite} })`);
  console.log(`  wrote ${dir}/package.json          kukuroo ${spec}`);
  console.log(`  wrote ${dir}/tsconfig.json`);
  console.log(`  wrote ${dir}/.gitignore`);

  return target;
}

function npmInstall(dir) {
  console.log("\nInstalling dependencies.\n");
  try {
    execFileSync("npm", ["install"], { cwd: workDir, stdio: "inherit" });
  } catch (error) {
    die(
      `npm install failed in ${workDir}.\n\n` +
        "Nothing else has happened yet: no keys exist and no Worker has been touched,\n" +
        "so this is safe to fix and repeat. If the failure is that `kukuroo` is not on\n" +
        "npm yet, change its version in package.json to \"github:saiday/kukuroo\".\n\n" +
        "Then, from inside the project:\n" +
        `  cd ${dir} && npm install && npx kukuroo init --secrets`,
    );
  }
}

// ---------------------------------------------------------------------------

/**
 * Generate every secret and install it, in the order that survives a failure.
 * Returns the credentials so the caller can print the summary its shape needs.
 */
async function provisionSecrets() {
  if (existsSync(credentialsPath())) {
    die(
      `${credentialsPath()} already exists.\n\n` +
        "Refusing to overwrite it: it holds a VAPID private key that cannot be\n" +
        "regenerated without re-enrolling every device.\n\n" +
        "  npx kukuroo init --resume        finish an interrupted setup\n" +
        "  npx kukuroo rotate send-token    replace the send token\n" +
        "  npx kukuroo rotate invite-code   replace the invite code",
    );
  }

  const deployed = existingSecretNames();
  if (deployed === null) {
    console.log("No Worker deployed yet. `wrangler secret put` will create a draft one.");
  }

  const present = (deployed ?? []).filter((n) => Object.values(SECRET_NAMES).includes(n));
  if (present.includes(SECRET_NAMES.vapidPrivateKey)) {
    die(
      `The Worker already holds ${SECRET_NAMES.vapidPrivateKey}, and no local\n` +
        "credentials file explains where it came from.\n\n" +
        "Refusing to continue. Overwriting it would silently kill every device already\n" +
        "enrolled against this origin, and nothing would report it.\n\n" +
        "If you have the key in a backup, put the file back as\n" +
        `${credentialsPath()} and run \`npx kukuroo init --resume\`.\n\n` +
        "If nothing is enrolled yet and you want a clean start, delete that secret first:\n" +
        `  npx wrangler secret delete ${SECRET_NAMES.vapidPrivateKey}`,
    );
  }
  if (present.length > 0) {
    console.log(`Note: overwriting existing rotatable secrets: ${present.join(", ")}`);
  }

  console.log("\nGenerating.\n");
  const credentials = {
    createdAt: new Date().toISOString(),
    ...(await generateVapidKeypair()),
    sendToken: randomToken(),
    inviteCode: randomInviteCode(),
  };

  // The local copy is written *before* anything is uploaded, and the ordering is
  // the point. A Worker Secret cannot be read back, so if the VAPID key reached
  // Cloudflare and the backup did not, the only copy of a key that can never be
  // regenerated lives somewhere nothing can retrieve it from. Worse, the guard
  // above would then refuse the retry: the safe would be locked with the only
  // key inside it.
  writeCredentials(credentials);
  uploadSecrets(credentials);
  return credentials;
}

/**
 * The backup instruction, first in every summary.
 *
 * It is first because it is the only step whose omission is unrecoverable, and
 * because the steps that follow it are the fun ones.
 */
function backupNote(where, indent = "   ") {
  return [
    `Back up ${where} somewhere you will still have in three years.`,
    "A password manager entry is enough. The VAPID private key in that file cannot",
    "be recovered from Cloudflare: secrets are write-only, so losing it means",
    "re-enrolling every device by hand. Nothing from it goes into wrangler.jsonc;",
    "the key is a JWK, so the public half is derived and served at /push/public-key.",
  ].join("\n" + indent);
}

/** The rest of the summary: the two values a sender and a phone need. */
function printCredentialsNote(credentials, { requireInvite }) {
  console.log(`
The send token is in the credentials file under "sendToken". Whatever sends
notifications reads it from there, or from a copy you place yourself:

     node -p 'require("./kukuroo.credentials.json").sendToken' > ~/.kukuroo-send-token
     chmod 600 ~/.kukuroo-send-token
`);

  if (requireInvite) {
    console.log(`Your invite code, for the enrolment page:

     ${credentials.inviteCode}
`);
  } else {
    console.log(`Enrolment is open: anyone who reaches the enrolment page can add their own
device, and will then receive everything you send. That was the answer to the
first question. To close it, set requireInvite: true and deploy; the code is
already generated and installed, so nothing re-enrols:

     ${credentials.inviteCode}
`);
  }

  console.log(`Of the four values, only the VAPID keypair is permanent. The send token and the
invite code can be rotated any time with \`npx kukuroo rotate\`, and nothing
re-enrols.`);
}

async function standaloneSetup(dir, answers) {
  const target = scaffold(dir, answers);
  workDir = target;
  npmInstall(dir);

  const credentials = await provisionSecrets();

  // Without our page, nothing can enrol until the origin serving the operator's
  // own UI is allowed to call subscribe from a browser. That is a step, not a
  // footnote: skip it and the first enrolment fails in the console with a CORS
  // error that names nothing.
  const ownUiStep = answers.frontEnd
    ? ""
    : `
4. Add the origin serving your enrolment UI to KUKUROO_ALLOWED_ORIGINS in
   ${dir}/wrangler.jsonc. There is no enrolment page on this Worker, so until
   that list has your site on it, no browser is allowed to call /push/subscribe.
   ${README_SECTIONS.ownUi}
`;

  console.log(`
Done. ${dir} is a deployable Worker, and every secret is installed.

${answers.frontEnd ? "Three" : "Four"} things left, in this order.

1. ${backupNote(`${dir}/kukuroo.credentials.json`)}

2. Open ${dir}/wrangler.jsonc and pick the origin. It offers your own hostname
   or workers.dev, and it is the one decision here that cannot be taken back: a
   push subscription is bound to the origin it was created on, so changing it
   later stops every enrolled device, silently.

3. Deploy, and probe it.

     cd ${dir}
     npx wrangler deploy
     curl -s https://<your origin>/push/public-key

   That probe proves the deploy landed, the secrets are installed, and the VAPID
   key imports.${
     answers.frontEnd
       ? ` Only then, on the phone: open the origin in Safari, Add to Home
   Screen, open it from the icon${answers.requireInvite ? ", and enter the invite code" : ""}.
   Enrolling from a Safari tab does not work; that is Apple's rule, not ours.`
       : ""
   }
${ownUiStep}
The standalone shape, written out: ${README_SECTIONS.standalone}`);

  printCredentialsNote(credentials, answers);
}

async function mountedSetup(answers, { dirGiven }) {
  if (dirGiven) {
    console.log(
      "\nIgnoring the directory argument: the mounted shape has no project to create.",
    );
  }
  console.log(`
Mounted, then. Your Worker already has an origin, so the routes belong on it and
there is nothing to scaffold. Paste this into the Worker you already run:

${mountedSnippet(answers)}

The mounted shape, written out: ${README_SECTIONS.mounted}

Setting up the secrets here, in ${workDir}. This has to be the directory holding
that Worker's wrangler config, since that is what says which Worker they go to.`);

  const credentials = await provisionSecrets();
  console.log(`
Done. The secrets are installed on the Worker this directory deploys.

1. ${backupNote("kukuroo.credentials.json")}`);
  printCredentialsNote(credentials, answers);
}

/** No questions, no scaffold: just the keys, here. The recovery path, and the mounted one. */
async function secretsOnly() {
  console.log(`\nSecrets only, in ${workDir}.`);
  const credentials = await provisionSecrets();
  console.log(`\nDone.\n\n${backupNote("kukuroo.credentials.json", "")}`);
  printCredentialsNote(credentials, { requireInvite: true });
}

const USAGE = `kukuroo <command>

Setup comes in two forms, and they are the same flow: whatever you pass is not
asked about, and whatever you leave out is.

  npx kukuroo init                         the wizard, asking what it needs
  npx kukuroo init my-push --front-end --invite
                                           direct, asking nothing

Commands:

  init [dir]              set up a deployment. Scaffolds into [dir] unless the
                          answers say mounted. Default dir: ./kukuroo
  init --secrets          no questions, no scaffold: generate and install the
                          secrets for the Worker in this directory
  init --resume           finish an interrupted setup from the local credentials
  rotate send-token       replace the send token
  rotate invite-code      replace the invite code

Answers:

  --front-end, --no-front-end   serve Kukuroo's bundled enrolment page
                                (default: yes)
  --standalone, --mounted       a Worker of its own, or three lines inside one
                                you already run (default: standalone; implied
                                by --front-end)
  --invite, --no-invite         require the invite code to enrol (default: no)
  --yes                         take every default, ask nothing

Only the VAPID keypair is permanent; there is no rotate for it.`;

/** Flags anywhere, one optional positional. Unknown flags stop rather than being ignored. */
function parseInitArgs(argv) {
  const flags = { frontEnd: undefined, shape: undefined, requireInvite: undefined, yes: false };
  let dir;
  const setShape = (value, arg) => {
    if (flags.shape !== undefined && flags.shape !== value) {
      die(`--standalone and --mounted contradict each other.\n\n${USAGE}`);
    }
    flags.shape = value;
    return arg;
  };

  for (const arg of argv) {
    switch (arg) {
      case "--invite": flags.requireInvite = true; break;
      case "--no-invite": flags.requireInvite = false; break;
      case "--front-end": flags.frontEnd = true; break;
      case "--no-front-end": flags.frontEnd = false; break;
      case "--standalone": setShape("standalone", arg); break;
      case "--mounted": setShape("mounted", arg); break;
      case "--yes": case "-y": flags.yes = true; break;
      default:
        if (arg.startsWith("-")) die(`Unknown option ${JSON.stringify(arg)}.\n\n${USAGE}`);
        if (dir !== undefined) die(`Two directories given: ${dir} and ${arg}.\n\n${USAGE}`);
        dir = arg;
    }
  }
  return { dir, flags };
}

const argv = process.argv.slice(2);
const command = argv[0] === undefined || argv[0].startsWith("-") ? "init" : argv[0];
const rest = command === argv[0] ? argv.slice(1) : argv;

if (argv.includes("--help") || argv.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}

switch (command) {
  case "init": {
    if (rest.includes("--resume")) { resumeSetup(); break; }
    if (rest.includes("--secrets")) { await secretsOnly(); break; }

    const { dir, flags } = parseInitArgs(rest);
    if (dir !== undefined) assertWritableTarget(dir);
    const answers = await askAnswers(flags);
    if (answers.shape === "standalone") await standaloneSetup(dir ?? "kukuroo", answers);
    else await mountedSetup(answers, { dirGiven: dir !== undefined });
    break;
  }
  case "rotate":
    await rotate(rest[0]);
    break;
  default:
    die(`Unknown command ${JSON.stringify(command)}.\n\n${USAGE}`);
}
