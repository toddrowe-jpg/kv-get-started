# ============================================================================
# BLOG WRITING WORKER DIRECTION - COMPLETE CONSOLIDATED VERSION
# ============================================================================
# Organization: Modular structure with consolidated imports, no conflicts,
# or redundancy. All sections properly ordered with dependencies resolved.
# ============================================================================

# ========== MODULE 1: CONSOLIDATED IMPORTS ==========
import json
import datetime as dt
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import List, Dict, Tuple, Optional
import yaml
import requests
from bs4 import BeautifulSoup

# ========== MODULE 2: GLOBAL CONSTANTS & CONFIGURATION ==========
USER_AGENT = "BITXCapitalBlogWorker/1.0 (+https://bitxcapital.com)"
TIMEOUT = 20
DASH_FORBIDDEN = ["—", "–"]
CITATION_PATTERN = re.compile(r"\(Source\s[12]\)")

# ========== MODULE 3: DATA MODELS ==========
@dataclass
class BlogBrief:
    """Configuration model for blog brief information"""
    topic: str
    audience: str
    primary_keyword: str
    goal: str
    angle: str
    word_count: int
    sources: list

@dataclass
class SourceDoc:
    """Model for source documents retrieved from web search"""
    url: str
    title: str
    text: str

# ========== MODULE 4: FILE & DATA LOADERS ==========
def load_yaml(path: str) -> dict:
    """Load YAML configuration file"""
    with open(path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)

def load_brief(path: str) -> BlogBrief:
    """Load blog brief from JSON file"""
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    return BlogBrief(**data)

# ========== MODULE 5: CORE LLM INTERFACE (DEFINED ONCE) ==========
def call_llm(messages: List[Dict], model: str = "gpt-4") -> str:
    """
    Core LLM interface - wire this to your LLM provider.
    
    Supports: OpenAI, Anthropic, Cohere, local models, etc.
    Must return assistant text content as string.
    """
    raise NotImplementedError(
        "Wire this to your LLM provider (OpenAI/Anthropic/etc). "
        "Must accept messages list and return assistant text."
    )

# ========== MODULE 6: WEB SEARCH & HTML EXTRACTION ==========
def web_search_two_results(query: str) -> List[str]:
    """
    Return exactly 2 URLs relevant to the query.
    
    Implement using preferred search API:
    - SerpAPI
    - Bing Web Search API
    - Google Programmable Search Engine
    - Brave Search API
    
    For safety: restrict to reputable domains (gov, edu, major publishers, regulators)
    """
    raise NotImplementedError(
        "Implement using a web search API and return exactly 2 URLs."
    )

def fetch_html(url: str) -> str:
    """Fetch HTML content from URL with proper headers and timeout"""
    headers = {"User-Agent": USER_AGENT}
    r = requests.get(url, headers=headers, timeout=TIMEOUT)
    r.raise_for_status()
    return r.text

def extract_main_text(html: str) -> Tuple[str, str]:
    """Extract main text and title from HTML.
    
    Returns: (title, cleaned_text)
    Note: Lightweight extractor. Upgrade to trafilatura/readability-lxml for production.
    """
    soup = BeautifulSoup(html, "html.parser")
    
    title = (soup.title.get_text(strip=True) if soup.title else "").strip()
    
    for tag in soup(["script", "style", "noscript", "svg", "footer", "header", "nav", "aside"]):
        tag.decompose()
    
    text = soup.get_text("\n", strip=True)
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    cleaned = "\n".join(lines)
    
    return title[:200], cleaned[:12000]

def load_sources(urls: List[str]) -> List[SourceDoc]:
    """Fetch and parse multiple sources from URLs"""
    docs: List[SourceDoc] = []
    for url in urls:
        html = fetch_html(url)
        title, text = extract_main_text(html)
        if len(text) < 800:
            raise ValueError(f"Source too thin or blocked: {url}")
        docs.append(SourceDoc(url=url, title=title, text=text))
        time.sleep(0.5)
    return docs

# ========== MODULE 7: PROMPT BUILDERS ==========
def system_prompt(style_guide: dict, brand_kit: dict) -> str:
    """Generate system prompt with style guide and brand kit"""
    return f"""
You are a professional blog writing worker.

NON-NEGOTIABLE RULES:
- Follow the STYLE GUIDE and BRAND KIT exactly.
- Use active voice whenever possible.
- Use transitions to improve flow (per style guide).
- Maintain consistent brand tone and terminology.
- Avoid forbidden phrases.
- Output in Markdown.

STYLE GUIDE (authoritative):
{json.dumps(style_guide, indent=2)}

BRAND KIT (authoritative):
{json.dumps(brand_kit, indent=2)}
""".strip()

def outline_prompt(brief: BlogBrief) -> str:
    """Generate prompt for creating blog outline"""
    return f"""
Create a detailed blog outline for this brief.

BRIEF:
- Topic: {brief.topic}
- Audience: {brief.audience}
- Primary keyword: {brief.primary_keyword}
- Goal: {brief.goal}
- Angle: {brief.angle}
- Word count: ~{brief.word_count}
- Sources to reference: {brief.sources}

Return:
1) High CTR Title options (5)
2) One chosen title
3) Meta description (<= 155 chars)
4) Outline with H2/H3s and bullet notes under each
5) Suggested CTA
""".strip()

def draft_prompt(brief: BlogBrief, outline: str) -> str:
    """Generate prompt for drafting blog post"""
    return f"""
Write the full blog post based on the outline.

BRIEF:
- Topic: {brief.topic}
- Audience: {brief.audience}
- Primary keyword: {brief.primary_keyword}
- Goal: {brief.goal}
- Angle: {brief.angle}
- Target length: ~{brief.word_count} words

OUTLINE:
{outline}

Requirements:
- Use short paragraphs.
- Include transitions between major sections.
- Prefer active voice.
- Include a clear CTA near the end.
- Naturally include the primary keyword (no stuffing).
Return only the Markdown blog post.
""".strip()

# ========== MODULE 8: VALIDATORS ==========
def validate_no_dashes(md: str) -> None:
    """Ensure no em dashes or en dashes in content"""
    for ch in DASH_FORBIDDEN:
        if ch in md:
            raise ValueError("Found forbidden dash character (— or –).")

# ... [remaining content is unchanged] ...
