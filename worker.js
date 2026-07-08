/**
 * DISPATCH — Cloudflare Worker
 * Storage: GitHub Gist
 *
 * Secrets required in Cloudflare Worker → Settings → Variables → Secrets:
 *   - GIST_ID          (id of your dispatch.json gist)
 *   - GITHUB_TOKEN     (classic PAT with gist scope)
 *   - GEMINI_API_KEY   (Google AI Studio key)
 *
 * Endpoints:
 *   GET    /?tab=reit           → REIT filings + REIT_FEEDS list
 *   GET    /                    → main news store
 *   POST   /  { action: ... }   → actions below
 *
 *   Actions:
 *     updateFeeds              — replace feed list (with confirmClear guard)
 *     forceFetch               — force fetch news feeds now
 *     forceFetchReit           — force fetch REIT feeds now
 *     generateSummary          — page-level AI summary
 *     summariseArticle         — per-article summary
 *     extractReitTransactions  — Gemini reads JP filing PDFs and extracts
 *                                structured deal metrics (prop, class, loc,
 *                                NOI, yield, appraisal, price). Quota-safe:
 *                                small batch, stops on 429, uses Flash by
 *                                default.
 */

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const GIST_FILE = 'dispatch.json';

const EMPTY = () => ({
  feeds: [], articles: [],
  reitArticles: [], reitTransactions: [],
  summary: null,
  lastFetch: null, reitLastFetch: null, reitExtractLastRun: null,
  fetchErrors: [], reitFetchErrors: [], reitExtractErrors: [],
});

// Retention + caps
const NEWS_MAX      = 3000;
const REIT_MAX      = 800;
const TXN_MAX       = 500;
const RETAIN_MS     = 180 * 24 * 60 * 60 * 1000;
// Quota-safe: only 2 PDFs per run. Increase once your Gemini tier is higher.
const EXTRACT_BATCH = 2;
// Gemini model for PDF extraction. Flash is quota-friendly; switch to Pro
// only if you're on a paid tier and Flash extractions look sparse.
const EXTRACT_MODEL = 'gemini-2.5-flash';

let isFetching     = false;
let isReitFetching = false;
let isExtracting   = false;

// ── HARDCODED REIT FEEDS ──────────────────────────────────────────────
const REIT_FEEDS = [
  // Hotel-themed
  { id: 'jh_reit',       name: 'JH REIT',                 url: 'https://rss.app/feeds/a1KuDpPwxBr6PZqi.xml' },
  { id: 'invincible',    name: 'Invincible REIT',         url: 'https://rss.app/feeds/I4JGlT1SdTvH7gzm.xml' },
  { id: 'hoshino',       name: 'Hoshino REIT',            url: 'https://webapi.yanoshin.jp/webapi/tdnet/list/3287.rss' },
  { id: 'nhr_reit',      name: 'NHR REIT',                url: 'https://rss.app/feeds/uGYoYiTgjbF3tOBo.xml' },
  { id: 'ichigo_reit',   name: 'Ichigo REIT',             url: 'https://rss.app/feeds/XnARKE1QJEamHLUW.xml' },
  { id: 'kasumigaseki',  name: 'Kasumigaseki Hotel REIT', url: 'https://webapi.yanoshin.jp/webapi/tdnet/list/401A.rss' },

  // Diversified with hotel holdings
  { id: 'united_urban',  name: 'United Urban',            url: 'https://webapi.yanoshin.jp/webapi/tdnet/list/8960.rss' },
  { id: 'mori_trust',    name: 'MORI TRUST REIT',         url: 'https://webapi.yanoshin.jp/webapi/tdnet/list/8961.rss' },
  { id: 'activia',       name: 'Activia Properties',      url: 'https://webapi.yanoshin.jp/webapi/tdnet/list/3279.rss' },
  { id: 'hulic',         name: 'Hulic Reit',              url: 'https://webapi.yanoshin.jp/webapi/tdnet/list/3295.rss' },
  { id: 'fukuoka',       name: 'Fukuoka REIT',            url: 'https://webapi.yanoshin.jp/webapi/tdnet/list/8968.rss' },
  { id: 'orix',          name: 'ORIX JREIT',              url: 'https://webapi.yanoshin.jp/webapi/tdnet/list/8954.rss' },
  { id: 'daiwa_house',   name: 'Daiwa House REIT',        url: 'https://webapi.yanoshin.jp/webapi/tdnet/list/8984.rss' },
  { id: 'nippon_reit',   name: 'Nippon REIT',             url: 'https://webapi.yanoshin.jp/webapi/tdnet/list/3296.rss' },
  { id: 'kdx',           name: 'KDX Realty',              url: 'https://webapi.yanoshin.jp/webapi/tdnet/list/8972.rss' },
  { id: 'nomura_mf',     name: 'Nomura RE Master Fund',   url: 'https://webapi.yanoshin.jp/webapi/tdnet/list/3462.rss' },
  { id: 'star_asia',     name: 'Star Asia',               url: 'https://webapi.yanoshin.jp/webapi/tdnet/list/3468.rss' },
  { id: 'marimo',        name: 'Marimo Regional',         url: 'https://webapi.yanoshin.jp/webapi/tdnet/list/3470.rss' },
  { id: 'mirarth',       name: 'MIRARTH REIT',            url: 'https://webapi.yanoshin.jp/webapi/tdnet/list/3492.rss' },
  { id: 'central',       name: 'CENTRAL REIT',            url: 'https://webapi.yanoshin.jp/webapi/tdnet/list/3488.rss' },
  { id: 'mirai',         name: 'MIRAI Corporation',       url: 'https://webapi.yanoshin.jp/webapi/tdnet/list/3476.rss' },
  { id: 'sankei',        name: 'SANKEI Real Estate',      url: 'https://webapi.yanoshin.jp/webapi/tdnet/list/2972.rss' },
];

