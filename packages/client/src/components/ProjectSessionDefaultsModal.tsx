import { SERVER_CAPABILITIES, serverHasCapability } from "@yep-anywhere/shared";
import { useMemo } from "react";
import { useI18n } from "../i18n";
import { ProjectSharingSection } from "./ProjectSharingSection";
import styles from "./ProjectSessionDefaultsModal.module.css";
import { Button } from "./ui/Button";
import { Modal } from "./ui/Modal";
import { Link } from "react-router-dom";
import { useVersion } from "../hooks/useVersion";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { ProjectAppViewer } from "./ProjectAppViewer";

interface ProjectSessionDefaultsModalProps {
  projectId: string;
  projectName?: string;
  /** The limited user who created the project, who may share it. */
  ownerUsername?: string;
  onClose: () => void;
}

export function ProjectSessionDefaultsModal({
  projectId,
  projectName,
  ownerUsername,
  onClose,
}: ProjectSessionDefaultsModalProps) {
  const { t } = useI18n();
  const { version } = useVersion();
  const basePath = useRemoteBasePath();
  const title = useMemo(
    () =>
      projectName
        ? t("projectSettingsTitleNamed", { project: projectName })
        : t("projectSettingsTitle"),
    [projectName, t],
  );

  return (
    <Modal title={title} onClose={onClose}>
      <div className={styles.body}>
        <div className={styles.column}>
          {serverHasCapability(
            version,
            SERVER_CAPABILITIES.projectService.name,
          ) && (
            <section className={styles.section}>
              <div className={styles.sectionTitle}>
                <h3>{t("projectAppLabel")}</h3>
                <Link
                  to={`${basePath}/projects/${projectId}/app`}
                  onClick={onClose}
                >
                  {t("projectAppOpen")}
                </Link>
              </div>
              <ProjectAppViewer projectId={projectId} presentation="settings" />
            </section>
          )}
          <ProjectSharingSection
            projectId={projectId}
            ownerUsername={ownerUsername}
          />
        </div>
        <div className={styles.actions}>
          <Button onClick={onClose}>{t("cancel")}</Button>
        </div>
      </div>
    </Modal>
  );
}
