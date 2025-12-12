import { GoogleGenAI } from "@google/genai";
import { CommentaryType } from "../types";

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

const SYSTEM_INSTRUCTION = `
You are a hyped-up, intense, and slightly humorous battle commentator for a video game.
The scenario: A time-traveler with an AK-47 is fighting an infinite horde of medieval knights in a flat grassy field.
Keep your comments short (max 2 sentences), punchy, and reactive.
Use French language but with internet gaming slang style.
`;

export const generateBattleCommentary = async (type: CommentaryType, score: number, wave: number): Promise<string> => {
  let prompt = "";

  switch (type) {
    case 'intro':
      prompt = "Intro the game. Player has an AK-47. Knights are coming.";
      break;
    case 'killstreak':
      prompt = `Player just hit a killstreak! Score is ${score}. Hype it up!`;
      break;
    case 'low_health':
      prompt = "Player is about to die! Panic!";
      break;
    case 'wave_start':
      prompt = `Wave ${wave} is starting! More knights!`;
      break;
  }

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        maxOutputTokens: 60, // Keep it short
      }
    });
    return response.text || "Erreur de communication...";
  } catch (error) {
    console.error("Gemini Error:", error);
    return "";
  }
};
