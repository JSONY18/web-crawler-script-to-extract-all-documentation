"""
OpenClaw 文档爬虫
目标网站: https://docs.openclaw.ai/zh-CN

方案 A: 使用 crawl4ai（推荐，支持 JS 渲染）
方案 B: 使用 requests + BeautifulSoup（轻量备用）

安装依赖:
    pip install crawl4ai beautifulsoup4 requests aiofiles
    crawl4ai-setup  # 安装 Playwright 浏览器（方案 A 需要）
"""

import asyncio
import re
import time
from pathlib import Path
from urllib.parse import urljoin, urlparse

# ─────────────────────────────────────────────
# 公共配置
# ─────────────────────────────────────────────
BASE_URL = "https://docs.openclaw.ai/zh-CN"
DOMAIN   = "docs.openclaw.ai"
OUT_DIR  = Path("openclaw_docs")        # 输出目录（每页一个 .md 文件）
ALL_TXT  = Path("openclaw_all.txt")     # 合并输出（单个大文本）
DELAY    = 0.5                          # 礼貌延迟（秒）


# ══════════════════════════════════════════════
# 方案 A：crawl4ai（推荐）
# 优点：支持 JS 渲染的 SPA 文档站；自动提取 Markdown
# ══════════════════════════════════════════════
async def crawl_with_crawl4ai():
    """使用 crawl4ai 异步爬取所有页面，输出 Markdown 文件"""
    try:
        from crawl4ai import AsyncWebCrawler, BrowserConfig, CrawlerRunConfig
        from crawl4ai.content_filter_strategy import PruningContentFilter
        from crawl4ai.markdown_generation_strategy import DefaultMarkdownGenerator
    except ImportError:
        print("❌ crawl4ai 未安装，请执行: pip install crawl4ai && crawl4ai-setup")
        return

    OUT_DIR.mkdir(exist_ok=True)
    visited: set[str] = set()
    queue:   list[str] = [BASE_URL]
    all_content: list[str] = []

    browser_cfg = BrowserConfig(headless=True, verbose=False)

    # 内容过滤：保留正文，去除导航/页脚噪声
    md_generator = DefaultMarkdownGenerator(
        content_filter=PruningContentFilter(threshold=0.45, threshold_type="fixed")
    )
    run_cfg = CrawlerRunConfig(markdown_generator=md_generator)

    async with AsyncWebCrawler(config=browser_cfg) as crawler:
        while queue:
            url = queue.pop(0)
            if url in visited:
                continue
            visited.add(url)

            print(f"🕷  抓取: {url}")
            try:
                result = await crawler.arun(url=url, config=run_cfg)
            except Exception as e:
                print(f"  ⚠️  跳过 {url}：{e}")
                continue

            if not result.success:
                print(f"  ⚠️  失败: {result.error_message}")
                continue

            # ── 保存单页 Markdown ──
            slug = url_to_slug(url)
            md_path = OUT_DIR / f"{slug}.md"
            md_content = result.markdown_v2.fit_markdown or result.markdown or ""
            md_path.write_text(f"# 来源: {url}\n\n{md_content}", encoding="utf-8")
            all_content.append(f"\n\n{'='*60}\n# {url}\n{'='*60}\n\n{md_content}")
            print(f"  ✅ 已保存 → {md_path}")

            # ── 从原始 HTML 提取新链接 ──
            new_links = extract_links(result.html, url)
            for link in new_links:
                if link not in visited:
                    queue.append(link)

            await asyncio.sleep(DELAY)

    # ── 写入合并文件 ──
    ALL_TXT.write_text("\n".join(all_content), encoding="utf-8")
    print(f"\n🎉 完成！共爬取 {len(visited)} 页")
    print(f"   📁 分页文件 → {OUT_DIR}/")
    print(f"   📄 合并文件 → {ALL_TXT}")


