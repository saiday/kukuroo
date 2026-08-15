# Releasing Kukuroo

Maintainer-facing. Not shipped in the tarball; `package.json` `files` does not list it.

Work top to bottom. Anything that fails is a stop, not a note to self: this package
generates keys that cannot be rotated and enrolls devices that cannot be repaired from
another origin, so a bad release costs somebody their subscriptions rather than a patch.

## 1. Preflight: repo state and the ability to publish

```sh
git switch main && git pull
git status --short              # must be clean
git log $(git describe --tags --abbrev=0)..HEAD --oneline
```

- [ ] Clean tree, on `main`, synced with origin.
- [ ] Read the commit list above. It is the changelog and it decides the next number.

Then prove you can actually publish, before anything else is built, deployed, or torn down.

```sh
npm whoami                      # must not 401
npm profile get                 # shows the two-factor mode
```

- [ ] Logged in as the maintainer.
- [ ] You can produce a working second factor **right now**, not in principle. With
      `two-factor auth: auth-and-writes`, every publish needs a one-time password, and a
      TOTP code is only valid if the clock on the device generating it is accurate. An
      authenticator that has drifted emits codes that look fine and are rejected every time.
- [ ] If you publish with a granular access token instead, confirm it exists, is scoped to
      this package with write access, and has 2FA bypass enabled. Note that `npm token
      create` cannot be used to make one, because creating a token is itself a write and
      needs the very OTP you may be unable to produce. That one is made on the website.

This section is here because of the release that skipped it. Everything downstream passed,
the QA Worker was torn down, and only then did four consecutive publishes fail on a second
factor nobody had tested. The order matters: an unpublishable release discovered early costs
a minute, and discovered last costs the deployment you were still using to verify things.

## 2. Version

The published version is the one thing no check catches until npm rejects the publish.

```sh
npm view kukuroo version        # what is already out there
node -p "require('./package.json').version"
```

- [ ] `package.json` version is greater than the published one.
- [ ] `.claude-plugin/plugin.json` and `.cursor-plugin/plugin.json` carry the same version.
      `test/agent.test.mjs` asserts this, so a mismatch fails `npm test` rather than shipping.

## 3. Build and correctness

```sh
npm test                        # 213 assertions across 6 suites
npm run typecheck
```

- [ ] Both pass. `prepublishOnly` runs them again at publish time; do not rely on that as
      the first run, because a failure there leaves a half-tagged release.

## 4. Package shape

```sh
npm pack --dry-run
```

- [ ] Every directory in `files` appears: `src`, `scripts`, `templates`, `docs`, `skills`,
      `commands`, `rules`, `.claude-plugin`, `.cursor-plugin`.
- [ ] No `.DS_Store`, no `.wrangler`, no `kukuroo.credentials.json`, no `.dev.vars`.
- [ ] Every relative link in `README.md` points at a path that is in the tarball. A link
      into a directory `files` omits is broken for everyone reading it in `node_modules`.

Then install the tarball into a scratch project and use it as a consumer would:

```sh
npm pack --pack-destination /tmp/qa
cd /tmp/qa && npm init -y && npm pkg set type=module
npm i ./kukuroo-<version>.tgz @cloudflare/workers-types@^5 typescript@^5.9.3
./node_modules/.bin/kukuroo init --help          # bin is linked and executable
```

- [ ] A `mountKukuroo` + `send` + `enrollmentPage` import typechecks against the tarball.
- [ ] It typechecks with `"allowImportingTsExtensions": true` and fails loudly without it.
      Kukuroo ships TypeScript source, so this flag is a documented requirement of mounting,
      not an optional nicety. If the failure mode changes, the README section must change too.

## 5. Routes, live

Do not test the routes by reading them. Run a Worker.

```sh
mkdir -p /tmp/qa-dev/src && cd /tmp/qa-dev
cp <repo>/templates/standalone/{tsconfig.json,package.json} .
cp <repo>/templates/standalone/src/worker.ts src/
# point the kukuroo dependency at the checkout, add a local KV id and workers_dev,
# then write .dev.vars with a generated VAPID JWK, a send token, and an invite code
npm i && npx wrangler dev --port 8787 --local
```

- [ ] `GET /push/enroll` 200, `GET /push/public-key` returns a `publicKey`.
- [ ] `GET /` redirects to `/push/enroll`.
- [ ] `POST /push/send` with no token and with a wrong token both 401.
- [ ] `POST /push/send` with the right token returns `{"delivered":0,...}` on an empty KV.
      Zero is the honest answer here, not a failure.
- [ ] `POST /push/subscribe` with no invite and with a wrong invite both 403.
- [ ] Each of these is rejected before any fetch leaves the Worker, with an error naming the
      field: missing `navigate`, relative `navigate`, empty `title`, relative `icon`,
      `navigate` off `KUKUROO_NAVIGATE_ORIGIN`.
- [ ] CORS: with `KUKUROO_ALLOWED_ORIGINS` unset, no `Access-Control-Allow-Origin` anywhere.
      With it set, `subscribe` and `public-key` echo the one allowed origin and no other, and
      `/push/send` still carries no CORS header at all. That last one is deliberate: a page
      holding the send token should fail its first test rather than work quietly.

## 6. Browser

```sh
agent-browser open http://localhost:8787/push/enroll
```

- [ ] In a non-Safari browser the page says it cannot enroll and names the versions that can
      (iOS 18.4+, macOS Safari 18.5+). It must refuse honestly rather than half-work.
