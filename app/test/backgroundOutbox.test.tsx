/// <reference types="jest" />
jest.mock('expo-background-task', () => ({
  BackgroundTaskResult: { Success: 1, Failed: 2 },
  BackgroundTaskStatus: { Restricted: 1, Available: 2 },
  getStatusAsync: jest.fn(async () => 2),
  registerTaskAsync: jest.fn(async () => {}),
  unregisterTaskAsync: jest.fn(async () => {}),
}));
jest.mock('expo-task-manager', () => ({ defineTask: jest.fn(), isTaskRegisteredAsync: jest.fn(async () => false) }));
jest.mock('../src/api', () => ({ api: { send: jest.fn() } }));
jest.mock('../src/offline', () => ({ flushLocalSends: jest.fn(async () => {}), localSends: jest.fn(async () => []) }));
const mockStore = { serverReady: false, serverUrl: '', loadServerUrl: jest.fn(async () => { mockStore.serverReady = true; mockStore.serverUrl = 'https://mail.example.com'; }) };
jest.mock('../src/store', () => ({ useAppStore: { getState: () => mockStore } }));

import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import { flushLocalSends, localSends } from '../src/offline';
import { api } from '../src/api';
import { OUTBOX_TASK, runOutboxTask, ensureBackgroundDelivery, resumeBackgroundDeliveryIfNeeded } from '../src/backgroundOutbox';

beforeEach(() => { jest.clearAllMocks(); });

test('the task is defined at load, so a headless launch can run it', () => {
  jest.isolateModules(() => { require('../src/backgroundOutbox'); });
  expect(TaskManager.defineTask).toHaveBeenCalledWith(OUTBOX_TASK, expect.any(Function));
});

test('a background run loads the saved connection, flushes, and unregisters once empty', async () => {
  mockStore.serverReady = false;
  expect(await runOutboxTask()).toBe(BackgroundTask.BackgroundTaskResult.Success);
  expect(mockStore.loadServerUrl).toHaveBeenCalled();
  expect(flushLocalSends).toHaveBeenCalledWith(api.send);
  expect(BackgroundTask.unregisterTaskAsync).toHaveBeenCalledWith(OUTBOX_TASK);
});

test('it stays registered while messages are still waiting', async () => {
  (localSends as jest.Mock).mockResolvedValueOnce([{ id: 'a', rejected: false }]);
  await runOutboxTask();
  expect(BackgroundTask.unregisterTaskAsync).not.toHaveBeenCalled();
});

test('a failed run reports failure to the OS instead of throwing', async () => {
  (flushLocalSends as jest.Mock).mockRejectedValueOnce(new Error('disk'));
  expect(await runOutboxTask()).toBe(BackgroundTask.BackgroundTaskResult.Failed);
});

test('registration respects a restricted device and avoids double registration', async () => {
  (BackgroundTask.getStatusAsync as jest.Mock).mockResolvedValueOnce(1);
  expect(await ensureBackgroundDelivery()).toBe(false);
  expect(BackgroundTask.registerTaskAsync).not.toHaveBeenCalled();

  (TaskManager.isTaskRegisteredAsync as jest.Mock).mockResolvedValueOnce(true);
  expect(await ensureBackgroundDelivery()).toBe(true);
  expect(BackgroundTask.registerTaskAsync).not.toHaveBeenCalled();

  expect(await ensureBackgroundDelivery()).toBe(true);
  expect(BackgroundTask.registerTaskAsync).toHaveBeenCalledWith(OUTBOX_TASK, { minimumInterval: 15 });
});

test('launch re-registers only when something is waiting', async () => {
  await resumeBackgroundDeliveryIfNeeded();
  expect(BackgroundTask.registerTaskAsync).not.toHaveBeenCalled();
  (localSends as jest.Mock).mockResolvedValueOnce([{ id: 'a' }]);
  await resumeBackgroundDeliveryIfNeeded();
  expect(BackgroundTask.registerTaskAsync).toHaveBeenCalled();
});
