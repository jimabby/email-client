/// <reference types="jest" />
// The composer with an OpenPGP key held on this phone: the message is built
// and encrypted here, and only those bytes reach the API.
jest.mock('../src/backgroundOutbox', () => ({ ensureBackgroundDelivery: jest.fn(async () => true) }));
jest.mock('../src/offline', () => ({ queueOffline: jest.fn(), offlineUnavailable: () => false }));
jest.mock('../src/devicePgp', () => ({
  hasDeviceKey: jest.fn(async () => true),
  isUnlocked: jest.fn(() => true),
  deviceReadiness: jest.fn(() => ({ recipients: ['friend@example.org'], missing: [], canEncrypt: true })),
  buildEncryptedMessage: jest.fn(async () => 'RU5DUllQVEVE'),
}));
import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';
import ComposeScreen from '../src/screens/ComposeScreen';
import { api } from '../src/api';
import { buildEncryptedMessage } from '../src/devicePgp';
jest.mock('../src/api', () => ({ api: {
  aiSettings: jest.fn(async () => ({ configured: false })), send: jest.fn(), saveDraft: jest.fn(),
  pgpReadiness: jest.fn(), publicKeys: jest.fn(async () => ({ keys: [{ email: 'friend@example.org', publicKey: 'PUB' }] })),
}, errorMessage: (e: Error) => e.message }));
jest.mock('../src/drafts', () => ({ saveLocalDraft: jest.fn(async () => {}), removeLocalDraft: jest.fn(async () => {}) }));
jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));
jest.mock('expo-file-system/legacy', () => ({ readAsStringAsync: jest.fn(), EncodingType: { Base64: 'base64' } }));
jest.mock('expo-crypto', () => ({ randomUUID: jest.fn(() => 'device-request-0001') }));
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

test('an encrypted send carries only the bytes encrypted on the phone', async () => {
  (api.send as jest.Mock).mockResolvedValue({ jobId: 'job' });
  const ui = await screen({ prefill: { to: 'friend@example.org', subject: 'Secret plans', body: 'Meet at noon' } });
  await waitFor(() => expect(api.publicKeys).toHaveBeenCalled());
  await waitFor(() => expect(ui.getByText(/Encrypt/)).toBeTruthy(), { timeout: 2000 });
  await fireEvent.press(ui.getByText(/Encrypt/));
  const header = await render(options.headerRight()); await fireEvent.press(header.getByText('Send'));
  await waitFor(() => expect(api.send).toHaveBeenCalled());

  expect(buildEncryptedMessage).toHaveBeenCalledWith(expect.objectContaining({ subject: 'Secret plans', text: 'Meet at noon', from: { name: 'Me', address: 'me@example.com' } }), [{ email: 'friend@example.org', publicKey: 'PUB' }]);
  const payload = (api.send as jest.Mock).mock.calls[0][1];
  expect(payload.prebuiltRaw).toBe('RU5DUllQVEVE');
  expect(JSON.stringify(payload)).not.toMatch(/Secret plans|Meet at noon/);
  expect(payload.requestId).toBe('device-request-0001');
  await ui.unmount();
});

test('an encrypted draft stays on the phone instead of the provider', async () => {
  const ui = await screen({ prefill: { to: 'friend@example.org', subject: 'Draft', body: 'Unfinished' } });
  await waitFor(() => expect(ui.getByText(/Encrypt/)).toBeTruthy(), { timeout: 2000 });
  await fireEvent.press(ui.getByText(/Encrypt/));
  await fireEvent.press(ui.getByText('Save draft'));
  await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Draft saved', expect.stringMatching(/on this phone/), expect.anything()));
  expect(api.saveDraft).not.toHaveBeenCalled();
  await ui.unmount();
});