// ── HARDCODED NEWS FEEDS ────────────────────────────────────────────────
// Hardcoded here (same pattern as REIT_FEEDS) so the feed list can never be
// wiped out by a bad Gist read/write — see readStore() notes below. To add,
// remove, or rename a feed, edit this array and redeploy the worker.
// `group` powers the source-filter drawer in the frontend: feeds sharing a
// group are shown/filtered together.
const NEWS_FEEDS = [
  // Al Jazeera
  { id: 'aj_news',            name: 'Al Jazeera (News)',       group: 'Al Jazeera',     url: 'https://rss.app/feeds/t3XqHphVAzBa6qqB.xml' },
  { id: 'aj_opinion',         name: 'Al Jazeera (Opinion)',     group: 'Al Jazeera',     url: 'https://rss.app/feeds/tROkJYFj6hPQFgZD.xml' },
  { id: 'aj_explained',       name: 'Al Jazeera (Explained)',   group: 'Al Jazeera',     url: 'https://rss.app/feeds/t9a4SiGeJwN3sZMx.xml' },

  // Guardian
  { id: 'guardian_uk',        name: 'Guardian (UK)',           group: 'Guardian',        url: 'https://www.theguardian.com/uk/rss' },
  { id: 'guardian_opinion',   name: 'Guardian (Opinion)',      group: 'Guardian',        url: 'https://www.theguardian.com/uk/commentisfree/RSS' },
  { id: 'guardian_business',  name: 'Guardian (Business)',     group: 'Guardian',        url: 'https://www.theguardian.com/uk/business/RSS' },
  { id: 'guardian_world',     name: 'Guardian (World)',        group: 'Guardian',        url: 'https://www.theguardian.com/world/rss' },

  // CNA
  { id: 'cna_asia',           name: 'CNA (Asia)',              group: 'CNA',             url: 'https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml&category=6511' },
  { id: 'cna_business',       name: 'CNA (Business)',          group: 'CNA',             url: 'https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml&category=6936' },

  // Bloomberg
  { id: 'bbg_world',          name: 'BBG (World)',             group: 'Bloomberg',       url: 'https://rss.app/feeds/tB7TswPuc6PWdI20.xml' },
  { id: 'bbg_markets',        name: 'BBG (Markets)',           group: 'Bloomberg',       url: 'https://rss.app/feeds/K7BepAaUYXdi0YXN.xml' },
  { id: 'bbg_finance',        name: 'BBG (Finance)',           group: 'Bloomberg',       url: 'https://rss.app/feeds/Kb18ufnUcBABlz3j.xml' },
  { id: 'bbg_explained',      name: 'BBG (Explained)',         group: 'Bloomberg',       url: 'https://rss.app/feeds/SYIYOgVN1hCDlLfj.xml' },
  { id: 'bbg_opinion',        name: 'BBG (Opinion)',           group: 'Bloomberg',       url: 'https://rss.app/feeds/oy44QoBz2jloJVXT.xml' },
  { id: 'bbg_industries',     name: 'BBG (Industries)',        group: 'Bloomberg',       url: 'https://rss.app/feeds/e4AKOsZCQFpLo0wJ.xml' },

  // Standalone
  { id: 'hotel_conversation', name: 'Hotel Conversation',      group: 'Hotel Conversation', url: 'https://rss.app/feeds/taTBv7EymD1TPLcm.xml' },
  { id: 'mtd',                name: 'MTD',                     group: 'Mingtiandi',      url: 'https://www.mingtiandi.com/feed/' },

  // Reuters
  { id: 'reuters_world',      name: 'Reuters (World)',         group: 'Reuters',         url: 'https://rss.app/feeds/tPROdBesgEfIdKYZ.xml' },
  { id: 'reuters_business',   name: 'Reuters (Business)',      group: 'Reuters',         url: 'https://rss.app/feeds/tPYdXGw0G1kG3LCc.xml' },
  { id: 'reuters_finance',    name: 'Reuters (Finance)',       group: 'Reuters',         url: 'https://rss.app/feeds/ta31RignlrDSfZ7g.xml' },

  { id: 'ap_advisors',        name: 'AP Advisors',             group: 'AP Advisors',     url: 'https://rss.app/feeds/IrhWD0aTjUlcV1O7.xml' },

  // Economist
  { id: 'economist_intl',        name: 'Economist (Intl)',        group: 'Economist', url: 'https://rss.app/feeds/bSEAY2o0JjDENy1f.xml' },
  { id: 'economist_indicators',  name: 'Economist (Indicators)',  group: 'Economist', url: 'https://rss.app/feeds/Itcif86EQsYtamDT.xml' },
  { id: 'economist_business',    name: 'Economist (Business)',    group: 'Economist', url: 'https://rss.app/feeds/thlmzDm4o7At8oM4.xml' },
  { id: 'economist_finance',     name: 'Economist (Finance)',     group: 'Economist', url: 'https://rss.app/feeds/t6KNm2JBAbQZeKHV.xml' },
  { id: 'economist_opinions',    name: 'Economist (Opinions)',    group: 'Economist', url: 'https://rss.app/feeds/tMJnfVpK84FsjI2K.xml' },
  { id: 'economist_china',       name: 'Economist (China)',       group: 'Economist', url: 'https://rss.app/feeds/eRBsKdmrphBL9pKw.xml' },
  { id: 'economist_europe',      name: 'Economist (Europe)',      group: 'Economist', url: 'https://rss.app/feeds/FXROFpAfT3Rajomh.xml' },
  { id: 'economist_us',          name: 'Economist (US)',          group: 'Economist', url: 'https://rss.app/feeds/RGddtgRi72iv5GHv.xml' },

  // BBC
  { id: 'bbc_business',       name: 'BBC (Business)',          group: 'BBC',             url: 'https://rss.app/feeds/9PvzCOxOzzKI0WCc.xml' },
  { id: 'bbc_world',          name: 'BBC (World)',             group: 'BBC',             url: 'https://rss.app/feeds/LQoYxqylVMXScpRm.xml' },

  // Standalone commentary / markets — these are X (Twitter) accounts
  // syndicated via rss.app, not conventional news sites. Flagged with
  // platform: 'x' so the frontend can split them into their own tab.
  { id: 'walter_bloomberg',   name: 'Walter Bloomberg',        group: 'Walter Bloomberg', platform: 'x', url: 'https://rss.app/feeds/EHOTeICYTCuzJIck.xml' },
  { id: 'kobeissi_letter',    name: 'Kobeissi Letter',         group: 'Kobeissi Letter',  platform: 'x', url: 'https://rss.app/feeds/vl6oLfdmvZwA0Kvk.xml' },
  { id: 'zerohedge',          name: 'Zerohedge',               group: 'Zerohedge',        platform: 'x', url: 'https://rss.app/feeds/7Evar9S34n6s8Vds.xml' },
  { id: 'michael_brown',      name: 'Michael Brown',           group: 'Michael Brown',    platform: 'x', url: 'https://rss.app/feeds/szZUhfmp4mGv6DLg.xml' },
];

