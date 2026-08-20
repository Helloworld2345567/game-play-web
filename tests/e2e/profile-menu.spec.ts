import { expect, test } from "@playwright/test";

test("keeps nickname setup open across reloads until the Guest saves it", async ({
  page,
}) => {
  await page.goto("/");
  const input = page.getByLabel("你的昵称");
  await expect(input).toBeVisible();
  const generatedName = await input.inputValue();

  await page.reload();
  await expect(input).toBeVisible();
  await expect(input).toHaveValue(generatedName);

  await input.fill("已确认棋友");
  await page.getByRole("button", { name: "保存昵称" }).click();
  await expect(page.getByRole("button", {
    name: "编辑昵称，当前为已确认棋友",
  })).toBeVisible();

  await page.reload();
  await expect(input).toBeHidden();
  await expect(page.getByRole("button", {
    name: "编辑昵称，当前为已确认棋友",
  })).toBeVisible();
});
