/// <reference types="jest" />
jest.mock('../src/offline', () => ({ queueOffline: jest.fn(), offlineUnavailable: () => false }));
import React from 'react';
import { render, fireEvent, act, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';
import ComposeScreen from '../src/screens/ComposeScreen';
import { api } from '../src/api';
import { saveLocalDraft } from '../src/drafts';
import * as DocumentPicker from 'expo-document-picker';
jest.mock('../src/api', () => ({ api: { aiSettings: jest.fn(async () => ({ configured: false })), send: jest.fn(), saveDraft: jest.fn() }, errorMessage: (e: Error) => e.message }));
jest.mock('../src/drafts', () => ({ saveLocalDraft: jest.fn(async () => {}), removeLocalDraft: jest.fn(async () => {}) }));
jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));
jest.mock('expo-file-system/legacy', () => ({ readAsStringAsync: jest.fn(async () => 'YXR0YWNobWVudA=='), EncodingType: { Base64: 'base64' } }));
jest.mock('expo-crypto', () => ({ randomUUID: jest.fn(() => 'stable-mobile-request') }));
jest.mock('@react-navigation/native', () => ({ usePreventRemove: jest.fn() }));
jest.mock('../src/i18n', () => { const tr = (s: string) => s; return { useTr: () => tr, tr }; });
jest.mock('../src/ThemeContext', () => {
  const t = require('../src/theme').darkPalette; const ui = require('../src/ui').makeUi(t); const value = { t, ui };
  return { useTheme: () => value };
});
const account = { id: 'one', email: 'me@example.com', type: 'imap', name: 'Me' };
let options: any;
function screen(extra = {}) {
  const navigation = { setOptions: (value: any) => { options = value; }, goBack: jest.fn(), dispatch: jest.fn() };
  return render(<ComposeScreen navigation={navigation as any} route={{ params: { account, ...extra } } as any} />);
}
beforeEach(() => { jest.clearAllMocks(); jest.spyOn(Alert, 'alert').mockImplementation(() => {}); });
test('typed markup is escaped in the sent HTML and the draft is saved first', async () => {
  (api.send as jest.Mock).mockResolvedValue({ jobId: 'job' });
  const ui = await screen({ prefill: { to: 'a@example.com', subject: 'Hello', body: '<name> & friends' } });
  await act(async () => {});
  const header = await render(options.headerRight()); await fireEvent.press(header.getByText('Send'));
  await waitFor(() => expect(api.send).toHaveBeenCalled());
  expect((api.send as jest.Mock).mock.calls[0][1].html).toBe('<p>&lt;name&gt; &amp; friends</p>');
  expect(saveLocalDraft).toHaveBeenCalled();
  expect((saveLocalDraft as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan((api.send as jest.Mock).mock.invocationCallOrder[0]);
  await ui.unmount();
});
test('attachment picker adds file content to the recoverable draft', async () => {
  (DocumentPicker.getDocumentAsync as jest.Mock).mockResolvedValue({ canceled: false, assets: [{ name: 'notes.txt', size: 10, uri: 'file://notes', mimeType: 'text/plain' }] });
  const ui = await screen(); await fireEvent.press(ui.getByText('Attach files'));
  await waitFor(() => expect(ui.getByText(/notes.txt/)).toBeTruthy());
  await waitFor(() => expect(saveLocalDraft).toHaveBeenCalledWith(expect.objectContaining({ attachments: [expect.objectContaining({ filename: 'notes.txt', content: 'YXR0YWNobWVudA==' })] })), { timeout: 2000 });
  await ui.unmount();
});
test('recovered reply preserves edited recipients and subject', async () => {
  const ui = await screen({ replyTo: { from: 'old@example.com', subject: 'Original', date: new Date().toISOString() }, prefill: { to: 'new@example.com', subject: 'Edited subject', body: 'Recovered body' } });
  await act(async () => {});
  expect(ui.getByDisplayValue('new@example.com')).toBeTruthy(); expect(ui.getByDisplayValue('Edited subject')).toBeTruthy(); expect(ui.getByDisplayValue('Recovered body')).toBeTruthy(); await ui.unmount();
});
test('lost response retries reuse the request id and preserve composition', async () => {
  (api.send as jest.Mock).mockRejectedValue(new Error('Network unavailable'));
  const ui = await screen({ prefill: { to: 'a@example.com', subject: 'Hello', body: 'Keep me' } }); await act(async () => {});
  let header = await render(options.headerRight()); await fireEvent.press(header.getByText('Send'));
  await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1)); await act(async () => {}); await header.unmount();
  header = await render(options.headerRight()); await fireEvent.press(header.getByText('Send'));
  await waitFor(() => expect(api.send).toHaveBeenCalledTimes(2));
  expect((api.send as jest.Mock).mock.calls[0][1].requestId).toBe((api.send as jest.Mock).mock.calls[1][1].requestId);
  expect(ui.getByDisplayValue('Keep me')).toBeTruthy(); await ui.unmount();
});
