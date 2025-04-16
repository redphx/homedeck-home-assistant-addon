FROM oven/bun:1.2.9 AS build

COPY web /app/web
WORKDIR /app/web

RUN bun install
RUN bun run build

EXPOSE 4663

CMD ["bun", "run", "server.ts"]