const ACQUISITION_KEYWORDS = [
  'acquisition of', 'to acquire', 'concerning acquisition',
  'notice concerning acquisition', 'notice regarding acquisition',
  'completion of acquisition', 'concludes acquisition',
  'additional acquisition',
  'trust beneficiary', 'beneficiary interest',
  'new property', 'asset acquisition', 'property acquisition',
  '取得', '資産の取得', '資産取得',
  '不動産取得', '不動産の取得',
  '信託受益権の取得', '信託受益権',
  '優先出資証券の取得',
  '物件取得', '新規取得', '追加取得',
  '取得決定', '取得決議',
];

const DISPOSAL_KEYWORDS = [
  'disposition', 'disposal', 'sale of', 'transfer of',
  'notice concerning disposition', 'notice concerning sale',
  '譲渡', '資産の譲渡', '売却', '資産の売却',
  '譲渡決定', '譲渡決議',
];

const EXCLUDE_KEYWORDS = [
  '自己投資口', 'unit repurchase', 'own investment units',
];

function classifyFiling(title, description) {
  const hay = ((title || '') + ' ' + (description || '')).toLowerCase();
  if (EXCLUDE_KEYWORDS.some(kw => hay.includes(kw.toLowerCase()))) return null;
  if (ACQUISITION_KEYWORDS.some(kw => hay.includes(kw.toLowerCase()))) return 'acquisition';
  if (DISPOSAL_KEYWORDS.some(kw => hay.includes(kw.toLowerCase()))) return 'disposal';
  return null;
}

// ── GIST STORAGE ──────────────────────────────────────────────────────
function ghHeaders(env) {
  return {
    'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
    'Accept':        'application/vnd.github+json',
    'User-Agent':    'Dispatch/1.0',
  };
}

async function readStore(env) {
  const resp = await fetch(`https://api.github.com/gists/${env.GIST_ID}`, { headers: ghHeaders(env) });
  if (!resp.ok) {
    const errText = await resp.text();
    console.error('Gist read failed:', resp.status, errText);
    // Don't return EMPTY() here — a transient read failure must NOT be
    // treated as "the store is legitimately empty", or callers will
    // happily write that empty state straight back over good data.
    throw new Error(`Gist read failed: ${resp.status}`);
  }
  const gist = await resp.json();
  const file = gist.files?.[GIST_FILE];
  if (!file) return EMPTY(); // gist exists but the file itself is genuinely new/missing

  let raw = file.content;

  // GitHub's Gist API truncates `content` (and sets `truncated: true`) for
  // any file over ~1MB — which dispatch.json regularly exceeds once articles
  // + REIT filings + transactions accumulate for a few days. The truncated
  // text isn't valid JSON, so without this check JSON.parse below would
  // throw and (in the old code) silently fall back to an EMPTY store —
  // which is what was wiping out feeds/articles every few days. Fetch the
  // untruncated content from raw_url instead.
  if (file.truncated && file.raw_url) {
    const rawResp = await fetch(file.raw_url, { headers: ghHeaders(env) });
    if (!rawResp.ok) throw new Error(`Gist raw_url fetch failed: ${rawResp.status}`);
    raw = await rawResp.text();
  }

  if (!raw) return EMPTY();
  try {
    return JSON.parse(raw);
  } catch (e) {
    // Unparseable content is a corruption signal, not "empty state".
    // Throwing here aborts the caller (fetch/write cycle) instead of
    // quietly persisting an EMPTY() store over whatever was actually there.
    throw new Error(`Gist content unparseable: ${e.message}`);
  }
}

function trimByAge(arr, max) {
  const cutoff = Date.now() - RETAIN_MS;
  const kept = (arr || []).filter(a => {
    const t = a.timestamp || Date.parse(a.pubDate || a.filingDate || '') || 0;
    return t >= cutoff;
  });
  return kept.slice(0, max);
}

