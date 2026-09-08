import { readFileSync } from "node:fs";
import type { z } from "zod";
import { errorMessage, formatIssues } from "./provider.ts";

/** Reads and validates a small JSON document; every failure names the file and the label of what it should be. */
export function readJsonFile<T>(path: string, schema: z.ZodType<T>, label: string): T {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`${label}: cannot read ${path}: ${errorMessage(error)}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label}: ${path} is not valid JSON: ${errorMessage(error)}`);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new Error(`${label}: ${path}: ${formatIssues(parsed.error)}`);
  return parsed.data;
}
