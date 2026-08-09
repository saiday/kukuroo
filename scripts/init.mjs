#!/usr/bin/env node
//
// One-time setup. Asks up to four questions, writes a deployable Worker,
// generates every secret Kukuroo needs, writes them to a local 0600 file,
// installs them into the Worker, and deploys it.
//
// The questions between them decide whether this deployment is a personal one.
// They are asked here, once, rather than left as options nobody discovers: an
// invite gate added after a stranger has enrolled is not the same thing as one
// that was there first, and an enrolment page is either the reason the Worker
// exists or a route that should never have been mounted.
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
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  README_SECTIONS,
  SCAFFOLD_GITIGNORE,
  mountedSnippet,
  originUrl,
  workerSource,
  wranglerSource,
} from "./template.mjs";
import { Cancelled, ask, supported, withScreen, wrap } from "./tui.mjs";

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
 * Stop before anything exists if Cloudflare will not talk to us.
 *
 * The order everything else runs in is: generate the VAPID keypair, write it to
 * kukuroo.credentials.json, upload the secrets, deploy. An auth failure lands at
 * the upload, which is *after* a keypair that can never be rotated exists on
 * disk, and the overwrite guard in provisionSecrets then refuses the retry. That
 * is a bad enough trap when the operator is deploying by hand; adding a deploy of
 * our own to the end only widens the window.
 *
 * The exit code is no use here: `wrangler whoami` prints "You are not
 * authenticated" and still exits 0. So this looks for the positive signal and
 * stops when it is absent, which is the safe direction to fail in. A false stop
 * costs one `wrangler login` and prints what wrangler actually said; a false pass
 * costs an unrecoverable key.
 */
function assertAuthenticated() {
  let output;
  try {
    output = wrangler(["whoami"], { captureStderr: true });
  } catch (error) {
    output = String(error.stdout ?? "") + String(error.stderr ?? "");
  }

  if (/logged in|account id|api token/i.test(output)) return;

  die(
    "Not logged in to Cloudflare, so stopping before anything is generated.\n\n" +
      "  npx wrangler login\n\n" +
      "Nothing has happened yet: no keys exist, no files were written, and no Worker\n" +
      "has been touched. This check is here because the VAPID keypair cannot be\n" +
      "regenerated, so failing halfway is worse than not starting.\n\n" +
      "wrangler said:\n\n" +
      (output.trim() || "(nothing)"),
  );
}

/**
 * Deploy, and hand back what wrangler printed.
 *
 * stdout is captured rather than inherited because the workers.dev origin is only
 * discoverable by reading it, and then echoed in full so the operator still sees
 * everything wrangler had to say.
 */
function deploy() {
  let output;
  try {
    output = wrangler(["deploy"]);
  } catch (error) {
    output = String(error.stdout ?? "");
    console.log(output);
    die(
      "The deploy failed.\n\n" +
        "Your keys are safe: they are in kukuroo.credentials.json and installed on the\n" +
        "Worker already, so nothing needs regenerating. Fix whatever wrangler named\n" +
        `above, then deploy again from ${workDir}:\n\n` +
        "  npx wrangler deploy",
    );
  }
  console.log(output);
  return output;
}

/**
 * The workers.dev origin, read off the deploy wrangler just did.
 *
 * Returns null rather than guessing if the output does not contain one. wrangler's
 * phrasing around the URL is not a contract, and a wrong navigate origin is worse
 * than an absent one: absent means unenforced, wrong means every notification is
 * rejected before it is sent.
 */
