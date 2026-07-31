FROM node:18-bullseye

# Install Python + pip and ffmpeg; install yt-dlp via pip
RUN apt-get update \
  && apt-get install -y python3 python3-pip ffmpeg --no-install-recommends \
  && pip3 install --no-cache-dir yt-dlp \
  && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy package manifests first for cached installs
COPY package.json package-lock.json* ./
RUN npm install --production --silent

# Copy remaining sources
COPY . .

ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "index.js"]
