/**
 * Legacy → shared mapping for the button and switch census.
 *
 * Status: button rows complete (2026-11-08): every global and CSS Module
 * button class the census finds has a row. The maintainer skims the census
 * pages and edits rows; plan 182's swap batches follow this table, not the
 * other way round. A class the census finds that no row names appears
 * under "Unmapped" until someone assigns it.
 *
 * `classes` is the exact class list a legacy element carries, so compound
 * variants (`settings-button settings-button-danger`) render as they do in
 * the app. `counted` names the class whose use count represents the row.
 */
import type { ButtonVariant } from "../../src/components/ui/Button";

/**
 * Where a legacy control goes:
 * - a shared variant: `Button`, or `IconButton` with `icon`;
 * - `base`: a clickable row, card, chip or disclosure that keeps its owner's
 *   styles on `ButtonBase`;
 * - `menu`, `tab`, `segmented`, `switch`: a later control family;
 * - `composer`: the session composer's and new-session form's controls,
 *   excluded until their own pass;
 * - `dead`: no production use; its rules are deleted;
 * - `not-a-button`: named like a button but styles something else (a
 *   `:global()` reference, a wrapper, or a name only in a comment).
 */
export type ButtonDisposition =
  | ButtonVariant
  | "base"
  | "menu"
  | "tab"
  | "segmented"
  | "switch"
  | "composer"
  | "dead"
  | "not-a-button";

export const BUTTON_DISPOSITIONS: readonly ButtonDisposition[] = [
  "primary",
  "secondary",
  "outline",
  "ghost",
  "danger",
  "danger-outline",
  "base",
  "menu",
  "tab",
  "segmented",
  "switch",
  "composer",
  "dead",
  "not-a-button",
];

export interface LegacyButton {
  classes: string;
  counted: string;
  to: ButtonDisposition;
  small?: boolean;
  icon?: boolean;
  note?: string;
}

/** A button class declared in a CSS Module, keyed by module and name. */
export interface ModuleButton {
  /** The module, relative to packages/client/src. */
  file: string;
  name: string;
  to: ButtonDisposition;
  small?: boolean;
  icon?: boolean;
  note?: string;
}

