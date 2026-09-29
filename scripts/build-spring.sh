#!/bin/sh
set -eu
repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_root"

pnpm --filter @ttyroom/connector... build
pnpm --filter @ttyroom/web build
exec ./backend/gradlew -p backend test bootJar -PwebDist=../web/dist "$@"
