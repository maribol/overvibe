#!/usr/bin/env bash
# Public release [T1112-123]: github.com/maribol/overvibe is its own history, fed by exports of this repo.
#
#   bun run release              dry run: export, privacy scan, diff stat; nothing is committed or pushed
#   bun run release -- --push    the same, then commit 'Overvibe <version>', tag v<version>, push main and the tag
#
# Options: --clone <dir> (default ~/scratchpad/agent-deck/release/public), --remote <url>
# (default git@github-maribol:maribol/overvibe.git).
#
# The clone is this script's own scratch copy: it is reset to origin/main on every run, so never keep work in it.
set -euo pipefail

PUSH=0
CLONE="$HOME/scratchpad/agent-deck/release/public"
REMOTE="git@github-maribol:maribol/overvibe.git"
EXCLUDE=(TASKS.md CLAUDE.md .cursor src/private src/web/private)

while [ $# -gt 0 ]; do
  case "$1" in
    --push) PUSH=1 ;;
    --clone) CLONE="$2"; shift ;;
    --remote) REMOTE="$2"; shift ;;
    -h|--help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "release: unknown option $1" >&2; exit 2 ;;
  esac
  shift
done

die() { echo "release: STOP: $*" >&2; exit 1; }

SRC="$(git rev-parse --show-toplevel)"
cd "$SRC"

# 1. a clean tree, so the export is exactly a commit
[ -z "$(git status --porcelain)" ] || die "the working tree has uncommitted changes; commit them first"
SHA="$(git rev-parse --short HEAD)"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"

# 2. version: package.json and desktop/package.json must agree
VERSION="$(bun -e 'console.log(require("./package.json").version)')"
DESKTOP="$(bun -e 'console.log(require("./desktop/package.json").version)')"
[ -n "$VERSION" ] || die "no version in package.json"
[ "$VERSION" = "$DESKTOP" ] || die "package.json is $VERSION but desktop/package.json is $DESKTOP"
TAG="v$VERSION"
MSG="Overvibe $VERSION"
echo "release: $MSG from $SHA ($BRANCH)"

# 3. the tag must not exist on the public repo yet
if git ls-remote --exit-code --tags "$REMOTE" "refs/tags/$TAG" >/dev/null 2>&1; then
  die "$TAG already exists on $REMOTE; bump the version in package.json and desktop/package.json"
fi

# 4. clone or update the public clone, back to origin/main exactly
if [ ! -d "$CLONE/.git" ]; then
  mkdir -p "$(dirname "$CLONE")"
  git clone -q "$REMOTE" "$CLONE"
else
  url="$(git -C "$CLONE" remote get-url origin)"
  [ "$url" = "$REMOTE" ] || die "$CLONE has origin $url, expected $REMOTE"
  git -C "$CLONE" fetch -q --tags --prune --prune-tags origin
fi
reset_clone() {
  git -C "$CLONE" checkout -q -B main origin/main
  git -C "$CLONE" reset -q --hard origin/main
  git -C "$CLONE" clean -qfdx
  git -C "$CLONE" tag -d "$TAG" >/dev/null 2>&1 || true # a leftover from a failed run
}
reset_clone

# 5. replace the tracked files with git archive HEAD minus the excluded ones
git -C "$CLONE" rm -rq --ignore-unmatch .
find "$CLONE" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
git archive HEAD | tar -x -C "$CLONE"
for x in "${EXCLUDE[@]}"; do rm -rf "${CLONE:?}/$x"; done
git -C "$CLONE" add -A -f .

# 6. the export must equal HEAD minus the excluded files (same paths, modes and blobs)
fmt='%(objectmode) %(objectname) %(path)'
excl_re="^[^ ]+ [^ ]+ ($(IFS='|'; echo "${EXCLUDE[*]}" | sed 's/\./\\./g'))(/.*)?$"
want="$(git ls-tree -r --full-tree --format="$fmt" HEAD | grep -vE "$excl_re" | sort)"
got="$(git -C "$CLONE" ls-files --format="$fmt" | sort)"
if [ "$want" != "$got" ]; then
  diff <(echo "$want") <(echo "$got") | head -20 >&2
  die "the export differs from HEAD minus ${EXCLUDE[*]}"
fi
echo "release: export = HEAD minus ${EXCLUDE[*]} ($(echo "$got" | wc -l | tr -d ' ') files)"

# 7. privacy scan of the export and the commit message
if ! bun "$SRC/scripts/releasescan.ts" "$CLONE" --message "$MSG"; then
  reset_clone
  die "the privacy scan found the hits above; fix them in this repo, commit, and run again"
fi

echo "release: changes against public main:"
git -C "$CLONE" diff --cached --stat | tail -25

if [ "$PUSH" != 1 ]; then
  reset_clone
  echo "release: dry run, nothing committed or pushed. Run with --push to release $TAG."
  exit 0
fi

# 8. commit as this repo's git user, plain message, no trailers, no hooks
NAME="$(git config user.name)"; EMAIL="$(git config user.email)"
[ -n "$NAME" ] && [ -n "$EMAIL" ] || die "git user.name / user.email are not set"
git -C "$CLONE" -c user.name="$NAME" -c user.email="$EMAIL" -c commit.template= \
  commit -q --no-verify --cleanup=verbatim -m "$MSG"
body="$(git -C "$CLONE" log -1 --format=%B)"
[ "$body" = "$MSG" ] || { reset_clone; die "the commit message came out as '$body'"; }
git -C "$CLONE" tag "$TAG"
PUB="$(git -C "$CLONE" rev-parse --short HEAD)"

# 9. push main and the tag
git -C "$CLONE" push -q origin main "refs/tags/$TAG"
echo "release: pushed $MSG to $REMOTE (public $PUB, tag $TAG, from $SHA)"
