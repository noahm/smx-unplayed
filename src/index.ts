/**
 * Worker entry: HTTP requests go to main.ts, Cron Triggers to cron.ts.
 * Static assets (public/) are served by Workers before either runs.
 */

import { CHART_PREWARM, LEADERBOARD_CHECK, checkLeaderboard, prewarmChartData } from "./cron.ts";
import handler from "./main.ts";

export default {
  fetch: handler,

  async scheduled(controller) {
    switch (controller.cron) {
      case CHART_PREWARM:
        return await prewarmChartData();
      case LEADERBOARD_CHECK:
        return await checkLeaderboard();
      default:
        console.warn(`No job for cron "${controller.cron}"`);
    }
  },
} satisfies ExportedHandler<Env>;
