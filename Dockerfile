# Build stage: the full toolchain, none of which ships.
FROM node:26-slim AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY . .
RUN npm run build

# Production dependencies, resolved here so npm itself never has to exist in the runtime image.
FROM node:26-slim AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev

# Runtime
FROM node:26-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Two changes here, both of which the image scan found rather than a hunch.
#
# 1. Patch the base image. `node:25-slim` is rebuilt on its own schedule, so between rebuilds it
#    carries Debian packages with fixes already published: at the time of writing, five HIGH and
#    CRITICAL advisories against libgnutls30 alone, all of them fixed upstream and none of them
#    fixed in the tag. Upgrading costs a layer and closes them.
#
# 2. Remove npm and corepack. They are build tools, and nothing at runtime invokes them: the
#    container runs `node dist/index.js`. But the npm that ships inside the node image vendors its
#    own dependency tree, and that tree had two more HIGH advisories (picomatch, sigstore) that we
#    can neither patch nor pin, because they are not our dependencies. Deleting the package manager
#    from a production image is the correct answer regardless of the CVEs: it is a smaller image,
#    and one fewer thing that can execute arbitrary code from a lockfile.
RUN apt-get update \
  && apt-get upgrade -y --no-install-recommends \
  && rm -rf /var/lib/apt/lists/* \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

# package.json comes along because the service reads its version from it (src/version.ts), rather
# than duplicating the number into a constant that will eventually be wrong.
COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

EXPOSE 3010
USER node
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3010)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
