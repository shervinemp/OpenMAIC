/**
 * Stateless Multi-Agent Generation
 *
 * Single-pass generation with structured JSON Array output format:
 * [{"type":"action","name":"...","params":{...}},{"type":"text","content":"natural speech"},...]
 *
 * Key design decisions:
 * - Backend is stateless (all state in request/response)
 * - Single generation pass (no generate/tool/loop)
 * - Text is natural teacher speech, NOT meta-commentary
 * - Tool calls are silent actions - students see results only
 * - Action and text objects can freely interleave in the array
 * - Uses partial-json for robust streaming of incomplete JSON
 *
 * Multi-agent orchestration:
 * - When multiple agents are configured, a director agent decides who speaks
 * - Uses LangGraph StateGraph for the orchestration loop
 * - Events are streamed via LangGraph's custom stream mode
 */

import type { LanguageModel } from 'ai';
import type { StatelessChatRequest, StatelessEvent, ParsedAction } from '@/lib/types/chat';
import type { ThinkingConfig } from '@/lib/types/provider';
import type { WhiteboardActionRecord } from './director-prompt';
import { createOrchestrationGraph, buildInitialState } from './director-graph';
import { parse as parsePartialJson, Allow } from 'partial-json';
import { jsonrepair } from 'jsonrepair';
import { createLogger } from '@/lib/logger';

const log = createLogger('StatelessGenerate');

// ==================== Structured Output Parser ====================

/**
 * Parser state for incremental JSON Array parsing.
 *
 * Accumulates raw text from the LLM stream. Once the opening `[` is found,
 * uses `partial-json` to incrementally parse the growing array. Emits new
 * complete items as they appear, and streams partial text content deltas
 * for the last (potentially incomplete) text item.
 */
interface ParserState {
  /** Accumulated raw text from the LLM */
  buffer: string;
  /** Whether we've found the opening `[` */
  jsonStarted: boolean;
  /** Number of fully processed (emitted) items */
  lastParsedItemCount: number;
  /** Length of text content already emitted for the trailing partial text item */
  lastPartialTextLength: number;
  /** Whether parsing is complete (closing `]` found) */
  isDone: boolean;
}

/**
 * Create initial parser state
 */
export function createParserState(): ParserState {
  return {
    buffer: '',
    jsonStarted: false,
    lastParsedItemCount: 0,
    lastPartialTextLength: 0,
    isDone: false,
  };
}

/**
 * Result from parsing a chunk
 */
export interface ParseResult {
  textChunks: string[];
  actions: ParsedAction[];
  isDone: boolean;
  /** Ordered sequence recording original interleaving of text and action segments */
  ordered: Array<{ type: 'text'; index: number } | { type: 'action'; index: number }>;
}

/**
 * Emit a single parsed item into the result, returning updated segment indices.
 */
