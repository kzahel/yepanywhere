import { useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { SERVER_CAPABILITIES, serverHasCapability } from "@yep-anywhere/shared";
import { NewSessionForm } from "../components/NewSessionForm";
import { ProjectAppViewer } from "../components/ProjectAppViewer";
import { Button } from "../components/ui/Button";
import type { VoiceInputButtonRef } from "../components/VoiceInputButton";
import type { ProjectAppTarget } from "../api/projectApp";
import { useProject } from "../hooks/useProjects";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useVersion } from "../hooks/useVersion";
import { MainContent, useNavigationLayout } from "../layouts";
import styles from "../components/ProjectAppViewer.module.css";
import { useI18n } from "../i18n";

export function ProjectAppPage() {
  const { t } = useI18n();
  const { projectId } = useParams<{ projectId: string }>();
  const { version } = useVersion();
  const enabled = serverHasCapability(
    version,
    SERVER_CAPABILITIES.projectService.name,
  );
  return projectId && enabled ? (
    <ProjectAppWorkspace key={projectId} projectId={projectId} />
  ) : (
    <p>{t("projectAppUpdateRequired")}</p>
  );
}

function ProjectAppWorkspace({ projectId }: { projectId: string }) {
  const { t } = useI18n();
  const { isWideScreen } = useNavigationLayout();
  const { project } = useProject(projectId);
  const basePath = useRemoteBasePath();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [composing, setComposing] = useState(params.get("compose") === "1");
  const [showApp, setShowApp] = useState(
    isWideScreen || params.get("compose") !== "1",
  );
  const [voice, setVoice] = useState<VoiceInputButtonRef | null>(null);
  const [target, setTarget] = useState<ProjectAppTarget>();
  const begin = () => {
    setComposing(true);
    setShowApp(isWideScreen);
  };
  return (
    <MainContent isWideScreen={isWideScreen} innerClassName={styles.workspace}>
      {project && (
        <div
          className={`${styles.composer} ${!composing || (!isWideScreen && showApp) ? styles.concealed : ""}`}
        >
          <Button
            onClick={() => {
              setShowApp(true);
            }}
          >
            {t("projectAppLabel")}
          </Button>
          <NewSessionForm
            projectId={projectId}
            selectedProject={project}
            projects={[project]}
            autoFocus={false}
            fixedProject={showApp}
            projectApp={target}
            onVoiceControl={setVoice}
          />
        </div>
      )}
      <div
        className={`${styles.appColumn} ${!showApp ? styles.concealed : ""}`}
      >
        <ProjectAppViewer
          projectId={projectId}
          projectName={project?.name}
          onTarget={setTarget}
          voice={voice}
          onSession={begin}
          onVoice={begin}
          initialSettings={params.get("settings") === "1"}
          onBack={() => {
            if (composing) {
              setShowApp(false);
              setComposing(true);
            } else {
              navigate(`${basePath}/projects`);
            }
          }}
        />
      </div>
    </MainContent>
  );
}
