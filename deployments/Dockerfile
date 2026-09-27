# Build and run one Epoch service.
#   docker build -f deployments/Dockerfile --build-arg APP=api_app -t epoch/api .
ARG APP=api_app

FROM node:22-bookworm-slim AS build
ARG APP
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile --ignore-scripts --filter "@epoch/${APP}..."
RUN pnpm --filter "@epoch/${APP}..." build
RUN pnpm --filter "@epoch/${APP}" deploy --prod --legacy /out

FROM node:22-bookworm-slim
ARG APP
ENV NODE_ENV=production
WORKDIR /srv
COPY --from=build /out ./
USER node
CMD ["node", "dist/index.js"]
