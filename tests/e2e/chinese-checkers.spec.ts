import { expect, test } from "@playwright/test";

test("offers only online Chinese Checkers and retires the local route", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", {
    name: "跳棋，选择联机人数",
  }).click();
  const picker = page.getByRole("dialog", { name: "跳棋" });
  await expect(picker.getByText("本机同屏", { exact: true })).toHaveCount(0);
  await expect(picker.getByRole("button", {
    name: "创建 2 人联机房间",
  })).toBeVisible();

  await page.goto("/chinese-checkers");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "这里没有棋盘",
  );
  await expect(page.getByRole("grid", { name: "跳棋棋盘，121 个棋位" }))
    .toHaveCount(0);
});
