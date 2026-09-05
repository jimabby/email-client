import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { api } from './api';

/**
 * Push notifications.
 *
 * The backend has watched every mailbox since boot — IMAP IDLE, Gmail Pub/Sub,
 * Graph webhooks, polling as a fallback — and told the desktop shell about
 * every arrival. The phone was the one client that heard nothing: it learned
 * about new mail only by being opened and pulled down.
 *
 * Delivery goes through Expo's push service, which the backend calls with the
 * token registered here.
 */

const TOKEN_KEY = 'hermes-push-token';

// Show a banner even when the app is in the foreground. A mail client is one
// of the few places where an arrival is worth interrupting the current screen
// for — and without this the notification is silently swallowed.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

export interface PushTarget {
  accountId?: string;
  emailId?: string;
  folder?: string;
  reason?: string;
}

/**
 * Ask for permission, obtain a token, and register it with the backend.
 *
 * Safe to call on every launch: Expo returns the same token for an install, and
 * the backend keys devices by token so re-registering updates in place.
 *
 * @returns the token, or null when push is unavailable (a simulator, a denied
 *          permission, or a server that cannot be reached).
 */
export async function registerForPush(): Promise<string | null> {
  // Simulators have no push transport, and asking would fail with a confusing
  // error rather than a clean "not available".
  if (!Device.isDevice) return null;

  try {
    const existing = await Notifications.getPermissionsAsync();
    let status = existing.status;
    if (status !== 'granted') {
      status = (await Notifications.requestPermissionsAsync()).status;
    }
    if (status !== 'granted') return null;

    if (Platform.OS === 'android') {
      // Android needs the channel to exist before a notification names it, or
      // the message arrives silently in the default channel.
      await Notifications.setNotificationChannelAsync('new-mail', {
        name: 'New mail',
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 200, 100, 200],
        lightColor: '#fbbf24',
      });
    }

    const { data: token } = await Notifications.getExpoPushTokenAsync();
    if (!token) return null;

    await api.registerDevice(token, Platform.OS);
    await AsyncStorage.setItem(TOKEN_KEY, token).catch(() => {});
    return token;
  } catch {
    // Push is an enhancement. A failure here must never stop the app starting.
    return null;
  }
}

/** Stop delivery to this device — used when the server or token is changed. */
export async function unregisterPush(): Promise<void> {
  try {
    const token = await AsyncStorage.getItem(TOKEN_KEY);
    if (token) await api.unregisterDevice(token);
    await AsyncStorage.removeItem(TOKEN_KEY);
  } catch { /* best effort */ }
}

/** Pull the routing payload out of a notification, whatever delivered it. */
export function targetFromNotification(
  response: Notifications.NotificationResponse | Notifications.Notification | null,
): PushTarget | null {
  const content = response && 'notification' in response
    ? response.notification.request.content
    : response?.request?.content;
  const data = content?.data as PushTarget | undefined;
  if (!data?.accountId) return null;
  return data;
}

/** Clear the app icon badge — called when the user actually reads their mail. */
export async function clearBadge(): Promise<void> {
  try { await Notifications.setBadgeCountAsync(0); } catch { /* not supported everywhere */ }
}