# ══════════════════════════════════════════════
# 方案 B：requests + BeautifulSoup（备用）
# 适用于纯静态 HTML 文档站；无需 Playwright
# ══════════════════════════════════════════════
def crawl_with_requests():
    """使用 requests + BeautifulSoup 同步爬取"""
    try:
        import requests
        from bs4 import BeautifulSoup
    except ImportError:
        print("❌ 请执行: pip install requests beautifulsoup4")
        return

    OUT_DIR.mkdir(exist_ok=True)
    visited: set[str] = set()
    queue:   list[str] = [BASE_URL]
    all_content: list[str] = []

    session = requests.Session()
    session.headers.update({
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/122.0.0.0 Safari/537.36"
        )
    })

    while queue:
        url = queue.pop(0)
        if url in visited:
            continue
        visited.add(url)

        print(f"🕷  抓取: {url}")
        try:
            resp = session.get(url, timeout=15)
            resp.raise_for_status()
        except Exception as e:
            print(f"  ⚠️  跳过 {url}：{e}")
            continue

        soup = BeautifulSoup(resp.text, "html.parser")

        # ── 提取正文 ──
        # 常见文档框架的正文选择器（Docusaurus / Mintlify / GitBook 等）
        content_selectors = [
            "article",
            "main",
            '[class*="content"]',
            '[class*="markdown"]',
            '[class*="prose"]',
            ".doc-content",
            "#content",
        ]
        body_el = None
        for sel in content_selectors:
            body_el = soup.select_one(sel)
            if body_el:
                break
        if not body_el:
            body_el = soup.body or soup

        # 去除导航、页脚、侧边栏等噪声元素
        for tag in body_el.select("nav, footer, header, aside, script, style, [class*='nav'], [class*='sidebar'], [class*='footer']"):
            tag.decompose()

        page_text = html_to_markdown(body_el)

        # ── 保存单页 .md ──
        slug = url_to_slug(url)
        md_path = OUT_DIR / f"{slug}.md"
        md_path.write_text(f"# 来源: {url}\n\n{page_text}", encoding="utf-8")
        all_content.append(f"\n\n{'='*60}\n# {url}\n{'='*60}\n\n{page_text}")
        print(f"  ✅ 已保存 → {md_path}")

        # ── 发现新链接 ──
        new_links = extract_links(resp.text, url)
        for link in new_links:
            if link not in visited:
                queue.append(link)

        time.sleep(DELAY)

    # ── 写入合并文件 ──
    ALL_TXT.write_text("\n".join(all_content), encoding="utf-8")
    print(f"\n🎉 完成！共爬取 {len(visited)} 页")
    print(f"   📁 分页文件 → {OUT_DIR}/")
    print(f"   📄 合并文件 → {ALL_TXT}")


# ══════════════════════════════════════════════
# 工具函数
# ══════════════════════════════════════════════
def extract_links(html: str, current_url: str) -> list[str]:
    """从 HTML 中提取同域内的文档链接"""
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(html, "html.parser")
    links = []
    for a in soup.find_all("a", href=True):
        href = a["href"].strip()
        if not href or href.startswith(("#", "mailto:", "javascript:")):
            continue
        full = urljoin(current_url, href)
        parsed = urlparse(full)
        # 只保留同域、同路径前缀的链接
        if parsed.netloc == DOMAIN and parsed.path.startswith("/zh-CN"):
            # 去掉 fragment
            clean = full.split("#")[0].rstrip("/")
            if clean:
                links.append(clean)
    return list(dict.fromkeys(links))  # 去重保序


def url_to_slug(url: str) -> str:
    """将 URL 转换为合法文件名"""
    parsed = urlparse(url)
    slug = parsed.path.strip("/").replace("/", "__") or "index"
    slug = re.sub(r"[^\w\-]", "_", slug)
    return slug[:120]  # 限制长度


def html_to_markdown(element) -> str:
    """将 BeautifulSoup 元素简单转换为 Markdown 文本"""
    lines = []
    for tag in element.descendants:
        if not hasattr(tag, "name"):
            continue
        if tag.name in ("h1", "h2", "h3", "h4", "h5", "h6"):
            level = int(tag.name[1])
            lines.append(f"\n{'#' * level} {tag.get_text(strip=True)}\n")
        elif tag.name == "p":
            text = tag.get_text(" ", strip=True)
            if text:
                lines.append(f"\n{text}\n")
        elif tag.name in ("li",):
            text = tag.get_text(" ", strip=True)
            if text:
                lines.append(f"- {text}")
        elif tag.name == "code":
            text = tag.get_text(strip=True)
            if text:
                lines.append(f"`{text}`")
        elif tag.name == "pre":
            text = tag.get_text()
            lines.append(f"\n```\n{text}\n```\n")
    return "\n".join(lines)


# ══════════════════════════════════════════════
# 入口
# ══════════════════════════════════════════════
if __name__ == "__main__":
    import sys

    mode = sys.argv[1] if len(sys.argv) > 1 else "crawl4ai"

    if mode == "requests":
        print("📦 使用方案 B：requests + BeautifulSoup")
        crawl_with_requests()
    else:
        print("📦 使用方案 A：crawl4ai（推荐）")
        asyncio.run(crawl_with_crawl4ai())
