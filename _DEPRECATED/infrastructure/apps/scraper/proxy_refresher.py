import aiohttp
import asyncio
from db import get_conn
from datetime import datetime

# needs: 
# - ALTER TABLE proxy ADD CONSTRAINT unique_ip_port UNIQUE (ip, port);
# - ALTER TABLE proxy ADD COLUMN country CHAR(2);
# - TRUNCATE TABLE proxy RESTART IDENTITY;

PROXY_SOURCES = [
    "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt",
    "https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt",
]

async def fetch_text(session, url):
    try:
        async with session.get(url, timeout=15) as resp:
            return await resp.text()
    except Exception as e:
        print(f"Failed to fetch proxy list from {url}: {e}")
        return ""

async def detect_country(ip):
    # Free, rate-limited API (fallback: ipapi.co)
    url = f"https://ipapi.co/{ip}/country/"
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(url, timeout=5) as resp:
                if resp.status == 200:
                    text = await resp.text()
                    return text.strip()[:2].upper()
    except Exception:
        pass
    return None

async def refresh_proxies():
    print("Refreshing free proxies...")
    async with aiohttp.ClientSession() as session:
        all_proxies = []
        for src in PROXY_SOURCES:
            text = await fetch_text(session, src)
            all_proxies.extend(line.strip() for line in text.splitlines() if ":" in line)

    all_proxies = list(set(all_proxies))
    conn = await get_conn()
    added = 0

    for p in all_proxies:
        try:
            ip, port = p.split(":")
            country = await detect_country(ip)
            await conn.execute("""
                INSERT INTO proxy (ip, port, type, last_used, country)
                SELECT $1, $2::int, 'anonymous', $3, $4
                WHERE NOT EXISTS (
                    SELECT 1 FROM proxy WHERE ip = $1 AND port = $2::int
                );
            """, ip, int(port), datetime.utcnow(), country)
            added += 1
        except Exception:
            continue

    await conn.close()
    print(f"Added or refreshed {added} proxies (with countries).")
