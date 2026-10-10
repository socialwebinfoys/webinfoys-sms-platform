// Route table. Feature screens grow with each phase.
import { Routes, Route, Navigate } from 'react-router-dom';
import Login from './pages/Login';
import Contacts from './pages/Contacts';
import Templates from './pages/Templates';
import Campaigns from './pages/Campaigns';
import Enrollments from './pages/Enrollments';
import Following from './pages/Following';
import Inbox from './pages/Inbox';
import AiAssistant from './pages/AiAssistant';
import Delivery from './pages/Delivery';
import Dashboard from './pages/Dashboard';
import Logs from './pages/Logs';
import Settings from './pages/Settings';
import Users from './pages/Users';
import ProtectedRoute from './components/ProtectedRoute';
import Layout from './components/Layout';

function Protected({ children }) {
  return (
    <ProtectedRoute>
      <Layout>{children}</Layout>
    </ProtectedRoute>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/contacts" element={<Protected><Contacts /></Protected>} />
      <Route path="/templates" element={<Protected><Templates /></Protected>} />
      <Route path="/campaigns" element={<Protected><Campaigns /></Protected>} />
      <Route path="/enrollments" element={<Protected><Enrollments /></Protected>} />
      <Route path="/following" element={<Protected><Following /></Protected>} />
      <Route path="/inbox" element={<Protected><Inbox /></Protected>} />
      <Route path="/ai" element={<Protected><AiAssistant /></Protected>} />
      <Route path="/dashboard" element={<Protected><Dashboard /></Protected>} />
      <Route path="/delivery" element={<Protected><Delivery /></Protected>} />
      <Route path="/logs" element={<Protected><Logs /></Protected>} />
      <Route path="/settings" element={<Protected><Settings /></Protected>} />
      <Route path="/users" element={<Protected><Users /></Protected>} />
      <Route path="*" element={<Navigate to="/contacts" replace />} />
    </Routes>
  );
}
