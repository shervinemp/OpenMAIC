import { createLogger } from '@/lib/logger';
import type { ImageGenerationOptions, ImageGenerationResult, VideoGenerationOptions, VideoGenerationResult } from '../types';

const log = createLogger('ComfyUI-Generic-Adapter');

// Define the interface for our dynamic config
interface ComfyUIConfig {
  baseUrl: string;
  nodeMapping: {
    textPromptNodeId: string;
    textPromptField: string;
    seedNodeId?: string | null;
    seedField?: string;
    imageInputNodeId?: string | null;
    imageInputField?: string;
    outputNodeId: string;
  };
  workflowTemplate: Record<string, unknown>;
}

// Helper to load the config dynamically at runtime
async function loadComfyConfig(): Promise<ComfyUIConfig> {
  if (typeof window !== 'undefined') {
    throw new Error('ComfyUI config cannot be loaded in the browser.');
  }

  // Workaround to avoid webpack bundling `fs` and `path` for the client
  // since this adapter might be imported in client components indirectly.
  const fs = eval(`require('fs')`);
  const path = eval(`require('path')`);

  const configPath = path.join(process.cwd(), 'comfyui-config.json');
  if (!fs.existsSync(configPath)) {
    throw new Error(`ComfyUI config not found at ${configPath}. Please create it.`);
  }
  const fileContent = await fs.promises.readFile(configPath, 'utf-8');
  return JSON.parse(fileContent);
}

export async function generateWithGenericComfyUI(
  // I need to use Options and not Params because the codebase uses Options,
  // I can look up the structure of ImageGenerationOptions/VideoGenerationOptions
  params: unknown
): Promise<unknown> {
  log.info(`Initializing Generic ComfyUI Generation for prompt: ${(params as { prompt?: string; providerId?: string; modelId?: string; duration?: number }).prompt}`);

  try {
    const config = await loadComfyConfig();
    const { baseUrl, nodeMapping, workflowTemplate } = config;

    // 1. Deep clone the template so we don't mutate the base object in memory
    const workflow = JSON.parse(JSON.stringify(workflowTemplate));

    // 2. DYNAMIC INJECTION: Text Prompt
    if (workflow[nodeMapping.textPromptNodeId] && workflow[nodeMapping.textPromptNodeId].inputs) {
      workflow[nodeMapping.textPromptNodeId].inputs[nodeMapping.textPromptField] = params.prompt;
    } else {
      log.warn(`Prompt Node ID ${nodeMapping.textPromptNodeId} not found in workflow.`);
    }

    // 3. DYNAMIC INJECTION: Random Seed (Forces new generation)
    if (nodeMapping.seedNodeId && workflow[nodeMapping.seedNodeId]) {
      const seedField = nodeMapping.seedField || 'seed';
      workflow[nodeMapping.seedNodeId].inputs[seedField] = Math.floor(Math.random() * 100000000);
    }

    // 4. DYNAMIC INJECTION: Source Image (For Image-to-Image or Image-to-Video)
    // Note: To use this, ComfyUI needs the image uploaded first, or passed as a base64 string depending on your custom nodes.
    // For standard ComfyUI, you would use an endpoint to upload the image first, then pass the filename here.
    if (nodeMapping.imageInputNodeId && params.imageUrls && params.imageUrls.length > 0) {
       log.warn("Image-to-Image mapping is configured, but handling remote URLs requires a custom ComfyUI upload step.");
       // Example: workflow[nodeMapping.imageInputNodeId].inputs[nodeMapping.imageInputField || 'image'] = "uploaded_file.png";
    }

    // 5. Submit the workflow to ComfyUI
    const queueRes = await fetch(`${baseUrl}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: workflow })
    });

    if (!queueRes.ok) throw new Error(`ComfyUI rejected prompt: ${await queueRes.text()}`);

    const { prompt_id } = await queueRes.json();
    log.info(`Successfully queued in ComfyUI. Prompt ID: ${prompt_id}`);

    // 6. Polling loop
    let isFinished = false;
    let finalFilename = "";
    let finalSubfolder = "";
    let finalType = "";

    // Safety timeout: stop after 200 attempts (600 seconds = 10 minutes)
    const MAX_ATTEMPTS = 200;
    let attempts = 0;

    while (!isFinished && attempts < MAX_ATTEMPTS) {
      attempts++;
      await new Promise(res => setTimeout(res, 3000)); // Poll every 3 seconds

      try {
        const historyRes = await fetch(`${baseUrl}/history/${prompt_id}`);
        if (!historyRes.ok) {
          log.warn(`Failed to fetch history for ${prompt_id}, status: ${historyRes.status}`);
          continue;
        }

        const historyData = await historyRes.json();

        if (historyData[prompt_id]) {
          const outputs = historyData[prompt_id].outputs;
          const outNode = outputs[nodeMapping.outputNodeId];

          if (!outNode) {
              throw new Error(`Output Node ${nodeMapping.outputNodeId} returned no data.`);
          }

          // Handle both Image outputs (SaveImage node) and Video outputs (VHS_VideoCombine node)
          const mediaArray = outNode.images || outNode.gifs || [];
          if (mediaArray.length > 0) {
             finalFilename = mediaArray[0].filename;
             finalSubfolder = mediaArray[0].subfolder || "";
             finalType = mediaArray[0].type || "output";
             isFinished = true;
          }
        }
      } catch (err) {
        log.error(`Error during polling for ${prompt_id}:`, err);
      }
    }

    if (!isFinished) {
      throw new Error(`ComfyUI Generation timed out after ${MAX_ATTEMPTS} attempts.`);
    }

    // 7. Construct the final URL
    // ComfyUI uses URL parameters to serve the generated file
    const paramsString = new URLSearchParams({
        filename: finalFilename,
        type: finalType,
        subfolder: finalSubfolder
    }).toString();

    const mediaUrl = `${baseUrl}/view?${paramsString}`;

    return {
      success: true,
      url: mediaUrl,
      sourceProvider: 'comfyui-generic',
      // width and height are required by ImageGenerationResult and VideoGenerationResult
      // I'll return dummy numbers here for now, or fallback to params.width/height if available
      width: params.width || 1024,
      height: params.height || 1024,
      duration: (params as { prompt?: string; providerId?: string; modelId?: string; duration?: number }).duration || 5
    };

  } catch (error: unknown) {
    log.error("Generic ComfyUI Generation failed", error);
    // The codebase throws exceptions for failed generation in other adapters
    throw error;
  }
}
