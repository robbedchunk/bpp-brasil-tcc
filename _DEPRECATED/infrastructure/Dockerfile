# Stage 1: Base
FROM node:20-alpine AS base
WORKDIR /app
COPY package.json pnpm-lock.yaml* turbo.json pnpm-workspace.yaml ./

RUN npm install -g pnpm turbo

# Stage 2: Development
FROM base AS development
WORKDIR /app
COPY apps/api/package.json ./apps/api/package.json
COPY packages/*/package.json ./packages/*/package.json
RUN pnpm install
CMD ["sh", "-c", "pnpm run seed && pnpm run start:dev"]
RUN mkdir -p /app/apps/api/dist && chmod -R 777 /app/apps/api/dist

COPY . .
EXPOSE 3000
CMD ["pnpm", "--filter", "api", "run", "start:dev"]
