#!/bin/sh
set -eu
repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_root"
# The recorded heap flags must not inherit unrecorded developer JVM tuning.
unset JAVA_TOOL_OPTIONS JDK_JAVA_OPTIONS _JAVA_OPTIONS
if [ "$#" -ne 1 ]; then
  echo 'Usage: ./scripts/measure-performance.sh artifacts/new-measurement-directory' >&2
  exit 2
fi
java_bin=${JAVA_HOME:+$JAVA_HOME/bin/}java
jar_path="$repo_root/backend/build/libs/ttyroom-backend.jar"
if [ ! -f "$jar_path" ]; then
  echo 'Run ./scripts/build-spring.sh first; measurements never rebuild a running JAR.' >&2
  exit 1
fi
# Refuse to overwrite evidence, including failed attempts.
mkdir -p "$(dirname -- "$1")"
mkdir "$1"
TTYROOM_PERFORMANCE_DIR=$(CDPATH= cd -- "$1" && pwd)
export TTYROOM_PERFORMANCE_DIR
TTYROOM_PERFORMANCE_MAX_HEAP=${TTYROOM_PERFORMANCE_MAX_HEAP:-2g}
export TTYROOM_PERFORMANCE_MAX_HEAP
trap 'result=$?; printf "%s\n" "$result" > "$TTYROOM_PERFORMANCE_DIR/exit-status.txt"' EXIT
cp "$jar_path" "$TTYROOM_PERFORMANCE_DIR/ttyroom-backend.jar"
TTYROOM_E2E_SERVER_COMMAND=$(node -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)))' "$java_bin" -Xms256m "-Xmx$TTYROOM_PERFORMANCE_MAX_HEAP" -jar "$TTYROOM_PERFORMANCE_DIR/ttyroom-backend.jar")
export TTYROOM_E2E_SERVER_COMMAND
node --input-type=module - "$repo_root" "$java_bin" <<'JS'
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const directory = process.env.TTYROOM_PERFORMANCE_DIR;
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const paths = git('ls-files', '-co', '--exclude-standard', '-z').split('\0').filter(Boolean);
writeFileSync(join(directory, 'manifest.json'), JSON.stringify({
  startedAt: new Date().toISOString(), revision: git('rev-parse', 'HEAD'),
  dirty: git('status', '--porcelain') !== '', node: process.version,
  java: execFileSync(process.argv[3], ['--version'], { encoding: 'utf8' }).trim(),
  jarSha256: hash(join(directory, 'ttyroom-backend.jar')),
  sourceSha256: Object.fromEntries(paths.map(path => [path, hash(path)])),
  serverJvmArguments: ['-Xms256m', '-Xmx' + process.env.TTYROOM_PERFORMANCE_MAX_HEAP], repeats: 3,
}, null, 2) + '\n');
JS
for repeat in 1 2 3; do
  ./backend/gradlew -p backend performanceTest -PperformanceDir="$TTYROOM_PERFORMANCE_DIR/adapter-$repeat" > "$TTYROOM_PERFORMANCE_DIR/adapter-$repeat.log" 2>&1
done
pnpm --filter @ttyroom/web exec playwright test --config playwright.performance.config.ts > "$TTYROOM_PERFORMANCE_DIR/browser.log" 2>&1
echo "Raw results: $TTYROOM_PERFORMANCE_DIR"
