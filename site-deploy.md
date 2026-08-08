# How the landing page ships

`site/` is the whole landing page: one `index.html`, no build step, no dependencies. It
is served by **Cloudflare Pages** at <https://kukuroo.cc>, deployed by Cloudflare's Git
integration. There is no deploy workflow in `.github/workflows/` on purpose. Pushing to
`main` is the deploy.

## The gate this replaced

The old GitHub Pages workflow was `workflow_dispatch`-only so the page could not go live
before `npm install kukuroo` worked. Git integration has no such gate: once the project
is connected, every push to `main` publishes. That was fine to give up, because the
condition it was guarding is met: `kukuroo@0.1.0` went to npm on 2026-08-08, so the
quickstart on the page is a promise the registry keeps.

What is left of the gate is worth remembering the next time the page makes a claim ahead
of the code. There is nothing between an edit to `site/index.html` and the public
internet except the push.

## One-time setup

Cloudflare dashboard, Workers & Pages, Create, Pages, Connect to Git:

| Field | Value |
| --- | --- |
| Repository | `saiday/kukuroo` |
| Production branch | `main` |
| Framework preset | None |
| Build command | *(empty)* |
| Build output directory | `site` |

Then Custom domains, Set up a custom domain, `kukuroo.cc`. The zone is already in the
account, so Cloudflare writes the DNS record and issues the certificate itself; nothing
to add by hand. Add `www.kukuroo.cc` the same way if you want it, and it will redirect.

The project also answers on `kukuroo.pages.dev`, and every branch and PR gets its own
preview URL. Those previews are public: they are the same public HTML, so that costs
nothing, but it is worth knowing before pushing a draft of the page to a branch.
