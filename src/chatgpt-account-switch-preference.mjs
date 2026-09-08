import { existsSync, readFileSync } from "node:fs";

import { writePrivateJson } from "./file-security.mjs";
import { CHATGPT_ACCOUNT_SWITCH_PREFERENCE_PATH } from "./paths.mjs";

const VERSION = 1;

function unavailablePreference() {
  return { version: VERSION, autoRestart: false, state: "unavailable" };
}

export function readChatGPTAccountSwitchPreference(
  filePath = CHATGPT_ACCOUNT_SWITCH_PREFERENCE_PATH,
) {
  if (!existsSync(filePath)) {
    return { version: VERSION, autoRestart: false, state: "default" };
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      parsed.version !== VERSION ||
      typeof parsed.autoRestart !== "boolean"
    ) {
      return unavailablePreference();
    }
    return {
      version: VERSION,
      autoRestart: parsed.autoRestart,
      state: "configured",
    };
  } catch {
    return unavailablePreference();
  }
}

export function setChatGPTAccountSwitchAutoRestart(
  autoRestart,
  filePath = CHATGPT_ACCOUNT_SWITCH_PREFERENCE_PATH,
) {
  if (typeof autoRestart !== "boolean") {
    throw new TypeError("ChatGPT account auto-restart must be boolean.");
  }
  writePrivateJson(
    filePath,
    { version: VERSION, autoRestart },
    { directoryMode: 0o700 },
  );
  return readChatGPTAccountSwitchPreference(filePath);
}
