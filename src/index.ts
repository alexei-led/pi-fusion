import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerFusionInitCommand } from "./commands.js";

export default function fusionExtension(pi: ExtensionAPI): void {
  registerFusionInitCommand(pi);
}
