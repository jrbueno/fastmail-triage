# ── Stage 1: build the radiosilence/fastmail-cli engine (Rust) ───────────────
FROM rust:1-slim AS engine
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN cargo install --git https://github.com/radiosilence/fastmail-cli --root /engine

# ── Stage 2: the Bun app ─────────────────────────────────────────────────────
FROM oven/bun:1 AS app
WORKDIR /app

# Engine binary from stage 1
COPY --from=engine /engine/bin/fastmail-cli /usr/local/bin/fastmail-cli

# Install deps first for layer caching
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src/ src/

# Config + per-account engine tokens live here; mount a volume to persist.
ENV FASTMAIL_TRIAGE_HOME=/data
VOLUME ["/data"]

ENTRYPOINT ["bun", "run", "src/cli.ts"]
CMD ["--help"]
