import {
  applyStagedUpdateOnStartup,
  awaitAutoUpdateCheck,
  handleManualUpdateCommand,
  startAutoUpdateCheck,
} from "./update";

export const updateDeps = {
  awaitAutoUpdateCheck,
  applyStagedUpdateOnStartup,
  handleManualUpdateCommand,
  startAutoUpdateCheck,
};
