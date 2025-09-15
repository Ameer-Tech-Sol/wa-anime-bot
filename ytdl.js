// ytdl.js  (ESM)
// Minimal YouTube → direct MP4 resolver via RapidAPI (YouTube Info & Download API)

const BASE = process.env.YTDL_API_BASE_URL;   // https://youtube-info-download-api.p.rapidapi.com
const HOST = process.env.YTDL_API_HOST;       // youtube-info-download-api.p.rapidapi.com
const KEY  = process.env.YTDL_API_KEY;        // your X-RapidAPI-Key

function assertEnv() {
  if (!BASE || !HOST || !KEY) {
    throw new Error("YTDL env missing: set YTDL_API_BASE_URL, YTDL_API_HOST, YTDL_API_KEY in .env");
  }
}

/**
 * Get best MP4 link for a given YouTube URL.
 * Strategy:
 *   1) Hit /info to list formats.
 *   2) Pick the best progressive MP4 (video+audio) (prefer <=1080p, else highest available).
 *   3) Fallback: call /ajax/download.php with format=mp4.
 * Returns: { title, thumbnail, url, quality, sizeBytes? }
 */
export async function fetchYoutubeMP4(ytUrl) {
  assertEnv();

  // --- 1) Try /info ---
  const infoUrl = new URL("/info", BASE);
  infoUrl.searchParams.set("url", ytUrl);

  const headers = {
    "x-rapidapi-host": HOST,
    "x-rapidapi-key": KEY
  };

  const infoRes = await fetch(infoUrl.toString(), { headers });
  if (!infoRes.ok) {
    throw new Error(`YTDL /info HTTP ${infoRes.status}`);
  }
  const info = await infoRes.json().catch(() => ({}));

  // Expected shapes vary by provider; handle common fields defensively
  const title = info.title || info.videoTitle || info?.result?.title || "YouTube Video";
  const thumb = info.thumbnail || info.thumb || info?.result?.thumbnail;

  // Many responses include arrays like info.formats or info?.result?.formats
  const formats = info.formats || info?.result?.formats || info?.videoFormats || [];

  // Prefer progressive mp4 (muxed A+V), pick best ≤1080p, else highest
  const mp4s = formats
    .filter(f =>
      /mp4/i.test(f.mimeType || f.mime || f.type || "") ||
      /mp4/i.test(f.ext || "")
    )
    .filter(f => {
      const hasAudio = f.hasAudio ?? /audio/i.test(f.audio || "") ?? true; // be generous
      const hasVideo = f.hasVideo ?? /video/i.test(f.qualityLabel || f.quality || "") ?? true;
      // Some APIs mark progressive/muxed explicitly
      const progressive = f.isMuxed ?? f.progressive ?? (hasAudio && hasVideo);
      return progressive;
    })
    .map(f => {
      const qLabel = f.qualityLabel || f.quality || "";
      const height = Number(String(qLabel).match(/\d{3,4}/)?.[0] || f.height || 0);
      return {
        url: f.url || f.downloadUrl || f.link || f.dlink,
        height,
        quality: qLabel || (height ? `${height}p` : "mp4"),
        sizeBytes: f.contentLength || f.filesize || f.size || null,
      };
    })
    .filter(f => !!f.url);

  if (mp4s.length) {
    // Pick best ≤1080p if present, else highest available
    const within1080 = mp4s.filter(m => m.height && m.height <= 1080);
    const pick = (within1080.length ? within1080 : mp4s)
      .sort((a, b) => (b.height || 0) - (a.height || 0))[0];

    return {
      title,
      thumbnail: thumb || null,
      url: pick.url,
      quality: pick.quality,
      sizeBytes: pick.sizeBytes || null,
      source: "info",
    };
  }

  // --- 2) Fallback: /ajax/download.php?format=mp4 ---
  const dlUrl = new URL("/ajax/download.php", BASE);
  dlUrl.searchParams.set("format", "mp4");
  dlUrl.searchParams.set("url", ytUrl);
  dlUrl.searchParams.set("add_info", "0");
  dlUrl.searchParams.set("no_merge", "false");
  dlUrl.searchParams.set("allow_extended_duration", "false");

  const dlRes = await fetch(dlUrl.toString(), { headers });
  if (!dlRes.ok) {
    throw new Error(`YTDL /download HTTP ${dlRes.status}`);
  }
  const dl = await dlRes.json().catch(() => ({}));

  // Common patterns: dl?.url or dl?.result?.url or array of links
  const direct =
    dl.url ||
    dl.download_url ||
    dl?.result?.url ||
    dl?.result?.download_url ||
    (Array.isArray(dl.links) && dl.links[0]?.url) ||
    (Array.isArray(dl.result) && dl.result[0]?.url);

  if (!direct) {
    throw new Error("YTDL: no direct mp4 URL found");
  }

  return {
    title,
    thumbnail: thumb || null,
    url: direct,
    quality: "mp4",
    sizeBytes: null,
    source: "download",
  };
}