export const LEGACY_BUTTONS: readonly LegacyButton[] = [
  {
    classes: "modal-close",
    counted: "modal-close",
    to: "ghost",
    small: true,
    icon: true,
    note: "Shared ghost IconButton close/minimize actions; the legacy class now owns flex placement only.",
  },
  {
    classes: "btn-primary",
    counted: "btn-primary",
    to: "primary",
    note: "Brand green; the onboarding and host-offline call to action.",
  },
  {
    classes: "login-button",
    counted: "login-button",
    to: "primary",
    note: "Same green, larger padding and base font size.",
  },
  {
    classes: "settings-button",
    counted: "settings-button",
    to: "secondary",
    note: "The most used button in the app; the secondary geometry comes from it.",
  },
  {
    classes: "btn-secondary",
    counted: "btn-secondary",
    to: "secondary",
    note: "No border and a larger radius than settings-button.",
  },
  {
    classes: "copy-button",
    counted: "copy-button",
    to: "ghost",
    small: true,
    icon: true,
    note: "CopyButton: a small IconButton.",
  },
  {
    classes: "session-share-icon-button",
    counted: "session-share-icon-button",
    to: "secondary",
    small: true,
    note: "Named an icon button but carries text.",
  },
  {
    classes: "settings-button settings-button-secondary",
    counted: "settings-button-secondary",
    to: "secondary",
    note: "Transparent with a border; an ordinary action, so secondary under the variant rule.",
  },
  {
    classes: "expand-button",
    counted: "expand-button",
    to: "ghost",
    small: true,
    note: "An inline text action (show more), so ghost small; it had a 44 px touch height of its own.",
  },
  {
    classes: "diff-toolbar-icon-button",
    counted: "diff-toolbar-icon-button",
    to: "ghost",
    small: true,
    icon: true,
  },
  {
    classes: "settings-button settings-button-danger",
    counted: "settings-button-danger",
    to: "danger",
  },
  {
    classes: "settings-button settings-button-danger-subtle",
    counted: "settings-button-danger-subtle",
    to: "danger-outline",
  },
  {
    classes: "send-button",
    counted: "send-button",
    to: "composer",
    icon: true,
  },
  {
    classes: "toolbar-button",
    counted: "toolbar-button",
    to: "composer",
    icon: true,
  },
  {
    classes: "new-session-submit-button",
    counted: "new-session-submit-button",
    to: "composer",
  },
  {
    classes: "settings-button model-switch-action-button",
    counted: "model-switch-action-button",
    to: "secondary",
    note: "Modal choice buttons (ModelSwitchModal, LongContextEffortWarningModal); keep column layout, min-width 13rem, mobile width 100%; Save could be primary.",
  },
  {
    classes: "file-link-button",
    counted: "file-link-button",
    to: "outline",
    note: "Shared wrapping, monospaced file actions (Read/ViewImage/WriteStdin); inline summaries use link. Line-count children remain subordinate.",
  },
  {
    classes: "toggle-btn",
    counted: "toggle-btn",
    to: "segmented",
    note: "Source/Preview two-option toggle in Read/WriteRenderer; depends on .markdown-view-toggle parent and first/last-child radii.",
  },
  {
    classes: "conversation-view-toolbar-button",
    counted: "conversation-view-toolbar-button",
    to: "composer",
    note: "MessageInputToolbar control; also PublicSharePage floating toggle (aria-pressed) that would need an outline IconButton later.",
  },
  {
    classes: "session-title-edit-button",
    counted: "session-title-edit-button",
    to: "ghost",
    small: true,
    icon: true,
    note: "22px save/cancel/accept icons in SessionHeader title editor; shares rule with title triggers; retitle-accept is-armed state.",
  },
  {
    classes: "attach-button",
    counted: "attach-button",
    to: "composer",
    note: "Attachment control in MessageInputToolbar (inline and overflow-menu tiers).",
  },
  {
    classes: "btw-toolbar-button",
    counted: "btw-toolbar-button",
    to: "composer",
    note: "BTW aside toolbar button in MessageInputToolbar.",
  },
  {
    classes: "commit-jump-btn",
    counted: "commit-jump-btn",
    to: "secondary",
    small: true,
    note: "Newer/older commit arrows in CommitBrowser; glyph on desktop, text label on touch via media query.",
  },
  {
    classes: "fixed-font-render-toggle__button",
    counted: "fixed-font-render-toggle__button",
    to: "outline",
    small: true,
    icon: true,
    note: "Elevated dense source/rendered IconButton (FixedFontMathToggle, ReadRenderer); module owns absolute placement and hover/focus reveal, including touch.",
  },
  {
    classes: "git-status-action-button",
    counted: "git-status-action-button",
    to: "secondary",
    small: true,
    note: "GitStatusPage action/pause buttons; keep indicator child and tone/running state classes, aria-pressed pause.",
  },
  {
    classes: "inbox-refresh-button",
    counted: "inbox-refresh-button",
    to: "secondary",
    note: "Icon+text Refresh (InboxContent) and Add project (ProjectsPage); muted text; spinner class in InboxContent.module.css.",
  },
  {
    classes:
      "send-button project-queue-button new-session-project-queue-button",
    counted: "project-queue-button",
    to: "composer",
    note: "Queue-to-project submit in NewSessionForm and MessageInputToolbar.",
  },
  {
    classes:
      "message-input-keyboard-action message-input-keyboard-secondary project-queue-mode project-queue-new-session-button",
    counted: "project-queue-new-session-button",
    to: "composer",
    note: "Composer keyboard/toolbar action in MessageInput and MessageInputToolbar.",
  },
  {
    classes: "project-selector-button",
    counted: "project-selector-button",
    to: "base",
    note: "Inline header listbox trigger in ProjectSelector; literal kept for .source-header-identity rules and style test.",
  },
  {
    classes: "render-mode-toolbar-button",
    counted: "render-mode-toolbar-button",
    to: "composer",
    note: "Render-mode toggle in MessageInputToolbar; shares rule with conversation-view-toolbar-button.",
  },
  {
    classes: "session-share-small-button",
    counted: "session-share-small-button",
    to: "secondary",
    small: true,
    note: "Manage session / Freeze live buttons in SessionShareModal; shares rule with session-share-icon-button.",
  },
  {
    classes: "session-shortcuts-help-button",
    counted: "session-shortcuts-help-button",
    to: "composer",
    note: "Keyboard-shortcuts help button in MessageInputToolbar.",
  },
  {
    classes: "show-more-btn",
    counted: "show-more-btn",
    to: "ghost",
    small: true,
    note: "Show more/less under truncated user prompt (UserPromptBlock); keep right alignment (margin-left auto, block).",
  },
  {
    classes: "timeline-dot-btn",
    counted: "timeline-dot-btn",
    to: "base",
    note: "Invisible absolute overlay on timeline dot in ExploredToolGroup; ThinkingBlock uses it on a span, not a button.",
  },
  {
    classes: "voice-input-button",
    counted: "voice-input-button",
    to: "composer",
    note: "Voice input control (VoiceInputButton, MessageInputToolbar).",
  },
  {
    classes: "composer-bottom-overflow-button",
    counted: "composer-bottom-overflow-button",
    to: "composer",
    note: "Composer bottom overflow-menu trigger in MessageInputToolbar.",
  },
  {
    classes: "diff-copy-button",
    counted: "diff-copy-button",
    to: "outline",
    small: true,
    icon: true,
    note: "Floating round copy icon in EditRenderer; keep absolute top-right, z-index, hover-reveal via .diff-view-container.",
  },
  {
    classes: "file-viewer-download-btn",
    counted: "file-viewer-download-btn",
    to: "primary",
    note: "Download file CTA in FileViewer's binary/unsupported view; currently blue --primary-color fill.",
  },
  {
    classes: "load-older-button",
    counted: "load-older-button",
    to: "secondary",
    small: true,
    note: "Load older messages pill in MessageList with a spinner; secondary small matches its filled, bordered look.",
  },
  {
    classes: "mode-button",
    counted: "mode-button",
    to: "composer",
    note: "Permission mode selector trigger in ModeSelector.",
  },
  {
    classes:
      "send-button project-queue-button new-session-project-queue-button",
    counted: "new-session-project-queue-button",
    to: "composer",
    note: "New-session form's queue-to-project submit in NewSessionForm.",
  },
  {
    classes: "provider-badge-button",
    counted: "provider-badge-button",
    to: "base",
    note: "Unstyled wrapper around provider badge opening ModelSwitchModal (SessionHeader); keep translateY(-1px), hover opacity.",
  },
  {
    classes: "qr-toggle-button",
    counted: "qr-toggle-button",
    to: "secondary",
    note: "Show/Hide QR code toggle in RemoteAccessSetup.",
  },
  {
    classes: "send-button queue-button",
    counted: "queue-button",
    to: "composer",
    note: "Queue message button in MessageInputToolbar.",
  },
  {
    classes: "revoke-all-button",
    counted: "revoke-all-button",
    to: "danger-outline",
    small: true,
    note: "Revoke all remote sessions in RemoteAccessSetup sessions header.",
  },
  {
    classes: "revoke-button",
    counted: "revoke-button",
    to: "danger-outline",
    small: true,
    note: "Per-session revoke in RemoteAccessSetup session list.",
  },
  {
    classes: "session-share-icon-button session-share-icon-button-danger",
    counted: "session-share-icon-button-danger",
    to: "danger-outline",
    small: true,
    icon: true,
    note: "Disconnect viewer icon in SessionShareModal viewer list; text glyph content, 28px square.",
  },
  {
    classes: "session-share-revoke-button",
    counted: "session-share-revoke-button",
    to: "danger-outline",
    small: true,
    note: "Revoke all shares in SessionShareModal global controls.",
  },
  {
    classes: "slash-command-button",
    counted: "slash-command-button",
    to: "composer",
    note: "Slash command menu trigger in SlashCommandButton.",
  },
  {
    classes: "stop-button",
    counted: "stop-button",
    to: "composer",
    note: "Stop generation button in MessageInputToolbar.",
  },
  {
    classes: "thinking-toggle-button",
    counted: "thinking-toggle-button",
    to: "composer",
    note: "Thinking mode toggle in ThinkingToolbarControl.",
  },
  {
    classes: "filter-clear-button",
    counted: "filter-clear-button",
    to: "dead",
    note: "No TS/TSX use anywhere (grep incl. templates); delete index.css rules incl. mobile media rule.",
  },
  {
    classes: "filter-search-button",
    counted: "filter-search-button",
    to: "dead",
    note: "No TS/TSX use anywhere; delete index.css rules.",
  },
  {
    classes: "global-sessions-load-more-button",
    counted: "global-sessions-load-more-button",
    to: "dead",
    note: "No TS/TSX use anywhere; delete index.css rules.",
  },
  {
    classes: "global-sessions-project-cta__button",
    counted: "global-sessions-project-cta__button",
    to: "dead",
    note: "No use; GlobalSessionsPage uses sibling cta/__token only; delete rule and mobile media rule.",
  },
];

