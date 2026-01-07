import { Injectable, Logger } from '@nestjs/common'
import { OpenAIService } from '../openai/openai.service'
import { ProcessRequestDto } from './dto/process-request.dto'
import { ProcessResponseDto } from './dto/process-response.dto'

@Injectable()
export class ExtractionTransformerService {
  private readonly logger = new Logger(ExtractionTransformerService.name)

  constructor (private readonly openaiService: OpenAIService) {}

  async process (input: ProcessRequestDto): Promise<ProcessResponseDto> {
    this.logger.log(
      `Processing scrape ${input.scrapeId ?? 'N/A'} via model ${
        input.model ?? 'gpt-4o-mini'
      }`,
    )

    const prompt = `
You are a web page analyzer.
Given the following HTML, classify whether it is a PRODUCT PAGE or a CATEGORY PAGE.
Extract key structured data if possible.

Return a strict JSON object:
{
  "pageType": "category" | "product" | "unknown",
  "title": string | null,
  "price": number | null,
  "currency": string | null,
  "links": string[],
  "metadata": { "confidence": number }
}

HTML INPUT:
${input.rawHtml.slice(0, 15000)}
`

    try {
      const result = await this.openaiService.jsonResponse<ProcessResponseDto>(
        prompt,
        input.model ?? 'gpt-4o-mini',
      )

      if (!result) {
        this.logger.warn('No JSON result returned from LLM.')
        return { pageType: 'unknown', metadata: { error: 'no_result' } }
      }

      return result
    } catch (error) {
      this.logger.error('Extraction failed', error)
      return { pageType: 'unknown', metadata: { error: 'exception' } }
    }
  }
}
