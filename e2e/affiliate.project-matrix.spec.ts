import { expect, test } from "@playwright/test";

test("configures an affiliate viewport for the route sweep", ({}, testInfo) => {
  expect(testInfo.project.use.viewport).toBeDefined();
});
