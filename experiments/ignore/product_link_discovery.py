#!/usr/bin/env python3
"""
Product Link Discovery Strategy

Discovers ALL product links from e-commerce websites using:
1. URL Seeding (fast bulk discovery from sitemaps/Common Crawl)
2. Deep Crawling (fallback for dynamic discovery)

The strategy automatically detects product URL patterns and filters accordingly.
"""

import asyncio
import json
import re
from pathlib import Path
from typing import List, Dict, Any, Optional, Set
from urllib.parse import urlparse, urljoin
from dataclasses import dataclass, asdict

from crawl4ai import AsyncUrlSeeder, SeedingConfig, AsyncWebCrawler, CrawlerRunConfig
from crawl4ai.deep_crawling import BFSDeepCrawlStrategy, BestFirstCrawlingStrategy
from crawl4ai.deep_crawling.filters import FilterChain, URLPatternFilter, DomainFilter
from crawl4ai.deep_crawling.scorers import KeywordRelevanceScorer


@dataclass
class DiscoveryResult:
    """Result of product link discovery"""
    merchant_url: str
    total_urls: int
    product_urls: List[str]
    discovery_method: str  # "url_seeding", "deep_crawl", or "hybrid"
    url_patterns_detected: List[str]
    metadata: Dict[str, Any]