export const MODULE_BUTTONS: readonly ModuleButton[] = [
  {
    file: "components/BulkActionBar.module.css",
    name: "actionButton",
    to: "secondary",
    note: "Bulk-action icon+label buttons; keep column layout on narrow, row in filtered bar, 22px icons.",
  },
  {
    file: "components/BulkActionBar.module.css",
    name: "actionButtonPrimary",
    to: "primary",
    note: "Select-all-filtered CTA modifier in the filtered bar.",
  },
  {
    file: "components/CompactResumeButton.module.css",
    name: "button",
    to: "outline",
    small: true,
    note: "Compact Resume action in a row; keep flex:0 0 auto, align-self:center, stopPropagation.",
  },
  {
    file: "components/EmulatorNavButtons.module.css",
    name: "button",
    to: "outline",
    icon: true,
    note: "Emulator Back/Home/Recents nav; 48px circle size and shape must be preserved.",
  },
  {
    file: "components/FileViewer.module.css",
    name: "backButton",
    to: "ghost",
    icon: true,
    note: "Header back arrow, layout over global file-viewer-action; 24px square, flex:0 0 auto.",
  },
  {
    file: "components/FileViewer.module.css",
    name: "fullscreenButton",
    to: "ghost",
    icon: true,
    note: "Fullscreen toggle, layout over global file-viewer-action; only flex:0 0 auto.",
  },
  {
    file: "components/FileViewerDensityControls.module.css",
    name: "button",
    to: "ghost",
    small: true,
    icon: true,
    note: "Markdown zoom in/out letter glyphs over file-viewer-action; 28px fixed width in group.",
  },
  {
    file: "components/FilterDropdown.module.css",
    name: "button",
    to: "secondary",
    note: "Filter dropdown trigger; keep chip (transparent), hasSelection green border, fullWidth modifiers.",
  },
  {
    file: "components/GoalPanel.module.css",
    name: "button",
    to: "secondary",
    note: "Goal panel Cancel/Edit/Clear actions; 44px min-height touch size.",
  },
  {
    file: "components/GoalPanel.module.css",
    name: "iconButton",
    to: "ghost",
    icon: true,
    note: "Header copy (CopyTextButton className) and close \u00d7; 40px min, 22px glyph.",
  },
  {
    file: "components/ImageViewer.module.css",
    name: "navigationButton",
    to: "secondary",
    icon: true,
    note: "Prev/next overlay arrows; preserve absolute centering, circle, translucent fill, hidden pointer-events.",
  },
  {
    file: "components/InboxContent.module.css",
    name: "inbox-refresh-button",
    to: "not-a-button",
    note: "Only named in a comment; the global class stays, module rule is .refreshSpinner.",
  },
  {
    file: "components/LocalMediaModal.module.css",
    name: "inlineImageButton",
    to: "base",
    note: "Zoom-in inline image thumbnail frame; passed via inlinePreviewClass map.",
  },
  {
    file: "components/MessageInputToolbar.module.css",
    name: "attach-button",
    to: "composer",
    note: "Only a :global(.message-input-left .attach-button) waveform-backdrop reference.",
  },
  {
    file: "components/MessageInputToolbar.module.css",
    name: "browserDebugButton",
    to: "composer",
    note: "Composer toolbar browser-debug control, inline and overflow tiers.",
  },
  {
    file: "components/MessageInputToolbar.module.css",
    name: "browserDebugButtonActive",
    to: "composer",
    note: "Active (red) modifier of the browser-debug toolbar control.",
  },
  {
    file: "components/MessageInputToolbar.module.css",
    name: "conversation-view-toolbar-button",
    to: "composer",
    note: "Only a :global() waveform-backdrop reference to the legacy toolbar class.",
  },
  {
    file: "components/MessageInputToolbar.module.css",
    name: "doneButton",
    to: "composer",
    note: "Synthetic Done toolbar control, inline and overflow menuitem.",
  },
  {
    file: "components/MessageInputToolbar.module.css",
    name: "mode-button",
    to: "composer",
    note: "Only a :global() waveform-backdrop reference to the legacy mode button.",
  },
  {
    file: "components/MessageInputToolbar.module.css",
    name: "render-mode-toolbar-button",
    to: "composer",
    note: "Only a :global() waveform-backdrop reference to the render-mode toggle.",
  },
  {
    file: "components/MessageInputToolbar.module.css",
    name: "slash-command-button",
    to: "composer",
    note: "Only a :global() waveform-backdrop reference to the slash-command button.",
  },
  {
    file: "components/MessageInputToolbar.module.css",
    name: "thinking-toggle-button",
    to: "composer",
    note: "Only a :global() waveform-backdrop reference to the thinking toggle.",
  },
  {
    file: "components/MessageInputToolbar.module.css",
    name: "transcriptSearchButton",
    to: "composer",
    note: "Composer transcript-search toolbar control, inline and overflow tiers.",
  },
  {
    file: "components/MessageInputToolbar.module.css",
    name: "voice-input-button",
    to: "composer",
    note: "Only a :global() waveform-backdrop reference to the voice button.",
  },
  {
    file: "components/NewSessionProjectQueue.module.css",
    name: "itemButton",
    to: "base",
    note: "Queue item card (grid, colored left border) opening the item.",
  },
  {
    file: "components/ProjectCaptionEditor.module.css",
    name: "editButton",
    to: "ghost",
    small: true,
    icon: true,
    note: "Caption edit pencil; 1.25rem wide, one caption line tall to align with first line.",
  },
  {
    file: "components/ProjectQueueSection.module.css",
    name: "dispatchButton",
    to: "outline",
    small: true,
    note: "Queue Pause/Resume toggle tinted with queue action color; min-width 72px.",
  },
  {
    file: "components/ProjectSelector.module.css",
    name: "button",
    to: "base",
    note: "Project listbox trigger in header identity row; truncation is style-tested, keep negative margin.",
  },
  {
    file: "components/PublicFileShareModal.module.css",
    name: "createButton",
    to: "primary",
    note: "Icon+label create/copy share CTA over global settings-button-primary.",
  },
  {
    file: "components/PublicShareInventory.module.css",
    name: "iconButton",
    to: "outline",
    small: true,
    icon: true,
    note: "Share row copy action; 30px bordered icon button.",
  },
  {
    file: "components/PublicShareInventory.module.css",
    name: "iconButtonDanger",
    to: "danger-outline",
    small: true,
    icon: true,
    note: "Share row revoke beside copy and freeze: a destructive secondary action.",
  },
  {
    file: "components/PublicShareInventory.module.css",
    name: "iconButtonFreeze",
    to: "secondary",
    small: true,
    icon: true,
    note: "Share row freeze modifier; amber attention fill has no shared variant.",
  },
  {
    file: "components/QuestionAnswerPanel.module.css",
    name: "btn",
    to: "secondary",
    note: "Base of deny(outline)/next(secondary)/submit(primary); keep flex:1, min-width, kbd hint chip.",
  },
  {
    file: "components/ReloadBanner.module.css",
    name: "button",
    to: "secondary",
    note: "Reload banner actions and dismiss \u00d7; translucent-white on warning banner, 36px tall.",
  },
  {
    file: "components/ReloadBanner.module.css",
    name: "buttonDanger",
    to: "danger",
    note: "Warning-state modifier on the immediate reload button (currently black fill).",
  },
  {
    file: "components/ReloadBanner.module.css",
    name: "buttonPrimary",
    to: "primary",
    note: "Immediate reload CTA; currently black fill with warning/error text, min-width 62px.",
  },
  {
    file: "components/ReloadBanner.module.css",
    name: "buttonSafe",
    to: "secondary",
    note: "Restart-when-safe action modifier; min-width 78px on narrow.",
  },
  {
    file: "components/RemoteCompatibilityNotices.module.css",
    name: "button",
    to: "secondary",
    small: true,
    note: "Notice Dismiss/Remind actions; also styles an <a> action link.",
  },
  {
    file: "components/RemoteCompatibilityNotices.module.css",
    name: "buttonPrimary",
    to: "primary",
    small: true,
    note: "Notice primary action modifier on <a> link and Show reminder button.",
  },
  {
    file: "components/RemoteCompatibilityNotices.module.css",
    name: "copyButton",
    to: "outline",
    small: true,
    icon: true,
    note: "CopyTextButton attached to command field; keep no left border, right-only radius.",
  },
  {
    file: "components/RenderItemComponent.module.css",
    name: "rewoundGroupToggleButton",
    to: "base",
    note: "Rewound-group disclosure header toggle with aria-expanded.",
  },
  {
    file: "components/SessionHeader.module.css",
    name: "modelButton",
    to: "base",
    note: "Provider/model badge chip (global provider-badge-button); max-width 14rem/8rem narrow.",
  },
  {
    file: "components/SessionHeader.module.css",
    name: "projectAppButton",
    to: "ghost",
    icon: true,
    note: "Header project-app toggle with aria-pressed and press handlers; flex-shrink 0.",
  },
  {
    file: "components/SessionMenu.module.css",
    name: "terminateButton",
    to: "menu",
    note: "Destructive Terminate item in the session dropdown menu.",
  },
  {
    file: "components/SessionRelationshipsSection.module.css",
    name: "button",
    to: "secondary",
    note: "Relationships Refresh/Previous/Next; 36px min, 44px on touch.",
  },
  {
    file: "components/SessionShareModal.module.css",
    name: "addButton",
    to: "primary",
    small: true,
    icon: true,
    note: "Per-type create share plus icon in manager; 30px, stretches row height.",
  },
  {
    file: "components/SessionShareModal.module.css",
    name: "filterButton",
    to: "base",
    note: "Manager sidebar scope/mode filter row with icon chip, aria-pressed; unsure vs segmented.",
  },
  {
    file: "components/SessionShareModal.module.css",
    name: "filterButtonActive",
    to: "base",
    note: "Selected-state modifier of the manager filter row (green border, tinted icon).",
  },
  {
    file: "components/SessionShareModal.module.css",
    name: "freezeTypeButton",
    to: "secondary",
    small: true,
    icon: true,
    note: "Per-type freeze/confirm icon; amber attention fill has no shared variant.",
  },
  {
    file: "components/SessionShareModal.module.css",
    name: "revokeTypeButton",
    to: "danger-outline",
    small: true,
    icon: true,
    note: "Per-scope/type revoke/confirm icon beside other actions; stretches row height.",
  },
  {
    file: "components/SessionShareModal.module.css",
    name: "settings-button",
    to: "not-a-button",
    note: ":global(.settings-button) narrow-layout override inside managerSidebar.",
  },
  {
    file: "components/SourceFileOutline.module.css",
    name: "groupButton",
    to: "base",
    note: "Outline group disclosure row (full-width list item, aria-expanded).",
  },
  {
    file: "components/SourceFileOutline.module.css",
    name: "sectionDividerButton",
    to: "base",
    note: "Clickable section divider disclosure combined with sectionDivider.",
  },
  {
    file: "components/ViewerCountIndicator.module.css",
    name: "button",
    to: "base",
    note: "Interactive modifier of the viewer-count chip (.root keeps its look).",
  },
  {
    file: "components/VoiceInputButton.module.css",
    name: "button",
    to: "composer",
    note: "Composer voice input button with waveform/capture states.",
  },
  {
    file: "components/blocks/ToolResultMediaRows.module.css",
    name: "imageButton",
    to: "base",
    note: "Zoom-in tool media thumbnail; class also applied to a <video>.",
  },
  {
    file: "components/renderers/tools/GrepRenderer.module.css",
    name: "matchCountButton",
    to: "base",
    note: "Link-styled match count opening the results modal.",
  },
  {
    file: "components/renderers/tools/ReadRenderer.module.css",
    name: "imagePreviewButton",
    to: "base",
    note: "Zoom-in image preview frame in Read tool output.",
  },
  {
    file: "components/renderers/tools/TaskRenderer.module.css",
    name: "expandButton",
    to: "base",
    note: "Task/spawn-agent header disclosure (global task-inline-header); also on a non-button div.",
  },
  {
    file: "components/ui/SelectionActionCluster.module.css",
    name: "button",
    to: "base",
    note: "Floating round per-kind colored selection action glyphs; also a span specimen. Unsure vs IconButton.",
  },
  {
    file: "extension/sidepanel/SidePanel.module.css",
    name: "iconButton",
    to: "ghost",
    icon: true,
    note: "Extension side panel open-app/refresh/options icons; 30px.",
  },
  {
    file: "hooks/useMessageListIsearch.module.css",
    name: "olderButton",
    to: "ghost",
    small: true,
    note: "Isearch 'search older' action; fixed 5.75rem width, preventDefault on mousedown.",
  },
  {
    file: "pages/AgentsPage.module.css",
    name: "killButton",
    to: "danger-outline",
    small: true,
    note: "Kill action inside a card Link; margin-left auto, stops propagation.",
  },
  {
    file: "pages/BlameView.module.css",
    name: "copy-button",
    to: "not-a-button",
    note: "Only named in a comment about the global .copy-button; rule is .pathCopy.",
  },
  {
    file: "pages/EmulatorPage.module.css",
    name: "btn",
    to: "secondary",
    note: "Base of emulator Connect/Stop/Start/Back/Download buttons.",
  },
  {
    file: "pages/EmulatorPage.module.css",
    name: "btnPrimary",
    to: "primary",
    note: "Emulator Connect and Download CTA modifier.",
  },
  {
    file: "pages/EmulatorPage.module.css",
    name: "btnSecondary",
    to: "secondary",
    note: "Emulator Stop/Start/Back/keyboard modifier.",
  },
  {
    file: "pages/IssuesPage.module.css",
    name: "button",
    to: "secondary",
    note: "Issue form submit/cancel and paging; 44px min-height.",
  },
  {
    file: "pages/IssuesPage.module.css",
    name: "iconButton",
    to: "ghost",
    icon: true,
    note: "Issue item/association menu triggers and close \u00d7; 36/44px.",
  },
  {
    file: "pages/IssuesPage.module.css",
    name: "textButton",
    to: "ghost",
    small: true,
    note: "Link-colored show/more evidence text actions.",
  },
  {
    file: "pages/NewSessionPage.module.css",
    name: "appButton",
    to: "secondary",
    note: "Project app toggle over global btn-secondary; aria-pressed green highlight, 36px.",
  },
  {
    file: "pages/RepoStatusBar.module.css",
    name: "copy-button",
    to: "not-a-button",
    note: "Only named in a comment about the global CopyButton class.",
  },
  {
    file: "pages/RepoStatusBar.module.css",
    name: "copyButton",
    to: "ghost",
    small: true,
    icon: true,
    note: "Compact branch/hash CopyButton in repo status bar (className pass-through).",
  },
  {
    file: "pages/RepoStatusBar.module.css",
    name: "upstreamButton",
    to: "base",
    note: "Link-like upstream label opening incoming commits; combines .upstream.",
  },
  {
    file: "pages/ReviewSubmissionsPanel.module.css",
    name: "submissionButton",
    to: "base",
    note: "Submission list item with active state and ellipsized label.",
  },
  {
    file: "pages/settings/ArtifactSettings.module.css",
    name: "accessButton",
    to: "outline",
    small: true,
    note: "Table-cell access label selecting the row; keep max-width and ellipsis. Unsure.",
  },
  {
    file: "pages/settings/CacheMissEventTable.module.css",
    name: "groupButton",
    to: "base",
    note: "Table row-group disclosure header with aria-expanded.",
  },
  {
    file: "pages/settings/LocalAccessSettings.module.css",
    name: "customFoldersButton",
    to: "secondary",
    note: "Save custom folders over global settings-button; flex 0 0 7rem, full width narrow.",
  },
  {
    file: "pages/settings/SettingsTableSort.module.css",
    name: "button",
    to: "base",
    note: "Sortable table column header button filling the th.",
  },
];

