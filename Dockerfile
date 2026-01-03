# Dockerfile — Live Eval Chess (Render)
# Installs Stockfish so `spawn("stockfish")` works.

FROM node:20-bullseye-slim

# Install stockfish (native binary) + minimal CA certs
RUN apt-get update \
  && apt-get install -y --no-install-recommends stockfish ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first (better layer caching)
COPY package*.json ./
RUN npm install --omit=dev

# Copy app source
COPY . .

# Render provides PORT; default to 10000 for local
ENV PORT=10000
EXPOSE 10000

# Start server
CMD ["node", "server.js"]