function workersDevUrlFrom(output) {
  const match = output.match(/https:\/\/[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*\.workers\.dev/i);
  return match === null ? null : match[0].toLowerCase();
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

// ---------------------------------------------------------------------------
// The agent-facing copy of where to send.
//
// An agent told "ping me when this finishes" is almost never standing in the
// push project's directory, so neither the credentials file nor wrangler.jsonc is
// reachable from where it is. One file in the user's config directory is what
// makes the endpoint discoverable from every project on the machine, and it is
// shell-sourceable so the command that reads it never has to name the token:
//
//   set -a; . ~/.config/kukuroo/env; set +a
//
// It holds the origin and the send token, and deliberately not the VAPID key.
// Sending needs a bearer token; a second copy of a private key that can never be
// rotated is only a second thing to lose.

const agentEnvPath = () =>
  resolve(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "kukuroo", "env");

function writeAgentEnv({ origin, sendToken }) {
  const path = agentEnvPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `KUKUROO_ORIGIN=${origin}\nKUKUROO_SEND_TOKEN=${sendToken}\n`, {
    mode: 0o600,
  });
  // writeFileSync's mode applies to a file it creates and not to one it
  // overwrites, and this path is overwritten on every send-token rotation.
  chmodSync(path, 0o600);
  console.log(`  wrote ${path} (0600)`);
}

/** The file's contents as an object, or null if it is not there. */
function readAgentEnv() {
  const path = agentEnvPath();
  if (!existsSync(path)) return null;
  const values = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (match !== null) values[match[1]] = match[2];
  }
  return values;
}

/**
 * A hostname or a URL in, an origin out.
 *
 * Both spellings turn up: `wrangler.jsonc` route patterns are bare hostnames,
 * and the address printed after a deploy is a URL. A trailing slash is the third
 * spelling, and it matters, because this value gets concatenated with
 * `/push/send`.
 */
function normaliseOrigin(value) {
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    return new URL(withScheme).origin;
  } catch {
    die(`${JSON.stringify(value)} is not a hostname or a URL.\n\n  --origin push.example.com`);
  }
}

/**
 * The one paragraph about agents, printed where a summary is already being read.
 *
 * It is a paragraph rather than a section because it is optional: the deployment
 * works the same whether or not anything here is ever installed. The install is
 * two lines and the value is one sentence, so both fit.
 */
function agentNote(knownOrigin) {
  const wired =
    knownOrigin === null
      ? `Once you know the origin, point this machine's agents at it:

     npx kukuroo agent-env --origin <your origin>
`
      : `This machine's agents can already find it: the origin and send token are in
${agentEnvPath()}, which init just wrote.
`;

  return `
${wired}
Then teach them what to do with it, once:

     claude plugin marketplace add saiday/kukuroo
     claude plugin install kukuroo@kukuroo

After that, "ping me on my phone when the tests finish" works in any project, and
so does asking for a status update at a time you name. ${README_SECTIONS.agents}
`;
}

/**
 * Point the agents on this machine at a deployment that already exists.
 *
 * The token is read from the local credentials file or from stdin, and never from
 * argv: an argument is visible in `ps` for the life of the process and lands in
 * shell history afterwards. Keeping the credential out of places it gets copied to
 * is the entire reason this command exists instead of the instruction being "tell
 * your agent the send token".
 */
