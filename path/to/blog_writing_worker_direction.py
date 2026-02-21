# ============================================================================
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


def extract_main_text(html: str) -> Tuple[str, str]:
    """Extract main text and title from HTML.
    
    Returns: (title, cleaned_text)
    Note: Lightweight extractor. Upgrade to trafilatura/readability-lxml for production.
    """
    soup = BeautifulSoup(html, "html.parser")
    
    title = (soup.title.get_text(strip=True) if soup.title else "").strip()
    
    # Remove junk elements
    for tag in soup(["script", "style", "noscript", "svg", "footer", "header", "nav", "aside"]):
        tag.decompose()
    
    text = soup.get_text("\n", strip=True)
    # De-dupe blank lines
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    cleaned = "\n".join(lines)
    
    # Truncate to reduce token load
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
        time.sleep(0.5)  # Be polite to servers
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


def edit_prompt(draft_md: str) -> str:
    """Generate prompt for editing blog post for compliance"""
    return f"""
Edit the draft to strictly comply with the STYLE GUIDE and BRAND KIT.

Do:
- Convert passive voice to active where feasible.
- Add transitions where the flow is choppy.
- Enforce brand phrasing and remove forbidden terms.
- Tighten sentences, remove fluff, keep it readable.
- Keep structure (headings) unless fixing clarity.

Return:
1) Final Markdown post only.
2) Then a short bullet list titled "Edits made" with 6-12 bullets.
""".strip()


def build_blog_prompt(keyword: str, angle: str) -> str:
    """Generate comprehensive blog writing prompt with all requirements"""
    return f"""
Write a blog targeting the long-tail keyword:
"{keyword}"

Blog format: {angle}

NON-NEGOTIABLE REQUIREMENTS:
- First mention must use "BITX Capital"
- Use bitxcapital.com only in the CTA
- Institutional tone, confident and disciplined
- Prefer active voice
- Add transitions between major sections
- 4–6 H2 sections
- Include a dedicated FAQ section near the end with EXACTLY 4 questions.
- Each FAQ must have:
  - a bold question line
  - a concise answer (2–4 sentences)
- The FAQs must be specific to the keyword and not generic.

OUTPUT FORMAT (Markdown):
- Use H2 for main sections.
- Include this exact header: "## FAQs"
- Under it, include exactly 4 Q&As in this format:

**Q1: ...?**  
A: ...

**Q2: ...?**  
A: ...

**Q3: ...?**  
A: ...

**Q4: ...?**  
A: ...

Length: 1,200–1,600 words.
Return Markdown only.
""".strip()


def build_strict_writer_messages(
    keyword: str,
    angle: str,
    sources: List[SourceDoc],
) -> List[Dict]:
    """Build system and user messages for strict source-backed blog writing"""
    s1, s2 = sources[0], sources[1]

    system = f"""
You are a blog writing worker for BITX Capital.

HARD RULES (NO EXCEPTIONS):
- Use active voice.
- No em dashes (—) and no en dashes (–). Use commas or parentheses instead.
- You MUST back up key claims using ONLY the two provided sources.
- Do NOT add facts not present in the sources. If a fact is not in the sources, omit it.
- Every section with factual claims must include an inline backlink to the supporting source.
- Use exactly these sources and no others:
  - Source 1 URL: {s1.url}
  - Source 2 URL: {s2.url}

CITATION STYLE:
- When you use a fact from Source 1, add: (Source 1) and include a markdown backlink near the claim: [{s1.title or "Source 1"}]({s1.url})
- When you use a fact from Source 2, add: (Source 2) and include a markdown backlink near the claim: [{s2.title or "Source 2"}]({s2.url})

OUTPUT:
- Markdown blog post.
- 4 to 6 H2 sections.
- Include "## FAQs" with EXACTLY 4 Q&As at the end.
- CTA near the end referencing bitxcapital.com (domain only as website mention).

If you are unsure, say it is not covered by the sources and remove it.
""".strip()

    user = f"""
Target long-tail keyword: "{keyword}"
Format/angle: {angle}
Length: 1,200 to 1,600 words

SOURCE 1 (use as evidence):
Title: {s1.title}
URL: {s1.url}
CONTENT:
"""{s1.text}"""

SOURCE 2 (use as evidence):
Title: {s2.title}
URL: {s2.url}
CONTENT:
"""{s2.text}"""

Write the blog now. Remember: no em dashes, and add inline backlinks to the source near the supported claim.
""".strip()

    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def build_summary_messages(keyword: str, blog_md: str) -> List[Dict]:
    """Build prompts for generating high-CTR summary"""
    system = """
You are an expert editor writing a top-of-post summary for a blog.

Hard rules:
- Write 4 to 5 sentences total.
- High CTR: make it punchy and benefit-led, but not hypey.
- Match an institutional tone for BITX Capital.
- No em dashes (—) and no en dashes (–).
- No new facts. Only summarize what is already in the blog.
- Avoid clickbait. Be specific.

Output exactly this format (Markdown), nothing else:

> <sentence 1> <sentence 2> <sentence 3> <sentence 4> [<sentence 5 if needed>]
""".strip()

    user = f"""
Target keyword: "{keyword}"

BLOG (Markdown):
{blog_md}

Write the summary now.
""".strip()

    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def build_table_messages(keyword: str, blog_md: str) -> List[Dict]:
    """Build prompts for generating HTML comparison table"""
    system = """
You create a single HTML comparison table to embed inside a Markdown blog post.

Hard rules:
- Output ONLY valid HTML (no Markdown, no backticks).
- Produce exactly ONE <table> element (no surrounding <html> or <body>).
- No em dashes (—) and no en dashes (–).
- No new facts. Use only information already present in the blog.
- Keep it broadly useful: a comparison chart relevant to the keyword.
- 4 to 7 rows, 3 to 5 columns.
- Use <thead>, <tbody>, <th>, <tr>, <td>.
- Keep cell text concise (max ~12 words per cell).
- Do not include external links.

If the blog lacks enough detail to compare, create a generic decision table that summarizes options mentioned in the blog without adding new facts.
""".strip()

    user = f"""
Target keyword: "{keyword}"

BLOG (Markdown):
{blog_md}

Create the HTML table now.
""".strip()

    return [{"role": "system", "content": system}, {"role": "user", "content": user}]

