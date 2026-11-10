/**
 * UI primitives barrel. Import what you need:
 *   import { Button, Icon, openContextMenu, toast, openDialog } from "../../components/ui";
 * Importing this module also loads the component CSS (`ui.css`).
 */
import "./ui.css";

export * from "./icons";
export * from "./util";
export { Icon, type IconProps } from "./Icon";
export { Button, IconButton, type ButtonProps, type IconButtonProps } from "./Button";
export { TextField, SearchField, type TextFieldProps, type SearchFieldProps } from "./TextField";
export { Checkbox, type CheckboxProps } from "./Checkbox";
export { Select, type SelectProps, type SelectOption } from "./Select";
export { MenuHost, openContextMenu, openMenu, closeMenu, isMenuOpen, type MenuItem } from "./Menu";
export { Popup, type PopupProps, type PopupPlacement } from "./Popup";
export { Dialog, DialogHost, openDialog, hasOpenDialog, moveDialogBy, type DialogProps, type DialogAction, type DialogComponentProps } from "./Dialog";
export { ConfirmDialog, type ConfirmProps, type ConfirmResult, type ConfirmCheckbox } from "./ConfirmDialog";
export {
  ToastHost, toast, dismissToast, notifications, unreadCount, markNotificationsRead, clearNotifications,
  type ToastOptions, type ToastAction, type ToastKind, type Notification,
} from "./Toast";
export { TooltipHost, tooltip, tip, type TooltipValue } from "./Tooltip";
export { Splitter, loadSplitSize, type SplitterProps } from "./Splitter";
export { VirtualList, type VirtualListProps, type VirtualListApi } from "./VirtualList";
export { Tree, createExpanded, type TreeProps, type TreeApi, type TreeRowInfo } from "./Tree";
export { Badge, Pill, type BadgeProps, type PillProps } from "./Badge";
export { Kbd, type KbdProps } from "./Kbd";
export { Spinner, ProgressBar, type ProgressBarProps } from "./Spinner";
export { EmptyState, type EmptyStateProps } from "./EmptyState";
export { SegmentedControl, type SegmentedControlProps, type SegmentOption } from "./SegmentedControl";
export { Avatar, type AvatarProps } from "./Avatar";
export {
  RepoChip, RepoIcon, RefPill, RefPills, AheadBehind, StatusLetter,
  type RepoChipProps, type RefPillProps, type RefPillsProps, type AheadBehindProps,
} from "./GitBits";
export { WindowControls, dragRegion } from "./WindowControls";
export { HeaderSlot, HeaderSlotTarget, type HeaderSlotName } from "./HeaderSlot";
