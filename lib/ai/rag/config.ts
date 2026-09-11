import { Settings } from "llamaindex";
import { OllamaEmbedding } from "@llamaindex/ollama";
import { resolveModel } from "@/lib/server/resolve-model";

export async function configureRagEngine(modelString: string) {
  // 1. Resolve the current model
  const resolved = await resolveModel({ modelString });

  // 2. Tell LlamaIndex to use OpenMAIC's chosen LLM
  Settings.llm = resolved.model as unknown as import("llamaindex").LLM;

  // 3. Set a fast local embedding model (runs completely offline)
  Settings.embedModel = new OllamaEmbedding({
    model: "nomic-embed-text",
    config: {
      host: process.env.LOCAL_LLM_BASE_URL || process.env.OLLAMA_BASE_URL || "http://localhost:11434",
    }
  });
}
