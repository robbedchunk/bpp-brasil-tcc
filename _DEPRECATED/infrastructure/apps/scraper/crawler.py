import asyncio
import aiohttp
from bs4 import BeautifulSoup
from urllib.parse import urljoin, urlparse
import itertools
import os
from db import get_conn
from datetime import datetime
from log_utils import log_message

SCRAPE_CONCURRENCY = int(os.getenv("SCRAPE_CONCURRENCY", 10))
SCRAPE_MAX_DEPTH = int(os.getenv("SCRAPE_MAX_DEPTH", 0))  # 0 = unlimited
semaphore = asyncio.Semaphore(SCRAPE_CONCURRENCY)


async def fetch(session, url, proxy=None):
    """Fetch a page and return HTML, or None on failure."""
    try:
        async with semaphore:
            async with session.get(url, proxy=proxy, timeout=15) as resp:
                if resp.status == 200:
                    return await resp.text(errors="ignore")
    except Exception as e:
        print(f"Fetch failed for {url}: {e}")
    return None


def extract_links(html, base_url):
    """Extract same-domain links."""
    soup = BeautifulSoup(html, "html.parser")
    links = set()
    for a in soup.find_all("a", href=True):
        href = a["href"].strip()
        abs_url = urljoin(base_url, href)
        if urlparse(abs_url).netloc == urlparse(base_url).netloc:
            links.add(abs_url.split("#")[0])
    return list(links)


async def save_link_to_db(conn, run_id, store_id, url):
    """Insert a single discovered link into the scrape table."""
    try:
        await conn.execute(
            '''
            INSERT INTO scrape (
                scrape_run_id,
                store_id,
                type,
                "sourceUrl",
                status,
                "startedAt"
            )
            VALUES ($1, $2, 'frontpage', $3, 'queued', $4)
            ON CONFLICT DO NOTHING
            ''',
            run_id, store_id, url, datetime.utcnow()
        )
    except Exception as e:
        print(f"DB insert failed for {url}: {e}")
        await log_message(None, "ERROR", f"Failed to save link {url}: {e}")


async def crawl_domain(base_url, proxies, run_id=None, store_id=None):
    """Recursively crawl and save all same-domain links."""
    visited = set()
    proxy_cycle = itertools.cycle(proxies) if proxies else None

    conn = await get_conn()
    async with aiohttp.ClientSession() as session:
        queue = asyncio.Queue()
        await queue.put((base_url, 0))

        async def worker():
            while not queue.empty():
                url, depth = await queue.get()
                if url in visited:
                    queue.task_done()
                    continue
                visited.add(url)
                proxy = next(proxy_cycle) if proxy_cycle else None
                html = await fetch(session, url, proxy)
                if not html:
                    await log_message(None, "ERROR", f"Failed to fetch {url}")
                    queue.task_done()
                    continue

                # Save found link immediately
                if run_id and store_id:
                    await save_link_to_db(conn, run_id, store_id, url)

                new_links = extract_links(html, base_url)

                if SCRAPE_MAX_DEPTH == 0 or depth < SCRAPE_MAX_DEPTH:
                    for link in new_links:
                        if link not in visited:
                            await queue.put((link, depth + 1))

                queue.task_done()

        tasks = [asyncio.create_task(worker()) for _ in range(SCRAPE_CONCURRENCY)]
        await queue.join()
        for t in tasks:
            t.cancel()

    await conn.close()
    return list(visited)
