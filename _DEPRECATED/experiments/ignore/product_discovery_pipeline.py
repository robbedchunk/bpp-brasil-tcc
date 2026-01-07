#!/usr/bin/env python3
"""
Product Discovery Pipeline for Carrefour Supermarket

This pipeline searches for products on Carrefour's website and extracts
all product links from the search results.

Usage:
    pipeline = ProductDiscoveryPipeline()
    product_urls = await pipeline.search_products("Leite Integral")
"""

import json
import asyncio
from pathlib import Path
from typing import List, Dict, Any, Optional
from urllib.parse import urljoin, urlparse
from crawl4ai import (
    AsyncWebCrawler,
    CrawlerRunConfig,
    BrowserConfig,
    CacheMode
)


class ProductDiscoveryPipeline:
    """Pipeline for discovering product URLs on e-commerce sites"""

    def __init__(self,
                 base_url: str = "https://mercado.carrefour.com.br",
                 headless: bool = False):
        self.base_url = base_url
        self.headless = headless

    async def search_products(self, query: str, max_pages: int = 5) -> List[str]:
        """
        Search for products and return all product URLs found.

        Args:
            query: Search term (e.g., "Leite Integral")
            max_pages: Maximum number of result pages to crawl

        Returns:
            List of product URLs
        """
        print(f"\n{'='*80}")
        print(f"Searching for: {query}")
        print(f"Target site: {self.base_url}")
        print(f"{'='*80}\n")

        all_product_urls = []

        browser_config = BrowserConfig(
            headless=self.headless,
            java_script_enabled=True,
            verbose=True
        )

        async with AsyncWebCrawler(config=browser_config) as crawler:
            # Step 1: Navigate to homepage and set a location (CEP)
            print("Step 1: Loading Carrefour homepage...")

            # Use homepage first
            home_config = CrawlerRunConfig(
                cache_mode=CacheMode.BYPASS,
                delay_before_return_html=2,
                verbose=True
            )

            # First, load homepage
            print("  Loading homepage to initialize session...")
            home_result = await crawler.arun(url=self.base_url, config=home_config)

            if not home_result.success:
                print(f"❌ Failed to load homepage: {home_result.error_message}")
                return []

            # Step 2: Try to interact with search
            print("Step 2: Searching for products...")

            # Try multiple search URL formats
            search_urls_to_try = [
                f"{self.base_url}/s?q={query.replace(' ', '+')}",
                f"{self.base_url}/busca?q={query.replace(' ', '+')}",
                f"{self.base_url}/{query.replace(' ', '-').lower()}",
            ]

            # Try searching directly via the search field
            search_js = f"""
            // Try to find and fill search box
            const searchInput = document.querySelector('input[type="search"]') ||
                              document.querySelector('input[placeholder*="Buscar"]') ||
                              document.querySelector('input[placeholder*="buscar"]') ||
                              document.querySelector('#search-input') ||
                              document.querySelector('[data-testid="search-input"]');

            if (searchInput) {{
                searchInput.value = '{query}';
                searchInput.dispatchEvent(new Event('input', {{ bubbles: true }}));

                // Try to submit
                const form = searchInput.closest('form');
                if (form) {{
                    form.submit();
                }} else {{
                    // Try to find and click search button
                    const searchBtn = document.querySelector('button[type="submit"]') ||
                                    document.querySelector('[aria-label*="Buscar"]') ||
                                    document.querySelector('[data-testid="search-button"]');
                    if (searchBtn) searchBtn.click();

                    // Trigger Enter key
                    searchInput.dispatchEvent(new KeyboardEvent('keydown', {{ key: 'Enter', code: 'Enter', bubbles: true }}));
                }}
                console.log('Search triggered with query: {query}');
            }} else {{
                console.log('Search input not found');
            }}
            """

            search_config = CrawlerRunConfig(
                session_id="carrefour_search",
                js_code=search_js,
                cache_mode=CacheMode.BYPASS,
                delay_before_return_html=5,  # Wait for results
                js_only=True,
                verbose=True
            )

            result = await crawler.arun(url=self.base_url, config=search_config)

            if not result.success:
                print(f"❌ Failed to load search page: {result.error_message}")
                return []

            print(f"✓ Search page loaded successfully")

            # Debug: Save HTML and markdown for inspection
            debug_dir = Path("debug_output")
            debug_dir.mkdir(exist_ok=True)

            with open(debug_dir / "search_page.html", "w", encoding="utf-8") as f:
                f.write(result.html)
            print(f"✓ Saved HTML to {debug_dir}/search_page.html")

            with open(debug_dir / "search_page.md", "w", encoding="utf-8") as f:
                f.write(result.markdown)
            print(f"✓ Saved Markdown to {debug_dir}/search_page.md")

            # Debug: Show what links we found
            print(f"\n📊 Debug - All links found:")
            internal_links = result.links.get("internal", [])
            print(f"  Total internal links: {len(internal_links)}")

            # Show sample links
            for i, link in enumerate(internal_links[:20], 1):
                href = link.get("href", "")
                text = link.get("text", "")[:50]
                print(f"  {i}. {href[:80]}... | Text: {text}")

            # Extract product links from search results
            product_urls = self._extract_product_links(result)
            all_product_urls.extend(product_urls)
            print(f"\n✓ Found {len(product_urls)} products on page 1")

            # If no products found via links, try extracting from HTML
            if len(product_urls) == 0:
                print("\n⚠ No products found via links, trying to extract from HTML...")
                product_urls = self._extract_product_links_from_html(result.html)
                all_product_urls.extend(product_urls)
                print(f"✓ Found {len(product_urls)} products via HTML parsing")

            # Check for pagination and get more pages if needed
            for page_num in range(2, max_pages + 1):
                print(f"\nChecking for page {page_num}...")

                # Try to find and click pagination or load more
                js_load_more = """
                // Try multiple pagination strategies

                // Strategy 1: Click "Next" button
                const nextButton = document.querySelector('[aria-label="Próxima página"]') ||
                                 document.querySelector('[aria-label="Next page"]') ||
                                 document.querySelector('button[aria-label*="próxima"]') ||
                                 document.querySelector('a[aria-label*="próxima"]');
                if (nextButton) {
                    nextButton.click();
                    console.log('Clicked next button');
                }

                // Strategy 2: Click page number
                const pageButton = document.querySelector(`[aria-label="Página ${page_num}"]`) ||
                                  document.querySelector(`[aria-label="Page ${page_num}"]`) ||
                                  document.querySelector(`button[data-page="${page_num}"]`);
                if (pageButton) {
                    pageButton.click();
                    console.log('Clicked page number');
                }

                // Strategy 3: Scroll to bottom to trigger infinite scroll
                window.scrollTo(0, document.body.scrollHeight);
                console.log('Scrolled to bottom');
                """.replace("${page_num}", str(page_num))

                # Wait for new products to load
                wait_condition = f"""js:() => {{
                    const links = document.querySelectorAll('a[href*="/p/"]');
                    return links.length > {len(all_product_urls)};
                }}"""

                next_page_config = CrawlerRunConfig(
                    session_id="carrefour_search",
                    js_code=js_load_more,
                    wait_for=wait_condition,
                    js_only=True,
                    cache_mode=CacheMode.BYPASS,
                    delay_before_return_html=2,
                    page_timeout=10000,  # 10s timeout
                    verbose=True
                )

                try:
                    result = await crawler.arun(url=search_url, config=next_page_config)

                    if result.success:
                        product_urls = self._extract_product_links(result)
                        new_urls = [url for url in product_urls if url not in all_product_urls]

                        if new_urls:
                            all_product_urls.extend(new_urls)
                            print(f"✓ Found {len(new_urls)} new products on page {page_num}")
                        else:
                            print(f"⚠ No new products found on page {page_num}, stopping pagination")
                            break
                    else:
                        print(f"⚠ Page {page_num} failed: {result.error_message}")
                        break

                except Exception as e:
                    print(f"⚠ Error loading page {page_num}: {str(e)}")
                    break

            # Clean up session
            try:
                await crawler.crawler_strategy.kill_session("carrefour_search")
            except:
                pass

        print(f"\n{'='*80}")
        print(f"Search completed!")
        print(f"Total unique products found: {len(all_product_urls)}")
        print(f"{'='*80}\n")

        return all_product_urls

    def _extract_product_links(self, result) -> List[str]:
        """Extract unique product URLs from crawl result"""
        product_urls = set()

        # Get internal links
        internal_links = result.links.get("internal", [])

        # Filter for product links (multiple patterns for different e-commerce sites)
        for link in internal_links:
            href = link.get("href", "")

            # Check if it's a product link (try multiple patterns)
            is_product = any([
                "/p/" in href,
                "/produto/" in href,
                "/product/" in href,
                "/item/" in href,
                # Carrefour specific: product IDs in path
                href.count("/") >= 4 and any(char.isdigit() for char in href)
            ])

            if is_product:
                # Ensure it's an absolute URL
                if not href.startswith("http"):
                    href = urljoin(self.base_url, href)

                # Clean URL (remove query params that don't matter)
                parsed = urlparse(href)
                clean_url = f"{parsed.scheme}://{parsed.netloc}{parsed.path}"

                product_urls.add(clean_url)

        return list(product_urls)

    def _extract_product_links_from_html(self, html: str) -> List[str]:
        """Extract product links directly from HTML using regex and parsing"""
        import re
        from bs4 import BeautifulSoup

        product_urls = set()

        try:
            soup = BeautifulSoup(html, 'html.parser')

            # Strategy 1: Find all <a> tags and filter for product patterns
            all_links = soup.find_all('a', href=True)
            print(f"  Total <a> tags found: {len(all_links)}")

            for link in all_links:
                href = link.get('href', '')

                # Product link patterns
                is_product = any([
                    '/p/' in href,
                    '/produto/' in href,
                    '/product/' in href,
                    re.search(r'/\d+/', href),  # Numeric ID in path
                ])

                if is_product:
                    # Make absolute URL
                    if not href.startswith('http'):
                        href = urljoin(self.base_url, href)

                    # Clean URL
                    parsed = urlparse(href)
                    clean_url = f"{parsed.scheme}://{parsed.netloc}{parsed.path}"
                    product_urls.add(clean_url)

            # Strategy 2: Look for data attributes that might contain product info
            products_with_data = soup.find_all(attrs={"data-product-id": True})
            products_with_data += soup.find_all(attrs={"data-product": True})
            products_with_data += soup.find_all(attrs={"data-sku": True})

            print(f"  Elements with product data attributes: {len(products_with_data)}")

            for elem in products_with_data:
                # Try to find link within or near this element
                link = elem.find('a', href=True)
                if not link:
                    link = elem.find_parent('a', href=True)

                if link:
                    href = link.get('href', '')
                    if not href.startswith('http'):
                        href = urljoin(self.base_url, href)

                    parsed = urlparse(href)
                    clean_url = f"{parsed.scheme}://{parsed.netloc}{parsed.path}"
                    product_urls.add(clean_url)

        except Exception as e:
            print(f"  Error parsing HTML: {e}")

        return list(product_urls)

    def save_results(self, query: str, product_urls: List[str], output_file: str = None):
        """Save discovered product URLs to JSON file"""
        if output_file is None:
            safe_query = "".join(c if c.isalnum() else "_" for c in query)
            output_file = f"products_{safe_query}.json"

        output_path = Path(output_file)

        data = {
            "query": query,
            "total_products": len(product_urls),
            "base_url": self.base_url,
            "product_urls": product_urls
        }

        with open(output_path, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2, ensure_ascii=False)

        print(f"✓ Results saved to {output_path}")
        return output_path


async def main():
    """Example usage"""
    # Initialize pipeline
    pipeline = ProductDiscoveryPipeline(
        base_url="https://mercado.carrefour.com.br",
        headless=False  # Set to True for production
    )

    # Search for products
    query = "Leite Integral"
    product_urls = await pipeline.search_products(query, max_pages=3)

    # Display results
    print("\n" + "="*80)
    print("Product URLs found:")
    print("="*80)
    for i, url in enumerate(product_urls[:10], 1):
        print(f"{i}. {url}")

    if len(product_urls) > 10:
        print(f"... and {len(product_urls) - 10} more")

    # Save results
    pipeline.save_results(query, product_urls)


if __name__ == "__main__":
    asyncio.run(main())
