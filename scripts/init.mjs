#!/usr/bin/env node
//
// One-time setup. Asks up to four questions, writes a deployable Worker,
// generates every secret Kukuroo needs, writes them to a local 0600 file,
// installs them into the Worker, and deploys it.
//
// The questions between them decide whether this deployment is a personal one.
// They are asked here, once, rather than left as options nobody discovers: an
// invite gate added after a stranger has enrolled is not the same thing as one
// that was there first, and an enrollment page is either the reason the Worker
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
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  README_SECTIONS,
  SCAFFOLD_GITIGNORE,
  mountedSnippet,
  originUrl,
  workerSource,
  wranglerSource,
} from "./template.mjs";
import { BACK, Cancelled, ask, columns, supported, withScreen, wrap } from "./tui.mjs";

// Where the credentials file goes and where wrangler runs. It is the current
// directory for every command except a scaffolded init, which moves both into
// the project it just created, so that the `wrangler secret` commands read that
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
 * which is far more than enough for a code that gates one manual enrollment.
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
 *
 * Returns which account it found, for the screens to name, or null if wrangler's
 * answer did not contain one. See whoAmI.
 */
function assertAuthenticated() {
  let output;
  try {
    output = wrangler(["whoami"], { captureStderr: true });
  } catch (error) {
    output = String(error.stdout ?? "") + String(error.stderr ?? "");
  }

  // Negative signals first. wrangler's own failures quote the same words the
  // positive check looks for ("Failed to automatically retrieve account IDs for
  // the logged in user"), so a substring match alone passes on exactly the
  // output that should stop the run. Failing here costs one `wrangler login`;
  // passing here costs an unrecoverable key, so the order is not arbitrary.
  const authenticated =
    !/failed to|\berror\b|not authenticated|non-interactive environment/i.test(output) &&
    /logged in|account id|api token/i.test(output);
  if (authenticated) return whoAmI(output);

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
 * Which Cloudflare account this is about to use, as a phrase to print.
 *
 * Best effort by design: this decorates the screens and gates nothing, so
 * anything unrecognised becomes null and the line is simply left out. wrangler's
 * wording and the shape of its table are not a contract, and a wrong guess here
 * would be worse than no line at all, because the whole point of printing it is
 * that somebody is checking it.
 *
 * More than one account on the login is the case worth being careful about.
 * wrangler does not pick one -- it stops and asks for CLOUDFLARE_ACCOUNT_ID -- so
 * naming the first row would name the wrong account as confidently as the right
 * one. It says how many there are instead.
 */
function whoAmI(output) {
  // One row per account the login can reach: | Some Account | 0123..cdef |, in
  // box-drawing pipes. The header row carries no 32-hex id and so cannot match.
  const names = [...output.matchAll(/│\s*(\S[^│]*?)\s*│\s*[0-9a-f]{32}\s*│/gi)].map((m) => m[1]);
  const found = output.match(/associated with the email\s+([^\s,]+@[^\s,]+)/i);
  const email = found === null ? null : found[1].replace(/\.+$/, "");

  if (names.length > 1) return `${names.length} accounts on this login, so wrangler will ask which`;
  if (names.length === 0) return email;
  // The account name is very often the email with "'s Account" on the end, and
  // printing both then says the same thing twice.
  const name = names[0];
  if (email === null || name.toLowerCase().includes(email.toLowerCase())) return name;
  return `${name} (${email})`;
}

/** The one standing fact every screen carries: whose Cloudflare account this is. */
const accountLine = (account) => (account === null ? "" : `Cloudflare account: ${account}`);

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
 * secret bulk` overwrites without asking, and overwriting KUKUROO_VAPID_PRIVATE
 * destroys every enrolled device with no error anywhere.
 *
 * `wrangler secret list` does *not* return an empty array for a Worker that has
 * never been deployed. It exits non-zero with "Worker ... not found" on stderr
 * and writes nothing at all to stdout, so treating any failure as fatal would
 * reject every genuine first-time user, which is the only case this script
 * really exists for. A Worker that does not exist holds no secrets; that is not
 * an error, it is the answer.
 *
 * `secret bulk` creates a draft Worker on demand, so setup legitimately runs
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
    // Specifically "this Worker does not exist", not any failure that happens
    // to contain the words. An account "not found", a KV namespace "not
    // found", or an npm "404 Not Found" while resolving wrangler all used to
    // match, and each one returned null, skipped the overwrite guard below,
    // and let uploadSecrets replace a live KUKUROO_VAPID_PRIVATE. That kills
    // every enrolled device permanently, with a 201 on every send afterwards.
    if (/(worker|script)[^\n]*not found|not found[^\n]*(worker|script)|10007/i.test(stderr)) {
      return null;
    }
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
      "new one and re-enroll every device by hand. Delete kukuroo.credentials.json and the\n" +
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

  // Local file first, then the upload, for the reason provisionSecrets spells
  // out: Worker Secrets are write-only, so a value that reaches Cloudflare but
  // not the disk cannot be read back from anywhere. Uploading first meant a
  // failed write left the Worker rejecting every sender with 401 and no copy of
  // the token that would fix it. This way round, a failed upload leaves the
  // file ahead of the Worker and `npx kukuroo init --resume` finishes the job.
  writeCredentials(credentials);
  putSecret(SECRET_NAMES[field], value);

  console.log(`\nRotated ${what}. Safe: nothing is bound to it, and no device re-enrolls.`);
  if (what === "send-token") {
    console.log("Update whatever sends notifications; it will get 401 until you do.");
  }
}

/**
 * Upload all three secrets, and say something useful if it goes wrong.
 *
 * One `secret bulk` rather than three `secret put`s, because every secret write
 * is a new version of the Worker and three of them make a fresh deployment look
 * like something went wrong five times. Bulk is a single merge-patch: the three
 * named here are written, anything else the Worker holds is left alone, and it
 * creates the draft Worker on demand exactly as `secret put` does, so this is
 * still the first thing a first-time setup can run.
 *
 * The local file is already on disk before this runs, so a failure here is
 * recoverable: nothing has been lost, and `--resume` finishes the job.
 */
function uploadSecrets(credentials) {
  const bundle = {
    [SECRET_NAMES.vapidPrivateKey]: credentials.vapidPrivateKey,
    [SECRET_NAMES.sendToken]: credentials.sendToken,
    [SECRET_NAMES.inviteCode]: credentials.inviteCode,
  };
  try {
    // On stdin, never as a file: writing three secrets to a temp path to hand
    // them to a subprocess is a copy nobody asked for and nothing deletes on a
    // crash.
    wrangler(["secret", "bulk"], { stdin: JSON.stringify(bundle) });
    for (const name of Object.keys(bundle)) console.log(`  set ${name}`);
  } catch (error) {
    die(
      `Upload failed: ${error instanceof Error ? error.message : String(error)}\n\n` +
        `Your keys are safe. They were written to ${credentialsPath()} before any\n` +
        "upload started, which is the whole reason that ordering exists.\n\n" +
        "Fix whatever broke, then finish the job from that directory:\n" +
        `  cd ${workDir} && npx kukuroo init --resume`,
    );
  }
}

/**
 * Re-upload from the local file. Idempotent: putting the same VAPID key back is
 * not a rotation, so nothing re-enrolls.
 */
function resumeSetup(account) {
  if (!existsSync(credentialsPath())) {
    die(`No ${credentialsPath()} to resume from. Run \`npx kukuroo init\`.`);
  }
  const credentials = JSON.parse(readFileSync(credentialsPath(), "utf8"));
  console.log(`\nResuming from ${credentialsPath()}.`);
  if (account !== null) console.log(`\n  ${accountLine(account)}`);
  console.log("");
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