/** Global classes that are button parts or containers, not buttons. */
export function isButtonClass(name: string): boolean {
  return (
    /(?:^|[-_])(?:button|btn)(?:$|[-_])|(?:button|btn)$/i.test(name) &&
    !/(?:-|__)(?:label|icon|text|group|row|wrap|wrapper|container|list|actions|bar|buttons|area|slot|main|detail|badge)$/i.test(
      name,
    )
  );
}

export type SwitchDisposition = "switch" | "segmented" | "keep";

export interface LegacySwitch {
  name: string;
  /** Class whose use count represents the row, when it is a global class. */
  counted?: string;
  /**
   * Every global class the row covers. The ban (pnpm buttons:check) rejects
   * each one once no global stylesheet styles it.
   */
  classes?: string;
  to: SwitchDisposition;
  note?: string;
}

export const LEGACY_SWITCHES: readonly LegacySwitch[] = [
  {
    name: "toggle-switch + toggle-slider",
    counted: "toggle-switch",
    classes: "toggle-switch toggle-slider",
    to: "switch",
    note: "Pasted markup: a hidden checkbox and a styled span. Became Switch, a checkbox with role=switch on the same 44×24 track.",
  },
  {
    name: "patient-queue-switch",
    counted: "patient-queue-switch",
    classes:
      "patient-queue-switch patient-queue-switch-wrap patient-queue-switch-track patient-queue-switch-thumb patient-queue-switch-option",
    to: "segmented",
    note: "A two-option track (regular / patient) with no remaining use; its rules were deleted.",
  },
  {
    name: "font-size-selector + font-size-option",
    counted: "font-size-option",
    classes: "font-size-selector font-size-option",
    to: "segmented",
    note: "The de facto segmented control; SegmentedControl keeps its look.",
  },
  {
    name: "model-settings-chip-group",
    counted: "model-settings-chip-group",
    classes: "model-settings-chip-group",
    to: "segmented",
    note: "Wrapped font-size-option buttons in model and recap settings.",
  },
  {
    name: "model-switch-chip-group + model-switch-chip",
    counted: "model-switch-chip",
    classes: "model-switch-chip-group model-switch-chip",
    to: "segmented",
  },
  {
    name: "provider-option, mode-option, new-session-helper-option",
    counted: "provider-option",
    classes:
      "provider-options provider-option provider-option-content provider-option-label provider-option-status mode-options mode-option mode-option-content mode-option-label mode-option-desc new-session-helper-options new-session-helper-option",
    to: "segmented",
    note: "Bordered option cards with a colored dot: SegmentedControl's cards look. The dots (provider-option-dot, mode-option-dot) stay as option icons.",
  },
  {
    name: "host-identity-preset",
    counted: "host-identity-preset",
    classes: "host-identity-preset",
    to: "segmented",
    note: "Icon presets: cards with icon-only options.",
  },
  {
    name: "settings-icon-style-option, output-font-option, onboarding-theme-option",
    counted: "onboarding-theme-option",
    classes:
      "settings-icon-style-option output-font-option onboarding-theme-grid onboarding-theme-option onboarding-theme-label",
    to: "segmented",
  },
  {
    name: "AttachmentQualityToggle",
    classes: "attachment-quality-toggle attachment-quality-option",
    to: "segmented",
    note: "Had no caller left; deleted with its rules.",
  },
  {
    name: "toggle-btn (Source/Preview in tool rows)",
    counted: "toggle-btn",
    classes: "toggle-btn",
    to: "segmented",
  },
  {
    name: "FullPaneComposerToggle",
    to: "keep",
    note: "An expand/collapse icon action, so it becomes an IconButton with aria-pressed, not a switch.",
  },
];

