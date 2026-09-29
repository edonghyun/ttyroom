#!/bin/sh
set -eu
repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_root"
suite=${1:-}
case "$suite" in
  protocol|browser|registration|authentication) shift ;;
  *) echo 'Usage: ./scripts/test-spring.sh protocol|browser|registration|authentication [test arguments...]' >&2; exit 2 ;;
esac
java_bin=${JAVA_HOME:+$JAVA_HOME/bin/}java
jar_path="$repo_root/backend/build/libs/ttyroom-backend.jar"
if [ ! -f "$jar_path" ]; then
  echo 'JAR가 없습니다. ./scripts/build-spring.sh를 먼저 실행하세요.' >&2
  exit 1
fi
TTYROOM_E2E_SERVER_COMMAND=$(node -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)))' "$java_bin" -jar "$jar_path")
export TTYROOM_E2E_SERVER_COMMAND
case "$suite" in
  protocol) exec pnpm --filter @ttyroom/e2e test:e2e "$@" ;;
  registration) exec pnpm --filter @ttyroom/e2e exec vitest run --config vitest.registration.config.ts "$@" ;;
  authentication) exec pnpm --filter @ttyroom/e2e exec vitest run --config vitest.authentication.config.ts "$@" ;;
  browser) exec pnpm --filter @ttyroom/web exec playwright test "$@" ;;
esac
