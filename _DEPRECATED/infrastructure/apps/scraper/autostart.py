from fastapi import FastAPI
import asyncio
from scraper_service import run_scrape

app = FastAPI()

@app.on_event("startup")
async def schedule_background_scrape():
    async def loop():
        while True:
            print("Starting automated scrape run...")
            await run_scrape()
            await asyncio.sleep(21600)  # every 6 hours
    asyncio.create_task(loop())

@app.get("/")
def health():
    return {"status": "ok"}
