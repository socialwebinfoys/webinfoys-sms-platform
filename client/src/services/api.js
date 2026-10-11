// Centralized Axios instance. All backend calls go through here so token
// handling and base URL live in one place.
import axios from 'axios';
import { resolveApiBase } from '../utils/apiBase';

// Phase 0: the API base URL is build-time configurable.
//   * Local development: VITE_API_URL is unset, so this falls back to '/api' and
//     Vite's dev-server proxy forwards to the backend on :5000 (unchanged).
//   * Production: the Hostinger-hosted frontend and the Render-hosted backend are
//     different origins, so there is no relative '/api' to hit. Build with
//     VITE_API_URL=https://<api-host>/api (see client/.env.example). A value given
//     without the /api suffix is corrected by resolveApiBase, because every
//     backend route lives under /api.
// Vite inlines import.meta.env.* at build time — this is a public URL, never a secret.
const api = axios.create({
  baseURL: resolveApiBase(import.meta.env.VITE_API_URL),
});

// Attach the JWT (if present) to every request.
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// On 401, clear the stored session so the app falls back to the login screen.
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response && error.response.status === 401) {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      // Avoid redirect loops if we are already on the login page.
      if (!window.location.pathname.startsWith('/login')) {
        window.location.assign('/login');
      }
    }
    return Promise.reject(error);
  }
);

export default api;
