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
CONFIG_COMMIT=<yoroi-config-commit-sha>

helm upgrade --install cardano-wallet-backend charts/cardano-wallet-backend \
  --set config.remoteConfig.url=https://raw.githubusercontent.com/yoroi-classic/yoroi-config/${CONFIG_COMMIT}/prod.json
```

To disable `/v1/config` explicitly:

```bash
helm upgrade --install cardano-wallet-backend charts/cardano-wallet-backend \
  --set config.remoteConfig.enabled=false
```
