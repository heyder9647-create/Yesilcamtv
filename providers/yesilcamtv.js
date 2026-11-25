/*
 * CVN-Yeşilçam TV — Nuvio local scraper
 * Searches the public WordPress REST index by TMDB title, then extracts a
 * playable media URL from the matched film page. No proxy or Cloudflare worker.
 */
var BASE = "https://yesilcamtv.com.tr";
var TMDB_API_KEY = "439c478a771f35c05022f9feabcca01c";
var UA = "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36";

function norm(s) {
  return String(s || "").toLocaleLowerCase("tr-TR")
    .replace(/ç/g, "c").replace(/ğ/g, "g").replace(/ı/g, "i")
    .replace(/ö/g, "o").replace(/ş/g, "s").replace(/ü/g, "u")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/&[^;]+;/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
}
function getJson(url) {
  return fetch(url, { headers: { "User-Agent": UA, "Accept": "application/json" } })
    .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); });
}
function getText(url, referer) {
  return fetch(url, { headers: { "User-Agent": UA, "Referer": referer || BASE + "/" } })
    .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.text(); });
}
function tmdbInfo(id) {
  return getJson("https://api.themoviedb.org/3/movie/" + encodeURIComponent(id) +
    "?api_key=" + TMDB_API_KEY + "&language=tr-TR")
    .then(function (d) {
      return { titles: [d.title, d.original_title].filter(Boolean), year: d.release_date ? d.release_date.slice(0, 4) : "" };
    });
}
function searchSite(q) {
  var url = BASE + "/wp-json/wp/v2/posts?per_page=30&_fields=link,title,content&search=" + encodeURIComponent(q);
  return getJson(url).catch(function () { return []; });
}
function choosePost(posts, titles, year) {
  var wanted = titles.map(norm).filter(Boolean);
  var scored = (posts || []).map(function (p) {
    var title = norm(p.title && p.title.rendered);
    var score = 0;
    wanted.forEach(function (w) {
      if (title === w) score += 100;
      else if (title.indexOf(w) !== -1 || w.indexOf(title) !== -1) score += 35;
      else {
        var words = w.split(" ").filter(function (x) { return x.length > 2; });
        words.forEach(function (word) { if (title.indexOf(word) !== -1) score += 5; });
      }
    });
    var body = (p.content && p.content.rendered) || "";
    if (/rumble\.com|\.m3u8|\.mp4|<video/i.test(body)) score += 4;
    if (year && body.indexOf(year) !== -1) score += 2;
    return { post: p, score: score };
  }).sort(function (a, b) { return b.score - a.score; });
  if (!scored.length || scored[0].score < 30) return null;
  return scored[0].post;
}
function decodeUrl(s) {
  return String(s || "").replace(/\\\//g, "/").replace(/&amp;/g, "&").replace(/\\u0026/g, "&");
}
function extractMedia(html) {
  var text = decodeUrl(html);
  var urls = [];
  var patterns = [
    /https?:[^"'\\\s<>]+\.m3u8(?:\?[^"'\\\s<>]*)?/ig,
    /https?:[^"'\\\s<>]+\.mp4(?:\?[^"'\\\s<>]*)?/ig
  ];
  patterns.forEach(function (re) {
    var m;
    while ((m = re.exec(text)) !== null) urls.push(m[0]);
  });
  var unique = [];
  urls.forEach(function (u) { if (unique.indexOf(u) === -1) unique.push(u); });
  var rumble = text.match(/rumble\.com\/embed\/([a-z0-9]+)/i);
  if (rumble) return getText("https://rumble.com/embed/" + rumble[1] + "/", "https://rumble.com/")
    .then(function (rh) {
      var h = decodeUrl(rh);
      var m = h.match(/"hls"\s*:\s*\{\s*"auto"\s*:\s*\{\s*"url"\s*:\s*"([^"]+)"/i);
      if (m) return [{ url: decodeUrl(m[1]), title: "Otomatik HLS", quality: "Auto", referer: "https://rumble.com/" }];
      var direct = extractDirectOnly(h);
      return direct;
    }).catch(function () { return []; });
  return Promise.resolve(unique.map(function (u) {
    return { url: u, title: u.indexOf(".m3u8") !== -1 ? "HLS yayın" : "MP4 yayın", quality: "Auto", referer: BASE + "/" };
  }));
}
function extractDirectOnly(html) {
  var text = decodeUrl(html), out = [], re = /https?:[^"'\s<>]+\.(?:m3u8|mp4)(?:\?[^"'\s<>]*)?/ig, m;
  while ((m = re.exec(text)) !== null) out.push({ url: m[0], title: "Doğrudan video", quality: "Auto", referer: "https://rumble.com/" });
  return out;
}
function getStreams(tmdbId, mediaType, season, episode) {
  if (mediaType !== "movie") return Promise.resolve([]);
  return tmdbInfo(tmdbId).then(function (info) {
    var titles = info.titles;
    var index = 0;
    function nextSearch() {
      if (index >= titles.length) return Promise.resolve(null);
      var title = titles[index++];
      return searchSite(title).then(function (posts) {
        var hit = choosePost(posts, titles, info.year);
        return hit || nextSearch();
      });
    }
    return nextSearch().then(function (post) {
      if (!post || !post.link) return [];
      var embedded = post.content && post.content.rendered || "";
      return extractMedia(embedded).then(function (streams) {
        if (streams.length) return streams;
        return getText(post.link, BASE + "/").then(extractMedia);
      }).then(function (streams) {
        return streams.map(function (s, i) {
          return {
            name: "CVN-Yeşilçam TV",
            title: (post.title && post.title.rendered ? post.title.rendered.replace(/<[^>]+>/g, "") : "Yeşilçam TV") + " — " + (s.title || "Kaynak " + (i + 1)),
            url: s.url,
            quality: s.quality || "Auto",
            headers: { "Referer": s.referer || post.link, "User-Agent": UA }
          };
        });
      });
    });
  }).catch(function (e) {
    console.log("[CVN-Yeşilçam TV] " + (e && e.message ? e.message : e));
    return [];
  });
}
module.exports = { getStreams: getStreams };
