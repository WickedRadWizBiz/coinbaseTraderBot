import { GoogleGenAI } from "@google/genai";
import * as dotenv from 'dotenv';
dotenv.config();

async function run() {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const models = ['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-2.5-flash'];
  for (const m of models) {
    try {
      const res = await ai.models.generateContent({
        model: m,
        contents: "test"
      });
      console.log(`${m}: SUCCESS`);
    } catch (e: any) {
      console.log(`${m}: ${e.message}`);
    }
  }
}
run();