function agentEnvCommand(argv) {
  let origin;
  let fromStdin = false;

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--origin": {
        const value = argv[++i];
        if (value === undefined || value.startsWith("-")) {
          die(`--origin needs a hostname or URL, e.g. --origin push.example.com\n\n${USAGE}`);
        }
        origin = normaliseOrigin(value);
        break;
      }
      case "--token-stdin":
        fromStdin = true;
        break;
      default:
        die(`Unknown option ${JSON.stringify(argv[i])} for agent-env.\n\n${USAGE}`);
    }
  }

  const credentials = existsSync(credentialsPath())
    ? JSON.parse(readFileSync(credentialsPath(), "utf8"))
    : null;

  if (origin === undefined) {
    if (credentials?.origin !== undefined) origin = normaliseOrigin(credentials.origin);
    else {
      die(
        "I do not know which origin to point them at.\n\n" +
          "  npx kukuroo agent-env --origin push.example.com\n\n" +
          "It is the address your Worker answers on: the custom domain in\n" +
          "wrangler.jsonc, or the workers.dev URL printed when you deployed. A\n" +
          "deployment set up before this command existed does not record it, which is\n" +
          "why it has to be given here.",
      );
    }
  }

  let sendToken;
  if (fromStdin) {
    sendToken = readFileSync(0, "utf8").trim();
    if (sendToken === "") die("--token-stdin: nothing arrived on stdin.");
  } else if (credentials?.sendToken !== undefined) {
    sendToken = credentials.sendToken;
  } else {
    die(
      `No ${credentialsPath()} here, so there is no send token to read.\n\n` +
        "Run this from the directory holding it, or pipe the token in so it stays out\n" +
        "of your shell history:\n\n" +
        `  pbpaste | npx kukuroo agent-env --origin ${origin} --token-stdin`,
    );
  }

  console.log("");
  writeAgentEnv({ origin, sendToken });
  console.log(`
Agents on this machine can find your deployment now.

     Origin   ${origin}

The file is shell-sourceable, so a send never has to name the token:

     set -a; . ${agentEnvPath()}; set +a
     curl -fsS -X POST "$KUKUROO_ORIGIN/push/send" \\
       -H "authorization: Bearer $KUKUROO_SEND_TOKEN" \\
       -H 'content-type: application/json' \\
       -d '{"notification":{"title":"hello","navigate":"'"$KUKUROO_ORIGIN"'/"}}'

Teach them what to do with it, once:

     claude plugin marketplace add saiday/kukuroo
     claude plugin install kukuroo@kukuroo

\`rotate send-token\` updates this file too, so a rotation does not leave them
holding a token that 401s. ${README_SECTIONS.agents}`);
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

  // The agent env file holds a copy of the send token, so a rotation that did not
  // reach it leaves every agent on this machine holding a token that now 401s.
  // Only rewrite a file that already exists: creating one here would be this
  // command quietly taking on a second job.
  if (what === "send-token") {
    const existing = readAgentEnv();
    if (existing !== null && existing.KUKUROO_ORIGIN !== undefined) {
      writeAgentEnv({ origin: existing.KUKUROO_ORIGIN, sendToken: value });
    }
  }

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
// The questions.
//
// Every one of them is defined once, here, and both askers render from the same
// entry: the full-screen one and the line-by-line fallback for a terminal that
// cannot be taken over. Two copies of this prose would drift, and the copy is
// the part that matters, because each answer becomes a line of TypeScript in a
// file the operator owns and has to be able to change their mind about.

/** A hostname, not a URL: the answer goes into a wrangler route pattern, which
 * takes neither a scheme nor a path. Trimming "https://push.example.com/" down
 * quietly would be friendlier right up until the deploy failed with something
 * about an invalid route. */
function assertHostname(answer) {
  if (/^https?:\/\//i.test(answer)) return "just the hostname, with no https:// in front";
  if (answer.includes("/")) return "just the hostname, with no path";
  if (answer.includes(":")) return "just the hostname, with no port";
  if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(answer)) return "that does not look like a hostname";
  return null;
}

const WORKERS_DEV = { kind: "workers-dev", url: null };

const QUESTIONS = {
  frontEnd: {
    question: "Use the bundled front end?",
    body:
      "It generates the page a phone opens in Safari, adds to the Home Screen, and " +
      "enrols from. One file, no build step. Sets `standalone` on mountKukuroo().",
    choices: [
      {
        label: "Yes, serve the bundled page",
        hint: "The out-of-box setup. Nothing to build.",
        value: true,
      },
      {
        label: "No, I will build my own UI",
        hint: `Against the API: ${README_SECTIONS.api}`,
        value: false,
      },
    ],
    default: 0,
    summary: (v) => (v ? "bundled front end" : "no bundled front end"),
  },

  shape: {
    question: "Where do the push routes live?",
    body: "Nothing is scaffolded for a mounted deployment: it is three lines inside a fetch handler you already have.",
    choices: [
      {
        label: "Its own Worker, at its own address",
        hint: "This script writes the project and deploys it.",
        value: "standalone",
      },
      {
        label: "Mounted into a Worker I already run",
        hint:
          "The routes sit on your site's origin, so a notification click lands back inside your site.",
        value: "mounted",
      },
    ],
    default: 0,
    summary: (v) => v,
  },

  origin: {
    question: "Where will devices enrol?",
    body:
      "This is the one answer worth getting right first. Moving it later does not stop " +
      "delivery to devices already enrolled, but it does mean you can no longer read or " +
      "repair their subscriptions, so every device enrols again by hand.",
    choices: [
      {
        label: "A workers.dev address",
        hint:
          "Cloudflare provides it, free, and it is stable as long as this Worker keeps its name.",
        value: WORKERS_DEV,
      },
      {
        label: "A domain I already have on Cloudflare",
        hint: "The deploy provisions the DNS record and the certificate.",
        value: "ask-hostname",
      },
    ],
    default: 0,
    summary: (v) => (v.kind === "domain" ? v.hostname : "workers.dev"),
  },

  requireInvite: {
    question: "Require an invite code to enrol a device?",
    body:
      "The code is generated either way, so changing your mind later is one word and a " +
      "deploy, and nothing re-enrols. Sets `requireInvite` on mountKukuroo().",
    choices: [
      {
        label: "No, notifications are for whoever turns up",
        hint: "Anyone who reaches the URL can enrol a device.",
        value: false,
      },
      {
        label: "Yes, this is for my own devices",
        hint: "Stops a stranger who finds your URL from receiving everything you send.",
        value: true,
      },
    ],
    default: 0,
    summary: (v) => (v ? "invite required" : "open enrolment"),
  },
};