/** Global classes worth a census row: switch, toggle and option parts. */
export function isSwitchClass(name: string): boolean {
  return (
    /switch|toggle|segment|option|chip|radio/i.test(name) &&
    !/^model-switch-(?!chip)/.test(name)
  );
}

/** Where a hand-rolled menu, dropdown or popover went (plan 182, family 2). */
export type MenuDisposition = "menu" | "popover" | "keep" | "composer";

export interface LegacyMenu {
  /** The surface, as a reader knows it. */
  name: string;
  /** Owning file, relative to src/. */
  file: string;
  to: MenuDisposition;
  note?: string;
}

export const LEGACY_MENUS: readonly LegacyMenu[] = [
  {
    name: "Session menu (…)",
    file: "components/SessionMenu.tsx",
    to: "menu",
    note: "25 items, no roles, Escape or focus handling before; inline category picker with a text field.",
  },
  {
    name: "Move session to project",
    file: "components/SessionHeader.tsx",
    to: "menu",
    note: "Right-click on the project breadcrumb; global .project-reclassify-* rules deleted.",
  },
  {
    name: "Recent sessions",
    file: "components/RecentSessionsDropdown.tsx",
    to: "popover",
    note: "A list of links and the current title: a dialog, not a menu.",
  },
  {
    name: "Issues for this session",
    file: "components/SessionIssuesLink.tsx",
    to: "menu",
    note: "Rows are MenuLinkItems, so modifier clicks open tabs and keep the menu open.",
  },
  {
    name: "Fork from this turn",
    file: "components/blocks/ForkTurnMenu.tsx",
    to: "menu",
  },
  {
    name: "Turn rail notch menu",
    file: "components/UserTurnNavigator.tsx",
    to: "menu",
    note: "At the pointer: right-click or long-press.",
  },
  {
    name: "File and resource context menu",
    file: "components/FileResourceActions.tsx",
    to: "menu",
    note: "At the pointer, with a nested submenu (a drill-in on touch).",
  },
  {
    name: "Source context menu",
    file: "components/SourceContextMenu.tsx",
    to: "menu",
    note: "The controller hook keeps its gestures (long-press, Shift+F10); the view is Menu.",
  },
  { name: "Recent hosts", file: "components/SwitchHostMenu.tsx", to: "menu" },
  {
    name: "Session router account",
    file: "components/SessionRouterAccountChip.tsx",
    to: "menu",
    note: "Radio items grouped by pool.",
  },
  {
    name: "Breadcrumb folder listing",
    file: "components/FolderListPopover.tsx",
    to: "popover",
  },
  {
    name: "Async questions panel and row menu",
    file: "components/AsyncQuestionsButton.tsx",
    to: "popover",
    note: "The panel is a Popover, a row's context menu a Menu.",
  },
  {
    name: "ACLI commentary",
    file: "components/AcliCommentary.tsx",
    to: "popover",
  },
  {
    name: "Search match menu",
    file: "components/session-search/SearchPreviews.tsx",
    to: "menu",
  },
  {
    name: "Search status details",
    file: "components/session-search/SearchControls.tsx",
    to: "popover",
  },
  {
    name: "Source shortcut help",
    file: "components/SourceShortcutHelp.tsx",
    to: "popover",
  },
  { name: "Agent metrics", file: "pages/AgentsPage.tsx", to: "popover" },
  {
    name: "Delivery marker",
    file: "components/blocks/UserPromptBlock.tsx",
    to: "popover",
  },
  {
    name: "Question aside help",
    file: "components/QuestionAsideCard.tsx",
    to: "popover",
  },
  {
    name: "Filter dropdown",
    file: "components/FilterDropdown.tsx",
    to: "menu",
    note: "Checkbox items (several) or radio items (one); a bottom sheet on phones.",
  },
  {
    name: "Source control project picker",
    file: "components/ProjectSelector.tsx",
    to: "menu",
    note: "Radio items; a bottom sheet on phones.",
  },
  {
    name: "Git integration help",
    file: "pages/GitStatusPage.tsx",
    to: "popover",
  },
  {
    name: "Goal panel",
    file: "components/GoalPanel.tsx",
    to: "keep",
    note: "Already on the modal layer stack with the back gesture, a focus trap and focus return; a form, not a menu.",
  },
  {
    name: "Anchored Modal",
    file: "components/ui/Modal.tsx",
    to: "keep",
    note: "A dialog; its anchored mode now shares Popover's placement function.",
  },
  {
    name: "Session hover card",
    file: "components/SessionHoverCard.tsx",
    to: "keep",
    note: "Hover timing, pointer bands and suppression belong to the hover card.",
  },
  {
    name: "Tooltip layer",
    file: "components/ui/TooltipLayer.tsx",
    to: "keep",
    note: "Above popovers at --z-tooltip.",
  },
  {
    name: "Selection action cluster",
    file: "hooks/useSelectionActionPresentation.tsx",
    to: "keep",
    note: "A selection toolbar; its context menu is the source context menu.",
  },
  {
    name: "Model switch list",
    file: "components/ModelSwitchModal.tsx",
    to: "keep",
    note: "A listbox inside a Modal with inline save.",
  },
  {
    name: "Completion menus (slash, bang, file, recall)",
    file: "components/ProjectFileCompletionMenu.tsx",
    to: "composer",
    note: "Comboboxes driven by the composer's text field: the composer pass.",
  },
  {
    name: "Composer toolbar popovers (thinking, mode, speech, context, overflow)",
    file: "components/MessageInputToolbar.tsx",
    to: "composer",
    note: "The composer pass.",
  },
  {
    name: "New session queue and project choosers",
    file: "components/NewSessionQueueOptions.tsx",
    to: "composer",
    note: "The composer pass.",
  },
];

