import robotsParser from "robots-parser";

const DEFAULT_USER_AGENT = "tcc-price-research-bot";

interface ParsedRobots {
  isAllowed(url: string, userAgent?: string): boolean | undefined;
  getSitemaps(): string[];
  getCrawlDelay(userAgent?: string): number | undefined;
}

const parseRobots = robotsParser as unknown as (
  url: string,
  text: string,
) => ParsedRobots;

export class RobotsPolicy {
  readonly origin: string;
  readonly sitemaps: string[];
  readonly crawlDelaySeconds: number | null;
  readonly #robots: ParsedRobots;
  readonly #userAgent: string;

  private constructor(
    origin: string,
    robots: ParsedRobots,
    userAgent: string,
  ) {
    this.origin = origin;
    this.#robots = robots;
    this.#userAgent = userAgent;
    this.sitemaps = [...robots.getSitemaps()];
    this.crawlDelaySeconds = robots.getCrawlDelay(userAgent) ?? null;
  }

  static parse(
    robotsUrl: string,
    text: string,
    userAgent = DEFAULT_USER_AGENT,
  ): RobotsPolicy {
    const url = new URL(robotsUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`Robots URL protocol is not allowed: ${url.protocol}`);
    }
    return new RobotsPolicy(
      url.origin,
      parseRobots(url.toString(), text),
      userAgent,
    );
  }

  static allowAll(origin: string, userAgent = DEFAULT_USER_AGENT): RobotsPolicy {
    const robotsUrl = new URL("/robots.txt", origin).toString();
    return RobotsPolicy.parse(robotsUrl, "User-agent: *\nDisallow:\n", userAgent);
  }

  canFetch(target: string): boolean {
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      return false;
    }
    if (url.origin !== this.origin) return false;
    return this.#robots.isAllowed(url.toString(), this.#userAgent) !== false;
  }
}
