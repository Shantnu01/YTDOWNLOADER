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
app.set('trust proxy', 1); // Trust Render's reverse proxy for accurate IP rate limiting
const PORT = process.env.PORT || 3000;

const ffmpegStatic = require('ffmpeg-static');

// Dynamic binary resolution for Windows (local) vs Linux (production)
const isWindows = process.platform === 'win32';
let YTDLP = isWindows ? path.join(__dirname, 'yt-dlp.exe') : path.join(__dirname, 'yt-dlp');
if (!isWindows && !fs.existsSync(YTDLP)) {
    YTDLP = 'yt-dlp'; // Use system-wide yt-dlp if local binary isn't found
}

// Prefer the static ffmpeg binary (best for Render), fallback to system ffmpeg
const FFMPEG = ffmpegStatic || 'ffmpeg';

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
    '--js-runtimes', 'node', // Fixes "No supported JavaScript runtime could be found" on Render
    '--extractor-args', 'youtube:player-client=android,web_embedded,ios', // Best bypass for "Sign in to confirm you're not a bot"
    '--quiet', '--no-warnings', // Ensure stdout is ONLY the JSON when using --dump-json
    '--no-check-certificates', // Prevent SSL errors on cloud environments
    '--prefer-free-formats',
    '--youtube-skip-dash-manifest',
];

