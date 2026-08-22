import { useEffect } from 'react';
import { View, ActivityIndicator, TouchableOpacity, Text } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer, DarkTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { useAppStore } from './src/store';
import { theme } from './src/theme';
import { ui } from './src/ui';
import type { RootStackParamList } from './src/navigation';

import SettingsScreen from './src/screens/SettingsScreen';
import AccountsScreen from './src/screens/AccountsScreen';
import InboxScreen from './src/screens/InboxScreen';
import ViewerScreen from './src/screens/ViewerScreen';
import ComposeScreen from './src/screens/ComposeScreen';
import OutboxScreen from './src/screens/OutboxScreen';

const Stack = createNativeStackNavigator<RootStackParamList>();

const navTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: theme.bg,
    card: theme.bgElevated,
    text: theme.text,
    border: theme.border,
    primary: theme.accent,
  },
};

const screenOptions = {
  // The header sits on the same ground as the content rather than being a
  // separate slab — the same move the desktop chrome makes.
  headerStyle: { backgroundColor: theme.bg },
  headerShadowVisible: false,
  headerTitleStyle: { color: theme.text, fontSize: 17, fontWeight: '600' as const, letterSpacing: -0.2 },
  headerTintColor: theme.accent,
  contentStyle: { backgroundColor: theme.bg },
};

export default function App() {
  const { serverReady, serverUrl, loadServerUrl } = useAppStore();

  useEffect(() => {
    loadServerUrl();
  }, [loadServerUrl]);

  if (!serverReady) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.bg, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={theme.accent} size="large" />
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <NavigationContainer theme={navTheme}>
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
            name="Inbox"
            component={InboxScreen}
            options={({ route }) => ({ title: route.params.account.name || route.params.account.email })}
          />
          <Stack.Screen name="Viewer" component={ViewerScreen} options={{ title: '' }} />
          <Stack.Screen name="Compose" component={ComposeScreen} options={{ title: 'New message' }} />
          <Stack.Screen name="Settings" component={SettingsScreen} options={{ title: 'Settings' }} />
          <Stack.Screen name="Outbox" component={OutboxScreen} options={{ title: 'Outbox' }} />
        </Stack.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}
