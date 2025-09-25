#!/usr/bin/env python3
"""
Product Extraction Pipeline

This pipeline uses LLM-assisted schema generation to create extraction patterns
for product data, then performs LLM-free extraction using the cached patterns.

The pipeline prioritizes collecting:
- Product identification number
- Product name
- Description
- Brand
- Package size
- Category information
- Price in standardized format
"""

import json
import asyncio
import hashlib
from pathlib import Path
from typing import List, Dict, Any, Optional
from urllib.parse import urlparse
from crawl4ai import (
    AsyncWebCrawler,
    CrawlerRunConfig,
    BrowserConfig,
    JsonCssExtractionStrategy,
    LLMExtractionStrategy,
    RegexExtractionStrategy,
    LLMConfig,
    CacheMode
)
from pydantic import BaseModel, Field


class ProductData(BaseModel):
    """Standard product data model"""
    product_id: Optional[str] = Field(
        None, description="Product identification number or SKU")
    name: str = Field(..., description="Product name")
    description: Optional[str] = Field(None, description="Product description")
    brand: Optional[str] = Field(None, description="Product brand")
    package_size: Optional[str] = Field(
        None, description="Package size or quantity")
    category: Optional[str] = Field(None, description="Product category")
    price: Optional[str] = Field(
        None, description="Product price in standardized format")
    url: Optional[str] = Field(None, description="Source URL")


