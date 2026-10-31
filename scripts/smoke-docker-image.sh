#!/usr/bin/env sh

set -eu

image="${DOCKER_IMAGE:-cardano-wallet-backend:ci}"
container="cardano-wallet-backend-smoke-${GITHUB_RUN_ID:-local}-$$"
max_attempts=30

cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
}

trap cleanup EXIT
trap 'exit 1' HUP INT TERM

probe_health() {
  docker exec "$container" node -e '
    fetch("http://127.0.0.1:" + (process.env.PORT || 3010) + "/health", {
      signal: AbortSignal.timeout(500),
    })
      .then(async response => {
        const body = await response.json();
        const keys =
          body !== null && typeof body === "object" && !Array.isArray(body)
            ? Object.keys(body)
            : [];
        const valid =
          response.status === 200 &&
          keys.length === 2 &&
          body.status === "ok" &&
          body.service === "cardano-wallet-backend";
        if (!valid) {
          throw new Error(
            "unexpected /health response: " + response.status + " " + JSON.stringify(body),
          );
        }
      })
      .catch(error => {
        console.error(error.message);
        process.exit(1);
      });
  '
}

docker run --detach --name "$container" "$image" >/dev/null

attempt=1
while [ "$attempt" -le "$max_attempts" ]; do
  if probe_health >/dev/null 2>&1; then
    echo "Docker image health contract passed for $image"
    exit 0
  fi

  if [ "$(docker inspect --format '{{.State.Running}}' "$container" 2>/dev/null || true)" != "true" ]; then
    break
  fi

  attempt=$((attempt + 1))
  sleep 1
done

probe_health || true
docker logs "$container" >&2 || true
echo "Docker image did not serve the expected /health contract after $max_attempts attempts" >&2
exit 1
