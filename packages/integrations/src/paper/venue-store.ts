import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalizeDecimal } from "@moneykernel/contracts";
import { z } from "zod";

/**
 * The paper venue keeps its own memory, separate from the kernel database,
 * exactly as a real exchange would. A kernel restart must not erase orders
 * the venue already accepted (prd.md 27.4, T-35, T-37, T-38); recovery has to
 * ask the venue what happened instead of assuming nothing did.
 */
const DecimalText = z
  .string()
  .regex(/^\d+(\.\d+)?$/)
  .transform((value) => canonicalizeDecimal(value));

const StoredFillSchema = z.object({
  fill_id: z.string(),
  order: z.object({ client_order_id: z.string(), exchange_order_id: z.string().nullable(), symbol: z.string() }),
  symbol: z.string(),
  side: z.enum(["BUY", "SELL"]),
  base_qty: DecimalText,
  price: DecimalText,
  quote_qty: DecimalText,
  commission_asset: z.string(),
  commission_qty: DecimalText,
  event_time: z.string(),
  raw_hash: z.string(),
});

const StoredOrderSchema = z.object({
  environment: z.enum(["REPLAY", "SHADOW", "TESTNET"]),
  client_order_id: z.string(),
  exchange_order_id: z.string().nullable(),
  symbol: z.string(),
  side: z.enum(["BUY", "SELL"]),
  order_type: z.literal("LIMIT_IOC"),
  status: z.enum(["NEW", "PARTIALLY_FILLED", "FILLED", "CANCELED", "EXPIRED"]),
  quantity: DecimalText,
  limit_price: DecimalText,
  executed_base: DecimalText,
  executed_quote: DecimalText,
  last_observed_at: z.string(),
  source_timestamp: z.string().nullable(),
  raw_hash: z.string(),
});

export const PaperVenueStateSchema = z.object({
  version: z.literal(1),
  simulator_version: z.string(),
  orders: z.record(
    z.string(),
    z.object({
      order: StoredOrderSchema,
      fills: z.array(StoredFillSchema),
      book_id: z.string(),
      book_hash: z.string(),
      accepted_at: z.string(),
    }),
  ),
  /** Simulated liquidity consumed per `${book_id}:${side}:${level index}`. */
  consumed: z.record(z.string(), DecimalText),
  sequence: z.number().int().nonnegative(),
  submissions: z.number().int().nonnegative(),
});
export type PaperVenueState = z.infer<typeof PaperVenueStateSchema>;

export function emptyPaperVenueState(simulatorVersion: string): PaperVenueState {
  return { version: 1, simulator_version: simulatorVersion, orders: {}, consumed: {}, sequence: 0, submissions: 0 };
}

export interface PaperVenueStore {
  load(): PaperVenueState | null;
  save(state: PaperVenueState): void;
}

/** In-memory venue memory that outlives a kernel runtime object; tests hand the same instance to successive boots. */
export class MemoryPaperVenueStore implements PaperVenueStore {
  private state: PaperVenueState | null = null;

  load(): PaperVenueState | null {
    return this.state === null ? null : PaperVenueStateSchema.parse(structuredClone(this.state));
  }

  save(state: PaperVenueState): void {
    this.state = PaperVenueStateSchema.parse(structuredClone(state));
  }
}

/** File-backed venue memory; written atomically (temp file + rename) before any response leaves the venue. */
export class FilePaperVenueStore implements PaperVenueStore {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  load(): PaperVenueState | null {
    if (!existsSync(this.path)) return null;
    return PaperVenueStateSchema.parse(JSON.parse(readFileSync(this.path, "utf8")));
  }

  save(state: PaperVenueState): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(PaperVenueStateSchema.parse(state), null, 2), "utf8");
    renameSync(tmp, this.path);
  }
}
