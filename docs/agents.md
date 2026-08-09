# Letting an agent notify you

A Kukuroo deployment is one authenticated POST away from your phone, which makes it a
natural thing for a coding agent to hold: you step away, and the work tells you when it is
done. Two problems stand between those two facts, and this is how each is answered.

**The agent does not know where to send.** It is working in some other repository, so
neither `kukuroo.credentials.json` nor `wrangler.jsonc` is anywhere it can see. And until
recently the address of a `workers.dev` deployment was printed once, after the deploy, and
recorded nowhere at all.

**The agent should not hold the token.** Reading a send token out of a file and pasting it
into a shell command puts it in the transcript, in that transcript's backups, and in shell
history. A credential that has been copied to four places has been rotated to none of them.

## Where to send

```sh
npx kukuroo agent-env --origin push.example.com
```

That writes two lines to `$XDG_CONFIG_HOME/kukuroo/env` (`~/.config/kukuroo/env` by
default) at mode 0600, in a directory at 0700:

```
KUKUROO_ORIGIN=https://push.example.com
KUKUROO_SEND_TOKEN=...
```

- **`init` writes it for you**, as soon as it knows the origin. It also records the origin
  in `kukuroo.credentials.json` now, so `agent-env` can be re-run later with no arguments.
  When a `workers.dev` deploy's output does not name a URL the field stays absent rather
  than guessed, and `--origin` is how you supply it.
- **`rotate send-token` updates it**, if it exists. Without that, rotating leaves every
  agent on the machine holding a token that 401s, and the failure surfaces hours later as a
  notification that never came.
- **It holds no VAPID key.** Sending needs a bearer token; a second copy of a key that can
  never be rotated is only a second thing to lose.
- **`--token-stdin`** reads the token from stdin rather than the credentials file, for a
  machine that has no copy of it:
  ```sh
  pbpaste | npx kukuroo agent-env --origin push.example.com --token-stdin
  ```
  Never as an argument. An argument is visible in `ps` for the life of the process and
  lands in shell history afterwards.

Being shell-sourceable is the whole design. The agent writes `$KUKUROO_SEND_TOKEN` and
never learns its value:

```sh
set -a; . "${XDG_CONFIG_HOME:-$HOME/.config}/kukuroo/env"; set +a
curl -fsS -X POST "$KUKUROO_ORIGIN/push/send" \
  -H "authorization: Bearer $KUKUROO_SEND_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"notification":{"title":"tests green","body":"412 passed in 38s","tag":"ci","navigate":"'"$KUKUROO_ORIGIN"'/"}}'
```

## What to send, and when

```sh
claude plugin marketplace add saiday/kukuroo
claude plugin install kukuroo@kukuroo
```

The repository is its own single-plugin marketplace, so those two lines are the install.
What arrives is a skill, a slash command, and a rules file:

| | |
|---|---|
| `skills/kukuroo-notify/` | the skill, and the payload reference it points at |
| `commands/kukuroo-setup.md` | `/kukuroo-setup`: wire this machine up and prove it works |
| `rules/kukuroo.mdc` | the same contract for Cursor and anything else reading `rules/` |

Nothing here is required. The deployment behaves the same whether or not any of it is
installed; it is one HTTP endpoint, and `curl` was always enough.

### It fires when you ask, and not otherwise

The skill triggers on an explicit request: a notification or status update **on your
phone**, a time you want to be told at, a mention of stepping away or being afk, or Kukuroo
by name. It deliberately does not fire because the agent decided a task had run long
enough to deserve a buzz.

That narrowness is doing two jobs. A push arrives on a lock screen wherever you happen to
be, so it is yours to ask for. And a skill that fires on a judgement call fires
inconsistently, which is worse than one that never fires at all: you cannot rely on it and
you cannot predict it.

### It warms the channel up before promising anything

Before committing to a notification later, the skill sends one now, and tells you in about
two sentences what is coming and that if the warm-up did not arrive your setup needs a
look.

This is not ceremony. Deleting a Home Screen icon destroys the subscription and nothing
reports that; a device left in a drawer for a month is equally silent. As
[the enrolment guide](create-pwa-and-subscribe-to-push.md) puts it, the absence of a
message you were expecting is the only reliable signal that the channel has died. A promise
made without a live test is a promise made on faith, and the cost of testing is one
notification you were about to receive anyway.

If the warm-up comes back `"delivered":0`, that changes the promise rather than footnoting
it: the agent says the notification did not arrive and that the later one will not either.

### `"delivered":0` is a failure

The response is `{"delivered":N,"removed":N,"failures":[]}`. `delivered` counts
subscriptions the push service accepted the message for, so a zero means the request was
fine and nothing reached a phone, usually because nothing is enrolled any more. The count
is in the response precisely so this cannot be read as success, and the skill is told to
report it as the failure it is.

### Scheduling has a limit worth knowing

"At 5pm" and "in 30 minutes" are scheduled with Claude Code's own one-shot cron, which
lives in the session's memory and fires only while the session is idle. Close Claude Code
and the notification does not happen. The skill is told to say so at the moment it
promises, rather than let you find out at 5pm.

A cloud-scheduled agent survives a closed laptop, but it has no access to
`~/.config/kukuroo/env`, and putting a send token into a scheduled prompt to work around
that stores the credential somewhere it should not be. If you want a notification that
genuinely does not depend on your machine, the honest answer is a
[Cron Trigger](https://developers.cloudflare.com/workers/configuration/cron-triggers/) on
the Worker itself, calling `send(env, ...)` from a `scheduled` handler.

## The payload rules it is given

Four, all of them there because the failure is invisible rather than loud: WebKit discards a
payload it cannot parse, displays nothing, logs nothing, and the push service already
answered 201.

- `title` is required and non-empty; `navigate` is required and absolute. `$KUKUROO_ORIGIN/`
  is always a correct `navigate`, and a deployment may pin it to exactly that origin.
- One `tag` per topic, so a second notification about the same thing replaces the first on
  the lock screen instead of stacking beside it.
- Titles are written to be read alone, at a glance: the outcome, not a label. "migration
  failed on users table", not "task update".
- No secrets, tokens, or absolute paths in `title` or `body`. A lock screen is not private.

`skills/kukuroo-notify/references/payload.md` has the full field list, the members WebKit
ignores, the ~3900-byte budget, the status-code table, and the in-Worker `send(env, ...)`
path. The [API section of the README](../README.md#api) is the same contract for humans.

## When something does not arrive

| What you see | What it is |
|---|---|
| `"delivered":0` | Nothing enrolled. Open the origin in Safari on the phone, Add to Home Screen, open it **from the icon**, allow notifications. A Safari tab cannot subscribe on iOS. |
| `401 unauthorized` | The token is stale. `npx kukuroo rotate send-token`, which updates the env file too. |
| `delivered` is 1 and no banner | Almost always Chrome, Firefox, or Android, none of which can receive these. Otherwise check that the icon still exists on the Home Screen. |
| The agent never offers | The skill did not trigger. Say "on my phone" or "via Kukuroo" and it will; `/kukuroo-setup` also confirms the plugin is installed and the endpoint reachable. |
| A 404 HTML page | Wrong origin, or the Worker is not deployed there. |