// Security Middlewares
app.use(helmet({
    contentSecurityPolicy: false, // Prevent breaking local UI fetch requests
}));
app.use(cors());
// Limit JSON body size to prevent JSON-bomb memory exhaustion
app.use(express.json({ limit: '10kb' }));
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
function isValidYouTubeUrl(urlStr) {
    try {
        const url = new URL(urlStr);
        // Extremely strict validation against CLI injection and domain spoofing (e.g., youtube.com.hacker.com)
        return ['youtube.com', 'www.youtube.com', 'youtu.be', 'm.youtube.com'].includes(url.hostname);
    } catch (e) {
        return false;
    }
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
        if (!raw) throw new Error('Empty response from metadata server');

        let data;
        try {
            data = JSON.parse(raw);
        } catch (e) {
            console.error('[JSON Parse Error] Raw output:', raw);
            throw new Error('Could not parse video metadata. YouTube might be blocking the request.');
        }

        // 1. Find the exact M4A audio stream yt-dlp will select
        // We choose M4A because it naturally muxes into MP4 containers without FFmpeg re-encoding
        const audioFmt = (data.formats || [])
            .filter(f => f.vcodec === 'none' && f.acodec !== 'none' && f.ext === 'm4a')
            .sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];

        const audioWebm = (data.formats || [])
            .filter(f => f.vcodec === 'none' && f.acodec !== 'none' && f.ext === 'webm')
            .sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];

        const audioBytesMp4 = audioFmt ? (audioFmt.filesize || audioFmt.filesize_approx || 0) : 0;
        const audioBytesWebm = audioWebm ? (audioWebm.filesize || audioWebm.filesize_approx || 0) : 0;

        const seenH = new Set();
        const videoFormats = [];

        (data.formats || [])
            .filter(f => f.vcodec !== 'none' && (f.height || (f.resolution && f.resolution.includes('x'))) && ['mp4', 'webm'].includes(f.ext))
            .sort((a, b) => {
                const ha = a.height || parseInt((a.resolution || '0x0').split('x')[1]);
                const hb = b.height || parseInt((b.resolution || '0x0').split('x')[1]);
                return hb - ha || (b.fps || 0) - (a.fps || 0);
            })
            .forEach(f => {
                const h = f.height || parseInt((f.resolution || '0x0').split('x')[1]);
                const label = `${h}p`;
                if (!seenH.has(label)) {
                    seenH.add(label);
                    // 2. Add the exact audio size to the video size for a highly accurate estimation
                    const vidBytes = f.filesize || f.filesize_approx || 0;
                    const hasAudio = f.acodec !== 'none';
                    const fallbackAudio = f.ext === 'mp4' ? audioBytesMp4 : (audioBytesWebm || audioBytesMp4);
                    const totalBytes = hasAudio ? vidBytes : (vidBytes > 0 && fallbackAudio > 0) ? (vidBytes + fallbackAudio) : null;
                    const outExt = (f.ext === 'mp4' || hasAudio) ? 'mp4' : 'mkv';

                    videoFormats.push({
                        height: h,
                        quality: label,
                        fps: f.fps ? `${f.fps}fps` : '',
                        ext: outExt,
                        size: fmtBytes(totalBytes) || 'Est. varies',
                        format_id: hasAudio ? f.format_id : `${f.format_id}+bestaudio/best`,
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
const activeJobs = new Map();

// Load limits to prevent server meltdown (CPU/RAM exhaustion)
const MAX_CONCURRENT_DOWNLOADS = 10;
const MAX_PER_IP = 2;

let currentGlobalDownloads = 0;
const ipDownloads = new Map();

const clearIpLimits = (clientIp, jobId) => {
    if (activeJobs.has(jobId) && activeJobs.get(jobId).limitsCleared) return;
    currentGlobalDownloads = Math.max(0, currentGlobalDownloads - 1);
    const nc = (ipDownloads.get(clientIp) || 1) - 1;
    if (nc <= 0) ipDownloads.delete(clientIp);
    else ipDownloads.set(clientIp, nc);
    if (activeJobs.has(jobId)) activeJobs.get(jobId).limitsCleared = true;
};

app.post('/prepare', async (req, res) => {
    const { url, format_id, type = 'video' } = req.body;
    const clientIp = req.ip || req.connection.remoteAddress;

    if (!url) return res.status(400).json({ error: 'Missing URL' });
    if (!isValidYouTubeUrl(url)) return res.status(400).json({ error: 'Invalid YouTube URL' });

    // 1. Check Load Limits before spawning yt-dlp
    if (currentGlobalDownloads >= MAX_CONCURRENT_DOWNLOADS) {
        return res.status(503).json({ error: 'Server is at maximum capacity. Please try again in a few minutes.' });
    }
    const currentIpCount = ipDownloads.get(clientIp) || 0;
    if (currentIpCount >= MAX_PER_IP) {
        return res.status(429).json({ error: 'You have reached the maximum number of concurrent downloads (2).' });
    }

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

        // Increment load counters
        currentGlobalDownloads++;
        ipDownloads.set(clientIp, currentIpCount + 1);

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
            clearIpLimits(clientIp, jobId); // Free up slot immediately!
            const job = activeJobs.get(jobId);
            if (!job) return;

            // Because we used %(ext)s in yt-dlp, we must find the exact file yt-dlp generated
            const files = fs.readdirSync(DOWNLOADS_DIR);
            const downloadedFileFiles = files.filter(f => f.startsWith(jobId + '.') && !f.includes('.temp.') && !f.endsWith('.part') && !f.includes('.f'));
            const downloadedFile = downloadedFileFiles[0];

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
        // Find if we already incremented but threw an error
        if (typeof jobId !== 'undefined' && activeJobs.has(jobId)) {
            clearIpLimits(clientIp, jobId);
        }
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

    // Ensure title has no characters that crash node header parsing
    const safeTitle = job.title.replace(/[^\w\s\-\.]/g, '_').trim() || 'video';
    const filename = `${safeTitle}${path.extname(job.file)}`;

    // Explicitly set the encoded Content-Disposition to prevent UUID fallback in Chromium browsers
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}; filename="${encodeURIComponent(filename)}"`);

    // This triggers browser download WITH proper sizes and range support
    res.sendFile(job.file, (err) => {
        // We optionally delete the file immediately after sending,
        // but to support true resuming over time, it's safer to let
        // the 1-hour timeout clean it up above. Let's keep it around.
    });
});

app.listen(PORT, () => {
    console.log(`\n🚀  http://localhost:${PORT}  |  yt-dlp + ffmpeg ready\n`);
});
