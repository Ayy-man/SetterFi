import { expect, test } from "@playwright/test";

test("configures an admin viewport for the route sweep", ({}, testInfo) => {
  expect(testInfo.project.use.viewport).toBeDefined();
});
