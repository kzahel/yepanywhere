import { useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "../components/ui/Button";
import { TextInput } from "../components/ui/Field";
import {
  type FileChangeEvent,
  type FileType,
  useFileActivity,
} from "../hooks/useFileActivity";
import { useI18n } from "../i18n";

function formatTime(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString();
}

function formatDate(timestamp: string): string {
  return new Date(timestamp).toLocaleDateString();
}

function getTypeIcon(type: FileChangeEvent["changeType"]): string {
  switch (type) {
    case "create":
      return "+";
    case "modify":
      return "~";
    case "delete":
      return "-";
  }
}

function getTypeColor(type: FileChangeEvent["changeType"]): string {
  switch (type) {
    case "create":
      return "#4f4";
    case "modify":
      return "#ff4";
    case "delete":
      return "#f44";
  }
}

function getTypeLabel(
  type: FileChangeEvent["changeType"],
  t: (key: never) => string,
): string {
  switch (type) {
    case "create":
      return t("activityTypeCreated" as never);
    case "modify":
      return t("activityTypeModified" as never);
    case "delete":
      return t("activityTypeDeleted" as never);
  }
}

function getFileTypeLabel(
  fileType: FileType,
  t: (key: never) => string,
): string {
  switch (fileType) {
    case "session":
      return t("activityFileTypeSession" as never);
    case "agent-session":
      return t("activityFileTypeAgentSession" as never);
    case "settings":
      return t("activityFileTypeSettings" as never);
    case "credentials":
      return t("activityFileTypeCredentials" as never);
    case "telemetry":
      return t("activityFileTypeTelemetry" as never);
    case "other":
      return t("activityFileTypeOther" as never);
  }
}

const FILE_TYPE_OPTIONS: FileType[] = [
  "session",
  "agent-session",
  "settings",
  "credentials",
  "telemetry",
  "other",
];

export function ActivityPage() {
  const { t } = useI18n();
  const [pathFilter, setPathFilter] = useState("");
  const [typeFilters, setTypeFilters] = useState<Set<FileType>>(new Set());
  const { events, connected, paused, clearEvents, togglePause } =
    useFileActivity({ bufferEvents: true });

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);

  // Apply filters
  let filteredEvents = events;

  if (pathFilter) {
    const regex = new RegExp(pathFilter, "i");
    filteredEvents = filteredEvents.filter((e) => regex.test(e.relativePath));
  }

  if (typeFilters.size > 0) {
    filteredEvents = filteredEvents.filter((e) => typeFilters.has(e.fileType));
  }

  // Reverse for chronological order (oldest at top, newest at bottom)
  const displayedEvents = [...filteredEvents].reverse();

  const toggleTypeFilter = (type: FileType) => {
    setTypeFilters((prev) => {
      const next = new Set(prev);
      if (next.has(type)) {
        next.delete(type);
      } else {
        next.add(type);
      }
      return next;
    });
  };

  // Track scroll position to know if we should auto-scroll
  const handleScroll = () => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const threshold = 20;
    isAtBottomRef.current =
      container.scrollHeight - container.scrollTop - container.clientHeight <
      threshold;
  };

  // Auto-scroll to bottom when new events arrive (if already at bottom)
  useLayoutEffect(() => {
    void displayedEvents.length;
    const container = scrollContainerRef.current;
    if (container && isAtBottomRef.current) {
      container.scrollTop = container.scrollHeight;
    }
  }, [displayedEvents.length]);

  // Group events by date
  const eventsByDate = displayedEvents.reduce(
    (acc, event) => {
      const date = formatDate(event.timestamp);
      if (!acc[date]) {
        acc[date] = [];
      }
      acc[date].push(event);
      return acc;
    },
    {} as Record<string, FileChangeEvent[]>,
  );

  return (
    <div
      className="page"
      style={{
        maxWidth: "1000px",
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <nav className="breadcrumb">
        <Link to="/projects">{t("pageTitleProjects")}</Link> /{" "}
        {t("activityBreadcrumb" as never)}
      </nav>

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <h1>{t("activityTitle" as never)}</h1>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: "var(--radius-full)",
              background: connected ? "#4f4" : "#f44",
            }}
          />
          <span style={{ fontSize: "var(--font-size-lg)", color: "#888" }}>
            {connected
              ? t("activityConnected" as never)
              : t("activityDisconnected" as never)}
          </span>
        </div>
      </div>

      {/* Controls */}
      <div
        style={{
          display: "flex",
          gap: "1rem",
          marginBottom: "1rem",
          flexWrap: "wrap",
        }}
      >
        <TextInput
          type="text"
          value={pathFilter}
          onChange={(e) => setPathFilter(e.target.value)}
          placeholder={t("activityPathPlaceholder" as never)}
          aria-label={t("activityPathPlaceholder" as never)}
          style={{ flex: 1, minWidth: "200px" }}
        />
        <Button variant="ghost" aria-pressed={paused} onClick={togglePause}>
          {paused ? t("activityResume" as never) : t("activityPause" as never)}
        </Button>
        <Button onClick={clearEvents}>{t("activityClear" as never)}</Button>
      </div>

      {/* Type filters */}
      <div
        style={{
          display: "flex",
          gap: "0.5rem",
          marginBottom: "1rem",
          flexWrap: "wrap",
        }}
      >
        {FILE_TYPE_OPTIONS.map((type) => (
          <Button
            key={type}
            variant="ghost"
            size="small"
            aria-pressed={typeFilters.has(type)}
            onClick={() => toggleTypeFilter(type)}
          >
            {getFileTypeLabel(type, t)}
          </Button>
        ))}
        {typeFilters.size > 0 && (
          <Button size="small" onClick={() => setTypeFilters(new Set())}>
            {t("activityClearFilters" as never)}
          </Button>
        )}
      </div>

      {/* Stats */}
      <div
        style={{
          display: "flex",
          gap: "2rem",
          marginBottom: "1rem",
          fontSize: "var(--font-size-lg)",
          color: "#888",
        }}
      >
        <span>{t("activityTotal" as never, { count: events.length })}</span>
        <span>
          {t("activityShowing" as never, { count: displayedEvents.length })}
        </span>
      </div>

      {/* Events - scrollable container */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        style={{
          flex: 1,
          overflow: "auto",
          minHeight: 0,
          background: "#1a1a1a",
          borderRadius: "var(--radius-lg)",
          padding: "1rem",
        }}
      >
        {Object.entries(eventsByDate).length === 0 ? (
          <div style={{ textAlign: "center", padding: "3rem", color: "#888" }}>
            {events.length === 0
              ? t("activityWaiting" as never)
              : t("activityNoMatches" as never)}
          </div>
        ) : (
          Object.entries(eventsByDate).map(([date, dateEvents]) => (
            <div key={date} style={{ marginBottom: "1.5rem" }}>
              <h3
                style={{
                  color: "#888",
                  fontSize: "var(--font-size-lg)",
                  marginBottom: "0.5rem",
                }}
              >
                {date}
              </h3>
              <div
                style={{
                  background: "#2a2a2a",
                  borderRadius: "var(--radius-lg)",
                  overflow: "hidden",
                }}
              >
                {dateEvents.map((event, i) => (
                  <div
                    key={`${event.timestamp}-${event.path}-${i}`}
                    style={{
                      padding: "0.75rem 1rem",
                      borderBottom:
                        i < dateEvents.length - 1 ? "1px solid #333" : "none",
                      display: "grid",
                      gridTemplateColumns: "80px 24px 100px 1fr",
                      gap: "0.75rem",
                      alignItems: "center",
                      fontFamily: "monospace",
                      fontSize: "var(--font-size-lg)",
                    }}
                  >
                    <span style={{ color: "#666" }}>
                      {formatTime(event.timestamp)}
                    </span>
                    <span
                      style={{
                        color: getTypeColor(event.changeType),
                        fontWeight: "bold",
                        textAlign: "center",
                      }}
                      title={getTypeLabel(event.changeType, t)}
                    >
                      {getTypeIcon(event.changeType)}
                    </span>
                    <span
                      style={{
                        color: "#888",
                        fontSize: "var(--font-size-sm)",
                        background: "#333",
                        padding: "0.25rem 0.5rem",
                        borderRadius: "var(--radius-sm)",
                        textAlign: "center",
                      }}
                    >
                      {getFileTypeLabel(event.fileType, t)}
                    </span>
                    <span
                      style={{
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      title={event.path}
                    >
                      {event.relativePath}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
