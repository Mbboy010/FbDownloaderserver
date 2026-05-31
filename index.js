const express = require("express");
const cors = require("cors");
const { exec, spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(cors());
app.use(express.json());

function run(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
  });
}

// GET /api/info
app.get("/api/info", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "url is required" });
  try {
    const raw = await run(`yt-dlp --dump-json --no-playlist "${url.replace(/"/g, "")}"`);
    const info = JSON.parse(raw);
    const formats = (info.formats || [])
      .filter((f) => f.url)
      .sort((a, b) => (b.height || 0) - (a.height || 0))
      .reduce((acc, f) => {
        const label = (f.height || 0) >= 720 ? "HD" : "SD";
        if (!acc.find((x) => x.quality === label)) {
          acc.push({ quality: label, height: f.height || null, url: f.url, ext: f.ext, filesize: f.filesize || null, format_id: f.format_id });
        }
        return acc;
      }, []);
    res.json({ title: info.title || "Facebook Video", thumbnail: info.thumbnail || null, duration: info.duration || null, formats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/download — uses yt-dlp + ffmpeg to merge video+audio then stream file
app.get("/api/download", async (req, res) => {
  const { url, filename = "fb_video.mp4" } = req.query;
  if (!url) return res.status(400).json({ error: "url is required" });

  const outPath = path.join(process.env.HOME, `tmp_${Date.now()}.mp4`);

  console.log(`Downloading: ${url}`);

  try {
    // yt-dlp merges best video+audio via ffmpeg into one mp4
    await run(`yt-dlp -f "bestvideo+bestaudio/best" --merge-output-format mp4 -o "${outPath}" "${url.replace(/"/g, "")}"`);

    if (!fs.existsSync(outPath)) throw new Error("Output file not created");

    const stat = fs.statSync(outPath);
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Length", stat.size);

    const stream = fs.createReadStream(outPath);
    stream.pipe(res);
    stream.on("close", () => {
      fs.unlink(outPath, () => {});
    });
  } catch (err) {
    console.error(err.message);
    if (fs.existsSync(outPath)) fs.unlink(outPath, () => {});
    res.status(500).json({ error: err.message });
  }
});

// GET /api/health
app.get("/api/health", async (req, res) => {
  try {
    const version = await run("yt-dlp --version");
    res.json({ ok: true, yt_dlp: version });
  } catch {
    res.json({ ok: false, yt_dlp: "not installed" });
  }
});

app.listen(3001, () => console.log("✅ Server running at http://localhost:3001"));
