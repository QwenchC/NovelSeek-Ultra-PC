import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { Layout } from '@components/Layout';
import { HomePage } from '@pages/HomePage';
import { LongNovelsHomePage } from '@pages/LongNovelsHomePage';
import { LongNovelPage } from '@pages/LongNovelPage';
import { LongNovelOutlinePage } from '@pages/LongNovelOutlinePage';
import { LongNovelEditorPage } from '@pages/LongNovelEditorPage';
import { LongNovelCharactersPage } from '@pages/LongNovelCharactersPage';
import { ProjectPage } from '@pages/ProjectPage';
import { EditorPage } from '@pages/EditorPage';
import { SettingsPage } from '@pages/SettingsPage';
import { OutlinePage } from '@pages/OutlinePage';
import { CharactersPage } from '@pages/CharactersPage';
import { ExportPage } from '@pages/ExportPage';
import { LongNovelExportPage } from '@pages/LongNovelExportPage';
import { ContainersPage } from '@pages/ContainersPage';
import { NovelQaPage } from '@pages/NovelQaPage';
import { SnapshotsPage } from '@pages/SnapshotsPage';
import { AgentPage } from '@pages/AgentPage';
import { ListenPage } from '@pages/ListenPage';
import { WritingWorkbenchPage } from '@pages/WritingWorkbenchPage';
import { BackupRecoveryGate } from '@components/BackupRecoveryGate';

function App() {
  return (
    <Router>
      <BackupRecoveryGate><Layout>
        <Routes>
          {/* App launches on the long-novel page by default. */}
          <Route path="/" element={<Navigate to="/long-novels" replace />} />
          <Route path="/short-novels" element={<HomePage />} />
          <Route path="/long-novels" element={<LongNovelsHomePage />} />
          <Route path="/workbench/:id" element={<WritingWorkbenchPage />} />
          <Route path="/long-novel/:id" element={<LongNovelPage />} />
          <Route path="/long-novel/:id/outline" element={<LongNovelOutlinePage />} />
          <Route path="/long-novel/:id/editor/:chapterId?" element={<LongNovelEditorPage />} />
          <Route path="/long-novel/:id/characters" element={<LongNovelCharactersPage />} />
          <Route path="/long-novel/:id/containers" element={<ContainersPage />} />
          <Route path="/long-novel/:id/qa" element={<NovelQaPage />} />
          <Route path="/long-novel/:id/history" element={<SnapshotsPage />} />
          <Route path="/long-novel/:id/listen" element={<ListenPage />} />
          <Route path="/long-novel/:id/export" element={<LongNovelExportPage />} />
          <Route path="/project/:id" element={<ProjectPage />} />
          <Route path="/project/:id/outline" element={<OutlinePage />} />
          <Route path="/project/:id/characters" element={<CharactersPage />} />
          <Route path="/project/:id/export" element={<ExportPage />} />
          <Route path="/editor/:projectId/:chapterId?" element={<EditorPage />} />
          <Route path="/agent" element={<AgentPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </Layout></BackupRecoveryGate>
    </Router>
  );
}

export default App;
