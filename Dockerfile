FROM node:20-bullseye-slim

# No apt packages needed: the chess engine runs in the browser via the vendored
# WASM build in public/engine/ (committed to the repo). The server never spawns
# a system stockfish binary, so we skip apt entirely — which also avoids Debian
# oldstable mirror churn breaking the build.

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV PORT=10000
EXPOSE 10000

CMD ["node", "server.js"]
