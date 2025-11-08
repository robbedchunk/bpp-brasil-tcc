#!/usr/bin/env python3
"""
Final Carrefour Product Discovery

Uses Crawl4AI's built-in link extraction (which we know works)
"""

import json
import asyncio
from pathlib import Path
from typing import List
from urllib.parse import urlparse
from crawl4ai import (
    AsyncWebCrawler,
    CrawlerRunConfig,
    BrowserConfig,
    CacheMode
)


async def discover_products(query_term: str = "leite integral") -> List[str]:
    """
    Discover products on Carrefour using link extraction

    Args:
        query_term: Product search term

    Returns:
        List of product URLs
    """
    base_url = "https://mercado.carrefour.com.br"

    # Categories to crawl
    categories = [
        "/mercearia",
        "/bebidas",
        "/laticinios",
    ]

    print(f"\n{'='*80}")
    print(f"🔍 Carrefour Product Discovery")
    print(f"Search term: '{query_term}'")
    print(f"{'='*80}\n")

    all_product_urls = []

    browser_config = BrowserConfig(
        headless=False,
        java_script_enabled=True,
        verbose=True
    )

    async with AsyncWebCrawler(config=browser_config) as crawler:
        for category in categories:
            url = base_url + category
            print(f"\n📂 Crawling: {url}")

            config = CrawlerRunConfig(
                cache_mode=CacheMode.BYPASS,
                delay_before_return_html=5,  # Wait for products to load
                verbose=True
            )

            try:
                result = await crawler.arun(url=url, config=config)

                if not result.success:
                    print(f"  ✗ Failed: {result.error_message}")
                    continue

                print(f"  ✓ Crawled successfully")

                # Use Crawl4AI's built-in link extraction
                internal_links = result.links.get("internal", [])
                print(f"  📊 Found {len(internal_links)} internal links")

                # Filter for product links
                for link in internal_links:
                    href = link.get("href", "")

                    # Carrefour product URLs end with /p
                    if href.endswith("/p"):
                        # Clean URL
                        parsed = urlparse(href)
                        clean_url = f"{parsed.scheme}://{parsed.netloc}{parsed.path}"

                        if clean_url not in all_product_urls:
                            all_product_urls.append(clean_url)

                print(f"  ✓ Total product URLs: {len(all_product_urls)}")

            except Exception as e:
                print(f"  ✗ Error: {e}")
                continue

    # Filter by query term
    query_terms = query_term.lower().split()
    matching_urls = [
        url for url in all_product_urls
        if any(term in url.lower() for term in query_terms)
    ]

    print(f"\n{'='*80}")
    print(f"✅ Discovery Complete!")
    print(f"  Total products found: {len(all_product_urls)}")
    print(f"  Matching '{query_term}': {len(matching_urls)}")
    print(f"{'='*80}\n")

    # Display results
    if matching_urls:
        print(f"🥛 Products matching '{query_term}':\n")
        for i, url in enumerate(matching_urls, 1):
            # Extract name from URL
            name = url.split('/')[-2].replace('-', ' ').title()
            print(f"{i}. {name}")
            print(f"   {url}\n")
    else:
        print(f"⚠️  No products found with '{query_term}' in URL")
        print(f"\nShowing all {len(all_product_urls)} products found:\n")
        for i, url in enumerate(all_product_urls[:20], 1):
            name = url.split('/')[-2].replace('-', ' ').title()
            print(f"{i}. {name}")
            print(f"   {url}\n")

        if len(all_product_urls) > 20:
            print(f"... and {len(all_product_urls) - 20} more")

    # Save results
    output_file = f"carrefour_{query_term.replace(' ', '_')}.json"
    data = {
        "query": query_term,
        "total_products": len(all_product_urls),
        "matching_products": len(matching_urls),
        "matching_urls": matching_urls,
        "all_urls": all_product_urls
    }

    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

    print(f"\n💾 Saved to {output_file}")

    return matching_urls if matching_urls else all_product_urls


async def main():
    products = await discover_products("leite integral")

    if products:
        print(f"\n✅ SUCCESS! Found {len(products)} product URLs")
        print(f"\nYou can now use these URLs with the product extraction pipeline!")
    else:
        print(f"\n⚠️  No products found")


if __name__ == "__main__":
    asyncio.run(main())
