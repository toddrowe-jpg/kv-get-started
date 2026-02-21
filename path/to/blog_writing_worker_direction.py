===========================================================================
# BLOG WRITING WORKER DIRECTION - COMPLETE CONSOLIDATED VERSION
# ============================================================================
# Organization: Modular structure with consolidated imports, no conflicts
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
    sources: list[str]

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
def call_llm(messages: List[Dict], model: str = "YOUR_MODEL") -> str:
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

# ... [Content truncated for brevity] ...

# ========== ENTRY POINT ==========
if __name__ == "__main__":
    run_daily_blog_worker()