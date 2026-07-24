import { expect, test } from "@playwright/test";
import axe from "axe-core";

test("renders arbitrary fork data without canned entities", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Control Room", exact: true })).toBeVisible();
  await expect(page.getByText("Cooperativa Aurora", { exact: true })).toBeVisible();
  await expect(page.getByText("Carrefour", { exact: false })).toHaveCount(0);
  await expect(page.getByText("Banco ao vivo", { exact: true })).toBeVisible();

  await page.addScriptTag({ content: axe.source });
  const results = await page.evaluate(async () => {
    const axeApi = (window as unknown as { axe: { run: () => Promise<{ violations: unknown[] }> } }).axe;
    return axeApi.run();
  });
  expect(results.violations).toEqual([]);

  await page.getByRole("button", { name: "Usar tema escuro" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/u);
  await page.waitForTimeout(350);
  const darkResults = await page.evaluate(async () => {
    const axeApi = (window as unknown as { axe: { run: () => Promise<{ violations: unknown[] }> } }).axe;
    return axeApi.run();
  });
  expect(darkResults.violations).toEqual([]);
  expect(errors).toEqual([]);
});

test("keeps action execution disabled in observer mode", async ({ page }) => {
  await page.goto("/jobs");
  await expect(page.getByRole("heading", { name: "Ações", exact: true })).toBeVisible();
  await expect(page.getByText("Modo observador", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Gerar preview read-only" })).toBeDisabled();
  await expect(page.getByText("Nenhuma ação iniciada nesta instalação", { exact: true })).toBeVisible();
});
