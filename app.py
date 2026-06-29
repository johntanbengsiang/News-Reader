import os
from datetime import datetime
from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse
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
            model='gemini-2.5-pro', # Using Pro for deep analysis and reasoning
            contents=req.headlines,
            config=types.GenerateContentConfig(
                system_instruction=system_prompt,
                temperature=0.3
            )
        )
        return {"content": response.text}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# Serve the HTML frontend directly from the root
@app.get("/")
async def serve_frontend():
    with open("index.html", "r", encoding="utf-8") as f:
        html_content = f.read()
    return HTMLResponse(content=html_content)
  
