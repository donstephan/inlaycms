FROM node:24-bookworm-slim AS build
# Keep in step with "packageManager" in package.json
RUN npm install -g pnpm@12.16.1
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# better-sqlite3 ships prebuilt binaries and pnpm-workspace.yaml turns off build scripts, so no compiler is needed.
# --ignore-scripts skips our own "prepare" build, which needs the sources copied below.
RUN --mount=type=cache,id=pnpm,target=/root/.pnpm-store pnpm install --frozen-lockfile --ignore-scripts --store-dir /root/.pnpm-store
COPY . .
RUN pnpm run build && pnpm pack --out /tmp/inlaycms.tgz

# The Inlay image: the host (`inlaycms serve`, the default) and the whole CLI, with TypeScript for `inlaycms pack`.
# /node_modules lets a site mounted anywhere resolve `inlaycms`; docker/inlaycms is the host-side wrapper.
FROM node:24-bookworm-slim
WORKDIR /opt/inlaycms
COPY --from=build /tmp/inlaycms.tgz /tmp/
RUN --mount=type=cache,id=npm-serve,target=/root/.npm \
    npm install --omit=dev --no-audit --no-fund /tmp/inlaycms.tgz typescript@7 @types/node@24 \
    && rm /tmp/inlaycms.tgz && ln -s /opt/inlaycms/node_modules /node_modules \
    && mkdir /data && chown node:node /data
COPY docker/inlaycms wrapper/inlaycms
USER node
ENV PATH=/opt/inlaycms/node_modules/.bin:$PATH INLAY_DATA_DIR=/data
VOLUME /data
EXPOSE 3000
CMD ["inlaycms", "serve"]
