LLM-Assisted Pattern Generation
For complex or site-specific patterns, you can use an LLM once to generate an optimized pattern, then save and reuse it without further LLM calls:

import json
import asyncio
from pathlib import Path
from crawl4ai import (
AsyncWebCrawler,
CrawlerRunConfig,
RegexExtractionStrategy,
LLMConfig
)

async def extract_with_generated_pattern():
cache_dir = Path("./pattern_cache")
cache_dir.mkdir(exist_ok=True)
pattern_file = cache_dir / "price_pattern.json"

    # 1. Generate or load pattern
    if pattern_file.exists():
        pattern = json.load(pattern_file.open())
        print(f"Using cached pattern: {pattern}")
    else:
        print("Generating pattern via LLM...")

        # Configure LLM
        llm_config = LLMConfig(
            provider="openai/gpt-4o-mini",
            api_token="env:OPENAI_API_KEY",
        )

        # Get sample HTML for context
        async with AsyncWebCrawler() as crawler:
            result = await crawler.arun("https://example.com/products")
            html = result.fit_html

        # Generate pattern (one-time LLM usage)
        pattern = RegexExtractionStrategy.generate_pattern(
            label="price",
            html=html,
            query="Product prices in USD format",
            llm_config=llm_config,
        )

        # Cache pattern for future use
        json.dump(pattern, pattern_file.open("w"), indent=2)

    # 2. Use pattern for extraction (no LLM calls)
    strategy = RegexExtractionStrategy(custom=pattern)
    config = CrawlerRunConfig(extraction_strategy=strategy)

    async with AsyncWebCrawler() as crawler:
        result = await crawler.arun(
            url="https://example.com/products",
            config=config
        )

        if result.success:
            data = json.loads(result.extracted_content)
            for item in data[:10]:
                print(f"Extracted: {item['value']}")
            print(f"Total matches: {len(data)}")

asyncio.run(extract_with_generated_pattern())
Copy
This pattern allows you to: 1. Use an LLM once to generate a highly optimized regex for your specific site 2. Save the pattern to disk for reuse 3. Extract data using only regex (no further LLM calls) in production
