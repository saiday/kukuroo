// `kukuroo init`, run end to end, against a wrangler that is not there.
//
// Everything else in this suite tests a function. This one tests the script,
// because the script is what fails: an init that scaffolds, installs, generates
// keys and then dies on the deploy has already written a VAPID key it cannot
// regenerate, and no unit test of any piece of it would have said so. The bug
// that prompted this file was a function deleted in a refactor and still called
// three hundred lines away, which parses, type-checks, passes every test that
// imports a module, and crashes the moment somebody runs it for real.
//
// It runs for real here. `npx` and `npm` are stubbed onto a PATH holding almost
// nothing else, so wrangler is never installed, Cloudflare is never contacted,
// and nothing is deployed; the stub records what it was asked for and answers in
// wrangler's own words. What is exercised is the whole of init: the auth check,
// the scaffold, the secret upload, the deploy, and the summary printed after it.
//
// The call log is an assertion in its own right. One `secret bulk` and one
// `deploy` is the floor for a first-time setup -- secrets and code are separate
// API operations -- and every extra call is another version in somebody's
// dashboard, which is how this was noticed in the first place.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const init = join(here, "..", "scripts", "init.mjs");

const ok = (label, cond) => {
  console.log(`${cond ? "  ok" : "FAIL"}  ${label}`);
  if (!cond) process.exitCode = 1;
};

const ACCOUNT = "Feocms@gmail.com's Account";

// wrangler's own output, close enough that the parsing is being tested rather
// than a paraphrase of it: the whoami table is box-drawn and the deploy names
// its workers.dev address on a line of its own.
const STUB = `#!/bin/bash
echo "npx $*" >> "$STUB_LOG"
case "$*" in
  "wrangler whoami")
    echo " wrangler 4.76.0"
    echo "Getting User settings..."
    echo "You are logged in with an OAuth Token, associated with the email feocms@gmail.com."
    echo "┌────────────┬────────────┐"
    echo "│ Account Name               │ Account ID                       │"
    echo "├────────────┼────────────┤"
    echo "│ ${ACCOUNT} │ 75ef187b83be586e7491aeb01b387e05 │"
    echo "└────────────┴────────────┘"
    exit 0 ;;
  "wrangler secret list")
    # What wrangler really does for a Worker that does not exist yet: nothing on
    # stdout, a complaint on stderr, and a non-zero exit.
    echo "Worker not found." >&2; exit 1 ;;
  "wrangler secret bulk")
    cat > "$STUB_LOG.secrets"; echo "Finished processing secrets file:"; exit 0 ;;
  "wrangler deploy")
    echo "Total Upload: 92.60 KiB / gzip: 21.02 KiB"
    echo "Uploaded demo (3.20 sec)"
    echo "Deployed demo triggers (0.52 sec)"
    echo "  https://demo.example-acct.workers.dev"
    echo "Current Version ID: 0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9"
    exit 0 ;;
  *) echo "STUB REFUSED: npx $*" >&2; exit 1 ;;
esac
`;

/**
 * Run init once, in a directory of its own, and hand back what it did.
 *
 * PATH is the point: the stubs first, then node so the script can find itself,
 * then the system directories the stubs' own shell needs. wrangler is reachable
 * only as the stub, so a command this does not recognise fails loudly instead of
 * quietly reaching Cloudflare.
 */
