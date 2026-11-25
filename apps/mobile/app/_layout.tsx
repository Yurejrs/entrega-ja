import { AppFeedback } from '../src/AppFeedback';
import { Stack } from 'expo-router';
import { useFonts, Inter_400Regular, Inter_500Medium, Inter_600SemiBold } from '@expo-google-fonts/inter';
import { StatusBar } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import '../src/route-tracking';
import '../src/live-location';

export default function Layout() {
  const [loaded] = useFonts({ Inter_400Regular, Inter_500Medium, Inter_600SemiBold });
  if (!loaded) return null;

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" backgroundColor="#F4F7F8" />
      <Stack screenOptions={{
        headerShown: false,
        headerStyle: { backgroundColor: '#072A35' },
        headerTintColor: '#E6EEF1',
        headerTitleStyle: { fontFamily: 'Inter_600SemiBold' },
      }}>
        <Stack.Screen name="index" options={{ title: 'Entrega Já' }} />
        <Stack.Screen name="delivery/[id]" options={{ title: 'Detalhes da entrega' }} />
      </Stack>
      <AppFeedback/>
    </SafeAreaProvider>
  );
}
