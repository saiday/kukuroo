---
name: kukuroo-notify
description: >
  Push a notification to the user's own phone through their Kukuroo Worker. Use when they ask to be
  notified, pinged, buzzed, or sent a status update on their phone; name a time they want to be told
  at; say they are stepping away from the monitor or will be afk; or mention Kukuroo. Also for
  diagnosing a Kukuroo send that returned delivered 0.
references:
  - payload
---

# Notify the user on their phone

Kukuroo is the user's own Web Push service, running on their own Cloudflare Worker. One
authenticated POST puts a notification on their phone. This skill is where the endpoint lives, plus
the few rules whose failures are otherwise silent.

Kukuroo is the pipe, not the errand. Spend a line or two on it and get back to the work the user
actually asked for.

## 1. Fire only on an explicit ask

Send when the user asks for it:

- a notification, ping, buzz, or status update **on their phone**
- a time they want to be told at: "at 5pm", "in 30 minutes", "when the deploy lands"
- leaving: "I'm stepping away", "off the monitor", "going for a walk", "afk"
- Kukuroo by name

A push arrives on a lock screen wherever the user happens to be, so it is theirs to ask for. Work
they are sitting there watching is already visible to them, and needs no notification.

## 2. Find where to send, or ask

Two values: `KUKUROO_ORIGIN` (where the Worker answers) and `KUKUROO_SEND_TOKEN` (the bearer token).
Take the first source that has both.

1. Already in the environment.
2. The file this skill wrote the last time it asked:
   ```sh
   cat "${XDG_CONFIG_HOME:-$HOME/.config}/kukuroo/env" 2>/dev/null
   ```

There is no third source. A Kukuroo deployment is set up on one machine and sent to from any number
of others, so the setup leaves nothing behind here to find, and a search for one is a search that
comes back empty.

**Ask once, in one message.** The user has just asked for a notification, so getting the address is
part of the job. Both values in one question, in about two sentences:

> Which origin does your Kukuroo Worker answer on, and what is its send token? Pasting the token puts
> it in this transcript; if you would rather it did not, put both in `~/.config/kukuroo/env` yourself
> (`KUKUROO_ORIGIN=` and `KUKUROO_SEND_TOKEN=`, a line each) and say when it is done.

Then let it go. If the answer does not come, or comes back as "not now", drop Kukuroo and do the work
they actually asked for. One question costs them a moment. A second one costs them the thread.

**Store on first success, not on being told.** Hold the answers for the length of the turn, send the
warm-up, and write the file only once a send has come back with `delivered` above zero:

```sh
umask 077 && mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/kukuroo"
printf 'KUKUROO_ORIGIN=%s\nKUKUROO_SEND_TOKEN=%s\n' "$KUKUROO_ORIGIN" "$KUKUROO_SEND_TOKEN" \
  > "${XDG_CONFIG_HOME:-$HOME/.config}/kukuroo/env"
```

A wrong token never reaches disk that way, and the user is asked once per machine rather than once per
project. Say the file was written, in the same breath as the warm-up result — storing a credential is
never something to do quietly.

A `401` means the token in that file is stale, which is what a rotation on another machine looks like
from here. Ask for the new one the same way, once, and overwrite the file.

## 3. Warm up, then say what will happen

Send a real notification immediately, before promising a later one:

```sh
set -a; . "${XDG_CONFIG_HOME:-$HOME/.config}/kukuroo/env"; set +a
curl -fsS -X POST "$KUKUROO_ORIGIN/push/send" \
  -H "authorization: Bearer $KUKUROO_SEND_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"notification":{"title":"Kukuroo is wired up","body":"Notifications will arrive here.","tag":"kukuroo-warmup","navigate":"'"$KUKUROO_ORIGIN"'/"}}'
```

A subscription dies silently: deleting the Home Screen icon destroys it and nothing reports that.
So a promise made without a live test is a promise made on faith, and the warm-up is what turns it
into a fact. Then disclose, in about two sentences — what is coming, when, and the one link:

> I'll push the test result to your phone at 5pm, via Kukuroo. A warm-up notification just went out;
> if it didn't arrive, your setup needs a look:
> https://github.com/saiday/kukuroo#agents

Warm up **once per session**, on the first thing you promise. Later sends in the same session go
straight out.

If the warm-up comes back `"delivered":0`, that changes the promise rather than being a footnote to
it. Say the notification did not arrive and that the 5pm one will not either, then carry on with the
real work.

## 4. Arrange the delivery

- **An event you are waiting on** — "when the tests finish", "when the deploy lands". No scheduling:
  you are still here when it happens, so send it then.
- **A time this session** — "at 5pm", "in 30 minutes". Use `CronCreate` with `recurring: false` and
  minute, hour, day-of-month and month all pinned. Disclose the catch in one clause, because it is
  the user's to plan around: the job lives in this session's memory and fires only while the session
  is idle, so closing Claude Code cancels it.
- **A time beyond this session** — say plainly that a local agent cannot keep that promise, and that
  the durable version is a Cron Trigger on the Worker itself.

## 5. Send, and read `delivered`

The response is `{"delivered":N,"removed":N,"failures":[...]}`. **`"delivered":0` is a failure**: the
request succeeded and nothing reached a phone, usually because no device is enrolled any more.
Report it as a failure. It is never a quiet success.

Four rules for the payload itself, each one here because getting it wrong fails invisibly — the push
service returns 201 and WebKit discards the message with no error anywhere:

- `title` is required and non-empty. `navigate` is required and absolute. Defaulting `navigate` to
  `$KUKUROO_ORIGIN/` is always correct, and the deployment may pin it to exactly that origin.
- Reuse one `tag` per topic, so a second notification about the same thing replaces the first on the
  lock screen instead of stacking beside it.
- Write the title to be read alone, at a glance, by someone holding a phone: the outcome, not a
  label. "migration failed on users table", not "task update".
- Keep secrets, tokens, and absolute paths out of `title` and `body`. A notification is read wherever
  the phone is, including on a lock screen someone else can see.

Receiving needs Safari on iOS 18.4+ or macOS 18.5+, opened from a Home Screen icon. Chrome, Firefox,
and Android cannot receive these at all, which answers most reports that a notification never showed
up.

The full field list, the members WebKit ignores, the size budget, sending from inside a Worker, and a
status-code table are in [references/payload.md](references/payload.md).
