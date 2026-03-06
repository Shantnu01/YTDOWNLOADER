# YouTube Downloader

A high-performance, resumable YouTube video downloader built with Node.js, Express, yt-dlp, and FFmpeg.

## 🚀 How It Works (The Architecture)

This downloader is designed to bypass the common issues of JavaScript-based YouTube libraries (like `ytdl-core`) breaking constantly, and to provide the highest possible quality (up to 4K) with perfect pause/resume support.

### The Problem with Standard Downloaders
1. **Broken Signatures:** YouTube constantly changes its video player signatures, breaking pure-JS libraries.
2. **Missing Audio in 1080p+:** YouTube distributes high-quality video (1080p, 4K) as *separate* video and audio streams. 
3. **Broken Resume:** If you pipe video data directly from a process to the browser, the browser doesn't know the final file size, so it can't resume the download if the connection drops.

### Our Solution
1. **yt-dlp:** We use `yt-dlp.exe` (a constantly updated, community-driven Python tool) instead of npm packages. It extracts the raw streams reliably.
2. **FFmpeg:** For 1080p+ videos, `yt-dlp` downloads the best video stream and best audio stream simultaneously, and then uses `ffmpeg.exe` to professionally merge them into a single `.mp4` file.
3. **The `/prepare` -> `/download` Flow:** 
   - Instead of streaming the merged video "on the fly" to the browser (which breaks seeking and resuming), the Node server downloads the complete, perfect `.mp4` file to its own disk (the `downloads/` folder) first.
   - The frontend polls the server for progress.
   - Once the server finishes building the file, it redirects the browser to download it. Express automatically supports byte-range requests (`Accept-Ranges`), making the final download to your computer **100% resumable!**

---

## 🛠️ Tech Stack & Components

### Backend (`server.js`)
- **Node.js & Express:** The lightweight web server managing the API endpoints.
- **`child_process.execFile` / `spawn`:** Used to run the `yt-dlp.exe` and `ffmpeg.exe` binary files natively in the background.
- **Endpoints:**
  - `GET /info?url=...` 
    Runs `yt-dlp --dump-json` to fetch video metadata, thumbnail, duration, and all available resolutions (from 144p to 4K).
  - `POST /prepare` 
    Triggers the download/merge job on the server. Saves state to an in-memory map.
  - `GET /status?jobId=...` 
    Returns live progress (0-100%) by parsing the `yt-dlp` output.
  - `GET /download/:jobId` 
    Streams the finished file from the server's disk to the user's browser securely.

### Frontend (`public/index.html`)
- **Vanilla HTML/CSS/JS:** No React or heavy frameworks.
- **Glassmorphism UI:** Modern, dark-themed design using CSS blur and gradient background orbs.
- **Dynamic Fetching:** Auto-fetches video info when a URL is pasted.
- **Progress Tracking:** Polls the `/status` endpoint every 1 second to show a smooth animated progress bar while the server prepares the 4K file.

### Required Binaries
- **`yt-dlp.exe`**: The core extraction engine. Handles downloading parallel fragments (`--concurrent-fragments 16`) for extreme speed.
- **`ffmpeg.exe`**: The video processing engine. Used to extract audio (to MP3) and merge separate video/audio streams into MP4s.

---

## ⚡ Speed Optimizations

The server is configured with:
- `--concurrent-fragments 16`: YouTube serves videos in tiny chunks. This flag opens 16 parallel connections to download chunks simultaneously, heavily multiplexing the download speed.
- `--buffer-size 16K`: Optimizes the memory buffer for I/O operations.

---

## 📂 Project Structure

```
YT downlaoder/
├── server.js              # The main Node API and Express server
├── yt-dlp.exe             # The download engine binary
├── ffmpeg.exe             # The video merging/conversion binary
├── package.json           # Node project config (dependencies: express)
├── public/
│   └── index.html         # The frontend user interface
└── downloads/             # Temporary folder where server prepares videos
```

> **Note:** Files in the `downloads/` folder are automatically tracked and deleted by the server 1 hour after they finish downloading, to keep the server's hard drive clean.