/** The follow-up when the origin answer is a domain. */
const HOSTNAME = {
  question: "Which hostname?",
  body:
    "It has to be a zone already on Cloudflare in this account, with no existing CNAME " +
    "record on that name. Just the hostname: no scheme, no path, no port.",
  placeholder: "push.example.com",
  validate: assertHostname,
};

/**
 * Fill in whatever the previous answers settle, then report what is still open.
 *
 * It does mutate: saying yes to the bundled page settles the shape, because that
 * page is served by a Worker of its own, and a question whose answer is already
 * determined is not a question. `--mounted` can still override it, which is why
 * this only ever fills a blank.
 */
function nextQuestion(answers) {
  if (answers.shape === undefined && answers.frontEnd === true) answers.shape = "standalone";

  if (answers.frontEnd === undefined) return "frontEnd";
  if (answers.shape === undefined) return "shape";
  // Standalone only. A mounted deployment enrols on its host Worker's origin,
  // which exists already and is not a question we get to ask.
  if (answers.shape === "standalone" && answers.origin === undefined) return "origin";
  if (answers.requireInvite === undefined) return "requireInvite";
  return null;
}

/**
 * How many questions this run will ask in total, counting the ones already done.
 *
 * Simulated forward with the defaults, because the plan genuinely is not fixed:
 * declining the bundled front end unlocks the shape question. So this can go from
 * three to four the moment that answer arrives, and showing four up front would be
 * wrong for almost everybody who takes the default.
 */
function totalQuestions(answers, answered) {
  const probe = { ...answers };
  const settled = { frontEnd: true, shape: "standalone", origin: WORKERS_DEV, requireInvite: false };
  let total = answered;
  for (let key = nextQuestion(probe); key !== null; key = nextQuestion(probe)) {
    probe[key] = settled[key];
    total++;
  }
  return total;
}

/** The questions, full-screen, one at a time. */
async function askOnScreen(answers) {
  let asked = 0;
  return withScreen(async () => {
    for (let key = nextQuestion(answers); key !== null; key = nextQuestion(answers)) {
      const spec = QUESTIONS[key];
      // `asked` counts the ones already answered, so the question on screen is the
      // next one and the total is what remains on top of it. Counting the current
      // question as answered would have it counted twice, once in each term.
      const position = { step: asked + 1, total: totalQuestions(answers, asked) };
      asked += 1;
      let value = await ask({ ...spec, ...position });

      if (value === "ask-hostname") {
        const hostname = await ask({
          ...HOSTNAME,
          ...position,
          value: "",
          validate: HOSTNAME.validate,
        });
        value = { kind: "domain", hostname: hostname.toLowerCase() };
      }

      answers[key] = value;
    }
    return answers;
  });
}

/**
 * The same questions down a terminal that cannot be taken over: stdout redirected
 * to a file, an editor's dumb shell, a CI job with a TTY on stdin only.
 */
