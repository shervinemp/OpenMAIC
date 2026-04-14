import { generateText } from 'ai';
import { resolveModel } from '@/lib/server/resolve-model';
import { createLogger } from '@/lib/logger';

const log = createLogger('Smart-Router');

interface RouterParams {
  topic: string;
  requirements?: string;
  defaultModel: string;
  routerModel: string;
  fastModel: string;
  complexityThreshold: number;
  maxLengthThreshold: number;
}

export async function determineOptimalModel(params: RouterParams): Promise<string> {
  const {
    topic,
    requirements,
    defaultModel,
    routerModel,
    fastModel,
    complexityThreshold,
    maxLengthThreshold,
  } = params;

  const fullPromptContext = `${topic}\n\n${requirements || ''}`;

  log.info(`Evaluating query routing. Length: ${fullPromptContext.length} chars.`);

  // 1. Length Check (Fast Path)
  // Massive contexts usually require heavy models (larger context window, better needle-in-haystack)
  if (fullPromptContext.length > maxLengthThreshold) {
    log.info(
      `Query exceeds length threshold (${fullPromptContext.length} > ${maxLengthThreshold}). Routing to HEAVY model: ${defaultModel}`
    );
    return defaultModel;
  }

  // 2. Complexity Check via LLM
  try {
    const resolvedRouterModel = await resolveModel({ modelString: routerModel });

    log.info(`Asking router model (${routerModel}) to evaluate complexity...`);

    const evaluation = await generateText({
      model: resolvedRouterModel.model,
      system: `You are a highly efficient query routing AI. Your only job is to evaluate the complexity of the user's educational prompt on a scale of 1 to 10.
      1-4: Simple topic, common knowledge, brief summary, basic definitions.
      5-7: Moderate structure required, specific formatting, nuanced subject matter.
      8-10: Extremely complex, requires deep reasoning, complex JSON schema generation, programming code, or obscure academic concepts.

      OUTPUT STRICTLY AN INTEGER FROM 1 TO 10. DO NOT OUTPUT ANY OTHER TEXT.`,
      prompt: `Evaluate this prompt:\n\n"${fullPromptContext}"`,
      maxTokens: 5,
      temperature: 0.1, // Keep it deterministic
    });

    // Parse the result safely using regex to grab the first number it outputs
    const match = evaluation.text.match(/\d+/);
    const score = match ? parseInt(match[0], 10) : 10; // Default to 10 if confused

    log.info(`Complexity score evaluated as: ${score}/10`);

    if (score >= complexityThreshold) {
      log.info(`Score >= ${complexityThreshold}. Routing to HEAVY model: ${defaultModel}`);
      return defaultModel;
    } else {
      log.info(`Score < ${complexityThreshold}. Routing to FAST model: ${fastModel}`);
      return fastModel;
    }
  } catch (error) {
    log.error("Smart Router evaluation failed. Falling back to heavy model safely.", error);
    return defaultModel;
  }
}
