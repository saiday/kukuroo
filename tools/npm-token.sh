#!/usr/bin/env bash
# Keeps the npm granular access token in the macOS login Keychain, and lends it to a
# single command through a temporary npmrc. The token never lands in ~/.npmrc, in the
# repository, in the environment of anything but the command you name, or in shell
# history. This repository is public; see .gitignore.
#
#   tools/npm-token.sh set                  # store a token (prompted, not echoed)
#   tools/npm-token.sh set < token.txt      # or from stdin, then shred the file
#   tools/npm-token.sh check                # who the stored token authenticates as
#   tools/npm-token.sh run npm publish      # run one command with the token
#   tools/npm-token.sh rm                   # forget it
#
# The token is only needed for a publish, and only if you cannot produce an OTP.
# See RELEASING.md section 1 for which kind of token works and section 9 for the release
# step this is meant for.

set -euo pipefail

SERVICE="${NPM_TOKEN_SERVICE:-npm-publish-token}"
ACCOUNT="${NPM_TOKEN_ACCOUNT:-registry.npmjs.org}"
REGISTRY="${NPM_TOKEN_REGISTRY:-registry.npmjs.org}"

die() { printf '%s\n' "$*" >&2; exit 1; }

require_macos() {
  [ "$(uname -s)" = "Darwin" ] || die "This script stores the token in the macOS Keychain, and this is not macOS.
Set NPM_TOKEN in the environment instead and use: tools/npm-token.sh run <command>"
}

read_token() {
  # NPM_TOKEN wins, so CI and non-macOS machines can use the same run subcommand.
  if [ -n "${NPM_TOKEN:-}" ]; then
    printf '%s' "$NPM_TOKEN"
    return 0
  fi
  require_macos
  security find-generic-password -s "$SERVICE" -a "$ACCOUNT" -w 2>/dev/null ||
    die "No token stored under service '$SERVICE', account '$ACCOUNT'. Run: tools/npm-token.sh set"
}

# -U updates in place rather than failing on an existing entry. -w is last and has no
# value, which is how security is told to ask for the password instead of taking it on
# the command line: "Use of the -p or -w options is insecure", per its own help.
keychain_add() {
  security add-generic-password -s "$SERVICE" -a "$ACCOUNT" -U \
    -l "npm publish token ($ACCOUNT)" \
    -j "Used by tools/npm-token.sh in the kukuroo repository." -w
}

cmd_set() {
  require_macos
  local token stored
  if [ -t 0 ]; then
    # security does the asking, and asks twice. Nothing else here ever holds the
    # token.
    keychain_add
  else
    read -r token
    [ -n "$token" ] || die "Empty token; nothing stored."
    # printf is a shell builtin, so the token stays inside this process instead of
    # becoming another process's argument. That is the whole reason for the pipe:
    # `security -w "$token"` would publish it to anything that can read the process
    # list, which its own help calls out. It reads the value twice.
    printf '%s\n%s\n' "$token" "$token" | keychain_add
  fi

  # security exits 0 after storing an empty password, which is what a mistyped
  # confirmation leaves behind, so read it back rather than trusting the status.
  stored="$(security find-generic-password -s "$SERVICE" -a "$ACCOUNT" -w 2>/dev/null || true)"
  [ -n "$stored" ] || die "Nothing was stored. The two prompts have to match, and the token cannot be empty."
  case "$stored" in
    npm_*) ;;
    *) printf 'Warning: what was stored does not start with npm_.\n' >&2 ;;
  esac

  printf 'Stored in the login Keychain: service %s, account %s\n' "$SERVICE" "$ACCOUNT" >&2
  printf 'Revoke it on npmjs.com when the release is done, then: tools/npm-token.sh rm\n' >&2
}

cmd_rm() {
  require_macos
  security delete-generic-password -s "$SERVICE" -a "$ACCOUNT" >/dev/null 2>&1 ||
    die "Nothing stored under service '$SERVICE', account '$ACCOUNT'."
  printf 'Forgotten. Revoke it on npmjs.com too, if you have not.\n' >&2
}

# Global, not local: the trap below runs after cmd_run has returned, where a local
# would already be out of scope.
TMP_NPMRC=""
cleanup() { [ -n "$TMP_NPMRC" ] && rm -f "$TMP_NPMRC"; TMP_NPMRC=""; }

cmd_run() {
  [ "$#" -gt 0 ] || die "Usage: tools/npm-token.sh run <command> [args...]"
  local token
  token="$(read_token)"

  trap cleanup EXIT INT TERM
  TMP_NPMRC="$(mktemp -t npmrc-publish)"
  chmod 600 "$TMP_NPMRC"
  printf '//%s/:_authToken=%s\n' "$REGISTRY" "$token" > "$TMP_NPMRC"

  # NPM_CONFIG_USERCONFIG replaces ~/.npmrc for this command only. A project .npmrc,
  # if one ever exists, still applies.
  NPM_CONFIG_USERCONFIG="$TMP_NPMRC" "$@"
}

cmd_check() {
  printf 'Authenticated as: ' >&2
  cmd_run npm whoami
}

case "${1:-}" in
  set)   shift; cmd_set "$@" ;;
  rm)    shift; cmd_rm "$@" ;;
  run)   shift; cmd_run "$@" ;;
  check) shift; cmd_check "$@" ;;
  *)
    sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//' >&2
    exit 1
    ;;
esac
