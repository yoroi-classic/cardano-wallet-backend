# cardano-wallet-backend Helm chart

This chart deploys `cardano-wallet-backend` with defaults that match the local Docker Compose
preprod setup: Koios provider, preprod network, port `3010`, and `/health` probes.

## Render and lint

```bash
helm lint charts/cardano-wallet-backend
helm template cardano-wallet-backend charts/cardano-wallet-backend
```

## Local install

Build an image into your local cluster or point `image.repository` and `image.tag` at an existing
registry image, then install:

```bash
helm upgrade --install cardano-wallet-backend charts/cardano-wallet-backend \
  --set image.repository=cardano-wallet-backend \
  --set image.tag=local
```

## Install from GHCR

Releases of this chart are published as OCI artifacts under
`oci://ghcr.io/yoroi-classic/charts/cardano-wallet-backend`. Pin the chart version and provide an
image that your cluster can pull:

```bash
helm upgrade --install cardano-wallet-backend \
  oci://ghcr.io/yoroi-classic/charts/cardano-wallet-backend \
  --version 0.1.1 \
  --set image.repository=YOUR_IMAGE_REPOSITORY \
  --set image.tag=YOUR_IMAGE_TAG
```

GitHub creates the package as private on its first publication. A package administrator must make
`charts/cardano-wallet-backend` public in the Yoroi Classic organization package settings before
the anonymous install above works. Until then, authenticate with a classic personal access token
that has `read:packages`:

```bash
export GHCR_USERNAME=YOUR_GITHUB_USERNAME
read -rs GHCR_TOKEN
export GHCR_TOKEN
echo "$GHCR_TOKEN" | helm registry login ghcr.io \
  --username "$GHCR_USERNAME" \
  --password-stdin
unset GHCR_TOKEN
```

The publication workflow refuses to reuse a version it can already see in GHCR, and PR checks
require `Chart.yaml`'s version to increase whenever packaged chart content changes. GHCR does not
itself make container tags immutable.

Expose it locally:

```bash
kubectl port-forward svc/cardano-wallet-backend 3010:80
curl http://127.0.0.1:3010/health
```

## Secrets

The chart does not create secrets. To use optional Koios or NFTCDN credentials, create a secret and
point the chart at it:

```bash
install -m 600 /dev/null ./cardano-wallet-backend-secrets.env
$EDITOR ./cardano-wallet-backend-secrets.env

kubectl create secret generic cardano-wallet-backend-secrets \
  --from-env-file=./cardano-wallet-backend-secrets.env

helm upgrade --install cardano-wallet-backend charts/cardano-wallet-backend \
  --set secrets.existingSecret=cardano-wallet-backend-secrets
```

## Remote config

By default the chart does not render `CONFIG_URL`, so the app uses its built-in
`yoroi-classic/yoroi-config` default. To serve a pinned config URL:

```bash
CONFIG_COMMIT=YOUR_COMMIT_SHA

helm upgrade --install cardano-wallet-backend charts/cardano-wallet-backend \
  --set config.remoteConfig.url=https://raw.githubusercontent.com/yoroi-classic/yoroi-config/${CONFIG_COMMIT}/prod.json
```

To disable `/v1/config` explicitly:

```bash
helm upgrade --install cardano-wallet-backend charts/cardano-wallet-backend \
  --set config.remoteConfig.enabled=false
```
