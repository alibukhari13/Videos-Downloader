import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import ytdl from "@distube/ytdl-core";
import path from "path";
import { fileURLToPath } from "url";
dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, "public")));
// In-memory cache for video info
const videoInfoCache = new Map();
const CACHE_DURATION = 10 * 60 * 1000; // 10 minutes
app.get("/api/health", (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});
app.get("/api/info", async (req, res) => {
  try {
    const url = req.query.url;
    if (!url || !url.match(/^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.?be)\/.+$/)) {
      return res.status(400).json({ error: "Invalid YouTube URL" });
    }
    // Check cache first
    const cacheKey = url;
    const cachedInfo = videoInfoCache.get(cacheKey);
    if (cachedInfo && Date.now() - cachedInfo.timestamp < CACHE_DURATION) {
      console.log(`Serving cached info for URL: ${url}`);
      return res.json(cachedInfo.data);
    }
    console.log(`Fetching info for URL: ${url}`);
   
    // Use ytdl-core to fetch video info
    const info = await ytdl.getInfo(url);
    // Get all available formats (both video and audio)
    const allFormats = info.formats
      .filter(f => f.hasVideo || f.hasAudio)
      .map(f => ({
        itag: f.itag.toString(),
        qualityLabel: f.qualityLabel || (f.hasVideo ? `${f.height}p` : 'audio'),
        hasVideo: f.hasVideo,
        hasAudio: f.hasAudio,
        container: f.container,
        bitrate: f.bitrate,
        url: f.url,
        quality: f.quality,
        audioQuality: f.audioQuality
      }));
    if (!allFormats.length) {
      console.error("No valid formats found");
      return res.status(400).json({ error: "No playable formats found for this video" });
    }
    // Remove duplicates and sort by quality
    const uniqueFormats = [];
    const seen = new Set();
   
    for (const f of allFormats) {
      const key = `${f.qualityLabel}-${f.hasAudio}-${f.hasVideo}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniqueFormats.push(f);
      }
    }
    // Sort formats: video with audio first, then video only, then audio only
    uniqueFormats.sort((a, b) => {
      // Both have video and audio
      if (a.hasVideo && a.hasAudio && b.hasVideo && b.hasAudio) {
        return (b.bitrate || 0) - (a.bitrate || 0);
      }
      // A has video and audio, B doesn't
      if (a.hasVideo && a.hasAudio) return -1;
      // B has video and audio, A doesn't
      if (b.hasVideo && b.hasAudio) return 1;
      // Both video only
      if (a.hasVideo && !a.hasAudio && b.hasVideo && !b.hasAudio) {
        return (b.bitrate || 0) - (a.bitrate || 0);
      }
      // A is video only, B is audio only
      if (a.hasVideo && !a.hasAudio) return -1;
      // B is video only, A is audio only
      if (b.hasVideo && !b.hasAudio) return 1;
      // Both audio only
      return (b.bitrate || 0) - (a.bitrate || 0);
    });
    const responseData = {
      videoId: info.videoDetails.videoId,
      title: info.videoDetails.title,
      author: info.videoDetails.author.name || "Unknown",
      lengthSeconds: parseInt(info.videoDetails.lengthSeconds) || 0,
      thumbnails: info.videoDetails.thumbnails || [],
      url: info.videoDetails.video_url,
      formats: uniqueFormats
    };
    // Cache the response
    videoInfoCache.set(cacheKey, {
      data: responseData,
      timestamp: Date.now()
    });
    res.json(responseData);
  } catch (err) {
    console.error(`Error fetching info: ${err.message}`);
    res.status(500).json({ error: `Failed to fetch video info: ${err.message}` });
  }
});
// Function to handle download
app.get("/api/download", async (req, res) => {
  try {
    const url = req.query.url;
    const itag = req.query.itag;
    if (!url || !url.match(/^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.?be)\/.+$/)) {
      return res.status(400).send("Invalid YouTube URL");
    }
    console.log(`Processing download for URL: ${url}, itag: ${itag || 'best'}`);
    // Fetch video info using ytdl-core
    const info = await ytdl.getInfo(url);
    // Clean title for safe filename
    const safeTitle = (info.videoDetails.title || "video")
      .replace(/[\\/:*?"<>|\r\n]/g, "")
      .replace(/[^\x20-\x7E]/g, "")
      .slice(0, 80);
    const filename = `${safeTitle}.mp4`;
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(filename)}"`
    );
    let selectedFormat;
    if (!itag || itag === "best") {
      // Best quality: prefer highest with audio
      selectedFormat = ytdl.chooseFormat(info.formats, {
        filter: format => format.hasVideo && format.hasAudio,
        quality: 'highest'
      });
    } else {
      selectedFormat = info.formats.find(f => f.itag == itag);
    }
    if (!selectedFormat || !selectedFormat.url) {
      console.error("Selected format not found or invalid");
      return res.status(400).send("Format not found or invalid");
    }
    console.log(`Selected format: ${selectedFormat.qualityLabel}`);
    // Pipe the video stream directly to response
    const videoStream = ytdl.downloadFromInfo(info, { format: selectedFormat });
    videoStream.pipe(res);
    videoStream.on('error', (err) => {
      console.error(`Stream error: ${err.message}`);
      if (!res.headersSent) {
        res.status(500).send("Download error");
      }
    });
    req.on('close', () => {
      videoStream.destroy();
    });
  } catch (err) {
    console.error(`Server error: ${err.message}`);
    if (!res.headersSent) {
      res.status(500).send(`Server error: ${err.message}`);
    }
  }
});

if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`YT Downloader running: http://localhost:${PORT}`);
  });
}

export default app;