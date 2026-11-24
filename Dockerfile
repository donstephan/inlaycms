# The build stage runs on the builder's own platform: it only produces dist/ and assets/, which are plain JavaScript.
FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS build
# Keep in step with "packageManager" in package.json
RUN npm install -g pnpm@12.16.1
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY docker/image/package.json docker/image/
# better-sqlite3 ships prebuilt binaries and pnpm-workspace.yaml turns off build scripts, so no compiler is needed.
# --ignore-scripts skips our own "prepare" build, which needs the sources copied below.
RUN --mount=type=cache,id=pnpm,target=/root/.pnpm-store pnpm install --frozen-lockfile --ignore-scripts --store-dir /root/.pnpm-store
COPY . .
RUN pnpm run build

# What the image runs, installed on the image's own platform (some dependencies ship a binary per platform) and only
# from pnpm-lock.yaml, with no install scripts: nothing here is resolved afresh when the image is built. The package
# folder is the workspace root, so its production dependencies land in its own node_modules. docker/image lists what
# the image needs beside them: fastify (a peer dependency), and typescript and @types/node for `inlaycms pack`.
FROM node:24-bookworm-slim AS deps
# Keep in step with "packageManager" in package.json
RUN npm install -g pnpm@12.16.1
WORKDIR /opt/inlaycms/node_modules/inlaycms
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml LICENSE README.md ./
COPY docker/image/package.json docker/image/
RUN --mount=type=cache,id=pnpm-image,target=/root/.pnpm-store \
    pnpm install --prod --frozen-lockfile --ignore-scripts --store-dir /root/.pnpm-store
COPY --from=build /app/dist dist
COPY --from=build /app/assets assets
# Beside the package, as an install from the registry would lay them out: what docker/image lists, and the commands.
RUN cd /opt/inlaycms/node_modules \
    && mkdir @types .bin \
    && ln -s inlaycms/docker/image/node_modules/fastify fastify \
    && ln -s inlaycms/docker/image/node_modules/typescript typescript \
    && ln -s ../inlaycms/docker/image/node_modules/@types/node @types/node \
    && chmod +x inlaycms/dist/adapters/cli/bin.js \
    && ln -s ../inlaycms/dist/adapters/cli/bin.js .bin/inlaycms \
    && ln -s ../typescript/bin/tsc .bin/tsc \
    && test -e fastify/package.json -a -e typescript/bin/tsc -a -e @types/node/package.json

# The Inlay image: the host (`inlaycms serve`, the default) and the whole CLI, with TypeScript for `inlaycms pack`.
# /node_modules lets a site mounted anywhere resolve `inlaycms`; docker/inlaycms is the host-side wrapper.
FROM node:24-bookworm-slim
WORKDIR /opt/inlaycms
COPY --from=deps /opt/inlaycms/node_modules node_modules
RUN ln -s /opt/inlaycms/node_modules /node_modules && mkdir /data && chown node:node /data
COPY docker/inlaycms wrapper/inlaycms
USER node
ENV PATH=/opt/inlaycms/node_modules/.bin:$PATH INLAY_DATA_DIR=/data
VOLUME /data
EXPOSE 3000
CMD ["inlaycms", "serve"]
