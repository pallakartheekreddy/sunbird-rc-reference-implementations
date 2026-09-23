#!/usr/bin/env bash
#
# Imports the Paradym Wallet fork into vendor/paradym-wallet as a reviewable
# history: one commit carrying the pristine upstream tree, then each showcase
# commit replayed on top with its original author, date and message.
#
# That shape is the whole point. `git log -p vendor/paradym-wallet` then shows
# exactly what the showcase changed and nothing of upstream's 3,000 commits, and
# the vendored tree at the replay tip is byte-identical to the fork — provable by
# comparing tree hashes, see the tail of this script.
#
# It is a script rather than a one-off shell session because taking a later
# upstream fix is the same operation with a newer base:
#
#   ./scripts/vendor-wallet.sh --base <new-upstream-sha> --tip <new-fork-tip>
#
# Extraction is `git archive`, which emits only blobs tracked at that commit.
# There is no exclude list to get wrong: node_modules, the Expo prebuild output,
# .expo, build directories, the APK and any keystore are all untracked in the
# source and therefore structurally unreachable from here.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SRC="${WALLET_FORK_PATH:-$ROOT/../paradym-wallet}"
PREFIX="vendor/paradym-wallet"
BASE="2d68168863dd8e78f883b752f420dc46aa2d7108"   # animo/paradym-wallet main
TIP="f9bdb83"                                     # fork tip on branch v1.0.3
UPSTREAM_REPO="https://github.com/animo/paradym-wallet"
FORK_REPO="pallakartheekreddy/paradym-wallet"

while [ $# -gt 0 ]; do
  case "$1" in
    --source) SRC="$2"; shift 2 ;;
    --base)   BASE="$2"; shift 2 ;;
    --tip)    TIP="$2";  shift 2 ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done

die() { printf '\n  %s\n\n' "$1" >&2; exit 1; }

[ -d "$SRC/.git" ] || die "no wallet fork at $SRC — pass --source or set WALLET_FORK_PATH"
git diff --quiet && git diff --cached --quiet || die "commit or stash your changes first"

# Each replay step clears the directory so that commits which DELETE files
# replay correctly — git archive only ever overlays. With pnpm's hoisted linker
# an install here is several gigabytes, so refuse rather than remove it.
[ -e "$PREFIX/node_modules" ] && die "$PREFIX/node_modules exists; this script removes $PREFIX on each step. Delete the install yourself if you meant to re-import."

PATCHES="$(mktemp -d)"
trap 'rm -rf "$PATCHES"' EXIT

# --binary matters: the design commits touch PNGs, and without it format-patch
# writes a "Binary files differ" stub that cannot be applied.
git -C "$SRC" format-patch --binary --no-signature -o "$PATCHES" "$BASE..$TIP" >/dev/null
COUNT="$(find "$PATCHES" -name '*.patch' | wc -l | tr -d ' ')"
printf 'importing %s: base %s + %s showcase commits\n' "$PREFIX" "${BASE:0:7}" "$COUNT"

rm -rf "$PREFIX"
mkdir -p "$PREFIX"
git -C "$SRC" archive --format=tar "$BASE" | tar -x -C "$PREFIX"
git add -A "$PREFIX"
git commit -q -F - <<MSG
vendor: import the Paradym Wallet at animo/paradym-wallet@${BASE:0:7} (Apache-2.0)

Anand asked for the wallet code to live in this repository. Until now the
showcase depended on a sibling checkout, so the changes it relies on — the trust
lookup fix, the showcase trust entries and the decline notification — were
invisible to anyone reviewing this branch.

Nothing in this commit is ours. It is the upstream tree at $UPSTREAM_REPO
commit $BASE, verbatim, extracted with git archive so
that only tracked files come across: no .git, no node_modules, no Expo prebuild
output, no build artefacts.

Apache-2.0, Copyright 2023-present Animo Solutions. LICENSE is retained at the
root of the vendored tree and in packages/sdk. The $COUNT commits that follow are the
fork's own, replayed with their original authorship; NOTICE and
SUNBIRD-CHANGES.md then record what changed and who changed it.
MSG

for p in "$PATCHES"/*.patch; do
  git am --directory="$PREFIX" --keep-non-patch "$p" >/dev/null \
    || die "failed to replay $(basename "$p") — 'git am --abort' then investigate"
  printf '  replayed  %s\n' "$(git log --format='%h %an: %s' -1)"
done

printf '\n%s\n' 'verifying the import is byte-identical to the fork'
WANT="$(git -C "$SRC" rev-parse "$TIP^{tree}")"
GOT="$(git rev-parse "HEAD:$PREFIX")"
printf '  fork tree      %s\n  vendored tree  %s\n' "$WANT" "$GOT"
[ "$WANT" = "$GOT" ] || die "tree hashes differ — the vendored copy is NOT the fork"
printf '  identical.\n\n  %s files, %s\n' \
  "$(git ls-files "$PREFIX" | wc -l | tr -d ' ')" "$(du -sh "$PREFIX" | cut -f1)"
