import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'jo.businesshub.pos',
  appName: 'Business Hub POS',
  webDir: 'dist',
  // Android serves the bundle from https://localhost, iOS from capacitor://localhost: both must be in the API's CORS_ORIGIN.
  server: { androidScheme: 'https' },
};

export default config;
