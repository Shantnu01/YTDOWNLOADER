FROM python:3.12-slim

# Force cache invalidation to ensure fresh build on Render
ENV CACHE_BUST=202405

# Install Node.js 20, ffmpeg, curl, and yt-dlp
RUN apt-get update && apt-get install -y curl ffmpeg wget gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && wget https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -O /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install

# Copy application files (excluding those in .dockerignore)
COPY . .

# Expose port and start
EXPOSE 3000
CMD [ "npm", "start" ]
