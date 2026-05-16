export interface GeminiPart {
  text?: string;
}

export interface GeminiContent {
  role?: string;
  parts?: GeminiPart[];
}

export interface GeminiSystemInstruction {
  parts?: GeminiPart[];
}

export interface GeminiGenerationConfig {
  stream?: boolean;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
}

export interface GeminiBody {
  systemInstruction?: GeminiSystemInstruction;
  contents?: GeminiContent[];
  generationConfig?: GeminiGenerationConfig;
}
