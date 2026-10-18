// App shell (Phase 9): branded sidebar navigation on desktop, collapsing to an
// off-canvas drawer on tablet/mobile. Presentation only — no change to auth or
// routing behavior.
import { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';

// Simple, dependency-free line icons (inline SVG).
const Icon = {
  dashboard: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="9" /><rect x="14" y="3" width="7" height="5" />
      <rect x="14" y="12" width="7" height="9" /><rect x="3" y="16" width="7" height="5" />
    </svg>
  ),
  contacts: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  ),
  templates: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" />
      <line x1="8" y1="13" x2="16" y2="13" /><line x1="8" y1="17" x2="13" y2="17" />
    </svg>
  ),
  campaigns: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 11l18-5v12L3 14v-3z" /><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6" />
    </svg>
  ),
  enrollments: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 11 12 14 22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </svg>
  ),
  following: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" /><polyline points="12 7 12 12 15 14" />
    </svg>
  ),
  inbox: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  ),
  delivery: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 2 11 13" /><path d="M22 2 15 22l-4-9-9-4 20-7z" />
    </svg>
  ),
  // Phase 9: the AI assistant — drafts awaiting review and AI configuration.
  ai: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <rect x="5" y="7" width="14" height="12" rx="3" />
      <path d="M12 3v4M9 12h.01M15 12h.01M9.5 16h5" />
    </svg>
  ),
  logs: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
  logout: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  ),
  users: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  ),
  sun: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  ),
  moon: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  ),
  menu: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  ),
};

const NAV = [
  { to: '/dashboard', label: 'Dashboard', icon: Icon.dashboard },
  { to: '/contacts', label: 'Contacts', icon: Icon.contacts },
  { to: '/templates', label: 'Templates', icon: Icon.templates },
  { to: '/campaigns', label: 'Campaigns', icon: Icon.campaigns },
  { to: '/enrollments', label: 'Enrollments', icon: Icon.enrollments },
  { to: '/following', label: 'Following', icon: Icon.following },
  { to: '/inbox', label: 'Inbox', icon: Icon.inbox },
  // Phase 9: next to Inbox because reviewing AI drafts is inbox work.
  { to: '/ai', label: 'AI Assistant', icon: Icon.ai },
  { to: '/delivery', label: 'SMS Delivery', icon: Icon.delivery },
  { to: '/logs', label: 'Logs', icon: Icon.logs },
  { to: '/settings', label: 'Settings', icon: Icon.settings },
  // Phase 7: admin-only team page. Hidden for non-admins below; the API
  // enforces the restriction regardless of what is rendered.
  { to: '/users', label: 'Team', icon: Icon.users, adminOnly: true },
];

function Wordmark() {
  return (
    <div className="sidebar-brand">
      <div className="brand-mark">W</div>
      <div className="brand-word">
        Webinfoys
        <span className="brand-sub">SMS Platform</span>
      </div>
    </div>
  );
}

// Phase 7: theme preference. Dark is the default and the historical look, so an
// unset or unreadable preference always resolves to dark. localStorage can throw
// in a private window, hence the guards.
const THEME_KEY = 'webinfoys-theme';
function readStoredTheme() {
  try {
    return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export default function Layout({ children }) {
  const { user, logout } = useAuth();
  const location = useLocation();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [theme, setTheme] = useState(readStoredTheme);

  // Apply the theme to <html> so the CSS variable overrides take effect, and
  // persist it so a refresh keeps the choice.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* private window / storage disabled — the theme still applies for this session */
    }
  }, [theme]);

  const toggleTheme = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'));
  // Phase 4: unread conversation count for the Inbox nav badge, from the
  // dedicated endpoint (never by downloading the whole conversation list).
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (document.visibilityState === 'hidden') return;
      try {
        const { data } = await api.get('/conversations/unread-count');
        if (!cancelled) setUnread(data.count || 0);
      } catch {
        /* a failed poll is not worth surfacing */
      }
    };
    load();
    const id = setInterval(load, 20000);
    document.addEventListener('visibilitychange', load);
    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener('visibilitychange', load);
    };
  }, [location.pathname]);

  // While the Inbox is open its own refresh already fetches the unread count,
  // and announces it — so the badge follows the Inbox's interval for free.
  useEffect(() => {
    const onInboxUnread = (e) => {
      if (typeof e.detail === 'number') setUnread(e.detail);
    };
    window.addEventListener('inbox:unread', onInboxUnread);
    return () => window.removeEventListener('inbox:unread', onInboxUnread);
  }, []);

  // Close the mobile drawer whenever navigation occurs.
  const closeDrawer = () => setDrawerOpen(false);

  const linkClass = ({ isActive }) => (isActive ? 'side-link active' : 'side-link');
  const initials = (user?.name || user?.email || '?').trim().charAt(0).toUpperCase();

  return (
    <div className={`app-shell${drawerOpen ? ' drawer-open' : ''}`}>
      {/* Sidebar */}
      <aside className="sidebar" aria-label="Primary">
        <Wordmark />
        <nav className="sidebar-nav">
          {NAV.filter((item) => !item.adminOnly || user?.role === 'admin').map((item) => (
            <NavLink key={item.to} to={item.to} className={linkClass} onClick={closeDrawer}>
              {item.icon}
              <span>{item.label}</span>
              {item.to === '/inbox' && unread > 0 && (
                <span className="nav-badge" title={`${unread} conversation(s) with unread messages`}>
                  {unread > 99 ? '99+' : unread}
                </span>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="avatar">{initials}</div>
          <div className="who">
            <div className="nm">{user?.name || user?.email || 'Signed in'}</div>
            {user?.role && <div className="rl">{user.role}</div>}
          </div>
          {/* Phase 7: light / dark toggle. Writes a data-theme attribute that
              the CSS variable overrides in styles.css key off. */}
          <button
            className="icon-btn theme-toggle"
            onClick={toggleTheme}
            title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            aria-label="Toggle colour theme"
          >
            {theme === 'dark' ? Icon.sun : Icon.moon}
          </button>
          <button className="icon-btn" onClick={logout} title="Log out" aria-label="Log out">
            {Icon.logout}
          </button>
        </div>
      </aside>

      {/* Scrim for the mobile drawer */}
      <div className="scrim" onClick={closeDrawer} aria-hidden="true" />

      {/* Main column */}
      <div className="main-area">
        <header className="mobile-topbar">
          <button
            className="hamburger"
            onClick={() => setDrawerOpen((v) => !v)}
            aria-label="Open menu"
            aria-expanded={drawerOpen}
          >
            {Icon.menu}
          </button>
          <div className="brand-word">Webinfoys SMS</div>
        </header>
        {/* The Inbox is a workspace, not a document: it takes the full width
            and exactly the viewport height, and scrolls inside its panels. */}
        <main
          className={`content${location.pathname === '/inbox' ? ' content-wide' : ''}`}
          key={location.pathname}
        >
          {children}
        </main>
      </div>
    </div>
  );
}
