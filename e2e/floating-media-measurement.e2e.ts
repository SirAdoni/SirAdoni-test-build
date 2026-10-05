import { expect, test } from "@playwright/test";
import { prepareViteFixtureDependencies } from "./vite-fixture-dependencies.js";
import { seedUIState } from "./ui-state-fixture.js";

test("floating widget measurement follows replacement nodes and stays inactive while OFF", async ({
  page,
  baseURL,
}) => {
  expect(["http://127.0.0.1:5178", "http://127.0.0.1:5179"]).toContain(baseURL);
  await page.route("**/*", (route) => {
    const request = route.request();
    return new URL(request.url()).origin === baseURL && ["GET", "HEAD"].includes(request.method())
      ? route.continue()
      : route.abort();
  });
  await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
  await seedUIState(page, { hasCompletedOnboarding: true, sidebarOpen: false, rightPanelOpen: false });
  await page.goto("/");
  await prepareViteFixtureDependencies(page);
  await page.evaluate(async () => {
    const { default: React } = await import(window.__viteFixtureDependencyUrl("react"));
    const { default: ReactDOM } = await import(window.__viteFixtureDependencyUrl("react-dom_client"));
    const { useMeasuredFloatingWidgetSize } = await import("/src/hooks/use-floating-widget-avoid.ts" as string);
    const container = document.createElement("div");
    container.style.cssText = "position:fixed;inset:0;z-index:99999;background:white;color:black";
    document.body.append(container);
    function Harness() {
      const [generation, setGeneration] = React.useState(0);
      const [enabled, setEnabled] = React.useState(true);
      const [width, setWidth] = React.useState(80);
      const [ref, size] = useMeasuredFloatingWidgetSize(enabled, 48);
      return React.createElement(
        "div",
        {},
        React.createElement("output", { "data-testid": "measured-size" }, String(size)),
        React.createElement(
          "button",
          {
            onClick: () => {
              setGeneration(generation + 1);
              setWidth(160);
            },
          },
          "Replace fixture bubble",
        ),
        React.createElement(
          "button",
          { onClick: () => setEnabled(!enabled) },
          enabled ? "Disable fixture placement" : "Enable fixture placement",
        ),
        React.createElement("button", { onClick: () => setWidth(240) }, "Resize fixture bubble"),
        React.createElement("div", { key: generation, ref, style: { width, height: width } }),
      );
    }
    ReactDOM.createRoot(container).render(React.createElement(Harness));
  });
  const size = page.getByTestId("measured-size");
  await expect(size).toHaveText("80");
  await page.getByRole("button", { name: "Replace fixture bubble" }).click();
  await expect(size).toHaveText("160");
  await page.getByRole("button", { name: "Disable fixture placement" }).click();
  await page.getByRole("button", { name: "Resize fixture bubble" }).click();
  // Let layout and ResizeObserver delivery complete before asserting inactivity.
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
  await expect(size).toHaveText("160");
  await page.getByRole("button", { name: "Enable fixture placement" }).click();
  await expect(size).toHaveText("240");
});
