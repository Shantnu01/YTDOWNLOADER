// ============================================================
//  server.js  —  YouTube Downloader (yt-dlp + ffmpeg)
// ============================================================
const express = require('express');
const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');

const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// Dynamic binary resolution for Windows (local) vs Linux (production)
const isWindows = process.platform === 'win32';
const YTDLP = isWindows ? path.join(__dirname, 'yt-dlp.exe') : 'yt-dlp';
const FFMPEG = isWindows ? path.join(__dirname, 'ffmpeg.exe') : 'ffmpeg';

const DOWNLOADS_DIR = path.join(__dirname, 'downloads');

// Ensure downloads directory exists
if (!fs.existsSync(DOWNLOADS_DIR)) {
    fs.mkdirSync(DOWNLOADS_DIR);
}

// Base args always passed to yt-dlp
const BASE = [
    '--ffmpeg-location', FFMPEG,
    '--no-playlist',
    '--concurrent-fragments', '16',
];

// Security Middlewares
app.use(helmet({
    contentSecurityPolicy: false, // Prevent breaking local UI fetch requests
}));
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Rate Limiting to prevent spam/DDoS on expensive endpoints
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 mins
    max: 200, // Limit each IP to 200 requests per 15 minutes
    message: { error: 'Too many requests. Please try again later.' }
});

app.use('/info', apiLimiter);
app.use('/prepare', apiLimiter);

// ─────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────
function isValidYouTubeUrl(url) {
    // Basic regex to ensure it's a YouTube domain and prevents CLI injection attempts
    const regex = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+/;
    return regex.test(url);
}

// ─────────────────────────────────────────────────────────────
//  Helper: run yt-dlp synchronously, return stdout
// ─────────────────────────────────────────────────────────────
function runYtDlp(args) {
    return new Promise((resolve, reject) => {
        execFile(YTDLP, [...BASE, ...args], { maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) return reject(new Error(stderr || err.message));
            resolve(stdout.trim());
        });
    });
}

function fmtBytes(b) {
    if (!b || b <= 0) return null;
    const mb = b / 1024 / 1024;
    return mb >= 1024 ? (mb / 1024).toFixed(2) + ' GB' : mb.toFixed(1) + ' MB';
}

