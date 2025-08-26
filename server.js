import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import ytdl from "@distube/ytdl-core";
import { spawn } from "child_process";
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

    // Extract video formats (only MP4 video formats)
    const videoFormats = info.formats
      .filter(f => f.hasVideo && f.mimeType.startsWith("video/mp4"))
      .map(f => ({
        itag: f.itag.toString(),
        qualityLabel: f.qualityLabel || `${f.height}p`,
        hasVideo: true,
        hasAudio: f.hasAudio,
        container: "mp4",
        bitrate: f.bitrate,
        url: f.url
      }));

    if (!videoFormats.length) {
      console.error("No valid MP4 video formats found");
      return res.status(400).json({ error: "No playable video formats found for this video" });
    }

    // Remove duplicates and sort by quality (high to low)
    const uniqueFormats = [];
    const seen = new Set();
    
    for (const f of videoFormats) {
      const key = f.qualityLabel;
      if (!seen.has(key)) {
        seen.add(key);
        uniqueFormats.push(f);
      }
    }

    uniqueFormats.sort((a, b) => {
      const getQualityNum = (str) => parseInt(str) || 0;
      return getQualityNum(b.qualityLabel) - getQualityNum(a.qualityLabel);
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

// Function to handle streaming/download with merging if needed
async function streamVideo(req, res, isDownload) {
  try {
    const url = req.query.url;
    const itag = req.query.itag;

    if (!url || !url.match(/^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.?be)\/.+$/)) {
      return res.status(400).send("Invalid YouTube URL");
    }

    console.log(`Processing ${isDownload ? 'download' : 'stream'} for URL: ${url}, itag: ${itag || 'best'}`);

    // Fetch video info using ytdl-core
    const info = await ytdl.getInfo(url);

    // Clean title for safe filename
    const safeTitle = (info.videoDetails.title || "video")
      .replace(/[\\/:*?"<>|\r\n]/g, "")
      .replace(/[^\x20-\x7E]/g, "")
      .slice(0, 80);

    const filename = `${safeTitle}.mp4`;

    res.setHeader('Content-Type', 'video/mp4');

    if (isDownload) {
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${encodeURIComponent(filename)}"`
      );
    }

    let selectedFormat;

    if (!itag || itag === "best") {
      // Best quality: prefer highest with audio, else highest video
      selectedFormat = ytdl.chooseFormat(info.formats, { filter: 'videoandaudio', quality: 'highest' }) ||
                       ytdl.chooseFormat(info.formats, { filter: 'videoonly', quality: 'highestvideo' });
    } else {
      selectedFormat = info.formats.find(f => f.itag == itag);
    }

    if (!selectedFormat || !selectedFormat.url) {
      console.error("Selected format not found or invalid");
      return res.status(400).send("Format not found or invalid");
    }

    console.log(`Selected format: ${selectedFormat.qualityLabel}, hasAudio: ${selectedFormat.hasAudio}`);

    if (selectedFormat.hasAudio) {
      // Direct stream if has audio
      const videoStream = ytdl.downloadFromInfo(info, { format: selectedFormat });
      videoStream.pipe(res);

      videoStream.on('error', (err) => {
        console.error(`Stream error: ${err.message}`);
        if (!res.headersSent) {
          res.status(500).send("Download/stream error");
        }
      });

      req.on('close', () => {
        videoStream.destroy();
      });
    } else {
      // Merge audio if no audio in format
      let audioFormats = info.formats.filter(f => f.hasAudio && !f.hasVideo && f.mimeType.startsWith('audio/mp4'));
      let audioCodec = 'copy';

      if (!audioFormats.length) {
        audioFormats = info.formats.filter(f => f.hasAudio && !f.hasVideo);
        audioCodec = 'aac';
      }

      if (!audioFormats.length) {
        console.error("No suitable audio format found");
        return res.status(400).send("No suitable audio format found");
      }

      audioFormats.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      const bestAudio = audioFormats[0];

      console.log(`Merging video (${selectedFormat.qualityLabel}) with audio (bitrate: ${bestAudio.bitrate})`);

      const ffmpegArgs = [
        '-i', selectedFormat.url,
        '-i', bestAudio.url,
        '-c:v', 'copy',
        '-c:a', audioCodec,
        '-f', 'mp4',
        '-movflags', 'frag_keyframe+empty_moov+faststart',
        'pipe:1'
      ];

      const ffmpeg = spawn('ffmpeg', ffmpegArgs);

      ffmpeg.stdout.pipe(res);

      ffmpeg.stderr.on('data', (data) => {
        console.error(`ffmpeg stderr: ${data.toString()}`);
      });

      ffmpeg.on('error', (err) => {
        console.error(`ffmpeg error: ${err.message}`);
        if (!res.headersSent) {
          res.status(500).send("FFmpeg error");
        }
      });

      ffmpeg.on('close', (code) => {
        if (code !== 0) {
          console.error(`ffmpeg exited with code ${code}`);
        }
      });

      req.on('close', () => {
        ffmpeg.kill();
      });
    }

  } catch (err) {
    console.error(`Server error: ${err.message}`);
    if (!res.headersSent) {
      res.status(500).send(`Server error: ${err.message}`);
    }
  }
};

app.get("/api/download", (req, res) => streamVideo(req, res, true));

app.get("/api/stream", (req, res) => streamVideo(req, res, false));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`YT Downloader running: http://localhost:${PORT}`);
});