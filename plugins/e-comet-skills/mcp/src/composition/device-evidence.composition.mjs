import { probeBrowserExtensionInstall } from '../bridge/profile/extension-install.mjs';
import { collectExtensionLog, extensionLogCheck } from '../bridge/profile/extension-log.mjs';
import { collectDoctorReport } from '../doctor.mjs';
import { collectExtensionSnapshotCheck } from '../support/diagnostics/application/diagnose.mjs';
import { collectCodexHookPermissions } from '../support/diagnostics/out/codex/hook-permissions.mjs';
import { collectDeviceEvidence } from '../support/feedback/application/evidence.mjs';
// The device evidence a feedback report carries, collected by support/feedback through the checks support/diagnostics
// and bridge/ own; the two sub-contexts never import each other.
const ADAPTERS = {
    collectInstallation: collectDoctorReport,
    probeExtensionInstall: probeBrowserExtensionInstall,
    collectHookPermissions: collectCodexHookPermissions,
    readExtensionLog: collectExtensionLog,
    collectExtensionSnapshotCheck,
    extensionLogCheck,
};
export const collectFeedbackDeviceEvidence = (dependencies) => collectDeviceEvidence(dependencies, ADAPTERS);
