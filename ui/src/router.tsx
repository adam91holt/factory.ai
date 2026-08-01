import {
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { AppShell } from "./components/shell/AppShell";
import { BoardPage } from "./pages/BoardPage";
import { RunsPage } from "./pages/RunsPage";
import { RunDetailPage } from "./pages/RunDetailPage";
import { QueuePage } from "./pages/QueuePage";
import { ApprovalsPage } from "./pages/ApprovalsPage";
import { HistoryPage } from "./pages/HistoryPage";
import { TelemetryPage } from "./pages/TelemetryPage";
import { CatalogPage } from "./pages/CatalogPage";
import { LessonsPage } from "./pages/LessonsPage";

const rootRoute = createRootRoute({ component: AppShell });

const boardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: BoardPage,
});

const runsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/runs",
  component: RunsPage,
});

const runDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/runs/$issueKey",
  component: RunDetailRoute,
});

function RunDetailRoute() {
  const { issueKey } = runDetailRoute.useParams();
  return <RunDetailPage issueKey={issueKey} />;
}

const queueRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/queue",
  component: QueuePage,
});

const approvalsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/approvals",
  component: ApprovalsPage,
});

const historyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/history",
  component: HistoryPage,
});

const telemetryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/telemetry",
  component: TelemetryPage,
});

const catalogRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/catalog",
  component: CatalogPage,
});

const lessonsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/lessons",
  component: LessonsPage,
});

const routeTree = rootRoute.addChildren([
  boardRoute,
  runsRoute,
  runDetailRoute,
  queueRoute,
  approvalsRoute,
  historyRoute,
  telemetryRoute,
  catalogRoute,
  lessonsRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