class ProductLinkDiscovery:
    """Discovers product links from e-commerce websites"""

    # Common product URL patterns for e-commerce sites
    COMMON_PRODUCT_PATTERNS = [
        "*/product/*",
        "*/produtos/*",
        "*/p/*",
        "*/pd/*",
        "*/item/*",
        "*/items/*",
        "*-p-*",
        "*/dp/*",  # Amazon style
        "*/gp/product/*",  # Amazon style
    ]

    # Keywords that indicate product pages
    PRODUCT_KEYWORDS = [
        "product", "produto", "item", "artigo",
        "buy", "comprar", "shop", "loja"
    ]

    # Patterns to exclude (non-product pages)
    EXCLUDE_PATTERNS = [
        "*/cart/*", "*/checkout/*", "*/account/*", "*/login/*",
        "*/register/*", "*/search/*", "*/category/*", "*/categories/*",
        "*/blog/*", "*/about/*", "*/contact/*", "*/help/*",
        "*/terms/*", "*/privacy/*", "*/faq/*"
    ]

    def __init__(self, cache_dir: str = "./discovery_cache"):
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(exist_ok=True)
        self.seeder = None

    async def __aenter__(self):
        self.seeder = AsyncUrlSeeder()
        await self.seeder.__aenter__()
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        if self.seeder:
            await self.seeder.__aexit__(exc_type, exc_val, exc_tb)

    def _get_domain(self, url: str) -> str:
        """Extract domain from URL"""
        return urlparse(url).netloc

    def _detect_product_patterns(self, urls: List[str]) -> List[str]:
        """
        Analyze URLs to detect product-specific patterns.
        Returns list of detected patterns.
        """
        detected_patterns = set()

        # Count URL path segments to find common patterns
        path_patterns = {}

        for url in urls[:100]:  # Sample first 100 URLs
            parsed = urlparse(url)
            path = parsed.path

            # Check against common patterns
            for pattern in self.COMMON_PRODUCT_PATTERNS:
                pattern_regex = pattern.replace("*", ".*").replace("/", "\\/")
                if re.search(pattern_regex, path):
                    detected_patterns.add(pattern)

            # Analyze path structure
            segments = [s for s in path.split('/') if s]
            if len(segments) >= 2:
                # Check for product-like patterns
                for segment in segments:
                    # Look for product keywords
                    if any(keyword in segment.lower() for keyword in self.PRODUCT_KEYWORDS):
                        # Create a pattern from this structure
                        pattern = f"*/{segment}/*"
                        detected_patterns.add(pattern)

        return list(detected_patterns) if detected_patterns else self.COMMON_PRODUCT_PATTERNS

    def _is_likely_product_url(self, url: str) -> bool:
        """
        Heuristic check if a URL is likely a product page.
        """
        parsed = urlparse(url)
        path = parsed.path.lower()

        # Exclude known non-product patterns
        for exclude_pattern in self.EXCLUDE_PATTERNS:
            exclude_regex = exclude_pattern.replace("*", ".*").replace("/", "\\/")
            if re.search(exclude_regex, path):
                return False

        # Check for product indicators
        product_indicators = [
            # Common product URL structures
            re.search(r'/p(?:roduct)?(?:o)?s?/[\w-]+', path),
            re.search(r'/item/[\w-]+', path),
            re.search(r'/dp/[\w-]+', path),
            re.search(r'-p-\d+', path),
            # Product ID patterns
            re.search(r'/\d{4,}', path),  # Long numeric IDs
            # SKU patterns
            re.search(r'[\w]+-\d+', path),
        ]

        # Check query parameters
        query = parsed.query.lower()
        query_indicators = [
            'productid' in query,
            'product_id' in query,
            'pid=' in query,
            'sku=' in query,
        ]

        return any(product_indicators) or any(query_indicators)

    def _filter_product_urls(self, urls: List[Dict[str, Any]]) -> List[str]:
        """
        Filter URLs to keep only product pages.
        """
        product_urls = []

        for url_data in urls:
            url = url_data.get('url', '')

            if not url:
                continue

            # Check if URL is valid
            if url_data.get('status') == 'not_valid':
                continue

            # Check if it's a product URL
            if self._is_likely_product_url(url):
                product_urls.append(url)

        return product_urls

    async def discover_via_url_seeding(
        self,
        merchant_url: str,
        max_urls: int = -1,
        use_scoring: bool = False
    ) -> DiscoveryResult:
        """
        Discover product links using URL seeding (fast bulk discovery).

        Args:
            merchant_url: Base URL of the merchant site
            max_urls: Maximum URLs to discover (-1 for unlimited)
            use_scoring: Whether to use BM25 scoring for relevance
        """
        print(f"\n🔍 Starting URL seeding discovery for {merchant_url}")

        domain = self._get_domain(merchant_url)

        # Step 1: Initial discovery without filtering
        print("📡 Discovering URLs from sitemap and Common Crawl...")

        config = SeedingConfig(
            source="sitemap+cc",  # Use both sources for maximum coverage
            extract_head=False,   # Fast discovery without metadata
            max_urls=max_urls if max_urls > 0 else -1,
            concurrency=50,
            verbose=True,
            filter_nonsense_urls=True,  # Remove utility URLs
        )

        try:
            discovered_urls = await self.seeder.urls(domain, config)
            print(f"✅ Discovered {len(discovered_urls)} total URLs")
        except Exception as e:
            print(f"❌ URL seeding failed: {e}")
            return DiscoveryResult(
                merchant_url=merchant_url,
                total_urls=0,
                product_urls=[],
                discovery_method="url_seeding",
                url_patterns_detected=[],
                metadata={"error": str(e)}
            )

        if not discovered_urls:
            print("⚠️ No URLs discovered via URL seeding")
            return DiscoveryResult(
                merchant_url=merchant_url,
                total_urls=0,
                product_urls=[],
                discovery_method="url_seeding",
                url_patterns_detected=[],
                metadata={}
            )

        # Step 2: Detect product URL patterns
        print("\n🔎 Analyzing URL patterns...")
        url_list = [u['url'] for u in discovered_urls]
        detected_patterns = self._detect_product_patterns(url_list)
        print(f"📋 Detected patterns: {detected_patterns}")

        # Step 3: Filter for product URLs
        print("\n🎯 Filtering product URLs...")
        product_urls = self._filter_product_urls(discovered_urls)
        print(f"✅ Found {len(product_urls)} product URLs")

        # Step 4: Optional BM25 scoring for prioritization
        if use_scoring and product_urls:
            print("\n📊 Applying BM25 scoring for prioritization...")

            config_scored = SeedingConfig(
                source="sitemap+cc",
                extract_head=True,
                query="product buy price purchase",
                scoring_method="bm25",
                score_threshold=0.3,
                max_urls=max_urls if max_urls > 0 else -1,
                concurrency=20,
                verbose=True,
            )

            try:
                scored_urls = await self.seeder.urls(domain, config_scored)
                scored_product_urls = [
                    u['url'] for u in scored_urls
                    if self._is_likely_product_url(u['url'])
                ]

                if scored_product_urls:
                    product_urls = scored_product_urls
                    print(f"✅ Refined to {len(product_urls)} scored product URLs")
            except Exception as e:
                print(f"⚠️ Scoring failed, using unscored results: {e}")

        return DiscoveryResult(
            merchant_url=merchant_url,
            total_urls=len(discovered_urls),
            product_urls=product_urls,
            discovery_method="url_seeding",
            url_patterns_detected=detected_patterns,
            metadata={
                "source": "sitemap+cc",
                "scoring_used": use_scoring
            }
        )

    async def discover_via_deep_crawl(
        self,
        merchant_url: str,
        max_depth: int = 2,
        max_pages: int = 100
    ) -> DiscoveryResult:
        """
        Discover product links using deep crawling (dynamic discovery).

        Args:
            merchant_url: Starting URL
            max_depth: Maximum depth to crawl
            max_pages: Maximum pages to crawl
        """
        print(f"\n🕷️ Starting deep crawl discovery for {merchant_url}")

        domain = self._get_domain(merchant_url)

        # Create filters for product pages
        domain_filter = DomainFilter(
            allowed_domains=[domain],
            blocked_domains=[]
        )

        # Create scorer to prioritize product pages
        scorer = KeywordRelevanceScorer(
            keywords=self.PRODUCT_KEYWORDS,
            weight=0.8
        )

        # Use BestFirstCrawling for intelligent prioritization
        strategy = BestFirstCrawlingStrategy(
            max_depth=max_depth,
            include_external=False,
            url_scorer=scorer,
            max_pages=max_pages,
            filter_chain=FilterChain([domain_filter])
        )

        config = CrawlerRunConfig(
            deep_crawl_strategy=strategy,
            stream=True,
            verbose=True
        )

        discovered_urls = []

        try:
            async with AsyncWebCrawler() as crawler:
                print(f"🚀 Crawling {merchant_url} (max_depth={max_depth}, max_pages={max_pages})")

                async for result in await crawler.arun(merchant_url, config=config):
                    if result.success:
                        url = result.url
                        discovered_urls.append(url)
                        print(f"  ✓ Discovered: {url}")

                print(f"\n✅ Deep crawl completed: {len(discovered_urls)} URLs discovered")

        except Exception as e:
            print(f"❌ Deep crawl failed: {e}")
            return DiscoveryResult(
                merchant_url=merchant_url,
                total_urls=0,
                product_urls=[],
                discovery_method="deep_crawl",
                url_patterns_detected=[],
                metadata={"error": str(e)}
            )

        # Filter for product URLs
        product_urls = [url for url in discovered_urls if self._is_likely_product_url(url)]

        # Detect patterns
        detected_patterns = self._detect_product_patterns(product_urls)

        return DiscoveryResult(
            merchant_url=merchant_url,
            total_urls=len(discovered_urls),
            product_urls=product_urls,
            discovery_method="deep_crawl",
            url_patterns_detected=detected_patterns,
            metadata={
                "max_depth": max_depth,
                "max_pages": max_pages
            }
        )

    async def discover(
        self,
        merchant_url: str,
        method: str = "auto",
        max_urls: int = -1,
        max_depth: int = 2,
        max_pages: int = 100
    ) -> DiscoveryResult:
        """
        Discover product links using the specified method.

        Args:
            merchant_url: Merchant website URL
            method: Discovery method - "url_seeding", "deep_crawl", or "auto"
            max_urls: Maximum URLs for URL seeding (-1 for unlimited)
            max_depth: Maximum depth for deep crawling
            max_pages: Maximum pages for deep crawling
        """
        if method == "auto":
            # Try URL seeding first (faster)
            result = await self.discover_via_url_seeding(merchant_url, max_urls)

            # If URL seeding found few results, try deep crawl
            if len(result.product_urls) < 10:
                print("\n⚠️ URL seeding found few results, trying deep crawl...")
                deep_result = await self.discover_via_deep_crawl(
                    merchant_url, max_depth, max_pages
                )

                # Combine results
                if deep_result.product_urls:
                    combined_urls = list(set(result.product_urls + deep_result.product_urls))
                    return DiscoveryResult(
                        merchant_url=merchant_url,
                        total_urls=result.total_urls + deep_result.total_urls,
                        product_urls=combined_urls,
                        discovery_method="hybrid",
                        url_patterns_detected=list(set(
                            result.url_patterns_detected +
                            deep_result.url_patterns_detected
                        )),
                        metadata={
                            "url_seeding_count": len(result.product_urls),
                            "deep_crawl_count": len(deep_result.product_urls)
                        }
                    )

            return result

        elif method == "url_seeding":
            return await self.discover_via_url_seeding(merchant_url, max_urls)

        elif method == "deep_crawl":
            return await self.discover_via_deep_crawl(merchant_url, max_depth, max_pages)

        else:
            raise ValueError(f"Unknown method: {method}")

    def save_results(self, result: DiscoveryResult, output_file: str = None) -> Path:
        """Save discovery results to JSON file"""
        if output_file is None:
            domain = self._get_domain(result.merchant_url).replace(".", "_")
            output_file = self.cache_dir / f"discovery_{domain}.json"
        else:
            output_file = Path(output_file)

        with open(output_file, 'w', encoding='utf-8') as f:
            json.dump(asdict(result), f, indent=2, ensure_ascii=False)

        print(f"\n💾 Results saved to {output_file}")
        return output_file


