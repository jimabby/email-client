// Must run before OpenPGP.js loads (crypto.getRandomValues, TextDecoder).
import './src/pgpPolyfills';
import { registerRootComponent } from 'expo';
// Defines the background outbox task; must load before anything else runs.
import './src/backgroundOutbox';
import App from './App';

registerRootComponent(App);
