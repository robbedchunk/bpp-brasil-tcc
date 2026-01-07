import { Injectable, Logger, OnModuleInit } from '@nestjs/common'
import OpenAI from 'openai'

@Injectable()
export class OpenAIService implements OnModuleInit {
  private readonly logger = new Logger(OpenAIService.name)
  private client: OpenAI

  onModuleInit () {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) {
      this.logger.error('OPENAI_API_KEY not found in environment variables')
      throw new Error('Missing OPENAI_API_KEY')
    }

    this.client = new OpenAI({ apiKey })
    this.logger.log('✅ OpenAI client initialized')
  }

  /**
   * Basic Chat Completion
   */
  async chat (
    prompt: string,
    model = 'gpt-4o-mini',
    temperature = 0.3,
  ): Promise<string> {
    const response = await this.client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature,
    })

    return response.choices[0].message?.content?.trim() || ''
  }

  /**
   * Structured JSON response (with automatic parsing)
   */
  async jsonResponse<T = any> (
    prompt: string,
    model = 'gpt-4o-mini',
  ): Promise<T | null> {
    const response = await this.client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0,
    })

    try {
      const json = response.choices[0].message?.content
      return json ? (JSON.parse(json) as T) : null
    } catch (err) {
      this.logger.error('JSON parse failed', err)
      return null
    }
  }

  /**
   * Low-level access for custom calls
   */
  getClient (): OpenAI {
    return this.client
  }
}