async function writeStore(env, data) {
  const payload = {
    ...data,
    articles:         trimByAge(data.articles,     NEWS_MAX),
    reitArticles:     trimByAge(data.reitArticles, REIT_MAX),
    reitTransactions: (data.reitTransactions || []).slice(0, TXN_MAX),
  };

  const resp = await fetch(`https://api.github.com/gists/${env.GIST_ID}`, {
    method:  'PATCH',
    headers: { ...ghHeaders(env), 'Content-Type': 'application/json' },
    body:    JSON.stringify({ files: { [GIST_FILE]: { content: JSON.stringify(payload) } } }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    console.error('Gist write failed:', resp.status, err);
    throw new Error(`Gist write failed: ${resp.status}`);
  }
}

// ── RESPONSE HELPER ───────────────────────────────────────────────────
function jsonResp(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

// ── ENTRY POINT ───────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (e) {
      console.error('Worker error:', e);
      // Feeds are hardcoded (NEWS_FEEDS), so even if the Gist read/write
      // itself failed, the frontend still gets a usable feed list back.
      return jsonResp({ success: false, error: String(e?.message || e), ...EMPTY(), feeds: NEWS_FEEDS }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(fetchBoth(env));
  },
};

// ── ROUTER ────────────────────────────────────────────────────────────
async function route(request, env, ctx) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

  if (request.method === 'GET') {
    const tab   = new URL(request.url).searchParams.get('tab');
    const store = await readStore(env);

    // Accept both singular and plural for robustness against frontend variants
    if (tab === 'reit' || tab === 'reits') {
      return jsonResp({
        success:        true,
        feeds:          REIT_FEEDS,
        articles:       store.reitArticles     || [],
        transactions:   store.reitTransactions || [],
        lastFetch:      store.reitLastFetch,
        extractLastRun: store.reitExtractLastRun,
        fetchErrors:    store.reitFetchErrors  || [],
        extractErrors:  store.reitExtractErrors || [],
      });
    }

    // Feeds are hardcoded (see NEWS_FEEDS above) — always serve that list
    // rather than whatever (if anything) is in the gist under `feeds`.
    return jsonResp({ success: true, ...store, feeds: NEWS_FEEDS });
  }

  if (request.method === 'POST') {
    let body;
    try {
      const text = await request.text();
      body = JSON.parse(text);
    } catch {
      return jsonResp({ success: false, error: 'Invalid JSON body' }, 400);
    }

    switch (body.action) {
      case 'updateFeeds':             return jsonResp(await handleUpdateFeeds(body, env, ctx));
      case 'forceFetch':              return jsonResp(await handleForceFetch(env));
      case 'forceFetchReit':          return jsonResp(await handleForceFetchReit(env));
      case 'generateSummary':         return jsonResp(await handleGenerateSummary(body, env));
      case 'summariseArticle':        return jsonResp(await handleSummariseArticle(body, env));
      case 'extractReitTransactions': return jsonResp(await handleExtractReitTransactions(body, env));
      default:                        return jsonResp({ success: false, error: 'Unknown action' }, 400);
    }
  }

  return jsonResp({ error: 'Method not allowed' }, 405);
}

// ── ACTION HANDLERS ───────────────────────────────────────────────────
// DEPRECATED: feeds are now hardcoded in NEWS_FEEDS above and can no longer
// be edited via the API — this avoids the feed list getting silently wiped
// by a Gist read/write race or truncation (see readStore()). Kept as a
// harmless no-op in case an old cached copy of the frontend still calls it.
async function handleUpdateFeeds(body, env, ctx) {
  return {
    success: true,
    feeds:   NEWS_FEEDS,
    note:    'Feeds are hardcoded in worker.js (NEWS_FEEDS) — edit and redeploy the worker to change them.',
  };
}

async function handleForceFetch(env) {
  const result = await fetchNews(env);
  return { success: true, ...result };
}

async function handleForceFetchReit(env) {
  const result = await fetchReit(env);
  return { success: true, ...result };
}

async function handleGenerateSummary(body, env) {
  const apiKey = env.GEMINI_API_KEY || '';
  if (!apiKey) return { success: false, error: 'GEMINI_API_KEY not set' };

  const result = await callGemini(apiKey, body.prompt || '', body.headlines || '', 'gemini-2.5-pro');
  if (!result.success) return result;

  const summary = { rawText: result.text, meta: 'Generated ' + new Date().toLocaleString() };
  const store   = await readStore(env);
  store.summary = summary;
  await writeStore(env, store);

  return { success: true, summary };
}

async function handleSummariseArticle(body, env) {
  const apiKey = env.GEMINI_API_KEY || '';
  if (!apiKey) return { success: false, error: 'GEMINI_API_KEY not set' };

  const system  = 'You are a concise news analyst. Summarise in 2-3 plain sentences. No preamble.';
  const content = `Title: ${body.title || ''}\n${body.description ? 'Excerpt: ' + body.description : ''}`;
  const result  = await callGemini(apiKey, system, content, 'gemini-2.5-flash');
  if (!result.success) return result;
  return { success: true, summary: result.text.trim() };
}

// ── REIT TRANSACTION EXTRACTION (Gemini reads PDFs → structured rows) ─
// Quota-safe:
//   • EXTRACT_BATCH=2 per run (was 12)
//   • Stops immediately on 429 / quota exhaustion so we don't burn calls
//   • Uses gemini-2.5-flash by default (see EXTRACT_MODEL constant)
function isGeminiQuotaError(msg) {
  const s = String(msg || '').toLowerCase();
  return s.includes('429') || s.includes('quota') ||
         s.includes('rate limit') || s.includes('rate-lim') ||
         s.includes('resource_exhausted');
}

async function handleExtractReitTransactions(body, env) {
  if (isExtracting) return { success: true, added: 0, skipped: true };
  isExtracting = true;
  try {
    const apiKey = env.GEMINI_API_KEY || '';
    if (!apiKey) return { success: false, error: 'GEMINI_API_KEY not set' };

    const store = await readStore(env);
    const done  = new Set((store.reitTransactions || []).map(t => t.filingId));

    const candidates = (store.reitArticles || [])
      .filter(a => a.category === 'acquisition' || a.category === 'disposal')
      .filter(a => a.link && a.link.startsWith('http'))
      .filter(a => !done.has(a.id))
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, Math.max(1, body.limit || EXTRACT_BATCH));

    const newRows = [];
    const errors  = [];
    let   quotaHit = false;

    for (const f of candidates) {
      try {
        const rows = await extractTxnFromFiling(apiKey, f);
        if (rows && rows.length) {
          newRows.push(...rows);
        } else {
          // Placeholder so we don't retry a filing that Gemini
          // successfully processed but returned nothing for.
          newRows.push({
            id: f.id + '_noop', filingId: f.id, reitName: f.feedName,
            transactionType: f.category, propertyName: null,
            extractedAt: new Date().toISOString(), sourceUrl: f.link,
            noExtract: true,
          });
        }
      } catch (e) {
        const msg = String(e?.message || e);
        errors.push({ filingId: f.id, error: msg });
        if (isGeminiQuotaError(msg)) { quotaHit = true; break; }
      }
    }

    store.reitTransactions   = [...newRows, ...(store.reitTransactions || [])].slice(0, TXN_MAX);
    store.reitExtractLastRun = new Date().toISOString();
    store.reitExtractErrors  = errors;
    await writeStore(env, store);

    return {
      success:   errors.length === 0 || newRows.length > 0,
      added:     newRows.filter(r => !r.noExtract).length,
      scanned:   candidates.length,
      processed: candidates.length - errors.length,
      quotaHit,
      errors,
      error:     quotaHit ? 'Gemini quota / rate limit hit. Wait a few minutes and retry.' :
                 (errors[0]?.error || ''),
    };
  } finally {
    isExtracting = false;
  }
}

