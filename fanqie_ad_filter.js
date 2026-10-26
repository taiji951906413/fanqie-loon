/**
 * fanqie_ad_filter.js — 信息流广告过滤器（Loon）
 *
 * 不需要手动切模式：过滤常开，同时把「没见过的接口结构」自动打到日志里。
 *
 * 模式由 $argument 决定，缺省 = "filter"
 *   filter  删广告条目 + 每个新结构只打一次日志（默认）
 *   log     不改内容，每次请求都打结构
 *   off     完全放行
 * 手动指定：给脚本行加 argument="MODE=log"
 */

const DEFAULT_MODE = "filter";
const MAX_LOG_LINES = 14;
const MAX_SIGS = 40;
const STORE_KEY = "fanqie_ad_schema_sigs_v2";

const AD_FLAG_KEYS = [
  "is_ad", "isAd", "is_advert", "isAdvert", "is_advertisement", "isAdvertisement",
  "ad_info", "adInfo", "ad_data", "adData", "ad_extra", "adExtra",
  "ad_id", "adId", "ad_type", "adType", "adv_info", "advInfo",
  "commercial_info", "commercialInfo", "is_commercial", "isCommercial",
  "ad_label", "adLabel", "ad_tag", "adTag", "ad_source", "adSource",
  "is_promotion", "isPromotion", "promotion_info", "promotionInfo"
];

const TYPE_KEYS = [
  "cell_type", "cellType", "item_type", "itemType",
  "card_type", "cardType", "content_type", "contentType",
  "render_type", "renderType", "type"
];

const AD_TYPE_VALUES = [
  "ad", "adv", "advert", "advertisement", "ad_card", "adcard", "ad_cell",
  "commercial", "promotion", "promoted", "sponsor", "sponsored"
];