async function askOnLines(answers) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const read = async (prompt) => {
    try {
      return (await rl.question(prompt)).trim();
    } catch {
      // Ctrl+D, or a pipe that ended. Nothing has been created at this point, so
      // leaving is free; a stack trace would only suggest otherwise.
      console.log("");
      die("Cancelled. Nothing was created and no key was generated.");
    }
  };

  try {
    for (let key = nextQuestion(answers); key !== null; key = nextQuestion(answers)) {
      const spec = QUESTIONS[key];
      console.log("");
      for (const line of wrap(spec.body, 76)) console.log(`  ${line}`);
      console.log("");
      spec.choices.forEach((choice, i) => {
        console.log(`  ${i + 1}) ${choice.label}`);
        for (const line of wrap(choice.hint, 72)) console.log(`     ${line}`);
      });
      console.log("");

      let value;
      for (;;) {
        const answer = await read(`${spec.question} [1-${spec.choices.length}] `);
        if (answer === "") {
          value = spec.choices[spec.default].value;
          break;
        }
        const picked = Number(answer);
        if (Number.isInteger(picked) && picked >= 1 && picked <= spec.choices.length) {
          value = spec.choices[picked - 1].value;
          break;
        }
        console.log(`  1 to ${spec.choices.length}.`);
      }

      if (value === "ask-hostname") {
        for (;;) {
          const hostname = (await read(`  Hostname, e.g. ${HOSTNAME.placeholder}: `)).toLowerCase();
          const complaint = assertHostname(hostname);
          if (complaint === null) {
            value = { kind: "domain", hostname };
            break;
          }
          console.log(`  ${complaint}.`);
        }
      }

      answers[key] = value;
    }
  } finally {
    rl.close();
  }
  return answers;
}

/**
 * Answers from flags, from the questions, or from the defaults if nobody is
 * watching. Anything already given on the command line is never asked about,
 * which is what makes the flag form and the wizard the same flow rather than two.
 */
async function askAnswers(flags) {
  const answers = {
    frontEnd: flags.frontEnd,
    shape: flags.shape,
    requireInvite: flags.requireInvite,
    origin: flags.origin,
  };

  if (!process.stdin.isTTY || flags.yes) {
    for (let key = nextQuestion(answers); key !== null; key = nextQuestion(answers)) {
      answers[key] = QUESTIONS[key].choices[QUESTIONS[key].default].value;
      console.log(`  ${QUESTIONS[key].summary(answers[key])} (default)`);
    }
    return answers;
  }

  let asked;
  try {
    asked = supported() ? await askOnScreen(answers) : await askOnLines(answers);
  } catch (error) {
    // Ctrl+C during the questions. The screen has already been given back by
    // withScreen's finally, so this only has to say why the run stopped.
    if (error instanceof Cancelled) {
      die("Cancelled. Nothing was created and no key was generated.");
    }
    throw error;
  }

  // The full-screen session takes its screen back on the way out, so the answers
  // are reprinted here, on the scrollback that survives. They are the shape of the
  // deployment, and the operator is about to read a summary that assumes them.
  console.log("\nAnswers:\n");
  for (const key of ["frontEnd", "shape", "origin", "requireInvite"]) {
    if (asked[key] === undefined) continue;
    console.log(`  ${QUESTIONS[key].summary(asked[key])}`);
  }

  return asked;
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

  // The Worker's name is the leftmost label of a workers.dev hostname, so it
  // follows the directory rather than staying "kukuroo" for everyone who ever runs
  // this. It is also why the wizard does not ask for a name: `init my-push` has
  // already answered that.
  const wranglerConfig = wranglerSource({ name, origin: answers.origin });
  const pkg = readFileSync(join(TEMPLATE_DIR, "package.json"), "utf8")
    .replace(/^(\s*"name":\s*)"[^"]*"/m, `$1"${name}"`)
    .replace(/^(\s*"kukuroo":\s*)"[^"]*"/m, `$1"${spec}"`);

  writeFileSync(join(target, "wrangler.jsonc"), wranglerConfig);
  writeFileSync(join(target, "package.json"), pkg);
  writeFileSync(join(target, "src", "worker.ts"), workerSource(answers));
  writeFileSync(join(target, ".gitignore"), SCAFFOLD_GITIGNORE);

  // The annotations line up against the longest path, so a long directory name
  // does not leave the second and third lines of the mount call hanging.
  const files = ["wrangler.jsonc", "src/worker.ts", "package.json", "tsconfig.json", ".gitignore"];
  const column = Math.max(...files.map((f) => `${dir}/${f}`.length)) + 4;
  const row = (file, note = "") => `  wrote ${`${dir}/${file}`.padEnd(column)}${note}`.trimEnd();
  const gutter = " ".repeat(column + 8);

  const originNote =
    answers.origin.kind === "domain"
      ? `origin ${answers.origin.hostname}`
      : `origin ${name}.<subdomain>.workers.dev`;

  console.log("");
  console.log(row("wrangler.jsonc", originNote));
  console.log(row("src/worker.ts", 'mountKukuroo({ prefix: "/push",'));
  console.log(`${gutter}standalone: ${answers.frontEnd},`);
  console.log(`${gutter}requireInvite: ${answers.requireInvite} })`);
  console.log(row("package.json", `kukuroo ${spec}`));
  console.log(row("tsconfig.json"));
  console.log(row(".gitignore"));

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
    `Back up ${where}. Cloudflare cannot give it back:`,
    "secrets are write-only, so losing this file means re-enrolling every device",
    "by hand. A password manager entry is enough.",
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
    console.log(`Enrolment is open: anyone who reaches your enrolment page can add their own
device, and will then receive everything you send. That is what you asked for.
To close it later, set requireInvite: true and deploy. The code below is already
generated and installed, so nothing re-enrols:

     ${credentials.inviteCode}
`);
  }

  console.log(`Of the four values, only the VAPID keypair is permanent. The send token and the
invite code can be rotated any time with \`npx kukuroo rotate\`, and nothing
re-enrols.`);
}

