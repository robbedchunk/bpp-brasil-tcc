# Ethics, politeness, and terms-of-service posture

This research collects factual product and price observations. It collects no
customer, employee, address-book, account, payment, or other personal data.
Saved public fixtures are reduced to product fields; cookies, tokens, headers,
session identifiers, address details, and unrelated page state are removed.

## Politeness controls

- one São Paulo CEP per retailer, recorded in configuration;
- off-peak daily collection and weekly discovery;
- page concurrency constrained to 3–5;
- at most 2,000 product attempts per retailer/day;
- randomized bounded delays and timeouts, plus per-retailer exponential blocking
  backoff before a persistent-blocking stop;
- identifiable research user agent where practical;
- robots.txt respected for sitemap and DOM discovery.

Three consecutive hard access failures, or three consecutive timeout/network
failures, stop the affected retailer's unstarted remainder. Requests already in
flight finish and are recorded; skipped products are never fabricated as failed
attempts. The browser uses only the charter-approved minimal stable São Paulo
profile (`pt-BR`, `AutomationControlled` disabled, and `navigator.webdriver`
normalized) while retaining the identifying academic user agent. The system does
not use proxies, CAPTCHA-solving/bypass, stolen sessions, broader fingerprint
spoofing, or paid anti-blocking services. Any such change requires author
approval and is outside the current pilot.

## Site terms and legal limits

Retailer terms and technical policies vary and may change. This document is an
engineering/research posture, not legal advice and not a claim that every site
permits every collection mode. The system minimizes requests, limits scope to
the research basket, records blocking honestly, and pauses an affected path when
authority is required.

Prices and availability are factual observations, but surrounding page content
may be protected. Raw HTML is retained privately only as a small replay sample
for debugging/healing and is never published. Public data contains normalized
facts, aggregate-safe operational evidence, provenance, and sanitized fixtures.

The thesis should disclose these controls, limitations, site changes, panel
gaps, and the absence of statistical-validation claims.
