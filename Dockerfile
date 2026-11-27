# The Sapwood server, with the web app, in one image (docs/HOSTING.md).
#
# Node runs the TypeScript source as it is (type stripping), so there's no compile step: only
# the web app is built. The project lives in one SQLite file, at $SAPWOOD_DB, on a volume.

FROM node:26-slim AS build
WORKDIR /app
COPY . .
RUN npm ci --no-audit --no-fund \
 && npm run build:web \
 && npm prune --omit=dev --no-audit --no-fund

FROM node:26-slim
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production \
    PORT=8080 \
    SAPWOOD_HOST=0.0.0.0 \
    SAPWOOD_DB=/data/sapwood.sqlite
VOLUME /data
EXPOSE 8080
CMD ["node", "packages/server/src/main.ts", "serve"]