class ProductExtractionPipeline:
    """Main pipeline for product extraction"""

    def __init__(self,
                 cache_dir: str = "./schema_cache",
                 association_file: str = "./url_patterns.json",
                 llm_provider: str = "openai/gpt-4o-mini",
                 api_token: str = None):
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(exist_ok=True)
        self.association_file = Path(association_file)
        self.llm_provider = llm_provider
        self.api_token = api_token
        self.url_patterns = self._load_url_patterns()

    def _load_url_patterns(self) -> Dict[str, Any]:
        """Load URL to pattern associations"""
        if self.association_file.exists():
            with open(self.association_file, 'r') as f:
                return json.load(f)
        return {}

    def _save_url_patterns(self):
        """Save URL to pattern associations"""
        with open(self.association_file, 'w') as f:
            json.dump(self.url_patterns, f, indent=2)

    def _get_domain_key(self, url: str) -> str:
        """Extract domain key from URL for pattern association"""
        parsed = urlparse(url)
        return f"{parsed.netloc}"

    def _get_pattern_cache_path(self, domain_key: str) -> Path:
        """Get cache file path for a domain pattern"""
        # Create a hash of the domain key for filename safety
        hash_key = hashlib.md5(domain_key.encode()).hexdigest()
        return self.cache_dir / f"pattern_{hash_key}.json"
    
    def _validate_and_clean_schema(self, schema: Dict[str, Any]) -> Dict[str, Any]:
        """Validate and clean CSS selectors in schema"""
        if not isinstance(schema, dict):
            return schema
            
        def clean_selector(selector: str) -> str:
            """Clean a CSS selector of problematic characters"""
            if not isinstance(selector, str):
                return selector
                
            # Remove or replace problematic patterns
            cleaned = selector
            
            # Remove escaped characters that cause parsing issues
            cleaned = cleaned.replace('\\:', ':')
            cleaned = cleaned.replace('\\', '')
            
            # Remove pseudo-classes that commonly cause issues
            problematic_patterns = [
                ':hover', ':focus', ':active', ':visited', ':link',
                ':first-child', ':last-child', ':nth-child'
            ]
            for pattern in problematic_patterns:
                cleaned = cleaned.replace(pattern, '')
            
            # Clean up any double spaces or trailing/leading spaces
            cleaned = ' '.join(cleaned.split())
            
            return cleaned
        
        def clean_schema_recursive(obj):
            """Recursively clean all CSS selectors in schema"""
            if isinstance(obj, dict):
                cleaned = {}
                for key, value in obj.items():
                    if key in ['selector', 'css_selector'] and isinstance(value, str):
                        cleaned[key] = clean_selector(value)
                    else:
                        cleaned[key] = clean_schema_recursive(value)
                return cleaned
            elif isinstance(obj, list):
                return [clean_schema_recursive(item) for item in obj]
            elif isinstance(obj, str) and any(char in obj for char in ['\\', ':']):
                # This might be a CSS selector
                return clean_selector(obj)
            else:
                return obj
        
        return clean_schema_recursive(schema)

    async def generate_schema_for_url(self, url: str) -> Dict[str, Any]:
        """Generate extraction patterns for a specific URL using LLM"""
        print(f"Generating patterns for {url}...")

        if not self.api_token:
            raise ValueError("API token required for schema generation")

        # Configure LLM
        llm_config = LLMConfig(
            provider=self.llm_provider,
            api_token=self.api_token,
        )

        # Get sample HTML for context
        browser_config = BrowserConfig(headless=False)
        async with AsyncWebCrawler(config=browser_config) as crawler:
            result = await crawler.arun(
                url=url,
                config=CrawlerRunConfig(cache_mode=CacheMode.BYPASS)
            )

            if not result.success:
                raise Exception(
                    f"Failed to crawl {url}: {result.error_message}")

            html = result.fit_html

        # Save HTML for debugging
        debug_html_file = self.cache_dir / \
            f"debug_html_{self._get_domain_key(url).replace('.', '_')}.html"
        with open(debug_html_file, 'w', encoding='utf-8') as f:
            f.write(html)
        print(f"HTML saved for debugging: {debug_html_file}")
        print(f"HTML length: {len(html)} characters")
        print(f"HTML preview (first 1000 chars):\n{html[:1000]}")

        # Generate patterns for each field using LLM
        patterns = {}

        field_queries = {
            "product_id": """Find the MAIN product's unique identifier (SKU, product code, model number). 
            Look for patterns in URLs, data attributes, or unique product codes. 
            AVOID generic numbers like quantities, prices, or timestamps. 
            Focus on the PRIMARY product being displayed, not related items.""",

            "name": """Extract the PRIMARY product title or name as displayed prominently on the page.
            Look for the main heading (h1, h2) or the biggest product title text.
            AVOID navigation links, breadcrumbs, or secondary product names.
            Focus on the MAIN product being sold.""",

            "description": """Find the detailed product description or summary text.
            Look for longer text blocks that describe the product features, benefits, or details.
            AVOID short labels, navigation text, or promotional banners.
            Extract the MAIN product description, not reviews or comments.""",

            "brand": """Identify the MAIN product's brand or manufacturer name.
            Look for brand logos, manufacturer labels, or brand-specific text near the product info.
            AVOID generic terms like 'brand', 'marca', or navigation elements.
            Focus on the actual brand name of the PRIMARY product.""",

            "package_size": """Extract ONLY the package size, weight, volume, or quantity of the MAIN product.
            Look for specific measurements like '1kg', '500ml', '12 units', etc.
            AVOID prices, product codes, or generic numbers.
            Focus on the physical quantity/size of the PRIMARY product being sold.""",

            "category": """Find the product category or classification from breadcrumbs or category labels.
            Look for navigational breadcrumb trails or category tags.
            AVOID generic words like 'products', 'home', or site navigation.
            Extract the SPECIFIC category/department of the MAIN product.""",

            "price": """Extract the CURRENT selling price of the MAIN product in the local currency format.
            Look for price displays with currency symbols (R$, $, €, etc.).
            AVOID crossed-out old prices, shipping costs, or unrelated numbers.
            Focus on the PRIMARY purchase price being offered NOW."""
        }

        # Generate a comprehensive CSS schema using LLM
        try:
            print("  Generating CSS schema for all product fields...")

            comprehensive_query = """
            Analyze this e-commerce product page and create CSS selectors for extracting:
            1. Product ID/SKU (unique identifier)
            2. Product name/title 
            3. Product description
            4. Brand name
            5. Package size/quantity
            6. Category information
            7. Current price
            
            IMPORTANT: Create SIMPLE CSS selectors only. Avoid:
            - Escaped characters like backslashes (\)
            - Complex pseudo-selectors with colons
            - Tailwind CSS classes with escape sequences
            - Use basic class names, IDs, and element selectors
            
            Examples of GOOD selectors: .product-name, #price, .description, [data-product-id]
            Examples of BAD selectors: .lg\:grid-cols-1, .sm\:text-lg, .hover\:bg-blue
            
            Focus on the MAIN product being displayed using simple, reliable selectors.
            """

            schema = JsonCssExtractionStrategy.generate_schema(
                html=html,
                query=comprehensive_query,
                llm_config=llm_config,
            )
            
            # Validate and clean CSS selectors
            if schema:
                schema = self._validate_and_clean_schema(schema)
            
            patterns = schema

        except Exception as e:
            print(f"  Warning: Failed to generate CSS schema: {e}")
            patterns = None

        return patterns

    async def get_or_generate_schema(self, url: str) -> Dict[str, Any]:
        """Get cached CSS schema or generate new one for URL"""
        domain_key = self._get_domain_key(url)
        pattern_file = self._get_pattern_cache_path(domain_key)

        # Check if we have cached schema for this domain
        if domain_key in self.url_patterns and pattern_file.exists():
            print(f"Using cached CSS schema for {domain_key}")
            with open(pattern_file, 'r') as f:
                return json.load(f)

        # Generate new schema
        schema = await self.generate_schema_for_url(url)

        if schema is None:
            raise Exception(f"Failed to generate schema for {url}")

        # Cache the schema
        with open(pattern_file, 'w') as f:
            json.dump(schema, f, indent=2)

        # Update URL associations
        self.url_patterns[domain_key] = {
            "pattern_file": str(pattern_file),
            "generated_from": url,
            "schema_hash": hashlib.md5(json.dumps(schema, sort_keys=True).encode()).hexdigest()
        }
        self._save_url_patterns()

        print(f"Generated and cached CSS schema for {domain_key}")
        return schema

    async def extract_products_from_url(self, url: str) -> List[Dict[str, Any]]:
        """Extract products from URL using cached or generated CSS schema"""
        print(f"Extracting products from {url}...")

        # Get extraction schema
        schema = await self.get_or_generate_schema(url)

        # Extract data using CSS strategy (LLM-free)
        browser_config = BrowserConfig(
            headless=False, java_script_enabled=True)
        extraction_strategy = JsonCssExtractionStrategy(schema)

        config = CrawlerRunConfig(
            cache_mode=CacheMode.BYPASS,
            extraction_strategy=extraction_strategy,
            delay_before_return_html=2
        )

        async with AsyncWebCrawler(config=browser_config) as crawler:
            result = await crawler.arun(url=url, config=config)

            if result.success and result.extracted_content:
                try:
                    products = json.loads(result.extracted_content)

                    # Add source URL to each product
                    for product in products:
                        product['url'] = url

                    print(
                        f"Successfully extracted {len(products)} products from {url}")
                    return products

                except json.JSONDecodeError as e:
                    print(f"Failed to parse extracted JSON: {e}")
                    print(f"Raw content: {result.extracted_content[:500]}...")
                    return []
            else:
                print(f"Failed to extract from {url}: {result.error_message}")
                return []

    async def process_urls(self, urls: List[str]) -> Dict[str, List[Dict[str, Any]]]:
        """Process multiple URLs and extract products"""
        results = {}

        for url in urls:
            try:
                products = await self.extract_products_from_url(url)
                results[url] = products
            except Exception as e:
                print(f"Error processing {url}: {str(e)}")
                results[url] = []

        return results

    def save_results(self, results: Dict[str, List[Dict[str, Any]]], output_file: str = "extracted_products.json"):
        """Save extraction results to file"""
        output_path = Path(output_file)

        # Flatten results for easier analysis
        all_products = []
        for url, products in results.items():
            all_products.extend(products)

        output_data = {
            "total_products": len(all_products),
            "urls_processed": len(results),
            "results_by_url": results,
            "all_products": all_products
        }

        with open(output_path, 'w') as f:
            json.dump(output_data, f, indent=2, ensure_ascii=False)

        print(f"Results saved to {output_path}")
        return output_path


async def main():
    """Example usage"""
    # Initialize pipeline
    pipeline = ProductExtractionPipeline(
        api_token="env:OPENAI_API_KEY"  # Will read from environment
    )

    # Example URLs (replace with actual product URLs)
    urls = [
        "https://mercado.carrefour.com.br/feijao-carioca-tipo-1-kicaldo-1kg-466506/p",
    ]

    # Process URLs
    results = await pipeline.process_urls(urls)

    # Save results
    pipeline.save_results(results)

    # Print summary
    total_products = sum(len(products) for products in results.values())
    print(f"\nPipeline completed:")
    print(f"- Processed {len(urls)} URLs")
    print(f"- Extracted {total_products} products total")
    print(f"- Cached patterns for {len(pipeline.url_patterns)} domains")


if __name__ == "__main__":
    asyncio.run(main())
