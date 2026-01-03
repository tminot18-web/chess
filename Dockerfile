FROM node:20-bullseye-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends stockfish ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Stockfish on Debian often lands in /usr/games
ENV PATH="/usr/games:/usr/local/games:${PATH}"

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Hard verify at build time (will fail build if missing)
RUN which stockfish && stockfish -help >/dev/null 2>&1 || true

ENV PORT=10000
EXPOSE 10000

CMD ["node", "server.js"]