/** Family 4 (fields): where each legacy field class went. */
export type FieldDisposition =
  | "text"
  | "select"
  | "textarea"
  | "field"
  | "checkbox"
  | "keep"
  | "composer";

export interface LegacyField {
  name: string;
  /** Class whose use count represents the row. */
  counted?: string;
  /**
   * Every global class the row covers. The ban (pnpm buttons:check) rejects
   * each one once no global stylesheet styles it.
   */
  classes?: string;
  to: FieldDisposition;
  note?: string;
}

export const LEGACY_FIELDS: readonly LegacyField[] = [
  {
    name: "settings-input, settings-input-small",
    counted: "settings-input",
    classes: "settings-input settings-input-small",
    to: "text",
    note: "The settings text box (a hover-colored fill, 12 px type, green focus border); the small one a 96 px number box.",
  },
  {
    name: "settings-input-unit",
    counted: "settings-input-unit",
    classes: "settings-input-unit",
    to: "text",
    note: "A number box with its unit; TextInput's unit prop.",
  },
  {
    name: "output-appearance-number",
    counted: "output-appearance-number",
    classes: "output-appearance-number",
    to: "text",
    note: "The narrow number box beside appearance sliders.",
  },
  {
    name: "settings-select",
    counted: "settings-select",
    classes: "settings-select",
    to: "select",
  },
  {
    name: "form-select",
    counted: "form-select",
    classes: "form-select",
    to: "select",
    note: "Remote access setup's select, a second select look.",
  },
  {
    name: "settings-textarea",
    counted: "settings-textarea",
    classes: "settings-textarea",
    to: "textarea",
  },
  {
    name: "form-field",
    counted: "form-field",
    classes: "form-field",
    to: "field",
    note: "Label above input in remote access setup.",
  },
  {
    name: "login-field, login-checkbox-label",
    counted: "login-field",
    classes: "login-field login-checkbox-label",
    to: "field",
    note: "The login forms' label-above-input and remember-me checkbox.",
  },
  {
    name: "Feature text fields",
    counted: "session-rename-input",
    classes:
      "session-rename-input session-share-url-field changeset-file-filter-input claude-gateway-start-command output-appearance-number-wrap output-appearance-unit login-field-hint",
    to: "text",
    note: "One-off boxes: the sidebar rename, the share URL, the changeset filter, the gateway start command and the appearance number wraps.",
  },
  {
    name: "Feature checkboxes",
    counted: "codex-update-prompt__checkbox",
    classes:
      "codex-update-prompt__checkbox codex-update-prompt__checkbox-label session-list-item__checkbox session-list-header__select-all login-field-checkbox",
    to: "checkbox",
    note: "Hand-drawn or resized checkboxes: the Codex update prompt's custom box, list selection boxes, the login remember-me row.",
  },
  {
    name: "Composer fields",
    counted: "new-session-form-textarea",
    to: "composer",
    note: "The session input's and new-session form's textareas, queue options and speech controls: the composer pass (allowlisted).",
  },
  {
    name: "Chromeless editors",
    counted: "session-title-input",
    to: "keep",
    note: "The header title editor, the source editor's code textarea, the find bar and transcript search scope, the vhost address and search age fields: frames drawn by their owners (allowlisted with reasons).",
  },
];

/**
 * Family 5 (banners, badges, spinners and tabs): where each legacy status
 * class went. One table, censused in the family's order.
 */