async def main():
    """Example usage"""

    # Test with Carrefour
    merchant_url = "https://mercado.carrefour.com.br/"

    async with ProductLinkDiscovery() as discovery:
        # Discover product links
        result = await discovery.discover(
            merchant_url=merchant_url,
            method="auto",  # Try URL seeding first, fallback to deep crawl
            max_urls=1000,  # Limit for testing
            max_depth=2,
            max_pages=100
        )

        # Print summary
        print("\n" + "="*60)
        print("📊 DISCOVERY SUMMARY")
        print("="*60)
        print(f"Merchant: {result.merchant_url}")
        print(f"Method: {result.discovery_method}")
        print(f"Total URLs discovered: {result.total_urls}")
        print(f"Product URLs found: {len(result.product_urls)}")
        print(f"\nDetected patterns:")
        for pattern in result.url_patterns_detected:
            print(f"  - {pattern}")

        print(f"\nSample product URLs (first 10):")
        for i, url in enumerate(result.product_urls[:10], 1):
            print(f"  {i}. {url}")

        # Save results
        output_file = discovery.save_results(result)

        print(f"\n✅ Discovery complete!")
        print(f"   Product URLs ready for extraction pipeline")
        print(f"   Results saved to: {output_file}")


if __name__ == "__main__":
    asyncio.run(main())