// `label` is what the answer is called on the review screen, where four of them
// are read side by side and the question they came from is no longer on screen.
const QUESTIONS = {
  frontEnd: {
    label: "Front end",
    question: "Use the bundled front end?",
    body:
      "Something has to serve the page a phone opens in Safari, adds to the Home Screen, " +
      "and enrolls from. Kukuroo can be that page, or it can stay an API and let a page of " +
      "yours do it. Sets `standalone` on mountKukuroo().",
    choices: [
      {
        label: "Yes, serve the bundled page",
        hint:
          "You write no HTML and run no bundler. The Worker returns the page itself, so " +
          "deploying it is the whole front end.",
        value: true,
      },
      {
        label: "No, I will build my own UI",
        hint:
          "Your page does two calls: read the VAPID key, post the subscription. " +
          README_SECTIONS.api,
        value: false,
      },
    ],
    default: 0,
    summary: (v) => (v ? "the bundled enrollment page" : "your own UI, elsewhere"),
  },

  shape: {
    label: "Routes",
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
    summary: (v) => (v === "standalone" ? "a Worker of its own" : "mounted into a Worker you run"),
  },

  origin: {
    label: "Enroll on",
    question: "Where will devices enroll?",
    body:
      "This is the one answer worth getting right first. Moving it later does not stop " +
      "delivery to devices already enrolled, but it does mean you can no longer read or " +
      "repair their subscriptions, so every device enrolls again by hand.",
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
    summary: (v) =>
      v.kind === "domain" ? v.hostname : "a workers.dev address, named by the first deploy",
  },

  requireInvite: {
    label: "Enrollment",
    question: "Require an invite code to enroll a device?",
    body:
      "The code is generated either way, so changing your mind later is one word and a " +
      "deploy, and nothing re-enrolls. Sets `requireInvite` on mountKukuroo().",
    choices: [
      {
        label: "Yes, this is for my own devices",
        hint: "Stops a stranger who finds your URL from receiving everything you send.",
        value: true,
      },
      {
        label: "No, notifications are for whoever turns up",
        hint: "Anyone who reaches the URL can enroll a device.",
        value: false,
      },
    ],
    // The gate stands unless someone says otherwise, matching mountKukuroo's
    // own default. Every unattended path lands here: `--yes`, CI, a piped
    // stdin, an editor shell. Defaulting the other way scaffolded and deployed
    // an open /subscribe on all of them, and an open endpoint reports nothing,
    // so nobody finds out until a stranger is reading their notifications.
    default: 0,
    summary: (v) => (v ? "an invite code is required" : "open to anyone with the URL"),
  },
};

