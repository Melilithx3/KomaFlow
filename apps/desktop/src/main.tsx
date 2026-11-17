import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { browserHost } from './hosts/browserHost.js';
import { isTauri, tauriHost } from './hosts/tauriHost.js';
import { App } from './ui/App.js';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App host={isTauri() ? tauriHost : browserHost} />
  </StrictMode>,
);
