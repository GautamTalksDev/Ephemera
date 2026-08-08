import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout.tsx";
import { EnvironmentDetailPage } from "./pages/EnvironmentDetailPage.tsx";
import { EnvironmentsPage } from "./pages/EnvironmentsPage.tsx";
import { ImportPage } from "./pages/ImportPage.tsx";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<EnvironmentsPage />} />
          <Route path="environments/:id" element={<EnvironmentDetailPage />} />
          <Route path="import" element={<ImportPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
