// What the agent-facing half ships, and whether it still describes this Worker.
//
// Three kinds of check here, and only the first is the obvious one.
//
// Manifests: a plugin whose JSON does not parse, or whose declared skills
// directory is not there, fails at install time in somebody else's terminal. It
// costs nothing to find out here instead.
//
// Drift: the skills document a payload in prose, and prose does not typecheck.
// The `curl` block in SKILL.md is pulled off disk and run through the real
// validator, so a documented example that Kukuroo would now reject is a failing
// test rather than a notification that never arrives. This is scaffold.test.mjs's
// trick pointed at documentation.
//
// The documented shell: setting an agent up is two shell blocks in SKILL.md and
// nothing else, so no code path in this package exercises them. They are pulled
// off disk and run, because a quoting mistake in a document is a mistake nothing
// else in this repository can notice.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildDeclarativePayload } from "../src/payload.ts";

const ok = (label, cond) => {
  console.log(`${cond ? "  ok" : "FAIL"}  ${label}`);
  if (!cond) process.exitCode = 1;
};

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) => readFileSync(join(root, ...parts), "utf8");
const readJson = (...parts) => JSON.parse(read(...parts));

// --- The manifests ---------------------------------------------------------

const marketplace = readJson(".claude-plugin/marketplace.json");
const plugin = readJson(".claude-plugin/plugin.json");

ok("the marketplace names one plugin", marketplace.plugins.length === 1);
ok(
  "the marketplace entry and the plugin agree on the name",
  marketplace.plugins[0].name === plugin.name && plugin.name === marketplace.name,
);
ok(
  "the plugin is the repository itself",
  marketplace.plugins[0].source === "./",
);
ok("the plugin version matches the package", plugin.version === readJson("package.json").version);

// A declared directory that is not there is an install-time failure, and the
// failure is silent: the plugin loads with no skills and nothing says why.
ok("the declared skills directory exists", existsSync(join(root, plugin.skills)));
for (const dir of plugin.commands) {
  ok(`the declared commands directory ${dir} exists`, existsSync(join(root, dir)));
}

const cursor = readJson(".cursor-plugin/plugin.json");
ok("the Cursor twin carries the same name and version",
  cursor.name === plugin.name && cursor.version === plugin.version);

// --- The skill -------------------------------------------------------------

/** Enough YAML for frontmatter: `key: value` and `- item` lists, nothing else. */
function frontmatter(source) {
  const match = source.match(/^---\n([\s\S]*?)\n---\n/);
  if (match === null) return null;
  const fields = {};
  let key = null;
  for (const line of match[1].split("\n")) {
    const pair = line.match(/^([a-z][a-z0-9_-]*):\s*(.*)$/i);
    const item = line.match(/^\s*-\s+(.*)$/);
    if (pair !== null) {
      key = pair[1];
      fields[key] = pair[2] === "" || pair[2] === ">" ? [] : pair[2];
    } else if (item !== null && Array.isArray(fields[key])) {
      fields[key].push(item[1].trim());
    } else if (key !== null && typeof fields[key] === "string" && line.trim() !== "") {
      fields[key] += " " + line.trim(); // folded block scalar
    } else if (key !== null && Array.isArray(fields[key]) && line.trim() !== "") {
      fields[key] = line.trim();
    }
  }
  return fields;
}

const skillSource = read("skills/kukuroo-notify/SKILL.md");
const skill = frontmatter(skillSource);

ok("the skill has parseable frontmatter", skill !== null);
ok("the skill's name matches its directory", skill.name === "kukuroo-notify");

// The description is the entire trigger: it is the only part of the skill loaded
// into every session, and a description that does not mention the phone is a
// skill nobody ever calls.
ok("the description names the phone", /phone/i.test(skill.description));
ok("the description says Kukuroo", /kukuroo/i.test(skill.description));

for (const name of [].concat(skill.references ?? [])) {
  ok(
    `the declared reference ${name} is on disk`,
    existsSync(join(root, "skills/kukuroo-notify/references", `${name}.md`)),
  );
}

