import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import { api } from './api';
import { flushLocalSends, localSends } from './offline';
import { useAppStore } from './store';

/**
 * Deliver the phone's offline outbox while the app is closed.
 *
 * In the foreground the app retries every 30 seconds and on returning to the
 * app (App.tsx). That never ran with the app closed, so a message written on
 * a train sat on the phone until the app was opened again. This registers an
 * OS background task — WorkManager on Android, BGTaskScheduler on iOS — that
 * runs the same flush.
 *
 * The OS decides when it runs: at most every 15 minutes, usually less often,
 * and on iOS only when the system judges it a good moment. It is a best effort
 * on top of the foreground retry, not a delivery guarantee. Each queued
 * message keeps its request id, so a run that races a foreground flush cannot
 * send anything twice; the server deduplicates on that id.
 *
 * The task is registered only while something is waiting and unregisters
 * itself once the outbox is empty, so an idle phone schedules no work.
 */
export const OUTBOX_TASK = 'hermes-offline-outbox';

/** What one background run does. Exported for tests. */
export async function runOutboxTask(): Promise<BackgroundTask.BackgroundTaskResult> {
  try {
    // A background run can start in a fresh JS context with an empty store.
    if (!useAppStore.getState().serverReady) await useAppStore.getState().loadServerUrl();
    const { serverUrl } = useAppStore.getState();
    if (!serverUrl) return BackgroundTask.BackgroundTaskResult.Success;
    await flushLocalSends(api.send);
    const waiting = (await localSends()).filter(item => !item.rejected);
    if (!waiting.length) await BackgroundTask.unregisterTaskAsync(OUTBOX_TASK).catch(() => {});
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
}

// Must run at module load, in the global scope: the OS can start the app
// headless just to run this task, before any component mounts.
TaskManager.defineTask(OUTBOX_TASK, runOutboxTask);

/**
 * Ask the OS to retry delivery in the background. Safe to call often: it is a
 * no-op when the task is registered already, or when the user or the OS has
 * restricted background work (the foreground retry still runs then).
 */
export async function ensureBackgroundDelivery(): Promise<boolean> {
  try {
    const status = await BackgroundTask.getStatusAsync();
    if (status === BackgroundTask.BackgroundTaskStatus.Restricted) return false;
    if (await TaskManager.isTaskRegisteredAsync(OUTBOX_TASK)) return true;
    await BackgroundTask.registerTaskAsync(OUTBOX_TASK, { minimumInterval: 15 });
    return true;
  } catch {
    return false;
  }
}

/** On launch: keep the task registered while anything is still waiting. */
export async function resumeBackgroundDeliveryIfNeeded(): Promise<void> {
  try {
    const waiting = (await localSends()).filter(item => !item.rejected);
    if (waiting.length) await ensureBackgroundDelivery();
  } catch { /* the foreground retry covers it */ }
}
