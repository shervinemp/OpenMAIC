# 🚀 OpenMAIC: Sovereign & Zero-Cost Edition

Welcome to the **Sovereign Setup Guide** for OpenMAIC. By default, complex AI agents like OpenMAIC rely on expensive cloud APIs (OpenAI, Tavily, AWS S3, Cloud Video generators). 

This guide provides a comprehensive architectural workaround to run OpenMAIC **100% locally, completely uncensored, and at exactly $0.00 in API costs**, utilizing the Gemini Free Tier, local GPUs, and open-source infrastructure.

---

## 🏗️ The Sovereign Architecture Overview

To achieve a zero-cost pipeline without sacrificing OpenMAIC's advanced multimodal capabilities, we replace the paid cloud stack with the following:

1. **Core Intelligence:** Gemini Free Tier (with Multi-Key Round-Robin & Cache-Bypass) OR Local LLMs (Ollama/vLLM).
2. **Image & Video:** Local GPU rendering via generic **ComfyUI** workflows (FLUX, Hunyuan, OmniGen).
3. **Audio (TTS/ASR):** Browser-native Web Speech API OR Local **Kokoro** TTS.
4. **Web Search:** Self-hosted **SearXNG**.
5. **Storage & Hosting:** Local **MinIO** (S3 alternative) and persistent **Docker** deployment to bypass serverless timeouts.

---

## Pillar 1: Bypassing Gemini Free Tier Limits

The free tier of Gemini has strict rate limits (15 RPM) and frequently blocks structured JSON outputs or complex multimodal prompts. OpenMAIC handles this natively using three mechanisms:

