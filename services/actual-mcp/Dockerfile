# Classic-builder compatible: Synology's Docker has no BuildKit, so no ADD --checksum.
FROM node:24.11.1-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends git python3 make g++ ca-certificates curl && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL -o /tmp/upstream.tar.gz https://codeload.github.com/s-stefanov/actual-mcp/tar.gz/16c9274ab4a4370bafb529ff4e20200e5217cbfd \
 && echo "defd622c94361b771e32b257212d0d971406cddb63dbc4149218a5561175630c  /tmp/upstream.tar.gz" | sha256sum -c -
WORKDIR /app
RUN tar -xzf /tmp/upstream.tar.gz --strip-components=1 && rm /tmp/upstream.tar.gz
COPY upstream.patch /tmp/upstream.patch
RUN git apply /tmp/upstream.patch
COPY package.json package-lock.json ./
COPY secrets.ts finance.test.ts ./src/integrations/actual/
RUN npm ci && npm run build && npx vitest run src/integrations/actual/finance.test.ts && npx eslint src/index.ts src/integrations/actual/connection.ts src/integrations/actual/secrets.ts src/integrations/actual/finance.test.ts src/resources.ts src/prompts.ts src/tools/index.ts src/utils/response.ts && npm prune --omit=dev

FROM node:24.11.1-bookworm-slim
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json /app/LICENSE ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/build ./build
RUN useradd --uid 1026 --gid 100 --home-dir /data --no-create-home actual-mcp
USER 1026:100
EXPOSE 3000
ENTRYPOINT ["node", "build/index.js"]
CMD ["--sse", "--enable-bearer", "--enable-write"]