// ─────────────────────────────────────────────────────────────
//  GET /info?url=<YouTube URL>
// ─────────────────────────────────────────────────────────────
app.get('/info', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'Missing URL' });
    if (!isValidYouTubeUrl(url)) return res.status(400).json({ error: 'Invalid YouTube URL' });

    try {
        const raw = await runYtDlp(['--dump-json', url]);
        const data = JSON.parse(raw);

        // 1. Find the exact M4A audio stream yt-dlp will select
        // We choose M4A because it naturally muxes into MP4 containers without FFmpeg re-encoding
        const audioFmt = (data.formats || [])
            .filter(f => f.vcodec === 'none' && f.acodec !== 'none' && f.ext === 'm4a')
            .sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];

        const audioBytes = audioFmt ? (audioFmt.filesize || audioFmt.filesize_approx || 0) : 0;

        const seenH = new Set();
        const videoFormats = [];

        (data.formats || [])
            .filter(f => f.vcodec !== 'none' && f.height && f.ext === 'mp4')
            .sort((a, b) => (b.height || 0) - (a.height || 0))
            .forEach(f => {
                const label = `${f.height}p`;
                if (!seenH.has(label)) {
                    seenH.add(label);
                    // 2. Add the exact audio size to the video size for a highly accurate estimation
                    const vidBytes = f.filesize || f.filesize_approx || 0;
                    const totalBytes = (vidBytes > 0 && audioBytes > 0) ? (vidBytes + audioBytes) : null;

                    videoFormats.push({
                        height: f.height,
                        quality: label,
                        fps: f.fps ? `${f.fps}fps` : '',
                        ext: 'auto', // Will usually be mp4 or mkv
                        size: fmtBytes(totalBytes) || 'Est. varies',
                        // Relaxed filter: prioritize mp4 if it exists for this height, otherwise accept webm
                        format_id: `bestvideo[height=${f.height}]+bestaudio/best[height<=${f.height}]`,
                    });
                }
            });

        res.json({
            title: data.title,
            author: data.uploader || data.channel || '—',
            duration: `${Math.floor((data.duration || 0) / 60)}m ${(data.duration || 0) % 60}s`,
            thumbnail: data.thumbnail,
            views: (data.view_count || 0).toLocaleString(),
            formats: videoFormats,
            audioFormat: audioFmt ? {
                format_id: 'bestaudio[ext=m4a]/bestaudio',
                quality: `${Math.round(audioFmt.abr || 0)}kbps`,
                size: fmtBytes(audioFmt.filesize || audioFmt.filesize_approx) || 'Est. varies',
            } : null,
        });
    } catch (err) {
        console.error('[/info]', err.message);
        const msg = err.message.toLowerCase();
        if (msg.includes('video unavailable') || msg.includes('incomplete') || msg.includes('not a valid')) {
            return res.status(400).json({ error: 'Check the URL' });
        }
        res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────
//  POST /prepare
//  Downloads video/audio to server disk before streaming to user.
//  This fixes ffmpeg missing video issues (which happens when piping mp4 stdout)
//  AND it enables exact file sizes allowing real pause/resume in browsers.
// ─────────────────────────────────────────────────────────────
const activeJobs = new Map();

app.post('/prepare', async (req, res) => {
    const { url, format_id, type = 'video' } = req.body;
    if (!url) return res.status(400).json({ error: 'Missing URL' });
    if (!isValidYouTubeUrl(url)) return res.status(400).json({ error: 'Invalid YouTube URL' });

    try {
        const titleRaw = await runYtDlp(['--print', 'title', url]);
        const cleanTitle = titleRaw.replace(/[^\w\s\-]/g, '_').trim() || 'video';
        const jobId = Date.now().toString() + Math.floor(Math.random() * 1000);

        // We let yt-dlp pick the best native extension (usually mkv for 4K AV1/WebM, or mp4)
        // by not specifying the extension in the output template, except for audio-only
        const tempFile = type === 'audio'
            ? path.join(DOWNLOADS_DIR, `${jobId}.mp3`)
            : path.join(DOWNLOADS_DIR, `${jobId}.%(ext)s`);

        let spawnArgs = [];

        if (type === 'audio') {
            spawnArgs = [
                ...BASE,
                '-f', 'bestaudio',
                '-x', '--audio-format', 'mp3', '--audio-quality', '0',
                '-o', tempFile,
                url,
            ];
        } else {
            // Relaxed format: allows high quality webm+opus to mux into mkv without CPU-crushing re-encoding
            const fmt = format_id || 'bestvideo+bestaudio/best';

            spawnArgs = [
                ...BASE,
                '-f', fmt,
                // Remove strict --merge-output-format to let FFmpeg auto-mux to mkv or mp4 cleanly
                '-o', tempFile,
                url,
            ];
        }
        // Save job state
        activeJobs.set(jobId, { status: 'downloading', file: tempFile, title: cleanTitle, progress: 0 });

        const proc = spawn(YTDLP, [...spawnArgs, '--newline']);

        // yt-dlp sends progress to stdout, not stderr
        proc.stdout.on('data', d => {
            const text = d.toString();
            // Match "[download]  45.3%" or "[download] 100%"
            const match = text.match(/\[download\]\s+([\d\.]+)%/);
            if (match) {
                const p = parseFloat(match[1]);
                const job = activeJobs.get(jobId);
                if (job && p > job.progress) {
                    job.progress = p;
                }
            }
        });

        // Log errors from stderr just in case
        proc.stderr.on('data', d => {
            console.error(`[yt-dlp ${jobId}]`, d.toString().trim());
        });

        proc.on('close', code => {
            const job = activeJobs.get(jobId);

            // Because we used %(ext)s in yt-dlp, we must find the exact file yt-dlp generated
            const files = fs.readdirSync(DOWNLOADS_DIR);
            const downloadedFile = files.find(f => f.startsWith(jobId + '.'));

            if (code === 0 && downloadedFile) {
                const fullPath = path.join(DOWNLOADS_DIR, downloadedFile);
                job.status = 'ready';
                job.progress = 100;
                job.file = fullPath; // Save the actual real path with extension

                setTimeout(() => {
                    if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
                    activeJobs.delete(jobId);
                }, 60 * 60 * 1000);
            } else {
                job.status = 'error';
            }
        });

        res.json({ jobId });

    } catch (err) {
        console.error('[/prepare]', err.message);
        const msg = err.message.toLowerCase();
        if (msg.includes('video unavailable') || msg.includes('incomplete') || msg.includes('not a valid')) {
            return res.status(400).json({ error: 'Check the URL' });
        }
        res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────
//  GET /status?jobId=...
// ─────────────────────────────────────────────────────────────
app.get('/status', (req, res) => {
    const { jobId } = req.query;
    const job = activeJobs.get(jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json({ status: job.status, progress: job.progress });
});

// ─────────────────────────────────────────────────────────────
//  GET /download/:jobId
//  Streams the COMPLETED file to the user using res.download.
//  Express res.download automatically supports 'Accept-Ranges'
//  so user downloads are 100% PAUSABLE and RESUMABLE!
// ─────────────────────────────────────────────────────────────
app.get('/download/:jobId', (req, res) => {
    const { jobId } = req.params;
    const job = activeJobs.get(jobId);

    if (!job || job.status !== 'ready') {
        return res.status(404).send('File not found or not ready yet.');
    }

    const filename = `${job.title}${path.extname(job.file)}`;

    // This triggers browser download WITH proper sizes and range support
    res.download(job.file, filename, (err) => {
        // We optionally delete the file immediately after sending,
        // but to support true resuming over time, it's safer to let
        // the 1-hour timeout clean it up above. Let's keep it around.
    });
});

app.listen(PORT, () => {
    console.log(`\n🚀  http://localhost:${PORT}  |  yt-dlp + ffmpeg ready\n`);
});
