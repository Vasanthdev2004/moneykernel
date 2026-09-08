import { z } from "zod";
import { readJsonFile } from "../json-file.ts";
import { NO_TOKEN_USAGE, type ProviderResult, type StrategyProvider, validateOutput } from "../provider.ts";

/** Replays of a known model response must be visibly labeled (prd.md 16.4). */
export const RECORDED_LABEL = "RECORDED MODEL RESPONSE";

export const RecordingSchema = z.object({
  model_id: z.string().min(1),
  recorded_at: z.string(),
  raw_text: z.string(),
});
export type Recording = z.infer<typeof RecordingSchema>;

export class RecordedProvider implements StrategyProvider {
  readonly source = "RECORDED" as const;
  readonly label = RECORDED_LABEL;
  readonly modelId: string;
  readonly recordedAt: string;
  readonly recordingPath: string;
  readonly #rawText: string;

  constructor(options: { recordingPath: string }) {
    const recording = readJsonFile(options.recordingPath, RecordingSchema, "RECORDING_INVALID");
    this.recordingPath = options.recordingPath;
    this.modelId = recording.model_id;
    this.recordedAt = recording.recorded_at;
    this.#rawText = recording.raw_text;
  }

  /** A recording is fixed text: there is nothing to repair, so an invalid recording is simply no proposal. */
  async propose(): Promise<ProviderResult> {
    const check = validateOutput(this.#rawText);
    if (!check.ok) throw new Error(`MODEL_OUTPUT_INVALID: ${check.error}`);
    return {
      output: check.output,
      raw_text: this.#rawText,
      latency_ms: 0,
      repair_attempts: 0,
      usage: NO_TOKEN_USAGE,
      validation: "VALID",
    };
  }
}