/**
 * Deploy, and settle the navigate origin for a workers.dev deployment.
 *
 * A custom domain knows its origin before the deploy, so it deploys once. A
 * workers.dev address is `<worker>.<account-subdomain>.workers.dev` and no
 * wrangler command reports the account subdomain, so the only way to learn it is
 * to deploy and read what wrangler printed. Hence two deploys: the first names the
 * origin, the second is the one that enforces it.
 *
 * Returns the origin that ended up live, or null if it could not be determined.
 */
function deployStandalone(name, answers) {
  console.log("\nDeploying.\n");
  const output = deploy();

  if (answers.origin.kind === "domain") return originUrl(answers.origin);

  const url = workersDevUrlFrom(output);
  if (url === null) return null;

  console.log(`\nThat origin is ${url}.`);
  console.log("Writing it into wrangler.jsonc as KUKUROO_NAVIGATE_ORIGIN, then deploying again");
  console.log("so notification clicks stay inside the installed web app.\n");

  const settled = { kind: "workers-dev", url };
  writeFileSync(resolve(workDir, "wrangler.jsonc"), wranglerSource({ name, origin: settled }));
  deploy();
  return url;
}

async function standaloneSetup(dir, answers, { shouldDeploy }) {
  const target = scaffold(dir, answers);
  workDir = target;
  npmInstall(dir);

  const credentials = await provisionSecrets();

  const name = workerName(basename(target));
  const liveOrigin = shouldDeploy ? deployStandalone(name, answers) : null;

  // Write the origin down next to the token. A custom domain knew it before the
  // deploy; a workers.dev address is only knowable after one, and until now it was
  // printed and nowhere else, so anything wanting to send later had to be told by
  // hand where to send. Absent stays absent when wrangler's output did not name
  // one -- a guessed origin is worse than a missing one.
  const knownOrigin =
    liveOrigin ?? (answers.origin?.kind === "domain" ? originUrl(answers.origin) : null);
  if (knownOrigin !== null) {
    credentials.origin = knownOrigin;
    writeCredentials(credentials);
    writeAgentEnv({ origin: knownOrigin, sendToken: credentials.sendToken });
  }

  const steps = [backupNote(`${dir}/kukuroo.credentials.json`)];

  // The deploy happened but wrangler's output did not name the origin, so the one
  // value that has to be exactly right is still missing. Say so, rather than
  // leaving an unenforced navigate origin to be discovered when a notification
  // click drops someone into a browser tab.
  if (shouldDeploy && liveOrigin === null) {
    steps.push(
      `Set KUKUROO_NAVIGATE_ORIGIN in ${dir}/wrangler.jsonc, and deploy again.

   The deploy went through, but its output did not contain a workers.dev URL this
   script could read, so it did not guess. Use the address wrangler printed above.
   Until then the navigate origin is not enforced, and a notification pointing off
   the origin ejects the reader into a browser tab.`,
    );
  }

  // Without our page, nothing can enrol until the origin serving the operator's
  // own UI is allowed to call subscribe from a browser. That is a step, not a
  // footnote: skip it and the first enrolment fails in the console with a CORS
  // error that names nothing. It goes before the deploy, because it is another
  // line in the same file the deploy publishes.
  if (!answers.frontEnd) {
    steps.push(
      `In the same file, add the origin serving your enrolment UI to
   KUKUROO_ALLOWED_ORIGINS. There is no enrolment page on this Worker, so until
   that list has your site on it, no browser is allowed to call /push/subscribe.
   ${README_SECTIONS.ownUi}`,
    );
  }

  if (!shouldDeploy) {
    steps.push(`Deploy it.

     cd ${dir}
     npx wrangler deploy${
       answers.origin.kind === "workers-dev"
         ? `

   Then set KUKUROO_NAVIGATE_ORIGIN in wrangler.jsonc to the workers.dev address
   the deploy prints, and deploy once more. Without it, a notification pointing off
   the origin ejects the reader into a browser tab.`
         : ""
     }`);
  }

  steps.push(
    answers.frontEnd
      ? `Enrol your phone.

   Open the origin in Safari, Add to Home Screen, open it from the icon, and allow
   notifications. Enrolling from a Safari tab does not work; that is Apple's rule,
   not ours.${
     answers.requireInvite ? "\n   The page asks for the invite code, which is at the end of this output." : ""
   }`
      : `Enrol a device from your own page.

   On iOS it has to be added to the Home Screen and opened from the icon first; a
   Safari tab cannot subscribe.`,
  );

  const origin = liveOrigin ?? "https://<your origin>";
  console.log(`
${
  shouldDeploy
    ? `Done, and deployed.${liveOrigin === null ? "" : ` Your origin is ${liveOrigin}.`}`
    : `Done. ${dir} is a deployable Worker, and every secret is installed.`
}

${["One", "Two", "Three", "Four"][steps.length - 1]} things left, in this order.

${steps.map((step, i) => `${i + 1}. ${step}`).join("\n\n")}

That is setup. From then on, a notification is one request:

     curl -X POST ${origin}/push/send \\
       -H "authorization: Bearer <the send token, below>" \\
       -H 'content-type: application/json' \\
       -d '{"notification":{"title":"hello","navigate":"${origin}/"}}'
${agentNote(knownOrigin)}
Everything else, in more detail: ${README_SECTIONS.standalone}`);

  printCredentialsNote(credentials, answers);
}

