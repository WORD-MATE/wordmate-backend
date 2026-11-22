FROM node:26-slim AS base
RUN npm install -g pnpm@10.34.9
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

FROM base AS build
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN pnpm build && mkdir -p /app/uploads

FROM base AS prod-deps
RUN pnpm install --frozen-lockfile --prod

FROM gcr.io/distroless/nodejs26-debian13:nonroot
WORKDIR /app
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY drizzle ./drizzle
COPY seeds ./seeds
# distroless에는 셸이 없어 미리 만든 빈 폴더를 nonroot(65532) 소유로 넣는다. 처음 붙는 named volume이 이 소유권을 이어받는다
COPY --from=build --chown=65532:65532 /app/uploads ./uploads
EXPOSE 3000
CMD ["dist/main.js"]
