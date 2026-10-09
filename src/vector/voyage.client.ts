import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface VoyageEmbeddingResponse {
  data: { embedding: number[]; index: number }[];
}

const MAX_RETRIES = 4;
const DEFAULT_RETRY_DELAY_MS = 21_000; // Voyage's free-tier cap is 3 req/min.

// Thin wrapper over Voyage's REST API -- no official SDK dependency needed
// for a single endpoint, and keeping it as a plain fetch makes the actual
// embedding request (and its shape) easy to read end to end.
@Injectable()
export class VoyageClient {
  private readonly logger = new Logger(VoyageClient.name);

  constructor(private readonly configService: ConfigService) {}

  async embed(text: string): Promise<number[]> {
    const [embedding] = await this.embedMany([text]);
    return embedding;
  }

  // Embeds many texts in a single HTTP request -- Voyage's rate limit is
  // per *request*, not per text, so batching is what actually keeps bulk
  // operations (resume import, bulk skill add) under the free-tier cap of
  // 3 requests/minute instead of burning one request per item.
  async embedMany(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const apiKey = this.configService.getOrThrow<string>('VOYAGE_API_KEY');
    const model =
      this.configService.get<string>('VOYAGE_EMBEDDING_MODEL') ??
      'voyage-3-lite';

    const data = await this.requestWithRetry(apiKey, model, texts);
    return data
      .sort((a, b) => a.index - b.index)
      .map((entry) => entry.embedding);
  }

  private async requestWithRetry(
    apiKey: string,
    model: string,
    texts: string[],
    attempt = 1,
  ): Promise<VoyageEmbeddingResponse['data']> {
    const response = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ input: texts, model }),
    });

    if (response.status === 429 && attempt <= MAX_RETRIES) {
      const retryAfterHeader = response.headers.get('retry-after');
      const delayMs = retryAfterHeader
        ? Number(retryAfterHeader) * 1000
        : DEFAULT_RETRY_DELAY_MS;
      this.logger.warn(
        `Voyage rate-limited (attempt ${attempt}/${MAX_RETRIES}), retrying in ${delayMs}ms`,
      );
      await sleep(delayMs);
      return this.requestWithRetry(apiKey, model, texts, attempt + 1);
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Voyage embedding request failed (${response.status}): ${body}`,
      );
    }

    const data = (await response.json()) as VoyageEmbeddingResponse;
    return data.data;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
