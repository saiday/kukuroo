# Releasing Kukuroo

Maintainer-facing. Not shipped in the tarball; `package.json` `files` does not list it.

Work top to bottom. Anything that fails is a stop, not a note to self: this package
generates keys that cannot be rotated and enrolls devices that cannot be repaired from
another origin, so a bad release costs somebody their subscriptions rather than a patch.

## 1. Repo state

```sh
git switch main && git pull
git status --short              # must be clean
git log $(git describe --tags --abbrev=0)..HEAD --oneline
```

- [ ] Clean tree, on `main`, synced with origin.
- [ ] Read the commit list above. It is the changelog and it decides the next number.

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
npm whoami                      # must not 401
npm publish --dry-run
npm publish
git tag v<version> && git push origin main --tags
```

- [ ] Logged in as the maintainer.
- [ ] Tag pushed, and it matches the published version.
- [ ] `npx kukuroo@latest init --help` works from a directory with no checkout.
