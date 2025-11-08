# apps/bun-worker/Dockerfile
FROM oven/bun:1.1.20

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install

COPY . .

CMD ["bun", "run", "start"]
