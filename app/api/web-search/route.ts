/**
 * Web Search API
 *
 * POST /api/web-search
 * Simple JSON request/response using Tavily search.
 */

import { NextRequest } from 'next/server';
import { callLLM } from '@/lib/ai/llm';
import { searchWithTavily, formatSearchResultsAsContext } from '@/lib/web-search/tavily';
import { searchWithSearXNG } from '@/lib/web-search/searxng';
import { resolveWebSearchApiKey } from '@/lib/server/provider-config';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import {
  buildSearchQuery,
  SEARCH_QUERY_REWRITE_EXCERPT_LENGTH,
} from '@/lib/server/search-query-builder';
import { resolveModelFromHeaders } from '@/lib/server/resolve-model';
import type { AICallFn } from '@/lib/generation/pipeline-types';

const log = createLogger('WebSearch');

export async function POST(req: NextRequest) {
  let query: string | undefined;
  try {
    const body = await req.json();
    const {
      query: requestQuery,
      pdfText,
      apiKey: clientApiKey,
      providerId,
      baseUrl,
    } = body as {
      query?: string;
      pdfText?: string;
      apiKey?: string;
      providerId?: string;
      baseUrl?: string;
    };
    query = requestQuery;

    if (!query || !query.trim()) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'query is required');
    }

    let result;
    if (providerId === 'searxng') {
      result = await searchWithSearXNG({
        query: query.trim(),
        baseUrl: baseUrl || process.env.SEARXNG_URL || 'http://127.0.0.1:8080/search'
      });
    } else if (providerId === 'tavily' || !providerId) {
      const apiKey = resolveWebSearchApiKey(clientApiKey);
      if (!apiKey) {
        return apiError(
          'MISSING_API_KEY',
          400,
          'Tavily API key is not configured. Set it in Settings → Web Search or set TAVILY_API_KEY env var.',
        );
      }
      result = await searchWithTavily({ query: query.trim(), apiKey });
    } else {
      return apiError('INVALID_PROVIDER', 400, `Unsupported web search provider: ${providerId}`);
    }

    // Clamp rewrite input at the route boundary; framework body limits still apply to total request size.
    const boundedPdfText = pdfText?.slice(0, SEARCH_QUERY_REWRITE_EXCERPT_LENGTH);

    let aiCall: AICallFn | undefined;
    try {
      const { model: languageModel } = await resolveModelFromHeaders(req);
      aiCall = async (systemPrompt, userPrompt) => {
        const result = await callLLM(
          {
            model: languageModel,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
            maxOutputTokens: 256,
          },
          'web-search-query-rewrite',
        );
        return result.text;
      };
    } catch (error) {
      log.warn('Search query rewrite model unavailable, falling back to raw requirement:', error);
    }

    const searchQuery = await buildSearchQuery(query, boundedPdfText, aiCall);

    log.info('Running web search API request', {
      hasPdfContext: searchQuery.hasPdfContext,
      rawRequirementLength: searchQuery.rawRequirementLength,
      rewriteAttempted: searchQuery.rewriteAttempted,
      finalQueryLength: searchQuery.finalQueryLength,
    });

    let finalAnswer, finalSources, finalQuery, finalResponseTime;

    if (providerId === 'searxng') {
       const searchRes = await searchWithSearXNG({ query: searchQuery.query, baseUrl: baseUrl || process.env.SEARXNG_URL || 'http://127.0.0.1:8080/search' });
       finalAnswer = searchRes.answer;
       finalSources = searchRes.sources;
       finalQuery = searchRes.query;
       finalResponseTime = searchRes.responseTime;
    } else if (providerId === 'tavily' || !providerId) {
       const resolvedApiKey = resolveWebSearchApiKey(clientApiKey);
       const searchRes = await searchWithTavily({ query: searchQuery.query, apiKey: resolvedApiKey! });
       finalAnswer = searchRes.answer;
       finalSources = searchRes.sources;
       finalQuery = searchRes.query;
       finalResponseTime = searchRes.responseTime;
    } else {
       return apiError('INVALID_PROVIDER', 400, `Unsupported web search provider: ${providerId}`);
    }
    const context = formatSearchResultsAsContext({ answer: finalAnswer, sources: finalSources, query: finalQuery, responseTime: finalResponseTime });

    return apiSuccess({
      answer: finalAnswer,
      sources: finalSources,
      context,
      query: finalQuery,
      responseTime: finalResponseTime,
    });
  } catch (err) {
    log.error(`Web search failed [query="${query?.substring(0, 60) ?? 'unknown'}"]:`, err);
    const message = err instanceof Error ? err.message : 'Web search failed';
    return apiError('INTERNAL_ERROR', 500, message);
  }
}