1. **Round-Robin Key Rotation:** OpenMAIC accepts multiple comma-separated Gemini keys in the `.env` or UI. It rotates them sequentially per request, multiplying your rate limit by the number of keys you own.
2. **Auto-Pausing (429 Interception):** If all keys hit their limit, the backend catches the `429 Too Many Requests` error, automatically sleeps for 20 seconds, and retries gracefully.
3. **The "Cache-and-Restart" Fallback:** If Google's safety filter blocks the JSON schema, OpenMAIC halts the job, generates a unique MD5 hash of the exact prompt, and displays it in the UI. 
   * You copy the prompt, paste it into the [Gemini Web App](https://gemini.google.com), and paste the raw JSON response back into OpenMAIC.
   * OpenMAIC saves this to a local `.openmaic/manual_cache` file.
   * When you click "Restart", the pipeline runs again, detects the cached hash, instantly injects your manual response, and seamlessly bypasses the API block!

---

## Pillar 2: Generic Local Media (ComfyUI)

Instead of paying for Kling or Midjourney, OpenMAIC connects directly to a local **ComfyUI** instance. It uses a generic adapter that reads a `comfyui-config.json` file, meaning you can swap between FLUX, SD3, or Video models without touching any code.

**1. Create `comfyui-config.json` in your project root:**
```json
{
  "baseUrl": "[http://host.docker.internal:8188](http://host.docker.internal:8188)",
  "nodeMapping": {
    "textPromptNodeId": "6",
    "textPromptField": "text",
    "seedNodeId": "3",
    "outputNodeId": "9"
  },
  "workflowTemplate": {
    "...": "PASTE YOUR EXPORTED COMFYUI API WORKFLOW JSON HERE"
  }
}
```
*(OpenMAIC will automatically inject its generated scene prompts into Node 6, randomize the seed in Node 3, and fetch the final media from Node 9).*

---

## Pillar 3: Studio-Quality Local Audio

You have two zero-cost options for Text-to-Speech (TTS) and Speech-to-Text (ASR):

* **The Zero-Setup Method:** In OpenMAIC settings, set your TTS and ASR providers to **Browser**. This uses your operating system's native voices.
* **The Studio Method (Kokoro):** Run Kokoro (an open-source TTS model that rivals ElevenLabs) via Docker:
  ```bash
  docker run -d -p 8880:8880 ghcr.io/remsky/kokoro-fastapi-cpu:v0.1.0
  ```
  Then, in OpenMAIC's UI, go to **Audio Settings ➔ Add Custom Provider**:
  * Name: `Kokoro Local`
  * Base URL: `http://host.docker.internal:8880/v1`
  * Voice ID: `af_heart` (or any default Kokoro voice)

---

## Pillar 4: Sovereign Infrastructure (Search & Storage)

* **Free Web Search:** Bypass the paid Tavily API by running **SearXNG** locally:
  ```bash
  docker run -d -p 8080:8080 searxng/searxng
  ```
  Set `SEARXNG_URL="http://host.docker.internal:8080/search"` in your `.env`.
* **Free Object Storage:** If you want production-grade storage without AWS S3 costs, run **MinIO** locally and plug its credentials into OpenMAIC's S3 environment variables.

---
---

## 💻 The Step-by-Step Laptop Setup Tutorial

Follow these steps to spin up the entire sovereign stack on your local machine.

### Step 1: Install Prerequisites
1. **Docker Desktop:** Required to run OpenMAIC with persistent disk access.
2. **ComfyUI (Optional):** Download and run ComfyUI locally. Ensure you launch it with the listen flag so Docker can reach it: `python main.py --listen 0.0.0.0`
3. **Ollama (Optional):** Install Ollama if you want to use local LLMs (like `llama3:8b`) or local Vision models (`qwen2-vl`) for offline PDF OCR.

### Step 2: Configure the Environment
Clone the repository and set up your environment variables:
```bash
cp .env.example .env
```
Edit `.env` to point to your local ecosystem:
```env
# Multi-Key Gemini Setup
GOOGLE_GENERATIVE_AI_API_KEY="AIzaSy_Key1, AIzaSy_Key2, AIzaSy_Key3"

# Local LLM Routing (Ollama)
LOCAL_LLM_BASE_URL="[http://host.docker.internal:11434/v1](http://host.docker.internal:11434/v1)"
LOCAL_API_KEY="dummy_key"

# Local Infrastructure
COMFYUI_URL="[http://host.docker.internal:8188](http://host.docker.internal:8188)"
SEARXNG_URL="[http://host.docker.internal:8080/search](http://host.docker.internal:8080/search)"
```

### Step 3: Boot the Persistent Server
**Do not use Vercel for this setup.** Vercel's serverless functions time out after 60 seconds and have a read-only file system, which breaks the manual fallback cache.

Boot the application using Docker Compose:
```bash
docker-compose up --build -d
```
This mounts a persistent volume to your hard drive, ensuring the `.openmaic/manual_cache` folder and SQLite database survive restarts.

### Step 4: Configure the OpenMAIC UI
1. Navigate to `http://localhost:3000`.
2. Click the **Gear Icon (Settings)**.
3. **General Settings:** Select **Gemini 1.5 Flash/Pro** (uses your keys) or your **Local Provider** (Ollama).
4. **Audio Settings:** Set TTS and ASR to **Browser** (or set up your Custom Kokoro provider).
5. **Image Settings:** Select the **ComfyUI** generic adapter.
6. **Search Settings:** Select **SearXNG**.

### Step 5: Handling Free Tier Blocks in Real-Time
As you generate a massive 50-slide classroom, the pipeline will run autonomously. 
* If it hits a rate limit, the console logs will show it pausing for 20 seconds.
* If Gemini blocks a complex structural request, the UI will halt and display the **Action Required** modal.
* **To resume:**
  1. Click **Copy Prompt**.
  2. Paste it into the free Gemini Web UI.
  3. Copy the output JSON.
  4. Paste it back into OpenMAIC and click **Inject & Restart**.
  5. OpenMAIC will instantly cache the response, restart the pipeline, skip the blocked step, and finish building your course.

Enjoy your infinitely scalable, zero-cost, sovereign AI education platform!
