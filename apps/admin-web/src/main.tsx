import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { createHttpApiClient } from './api';

// The API origin (same host in dev via Vite proxy / configured at build time).
const baseUrl = import.meta.env.VITE_API_URL ?? '';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App api={createHttpApiClient(baseUrl)} />
  </StrictMode>,
);