async function mountedSetup(answers, { dirGiven }) {
  if (dirGiven) {
    console.log("\nIgnoring the directory argument: mounted has no project to create.");
  }
  // Both are standalone's business. The host Worker's origin already exists, and
  // its deploy pipeline is not ours to drive.
  if (answers.origin !== undefined) {
    console.log("Ignoring the origin: mounted enrols on your Worker's own origin.");
  }
  console.log(`
Mounted, then. Your Worker already has an origin, so the routes belong on it and
there is nothing to scaffold. Paste this into the Worker you already run:

${mountedSnippet(answers)}

Everything else, in more detail: ${README_SECTIONS.mounted}

Setting up the secrets here, in ${workDir}. This has to be the directory holding
that Worker's wrangler config, since that is what says which Worker they go to.`);

  const credentials = await provisionSecrets();
  console.log(`
Done. The secrets are installed on the Worker this directory deploys.

${backupNote("kukuroo.credentials.json", "")}

Then deploy your Worker as you always do, and the push routes are live on the
origin you already own.
${agentNote(null)}`);
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
  agent-env               point this machine's coding agents at a deployment,
                          by writing the origin and send token to
                          ~/.config/kukuroo/env (0600). init does this for you;
                          this is for a deployment that predates it.

Answers:

  --front-end, --no-front-end   serve Kukuroo's bundled enrolment page
                                (default: yes)
  --standalone, --mounted       a Worker of its own, or three lines inside one
                                you already run (default: standalone; implied
                                by --front-end)
  --origin <hostname>           enrol devices on a domain you have on Cloudflare
  --workers-dev                 enrol devices on a workers.dev address (default)
  --invite, --no-invite         require the invite code to enrol (default: no)
  --yes                         take every default, ask nothing
  --deploy, --no-deploy         deploy a standalone Worker once it is set up
                                (default: yes with a terminal, no without)

agent-env takes:

  --origin <hostname>           the address the Worker answers on. Read from the
                                credentials file when it records one
  --token-stdin                 read the send token from stdin instead of the
                                credentials file, so it stays out of your history

Only the VAPID keypair is permanent; there is no rotate for it.`;

/** Flags anywhere, one optional positional. Unknown flags stop rather than being ignored. */
function parseInitArgs(argv) {
  const flags = {
    frontEnd: undefined,
    shape: undefined,
    requireInvite: undefined,
    origin: undefined,
    deploy: undefined,
    yes: false,
  };
  let dir;
  const setShape = (value, arg) => {
    if (flags.shape !== undefined && flags.shape !== value) {
      die(`--standalone and --mounted contradict each other.\n\n${USAGE}`);
    }
    flags.shape = value;
    return arg;
  };
  const setOrigin = (value) => {
    if (flags.origin !== undefined) {
      die(`--origin and --workers-dev contradict each other.\n\n${USAGE}`);
    }
    flags.origin = value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--invite": flags.requireInvite = true; break;
      case "--no-invite": flags.requireInvite = false; break;
      case "--front-end": flags.frontEnd = true; break;
      case "--no-front-end": flags.frontEnd = false; break;
      case "--standalone": setShape("standalone", arg); break;
      case "--mounted": setShape("mounted", arg); break;
      case "--workers-dev": setOrigin({ kind: "workers-dev", url: null }); break;
      case "--origin": {
        const hostname = (argv[i + 1] ?? "").trim().toLowerCase();
        if (hostname === "" || hostname.startsWith("-")) {
          die(`--origin needs a hostname, e.g. --origin push.example.com\n\n${USAGE}`);
        }
        const complaint = assertHostname(hostname);
        if (complaint !== null) die(`--origin ${hostname}: ${complaint}.\n\n${USAGE}`);
        setOrigin({ kind: "domain", hostname });
        i += 1;
        break;
      }
      case "--deploy": flags.deploy = true; break;
      case "--no-deploy": flags.deploy = false; break;
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
    if (rest.includes("--resume")) { assertAuthenticated(); resumeSetup(); break; }
    if (rest.includes("--secrets")) { assertAuthenticated(); await secretsOnly(); break; }

    const { dir, flags } = parseInitArgs(rest);
    if (dir !== undefined) assertWritableTarget(dir);
    // Before the questions, so nobody answers three of them and is then told to
    // log in. It costs a second and it is the only check here that prevents an
    // unrecoverable half-finished setup.
    assertAuthenticated();

    // Deploying to a live Cloudflare account is fine when someone is watching and
    // chose it. Doing it from a script that could not ask is a surprise, and the
    // kind that claims a hostname or spends money is the wrong kind, so no
    // terminal means no deploy unless --deploy says otherwise.
    const shouldDeploy = flags.deploy ?? Boolean(process.stdin.isTTY);

    const answers = await askAnswers(flags);
    if (answers.shape === "standalone") {
      await standaloneSetup(dir ?? "kukuroo", answers, { shouldDeploy });
    } else await mountedSetup(answers, { dirGiven: dir !== undefined });
    break;
  }
  case "rotate":
    assertAuthenticated();
    await rotate(rest[0]);
    break;
  // No `assertAuthenticated` here: this writes one local file from values that
  // already exist, and talks to Cloudflare not at all. Requiring a wrangler login
  // to record an origin would be a check that protects nothing.
  case "agent-env":
    agentEnvCommand(rest);
    break;
  default:
    die(`Unknown command ${JSON.stringify(command)}.\n\n${USAGE}`);
}