# ========== MODULE 8: VALIDATORS ==========
def validate_no_dashes(md: str) -> None:
    """Ensure no em dashes or en dashes in content"""
    for ch in DASH_FORBIDDEN:
        if ch in md:
            raise ValueError("Found forbidden dash character (— or –).")


def validate_two_sources_only(md: str, sources: List[SourceDoc]) -> None:
    """Validate only two sources are referenced and no disallowed links present"""
    # Ensure both sources are present as backlinks
    for s in sources:
        if s.url not in md:
            raise ValueError(f"Missing backlink to required source: {s.url}")

    # Disallow other http(s) links besides the two sources and bitxcapital.com
    allowed = set([sources[0].url, sources[1].url, "https://bitxcapital.com", "http://bitxcapital.com"])
    found = set(re.findall(r"https?://[^"]+", md))
    extras = {u for u in found if u not in allowed}
    if extras:
        raise ValueError(f"Found disallowed external links: {sorted(extras)[:5]}")


def validate_faqs(md: str) -> None:
    """Validate FAQ section exists with exactly 4 questions"""
    if "## FAQs" not in md:
        raise ValueError("Missing '## FAQs' section.")
    # Must include exactly Q1..Q4 lines
    q_matches = re.findall(r"^\*\*Q([1-4]):.*\?\*\*\s*$", md, flags=re.MULTILINE)
    if len(q_matches) != 4:
        raise ValueError(f"Expected exactly 4 FAQ questions (Q1–Q4). Found {len(q_matches)}.")


def validate_has_citations(md: str) -> None:
    """Require minimum citation count for fact-backed content"""
    cites = CITATION_PATTERN.findall(md)
    if len(cites) < 6:
        raise ValueError("Too few citations. Add more supported claims with (Source 1)/(Source 2).")


def validate_summary(summary_block: str) -> None:
    """Validate summary format and content"""
    # Must start with blockquote
    if not summary_block.strip().startswith(">"):
        raise ValueError("Summary must be a single Markdown blockquote starting with '>'.")

    # Block em/en dashes
    for ch in DASH_FORBIDDEN:
        if ch in summary_block:
            raise ValueError("Summary contains a forbidden dash character (— or –).")

    # Count sentences (simple heuristic)
    text = summary_block.lstrip(">").strip()
    sentences = [s.strip() for s in re.split(r"[.!?]+", text) if s.strip()]
    if not (4 <= len(sentences) <= 5):
        raise ValueError(f"Summary must be 4–5 sentences. Found {len(sentences)}.")


def validate_html_table(table_html: str) -> None:
    """Validate HTML table structure and content"""
    if any(ch in table_html for ch in DASH_FORBIDDEN):
        raise ValueError("Table contains a forbidden dash character (— or –).")

    stripped = table_html.strip()
    if "```" in stripped:
        raise ValueError("Table must be raw HTML only (no code fences).")

    # Must contain exactly one table element
    open_tables = len(re.findall(r"<table\b", stripped, flags=re.IGNORECASE))
    close_tables = len(re.findall(r"</table>", stripped, flags=re.IGNORECASE))
    if open_tables != 1 or close_tables != 1:
        raise ValueError("Output must contain exactly one <table>...</table>.")

    # Basic structure checks
    required_tags = ["<thead", "<tbody", "<tr", "<th", "<td"]
    for tag in required_tags:
        if re.search(tag, stripped, flags=re.IGNORECASE) is None:
            raise ValueError(f"Missing required HTML tag: {tag}")


def validate_all(md: str, sources: List[SourceDoc]) -> None:
    """Run all validators on blog content"""
    validate_no_dashes(md)
    validate_faqs(md)
    validate_has_citations(md)
    validate_two_sources_only(md, sources)

# ========== MODULE 9: BLOG GENERATION WORKFLOW ==========
def generate_blog_with_two_sources(keyword: str, angle: str) -> str:
    """Main workflow: Generate blog from web search sources with validation and repair.
    
    Steps:
    1. Search web for 2 relevant sources
    2. Generate blog from sources
    3. Validate against strict rules
    4. If validation fails, attempt auto-repair
    """
    urls = web_search_two_results(keyword)
    if len(urls) != 2:
        raise ValueError("Search must return exactly 2 URLs.")
    sources = load_sources(urls)

    messages = build_strict_writer_messages(keyword, angle, sources)
    draft = call_llm(messages)

    # Validate. If fails, run one repair pass.
    try:
        validate_all(draft, sources)
        return draft
    except Exception as e:
        repair_prompt = f"""
Fix the blog to pass validation:

Errors: {str(e)}

Rules:
- Keep meaning and structure.
- Add missing inline backlinks to the correct source.
- Remove any unsupported factual claims.
- Remove any external links not in the two sources or bitxcapital.com.
- Remove any em/en dashes.
- Ensure at least 6 citations using (Source 1) and/or (Source 2).
- Keep exactly 4 FAQs labeled Q1..Q4.

Return Markdown only.
BLOG:
{draft}
""".strip()

        repaired = call_llm([
            {"role": "system", "content": messages[0]["content"]},
            {"role": "user", "content": repair_prompt}
        ])
        validate_all(repaired, sources)
        return repaired

# ========== MODULE 10: SUMMARY INJECTION ==========
def inject_summary_at_top(blog_md: str, summary_block: str) -> str:
    """Insert summary after H1 title or at top of blog"""
    lines = blog_md.splitlines()
    if lines and lines[0].startswith("# "):
        # Insert after title + blank line
        out = [lines[0], "", summary_block.strip(), ""]
        out.extend(lines[1:])
        return "\n".join(out).strip() + "\n"
    else:
        return (summary_block.strip() + "\n\n" + blog_md.strip() + "\n")


def add_top_summary(keyword: str, blog_md: str, model: str = "YOUR_MODEL") -> str:
    """Generate and inject high-CTR summary at top of blog.
    Retries once with repair prompt if validation fails.
    """
    messages = build_summary_messages(keyword, blog_md)
    summary = call_llm(messages, model=model).strip()

    try:
        validate_summary(summary)
    except Exception as e:
        repair = f"""
Fix the summary to pass validation.

Error: {str(e)}

Rules:
- 4 to 5 sentences total
- One Markdown blockquote starting with '>'
- No em/en dashes
- No new facts
Return only the corrected summary blockquote.
SUMMARY:
{summary}
""".strip()
        summary = call_llm([{"role": "system", "content": messages[0]["content"]}, {"role": "user", "content": repair}], model=model).strip()
        validate_summary(summary)

    return inject_summary_at_top(blog_md, summary)

# ========== MODULE 11: HTML TABLE INSERTION ==========
def insert_table_into_blog(blog_md: str, table_html: str, after_heading: Optional[str] = None) -> str:
    """Insert HTML table after specified H2 or first H2 heading.
    Falls back to inserting after H1 title or at top.
    """
    lines = blog_md.splitlines()

    def find_h2_index(match_text: Optional[str]) -> Optional[int]:
        if not match_text:
            return None
        pattern = re.compile(rf"^##\s+{re.escape(match_text)}\s*$", re.IGNORECASE)
        for i, ln in enumerate(lines):
            if pattern.match(ln.strip()):
                return i
        return None

    # Prefer inserting after a specific H2
    idx = find_h2_index(after_heading)

    # Otherwise after the first H2
    if idx is None:
        for i, ln in enumerate(lines):
            if ln.startswith("## "):
                idx = i
                break

    insert_block = ["", "<!-- Comparison Table -->", table_html.strip(), ""]

    # If we found an H2, insert after its heading line + one blank line
    if idx is not None:
        out = lines[: idx + 1] + insert_block + lines[idx + 1 :]
        return "\n".join(out).strip() + "\n"

    # Else, if there's an H1 at top, insert after it
    if lines and lines[0].startswith("# "):
        out = [lines[0]] + insert_block + lines[1:]
        return "\n".join(out).strip() + "\n"

    # Else insert at top
    return ("\n".join(insert_block).strip() + "\n\n" + blog_md.strip() + "\n")


def add_html_comparison_table(
    keyword: str,
    blog_md: str,
    model: str = "YOUR_MODEL",
    after_heading: Optional[str] = None
) -> str:
    """Generate and insert HTML comparison table into blog.
    Retries once with repair prompt if validation fails.
    """
    messages = build_table_messages(keyword, blog_md)
    table_html = call_llm(messages, model=model).strip()

    try:
        validate_html_table(table_html)
    except Exception as e:
        repair = f"""
Fix the HTML so it passes validation.

Error: {str(e)}

Rules:
- Output ONLY a single valid <table>...</table> element
- Include <thead> and <tbody>
- No em/en dashes
- No new facts beyond the blog
- 4 to 7 rows, 3 to 5 columns
Return ONLY the corrected HTML table.
BAD HTML:
{table_html}
""".strip()
        table_html = call_llm([messages[0], {"role": "user", "content": repair}], model=model).strip()
        validate_html_table(table_html)

    return insert_table_into_blog(blog_md, table_html, after_heading=after_heading)

# ========== MODULE 12: OUTPUT SANITIZATION ==========
def sanitize_output(text: str, max_len: int = 20000) -> str:
    """Comprehensive output sanitizer for security and quality.
    
    Operations:
    - Strips code fences
    - Removes <script>/<style>/<iframe>/<object>/<embed> blocks
    - Removes inline event handlers (onclick=, onload=, etc.)
    - Blocks javascript: URLs
    - Trims and length-limits output
    """
    if text is None:
        return ""

    # Normalize: remove null bytes
    text = text.replace("\x00", "")
    text = text.strip()

    # Remove code fences if the model wrapped output
    text = re.sub(r"^```[a-zA-Z0-9_-]*\s*", "", text)
    text = re.sub(r"\s*```$", "", text)

    # Remove dangerous HTML blocks
    # Removes <script>, <style>, <iframe>, <object>, <embed> and their contents
    text = re.sub(r"(?is)<(script|style|iframe|object|embed)[^>]*>.*?</\1>", "", text)

    # Remove inline JS event handlers
    # Removes: onclick="...", onload="...", onmouseover="...", etc.
    text = re.sub(r'(?i)\son\w+\s*=\s*(".*?"|\'.*?\'|[^\s>]+)', "", text)

    # Neutralize javascript: URLs
    # Converts javascript:alert(...) to safe href="#"
    text = re.sub(r'(?i)href\s*=\s*("|\')\s*javascript:.*?\1', 'href="#"', text)

    # Final trim and length limit
    text = text.strip()
    if len(text) > max_len:
        text = text[:max_len].rstrip()

    return text

# ========== MODULE 13: MAIN DAILY WORKER ==========
def run_daily_blog_worker(
    brief_path: str = "post_brief.json",
    style_path: str = "style_guide.yaml",
    brand_path: str = "brand_kit.yaml",
    out_dir: str = "out",
) -> None:
    """Complete daily blog generation workflow.
    
    Steps:
    1. Load configuration files
    2. Generate system prompt from style guide and brand kit
    3. Create blog outline
    4. Draft blog post
    5. Edit for compliance
    6. Save to file
    """
    style_guide = load_yaml(style_path)
    brand_kit = load_yaml(brand_path)
    brief = load_brief(brief_path)

    sys = system_prompt(style_guide, brand_kit)

    # 1) Outline
    outline = call_llm([
        {"role": "system", "content": sys},
        {"role": "user", "content": outline_prompt(brief)}
    ])

    # 2) Draft
    draft = call_llm([
        {"role": "system", "content": sys},
        {"role": "user", "content": draft_prompt(brief, outline)}
    ])

    # 3) Edit/compliance pass
    edited = call_llm([
        {"role": "system", "content": sys},
        {"role": "user", "content": edit_prompt(draft)}
    ])

    # Save
    date_str = dt.date.today().isoformat()
    Path(out_dir).mkdir(parents=True, exist_ok=True)
    out_path = Path(out_dir) / f"blog_{date_str}.md"
    out_path.write_text(edited, encoding="utf-8")
    print(f"Saved: {out_path}")

# ========== ENTRY POINT ==========
if __name__ == "__main__":
    run_daily_blog_worker()