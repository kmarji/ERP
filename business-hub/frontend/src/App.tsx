import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { auth } from './lib/api';
import Approvals from './pages/Approvals';
import Audit from './pages/Audit';
import Exceptions from './pages/Exceptions';
import Finance from './pages/Finance';
import Inventory from './pages/Inventory';
import Marketplaces from './pages/Marketplaces';
import OnlineOrders from './pages/OnlineOrders';
import OnlineStoreSettings from './pages/OnlineStoreSettings';
import Payables from './pages/Payables';
import Products from './pages/Products';
import Purchasing from './pages/Purchasing';
import Receiving from './pages/Receiving';
import StockOperations from './pages/StockOperations';
import Suppliers from './pages/Suppliers';
import Login from './pages/Login';
import OwnerHome from './pages/OwnerHome';
import Customers from './pages/Customers';
import MenuAdmin from './pages/MenuAdmin';
import PosDevices from './pages/PosDevices';
import Sales from './pages/Sales';
import Policies from './pages/Policies';
import Settings from './pages/Settings';
import TaxFiling from './pages/TaxFiling';
import Onboarding from './pages/Onboarding';
import People from './pages/People';
import Recruitment from './pages/Recruitment';
import Scheduling from './pages/Scheduling';
import TimeAttendance from './pages/TimeAttendance';
import Leave from './pages/Leave';
import Payroll from './pages/Payroll';
import PayrollRun from './pages/PayrollRun';
import Offboarding from './pages/Offboarding';
import MySpace from './pages/MySpace';

function Protected() {
  return auth.get() ? <Layout /> : <Navigate to="/login" replace />;
}

// Milestones add their routes inside the protected block.
export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<Protected />}>
        <Route path="/" element={<OwnerHome />} />
        <Route path="/exceptions" element={<Exceptions />} />
        <Route path="/approvals" element={<Approvals />} />
        <Route path="/purchasing" element={<Purchasing />} />
        <Route path="/receiving" element={<Receiving />} />
        <Route path="/suppliers" element={<Suppliers />} />
        <Route path="/online-orders" element={<OnlineOrders />} />
        <Route path="/online-store" element={<OnlineStoreSettings />} />
        <Route path="/marketplaces" element={<Marketplaces />} />
        <Route path="/payables" element={<Payables />} />
        <Route path="/products" element={<Products />} />
        <Route path="/inventory" element={<Inventory />} />
        <Route path="/stock-operations" element={<StockOperations />} />
        <Route path="/finance" element={<Finance />} />
        <Route path="/menu" element={<MenuAdmin />} />
        <Route path="/sales" element={<Sales />} />
        <Route path="/pos-devices" element={<PosDevices />} />
        <Route path="/customers" element={<Customers />} />
        <Route path="/tax" element={<TaxFiling />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/recruitment" element={<Recruitment />} />
        <Route path="/onboarding" element={<Onboarding />} />
        <Route path="/people" element={<People />} />
        <Route path="/scheduling" element={<Scheduling />} />
        <Route path="/time" element={<TimeAttendance />} />
        <Route path="/leave" element={<Leave />} />
        <Route path="/payroll" element={<Payroll />} />
        <Route path="/payroll/runs/:id" element={<PayrollRun />} />
        <Route path="/offboarding" element={<Offboarding />} />
        <Route path="/me" element={<MySpace />} />
        <Route path="/policies" element={<Policies />} />
        <Route path="/audit" element={<Audit />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
