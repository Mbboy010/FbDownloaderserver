const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { exec } = require("child_process");
const path = require("path");
const fs = require("fs");

const app = express();

// ==========================================
// 1. GLOBAL MIDDLEWARES
// ==========================================

// Basic security headers
app.use(helmet({
  crossOriginResourcePolicy: false, // Allows cross-origin image requests for thumbnails
}));

// Cross-Origin Resource Sharing
app.use(cors());

// Body Parsers
app.use(express.json());


// ==========================================
// 2. CUSTOM MIDDLEWARES & RATE LIMITERS
// ==========================================

// Rate limiter for fetching video info (Lightweight endpoint)
const infoLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 30, // Limit each IP to 30 requests per minute
  message: { error: "Too many info requests. Please try again shortly." }
});

// Rate limiter for heavy downloads (Protects server RAM/CPU from overload)
const downloadLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 10, // Limit each IP to 10 downloads per 5 minutes
  message: { error: "Download quota reached. Please wait a few minutes before downloading more videos." }
});

// Custom Input Validation Middleware (Sanitizes and checks URLs)
function validateUrlQuery(req, res, next) {
  const { url } = req.query;
  
  if (!url) {
    return res.status(400).json({ error: "URL parameter is required." });
  }

  // Basic regex rule checking if it looks like a valid url scheme
  const urlRegex = /^(https?:\/\/)?([\da-z.-]+)\.([a-z.]{2,6})([\/\w .-]*)*\/?.*$/;
  if (!urlRegex.test(url)) {
    return res.status(400).json({ error: "Invalid URL format provided." });
  }

  // Escape quotation marks to mitigate command injection risks
  req.sanitizedUrl = url.replace(/"/g, '\\"').replace(/`/g, '');
  
  next(); // URL is safe, proceed to the endpoint controller
}


// ==========================================
// 3. UTILITY FUNCTIONS
// ==========================================
function run(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
  });
}

async function ensureDependencies() {
  try {
    await run("yt-dlp --version");
    console.log("✅ yt-dlp is ready");
  } catch {
    console.log("⏳ Installing yt-dlp...");
    try { await run("pip install yt-dlp"); } 
    catch { try { await run("pip3 install yt-dlp"); } catch {
      await run("curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && chmod a+rx /usr/local/bin/yt-dlp");
    }}
  }
}


// ==========================================
// 4. ENDPOINTS (WITH APPLIED MIDDLEWARE)
// ==========================================

// GET /api/info
// Applies: infoLimiter (rate limit) -> validateUrlQuery (validation)
app.get("/api/info", infoLimiter, validateUrlQuery, async (req, res) => {
  try {
    // Note: Using req.sanitizedUrl instead of raw query string
    const raw = await run(`yt-dlp --dump-json --no-playlist "${req.sanitizedUrl}"`);
    const info = JSON.parse(raw);

    const seen = new Set();
    const formats = (info.formats || [])
      .filter((f) => f.url && f.height && f.width && f.vcodec !== "none")
      .sort((a, b) => (b.height || 0) - (a.height || 0))
      .reduce((acc, f) => {
        const key = `${f.width}x${f.height}`;
        if (!seen.has(key)) {
          seen.add(key);
          let label = "Low";
          if (f.height >= 1080) label = "Full HD";
          else if (f.height >= 720) label = "HD";
          else if (f.height >= 480) label = "SD";
          
          acc.push({
            label,
            resolution: `${f.height}p`,
            dimensions: `${f.width}x${f.height}`,
            width: f.width,
            height: f.height,
            fps: f.fps || null,
            format_id: f.format_id,
            has_audio: f.acodec !== "none",
            filesize_mb: f.filesize ? `${(f.filesize / (1024 * 1024)).toFixed(1)} MB` : "Unknown",
          });
        }
        return acc;
      }, []);

    res.json({
      title: info.title || "Video",
      thumbnail: info.thumbnail || null,
      duration_str: info.duration ? `${Math.floor(info.duration / 60)}:${String(info.duration % 60).padStart(2, "0")}` : null,
      formats,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/download
// Applies: downloadLimiter (heavy rate limit) -> validateUrlQuery (validation)
app.get("/api/download", downloadLimiter, validateUrlQuery, async (req, res) => {
  const { format_id, type } = req.query;

  const tmpDir = fs.existsSync("/tmp") ? "/tmp" : process.env.HOME || __dirname;
  const isMp3 = type === "mp3";
  const ext = isMp3 ? "mp3" : "mp4";
  const filename = req.query.filename || `download.${ext}`;
  const outPath = path.join(tmpDir, `media_${Date.now()}.${ext}`);

  let cmd;
  if (isMp3) {
    cmd = `yt-dlp -f "bestaudio" --extract-audio --audio-format mp3 -o "${outPath}" "${req.sanitizedUrl}"`;
  } else {
    const formatArg = format_id ? `"${format_id}+bestaudio/${format_id}"` : `"bestvideo+bestaudio/best"`;
    cmd = `yt-dlp -f ${formatArg} --merge-output-format mp4 --postprocessor-args "-movflags +faststart" -o "${outPath}" "${req.sanitizedUrl}"`;
  }

  try {
    await run(cmd);

    if (!fs.existsSync(outPath)) throw new Error("File not created by backend processing.");
    const stat = fs.statSync(outPath);
    if (stat.size < 1000) throw new Error("Download was corrupted or too short.");

    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Type", isMp3 ? "audio/mpeg" : "video/mp4");
    res.setHeader("Content-Length", stat.size);
    res.setHeader("Accept-Ranges", "bytes");

    const stream = fs.createReadStream(outPath);
    
    stream.on("error", (e) => {
      console.error("❌ Stream error:", e.message);
      res.status(500).end();
    });

    stream.on("close", () => {
      fs.unlink(outPath, () => console.log("🗑️ Local temporary media file cleaned"));
    });

    stream.pipe(res);

  } catch (err) {
    console.error("❌ Error execution:", err.message);
    if (fs.existsSync(outPath)) fs.unlink(outPath, () => {});
    res.status(500).json({ error: err.message });
  }
});

// GET /api/health
// Public checking route - no complex validations needed, but standard global middlewares still apply
app.get("/api/health", async (req, res) => {
  try {
    const ytVersion = await run("yt-dlp --version");
    let ffmpegOk = true;
    try { await run("ffmpeg -version"); } catch { ffmpegOk = false; }
    res.json({ ok: true, yt_dlp: ytVersion, ffmpeg_installed: ffmpegOk });
  } catch {
    res.json({ ok: false, yt_dlp: "not installed" });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
  console.log(`✅ Server securely running at port: ${PORT}`);
  await ensureDependencies();
});
