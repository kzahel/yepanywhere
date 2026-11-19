import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomically } from "../utils/writeFileAtomically.js";

const artifactSchema = z.strictObject({
  id: z.string().uuid(),
  path: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  associatedAt: z.string(),
  order: z.number().int().nonnegative(),
});
const visibilityEventSchema = z.strictObject({
  username: z.string().min(1),
  actor: z.string().min(1),
  hidden: z.boolean(),
  at: z.string(),
});
const reservationSchema = z.strictObject({
  namespace: z.string().min(1),
  name: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/),
  projectId: z.string().min(1),
  owner: z.string().min(1),
  reservedAt: z.string(),
  serving: z.boolean(),
  public: z.boolean(),
  privateOnly: z.boolean().default(true),
  /** Public access the superuser chose; the owner's permission cannot cap it. */
  superuserPublic: z.boolean().default(false),
});
const projectSchema = z.strictObject({
  latestArtifact: artifactSchema.optional(),
  artifactHistory: z.array(artifactSchema).default([]),
  visibility: z.record(z.string(), z.boolean()),
  visibilityEvents: z.array(visibilityEventSchema),
});
const storeSchema = z.strictObject({
  version: z.literal(1),
  nextAssociation: z.number().int().nonnegative(),
  projects: z.record(z.string(), projectSchema),
  reservations: z.array(reservationSchema),
});
type Store = z.infer<typeof storeSchema>;
export type ProjectArtifactAssociation = z.infer<typeof artifactSchema>;
export type ProjectAppReservation = z.infer<typeof reservationSchema>;

/** YA-owned associations, personal visibility and first-claim-wins names. */
export class ProjectAppStore {
  private state: Store = {
    version: 1,
    nextAssociation: 0,
    projects: {},
    reservations: [],
  };
  private writing: Promise<unknown> = Promise.resolve();
  readonly ready: Promise<void>;
  private readonly file: string;

  constructor(private readonly directory: string) {
    this.file = join(directory, "project-apps.json");
    this.ready = this.load();
    // Every public operation still awaits readiness and receives this error.
    void this.ready.catch((error: unknown) =>
      console.error("[ProjectAppStore] State unavailable:", error),
    );
  }

