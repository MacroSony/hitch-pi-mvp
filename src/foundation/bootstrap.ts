import type { AppConfig } from "../config/config.js";
import {
  openFoundationDatabase,
  publishStaticTopology,
  type Clock,
  type FoundationDatabase,
} from "./database.js";
import { validateTopology, type ValidatedTopology } from "./filesystem.js";

export interface Foundation {
  readonly database: FoundationDatabase;
  readonly topology: ValidatedTopology;
  close(): void;
}

export function bootstrapFoundation(
  config: AppConfig,
  clock?: Clock,
): Foundation {
  const topology = validateTopology(config);
  const database = openFoundationDatabase(topology.dataRoot.path);
  try {
    publishStaticTopology(database, topology, clock);
  } catch (error) {
    database.close();
    throw error;
  }
  return { database, topology, close: () => database.close() };
}
