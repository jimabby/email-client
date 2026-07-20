import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

const SERVER_KEY = 'hermes-server-url';
const TOKEN_KEY = 'hermes-api-token';

interface AppState {
  serverUrl: string;
  apiToken: string;
  serverReady: boolean; // hydrated from storage yet?
  setServerUrl: (url: string) => Promise<void>;
  setApiToken: (token: string) => Promise<void>;
  loadServerUrl: () => Promise<void>;
}

function normalizeUrl(url: string): string {
  let u = url.trim().replace(/\/+$/, '');
  // Bare public hostnames should never silently downgrade credentials to HTTP.
  // Local development can still opt into HTTP by entering it explicitly.
  if (u && !/^https?:\/\//i.test(u)) u = `https://${u}`;
  return u;
}

export const useAppStore = create<AppState>((set) => ({
  serverUrl: '',
  apiToken: '',
  serverReady: false,

  setServerUrl: async (url) => {
    const normalized = normalizeUrl(url);
    await AsyncStorage.setItem(SERVER_KEY, normalized);
    set({ serverUrl: normalized });
  },

  setApiToken: async (token) => {
    const normalized = token.trim();
    if (normalized) await SecureStore.setItemAsync(TOKEN_KEY, normalized);
    else await SecureStore.deleteItemAsync(TOKEN_KEY);
    set({ apiToken: normalized });
  },

  loadServerUrl: async () => {
    try {
      const [savedUrl, savedToken] = await Promise.all([
        AsyncStorage.getItem(SERVER_KEY),
        SecureStore.getItemAsync(TOKEN_KEY),
      ]);
      set({ serverUrl: savedUrl || '', apiToken: savedToken || '', serverReady: true });
    } catch {
      set({ serverReady: true });
    }
  },
}));
