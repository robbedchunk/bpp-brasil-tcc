import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
} from "@tanstack/react-router";

import { AppShell } from "./components/app-shell.js";
import { ControlRoomPage } from "./pages/control-room.js";
import { RetailerDetailPage } from "./pages/retailer-detail.js";
import { RunDetailPage } from "./pages/run-detail.js";
import { RunsPage, type RunsSearch } from "./pages/runs.js";

const rootRoute = createRootRoute({ component: AppShell });
const controlRoomRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: ControlRoomPage });
const retailersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/retailers",
  component: lazyRouteComponent(() => import("./pages/retailers.js"), "RetailersPage"),
});
const retailerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/retailers/$retailerId",
  component: () => {
    const { retailerId } = retailerRoute.useParams();
    return <RetailerDetailPage retailerId={retailerId} />;
  },
});
const runsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/runs",
  validateSearch: (search: Record<string, unknown>): RunsSearch => ({
    ...(typeof search.retailer === "string" && search.retailer !== "" ? { retailer: search.retailer } : {}),
    ...(search.stage === "collect" || search.stage === "discover" ? { stage: search.stage } : {}),
    ...(typeof search.status === "string" && search.status !== "" ? { status: search.status } : {}),
  }),
  component: () => {
    const search = runsRoute.useSearch();
    const navigate = runsRoute.useNavigate();
    return <RunsPage search={search} onSearch={(next) => void navigate({ search: next, replace: true })} />;
  },
});
const runRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/runs/$runId",
  component: () => {
    const { runId } = runRoute.useParams();
    return <RunDetailPage runId={runId} />;
  },
});
const automationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/automation",
  component: lazyRouteComponent(() => import("./pages/automation.js"), "AutomationPage"),
});
const limitsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/limits",
  component: lazyRouteComponent(() => import("./pages/limits.js"), "LimitsPage"),
});
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/index",
  component: lazyRouteComponent(() => import("./pages/index.js"), "IndexPage"),
});
const jobsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/jobs",
  component: lazyRouteComponent(() => import("./pages/jobs.js"), "JobsPage"),
});
const systemRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/system",
  component: lazyRouteComponent(() => import("./pages/system.js"), "SystemPage"),
});

const routeTree = rootRoute.addChildren([
  controlRoomRoute,
  retailersRoute,
  retailerRoute,
  runsRoute,
  runRoute,
  automationRoute,
  limitsRoute,
  indexRoute,
  jobsRoute,
  systemRoute,
]);

export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  defaultPreloadStaleTime: 5_000,
  scrollRestoration: true,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