function runInit(args) {
  const root = mkdtempSync(join(tmpdir(), "kukuroo-init-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "npx"), STUB);
  writeFileSync(join(bin, "npm"), "#!/bin/bash\necho \"npm $*\" >> \"$STUB_LOG\"\necho added\n");
  chmodSync(join(bin, "npx"), 0o755);
  chmodSync(join(bin, "npm"), 0o755);

  const log = join(root, "calls.log");
  let output;
  let failed = false;
  try {
    output = execFileSync(process.execPath, [init, "init", "demo", ...args], {
      cwd: root,
      encoding: "utf8",
      // No TTY on stdin, so init takes its defaults for anything the flags left
      // unanswered and asks nothing. That is the same path a CI run takes.
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        STUB_LOG: log,
        PATH: [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
      },
    });
  } catch (error) {
    failed = true;
    output = String(error.stdout ?? "") + String(error.stderr ?? "");
  }

  const read = (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return "";
    }
  };
  return {
    failed,
    output,
    calls: read(log).trim().split("\n").filter(Boolean),
    secrets: read(`${log}.secrets`),
    credentialsPath: join(root, "demo", "kukuroo.credentials.json"),
    packagePath: join(root, "demo", "package.json"),
  };
}

// ---------------------------------------------------------------------------
// A workers.dev deployment, which is the default and the one that has to read
// its own address off the deploy.

// `--no-invite` is stated rather than taken: the default is now the gate, so an
// open deployment is something a run has to ask for. The assertion further down
// is about what an open deployment prints, and it needs a run that is one.
const wd = runInit(["--deploy", "--workers-dev", "--no-invite"]);

ok("init runs to the end", !wd.failed);
if (wd.failed) console.log(wd.output);

ok("it names the account it is about to use", wd.output.includes(`Cloudflare account: ${ACCOUNT}`));

// The whole of item 6: three `secret put` calls and two deploys were six
// versions in the dashboard for one setup. This is the floor.
ok(`one secret write and one deploy (${wd.calls.length} calls)`,
  wd.calls.join(" | ") ===
    "npx wrangler whoami | npm install | npx wrangler secret list | " +
    "npx wrangler secret bulk | npx wrangler deploy");

// A merge patch, so what is not named is not touched. All three go in one call
// or the version count goes back up.
const bulk = JSON.parse(wd.secrets || "{}");
ok("all three secrets go up in the one call",
  Object.keys(bulk).sort().join(",") ===
    "KUKUROO_INVITE_CODE,KUKUROO_SEND_TOKEN,KUKUROO_VAPID_PRIVATE");

ok("the deploy happened and said so", wd.output.includes("Done, and deployed."));

// The headline block, by label rather than by counting the spaces after it: the
// gap is padding to the widest label in the table, so spelling one of them
// differently is not a reason for this to fail. What is worth pinning is that
// the values line up, since they are read one after another off a screen.
const rowFor = (output, label) =>
  output.split("\n").find((line) => new RegExp("^\\s+" + label + "\\s").test(line)) ?? "";
const originRow = rowFor(wd.output, "Origin");
const enrollRow = rowFor(wd.output, "Enroll at");

ok("the summary leads with the address the deploy printed",
  originRow.includes("https://demo.example-acct.workers.dev"));
ok("and with the page a phone opens",
  enrollRow.includes("https://demo.example-acct.workers.dev/push/enroll"));
ok("the two values line up",
  originRow.indexOf("https://") === enrollRow.indexOf("https://"));

// The curl at the end is meant to be run, not adapted, so the token in it has to
// be the token that was installed rather than a placeholder. Three copies of one
// value: the file, the upload, and the printed command.
const credentials = JSON.parse(readFileSync(wd.credentialsPath, "utf8"));
ok("the printed curl carries the send token that was installed",
  wd.output.includes(`Bearer ${credentials.sendToken}`) &&
  bulk.KUKUROO_SEND_TOKEN === credentials.sendToken);
ok("the credentials file is readable only by its owner",
  (statSync(wd.credentialsPath).mode & 0o777) === 0o600);

// Nothing about the invite code for somebody who has just said they do not want
// one. The code is still generated and installed, so the gate can be closed
// later, but that is a README's job rather than a paragraph at the end of a
// setup somebody is reading to find out what to do next.
ok("an open deployment is not lectured about the code it declined",
  !wd.output.includes("Enrollment is open") &&
  !wd.output.includes(credentials.inviteCode));

// ---------------------------------------------------------------------------
// A custom domain, which knows its origin before the deploy and must not report
// the workers.dev address the same deploy also prints.

const dom = runInit(["--deploy", "--origin", "demo.kukuroo.cc", "--invite"]);

ok("a custom domain init runs to the end", !dom.failed);
if (dom.failed) console.log(dom.output);
ok("it deploys once, like the other one",
  dom.calls.filter((c) => c === "npx wrangler deploy").length === 1);
ok("the summary reports the domain, not the workers.dev address the deploy printed",
  rowFor(dom.output, "Origin").includes("https://demo.kukuroo.cc") &&
  !rowFor(dom.output, "Origin").includes("workers.dev"));

// Read off the screen together, on a phone, within a minute of each other.
const domCredentials = JSON.parse(readFileSync(dom.credentialsPath, "utf8"));
ok("the invite code is printed with the origin, not a screen later",
  rowFor(dom.output, "Invite code").includes(domCredentials.inviteCode));
ok("a gated deployment is told where the code lives",
  dom.output.includes('The invite code is in the same file under "inviteCode"'));

// ---------------------------------------------------------------------------
// --link. Running this script from a checkout makes the wizard local and leaves
// the library remote, so a change to src/ can be scaffolded, deployed and opened
// on a phone without once being the code that ran. The flag closes that gap, and
// this checks the one line that does it.

const repo = join(here, "..");
const linked = runInit(["--no-deploy", "--workers-dev", "--link"]);

ok("a linked init runs to the end", !linked.failed);
if (linked.failed) console.log(linked.output);
ok("--link depends on the checkout that wrote the project",
  JSON.parse(readFileSync(linked.packagePath, "utf8")).dependencies.kukuroo === `file:${repo}`);
ok("and says so where it says everything else it wrote",
  linked.output.includes(`kukuroo file:${repo}`));

// This run answers neither --invite nor --no-invite, so it is the one that takes
// the default. The default is the gate: every unattended path lands here, and
// the other way round scaffolds an open /subscribe onto a URL nobody is watching.
ok("the default answer scaffolds the gate closed",
  readFileSync(join(dirname(linked.packagePath), "src", "worker.ts"), "utf8")
    .includes("requireInvite: true"));

// Without it, nothing changes: a checkout still scaffolds against GitHub, which
// is what somebody setting up a real deployment from a clone wants.
ok("without it the project still depends on the published package",
  JSON.parse(readFileSync(wd.packagePath, "utf8")).dependencies.kukuroo ===
    "github:saiday/kukuroo");
