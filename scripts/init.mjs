#!/usr/bin/env node
//
// One-time setup. Generates every secret Kukuroo needs, writes them to a local
// 0600 file, and installs them into the Worker.
//
// This exists because a Worker Secret is write-only. `wrangler secret list`
// returns names, never values, so a setup flow that says "generate a send token
// and store it as a secret" has quietly destroyed the token by the time anything
// needs to send. The operator then discovers this halfway through enrolling a
// phone, which is the worst possible moment.
//
// So: generate all of it here, at the start, and keep a copy the operator owns.
//
//   npx kukuroo init                  first-time setup
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
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const CREDENTIALS_PATH = resolve(process.cwd(), "kukuroo.credentials.json");

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
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { stdio: "ignore" });
  } catch {
    return; // Not a repository. Nothing to protect against.
  }

  try {
    execFileSync("git", ["check-ignore", "-q", name], { stdio: "ignore" });
    return; // Already ignored.
  } catch {
    // Not ignored; fall through and fix it.
  }

  const gitignore = resolve(process.cwd(), ".gitignore");
  const existing = existsSync(gitignore) ? readFileSync(gitignore, "utf8") : "";
  const separator = existing === "" || existing.endsWith("\n") ? "" : "\n";
  writeFileSync(
    gitignore,
    `${existing}${separator}\n# Kukuroo: holds a VAPID private key that can never be rotated.\n${name}\n`,
  );
  console.log(`  added ${name} to .gitignore`);
}

function writeCredentials(credentials) {
  writeFileSync(CREDENTIALS_PATH, JSON.stringify(credentials, null, 2) + "\n", { mode: 0o600 });
  console.log(`  wrote ${CREDENTIALS_PATH} (0600)`);
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
  if (!existsSync(CREDENTIALS_PATH)) {
    die(`No ${CREDENTIALS_PATH}. Run \`npx kukuroo init\` to do first-time setup.`);
  }

  const credentials = JSON.parse(readFileSync(CREDENTIALS_PATH, "utf8"));
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

async function firstTimeSetup() {
  if (existsSync(CREDENTIALS_PATH)) {
    die(
      `${CREDENTIALS_PATH} already exists.\n\n` +
        "Refusing to overwrite it. If you are trying to replace a rotatable secret, use\n" +
        "  npx kukuroo rotate send-token\n" +
        "  npx kukuroo rotate invite-code",
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

  putSecret(SECRET_NAMES.vapidPrivateKey, credentials.vapidPrivateKey);
  putSecret(SECRET_NAMES.sendToken, credentials.sendToken);
  putSecret(SECRET_NAMES.inviteCode, credentials.inviteCode);
  writeCredentials(credentials);

  console.log(`
Done. Two things left.

1. Back up kukuroo.credentials.json somewhere you will still have in three years.
   A password manager entry is enough. The VAPID private key in that file cannot
   be recovered from Cloudflare: secrets are write-only. Losing it means
   re-enrolling every device by hand.

   Nothing to paste into wrangler.jsonc. The key is stored as a JWK, so the
   public half is derived from it and served at <prefix>/public-key.

2. Your invite code, for the enrolment page:

     ${credentials.inviteCode}

The send token is in the credentials file under "sendToken". Whatever sends
notifications reads it from there, or from a copy you place yourself:

     node -p 'require("./kukuroo.credentials.json").sendToken' > ~/.kukuroo-send-token
     chmod 600 ~/.kukuroo-send-token

Of the four values, only the VAPID keypair is permanent. The send token and the
invite code can be rotated any time with --rotate, and nothing re-enrols.
`);
}

const USAGE = `kukuroo <command>

  init                    generate every secret and install it into the Worker
  rotate send-token       replace the send token
  rotate invite-code      replace the invite code

Only the VAPID keypair is permanent; there is no rotate for it.`;

const [command, argument] = process.argv.slice(2);

switch (command) {
  case undefined:
  case "init":
    await firstTimeSetup();
    break;
  case "rotate":
    await rotate(argument);
    break;
  default:
    die(`Unknown command ${JSON.stringify(command)}.\n\n${USAGE}`);
}
