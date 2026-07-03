import os
from datetime import datetime
from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse, Response
from pydantic import BaseModel
from google import genai
from google.genai import types

app = FastAPI()

# The client automatically picks up the GEMINI_API_KEY environment variable
try:
    client = genai.Client()
except Exception as e:
    client = None


class SummaryRequest(BaseModel):
    headlines: str


@app.post("/api/summary")
async def generate_summary(req: SummaryRequest):
    if not client:
        raise HTTPException(status_code=500, detail="Gemini API key not configured on server.")

    current_date = datetime.now().strftime("%B %d, %Y")

    system_prompt = f"""You are an Analyst working for a global investment firm. Your daily task is to deliver a concise, high-signal briefing on the most important macroeconomic and political drivers/events that will influence markets worldwide.

Requirements:
- Search widely across trustworthy sources (Financial Times, Reuters, Bloomberg, WSJ, The Economist, South China Morning Post, Nikkei, Straits Times, Caixin, major central bank sites, IMF/World Bank, official government releases, etc.). Include non-English sources when relevant (translate key points accurately).
- Provide at least 20 distinct, high-impact headlines from news articles, divided into clear categories (e.g., Monetary Policy & Interest Rates, Geopolitics & Trade, Economic Data & Growth, Inflation & Energy, Regional/Regulatory Developments, etc.).
- For each headline or group: Source + date, 1-sentence neutral summary, and a brief assessment of potential impact on global markets.

Opinion & Analysis Section - Source and summarize at least 5 high-quality opinion, commentary, or in-depth analysis articles (op-eds, research house outlooks, expert columns from reputable outlets). For each:
- Title, author/source, date
- 2-4 sentence summary of the core thesis
- Key implications for global markets

Deeper Dive: For the top 3-5 most important news items and all opinion/analysis pieces, provide additional 1-2 sentences of forward-looking analysis. Prioritize forward-looking insights over pure recaps.
- End with a short "Key Takeaways" section (4-6 bullets) highlighting biggest risks, opportunities, and watchpoints. Flag uncertainties or conflicting signals.
- Keep the entire briefing professional, balanced, objective, and easy to read with markdown. Use clear headings, numbered lists, and bold for emphasis.

Today's date is {current_date}. Run this fresh daily."""

    try:
        response = client.models.generate_content(
            model='gemini-2.5-pro',
            contents=req.headlines,
            config=types.GenerateContentConfig(
                system_instruction=system_prompt,
                temperature=0.3
            )
        )
        return {"content": response.text}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── PWA ASSETS ──────────────────────────────────────────────────
# Chrome PWA install requirements (verified against Chrome dev docs):
#   1. HTTPS  (HF Spaces provides this)
#   2. Linked manifest.json with:
#        - name / short_name
#        - start_url
#        - display = standalone / fullscreen / minimal-ui
#        - icons (192px and 512px, or SVG with sizes="any")
#   3. Service worker registered at scope "/"
#   4. Service worker with a functional (non-empty) fetch handler
#      (still needed for auto-install prompt, though menu-install
#      works since Chrome 108 without it)

MANIFEST = {
    "name": "Dispatch",
    "short_name": "Dispatch",
    "description": "Personal news + J-REIT reader",
    "start_url": "/",
    "scope": "/",
    "id": "/",
    "display": "standalone",
    "display_override": ["standalone", "fullscreen", "minimal-ui"],
    "orientation": "portrait",
    "background_color": "#000000",
    "theme_color": "#c0392b",
    "categories": ["news", "finance", "productivity"],
    "prefer_related_applications": False,
    "icons": [
        {
            "src": "/icon.svg",
            "sizes": "any",
            "type": "image/svg+xml",
            "purpose": "any"
        },
        {
            "src": "/icon-maskable.svg",
            "sizes": "any",
            "type": "image/svg+xml",
            "purpose": "maskable"
        }
    ]
}


@app.get("/manifest.json")
async def serve_manifest():
    return JSONResponse(
        content=MANIFEST,
        media_type="application/manifest+json",
        headers={"Cache-Control": "public, max-age=3600"},
    )


# Functional service worker with a REAL fetch handler.
# Chrome ignores empty fetch handlers, so this one actually does work:
# - Caches the app shell on install for offline use
# - Serves shell from cache when offline (navigation requests only)
# - Non-navigation requests (API, feeds) pass through untouched so
#   news content stays fresh
SW_JS = """// Dispatch service worker
// Registered at scope "/" by index.html
// Chrome PWA install requires a non-empty fetch handler.

const CACHE_NAME = 'dispatch-shell-v2';
const SHELL_URL = '/';

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.add(SHELL_URL))
      .catch(err => console.warn('SW shell cache failed:', err))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    Promise.all([
      caches.keys().then(names =>
        Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n)))
      ),
      self.clients.claim()
    ])
  );
});

self.addEventListener('fetch', event => {
  // Only intercept navigation requests (main HTML page loads).
  // Everything else — API calls to the Cloudflare Worker, RSS fetches,
  // icons — passes through to the network untouched. This keeps the
  // news feed and REIT data live at all times.
  if (event.request.mode !== 'navigate') {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .catch(() => caches.match(SHELL_URL))
  );
});
"""


@app.get("/sw.js")
async def serve_sw():
    return Response(
        content=SW_JS,
        media_type="application/javascript",
        headers={
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Service-Worker-Allowed": "/",
        },
    )


# SVG icons — Chrome accepts SVG in manifest since v80 when declared
# with sizes="any" and type="image/svg+xml".
ICON_SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="96" fill="#000000"/>
  <text x="256" y="345" font-family="Georgia,serif" font-size="290" font-weight="700" text-anchor="middle" fill="#c0392b">D</text>
</svg>"""

# Maskable variant: safe zone is inner 80% (per Android adaptive icon spec).
# The background extends to the full canvas so system masks look clean.
ICON_MASKABLE_SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#000000"/>
  <text x="256" y="325" font-family="Georgia,serif" font-size="220" font-weight="700" text-anchor="middle" fill="#c0392b">D</text>
</svg>"""


@app.get("/icon.svg")
async def serve_icon():
    return Response(
        content=ICON_SVG,
        media_type="image/svg+xml",
        headers={"Cache-Control": "public, max-age=86400"},
    )


@app.get("/icon-maskable.svg")
async def serve_icon_maskable():
    return Response(
        content=ICON_MASKABLE_SVG,
        media_type="image/svg+xml",
        headers={"Cache-Control": "public, max-age=86400"},
    )


# Apple touch icon fallback (iOS Safari doesn't use manifest icons)
@app.get("/apple-touch-icon.png")
async def serve_apple_touch_icon():
    # Serve SVG with PNG-like extension; iOS accepts both
    return Response(
        content=ICON_SVG,
        media_type="image/svg+xml",
        headers={"Cache-Control": "public, max-age=86400"},
    )


# Favicon
@app.get("/favicon.ico")
async def serve_favicon():
    return Response(
        content=ICON_SVG,
        media_type="image/svg+xml",
    )


# ── FRONTEND ────────────────────────────────────────────────────
@app.get("/")
async def serve_frontend():
    with open("index.html", "r", encoding="utf-8") as f:
        html_content = f.read()
    return HTMLResponse(content=html_content)