export type StatusFamily = "banner" | "badge" | "spinner" | "tabs";
export type StatusDisposition = StatusFamily | "keep" | "composer";

export interface LegacyStatus {
  family: StatusFamily;
  name: string;
  /** Class whose use count represents the row. */
  counted?: string;
  /**
   * Every global class the row covers. The ban (pnpm buttons:check) rejects
   * each one once no global stylesheet styles it.
   */
  classes?: string;
  to: StatusDisposition;
  note?: string;
}

export const LEGACY_STATUS: readonly LegacyStatus[] = [
  {
    family: "banner",
    name: "settings-warning, settings-status-warning",
    counted: "settings-warning",
    classes: "settings-warning settings-status-warning",
    to: "banner",
    note: "Red text under a settings row (~25 uses): an error Banner, or the Field's error when it belongs to one field.",
  },
  {
    family: "banner",
    name: "form-error, form-warning, form-success",
    counted: "form-error",
    classes: "form-error form-warning form-success",
    to: "banner",
    note: "Tinted message boxes in settings forms.",
  },
  {
    family: "banner",
    name: "login-error",
    counted: "login-error",
    classes: "login-error",
    to: "banner",
    note: "The login pages' centered error box.",
  },
  {
    family: "banner",
    name: "Feature notices",
    counted: "provider-deprecation-notice",
    classes:
      "provider-deprecation-notice desktop-provider-notice source-projection-notice source-detail-banner public-share-error public-share-error--inline public-share-notice session-share-error btw-aside-error project-queue-inline-message-error file-access-settings-warning git-integration-options-warning external-session-warning model-switch-error",
    to: "banner",
    note: "One-off notice boxes and error lines, each with its own tint, border and padding.",
  },
  {
    family: "banner",
    name: "Notice components",
    to: "banner",
    note: "ReloadBanner, ProviderHostDegradedBanner, StorageFilesystemBanner, RemoteCompatibilityNotices, SessionCreationNotice, DraftSyncNotice, GoalNotice, PendingToolWarning and module error/notice blocks: their logic stays, their box is Banner.",
  },
  {
    family: "banner",
    name: "Not banners",
    to: "keep",
    note: "Toasts (transient, their own stack), tool output error text in the transcript, system message rows, empty states and the crash page.",
  },
  {
    family: "badge",
    name: "badge, badge-*",
    counted: "badge",
    classes:
      "badge-warning badge-error badge-info badge-muted badge-running badge-pending badge-success",
    to: "badge",
    note: "The renderers' badge (~70 uses, most in tool rows): tones map onto Badge's. The bare `badge` name is too common (module classes share it) to ban; its global rules are gone.",
  },
  {
    family: "badge",
    name: "Session and list badges",
    counted: "session-draft-badge",
    classes:
      "status-badge session-badge session-badge-btw session-badge-external session-badge-needs-input session-badge-executor session-archived-badge session-draft-badge archived-badge inbox-item-badge sidebar-nav-badge recent-sessions-badge session-project-queue-badge",
    to: "badge",
    note: "State and count badges in the session list, sidebar, header and inbox.",
  },
  {
    family: "badge",
    name: "Settings and feature badges",
    counted: "settings-status-badge",
    classes:
      "settings-status-badge settings-status-detected settings-status-not-detected device-current-badge public-share-badge git-status-badge subscription-usage-badge client-log-recording-badge ignored-tool-badge hidden-content-badge git-integration-option-pill model-switch-action-badge source-comment-badge webrun-preview-more-badge",
    to: "badge",
    note: "Detected/running states, current-device and default markers, counts and kind labels, each with its own padding and colors.",
  },
  {
    family: "badge",
    name: "Badge components",
    to: "badge",
    note: "StatusBadge, ProviderBadge, IssueTypeBadge, TrackerStatusBadge, QueuedEffortBadge, ClearloopRemainingBadge, HiddenContentBadge: their data stays, their box is Badge (provider colors through --badge-color).",
  },
  {
    family: "badge",
    name: "Clickable chips",
    to: "keep",
    note: "Chips that are buttons or links (user and host chips, attachment chips, filter chips) stay buttons: a Badge is not interactive.",
  },
  {
    family: "spinner",
    name: "Spinner classes",
    counted: "login-spinner",
    classes:
      "login-spinner public-share-spinner speech-transcribing-spinner fork-summary-display-object-spinner tool-spinner task-spinner",
    to: "spinner",
    note: "Eight spinner classes and about fourteen rotate keyframes (four of them a global `spin`), each with its own size, border and speed.",
  },
  {
    family: "spinner",
    name: "send-spinner",
    counted: "send-spinner",
    to: "composer",
    note: "The new-session submit's spinner: the composer pass.",
  },
  {
    family: "tabs",
    name: "Tab strips",
    counted: "model-switch-tab",
    classes: "model-switch-tabs model-switch-tab",
    to: "tabs",
    note: "Three hand-rolled strips (source control modes, the model/info dialog, the question panel), only one with roving focus.",
  },
];

/**
 * Family 7 (the dialog pattern): every Modal caller and hand-rolled modal,
 * with its width, header and footer shape at census time, and where it
 * went. `dialog` moves onto Dialog (sized box, padded body, footer action
 * row), `viewer` stays on Modal (files, diffs, media, logs), `keep` is a
 * hand-rolled surface left on purpose. Confirmations are separate:
 * CONFIRM_CALLS.
 */
export type DialogDisposition = "dialog" | "viewer" | "keep";

export interface LegacyDialog {
  /** Source file, relative to src/. */
  file: string;
  name: string;
  /** Width and footer shape at census time. */
  shape: string;
  /**
   * Global classes of the old frame or footer. The ban (pnpm buttons:check)
   * rejects each one once no global stylesheet styles it.
   */
  classes?: string;
  to: DialogDisposition;
}

