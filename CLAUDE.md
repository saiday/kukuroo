# Pull Requests

- Write PR titles, summaries, and descriptions in English.

# Releasing

`RELEASING.md` is the procedure, and it is not optional reading before a publish. Two
things it is easy to get wrong from the outside:

- A publish credential never goes in `~/.npmrc` or anywhere in the repo. `tools/npm-token.sh`
  is the only path to one, and `tools/` is outside `files` in `package.json` so it does
  not ship.
- The git tag names the commit the tarball was built from, which is not always `main`.
