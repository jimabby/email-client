import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';

const SERVER_KEY = 'hermes-server-url';

interface AppState {
  serverUrl: string;
  serverReady: boolean; // hydrated from storage yet?
  setServerUrl: (url: string) => Promise<void>;
  loadServerUrl: () => Promise<void>;
}

function normalizeUrl(url: string): string {
  let u = url.trim().replace(/\/+$/, '');
  if (u && !/^https?:\/\//i.test(u)) u = `http://${u}`;
  return u;
}

export const useAppStore = create<AppState>((set) => ({
  serverUrl: '',
  serverReady: false,

  setServerUrl: async (url) => {
    const normalized = normalizeUrl(url);
    await AsyncStorage.setItem(SERVER_KEY, normalized);
    set({ serverUrl: normalized });
  },

  loadServerUrl: async () => {
    try {
      const saved = await AsyncStorage.getItem(SERVER_KEY);
      set({ serverUrl: saved || '', serverReady: true });
    } catch {
      set({ serverReady: true });
    }
  },
}));
