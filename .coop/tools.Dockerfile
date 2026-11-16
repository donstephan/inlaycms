# Same Node build as the repo's own Dockerfile, so native modules
# (better-sqlite3, sharp) installed into the tree match the compose image.
FROM node:24-bookworm-slim AS node

FROM coop-tools:base

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
# Keep in step with "packageManager" in package.json
RUN npm install -g pnpm@12.16.1

RUN apt-get update && apt-get install -y --no-install-recommends \
        sqlite3 \
    && rm -rf /var/lib/apt/lists/*