  private async load(): Promise<void> {
    try {
      this.state = storeSchema.parse(
        JSON.parse(await readFile(this.file, "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private change<T>(operation: (state: Store) => Promise<T> | T): Promise<T> {
    const perform = async () => {
      await this.ready;
      const next = structuredClone(this.state);
      const result = await operation(next);
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await writeFileAtomically(this.file, JSON.stringify(next));
      this.state = next;
      return result;
    };
    const current = this.writing.then(perform, perform);
    // Queue completion is separate from the result each request must observe.
    this.writing = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  }

  private project(
    state: Store,
    projectId: string,
  ): z.infer<typeof projectSchema> {
    if (!Object.hasOwn(state.projects, projectId))
      Object.defineProperty(state.projects, projectId, {
        value: { artifactHistory: [], visibility: {}, visibilityEvents: [] },
        enumerable: true,
        configurable: true,
        writable: true,
      });
    return state.projects[projectId]!;
  }

  async latestArtifact(
    projectId: string,
  ): Promise<ProjectArtifactAssociation | null> {
    await this.ready;
    return Object.hasOwn(this.state.projects, projectId)
      ? structuredClone(this.state.projects[projectId]?.latestArtifact ?? null)
      : null;
  }

  associate(
    projectId: string,
    path: string,
    sessionId?: string,
  ): Promise<ProjectArtifactAssociation> {
    return this.change((state) => {
      const project = this.project(state, projectId);
      const previous = project.latestArtifact;
      if (previous?.path === path && previous.sessionId === sessionId)
        return structuredClone(previous);
      const artifact = artifactSchema.parse({
        id: randomUUID(),
        path,
        sessionId,
        associatedAt: new Date().toISOString(),
        order: state.nextAssociation++,
      });
      if (previous) project.artifactHistory.push(previous);
      project.latestArtifact = artifact;
      return structuredClone(artifact);
    });
  }

  async artifact(
    projectId: string,
    id: string,
  ): Promise<ProjectArtifactAssociation | null> {
    await this.ready;
    if (!Object.hasOwn(this.state.projects, projectId)) return null;
    const project = this.state.projects[projectId]!;
    return structuredClone(
      project.latestArtifact?.id === id
        ? project.latestArtifact
        : (project.artifactHistory.find((entry) => entry.id === id) ?? null),
    );
  }

  async hiddenProjectIds(username: string): Promise<ReadonlySet<string>> {
    await this.ready;
    return new Set(
      Object.entries(this.state.projects)
        .filter(
          ([, project]) =>
            Object.hasOwn(project.visibility, username) &&
            project.visibility[username] === true,
        )
        .map(([projectId]) => projectId),
    );
  }

  async visibilityHistory(projectId: string) {
    await this.ready;
    return Object.hasOwn(this.state.projects, projectId)
      ? structuredClone(this.state.projects[projectId]!.visibilityEvents)
      : [];
  }

  setHidden(
    projectId: string,
    username: string,
    hidden: boolean,
    actor: string,
  ): Promise<void> {
    return this.change((state) => {
      const project = this.project(state, projectId);
      const event = visibilityEventSchema.parse({
        username,
        actor,
        hidden,
        at: new Date().toISOString(),
      });
      if (
        Object.hasOwn(project.visibility, username) &&
        project.visibility[username] === hidden
      )
        return;
      Object.defineProperty(project.visibility, username, {
        value: hidden,
        enumerable: true,
        configurable: true,
        writable: true,
      });
      project.visibilityEvents.push(event);
    });
  }

  async reservations(projectId: string): Promise<ProjectAppReservation[]> {
    await this.ready;
    return structuredClone(
      this.state.reservations.filter((row) => row.projectId === projectId),
    );
  }

  async allReservations(): Promise<ProjectAppReservation[]> {
    await this.ready;
    return structuredClone(this.state.reservations);
  }

  reserve(
    input: Pick<
      ProjectAppReservation,
      "namespace" | "name" | "projectId" | "owner"
    > & { privateOnly?: boolean; serving?: boolean },
    authorize: () => Promise<void>,
  ): Promise<ProjectAppReservation> {
    return this.change(async (state) => {
      await authorize();
      const reservation = reservationSchema.parse({
        ...input,
        reservedAt: new Date().toISOString(),
        serving: input.serving ?? false,
        public: false,
        superuserPublic: false,
      });
      const existing = state.reservations.find(
        (row) =>
          row.namespace === reservation.namespace &&
          row.name === reservation.name,
      );
      if (existing) {
        if (existing.projectId !== reservation.projectId)
          throw new Error("App address is already reserved");
        return structuredClone(existing);
      }
      if (
        state.reservations.some(
          (row) =>
            row.namespace === reservation.namespace &&
            row.projectId === reservation.projectId,
        )
      )
        throw new Error(
          "This project already has an address in this namespace",
        );
      state.reservations.push(reservation);
      return structuredClone(reservation);
    });
  }

  setServing(
    projectId: string,
    namespace: string,
    serving: boolean,
    publicAccess: boolean,
    authorize: () => Promise<{ allowed: boolean; superuser: boolean }>,
  ): Promise<ProjectAppReservation> {
    return this.change(async (state) => {
      const { allowed, superuser } = await authorize();
      const row = state.reservations.find(
        (entry) =>
          entry.projectId === projectId && entry.namespace === namespace,
      );
      if (!row) throw new Error("Project has no reserved app address");
      if (publicAccess && row.privateOnly && !allowed)
        throw new Error("This owner's apps require a private link");
      // A limited user who keeps an app public retains the superuser's
      // choice; turning public access off discards it.
      row.superuserPublic =
        publicAccess && (superuser || (row.public && row.superuserPublic));
      row.serving = serving;
      row.public = publicAccess;
      return structuredClone(row);
    });
  }

  async close(): Promise<void> {
    await this.ready;
    await this.writing;
  }

  release(
    projectId: string,
    namespace: string,
    authorize: () => Promise<void>,
  ): Promise<void> {
    return this.change(async (state) => {
      await authorize();
      state.reservations = state.reservations.filter(
        (row) => row.projectId !== projectId || row.namespace !== namespace,
      );
    });
  }

  /** Revoke and release every address, retaining project history and visibility. */
  releaseAll(
    projectId: string,
    beforeRelease: (rows: ProjectAppReservation[]) => Promise<void>,
  ): Promise<void> {
    return this.change(async (state) => {
      await beforeRelease(
        state.reservations.filter((row) => row.projectId === projectId),
      );
      state.reservations = state.reservations.filter(
        (row) => row.projectId !== projectId,
      );
    });
  }
}
