#!/bin/sh
# The throwaway Home Chat stack for verification: its own compose project and data volume, never anyone's real one.
# Usage: stack.sh up | doctor | run <command...> | data <file> | down
set -eu
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
# Both beat .env, whose COMPOSE_FILE would add the public tunnel on home-macmini. Every docker compose call below, and
# in the commands `run` starts, targets this project.
export COMPOSE_PROJECT_NAME=home-chat-verify COMPOSE_FILE=compose.yaml
origin=http://127.0.0.1:8787
state=.local/verify/stack.env

fail() { echo "FAIL $*" >&2; exit 1; }

doctor() {
  [ -f "$state" ] || fail "no $state, so this run did not start the stack; run stack.sh up"
  . "./$state"
  app=$(docker compose ps -q app)
  [ -n "$app" ] || fail "the app container of $COMPOSE_PROJECT_NAME is not running"
  health=$(docker inspect -f '{{.State.Health.Status}}' "$app")
  [ "$health" = healthy ] || fail "the app container is $health"
  [ "$(docker inspect -f '{{.Image}}' "$app")" = "$IMAGE" ] || fail "the app runs another image than stack.sh up built"
  owner=$(docker ps --filter publish=8787 --format '{{.Label "com.docker.compose.project"}}')
  [ "$owner" = "$COMPOSE_PROJECT_NAME" ] || fail "port 8787 belongs to '${owner:-nothing}', not $COMPOSE_PROJECT_NAME"
  curl -fsS "$origin/" | grep -q '<title>Home Chat</title>' || fail "$origin/ is not the Home Chat page"
  # A real owner sign-in, then sign-out so repeated checks don't use up the server's 16 sessions. The code goes through
  # pipes only, never argv, a file or the log.
  jar=$(mktemp)
  trap 'rm -f "$jar"' EXIT
  docker compose exec -T --user 10001:10001 app node scripts/show-access.ts owner \
    | node -e 'process.stdout.write(JSON.stringify({code: require("fs").readFileSync(0, "utf8").trim()}))' \
    | curl -fsS -c "$jar" -o /dev/null -H "Origin: $origin" -H 'Content-Type: application/json' --data-binary @- "$origin/api/login" \
    || fail "owner sign-in with the stack's access code failed"
  me=$(curl -fsS -b "$jar" "$origin/api/me") || fail "/api/me refused the new session"
  csrf=$(printf '%s' "$me" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0, "utf8")).csrf)')
  codex=$(printf '%s' "$me" | node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(0, "utf8")).codexConfigured))')
  curl -fsS -b "$jar" -o /dev/null -H "Origin: $origin" -H "X-CSRF-Token: $csrf" -H 'Content-Type: application/json' \
    --data '{}' "$origin/api/logout" || fail "sign-out failed"
  echo "OK $COMPOSE_PROJECT_NAME at $origin, built from $REV, owner sign-in works, Codex signed in: $codex"
}

case "${1:-}" in
  up)
    taken=$(docker ps --filter publish=8787 --format '{{.Names}}')
    [ -z "$taken" ] || fail "port 8787 is already published by: $taken. Every Home Chat stack uses that port and the 172.30.91.0/28 subnet, so one runs per machine. If it is home-chat-verify from an earlier run, run stack.sh down; otherwise it is not ours, so stop and ask"
    # A stopped stack or a kept volume would bring back an earlier run's lists, notes and Codex login.
    [ -z "$(docker compose ps -a -q)$(docker volume ls -q --filter "name=${COMPOSE_PROJECT_NAME}_chat-data")" ] \
      || fail "$COMPOSE_PROJECT_NAME has containers or a volume left from an earlier run; run stack.sh down first"
    mkdir -p .local/verify
    docker compose up -d --build --wait --wait-timeout 300
    dirty=$(git status --porcelain | grep -q . && echo -dirty || true)
    printf 'REV=%s\nIMAGE=%s\n' "$(git rev-parse --short HEAD)$dirty" "$(docker inspect -f '{{.Image}}' "$(docker compose ps -q app)")" > "$state"
    doctor ;;
  doctor) doctor ;;
  run) shift; exec "$@" ;;
  # Read-only look at a file on the stack's data volume, such as todos.json, memory.json or routines.json.
  data) docker compose exec -T --user 10001:10001 app cat "/data/$2" ;;
  down)
    docker compose down -v --remove-orphans
    rm -f "$state"
    echo "Removed $COMPOSE_PROJECT_NAME with its volume; evidence stays in .local/verify/" ;;
  *) fail "usage: stack.sh up | doctor | run <command...> | data <file> | down" ;;
esac
