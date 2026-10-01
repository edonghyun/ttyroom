FROM node:22-bookworm-slim
RUN corepack enable && corepack prepare pnpm@10.10.0 --activate
WORKDIR /workspace
COPY . .
RUN pnpm install --frozen-lockfile --ignore-scripts \
    && pnpm --filter @ttyroom/protocol build
USER node
ENTRYPOINT ["./benchmarks/node_modules/.bin/tsx"]
CMD ["benchmarks/src/docker-smoke.ts"]
