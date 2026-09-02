import { expect, test } from "@playwright/test";

test("configures a coach viewport for the route sweep", ({}, testInfo) => {
  expect(testInfo.project.use.viewport).toBeDefined();
});
