import asyncio
import aiohttp
from bs4 import BeautifulSoup
from scraper.db import save_scraped_data
from scraper.targets import TARGET_SITES

async def fetch(session, url):
    async with session.get(url, timeout=30) as resp:
        html = await resp.text()
        return url, html

async def parse(html, base_url):
    soup = BeautifulSoup(html, "html.parser")
    # Example: extract inside links (customize selectors)
    links = [a["href"] for a in soup.select("a[href]")]
    # Make absolute URLs if needed
    links = [l if l.startswith("http") else base_url + l for l in links]
    return {"base_url": base_url, "links": links}

async def scrape_site(session, site):
    url, html = await fetch(session, site["url"])
    data = await parse(html, site["url"])
    await save_scraped_data(data)

async def run_all_sites():
    async with aiohttp.ClientSession() as session:
        await asyncio.gather(*(scrape_site(session, s) for s in TARGET_SITES))