/** The follow-up when the origin answer is a domain. */
const HOSTNAME = {
  question: "Which hostname?",
  body:
    "Something like push.example.com, or notify.yourdomain.com. It has to be a zone " +
    "already on Cloudflare in this account, with no existing CNAME record on that name. " +
    "Just the hostname: no scheme, no path, no port.",
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
  // Standalone only. A mounted deployment enrolls on its host Worker's origin,
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
  const settled = { frontEnd: true, shape: "standalone", origin: WORKERS_DEV, requireInvite: true };
  let total = answered;
  for (let key = nextQuestion(probe); key !== null; key = nextQuestion(probe)) {
    probe[key] = settled[key];
    total++;
  }
  return total;
}

/** The answered questions, in asking order, as the review screen lists them. */
function answerRows(answers) {
  return ["frontEnd", "shape", "origin", "requireInvite"]
    .filter((key) => answers[key] !== undefined)
    .map((key) => [QUESTIONS[key].label, QUESTIONS[key].summary(answers[key])]);
}

/**
 * The same table for the scrollback, with the account at the top of it.
 *
 * The full-screen review keeps the account on its standing line instead, where it
 * has been since the first question. Printed output has no standing line, so the
 * account has to be a row or it is nowhere.
 */
function reviewRows(answers, account) {
  const rows = answerRows(answers);
  return account === null || account === undefined ? rows : [["Cloudflare", account], ...rows];
}

/**
 * Every answer on one page, and a last chance to disagree with it.
 *
 * It is here because each question before it is quick to answer and slow to
 * undo, and because the operator has been shown them one at a time and has never
 * seen them together. Confirming a deployment nobody has read is not
 * confirmation. It is also the only screen that says out loud what is about to
 * happen to a live Cloudflare account.
 */
function confirmScreen(answers, { dir, shouldDeploy, canGoBack, account }) {
  const choices = [
    {
      label: "Yes, set it up",
      hint: shouldDeploy
        ? `Writes ./${dir}, installs the secrets, and deploys.`
        : `Writes ./${dir} and installs the secrets. You deploy when you are ready.`,
      value: true,
    },
  ];
  if (canGoBack) {
    choices.push({
      label: "No, change an answer",
      hint: "Steps back through the questions, one at a time.",
      value: BACK,
    });
  }

  return ask({
    question: "Ready?",
    body:
      "This generates a VAPID keypair that can never be rotated, writes it to a file " +
      `only you can read, and installs it on ${
        // Only "named above" if there is in fact a name above: the account line
        // is left out when wrangler's answer did not contain one to read.
        account === null ? "Cloudflare" : "the Cloudflare account named above"
      } along with a send token and an invite code${
        shouldDeploy ? ", then deploys the Worker" : ""
      }. Everything above can be changed afterwards except where devices enroll.`,
    status: accountLine(account),
    facts: answerRows(answers),
    choices,
    default: 0,
    step: null,
    total: null,
    // The same key that steps back from a question steps back from the review.
    // The choice above says so in words for anyone who did not think to try it.
    canGoBack,
  });
}

