from fastapi import FastAPI, BackgroundTasks
from scraper_service import run_scrape
from seed import seed_stores
import asyncio
import os       
from contextlib import asynccontextmanager
from proxy_refresher import refresh_proxies



@asynccontextmanager
async def lifespan(app: FastAPI):
    print("Running startup tasks...")
    await asyncio.sleep(5)  # ensure DB is ready
    await seed_stores()
    await refresh_proxies() 

    async def scrape_loop():
        while True:
            print("Starting automated scrape run...")
            try:
                await run_scrape()
            except Exception as e:
                print(f"Scrape error: {e}")
            print("Scrape run complete, sleeping...")
            await asyncio.sleep(int(os.getenv("SCRAPE_INTERVAL", 21600)))

    if os.getenv("AUTO_SCRAPE_ON_STARTUP", "true").lower() == "true":
        asyncio.create_task(scrape_loop())
        print("Auto scrape loop enabled.")
    else:
        print("Auto scrape disabled by env variable.")

    async def proxy_loop():
        while True:
            await refresh_proxies()
            await asyncio.sleep(43200)  # 12 hours

    # handle /health endpoint
    
    asyncio.create_task(proxy_loop())

    yield  # ← everything above runs at startup, below runs at shutdown

    print("Shutting down scraper service...")




app = FastAPI(title="Domain Scraper", lifespan=lifespan)

@app.get("/")
def health():
    return {"status": "ok"}

@app.get("/scrape")
async def start_scrape(background_tasks: BackgroundTasks):
    background_tasks.add_task(run_scrape)
    return {"message": "Scraping started manually"}
