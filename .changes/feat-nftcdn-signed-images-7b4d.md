### Added

- Signed NFTCDN media URLs for native assets. `POST /v1/assets/media` returns a signed, resized
  image URL (and a metadata URL) for up to 100 asset fingerprints in one call; `GET
/v1/assets/{fingerprint}/image?size=` 302s to the signed URL for a single asset.
- Until now `/v1/assets/info` handed clients the raw on-chain image URI, usually `ipfs://`, which
  is not renderable without a gateway and not sized: an NFT gallery would pull a hundred
  full-resolution originals onto a phone.
- The signing key never leaves the backend. A client holding it could be decompiled within the
  hour, and whoever pulled the key could serve their own bandwidth on our account.
- A requested size is rounded **up** to one NFTCDN actually serves (it serves powers of two; the
  Yoroi apps ask for 720, which is not one), and the response reports the size actually served.
- Configured with `NFTCDN_SUBDOMAIN` and `NFTCDN_KEY`, both or neither. Without them the media
  routes answer `503 FEATURE_UNAVAILABLE`, naming the fallback, and every other endpoint works.
