import { Navigate, Route, Routes } from "react-router-dom";
import { Admin } from "./pages/Admin.js";
import { Privacy } from "./pages/Privacy.js";

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/admin" replace />} />
      <Route path="/admin/*" element={<Admin />} />
      <Route path="/privacy" element={<Privacy />} />
    </Routes>
  );
}
