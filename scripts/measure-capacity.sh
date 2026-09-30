#!/bin/sh
set -eu
repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_root"
unset JAVA_TOOL_OPTIONS JDK_JAVA_OPTIONS _JAVA_OPTIONS
if [ "$#" -ne 1 ] || [ -z "${JAVA_HOME:-}" ]; then
  echo 'Usage: JAVA_HOME=/path/to/jdk21 ./scripts/measure-capacity.sh artifacts/new-directory' >&2
  exit 2
fi
TTYROOM_CAPACITY_PROFILE=${TTYROOM_CAPACITY_PROFILE:-full}
case "$TTYROOM_CAPACITY_PROFILE" in smoke|full|recovery|admission|credentials) ;; *) echo 'Unknown capacity profile' >&2; exit 2 ;; esac
export TTYROOM_CAPACITY_PROFILE
mkdir -p "$(dirname -- "$1")"
mkdir "$1"
TTYROOM_CAPACITY_DIR=$(CDPATH= cd -- "$1" && pwd)
export TTYROOM_CAPACITY_DIR
trap 'result=$?; printf "%s\n" "$result" > "$TTYROOM_CAPACITY_DIR/exit-status.txt"' EXIT
cp backend/build/libs/ttyroom-backend.jar "$TTYROOM_CAPACITY_DIR/ttyroom-backend.jar"
"$JAVA_HOME/bin/jfr" configure --input none --output "$TTYROOM_CAPACITY_DIR/capacity.jfc" \
  +jdk.CPULoad#enabled=true +jdk.CPULoad#period=1s \
  +jdk.GarbageCollection#enabled=true +jdk.GCHeapSummary#enabled=true +jdk.DataLoss#enabled=true \
  +ttyroom.ControlQueueWait#enabled=true +ttyroom.BufferPressure#enabled=true > "$TTYROOM_CAPACITY_DIR/jfr-configure.log"
node --input-type=module <<'JS'
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
const dir = process.env.TTYROOM_CAPACITY_DIR;
const git = (...args) => execFileSync('git', args, {encoding:'utf8'}).trim();
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const paths = git('ls-files','-co','--exclude-standard','-z').split('\0').filter(Boolean);
writeFileSync(join(dir,'manifest.json'),JSON.stringify({startedAt:new Date().toISOString(),revision:git('rev-parse','HEAD'),dirty:git('status','--porcelain')!=='',profile:process.env.TTYROOM_CAPACITY_PROFILE,node:process.version,java:execFileSync(join(process.env.JAVA_HOME,'bin/java'),['--version'],{encoding:'utf8'}).trim(),jvmArguments:['-Xms256m','-Xmx512m','-XX:+UseG1GC'],jarSha256:hash(join(dir,'ttyroom-backend.jar')),jfcSha256:hash(join(dir,'capacity.jfc')),sourceSha256:Object.fromEntries(paths.map(p=>[p,hash(p)]))},null,2)+'\n');
JS
runner=src/performance/capacity-run.ts
if [ "$TTYROOM_CAPACITY_PROFILE" = admission ]; then runner=src/performance/admission-run.ts; fi
if [ "$TTYROOM_CAPACITY_PROFILE" = credentials ]; then runner=src/performance/credential-run.ts; fi
pnpm --filter @ttyroom/e2e exec tsx "$runner" > "$TTYROOM_CAPACITY_DIR/run.log" 2>&1
