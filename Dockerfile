FROM node:18-bullseye-slim

# Install ffmpeg, python (required for yt-dlp), and download yt-dlp
RUN apt-get update && apt-get install -y ffmpeg python3 curl wget \
    && wget https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -O /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app
COPY package*.json ./
RUN npm install

# Copy application files (excluding those in .dockerignore like the local .exe and node_modules)
COPY . .

# Expose port and start
EXPOSE 3000
CMD [ "npm", "start" ]
