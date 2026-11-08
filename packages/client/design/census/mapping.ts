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
    to: "secondary",
    small: true,
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
    to: "outline",
    note: "Transparent with a border; 'secondary' in name only.",
  },
  {
    classes: "expand-button",
    counted: "expand-button",
    to: "outline",
    note: "Muted text and a 44 px touch height of its own.",
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
    to: "base",
    note: "Mono file-link card (Read/ViewImage/WriteStdin renderers); keeps own border/link color, .file-line-count child, fixed-font rules.",
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
    note: "Floating round source/rendered toggle (FixedFontMathToggle, ReadRenderer); keep absolute position and hover-reveal opacity via parent.",
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
    to: "danger",
    small: true,
    icon: true,
    note: "Share row revoke modifier, filled red with 13px icon.",
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
    to: "danger",
    small: true,
    icon: true,
    note: "Per-scope/type revoke/confirm icon, filled red; stretches row height.",
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
  to: SwitchDisposition;
  note?: string;
}

export const LEGACY_SWITCHES: readonly LegacySwitch[] = [
  {
    name: "toggle-switch + toggle-slider",
    counted: "toggle-switch",
    to: "switch",
    note: "Pasted markup: a hidden checkbox and a styled span. Same geometry; becomes role=switch.",
  },
  {
    name: "patient-queue-switch",
    counted: "patient-queue-switch",
    to: "segmented",
    note: "A two-option track (regular / patient), not an on/off switch. The census shows its current use count.",
  },
  {
    name: "font-size-selector + font-size-option",
    counted: "font-size-option",
    to: "segmented",
    note: "The de facto segmented control; the proposal keeps its look.",
  },
  {
    name: "model-settings-chip-group",
    counted: "model-settings-chip-group",
    to: "segmented",
    note: "Wraps font-size-option buttons in model and recap settings.",
  },
  {
    name: "model-switch-chip-group + model-switch-chip",
    counted: "model-switch-chip",
    to: "segmented",
  },
  {
    name: "AttachmentQualityToggle",
    to: "segmented",
    note: "Component with its own module styles.",
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
