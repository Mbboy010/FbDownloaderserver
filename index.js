const express = require("express");
const cors = require("cors");
const { exec } = require("child_process");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(cors());
app.use(express.json());

// Helper to run shell commands
function run(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
  });
}

// Ensure dependencies are installed
async function ensureDependencies() {
  // Check yt-dlp
  try {
    await run("yt-dlp --version");
    console.log("✅ yt-dlp is ready");
  } catch {
    console.log("⏳ Installing yt-dlp...");
    try { 
      await run("pip install yt-dlp"); 
    } catch { 
      try { 
        await run("pip3 install yt-dlp"); 
      } catch {
        await run("curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && chmod a+rx /usr/local/bin/yt-dlp");
      }
    }
  }

  // Check FFmpeg (CRITICAL for merging high-res video and audio)
  try {
    await run("ffmpeg -version");
    console.log("✅ ffmpeg is installed and ready");
  } catch {
    console.warn("⚠️  WARNING: ffmpeg is MISSING! High-resolution downloads (1080p+) will fail because yt-dlp needs ffmpeg to merge video and audio streams. Please install ffmpeg on your server.");
  }
}

// GET /api/info — Fetch available qualities
app.get("/api/info", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "url is required" });

  try {
    // Fetch JSON dump from yt-dlp
    const raw = await run(`yt-dlp --dump-json --no-playlist "${url.replace(/"/g, "")}"`);
    const info = JSON.parse(raw);

    const seen = new Set();
    const formats = (info.formats || [])
      // Filter for formats that actually have video
      .filter((f) => f.url && f.height && f.width && f.vcodec !== "none")
      .sort((a, b) => (b.height || 0) - (a.height || 0))
      .reduce((acc, f) => {
        // Group by resolution to avoid duplicates of the same quality
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
            has_audio: f.acodec !== "none", // Useful for the frontend to know
            filesize_mb: f.filesize ? `${(f.filesize/(1024*1024)).toFixed(1)} MB` : "Unknown",
          });
        }
        return acc;
      }, []);

    res.json({
      title: info.title || "Video",
      thumbnail: info.thumbnail || null,
      duration_str: info.duration ? `${Math.floor(info.duration/60)}:${String(info.duration%60).padStart(2,"0")}` : null,
      formats,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/download — Download specific format and serve
app.get("/api/download", async (req, res) => {
  const { url, format_id, filename = "video.mp4" } = req.query;
  if (!url) return res.status(400).json({ error: "url is required" });

  const tmpDir = fs.existsSync("/tmp") ? "/tmp" : process.env.HOME || __dirname;
  const outPath = path.join(tmpDir, `vid_${Date.now()}.mp4`);

  console.log(`⏳ Downloading format: ${format_id || "best"}...`);

  // Safe fallback: Try requested video + best audio. If requested format already has audio, just use requested format.
  const formatArg = format_id
    ? `"${format_id}+bestaudio/${format_id}"`
    : `"bestvideo+bestaudio/best"`;

  try {
    // Download and merge via yt-dlp
    await run(
      `yt-dlp -f ${formatArg} --merge-output-format mp4 --postprocessor-args "-movflags +faststart" -o "${outPath}" "${url.replace(/"/g, "")}"`
    );

    if (!fs.existsSync(outPath)) throw new Error("File not created by yt-dlp");
    const stat = fs.statSync(outPath);
    if (stat.size < 1000) throw new Error("File too small, download likely failed");

    console.log(`✅ Downloaded: ${(stat.size / (1024*1024)).toFixed(1)} MB`);

    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Length", stat.size);
    res.setHeader("Accept-Ranges", "bytes");

    const stream = fs.createReadStream(outPath);

    stream.on("error", (e) => {
      console.error("❌ Stream error:", e.message);
      res.status(500).end();
    });

    stream.on("close", () => {
      fs.unlink(outPath, () => console.log("🗑️ Temp file cleaned"));
    });

    stream.pipe(res);

  } catch (err) {
    console.error("❌ Error:", err.message);
    if (fs.existsSync(outPath)) fs.unlink(outPath, () => {});
    res.status(500).json({ error: err.message });
  }
});

// GET /api/health
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

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});