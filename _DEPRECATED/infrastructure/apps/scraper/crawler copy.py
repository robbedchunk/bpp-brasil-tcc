import asyncio
import aiohttp
from bs4 import BeautifulSoup
from urllib.parse import urljoin, urlparse
import itertools
import os
from db import save_scraped_data
from log_utils import log_message
from datetime import datetime

scrape_id = 1


SCRAPE_CONCURRENCY = int(os.getenv("SCRAPE_CONCURRENCY", 10))
SCRAPE_MAX_DEPTH = int(os.getenv("SCRAPE_MAX_DEPTH", 0))  # 0 = unlimited

semaphore = asyncio.Semaphore(SCRAPE_CONCURRENCY)


async def fetch(session, url, proxy=None):
    try:
        async with semaphore:
            async with session.get(url, proxy=proxy, timeout=15) as resp:
                if resp.status != 200:
                    return None
                return await resp.text(errors="ignore")
    except Exception as e:
        await log_message(scrape_id, "ERROR", f"Fetch failed for {url}: {e}")
        print(f"Fetch error for {url}: {e}")
        return None


def extract_links(html, wbase_url):
    soup = BeautifulSoup(html, "html.parser")
    links = []
    for a in soup.find_all("a", href=True):
        href = a["href"]
        abs_url = urljoin(base_url, href)
        # stay within same domain
        if urlparse(abs_url).netloc == urlparse(base_url).netloc:
            links.append(abs_url.split("#")[0])
    return list(set(links))


async def crawl_domain(base_url, proxies):
    visited = set()
    found_links = []
    proxy_cycle = itertools.cycle(proxies) if proxies else None

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
                html = await fetch(session, url, proxy=proxy)
                if not html:
                    queue.task_done()
                    continue

                found_links.append(url)

                # Depth control: 0 = unlimited
                if SCRAPE_MAX_DEPTH == 0 or depth < SCRAPE_MAX_DEPTH:
                    new_links = extract_links(html, base_url)
                    for l in new_links:
                        if l not in visited:
                            await queue.put((l, depth + 1))

                queue.task_done()

        tasks = [asyncio.create_task(worker()) for _ in range(SCRAPE_CONCURRENCY)]
        await queue.join()
        for t in tasks:
            t.cancel()

    return found_links