/**
 * The questions, full-screen, one at a time, and then all of them at once.
 *
 * The loop walks a history of whole snapshots rather than a list of answered
 * keys, because going back has to undo more than the last answer: `nextQuestion`
 * settles the shape the moment the front end is answered yes, so stepping back
 * past that question has to unsettle it too. Restoring the object entire is the
 * only version of that with no second list of consequences to keep in step.
 */
async function askOnScreen(initial, plan) {
  return withScreen(async () => {
    let answers = { ...initial };
    // One entry per answered question: what `answers` looked like before it.
    const history = [];
    // The same on every screen, first to last, because the account is the one
    // thing here nobody chose and everybody assumes. It is worth seeing before
    // the first answer, since it is what the whole run is about to write to.
    const status = accountLine(plan.account);

    for (;;) {
      const key = nextQuestion(answers);

      if (key === null) {
        const go = await confirmScreen(answers, {
          ...plan,
          canGoBack: history.length > 0,
        });
        if (go !== BACK) return answers;
        answers = history.pop();
        continue;
      }

      // `history.length` counts the questions already answered, so the one on
      // screen is the next and the total is what remains on top of it. Counting
      // the current question as answered would count it twice, once in each term.
      const position = {
        step: history.length + 1,
        total: totalQuestions(answers, history.length),
      };
      const before = { ...answers };

      let value = await ask({
        ...QUESTIONS[key],
        ...position,
        status,
        canGoBack: history.length > 0,
      });
      if (value === BACK) {
        answers = history.pop();
        continue;
      }

      if (value === "ask-hostname") {
        // Always back-able, whatever the history holds: the question behind this
        // one is the origin question that just branched to it, and that one is
        // on screen again the moment this loop turns over.
        const hostname = await ask({
          ...HOSTNAME, ...position, status, value: "", canGoBack: true,
        });
        if (hostname === BACK) continue;
        value = { kind: "domain", hostname: hostname.toLowerCase() };
      }

      history.push(before);
      answers[key] = value;
    }
  });
}

/**
 * The same questions down a terminal that cannot be taken over: stdout redirected
 * to a file, an editor's dumb shell, a CI job with a TTY on stdin only.
 */
