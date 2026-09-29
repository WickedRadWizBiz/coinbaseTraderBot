/**
 * geminiKeyLoader.ts
 * ==================
 * Robust Gemini API key detection and resolution engine.
 * 
 * Sources checked in priority order:
 * 1. process.env.GEMINI_API_KEY
 * 2. process.env.API_KEY
 * 3. process.env.GOOGLE_API_KEY
 * 4. process.env.GOOGLE_GENAI_API_KEY
 * 5. process.env.VITE_GEMINI_API_KEY
 * 6. /app/.dev.env.json & parent .dev.env.json (AI Studio container secrets)
 * 7. .env / .env.local in current and parent directories
 *
 * Ensures sanitized formatting (unquoted, trimmed) and synchronized across
 * process.env to guarantee all downstream modules and child processes detect the key.
 */

import fs from 'fs';
import path from 'path';
import { GoogleGenAI } from '@google/genai';

export function getGeminiApiKey(): string | undefined {
  // 1. Direct process.env lookup
  const envCandidates = [
    process.env.GEMINI_API_KEY,
    process.env.API_KEY,
    process.env.GOOGLE_API_KEY,
    process.env.GOOGLE_GENAI_API_KEY,
    process.env.VITE_GEMINI_API_KEY
  ];

  for (const candidate of envCandidates) {
    if (candidate && typeof candidate === 'string') {
      const sanitized = candidate.replace(/^["']|["']$/g, '').trim();
      if (sanitized.length > 0 && sanitized !== 'MY_GEMINI_API_KEY') {
        propagateApiKey(sanitized);
        return sanitized;
      }
    }
  }

  // 2. Candidate secret file paths
  const candidateFiles = [
    path.join(process.cwd(), '.env'),
    path.join(process.cwd(), '.env.local'),
    '/app/.dev.env.json',
    path.join(process.cwd(), '..', '.dev.env.json'),
    path.join(process.cwd(), '.dev.env.json'),
    '/app/.env',
    path.join(process.cwd(), '..', '.env')
  ];

  for (const filePath of candidateFiles) {
    try {
      if (!fs.existsSync(filePath)) continue;
      const content = fs.readFileSync(filePath, 'utf-8');

      if (filePath.endsWith('.json')) {
        const parsed = JSON.parse(content);
        const key = parsed.GEMINI_API_KEY || parsed.API_KEY || parsed.GOOGLE_API_KEY || parsed.GOOGLE_GENAI_API_KEY;
        if (key && typeof key === 'string') {
          const sanitized = key.replace(/^["']|["']$/g, '').trim();
          if (sanitized.length > 0 && sanitized !== 'MY_GEMINI_API_KEY') {
            propagateApiKey(sanitized);
            syncToLocalEnv(sanitized);
            return sanitized;
          }
        }
      } else {
        const match = content.match(/(?:GEMINI_API_KEY|API_KEY|GOOGLE_API_KEY|GOOGLE_GENAI_API_KEY)=([^\r\n]+)/);
        if (match && match[1]) {
          const sanitized = match[1].replace(/^["']|["']$/g, '').trim();
          if (sanitized.length > 0 && sanitized !== 'MY_GEMINI_API_KEY') {
            propagateApiKey(sanitized);
            return sanitized;
          }
        }
      }
    } catch {
      // Continue checking next candidate file
    }
  }

  return undefined;
}

function propagateApiKey(key: string): void {
  process.env.GEMINI_API_KEY = key;
  process.env.API_KEY = key;
  process.env.GOOGLE_API_KEY = key;
  process.env.GOOGLE_GENAI_API_KEY = key;
}

function syncToLocalEnv(key: string): void {
  try {
    const localEnvPath = path.join(process.cwd(), '.env');
    if (!fs.existsSync(localEnvPath)) {
      fs.writeFileSync(localEnvPath, `GEMINI_API_KEY="${key}"\n`);
    } else {
      const cur = fs.readFileSync(localEnvPath, 'utf-8');
      if (!cur.includes('GEMINI_API_KEY')) {
        fs.appendFileSync(localEnvPath, `\nGEMINI_API_KEY="${key}"\n`);
      }
    }
  } catch {
    // Ignore filesystem write errors in read-only environments
  }
}

/**
 * Creates and returns an authorized GoogleGenAI client with official telemetry headers.
 */
export function createGeminiClient(): GoogleGenAI | null {
  const apiKey = getGeminiApiKey();
  if (!apiKey) return null;
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build'
      }
    }
  });
}

// Immediate eager execution on module import to ensure process.env is primed
getGeminiApiKey();
