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
//   node scripts/init.mjs                    first-time setup
//   node scripts/init.mjs --rotate send-token
//   node scripts/init.mjs --rotate invite-code
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
    vapidPublicKey: b64url(await crypto.subtle.exportKey("raw", pair.publicKey)),
    // The 32-byte scalar, which is the interchange format the rest of the
    // ecosystem uses. src/vapid.ts also accepts a JWK or PKCS#8.
    vapidPrivateKey: jwk.d,
  };
}

const randomToken = () => b64url(crypto.getRandomValues(new Uint8Array(32)));

/** Six words is plenty when enrolment is one device, once, by hand. */
const randomInviteCode = () =>
  b64url(crypto.getRandomValues(new Uint8Array(9))).replace(/[-_]/g, "").slice(0, 10);

// ---------------------------------------------------------------------------

function wrangler(args, stdin) {
  return execFileSync("npx", ["wrangler", ...args], {
    input: stdin,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "inherit"],
  });
}

/**
 * Which secrets the Worker already holds. This is the guard that makes the
 * script safe to run twice: `wrangler secret put` overwrites without asking,
 * and overwriting KUKUROO_VAPID_PRIVATE destroys every enrolled device with no
 * error anywhere.
 */
function existingSecretNames() {
  try {
    return JSON.parse(wrangler(["secret", "list"])).map((s) => s.name);
  } catch {
    die(
      "Could not read the Worker's secret list.\n" +
        "Run this from the directory holding your wrangler config, with wrangler authenticated.",
    );
  }
}

function putSecret(name, value) {
  // Piped on stdin, never as an argument, so the value stays out of the process
  // table and out of shell history.
  wrangler(["secret", "put", name], value);
  console.log(`  set ${name}`);
}

function writeCredentials(credentials) {
  writeFileSync(CREDENTIALS_PATH, JSON.stringify(credentials, null, 2) + "\n", { mode: 0o600 });
  console.log(`  wrote ${CREDENTIALS_PATH} (0600)`);
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
    die(`--rotate takes send-token or invite-code; got ${JSON.stringify(what)}`);
  }
  if (!existsSync(CREDENTIALS_PATH)) {
    die(`No ${CREDENTIALS_PATH}. Run without --rotate to do first-time setup.`);
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
        "  node scripts/init.mjs --rotate send-token\n" +
        "  node scripts/init.mjs --rotate invite-code",
    );
  }

  const present = existingSecretNames().filter((n) => Object.values(SECRET_NAMES).includes(n));
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
Done. Three things left, in this order.

1. Put the public key in your wrangler config. It is a plain var, not a secret:
   the enrolment page needs it client-side.

     "vars": { "KUKUROO_VAPID_PUBLIC": "${credentials.vapidPublicKey}" }

2. Back up kukuroo.credentials.json somewhere you will still have in three years.
   A password manager entry is enough. The VAPID private key in that file cannot
   be recovered from Cloudflare: secrets are write-only. Losing it means
   re-enrolling every device by hand.

   Add it to .gitignore if it is not already.

3. Your invite code, for the enrolment page:

     ${credentials.inviteCode}

The send token is in the credentials file under "sendToken". Whatever sends
notifications reads it from there, or from a copy you place yourself:

     node -p 'require("./kukuroo.credentials.json").sendToken' > ~/.kukuroo-send-token
     chmod 600 ~/.kukuroo-send-token

Of the four values, only the VAPID keypair is permanent. The send token and the
invite code can be rotated any time with --rotate, and nothing re-enrols.
`);
}

const rotateAt = process.argv.indexOf("--rotate");
await (rotateAt === -1 ? firstTimeSetup() : rotate(process.argv[rotateAt + 1]));
