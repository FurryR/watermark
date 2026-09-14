import { CssBaseline, ThemeProvider } from "@mui/material";
import { Suspense, lazy } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AppLayout } from "./components/layout/AppLayout";
import { SettingsPage } from "./pages/SettingsPage";
import { StartPage } from "./pages/StartPage";
import { theme } from "./theme";
import { RuntimeSettingsProvider } from "./features/settings/runtimeSettings";
import { UnsavedChangesGuardProvider } from "./unsavedChangesGuard";

const CreatePage = lazy(() =>
  import("./pages/CreatePage").then((module) => ({ default: module.CreatePage })),
);

function App() {
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <RuntimeSettingsProvider>
        <UnsavedChangesGuardProvider>
          <BrowserRouter>
            <Routes>
              <Route path="/" element={<AppLayout />}>
                <Route index element={<StartPage />} />
                <Route
                  path="create"
                  element={
                    <Suspense fallback={null}>
                      <CreatePage />
                    </Suspense>
                  }
                />
                <Route path="settings" element={<SettingsPage />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Routes>
          </BrowserRouter>
        </UnsavedChangesGuardProvider>
      </RuntimeSettingsProvider>
    </ThemeProvider>
  );
}

export default App;