function truthy(v) {
  if (v === undefined || v === null || v === false || v === 0 || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return true;
}

function looksLikeAd(o) {
  if (!o || typeof o !== "object" || Array.isArray(o)) return false;
  for (let i = 0; i < AD_FLAG_KEYS.length; i++) {
    if (truthy(o[AD_FLAG_KEYS[i]])) return true;
  }
  for (let i = 0; i < TYPE_KEYS.length; i++) {
    const v = o[TYPE_KEYS[i]];
    if (typeof v === "string" && AD_TYPE_VALUES.indexOf(v.toLowerCase()) >= 0) return true;
  }
  if (o.ad && typeof o.ad === "object" && Object.keys(o.ad).length > 0) return true;
  return false;
}

function hash32(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function resolveMode() {
  let m = null;
  try {
    if (typeof $argument === "object" && $argument !== null) {
      m = $argument.MODE;
    } else if (typeof $argument === "string" && $argument) {
      const hit = /(?:^|[,&\s])MODE\s*=\s*"?([a-zA-Z]+)"?/.exec($argument);
      if (hit) m = hit[1];
    }
  } catch (e) { /* $argument 不存在时忽略 */ }
  if (typeof m !== "string") return DEFAULT_MODE;
  m = m.toLowerCase();
  if (m === "filter" || m === "log" || m === "off") return m;
  return DEFAULT_MODE;
}

function loadSigs() {
  try {
    const raw = $persistentStore.read(STORE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}

function saveSigs(arr) {
  try { $persistentStore.write(JSON.stringify(arr.slice(-MAX_SIGS)), STORE_KEY); } catch (e) {}
}

function collectSchema(root, url) {
  const lines = [];
  const sigs = [];
  let found = 0;

  lines.push("URL " + url);
  if (root && typeof root === "object" && !Array.isArray(root)) {
    lines.push("TOP " + Object.keys(root).slice(0, 20).join(","));
  }

  function visit(node, path, depth) {
    if (found >= MAX_LOG_LINES || depth > 6) return;

    if (Array.isArray(node)) {
      if (node.length > 0) {
        const first = node[0];
        if (first && typeof first === "object" && !Array.isArray(first)) {
          const keys = Object.keys(first);
          let adCount = 0;
          for (let i = 0; i < node.length; i++) if (looksLikeAd(node[i])) adCount++;
          const mark = adCount > 0 ? " AD?" : "";
          lines.push("ARR " + path + " len=" + node.length + " ads=" + adCount + "/" + node.length +
                     mark + " keys=" + keys.slice(0, 18).join(","));
          found++;
          if (adCount > 0) {
            for (let i = 0; i < node.length; i++) {
              if (looksLikeAd(node[i])) {
                const extra = Object.keys(node[i]).filter(function (k) { return keys.indexOf(k) < 0; });
                if (extra.length) lines.push("    +keys(ad)=" + extra.slice(0, 14).join(","));
                break;
              }
            }
          }
          sigs.push(path + "|" + keys.join(","));
        }
      }
      for (let i = 0; i < Math.min(node.length, 3); i++) {
        visit(node[i], path + "[" + i + "]", depth + 1);
        if (found >= MAX_LOG_LINES) return;
      }
      return;
    }

    if (node && typeof node === "object") {
      const ks = Object.keys(node);
      for (let i = 0; i < ks.length; i++) {
        visit(node[ks[i]], path + "." + ks[i], depth + 1);
        if (found >= MAX_LOG_LINES) return;
      }
    }
  }

  visit(root, "$", 0);
  return { text: lines.join("\n"), sig: hash32(sigs.join(";")) };
}

let removed = 0;
let guarded = 0;

function safeFilter(root) {
  const emptied = [];

  function pass(node, path) {
    if (Array.isArray(node)) {
      const total = node.length;
      if (total > 0) {
        const keep = [];
        for (let i = 0; i < total; i++) {
          if (looksLikeAd(node[i])) continue;
          keep.push(node[i]);
        }
        if (keep.length === 0 && total >= 3) {
          emptied.push(path + "(len=" + total + ")");
          guarded++;
        } else if (keep.length !== total) {
          removed += total - keep.length;
          node.length = 0;
          for (let i = 0; i < keep.length; i++) node.push(keep[i]);
        }
      }
      for (let i = 0; i < node.length; i++) pass(node[i], path + "[" + i + "]");
      return;
    }
    if (node && typeof node === "object") {
      const ks = Object.keys(node);
      for (let i = 0; i < ks.length; i++) pass(node[ks[i]], path + "." + ks[i]);
    }
  }

  pass(root, "$");
  return emptied;
}

(function () {
  const mode = resolveMode();
  const url = ($request && $request.url) ? $request.url : "";
  const body = $response ? $response.body : null;

  if (mode === "off") { $done({}); return; }
  if (!body) { $done({}); return; }

  let obj;
  try {
    obj = JSON.parse(body);
  } catch (e) {
    if (mode === "log") console.log("[fanqie] 非 JSON，跳过: " + url);
    $done({});
    return;
  }

  const schema = collectSchema(obj, url);
  const sigs = loadSigs();
  const isNew = sigs.indexOf(schema.sig) < 0;

  if (mode === "log") {
    console.log("\n[fanqie:log]\n" + schema.text);
    $done({});
    return;
  }

  if (isNew) {
    sigs.push(schema.sig);
    saveSigs(sigs);
    console.log("\n[fanqie:new-schema]\n" + schema.text);
  }

  removed = 0;
  guarded = 0;
  const emptied = safeFilter(obj);

  if (removed === 0) {
    if (guarded > 0) {
      console.log("[fanqie] guarded=" + guarded + " [" + emptied.join(",") + "] " + url);
    }
    $done({});
    return;
  }

  let msg = "[fanqie] removed=" + removed + " " + url;
  if (guarded > 0) msg += "  guarded=" + guarded + " [" + emptied.join(",") + "]";
  console.log(msg);

  $done({ body: JSON.stringify(obj) });
})();
