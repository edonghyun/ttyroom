#!/bin/sh
set -eu
repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_root"
java_bin=${JAVA_HOME:+$JAVA_HOME/bin/}java
jar_path="$repo_root/backend/build/libs/ttyroom-backend.jar"
if [ ! -f "$jar_path" ]; then
  echo 'JAR가 없습니다. ./scripts/build-spring.sh를 먼저 실행하세요.' >&2
  exit 1
fi
exec "$java_bin" -jar "$jar_path" "$@"
