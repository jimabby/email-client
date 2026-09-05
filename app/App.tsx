import { useEffect, useMemo, useRef } from 'react';
import { View, ActivityIndicator, TouchableOpacity, Text } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import * as Notifications from 'expo-notifications';
import {
  NavigationContainer, DarkTheme, DefaultTheme, type NavigationContainerRef,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { useAppStore } from './src/store';
import { ThemeProvider, useTheme } from './src/ThemeContext';
import { api } from './src/api';
import { registerForPush, targetFromNotification, type PushTarget } from './src/push';
import type { RootStackParamList } from './src/navigation';

import SettingsScreen from './src/screens/SettingsScreen';
import AccountsScreen from './src/screens/AccountsScreen';
import FoldersScreen from './src/screens/FoldersScreen';
import InboxScreen from './src/screens/InboxScreen';
import ViewerScreen from './src/screens/ViewerScreen';
import ComposeScreen from './src/screens/ComposeScreen';
import OutboxScreen from './src/screens/OutboxScreen';

const Stack = createNativeStackNavigator<RootStackParamList>();

function Root() {
  const { serverReady, serverUrl, loadServerUrl } = useAppStore();
  const { t, ui, mode } = useTheme();
  const navigationRef = useRef<NavigationContainerRef<RootStackParamList>>(null);
  // A notification can arrive before the navigator is mounted (a cold start
  // from a tapped banner), so the target is held until navigation is ready.
  const pendingTarget = useRef<PushTarget | null>(null);

  useEffect(() => {
    loadServerUrl();
  }, [loadServerUrl]);

  // Register for push once the server address and token are known — the
  // registration call itself is authenticated.
  useEffect(() => {
    if (!serverUrl) return;
    registerForPush().catch(() => { /* push is an enhancement, never fatal */ });
  }, [serverUrl]);

  /**
   * Open the message a notification refers to.
   *
   * The payload names the account, folder and message id. The summary itself is
   * not in the payload (it would not survive a push size limit, and it would be
   * stale by the time it was tapped), so the folder is fetched and the message
   * located in it. Failing that, the account's inbox is still the right place
   * to land.
   */
  const openTarget = async (target: PushTarget) => {
    const nav = navigationRef.current;
    if (!nav?.isReady()) { pendingTarget.current = target; return; }

    try {
      const accounts = await api.listAccounts();
      const account = accounts.find(a => a.id === target.accountId);
      if (!account) return;

      const folder = target.folder || 'INBOX';
      nav.navigate('Inbox', { account, folder });

      if (!target.emailId) return;
      const { emails } = await api.listEmails(account.id, folder, 50);
      const email = emails.find(e => e.id === target.emailId);
      if (email) nav.navigate('Viewer', { account, email });
    } catch {
      // Landing on the inbox is an acceptable outcome for a tapped banner.
    }
  };

  useEffect(() => {
    // Tapped while the app was running, or tapped to launch it.
    const responseSub = Notifications.addNotificationResponseReceivedListener((response) => {
      const target = targetFromNotification(response);
      if (target) openTarget(target);
    });

    Notifications.getLastNotificationResponseAsync()
      .then((response) => {
        const target = targetFromNotification(response);
        if (target) openTarget(target);
      })
      .catch(() => {});

    return () => responseSub.remove();
  }, []);

  const navTheme = useMemo(() => {
    const base = mode === 'dark' ? DarkTheme : DefaultTheme;
    return {
      ...base,
      colors: {
        ...base.colors,
        background: t.bg,
        card: t.bgElevated,
        text: t.text,
        border: t.border,
        primary: t.accent,
      },
    };
  }, [mode, t]);

  const screenOptions = useMemo(() => ({
    // The header sits on the same ground as the content rather than being a
    // separate slab — the same move the desktop chrome makes.
    headerStyle: { backgroundColor: t.bg },
    headerShadowVisible: false,
    headerTitleStyle: { color: t.text, fontSize: 17, fontWeight: '600' as const, letterSpacing: -0.2 },
    headerTintColor: t.accent,
    contentStyle: { backgroundColor: t.bg },
  }), [t]);

  if (!serverReady) {
    return (
      <View style={{ flex: 1, backgroundColor: t.bg, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={t.accent} size="large" />
      </View>
    );
  }

  return (
    <>
      <StatusBar style={mode === 'dark' ? 'light' : 'dark'} />
      <NavigationContainer
        ref={navigationRef}
        theme={navTheme}
        onReady={() => {
          const target = pendingTarget.current;
          pendingTarget.current = null;
          if (target) openTarget(target);
        }}
      >
        <Stack.Navigator
          initialRouteName={serverUrl ? 'Accounts' : 'Settings'}
          screenOptions={screenOptions}
        >
          <Stack.Screen
            name="Accounts"
            component={AccountsScreen}
            options={({ navigation }) => ({
              title: 'Hermes',
              headerRight: () => (
                <View style={{ flexDirection: 'row', gap: 16 }}>
                  <TouchableOpacity onPress={() => navigation.navigate('Outbox')}>
                    <Text style={ui.headerAction}>Outbox</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => navigation.navigate('Settings')}>
                    <Text style={ui.headerAction}>Settings</Text>
                  </TouchableOpacity>
                </View>
              ),
            })}
          />
          <Stack.Screen
            name="Folders"
            component={FoldersScreen}
            options={({ route }) => ({ title: route.params.account.name || route.params.account.email })}
          />
          {/* The Inbox screen sets its own title: it may be a folder, one
              account's inbox, or the unified list. */}
          <Stack.Screen name="Inbox" component={InboxScreen} />
          <Stack.Screen name="Viewer" component={ViewerScreen} options={{ title: '' }} />
          <Stack.Screen name="Compose" component={ComposeScreen} options={{ title: 'New message' }} />
          <Stack.Screen name="Settings" component={SettingsScreen} options={{ title: 'Settings' }} />
          <Stack.Screen name="Outbox" component={OutboxScreen} options={{ title: 'Outbox' }} />
        </Stack.Navigator>
      </NavigationContainer>
    </>
  );
}

export default function App() {
  return (
    // GestureHandlerRootView has to wrap the whole tree for Swipeable rows in
    // the inbox to receive touches.
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <Root />
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