- [ ] Renders correctly at a phone viewport (390x844). This is the only viewport that matters.
- [ ] No console errors, no failed requests.
- [ ] `site/index.html` renders at 1280 and at 390 with no horizontal overflow, and its links
      resolve.
- [ ] `curl -sI https://kukuroo.cc/og.png` answers `content-type: image/png`. Pages serves a
      real file ahead of the catch-all, so `text/html` here means the asset is missing and
      every share preview is silently imageless. The card is only re-cut when the headline
      changes; the `og:title` and `og:description` still matching the page is the check.

A first deploy to a fresh `workers.dev` name is not globally consistent for a minute or two:
colos that have not picked up the script yet answer 404, so a handful of requests fail while
the rest succeed. Loop each route twenty times and wait for a clean run before believing any
404, and do not go hunting through `mount.ts` for a routing bug that is really propagation.

## 7. The real device

Nothing above proves a notification arrives. Only a device does, and this step cannot be
automated: it needs a permission prompt answered by a person.

- [ ] On an iPhone, open the origin in Safari, **Add to Home Screen**, open it **from the
      icon**, allow notifications, enter the invite code.
- [ ] `POST /push/send` and confirm the notification appears on the lock screen.
- [ ] Tap it and confirm it lands inside the installed app, not a browser tab.

Skipping this because the unit tests are green is how a release ships an encryption or VAPID
regression that every local check passes.

## 8. Tear down the QA deployment

Do this before publishing, not after. A QA Worker left running is a live enrollable origin
with a real invite code, and the credentials file on disk is the only copy of a VAPID key
that now has devices attached to it.

Before deleting anything, re-read section 1. Tearing down while the publish is still unproven
is what turns a credential problem into a lost test environment.

```sh
cd <qa-dir>
npx wrangler delete                                  # the Worker and its secrets
npx wrangler kv namespace list                       # find the QA namespace id
npx wrangler kv namespace delete --namespace-id <id> # the subscriptions
rm -rf <qa-dir>                                      # includes kukuroo.credentials.json
```

- [ ] Worker deleted, and its hostname no longer answers.
- [ ] KV namespace deleted. It is named `<worker>-kukuroo-subs` and wrangler creates it
      per Worker, so it does not disappear with the script.
- [ ] Delete the Home Screen icon from any phone enrolled during the test. The subscription
      is dead once the Worker is gone, but the icon stays and opens a broken page.
- [ ] The QA `kukuroo.credentials.json` is gone. It is a real keypair, not a fixture.

## 9. Publish

```sh
npm publish --dry-run
npm publish --otp=<code>        # or via a granular token, below
```

Publishing with a token, without writing it into `~/.npmrc` where it outlives the release:

```sh
tools/npm-token.sh set               # once, into the macOS login Keychain
tools/npm-token.sh check             # confirm it authenticates before you need it
tools/npm-token.sh run npm publish
```

The script does the same thing by hand, if you would rather not store the token at all:

```sh
RC="$(mktemp -t npmrc-publish)" && chmod 600 "$RC"
printf '//registry.npmjs.org/:_authToken=%s\n' "$TOKEN" > "$RC"
NPM_CONFIG_USERCONFIG="$RC" npm publish
rm -f "$RC"
```

- [ ] Published, and `npm view kukuroo --prefer-online version` reports the new number.
      Without `--prefer-online` this can report the old version for a while after a
      successful publish, from the local cache rather than the registry. `curl -sS
      https://registry.npmjs.org/kukuroo` settles it.
- [ ] Install it from the registry, not from the working tree, and check the things that
      only the published artifact can be wrong about: `docs/` present, every relative README
      link resolving inside `node_modules`, and the `bin` runnable.

```sh
cd "$(mktemp -d)" && npm init -y >/dev/null && npm i kukuroo@<version>
./node_modules/.bin/kukuroo init --help
```

Then the tag, which points at the commit whose tree was published, not at wherever `main`
has since moved:

```sh
git tag v<version> <commit> && git push origin main --tags
```

- [ ] Tag pushed, and it names the commit the tarball was built from.
- [ ] `npx kukuroo@latest init --help` works from a directory with no checkout.
- [ ] If a token was used, revoke it unless you intend to keep it, and drop it from the
      Keychain with `tools/npm-token.sh rm`.

## 10. The GitHub release

The tag is a pointer. The release is the only place a reader is told what changed and
whether it touches them, so write it for somebody who has the old version installed and
wants to know whether to care.

Do this after the tag is pushed. `gh release create` against a tag that does not exist
on the remote creates one from the default branch, which is the mistake section 9 just
took care to avoid: it would name whatever `main` is now, not the tree that was
published.

The commit range is the raw material, not the text. Read it and write prose:

```sh
git log --oneline v<previous>..v<version>
gh release create v<version> --draft --title "v<version>" --notes-file notes.md
gh release edit v<version> --draft=false
```

Draft first. Publishing notifies every watcher and cannot be un-sent, and the notes are
the one artifact of a release with no test that catches a wrong claim. A draft URL comes
back as `.../releases/tag/untagged-<hash>`, which is how GitHub addresses drafts and not
a sign the tag was missed; it becomes `.../tag/v<version>` when published.

- [ ] Notes describe what changed and what it means for somebody upgrading, in the shape
      the earlier releases use: the substantive change first, docs and site after,
      closing with the install line and whether anything re-enrolls or re-keys.
- [ ] Every claim in the notes is one the diff supports. `git diff --stat
      v<previous>..v<version>` is the check.
- [ ] Published, pointing at `v<version>`, and showing as Latest in `gh release list`.
