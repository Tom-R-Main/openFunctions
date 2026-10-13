/** Fixed local work surface; profile loading follows only trusted plugin configuration. */
import { createWorkTools, type WorkAttemptController } from "openfunction/framework/work";
import { createWorkProfile, type WorkProfile } from "openfunction/runtime/work-profile";

export function buildLocalWorkTools(configPath?: string) {
  let runtime: Promise<WorkProfile> | undefined;
  const controller = async () => {
    if (!configPath) throw new Error("Configure workConfigPath or OPENFUNCTION_WORK_CONFIG before using local work tools");
    runtime ??= createWorkProfile(configPath);
    return (await runtime).controller;
  };
  const bound = {
    prepare: async (...args: Parameters<WorkAttemptController["prepare"]>) => (await controller()).prepare(...args),
    start: async (...args: Parameters<WorkAttemptController["start"]>) => (await controller()).start(...args),
    step: async (...args: Parameters<WorkAttemptController["step"]>) => (await controller()).step(...args),
    verify: async (...args: Parameters<WorkAttemptController["verify"]>) => (await controller()).verify(...args),
    status: async (...args: Parameters<WorkAttemptController["status"]>) => (await controller()).status(...args),
    reconcile: async (...args: Parameters<WorkAttemptController["reconcile"]>) => (await controller()).reconcile(...args),
    finish: async (...args: Parameters<WorkAttemptController["finish"]>) => (await controller()).finish(...args),
  };
  return {
    tools: createWorkTools(bound),
    async shutdown() { if (runtime) await (await runtime).controller.shutdown(); },
  };
}
