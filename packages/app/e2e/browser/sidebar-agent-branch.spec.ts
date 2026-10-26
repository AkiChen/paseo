import { execFileSync } from "node:child_process";
import { test, expect } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { getServerId } from "../support/helpers/server-id";

test("Agents subtitles follow the current workspace branch", async ({ page }) => {
  test.setTimeout(120_000);
  const workspace = await seedMockAgentWorkspace({
    repoPrefix: "agent-branch-",
    title: "Branch subtitle agent",
  });
  try {
    await openAgentRoute(page, workspace);
    await page.getByTestId("sidebar-mode-agents").click();
    const subtitle = page.getByTestId(
      `sidebar-recent-agent-branch-${getServerId()}-${workspace.agentId}`,
    );
    await expect(subtitle).toHaveText("main");

    execFileSync("git", ["checkout", "-b", "feature/updated-branch"], {
      cwd: workspace.cwd,
      stdio: "ignore",
    });
    await workspace.client.checkoutRefresh(workspace.cwd);
    await expect(subtitle).toHaveText("feature/updated-branch", { timeout: 30_000 });
    // A detached checkout must not advertise HEAD as if it were a branch name.
    execFileSync("git", ["checkout", "--detach"], { cwd: workspace.cwd, stdio: "ignore" });
    await workspace.client.checkoutRefresh(workspace.cwd);
    await expect(subtitle).toHaveCount(0, { timeout: 30_000 });
  } finally {
    await workspace.cleanup();
  }
});