// Downloads the filing (PDF or HTML) and asks Gemini to return structured
// JSON per the response schema. One filing may cover multiple properties
// → returns an array.
async function extractTxnFromFiling(apiKey, filing) {
  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 20000);

  let resp;
  try {
    resp = await fetch(filing.link, {
      headers: {
        'User-Agent':      'Mozilla/5.0 (compatible; Dispatch/1.0)',
        'Accept':          'application/pdf,text/html,*/*',
        'Accept-Language': 'ja,en;q=0.9',
      },
      signal:   controller.signal,
      redirect: 'follow',
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!resp.ok) throw new Error(`Filing HTTP ${resp.status}`);
  const contentType = (resp.headers.get('content-type') || '').toLowerCase();

  const schema = {
    type: 'ARRAY',
    items: {
      type: 'OBJECT',
      properties: {
        propertyName:    { type: 'STRING' },
        assetClass:      { type: 'STRING', description: 'Hotel / Office / Retail / Logistics / Residential / Mixed-use / Other. Use "Mixed-use (hotel)" etc. for mixed-use properties so the primary component is preserved.' },
        location:        { type: 'STRING', description: 'City, Prefecture. E.g. "Chuo-ku, Tokyo".' },
        transactionType: { type: 'STRING', description: 'acquisition or disposal.' },
        priceJpyMn:      { type: 'NUMBER' },
        appraisalJpyMn:  { type: 'NUMBER' },
        noiJpyMn:        { type: 'NUMBER' },
        noiBasis:        { type: 'STRING', description: 'NOI / NCF / DCF NOI.' },
        yieldPct:        { type: 'NUMBER' },
        settlementDate:  { type: 'STRING' },
      },
      required: ['propertyName', 'transactionType'],
    },
  };

  const instruction = [
    'You are a J-REIT disclosure analyst. Extract every property covered in this filing.',
    'Return one JSON object per property.',
    'All monetary figures in JPY millions (百万円). Convert 億円 to millions (1 億 = 100 million).',
    'Yield is disclosed NOI yield or cap rate as a percentage (e.g. 4.2 for 4.2%). Prefer NOI yield; use NCF yield only if NOI yield is not disclosed and set noiBasis="NCF".',
    'transactionType is acquisition (取得) or disposal (譲渡/売却).',
    'If a field is not explicitly disclosed, return null. Do not invent, infer, or round.',
    'For assetClass, use "Mixed-use (hotel)" / "Mixed-use (office)" etc. when a property has multiple uses.',
  ].join(' ');

  let contents;
  if (contentType.includes('application/pdf')) {
    const buf = await resp.arrayBuffer();
    if (buf.byteLength > 15 * 1024 * 1024) throw new Error('PDF too large for inline extraction');
    const b64 = arrayBufferToBase64(buf);
    contents = [{
      role: 'user',
      parts: [
        { inlineData: { mimeType: 'application/pdf', data: b64 } },
        { text: instruction },
      ],
    }];
  } else {
    const raw  = await resp.text();
    const text = htmlToText(raw).slice(0, 20000);
    if (text.length < 40) return [];
    contents = [{
      role: 'user',
      parts: [{ text: instruction + '\n\n---\n' + text }],
    }];
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${EXTRACT_MODEL}:generateContent?key=${apiKey}`;
  const body = {
    contents,
    generationConfig: {
      temperature:      0.1,
      responseMimeType: 'application/json',
      responseSchema:   schema,
    },
  };

  const r = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Gemini ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);

  const txt = j.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '[]';
  let rows;
  try { rows = JSON.parse(txt); } catch { return []; }
  if (!Array.isArray(rows)) return [];

  return rows.map((row, i) => ({
    id:          `${filing.id}_${i}`,
    filingId:    filing.id,
    reitName:    filing.feedName,
    filingTitle: filing.title,
    filingDate:  filing.pubDate || null,
    timestamp:   filing.timestamp || Date.now(),
    sourceUrl:   filing.link,
    extractedAt: new Date().toISOString(),
    ...row,
    // Backfill settlementDate with filing date if Gemini didn't find one,
    // so table dates never fall through to today.
    settlementDate: row.settlementDate || filing.pubDate || null,
  }));

}

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// ── COMBINED CRON FETCH ───────────────────────────────────────────────
async function fetchBoth(env) {
  const store = await readStore(env);

  const [newsResult, reitResult] = await Promise.allSettled([
    fetchNewsArticles(NEWS_FEEDS, store.articles || []),
    fetchReitArticles(REIT_FEEDS.filter(f => f.url), store.reitArticles || []),
  ]);

  if (newsResult.status === 'fulfilled') {
    store.articles    = newsResult.value.articles;
    store.lastFetch   = new Date().toISOString();
    store.fetchErrors = newsResult.value.errors;
  }
  if (reitResult.status === 'fulfilled') {
    store.reitArticles    = reitResult.value.articles;
    store.reitLastFetch   = new Date().toISOString();
    store.reitFetchErrors = reitResult.value.errors;
  }

  await writeStore(env, store);

  // Chain: extract deals from any new filings. Quota-safe: only 2 PDFs
  // per run. Non-fatal if it errors.
  if (env.GEMINI_API_KEY) {
    try { await handleExtractReitTransactions({}, env); }
    catch (e) { console.error('Cron extract failed:', e); }
  }
}

// ── NEWS FETCH ────────────────────────────────────────────────────────
async function fetchNews(env) {
  if (isFetching) return { added: 0, skipped: true };
  isFetching = true;
  try {
    const store = await readStore(env);
    const feeds = NEWS_FEEDS;
    if (!feeds.length) return { added: 0, errors: [] };

    const result = await fetchNewsArticles(feeds, store.articles || []);
    store.articles    = result.articles;
    store.lastFetch   = new Date().toISOString();
    store.fetchErrors = result.errors;
    await writeStore(env, store);
    return { added: result.added, errors: result.errors };
  } finally {
    isFetching = false;
  }
}

async function fetchNewsArticles(feeds, existingArticles) {
  // Auto-prune: drop any stored article whose feedId no longer matches a
  // feed currently in NEWS_FEEDS. This means removing (or renaming the id
  // of) a feed in the hardcoded array is enough — the next fetch, cron or
  // forced, will evict its old articles automatically. No manual cleanup
  // action needed.
  const validFeedIds = new Set(feeds.map(f => f.id));
  let articles = existingArticles.filter(a => validFeedIds.has(a.feedId));
  let addedIds = [];
  const errors = [];

  await Promise.allSettled(feeds.map(async feed => {
    try {
      const newOnes = await fetchFeed(feed, articles);
      addedIds.push(...newOnes.map(a => a.id));
      articles  = articles.concat(newOnes);
    } catch (e) {
      errors.push({ feedId: feed.id, feedName: feed.name, error: e.message });
    }
  }));

  // Repair any legacy dirty/imageless entries, then dedupe by content across
  // the WHOLE merged list (existing + new) — this is what catches mirrored
  // feeds / republished stories that slip past the per-feed id check.
  articles = dedupeAndCluster(articles.map(repairArticle));
  articles.sort((a, b) => b.timestamp - a.timestamp);

  const survivingIds = new Set(articles.map(a => a.id));
  const added = addedIds.filter(id => survivingIds.has(id)).length;

  return { articles: articles.slice(0, NEWS_MAX), errors, added };
}

// ── REIT FETCH ────────────────────────────────────────────────────────
async function fetchReit(env) {
  if (isReitFetching) return { added: 0, skipped: true };
  isReitFetching = true;
  try {
    const store = await readStore(env);
    const feeds = REIT_FEEDS.filter(f => f.url);
    if (!feeds.length) return { added: 0, errors: [] };

    const result = await fetchReitArticles(feeds, store.reitArticles || []);
    store.reitArticles    = result.articles;
    store.reitLastFetch   = new Date().toISOString();
    store.reitFetchErrors = result.errors;
    await writeStore(env, store);
    return { added: result.added, errors: result.errors };
  } finally {
    isReitFetching = false;
  }
}

async function fetchReitArticles(feeds, existingArticles) {
  // Auto-prune: same rationale as fetchNewsArticles — drop stored articles
  // whose feedId no longer exists in REIT_FEEDS.
  const validFeedIds = new Set(feeds.map(f => f.id));
  let articles = existingArticles.filter(a => validFeedIds.has(a.feedId));
  let addedIds = [];
  const errors = [];

  await Promise.allSettled(feeds.map(async feed => {
    try {
      const newOnes = await fetchFeed(feed, articles, { filterDeals: true });
      addedIds.push(...newOnes.map(a => a.id));
      articles  = articles.concat(newOnes);
    } catch (e) {
      errors.push({ feedId: feed.id, feedName: feed.name, error: e.message });
    }
  }));

  articles = dedupeAndCluster(articles.map(repairArticle));
  articles.sort((a, b) => b.timestamp - a.timestamp);

  const survivingIds = new Set(articles.map(a => a.id));
  const added = addedIds.filter(id => survivingIds.has(id)).length;

  return { articles: articles.slice(0, REIT_MAX), errors, added };
}

// ── PER-FEED FETCHER ──────────────────────────────────────────────────
async function fetchFeed(feed, existingArticles, opts = {}) {
  const existingIds = new Set(existingArticles.map(a => a.id));

  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 8000);

  let resp;
  try {
    resp = await fetch(feed.url, {
      headers: { 'User-Agent': 'Dispatch/1.0 RSS Reader' },
      signal:  controller.signal,
      cf:      { cacheTtl: 55 },
    });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Feed timed out after 8s');
    throw e;
  } finally {
    clearTimeout(timeout);
  }

  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const rawText = await resp.text();

  const sniff = rawText.trimStart().slice(0, 100).toLowerCase();
  if (sniff.startsWith('<!doctype html') || sniff.startsWith('<html')) {
    throw new Error('URL returned HTML not RSS — check feed URL.');
  }

  const items       = parseRSS(rawText);
  const newArticles = [];
  const isGoogle    = feed.url.includes('news.google.com');

  for (const item of items) {
    if (!item.title) continue;
    const rawTitle       = isGoogle ? stripGoogleSuffix(item) : item.title;
    const title          = decodeEntities(rawTitle);
    const decodedDesc    = decodeEntities(item.description || '');
    // Pull a thumbnail from feed metadata first, falling back to the first
    // <img> inside the description HTML. Do this BEFORE stripping tags.
    const imageUrl       = item.enclosureImage || item.mediaImage ||
                            extractImageFromHtml(decodedDesc) || null;
    // Strip HTML tags / boilerplate out of the description so the reader
    // shows plain text instead of raw markup (<div><img ...> etc.).
    const description    = cleanDescriptionText(decodedDesc);

    let category = null;
    if (opts.filterDeals) {
      category = classifyFiling(title, description);
      if (!category) continue;
    }

    // Stable ID = feedId + hash(normalised link + title). Strips utm_ /
    // tracking params so the same article gets one id across polls.
    // Exception: for X/Twitter posts (this app's rss.app-converted feeds),
    // prefer the numeric tweet id embedded in the URL over the link+title
    // hash. Those feeds can have titles/link wrappers that drift very
    // slightly between fetches — engagement-count text, redirect params —
    // which would otherwise mint a brand-new id for the same post on every
    // re-fetch and silently flip it back to "unread". The tweet id itself
    // never changes.
    const tweetIdMatch = (item.link || '').match(/(?:twitter|x)\.com\/[^/]+\/status(?:es)?\/(\d+)/i);
    const normLink = normaliseUrl(item.link || '');
    const idSeed   = tweetIdMatch ? tweetIdMatch[1] : (normLink + '|' + title.slice(0, 120));
    const id       = feed.id + '_' + fnv1a(idSeed);

    if (existingIds.has(id)) continue;
    existingIds.add(id);

    newArticles.push({
      id,
      feedId:    feed.id,
      feedName:  feed.name,
      title,
      link:      item.link || '',
      description,
      imageUrl,
      pubDate:   item.pubDate || '',
      timestamp: Date.parse(item.pubDate || '') || Date.now(),
      ...(category ? { category } : {}),
    });
  }
  return newArticles;
}

// ── RSS PARSER ────────────────────────────────────────────────────────
function parseRSS(xml) {
  xml = xml.replace(/^\uFEFF/, '');
  xml = xml.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  xml = xml.replace(/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)/g, '&amp;');

  const items = [];
  const rx    = /<(item|entry)[\s>][\s\S]*?<\/\1>/gi;
  let m;
  while ((m = rx.exec(xml)) !== null) {
    const b = m[0];
    items.push({
      title:          extractTag(b, 'title'),
      link:           extractLink(b),
      description:    extractTag(b, 'description') || extractTag(b, 'summary'),
      pubDate:        extractTag(b, 'pubDate') || extractTag(b, 'published') || extractTag(b, 'updated'),
      source:         extractTag(b, 'source'),
      enclosureImage: extractEnclosureImage(b),
      mediaImage:     extractMediaImage(b),
    });
  }
  return items;
}

function extractTag(block, tag) {
  const rx = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))<\\/${tag}>`, 'i');
  const m  = block.match(rx);
  if (!m) return '';
  return (m[1] !== undefined ? m[1] : m[2] || '').trim();
}

function extractLink(block) {
  const rss = block.match(/<link[^>]*>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))<\/link>/i);
  if (rss) {
    const v = (rss[1] !== undefined ? rss[1] : rss[2] || '').trim();
    if (v && !v.startsWith('<')) return v;
  }
  const atom = block.match(/<link[^>]+href=["']([^"']+)["']/i);
  if (atom) return atom[1];
  return '';
}

