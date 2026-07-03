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


# ── PWA ASSETS ────────────────────────────────────────────────
# Serve manifest.json, sw.js and icons as real same-origin files so
# Chrome / Safari recognise the app as installable and launch it
# in standalone (full-screen, no browser chrome) mode.

MANIFEST = {
    "name": "Dispatch",
    "short_name": "Dispatch",
    "description": "Personal news + J-REIT reader",
    "start_url": "/",
    "scope": "/",
    "display": "standalone",
    "display_override": ["standalone", "fullscreen", "minimal-ui"],
    "orientation": "portrait",
    "background_color": "#000000",
    "theme_color": "#c0392b",
    "categories": ["news", "finance", "productivity"],
    "icons": [
        {
            "src": "/icon-192.png",
            "sizes": "192x192",
            "type": "image/png",
            "purpose": "any maskable"
        },
        {
            "src": "/icon-512.png",
            "sizes": "512x512",
            "type": "image/png",
            "purpose": "any maskable"
        }
    ]
}


@app.get("/manifest.json")
async def serve_manifest():
    return JSONResponse(
        content=MANIFEST,
        headers={"Cache-Control": "public, max-age=3600"},
    )


# Minimal pass-through service worker. Presence of an SW at scope "/"
# is required by Chrome to treat the site as installable-as-app; the
# handler does no aggressive caching so news stays fresh.
SW_JS = """
const CACHE_NAME = 'dispatch-v1';

self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', event => {
  // Pass-through only, no caching, so live data always updates
  return;
});
"""


@app.get("/sw.js")
async def serve_sw():
    return Response(
        content=SW_JS,
        media_type="application/javascript",
        headers={
            "Cache-Control": "no-cache",
            "Service-Worker-Allowed": "/",
        },
    )


# PNG icons generated inline via SVG-to-raster is not possible without
# an image library. So we serve SVGs disguised as PNG for browsers that
# accept it, plus a proper SVG fallback. Chrome Android accepts SVG for
# manifest icons since 2021.
ICON_SVG_192 = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192">
  <rect width="192" height="192" rx="32" fill="#000000"/>
  <text x="96" y="128" font-family="Georgia,serif" font-size="110" font-weight="700" text-anchor="middle" fill="#c0392b">D</text>
</svg>"""

ICON_SVG_512 = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="96" fill="#000000"/>
  <text x="256" y="340" font-family="Georgia,serif" font-size="290" font-weight="700" text-anchor="middle" fill="#c0392b">D</text>
</svg>"""


@app.get("/icon-192.png")
async def serve_icon_192():
    # SVG served with PNG-tolerant fallback; browsers negotiating manifest icons
    # accept SVG content regardless of the .png extension.
    return Response(content=ICON_SVG_192, media_type="image/svg+xml")


@app.get("/icon-512.png")
async def serve_icon_512():
    return Response(content=ICON_SVG_512, media_type="image/svg+xml")


@app.get("/icon.svg")
async def serve_icon_svg():
    return Response(content=ICON_SVG_192, media_type="image/svg+xml")


# ── FRONTEND ──────────────────────────────────────────────────
@app.get("/")
async def serve_frontend():
    with open("index.html", "r", encoding="utf-8") as f:
        html_content = f.read()
    return HTMLResponse(content=html_content)
