// ============================================================
//  downloader.js  —  YouTube Downloader (fully commented)
// ============================================================

// 'ytdl-core' is the library that talks to YouTube.
// It fetches video info and returns a readable stream.
const ytdl = require('@distube/ytdl-core');

// Node's built-in File System module.
// We use it to create a writable stream → save the file to disk.
const fs = require('fs');

// 'path' helps us build safe cross-platform file paths.
const path = require('path');

// ─────────────────────────────────────────────
//  STEP 1 ─ Validate the YouTube URL
// ─────────────────────────────────────────────
// ytdl.validateURL() returns true/false.
// Always validate before doing anything else.
function validateURL(url) {
    if (!ytdl.validateURL(url)) {
        console.error('❌  Invalid YouTube URL');
        process.exit(1);       // stop the program
    }
    console.log('✅  URL is valid');
}

// ─────────────────────────────────────────────
//  STEP 2 ─ Fetch Video Metadata
// ─────────────────────────────────────────────
// ytdl.getInfo() is an async function.
// It returns an object with title, author, duration, formats, etc.
async function fetchMetadata(url) {
    const info = await ytdl.getInfo(url);

    // videoDetails holds human-readable info
    const details = info.videoDetails;

    console.log('\n📹  Video Metadata:');
    console.log('   Title   :', details.title);
    console.log('   Author  :', details.author.name);
    console.log('   Duration:', Math.floor(details.lengthSeconds / 60), 'min',
        details.lengthSeconds % 60, 'sec');
    console.log('   Views   :', Number(details.viewCount).toLocaleString());

    return info;  // return the full info object — we'll need it later
}

// ─────────────────────────────────────────────
//  STEP 3 ─ Download and Save the Video
// ─────────────────────────────────────────────
async function downloadVideo(url, quality = 'highest') {
    // First validate the URL
    validateURL(url);

    // Fetch metadata so we can name the file after the video title
    const info = await fetchMetadata(url);

    // Sanitize the title to make it safe for file names
    // (removes characters Windows/Mac don't allow in file names)
    const title = info.videoDetails.title.replace(/[^a-z0-9 \-_\.]/gi, '_');
    const outputPath = path.join(__dirname, 'downloads', `${title}.mp4`);

    // Make sure the 'downloads' folder exists; create it if not
    fs.mkdirSync(path.join(__dirname, 'downloads'), { recursive: true });

    console.log(`\n⬇️   Downloading "${info.videoDetails.title}"...`);
    console.log(`   Saving to: ${outputPath}\n`);

    // ── Create the readable stream from ytdl ──────────────────
    // ytdl(url, options) returns a Node.js Readable stream.
    // 'quality' can be:
    //   'highest'        → best quality (video + audio)
    //   'lowest'         → smallest file
    //   'highestaudio'   → audio only
    //   a specific itag  → e.g. itag: 137 (1080p video)
    const videoStream = ytdl(url, {
        quality,                   // which quality to download
        filter: 'audioandvideo',   // only fetch formats that have BOTH audio AND video
    });

    // ── Create the writable stream (the output file) ──────────
    // fs.createWriteStream opens a file for writing.
    // Data written to it is saved to disk.
    const fileStream = fs.createWriteStream(outputPath);

    // ── Track download progress ───────────────────────────────
    // ytdl emits a 'progress' event with bytes downloaded / bytes total
    let startTime = Date.now();

    videoStream.on('progress', (chunkLength, downloaded, total) => {
        const percent = ((downloaded / total) * 100).toFixed(1);
        const elapsed = (Date.now() - startTime) / 1000;             // seconds
        const speed = (downloaded / 1024 / 1024 / elapsed).toFixed(2); // MB/s

        // \r overwrites the same line each time (gives a live progress bar feel)
        process.stdout.write(
            `   📊 ${percent}% | ${(downloaded / 1024 / 1024).toFixed(1)} MB ` +
            `of ${(total / 1024 / 1024).toFixed(1)} MB | ${speed} MB/s\r`
        );
    });

    // ── Pipe the readable stream into the writable stream ─────
    // pipe() automatically moves data from videoStream → fileStream.
    // When the download finishes, 'finish' fires on the file stream.
    videoStream.pipe(fileStream);

    // ── Wait for the download to finish ──────────────────────
    await new Promise((resolve, reject) => {
        fileStream.on('finish', resolve);   // download complete
        fileStream.on('error', reject);     // something went wrong writing
        videoStream.on('error', reject);    // something went wrong downloading
    });

    console.log('\n\n✅  Download complete!');
    console.log(`   Saved to: ${outputPath}`);
}

// ─────────────────────────────────────────────
//  STEP 4 ─ Download Audio Only
// ─────────────────────────────────────────────
async function downloadAudioOnly(url) {
    validateURL(url);
    const info = await fetchMetadata(url);

    const title = info.videoDetails.title.replace(/[^a-z0-9 \-_\.]/gi, '_');
    const outputPath = path.join(__dirname, 'downloads', `${title}.mp3`);

    fs.mkdirSync(path.join(__dirname, 'downloads'), { recursive: true });

    console.log(`\n🎵  Downloading audio only for "${info.videoDetails.title}"...`);

    // filter: 'audioonly' means only grab the audio track (no video data)
    // This is much smaller and faster than a full video download!
    const audioStream = ytdl(url, {
        quality: 'highestaudio',
        filter: 'audioonly',
    });

    const fileStream = fs.createWriteStream(outputPath);

    audioStream.on('progress', (chunkLength, downloaded, total) => {
        const percent = ((downloaded / total) * 100).toFixed(1);
        process.stdout.write(`   🎵 ${percent}%\r`);
    });

    audioStream.pipe(fileStream);

    await new Promise((resolve, reject) => {
        fileStream.on('finish', resolve);
        fileStream.on('error', reject);
        audioStream.on('error', reject);
    });

    console.log('\n✅  Audio download complete!');
    console.log(`   Saved to: ${outputPath}`);
}

// ─────────────────────────────────────────────
//  Run it!  Change the URL to any YouTube video.
// ─────────────────────────────────────────────
const VIDEO_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'; // replace with any URL

// Uncomment one of these to try it:
downloadVideo(VIDEO_URL, 'highest');
// downloadAudioOnly(VIDEO_URL);

module.exports = { validateURL, fetchMetadata, downloadVideo, downloadAudioOnly };