function emitItem(
  item: Record<string, unknown>,
  result: ParseResult,
  textSegmentIndex: number,
  actionSegmentIndex: number,
): { textSegmentIndex: number; actionSegmentIndex: number } {
  if (item.type === 'text') {
    const content = (item.content as string) || '';
    if (content) {
      result.textChunks.push(content);
      // Use per-call array index (not cumulative segment index) so that
      // director-graph can read result.textChunks[entry.index] correctly.
      result.ordered.push({
        type: 'text',
        index: result.textChunks.length - 1,
      });
      return { textSegmentIndex: textSegmentIndex + 1, actionSegmentIndex };
    }
  } else if (item.type === 'action') {
    // Support both new format (name/params) and legacy format (tool_name/parameters)
    const action: ParsedAction = {
      actionId:
        (item.action_id as string) || `action-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      actionName: (item.name || item.tool_name) as string,
      params: (item.params || item.parameters || {}) as Record<string, unknown>,
    };
    result.actions.push(action);
    // Use per-call array index (not cumulative segment index) so that
    // director-graph can read result.actions[entry.index] correctly.
    result.ordered.push({ type: 'action', index: result.actions.length - 1 });
    return { textSegmentIndex, actionSegmentIndex: actionSegmentIndex + 1 };
  }
  return { textSegmentIndex, actionSegmentIndex };
}

/**
 * Parse streaming chunks of structured JSON Array output.
 *
 * The LLM is expected to produce a JSON array like:
 * [{"type":"action","name":"spotlight","params":{"elementId":"img_1"}},
 *  {"type":"text","content":"Hello students..."},...]
 *
 * This parser:
 * 1. Accumulates chunks into a buffer
 * 2. Skips any prefix before `[` (e.g. ```json\n, explanatory text)
 * 3. Uses partial-json to incrementally parse the growing array
 * 4. Emits new complete items (action→toolCall, text→textChunk)
 * 5. For the trailing incomplete text item, emits content deltas for streaming
 * 6. Marks done when the buffer contains the closing `]`
 *
 * @param chunk - New chunk of text to parse
 * @param state - Current parser state (mutated in place)
 * @returns Parsed text chunks and tool calls from this chunk
 */
export function parseStructuredChunk(chunk: string, state: ParserState): ParseResult {
  const result: ParseResult = {
    textChunks: [],
    actions: [],
    isDone: false,
    ordered: [],
  };

  if (state.isDone) {
    return result;
  }

  state.buffer += chunk;

  // Step 1: Find the opening `[` containing an object `{` if not yet found
  if (!state.jsonStarted) {
    const match = state.buffer.match(/\[\s*\{/);
    if (!match) {
      return result;
    }
    // Trim everything before the actual `[`
    const bracketIndex = state.buffer.indexOf('[', match.index);
    state.buffer = state.buffer.slice(bracketIndex);
    state.jsonStarted = true;
  }

  // Step 2: Extract complete JSON objects (finite-state machine approach)
  // Instead of passing the entire array to jsonrepair every time, we find complete objects,
  // slice them out, and emit them. The buffer will only hold the currently incomplete object.
  let openBraces = 0;
  let inString = false;
  let escapeNext = false;
  let lastValidEnd = 0;
  let firstBrace = -1;

  for (let i = 0; i < state.buffer.length; i++) {
    const char = state.buffer[i];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (char === '\\') {
      escapeNext = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (char === '{') {
        if (openBraces === 0) firstBrace = i;
        openBraces++;
      } else if (char === '}') {
        openBraces--;
        if (openBraces === 0 && firstBrace !== -1) {
          // We found a complete object
          const objectString = state.buffer.slice(firstBrace, i + 1);
          lastValidEnd = i + 1;

          try {
            const repaired = jsonrepair(objectString);
            const item = JSON.parse(repaired);

            if (item && typeof item === 'object') {
              // Since we process complete objects one by one, we no longer need to
              // track text delta offsets for them.
              emitItem(item, result, state.lastParsedItemCount, state.lastParsedItemCount);
              state.lastParsedItemCount++;
              state.lastPartialTextLength = 0; // Reset as we finished an object
            }
          } catch (_e) {
            // Ignore parse errors on individual objects
          }

          firstBrace = -1;
        }
      }
    }
  }

  // Remove completely parsed objects from the buffer to avoid O(N²) bloat
  if (lastValidEnd > 0) {
    state.buffer = '[' + state.buffer.slice(lastValidEnd).replace(/^\s*,\s*/, '');
  }

  // Step 3: Stream partial text delta for the currently incomplete object
  if (state.buffer.length > 1) {
    try {
      // Try to parse the remaining buffer incrementally
      const parsed = parsePartialJson(
        state.buffer,
        Allow.ARR | Allow.OBJ | Allow.STR | Allow.NUM | Allow.BOOL | Allow.NULL,
      );

      if (Array.isArray(parsed) && parsed.length > 0) {
        const lastItem = parsed[parsed.length - 1];
        if (lastItem && typeof lastItem === 'object' && lastItem.type === 'text') {
          const content = lastItem.content || '';
          if (content.length > state.lastPartialTextLength) {
            result.textChunks.push(content.slice(state.lastPartialTextLength));
            state.lastPartialTextLength = content.length;
          }
        }
      }
    } catch {
      // Ignore incremental parse errors
    }
  }

  // Step 4: Check if the array is complete
  const trimmed = state.buffer.trimEnd();
  if (trimmed === ']' || trimmed === '[]') {
    state.isDone = true;
    result.isDone = true;
    state.lastPartialTextLength = 0;
  }

  return result;
}

export function finalizeParser(state: ParserState): ParseResult {
  const result: ParseResult = {
    textChunks: [],
    actions: [],
    isDone: true,
    ordered: [],
  };

  if (state.isDone) {
    return result;
  }

  const content = state.buffer.trim();
  if (!content) {
    return result;
  }

  if (!state.jsonStarted) {
    // Model never output `[` — treat entire buffer as plain text
    result.textChunks.push(content);
    result.ordered.push({ type: 'text', index: 0 });
  } else {
    // JSON started but never closed — try one final parse
    const finalChunk = parseStructuredChunk('', state);
    result.textChunks.push(...finalChunk.textChunks);
    result.actions.push(...finalChunk.actions);
    result.ordered.push(...finalChunk.ordered);

    // If final parse yielded nothing, emit raw text after `[` as fallback
    if (result.textChunks.length === 0 && result.actions.length === 0) {
      const bracketIndex = content.indexOf('[');
      const raw = content.slice(bracketIndex + 1).trim();
      if (raw) {
        result.textChunks.push(raw);
        result.ordered.push({ type: 'text', index: 0 });
      }
    }
  }

  state.isDone = true;
  return result;
}

// ==================== Main Generation Function ====================

/**
 * Stateless generation with streaming via LangGraph orchestration
 *
 * @param request - The chat request with full state
 * @param abortSignal - Signal for cancellation
 * @yields StatelessEvent objects for streaming
 */
export async function* statelessGenerate(
  request: StatelessChatRequest,
  abortSignal: AbortSignal,
  languageModel: LanguageModel,
  thinkingConfig?: ThinkingConfig,
): AsyncGenerator<StatelessEvent> {
  log.info(
    `[StatelessGenerate] Starting orchestration for agents: ${request.config.agentIds.join(', ')}`,
  );
  log.info(
    `[StatelessGenerate] Message count: ${request.messages.length}, turnCount: ${request.directorState?.turnCount ?? 0}`,
  );

  try {
    const graph = createOrchestrationGraph();
    const initialState = buildInitialState(request, languageModel, thinkingConfig);

    const stream = await graph.stream(initialState, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      streamMode: 'custom' as any,
      signal: abortSignal,
    });

    let totalActions = 0;
    let totalAgents = 0;
    // Tracks whether the agent dispatched in this turn produced any text or actions.
    // Each statelessGenerate call handles exactly one agent turn (client loops externally).
    let agentHadContent = false;

    // Track current agent turn to build updated directorState
    let currentAgentId: string | null = null;
    let currentAgentName: string | null = null;
    let contentPreview = '';
    let agentActionCount = 0;
    const agentWbActions: WhiteboardActionRecord[] = [];

    for await (const chunk of stream) {
      const event = chunk as StatelessEvent;

      if (event.type === 'agent_start') {
        totalAgents++;
        currentAgentId = event.data.agentId;
        currentAgentName = event.data.agentName;
        contentPreview = '';
        agentActionCount = 0;
        agentWbActions.length = 0;
      }
      if (event.type === 'text_delta' && contentPreview.length < 100) {
        contentPreview = (contentPreview + event.data.content).slice(0, 100);
        agentHadContent = true;
      }
      if (event.type === 'action') {
        totalActions++;
        agentActionCount++;
        agentHadContent = true;
        if (event.data.actionName.startsWith('wb_')) {
          agentWbActions.push({
            actionName: event.data.actionName as WhiteboardActionRecord['actionName'],
            agentId: event.data.agentId,
            agentName: currentAgentName || event.data.agentId,
            params: event.data.params,
          });
        }
      }

      yield event;
    }

    // Build updated directorState from incoming state + this turn's data
    const incoming = request.directorState;
    const prevResponses = incoming?.agentResponses ?? [];
    const prevLedger = incoming?.whiteboardLedger ?? [];
    const prevTurnCount = incoming?.turnCount ?? 0;

    const directorState =
      totalAgents > 0
        ? {
            turnCount: prevTurnCount + 1,
            agentResponses: [
              ...prevResponses,
              {
                agentId: currentAgentId!,
                agentName: currentAgentName || currentAgentId!,
                contentPreview,
                actionCount: agentActionCount,
                whiteboardActions: [...agentWbActions],
              },
            ],
            whiteboardLedger: [...prevLedger, ...agentWbActions],
          }
        : {
            turnCount: prevTurnCount,
            agentResponses: prevResponses,
            whiteboardLedger: prevLedger,
          };

    yield {
      type: 'done',
      data: { totalActions, totalAgents, agentHadContent, directorState },
    };

    log.info(
      `[StatelessGenerate] Completed. Agents: ${totalAgents}, Actions: ${totalActions}, hadContent: ${agentHadContent}, turnCount: ${directorState.turnCount}`,
    );
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      yield { type: 'error', data: { message: 'Request interrupted' } };
    } else {
      log.error('[StatelessGenerate] Error:', error);
      yield {
        type: 'error',
        data: {
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }
}
