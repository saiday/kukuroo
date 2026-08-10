---
description: Point this machine's agents at a Kukuroo Worker, and prove the channel works
argument-hint: "[origin]"
allowed-tools: [Bash, Read, Glob]
---

# Wire up Kukuroo

The user invoked this with: $ARGUMENTS

Goal: leave `$XDG_CONFIG_HOME/kukuroo/env` holding a working origin and send token, verified by a
notification that actually arrived. Every project on this machine reads that one file afterwards.

## 1. Find what is already there

```sh
cat "${XDG_CONFIG_HOME:-$HOME/.config}/kukuroo/env" 2>/dev/null
```

That file, or `KUKUROO_ORIGIN` and `KUKUROO_SEND_TOKEN` already in the environment, is the only place
either value lives on this machine. Kukuroo is deployed on one machine and sent to from others, so
being on a machine that has never been wired up is the normal case and not a sign anything is wrong.

`$ARGUMENTS`, if given, is the origin. Accept it with or without a scheme and normalise to
`https://<host>` with no trailing slash.

## 2. Ask for what is missing

One message, both values:

> Which origin does your Kukuroo Worker answer on, and what is its send token? Pasting the token puts
> it in this transcript; if you would rather it did not, put both in `~/.config/kukuroo/env` yourself
> (`KUKUROO_ORIGIN=` and `KUKUROO_SEND_TOKEN=`, a line each) and say when it is done.

Both are in `kukuroo.credentials.json` on the machine the deployment was set up from: `sendToken`, and
the address is the custom domain in its `wrangler.jsonc` or the `workers.dev` URL the deploy printed.
Say that once if they do not have the values to hand.

If they have not deployed a Worker at all yet, `npx kukuroo init my-push` is the whole of setup. Say
that and stop, rather than walking them through it here.

## 3. Prove it, then store it

Send a real notification. This is the only way to know: nothing in the config can tell you whether a
device is still enrolled.

```sh
curl -fsS -X POST "$KUKUROO_ORIGIN/push/send" \
  -H "authorization: Bearer $KUKUROO_SEND_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"notification":{"title":"Kukuroo is wired up","body":"Your agents can reach this phone.","tag":"kukuroo-warmup","navigate":"'"$KUKUROO_ORIGIN"'/"}}'
```

Write the env file **only** once the response says `delivered` above zero, so a wrong token never
reaches disk:

```sh
umask 077 && mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/kukuroo"
printf 'KUKUROO_ORIGIN=%s\nKUKUROO_SEND_TOKEN=%s\n' "$KUKUROO_ORIGIN" "$KUKUROO_SEND_TOKEN" \
  > "${XDG_CONFIG_HOME:-$HOME/.config}/kukuroo/env"
```

## 4. Report, briefly

Three facts and nothing else: the origin, whether the notification arrived, and the path of the file
you wrote. Then say that "ping me on my phone when this is done" now works in any project.

Read the response rather than the exit code:

- `"delivered":1` or more — done.
- `"delivered":0` — the request was fine and no device is enrolled. Nothing gets stored. The fix is
  enrolment, not config: open the origin in Safari on the phone, Add to Home Screen, open it **from
  the icon**, and allow notifications. A Safari tab cannot subscribe on iOS.
- `401` — the token is wrong, or has been rotated on the machine that holds the credentials file.
  Nothing gets stored; ask for the current one.
- Connection refused or a 404 HTML page — the origin is wrong, or the Worker is not deployed there.
