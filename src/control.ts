import fs from "fs";
import { PAPER_TRADING } from "./config";
import logger from "./logger";

const CONTROL_FILE = PAPER_TRADING ? "paper_control.json" : "live_control.json";
const DEFAULT_PAUSED = !PAPER_TRADING; // Paper: active, Live: paused by default

interface ControlState {
  paused: boolean;
}

let state: ControlState = load();

function load(): ControlState {
  try {
    if (fs.existsSync(CONTROL_FILE)) {
      const raw = fs.readFileSync(CONTROL_FILE, "utf-8");
      const data = JSON.parse(raw) as ControlState;
      if (typeof data.paused === "boolean") {
        logger.info(`Control loaded from ${CONTROL_FILE}: ${data.paused ? "PAUSED" : "ACTIVE"}`);
        return data;
      }
    }
  } catch {}
  return { paused: DEFAULT_PAUSED };
}

function save(): void {
  try {
    fs.writeFileSync(CONTROL_FILE, JSON.stringify(state, null, 2), "utf-8");
  } catch {}
}

export function isPaused(): boolean {
  return state.paused;
}

export function setPaused(paused: boolean): void {
  state.paused = paused;
  save();
  logger.info(`Bot ${paused ? "PAUSED" : "ACTIVATED"} (${CONTROL_FILE})`);
}

export function getControlFile(): string {
  return CONTROL_FILE;
}