// Every relative link in the skill resolves. A skill that points at a file that
// moved sends the agent to read nothing and carry on regardless.
for (const [, target] of skillSource.matchAll(/\]\((?!https?:)([^)#]+)\)/g)) {
  ok(`the link ${target} resolves`, existsSync(join(root, "skills/kukuroo-notify", target)));
}

for (const path of ["commands/kukuroo-setup.md", "rules/kukuroo.mdc"]) {
  ok(`${path} has parseable frontmatter with a description`,
    (frontmatter(read(path))?.description ?? "") !== "");
}

// --- The documented payload, against the real validator --------------------

/** Every `-d '<json>'` argument in a documented curl block. */
function documentedPayloads(source) {
  return [...source.matchAll(/-d '(\{[\s\S]*?\})'/g)].map(([, json]) =>
    // `'"$KUKUROO_ORIGIN"'` is the shell closing its quote, interpolating, and
    // reopening. The shell was verified separately; here it just needs an origin.
    json.replaceAll(`'"$KUKUROO_ORIGIN"'`, "https://push.example.com"),
  );
}

const documented = [
  ...documentedPayloads(skillSource),
  ...documentedPayloads(read("commands/kukuroo-setup.md")),
  ...documentedPayloads(read("rules/kukuroo.mdc")),
];

ok("the skills document at least one send", documented.length >= 3);

for (const json of documented) {
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    ok(`a documented payload is JSON: ${json.slice(0, 40)}`, false);
    continue;
  }
  let built = null;
  try {
    // navigateOrigin pinned, because the origin the skills default to is the one
    // a standalone deployment enforces. A documented example that the deployment
    // it documents would reject is the failure this test exists for.
    built = buildDeclarativePayload(parsed, { navigateOrigin: "https://push.example.com" });
  } catch (error) {
    ok(`a documented payload passes validation (${parsed.notification?.title}): ${error.message}`, false);
  }
  if (built !== null) {
    ok(
      `the documented payload "${parsed.notification.title}" is a declarative push`,
      JSON.parse(built).web_push === 8030,
    );
  }
}

// --- The documented setup, run as written -----------------------------------

// Setting an agent up is now two shell blocks and a question. Nothing in this
// package runs those blocks, so they are extracted and run here: `umask 077`
// carrying through to both the directory and the file, and the sourcing line
// round-tripping what the writing line wrote.

/** The fenced sh block containing `needle`. */
function shellBlock(source, needle) {
  for (const [, body] of source.matchAll(/```sh\n([\s\S]*?)```/g)) {
    if (body.includes(needle)) return body;
  }
  return null;
}

const writeBlock = shellBlock(skillSource, "printf 'KUKUROO_ORIGIN=");
ok("the skill documents how to write the env file", writeBlock !== null);

const sandbox = mkdtempSync(join(tmpdir(), "kukuroo-agent-"));
const config = join(sandbox, "config");

const bash = (script, env) =>
  execFileSync("/bin/bash", ["-c", script], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });

bash(writeBlock, {
  XDG_CONFIG_HOME: config,
  KUKUROO_ORIGIN: "https://push.example.com",
  KUKUROO_SEND_TOKEN: "send-token-fixture",
});

const envPath = join(config, "kukuroo", "env");
const envFile = readFileSync(envPath, "utf8");

ok("the documented block writes the env file", existsSync(envPath));
// It holds a send token, so the mode is a real assertion rather than tidiness.
ok("it is 0600", (statSync(envPath).mode & 0o777) === 0o600);
ok("its directory is 0700", (statSync(join(config, "kukuroo")).mode & 0o777) === 0o700);
ok("it carries the origin", envFile.includes("KUKUROO_ORIGIN=https://push.example.com\n"));
ok("it carries the send token", envFile.includes("KUKUROO_SEND_TOKEN=send-token-fixture\n"));
ok("it holds those two lines and nothing else", envFile.trimEnd().split("\n").length === 2);

// The send commands source that file instead of naming the token, which is the
// only reason the token never reaches a transcript. So the sourcing line has to
// work on the file the writing line produces.
const sourceLine = /^set -a;.*set \+a$/m.exec(skillSource)?.[0];
ok("the skill documents sourcing it", sourceLine !== undefined);

const sourced = bash(`${sourceLine}\nprintf '%s|%s' "$KUKUROO_ORIGIN" "$KUKUROO_SEND_TOKEN"`, {
  XDG_CONFIG_HOME: config,
});
ok("sourcing it loads both values", sourced === "https://push.example.com|send-token-fixture");

// The machine that sends is not the machine that deployed. So the two documents
// an agent acts on directly must not resolve config from setup leftovers:
// kukuroo.credentials.json and wrangler.jsonc are on somebody else's disk, and a
// lookup that reads them is a lookup that finds nothing while looking thorough.
for (const path of ["skills/kukuroo-notify/SKILL.md", "rules/kukuroo.mdc"]) {
  ok(
    `${path} does not send the agent looking for the deployment's own files`,
    !/kukuroo\.credentials\.json|wrangler\.jsonc/.test(read(path)),
  );
}