async function askOnLines(answers, plan) {
  const measure = columns();
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
    // Said once here and again at the confirm, which is where the full-screen
    // asker's standing account line has to land in a terminal that only scrolls.
    if (plan.account !== null) console.log(`\n  ${accountLine(plan.account)}`);

    for (let key = nextQuestion(answers); key !== null; key = nextQuestion(answers)) {
      const spec = QUESTIONS[key];
      console.log("");
      for (const line of wrap(spec.body, measure - 4)) console.log(`  ${line}`);
      console.log("");
      spec.choices.forEach((choice, i) => {
        console.log(`  ${i + 1}) ${choice.label}`);
        for (const line of wrap(choice.hint, measure - 8)) console.log(`     ${line}`);
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

    // The same last look the full-screen asker gives, minus the stepping back:
    // a terminal that cannot be redrawn cannot take a screen away again, and
    // scrolling up to the question you want is what the scrollback is for.
    console.log("\nReady?\n");
    console.log(facts(reviewRows(answers, plan.account)));
    console.log(
      `\nThis generates a VAPID keypair that can never be rotated, writes it to a file\n` +
        `only you can read, and installs it on Cloudflare${
          plan.shouldDeploy ? `, then deploys ./${plan.dir}` : ""
        }.`,
    );
    for (;;) {
      const answer = (await read("\nGo ahead? [Y/n] ")).toLowerCase();
      if (answer === "" || answer === "y" || answer === "yes") break;
      if (answer === "n" || answer === "no") {
        die("Stopped. Nothing was created and no key was generated.");
      }
      console.log("  y or n.");
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
async function askAnswers(flags, plan) {
  const answers = {
    frontEnd: flags.frontEnd,
    shape: flags.shape,
    requireInvite: flags.requireInvite,
    origin: flags.origin,
  };

  if (!process.stdin.isTTY || flags.yes) {
    // Nobody is going to be asked anything, so this is the only chance to say
    // which account the run is about to write to.
    if (plan.account !== null) console.log(`\n  ${accountLine(plan.account)}\n`);
    for (let key = nextQuestion(answers); key !== null; key = nextQuestion(answers)) {
      answers[key] = QUESTIONS[key].choices[QUESTIONS[key].default].value;
      console.log(`  ${QUESTIONS[key].summary(answers[key])} (default)`);
    }
    return answers;
  }

  let asked;
  try {
    asked = supported() ? await askOnScreen(answers, plan) : await askOnLines(answers, plan);
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
  console.log(facts(reviewRows(asked, plan.account)));

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
 *
 * `--link` is the third answer, and it exists because of a trap. Running this
 * script out of a checkout makes the *wizard* local, but the Worker it writes
 * still fetches the *library* from GitHub, so a change to src/ can be edited,
 * scaffolded, deployed, and opened on a phone without ever being the code that
 * ran. Linking points the project at the checkout that wrote it, and from then
 * on every deploy carries the working tree.
 */
function dependencySpec(link) {
  if (link) return `file:${PACKAGE_ROOT}`;
  if (existsSync(join(PACKAGE_ROOT, ".git"))) return "github:saiday/kukuroo";
  const { version } = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"));
  return `^${version}`;
}

/**
 * Refuse to link something that is not a checkout.
 *
 * `npx kukuroo init --link` would otherwise point the project at an npm cache
 * directory: a path that resolves today, is not under anybody's editor, and
 * disappears when the cache is cleaned. Failing here costs one flag; not failing
 * costs somebody an afternoon wondering why their edits do nothing.
 */
function assertLinkable() {
  if (PACKAGE_ROOT.split(sep).includes("node_modules") || !existsSync(join(PACKAGE_ROOT, ".git"))) {
    die(
      "--link needs a checkout to link to, and this is running from an installed copy:\n\n" +
        `  ${PACKAGE_ROOT}\n\n` +
        "Clone the repository and run its scripts/init.mjs directly:\n\n" +
        "  git clone https://github.com/saiday/kukuroo\n" +
        "  node kukuroo/scripts/init.mjs init my-push --link",
    );
  }
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

function scaffold(dir, answers, { link = false } = {}) {
  const target = assertWritableTarget(dir);
  const name = workerName(basename(target));
  const spec = dependencySpec(link);

  mkdirSync(join(target, "src"), { recursive: true });
  copyFileSync(join(TEMPLATE_DIR, "tsconfig.json"), join(target, "tsconfig.json"));

  // The Worker's name is the leftmost label of a workers.dev hostname, so it
  // follows the directory rather than staying "kukuroo" for everyone who ever runs
  // this. It is also why the wizard does not ask for a name: `init my-push` has
  // already answered that.
  const wranglerConfig = wranglerSource({ name, origin: answers.origin, frontEnd: answers.frontEnd });
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
    console.log("No Worker deployed yet. `wrangler secret bulk` will create a draft one.");
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

/**
 * An aligned block of values somebody is about to read off the screen and use.
 *
 * Aligned because they are read one at a time, by eye, while looking at a phone
 * in the other hand, and a ragged left edge on the values is one more thing to
 * track across a line.
 */
function facts(rows) {
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, value]) => `     ${label.padEnd(width)}   ${value}`).join("\n");
}

/** The rest of the summary: the two values a sender and a phone need. */
function printCredentialsNote({ requireInvite }) {
  console.log(`
The send token is in the credentials file under "sendToken". Whatever sends
notifications reads it from there, or from a copy you place yourself:

     node -p 'require("./kukuroo.credentials.json").sendToken' > ~/.kukuroo-send-token
     chmod 600 ~/.kukuroo-send-token
`);

  // Nothing here for an open deployment. The code is still generated and
  // installed, so closing the gate later stays one word and a deploy, but
  // somebody who has just chosen not to have an invite code does not need a
  // paragraph about the invite code they do not have. It is in the credentials
  // file, and the README covers turning it on.
  if (requireInvite) {
    console.log(`The invite code is in the same file under "inviteCode", and is printed above.
`);
  }

  console.log(`Of the four values, only the VAPID keypair is permanent. The send token and the
invite code can be rotated any time with \`npx kukuroo rotate\`, and nothing
re-enrolls.`);
}

/**
 * Deploy, once, and say where it landed.
 *
 * A custom domain knows its origin before the deploy, so there is nothing to
 * read. A workers.dev address is <worker>.<account-subdomain>.workers.dev, and no
 * wrangler command reports the account subdomain, so the only way to learn it is
 * to deploy and read what wrangler printed.
 *
 * That address used to be written back into wrangler.jsonc as
 * KUKUROO_NAVIGATE_ORIGIN and deployed a second time, which is why one setup left
 * several versions behind. A standalone Worker now reads that origin off the
 * request when it serves the enrollment page itself, so the address is needed only
 * to print, and one deploy is the whole of it.
 *
 * Returns the origin that ended up live, or null if the output did not name one.
 */
function deployStandalone(answers) {
  console.log("\nDeploying.\n");
  const output = deploy();
  if (answers.origin.kind === "domain") return originUrl(answers.origin);
  return workersDevUrlFrom(output);
}

async function standaloneSetup(dir, answers, { shouldDeploy, link }) {
  const target = scaffold(dir, answers, { link });
  workDir = target;
  npmInstall(dir);

  const credentials = await provisionSecrets();

  const liveOrigin = shouldDeploy ? deployStandalone(answers) : null;

  const steps = [backupNote(`${dir}/kukuroo.credentials.json`)];

  // The deploy went through but wrangler's output did not name the address, so
  // the operator has a live Worker and no idea where. Nothing is broken -- the
  // Worker enforces its own origin off the request either way -- but a URL you
  // cannot type is not much of an enrollment page.
  if (shouldDeploy && liveOrigin === null) {
    steps.push(
      `Find your Worker's address.

   The deploy went through, but its output did not contain a workers.dev URL this
   script could read, so it did not guess one. It is in the Cloudflare dashboard
   under Workers, or in the output above.`,
    );
  }

  // Without our page, nothing can enroll until the origin serving the operator's
  // own UI is allowed to call subscribe from a browser. That is a step, not a
  // footnote: skip it and the first enrollment fails in the console with a CORS
  // error that names nothing. Nor can the Worker infer the navigate origin for
  // itself here, the way it can when the page is its own: the page is somebody
  // else's, and the origin it is served from is the answer.
  if (!answers.frontEnd) {
    steps.push(
      `Name the origin serving your enrollment UI, in ${dir}/wrangler.jsonc.

   It goes in KUKUROO_ALLOWED_ORIGINS, or no browser is allowed to call
   /push/subscribe, and in KUKUROO_NAVIGATE_ORIGIN, or a notification is free to
   navigate off it and eject the reader into a browser tab. Then deploy again.
   ${README_SECTIONS.ownUi}`,
    );
  }

  if (!shouldDeploy) {
    steps.push(`Deploy it.

     cd ${dir}
     npx wrangler deploy`);
  }

  steps.push(
    answers.frontEnd
      ? `Enroll your phone.

   Open the enrollment page in Safari, Add to Home Screen, open it from the icon,
   and allow notifications. Enrolling from a Safari tab does not work; that is
   Apple's rule, not ours.`
      : `Enroll a device from your own page.

   On iOS it has to be added to the Home Screen and opened from the icon first; a
   Safari tab cannot subscribe.`,
  );

  const origin = liveOrigin ?? "https://<your origin>";

  // The origin, and directly under it the code somebody types into the page that
  // origin serves. They are used together, within a minute of each other, on a
  // phone; separating them by a screenful of prose only means scrolling back.
  const headline = [["Origin", origin]];
  if (answers.frontEnd) headline.push(["Enroll at", `${origin}/push/enroll`]);
  if (answers.requireInvite) headline.push(["Invite code", credentials.inviteCode]);

  console.log(`
${
  shouldDeploy
    ? "Done, and deployed."
    : `Done. ${dir} is a deployable Worker, and every secret is installed.`
}

${facts(headline)}

${["One", "Two", "Three", "Four"][steps.length - 1]} things left, in this order.

${steps.map((step, i) => `${i + 1}. ${step}`).join("\n\n")}

That is setup. From then on, a notification is one request, and this one is
ready to run: the token in it is the send token this setup just generated.

     curl -X POST ${origin}/push/send \\
       -H "authorization: Bearer ${credentials.sendToken}" \\
       -H 'content-type: application/json' \\
       -d '{"notification":{"title":"hello","navigate":"${origin}/"}}'

It answers {"delivered":0,...} until a device has enrolled, which is the honest
answer and the reason the count is in the response at all.
Everything else, in more detail: ${README_SECTIONS.standalone}`);

  printCredentialsNote(answers);
}

async function mountedSetup(answers, { dirGiven }) {
  if (dirGiven) {
    console.log("\nIgnoring the directory argument: mounted has no project to create.");
  }
  // Both are standalone's business. The host Worker's origin already exists, and
  // its deploy pipeline is not ours to drive.
  if (answers.origin !== undefined) {
    console.log("Ignoring the origin: mounted enrolls on your Worker's own origin.");
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
${answers.requireInvite ? `\n${facts([["Invite code", credentials.inviteCode]])}\n` : ""}
${backupNote("kukuroo.credentials.json", "")}

Then deploy your Worker as you always do, and the push routes are live on the
origin you already own.`);
  printCredentialsNote(answers);
}

/** No questions, no scaffold: just the keys, here. The recovery path, and the mounted one. */
async function secretsOnly(account) {
  console.log(`\nSecrets only, in ${workDir}.`);
  if (account !== null) console.log(`\n  ${accountLine(account)}`);
  const credentials = await provisionSecrets();
  console.log(`\nDone.\n
${facts([["Invite code", credentials.inviteCode]])}\n
${backupNote("kukuroo.credentials.json", "")}`);
  printCredentialsNote({ requireInvite: true });
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

  --front-end, --no-front-end   serve Kukuroo's bundled enrollment page
                                (default: yes)
  --standalone, --mounted       a Worker of its own, or three lines inside one
                                you already run (default: standalone; implied
                                by --front-end)
  --origin <hostname>           enroll devices on a domain you have on Cloudflare
  --workers-dev                 enroll devices on a workers.dev address (default)
  --invite, --no-invite         require the invite code to enroll (default: yes)
  --yes                         take every default, ask nothing
  --deploy, --no-deploy         deploy a standalone Worker once it is set up
                                (default: yes with a terminal, no without)

Working on Kukuroo itself:

  --link                        depend on the checkout this script came from
                                instead of GitHub, so every deploy from the new
                                project carries your working tree. Needs a
                                checkout; see the error if it is not one.

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
    link: false,
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
      case "--link": flags.link = true; break;
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
    if (rest.includes("--resume")) { resumeSetup(assertAuthenticated()); break; }
    if (rest.includes("--secrets")) { await secretsOnly(assertAuthenticated()); break; }

    const { dir, flags } = parseInitArgs(rest);
    if (dir !== undefined) assertWritableTarget(dir);
    // Before anything else it could waste: a --link that cannot be honoured is a
    // typo in the command that was just typed, not a problem to discover after
    // four questions and a keypair.
    if (flags.link) assertLinkable();
    // Before the questions, so nobody answers three of them and is then told to
    // log in. It costs a second and it is the only check here that prevents an
    // unrecoverable half-finished setup. It also settles which account every
    // screen from here on names.
    const account = assertAuthenticated();

    // Deploying to a live Cloudflare account is fine when someone is watching and
    // chose it. Doing it from a script that could not ask is a surprise, and the
    // kind that claims a hostname or spends money is the wrong kind, so no
    // terminal means no deploy unless --deploy says otherwise.
    const shouldDeploy = flags.deploy ?? Boolean(process.stdin.isTTY);

    const answers = await askAnswers(flags, { dir: dir ?? "kukuroo", shouldDeploy, account });
    if (answers.shape === "standalone") {
      await standaloneSetup(dir ?? "kukuroo", answers, { shouldDeploy, link: flags.link });
    } else await mountedSetup(answers, { dirGiven: dir !== undefined });
    break;
  }
  case "rotate":
    assertAuthenticated();
    await rotate(rest[0]);
    break;
  default:
    die(`Unknown command ${JSON.stringify(command)}.\n\n${USAGE}`);
}
