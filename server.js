const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const path = require("path");
const fs = require("fs/promises");
const { exec } = require("child_process");
const { promisify } = require("util");
const YTDlpWrap = require("yt-dlp-wrap").default || require("yt-dlp-wrap");

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

app.use(express.static(path.join(__dirname, "public")));

const execPromise = promisify(exec);

// yt-dlp initialization
let ytDlp;
const binaryPath = process.env.NODE_ENV === "production" ? "/tmp/yt-dlp" : "./yt-dlp";

async function initYtDlp() {
  try {
    // Check if yt-dlp binary exists
    console.log(`Checking for yt-dlp binary at ${binaryPath}`);
    await fs.access(binaryPath);
    ytDlp = new YTDlpWrap(binaryPath);
    console.log("yt-dlp initialized successfully at", binaryPath);
    // Verify yt-dlp works
    const version = await execPromise(`${binaryPath} --version`);
    console.log(`yt-dlp version: ${version.stdout.trim()}`);
  } catch (error) {
    console.error("yt-dlp binary not found or unusable:", error.message);
    if (process.env.NODE_ENV !== "production") {
      console.log("Please manually place the yt-dlp binary in the project directory and run 'chmod +x ./yt-dlp'");
      throw new Error("yt-dlp binary missing. Please add it to the project directory.");
    } else {
      console.log("Attempting to download yt-dlp for production...");
      try {
        console.log("Downloading yt-dlp from GitHub...");
        await execPromise(
          `curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o ${binaryPath} --retry 5 --retry-delay 10`
        );
        console.log("Setting executable permissions for yt-dlp...");
        await execPromise(`chmod +x ${binaryPath}`);
        ytDlp = new YTDlpWrap(binaryPath);
        console.log("yt-dlp downloaded and initialized");
        const version = await execPromise(`${binaryPath} --version`);
        console.log(`yt-dlp version: ${version.stdout.trim()}`);
      } catch (downloadError) {
        console.error("Failed to download or initialize yt-dlp:", downloadError.message);
        throw new Error(`Could not initialize yt-dlp: ${downloadError.message}`);
      }
    }
  }
}

// In-memory cache for video info
const videoInfoCache = new Map();
const CACHE_DURATION = 10 * 60 * 1000; // 10 minutes

// Convert Shorts URL to regular YouTube URL
function normalizeYouTubeUrl(url) {
  if (url.includes("youtube.com/shorts/")) {
    return url.replace("youtube.com/shorts/", "youtube.com/watch?v=");
  }
  return url;
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

app.get("/api/info", async (req, res) => {
  try {
    let url = req.query.url;
    if (!url || !url.match(/^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.?be)\/.+$/)) {
      return res.status(400).json({ error: "Invalid YouTube URL" });
    }

    // Normalize URL
    url = normalizeYouTubeUrl(url);

    // Check cache first
    const cacheKey = url;
    const cachedInfo = videoInfoCache.get(cacheKey);
    if (cachedInfo && Date.now() - cachedInfo.timestamp < CACHE_DURATION) {
      console.log(`Serving cached info for URL: ${url}`);
      return res.json(cachedInfo.data);
    }

    console.log(`Fetching info for URL: ${url}`);

    // Use yt-dlp-wrap to get video info
    const videoInfo = await ytDlp.getVideoInfo(url);

    // Filter formats to include only muxed mp4 formats (video + audio)
    const formats = videoInfo.formats
      .filter(
        (format) =>
          format.vcodec &&
          format.vcodec !== "none" &&
          format.acodec &&
          format.acodec !== "none" &&
          format.ext === "mp4" &&
          format.protocol.includes("https") // Ensure downloadable via HTTPS
      )
      .map((format) => ({
        itag: format.format_id,
        qualityLabel: format.format_note || (format.height ? `${format.height}p` : "unknown"),
        hasVideo: true,
        hasAudio: true,
        container: format.ext,
        bitrate: format.tbr || 0,
        filesize: format.filesize || null,
        url: format.url,
      }))
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0)); // Sort by bitrate (higher quality first)

    if (!formats.length) {
      throw new Error("No playable video formats with audio found");
    }

    const responseData = {
      videoId: videoInfo.id,
      title: videoInfo.title,
      author: videoInfo.uploader || "Unknown",
      lengthSeconds: videoInfo.duration || 0,
      thumbnails: videoInfo.thumbnails || [],
      url: videoInfo.webpage_url,
      formats: formats,
    };

    // Cache the response
    videoInfoCache.set(cacheKey, {
      data: responseData,
      timestamp: Date.now(),
    });

    return res.json(responseData);
  } catch (err) {
    console.error(`Error fetching info: ${err.message}`);
    let errorMsg = `Failed to fetch video info: ${err.message}`;
    if (err.message.includes("Private video")) {
      errorMsg = "Yeh video private hai aur download nahi ho sakti.";
    } else if (err.message.includes("Members-only")) {
      errorMsg = "Yeh members-only video hai aur download nahi ho sakti.";
    } else if (err.message.includes("No playable video formats")) {
      errorMsg = "Koi downloadable formats video aur audio ke saath nahi mile.";
    } else if (err.message.includes("unable to download webpage")) {
      errorMsg = "Is video tak nahi pahunch sakte. Yeh age-restricted ya aapke region mein unavailable ho sakta hai.";
    }
    res.status(500).json({ error: errorMsg });
  }
});

app.get("/api/download", async (req, res) => {
  try {
    let url = req.query.url;
    const itag = req.query.itag;

    if (!url || !url.match(/^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.?be)\/.+$/)) {
      return res.status(400).send("Invalid YouTube URL");
    }

    // Normalize URL
    url = normalizeYouTubeUrl(url);

    console.log(`Processing download for URL: ${url}, itag: ${itag || "best"}`);

    // Get video info to extract title
    const videoInfo = await ytDlp.getVideoInfo(url);

    // Clean title for safe filename
    const safeTitle = (videoInfo.title || "video")
      .replace(/[\\/:*?"<>|\r\n]/g, "_")
      .replace(/[^\x20-\x7E]/g, "_")
      .slice(0, 80);

    const filename = `${safeTitle}.mp4`;
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(filename)}"`
    );

    // Set up download options
    let formatOption = "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best"; // Prefer muxed mp4
    if (itag && itag !== "best") {
      formatOption = itag;
    }

    // Stream the download
    const execEmitter = ytDlp.exec(["-f", formatOption, "-o", "-", url, "--no-part"]);

    execEmitter.childProcess.stdout.pipe(res);

    execEmitter.on("progress", (progress) => {
      console.log(`Download progress: ${progress.percent}%`);
    });

    execEmitter.on("error", (error) => {
      console.error(`Download error: ${error}`);
      if (!res.headersSent) {
        res.status(500).send("Download error");
      }
    });

    execEmitter.on("close", (code) => {
      console.log(`Download closed with code ${code}`);
      if (code !== 0 && !res.headersSent) {
        res.status(500).send("Download failed");
      }
    });

    req.on("close", () => {
      execEmitter.childProcess.kill();
    });
  } catch (err) {
    console.error(`Server error: ${err.message}`);
    if (!res.headersSent) {
      res.status(500).send(`Server error: ${err.message}`);
    }
  }
});

// Initialize yt-dlp and start server
initYtDlp()
  .then(() => {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
      console.log(`YT Downloader running: http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Failed to initialize yt-dlp:", error);
    process.exit(1);
  });

module.exports = app;