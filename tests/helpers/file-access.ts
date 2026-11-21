import * as path from "node:path";
import { HOME_SECRETS, isDenied } from "../../src/agent/tools/file-access.ts";

/** isDenied against a synthetic home: the home secret stores plus the env-file rule. */
export const isDeniedAt = (file: string, home: string) => isDenied(file, { folders: [], denied: HOME_SECRETS.map((s) => path.join(home, s)) });
