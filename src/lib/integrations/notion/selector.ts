/** Notion selection extends the shared two-arm contract with one server-configured offline arm. */

import {
  DriverConfigurationError,
  driverSelection,
  environmentValue,
  requireEnvironment,
  type EnvironmentSource,
} from "@/lib/env-contract";

import { createMockNotionDriver } from "./mock";
import { createOfflineNotionDriver } from "./offline";
import { createRealNotionDriver, type NotionRealDependencies } from "./real";
import type { NotionKnowledgeDriver } from "./types";

export function resolveNotionDriver(
  environment: EnvironmentSource = process.env,
  realDependencies: NotionRealDependencies = {},
): NotionKnowledgeDriver {
  const selected = environmentValue("SETTERFI_NOTION_DRIVER", environment);
  if (selected === "offline") {
    const path = requireEnvironment("notion", ["NOTION_EXPORT_PATH"], environment).NOTION_EXPORT_PATH;
    return createOfflineNotionDriver(path);
  }
  if (selected && selected !== "mock" && selected !== "real") {
    throw new DriverConfigurationError("notion", ["SETTERFI_NOTION_DRIVER"]);
  }
  if (driverSelection("notion", "SETTERFI_NOTION_DRIVER", environment) === "mock") {
    return createMockNotionDriver();
  }
  const values = requireEnvironment(
    "notion",
    ["NOTION_API_KEY", "NOTION_KB_ROOT_ID"],
    environment,
  );
  return createRealNotionDriver(
    { apiKey: values.NOTION_API_KEY, rootId: values.NOTION_KB_ROOT_ID },
    realDependencies,
  );
}
