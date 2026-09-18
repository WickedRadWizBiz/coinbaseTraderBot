const { GoogleGenAI } = require("@google/genai");
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

ai.models.generateContent({
    model: "gemini-3.6-flash",
    contents: "Hello",
}).then(r => console.log(r.text)).catch(e => console.error(e));
