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
ls -l "${XDG_CONFIG_HOME:-$HOME/.config}/kukuroo/env" 2>/dev/null; ls -l kukuroo.credentials.json 2>/dev/null
```

- The env file exists: read `KUKUROO_ORIGIN` from it and go to step 3 to re-verify. Report the origin,
  never the token.
- `kukuroo.credentials.json` is here: this is the user's push project. Take `origin` and `sendToken`
  from it. When `origin` is absent, the deployment predates that field, so ask for it or take it from
  `wrangler.jsonc` (`routes[].pattern`, or `vars.KUKUROO_NAVIGATE_ORIGIN`).
- Neither: step 2.

`$ARGUMENTS`, if given, is the origin. Accept it with or without a scheme and normalise to
`https://<host>` with no trailing slash.

## 2. Ask for what is missing

The origin is public, so ask for it in the conversation. The send token is a credential, so offer the
choice and name the difference:

> Run this yourself and the token stays out of this transcript — in Claude Code, `!` runs a command
> here:
> `!kukuroo agent-env --origin https://push.example.com`
> Or paste the token and I'll store it, which does put it in the transcript.

If the user has not deployed a Worker yet, `npx kukuroo init my-push` is the whole of setup; say that
once and stop rather than walking them through it here.

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
- `401` — the token is wrong or has been rotated. `kukuroo rotate send-token` prints a new one.
- Connection refused or a 404 HTML page — the origin is wrong, or the Worker is not deployed there.
