#!/usr/bin/env python3
"""
Simple Product Discovery for Carrefour

Uses direct category URLs and scrolling to discover products
"""

import json
import asyncio
import re
from pathlib import Path
from typing import List
from urllib.parse import urljoin, urlparse
from crawl4ai import (
    AsyncWebCrawler,
    CrawlerRunConfig,
    BrowserConfig,
    CacheMode
)
from bs4 import BeautifulSoup


async def discover_products_carrefour(search_term: str = "leite"):
    """
    Discover products on Carrefour by navigating through categories
    """
    base_url = "https://mercado.carrefour.com.br"

    # Category URLs to try (common categories where products might be)
    category_urls = [
        f"{base_url}/mercearia",  # Grocery
        f"{base_url}/bebidas",  # Beverages
        f"{base_url}/laticinios",  # Dairy
        f"{base_url}/alimentos",  # Foods
    ]

    print(f"\n{'='*80}")
    print(f"Discovering products on Carrefour")
    print(f"Search term: {search_term}")
    print(f"{'='*80}\n")

    all_product_urls = set()

    browser_config = BrowserConfig(
        headless=False,  # Keep visible for debugging
        java_script_enabled=True,
        verbose=True
    )

    async with AsyncWebCrawler(config=browser_config) as crawler:
        # Try each category
        for category_url in category_urls:
            print(f"\n📂 Trying category: {category_url}")

            # Multiple passes with scrolling to load all products
            session_id = f"carrefour_{category_url.split('/')[-1]}"

            # First load
            config = CrawlerRunConfig(
                session_id=session_id,
                cache_mode=CacheMode.BYPASS,
                delay_before_return_html=3,
                verbose=True
            )

            try:
                result = await crawler.arun(url=category_url, config=config)

                if not result.success:
                    print(f"  ✗ Failed: {result.error_message}")
                    continue

                print(f"  ✓ Loaded {category_url}")

                # Scroll multiple times to load more products
                for scroll_num in range(1, 6):  # Scroll 5 times
                    print(f"  📜 Scrolling {scroll_num}/5...")

                    scroll_js = """
                    window.scrollTo(0, document.body.scrollHeight);

                    // Also try clicking "Load More" if it exists
                    const loadMoreBtn = document.querySelector('[data-testid="load-more"]') ||
                                      document.querySelector('button:contains("Ver mais")') ||
                                      document.querySelector('button:contains("Carregar mais")');
                    if (loadMoreBtn) {
                        loadMoreBtn.click();
                        console.log('Clicked load more button');
                    }
                    """

                    scroll_config = CrawlerRunConfig(
                        session_id=session_id,
                        js_code=scroll_js,
                        js_only=True,
                        cache_mode=CacheMode.BYPASS,
                        delay_before_return_html=2,
                        verbose=False
                    )

                    result = await crawler.arun(url=category_url, config=scroll_config)

                if result.success:
                    # Extract product links
                    soup = BeautifulSoup(result.html, 'html.parser')
                    links = soup.find_all('a', href=True)

                    products_before = len(all_product_urls)

                    for link in links:
                        href = link.get('href', '')

                        # Carrefour product URLs end with /p
                        if '/p' in href and href.endswith('/p'):
                            # Check if product name contains search term
                            if search_term.lower() in href.lower():
                                abs_url = urljoin(base_url, href)
                                parsed = urlparse(abs_url)
                                clean_url = f"{parsed.scheme}://{parsed.netloc}{parsed.path}"
                                all_product_urls.add(clean_url)

                    new_products = len(all_product_urls) - products_before
                    print(f"  ✓ Found {new_products} new products ({len(all_product_urls)} total)")

                else:
                    print(f"  ✗ Failed after scrolling: {result.error_message}")

            except Exception as e:
                print(f"  ✗ Error: {e}")
                continue

    product_list = list(all_product_urls)

    print(f"\n{'='*80}")
    print(f"Discovery completed!")
    print(f"Total products found with '{search_term}': {len(product_list)}")
    print(f"{'='*80}\n")

    # Display results
    if product_list:
        print("Products found:")
        for i, url in enumerate(product_list[:20], 1):
            # Extract product name from URL
            product_name = url.split('/')[-2].replace('-', ' ').title()
            print(f"{i}. {product_name}")
            print(f"   {url}")

        if len(product_list) > 20:
            print(f"... and {len(product_list) - 20} more")

    # Save results
    output_file = f"products_{search_term}.json"
    data = {
        "search_term": search_term,
        "total_products": len(product_list),
        "products": product_list
    }

    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

    print(f"\n✓ Results saved to {output_file}")

    return product_list


async def main():
    # Search for milk products ("leite" in Portuguese)
    products = await discover_products_carrefour("leite")

    if not products:
        print("\n⚠️ No products found. Carrefour might require:")
        print("  1. Setting a delivery location (CEP)")
        print("  2. Accepting cookies")
        print("  3. Different approach to access products")


if __name__ == "__main__":
    asyncio.run(main())
