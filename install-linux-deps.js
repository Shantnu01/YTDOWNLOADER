const fs = require('fs');
const https = require('https');
const path = require('path');
const { execSync } = require('child_process');

// Only run on Linux (Render) natively, not on local Windows dev environment where yt-dlp.exe is used
if (process.platform === 'linux') {
    const ytdlpPath = path.join(__dirname, 'yt-dlp');
    const url = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux';

    console.log('🐧 Linux environment detected. Downloading yt-dlp binary for Render...');

    const file = fs.createWriteStream(ytdlpPath);
    https.get(url, (response) => {
        if (response.statusCode === 301 || response.statusCode === 302) {
            // Handle redirect
            https.get(response.headers.location, (redirectResponse) => {
                redirectResponse.pipe(file);
                file.on('finish', () => {
                    file.close();
                    console.log('✅ yt-dlp downloaded!');
                    // Make it executable on Linux
                    execSync(`chmod +x ${ytdlpPath}`);
                    console.log('✅ chmod +x applied to yt-dlp');
                });
            }).on('error', (err) => {
                fs.unlink(ytdlpPath, () => { });
                console.error('❌ Error downloading yt-dlp from redirect:', err.message);
            });
        } else {
            response.pipe(file);
            file.on('finish', () => {
                file.close();
                console.log('✅ yt-dlp downloaded!');
                // Make it executable on Linux
                execSync(`chmod +x ${ytdlpPath}`);
                console.log('✅ chmod +x applied to yt-dlp');
            });
        }
    }).on('error', (err) => {
        fs.unlink(ytdlpPath, () => { });
        console.error('❌ Error downloading yt-dlp:', err.message);
    });
} else {
    console.log('💻 Not running on Linux. Skipping yt-dlp linux binary download.');
}