// <enclosure url="..." type="image/jpeg" length="..."/>
function extractEnclosureImage(block) {
  const rx = /<enclosure\b[^>]*>/gi;
  let m;
  while ((m = rx.exec(block)) !== null) {
    const tag   = m[0];
    const typeM = tag.match(/type=["']([^"']+)["']/i);
    const urlM  = tag.match(/url=["']([^"']+)["']/i);
    if (urlM && (!typeM || /^image\//i.test(typeM[1]))) return urlM[1];
  }
  return '';
}

// Media RSS: <media:content url="..." medium="image"/> or <media:thumbnail url="..."/>
function extractMediaImage(block) {
  let m = block.match(/<media:content\b[^>]*>/i);
  if (m) {
    const tag     = m[0];
    const urlM    = tag.match(/url=["']([^"']+)["']/i);
    const mediumM = tag.match(/medium=["']([^"']+)["']/i);
    if (urlM && (!mediumM || /image/i.test(mediumM[1]))) return urlM[1];
  }
  m = block.match(/<media:thumbnail\b[^>]*url=["']([^"']+)["']/i);
  if (m) return m[1];
  return '';
}

// First <img src="..."> found in an HTML blob (used as a fallback thumbnail
// source when the feed doesn't provide enclosure/media metadata).
function extractImageFromHtml(html) {
  if (!html) return null;
  const m = String(html).match(/<img[^>]+src=["']([^"']+)["']/i);
  return m ? m[1] : null;
}

function decodeEntities(str) {
  if (!str) return '';
  return str
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g,           (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g,  '&');
}

// URL normalisation for stable dedupe hashes.
function normaliseUrl(link) {
  if (!link) return '';
  try {
    const u = new URL(link);
    const drop = /^(utm_|fbclid$|gclid$|mc_|ref$|ref_src$|cmpid$|cid$|src$)/i;
    const keep = [];
    u.searchParams.forEach((v, k) => { if (!drop.test(k)) keep.push([k, v]); });
    u.search = keep.length ? '?' + keep.map(([k, v]) => `${k}=${v}`).join('&') : '';
    u.hash   = '';
    return u.toString().replace(/\/$/, '').toLowerCase();
  } catch {
    return String(link).toLowerCase().split('#')[0];
  }
}

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

// Strip HTML down to a clean, single-paragraph text snippet for storage
// and display. Reuses htmlToText's tag/entity handling, then flattens
// whitespace/newlines since this is used as a short row-level snippet
// rather than a multi-line body.
function cleanDescriptionText(html) {
  return htmlToText(html)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

// ── DEDUPE + CLUSTER (by content, not just id/title) ───────────────────
// Some feeds are proxied/mirrored under more than one URL, or occasionally
// list the same story twice with slightly different links/tracking params.
// Those slip past the per-feed id check (which is link+title based), so we
// run a second pass over the FULLY MERGED list (existing + newly fetched).
// This also self-heals any duplicates already sitting in storage, since it
// runs across the whole array on every fetch — not just newly added items.
//
// This used to be an exact-match fingerprint (normalised title + day +
// first 200 chars of description). That broke in two common cases:
//   1. Mirrored/scraped feeds (rss.app etc.) often stamp their own scrape
//      time rather than the original pubDate, so the same story can land
//      on opposite sides of a UTC day boundary and get different date
//      buckets — silently skipping the dedupe.
//   2. Requiring the first 200 chars of description to match *exactly*
//      is brittle: a mirror that trims a byline, a "(Reuters) -" prefix
//      on one copy but not another, or a re-encoded quote mark is enough
//      to shift the whole slice and break the match.
// Token-set (Jaccard) similarity over title+description fixes both: it's
// tolerant of minor wording/formatting differences, and time proximity is
// checked with a sliding window instead of a hard calendar-day bucket.
//
// It also gives us "related coverage" clustering for free at a lower
// threshold: articles too different to be the *same* copy, but clearly
// about the *same event* from different publishers (e.g. Reuters vs.
// Bloomberg on the same story), get tagged with a shared clusterId so the
// frontend can group them under one row instead of listing near-identical
// entries separately.
const DEDUPE_THRESHOLD   = 0.72; // token overlap → literal duplicate, drop
const CLUSTER_THRESHOLD  = 0.32; // token overlap → related coverage, keep both, link them
const CLUSTER_WINDOW_MS  = 48 * 60 * 60 * 1000; // only compare articles within 48h of each other
const MIN_TOKENS_TO_COMPARE = 4; // sparse title/desc → too little signal, never merge

const STOPWORDS = new Set([
  'the','a','an','of','to','in','on','for','and','or','is','are','was','were',
  'with','at','by','as','it','its','this','that','from','after','over','amid',
  'says','say','said','will','has','have','had','be','been','but','not','new',
]);

function normaliseForFingerprint(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9\u00c0-\u024f\u4e00-\u9fff\u3040-\u30ff\u3400-\u4dbf]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenSet(a) {
  const text = normaliseForFingerprint(a.title) + ' ' + normaliseForFingerprint(a.description).slice(0, 300);
  const out = new Set();
  for (const w of text.split(' ')) {
    if (w.length > 2 && !STOPWORDS.has(w)) out.add(w);
  }
  return out;
}

function jaccard(setA, setB) {
  if (!setA.size || !setB.size) return 0;
  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union ? intersection / union : 0;
}

function dedupeAndCluster(articles) {
  // Process oldest → newest so the earliest-seen copy of a duplicate/
  // cluster becomes the representative that survives.
  const sorted = [...articles].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  const kept = [];
  const tokenCache = new Map();
  const getTokens = a => {
    if (!tokenCache.has(a.id)) tokenCache.set(a.id, tokenSet(a));
    return tokenCache.get(a.id);
  };

  // `kept` is ascending by timestamp and we only ever compare a new
  // article against recent-enough entries, so windowStart only moves
  // forward — this keeps the whole pass close to linear instead of
  // rescanning the full history (up to NEWS_MAX) for every article.
  let windowStart = 0;

  for (const a of sorted) {
    const aTime = a.timestamp || 0;
    while (windowStart < kept.length && aTime - (kept[windowStart].timestamp || 0) > CLUSTER_WINDOW_MS) {
      windowStart++;
    }

    const aTokens = getTokens(a);
    if (aTokens.size < MIN_TOKENS_TO_COMPARE) { kept.push(a); continue; }

    let duplicateOf = null;
    let bestCluster = null;
    for (let i = windowStart; i < kept.length; i++) {
      const k = kept[i];
      const kTokens = getTokens(k);
      if (kTokens.size < MIN_TOKENS_TO_COMPARE) continue;
      const sim = jaccard(aTokens, kTokens);
      if (sim >= DEDUPE_THRESHOLD) { duplicateOf = k; break; }
      if (sim >= CLUSTER_THRESHOLD && (!bestCluster || sim > bestCluster.sim)) bestCluster = { article: k, sim };
    }

    if (duplicateOf) continue; // literal duplicate — drop, keep the earlier copy

    if (bestCluster) {
      const rootId = bestCluster.article.clusterId || bestCluster.article.id;
      a.clusterId = rootId;
      bestCluster.article.clusterId = rootId;
    }
    kept.push(a);
  }
  return kept;
}


// Repairs articles that were stored before this cleanup existed: strips any
// leftover raw HTML out of the description and backfills imageUrl by
// scavenging the (still-dirty) description for an <img> tag. Cheap no-op for
// articles that are already clean.
function repairArticle(a) {
  const desc       = a.description || '';
  const looksDirty = /<[a-z!/][\s\S]{0,300}?>/i.test(desc);
  if (!looksDirty && a.imageUrl !== undefined) return a;

  const imageUrl = (a.imageUrl !== undefined && a.imageUrl !== null)
    ? a.imageUrl
    : extractImageFromHtml(desc);
  const description = looksDirty ? cleanDescriptionText(desc) : desc;

  return { ...a, description, imageUrl: imageUrl || null };
}

function stripGoogleSuffix(item) {
  const title  = item.title  || '';
  const source = item.source || '';
  if (source && title.endsWith(' - ' + source)) {
    return title.slice(0, title.length - source.length - 3).trim();
  }
  return title;
}

// ── HTML → TEXT EXTRACTION (used by fetchAndTranslate) ────────────────
function htmlToText(raw) {
  if (!raw) return '';
  return String(raw)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<(br|p|div|li|tr|h1|h2|h3|h4|h5|h6)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g,  '<')
    .replace(/&gt;/g,  '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/\n\s*\n\s*\n/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s+\n/g, '\n')
    .trim();
}

// ── GEMINI ────────────────────────────────────────────────────────────
async function callGemini(apiKey, systemPrompt, userContent, model) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ parts: [{ text: userContent }] }],
    generationConfig: { temperature: 0.3 },
  };
  if (systemPrompt) body.systemInstruction = { parts: [{ text: systemPrompt }] };

  try {
    const resp = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    const json = await resp.json();
    if (!resp.ok) return { success: false, error: `Gemini ${resp.status}: ${JSON.stringify(json).slice(0, 300)}` };
    const text = json.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
    if (!text) return { success: false, error: 'Empty Gemini response' };
    return { success: true, text };
  } catch (e) {
    return { success: false, error: e.message };
  }
}
