import fs from "node:fs";
import { projectPath } from "./paths.js";

/**
 * Whether this Google Cloud project is "audited" - i.e. approved by YouTube
 * so that uploads can be set public/unlisted. Un-audited projects return
 * every upload locked to private regardless of the requested privacyStatus.
 *
 * The server cannot query audit status directly. It is either forced via
 * YTAGENT_PROJECT_AUDITED=true|false, or OBSERVED from upload responses
 * (if public was requested but private came back, audited := false).
 */

export interface ProjectState {
  audited: boolean | null; // null = unknown until first observed
  source: "env" | "observed" | "default";
  observedAt: string | null;
}

export function projectState(): ProjectState {
  const env = process.env.YTAGENT_PROJECT_AUDITED?.trim().toLowerCase();
  if (env === "true" || env === "false") {
    return { audited: env === "true", source: "env", observedAt: null };
  }
  try {
    const s = JSON.parse(fs.readFileSync(projectPath(), "utf8")) as ProjectState;
    return { ...s, source: "observed" };
  } catch {
    return { audited: null, source: "default", observedAt: null };
  }
}

/** Learn audit status from an observed upload response. */
export function setAudited(audited: boolean): void {
  fs.writeFileSync(
    projectPath(),
    JSON.stringify(
      { audited, source: "observed", observedAt: new Date().toISOString() },
      null,
      2
    )
  );
}