export const LEGACY_DIALOGS: readonly LegacyDialog[] = [
  {
    file: "components/LongContextEffortWarningModal.tsx",
    name: "Long-context effort warning",
    shape:
      "Full modal width (1200px); model-switch-actions column of buttons; Cancel first, primary last.",
    classes: "long-context-effort-warning",
    to: "dialog",
  },
  {
    file: "components/RestartSessionModal.tsx",
    name: "Restart session",
    shape:
      "Full width; model-switch-content sections; model-switch-actions footer inside the scroll.",
    classes:
      "model-switch-content model-switch-actions model-switch-action-button model-switch-action-label model-switch-action-badge-main model-switch-action-badge-detail",
    to: "dialog",
  },
  {
    file: "components/SessionRecapModal.tsx",
    name: "Session recap",
    shape:
      "Full width; settings-group rows; model-switch-actions footer inside the scroll.",
    classes: "session-recap-modal",
    to: "dialog",
  },
  {
    file: "components/ModelSwitchModal.tsx",
    name: "Model switch and process info",
    shape:
      "Full width; tabs, a model list, model-switch-actions footer inside the scroll.",
    to: "dialog",
  },
  {
    file: "components/SessionRenameEditor.tsx",
    name: "Rename session (phone)",
    shape:
      "28rem card pinned near the top via :global(.modal):has(); Save before Cancel.",
    to: "dialog",
  },
  {
    file: "components/ProjectSessionDefaultsModal.tsx",
    name: "Project session defaults",
    shape:
      "Own width via :global(.modal):has(.body); actions row inside the scroll.",
    to: "dialog",
  },
  {
    file: "components/HostOfflineModal.tsx",
    name: "Host offline",
    shape: "Own width via :global(.modal):has(.content); primary action row.",
    to: "dialog",
  },
  {
    file: "components/CodexUpdatePrompt.tsx",
    name: "Codex update required",
    shape: "Full width; settings-group look; actions row inside the scroll.",
    to: "dialog",
  },
  {
    file: "components/onboarding/OnboardingWizard.tsx",
    name: "Onboarding wizard",
    shape:
      "Own width via .modal:has(.onboarding-wizard) in index.css; onboarding-footer with Skip at the start, Back/Next at the end.",
    classes:
      "onboarding-wizard onboarding-footer onboarding-footer-right onboarding-modal-title onboarding-step-actions onboarding-progress onboarding-progress-dot",
    to: "dialog",
  },
  {
    file: "components/SchemaWarning.tsx",
    name: "Schema validation failure",
    shape: "Full width; schema-warning-footer link row inside the scroll.",
    classes:
      "schema-warning-footer schema-warning-modal-content schema-warning-modal-title",
    to: "dialog",
  },
  {
    file: "components/SchemaValidationSummary.tsx",
    name: "Schema gap summary",
    shape: "Full width; a list, no footer.",
    to: "dialog",
  },
  {
    file: "components/RiskAffordance.tsx",
    name: "Risk explanation",
    shape: "Full width for a paragraph; no footer.",
    to: "dialog",
  },
  {
    file: "components/SessionShareModal.tsx",
    name: "Share session",
    shape:
      "Anchored on desktop; own width via .modal:has(.session-share-modal) in index.css; session-share-actions row.",
    classes: "session-share-modal",
    to: "dialog",
  },
  {
    file: "components/PublicShareManagerModal.tsx",
    name: "Public share manager",
    shape:
      "Anchored at any width; own width; primary/secondary rows per share.",
    to: "dialog",
  },
  {
    file: "components/PublicFileShareModal.tsx",
    name: "Share file",
    shape:
      "Anchored; own width via :global(.modal):has(.modal); primary action.",
    to: "dialog",
  },
  {
    file: "pages/ReviewSubmitModal.tsx",
    name: "Submit review",
    shape: "Full width; module .modal wrapper; actions row inside the scroll.",
    to: "dialog",
  },
  {
    file: "pages/RepoStatusBar.tsx",
    name: "Incoming commits",
    shape: "Full width; a list and a pull action.",
    to: "dialog",
  },
  {
    file: "pages/settings/ServerConnectionsSettings.tsx",
    name: "Server connection add, detail and remove",
    shape:
      "Shared wrapper; widths and header via :global(.modal):has(.confirmation/.detail); danger confirm row.",
    to: "dialog",
  },
  {
    file: "pages/settings/ProvidersSettings.tsx",
    name: "Additional models editor",
    shape:
      "Anchored; 32rem via .modal:has(.providers-additional-models-editor) in renderers.css.",
    classes: "providers-additional-models-editor",
    to: "dialog",
  },
  {
    file: "pages/settings/VhostOauthSettings.tsx",
    name: "OAuth logs",
    shape: "Full width log viewer with header actions.",
    to: "viewer",
  },
  {
    file: "components/ProcessInfoModal.tsx",
    name: "Process info",
    shape: "Full width read-only panel.",
    to: "viewer",
  },
  {
    file: "components/ToolApprovalPanel.tsx",
    name: "Tool approval details",
    shape: "Full width read-only tool input.",
    to: "viewer",
  },
  {
    file: "components/ActivityDetailModal.tsx",
    name: "Activity detail",
    shape: "Full width; header actions.",
    to: "viewer",
  },
  {
    file: "pages/GitStatusDiffPreview.tsx",
    name: "Diff, file, blame, commit and working-tree viewers",
    shape:
      "Full width/height viewers; back gesture; header actions (also BlameBrowser, CommitBrowser, WorkingTreeBrowser).",
    to: "viewer",
  },
  {
    file: "components/LocalMediaModal.tsx",
    name: "Media, diagram and attachment viewers",
    shape: "image-viewer variant (also DiagramViewer, AttachmentChip).",
    to: "viewer",
  },
  {
    file: "components/SessionManagedViewer.tsx",
    name: "Session panels and search detail",
    shape: "Modal or docked pane via ModalChrome (also SearchDetail).",
    to: "viewer",
  },
  {
    file: "components/GoalPanel.tsx",
    name: "Goal editor",
    shape:
      "Anchored form panel with its own overlay, focus trap and useModalLayer.",
    to: "keep",
  },
  {
    file: "components/SourceEditor.tsx",
    name: "Source editor workspace",
    shape: "Full-screen workspace with its own trap and save shortcut.",
    to: "keep",
  },
  {
    file: "components/FilePathLink.tsx",
    name: "File viewer",
    shape:
      "A <dialog open> inside .modal-overlay, portaled into the session layer.",
    to: "keep",
  },
];

/** Family 7: the `window.confirm` calls at census time. */
export const CONFIRM_CALLS: readonly { file: string; asks: string }[] = [
  { file: "pages/HostPickerPage.tsx", asks: "Remove a saved host" },
  { file: "pages/AgentsPage.tsx", asks: "Kill an agent process" },
  {
    file: "pages/ProjectsPage.tsx",
    asks: "Create a missing project folder; add a project (2)",
  },
  { file: "pages/settings/UsersSettings.tsx", asks: "Delete a user" },
  {
    file: "pages/settings/SettingsBackupActions.tsx",
    asks: "Load a settings backup",
  },
  {
    file: "pages/settings/ProjectAppInventorySection.tsx",
    asks: "Stop or forget a project app (2)",
  },
  {
    file: "pages/settings/RemoteAccessSettings.tsx",
    asks: "Turn off remote access",
  },
  {
    file: "api/connectionImpact.ts",
    asks: "A setting may disconnect this client (legacy servers)",
  },
  {
    file: "hooks/useConnectionImpactConfirmation.ts",
    asks: "A setting will disconnect this client",
  },
  { file: "hooks/useSessionRewindControls.ts", asks: "Cancel a clear loop" },
  {
    file: "components/PublicShareManagerModal.tsx",
    asks: "Revoke or freeze a share (2)",
  },
  { file: "components/PublicFileShareModal.tsx", asks: "Revoke a file share" },
  { file: "components/FileVhostSection.tsx", asks: "Stop a file site" },
  {
    file: "components/SourceEditor.tsx",
    asks: "Discard edits; register a rebuild hook (2)",
  },
  {
    file: "components/ProjectAppViewer.tsx",
    asks: "Restart or stop the project app (2)",
  },
];
