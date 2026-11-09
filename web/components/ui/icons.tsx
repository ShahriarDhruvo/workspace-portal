// The portal's icons: lucide-react (as in the Web Shell), 16px with a thin 1.5 stroke, in currentColor.
// Import icons from here rather than from lucide-react so size, stroke and aria-hidden stay consistent.
import {
  ArrowUpRight,
  Check,
  ChevronLeft,
  CircleAlert,
  Copy,
  Ellipsis,
  Eye,
  KeyRound,
  LogOut,
  Plus,
  RefreshCw,
  ScrollText,
  Shield,
  Square,
  SquarePen,
  SquareTerminal,
  Trash2,
  UserCheck,
  Users,
  UserX,
  X,
  type LucideIcon,
  type LucideProps,
} from "lucide-react";

export type IconProps = LucideProps;

function icon(Glyph: LucideIcon, name: string) {
  function Icon({ size = 16, strokeWidth = 1.5, ...props }: IconProps) {
    return <Glyph size={size} strokeWidth={strokeWidth} aria-hidden="true" focusable="false" {...props} />;
  }
  Icon.displayName = name;
  return Icon;
}

export const PlusIcon = icon(Plus, "PlusIcon");
export const EllipsisIcon = icon(Ellipsis, "EllipsisIcon");
export const CloseIcon = icon(X, "CloseIcon");
export const CheckIcon = icon(Check, "CheckIcon");
export const CopyIcon = icon(Copy, "CopyIcon");
export const EditIcon = icon(SquarePen, "EditIcon");
export const TrashIcon = icon(Trash2, "TrashIcon");
export const RefreshIcon = icon(RefreshCw, "RefreshIcon");
export const WarningIcon = icon(CircleAlert, "WarningIcon");
export const ShieldIcon = icon(Shield, "ShieldIcon");
export const UsersIcon = icon(Users, "UsersIcon");
export const RightUpIcon = icon(ArrowUpRight, "RightUpIcon");
export const BackIcon = icon(ChevronLeft, "BackIcon");
export const LogOutIcon = icon(LogOut, "LogOutIcon");
export const TerminalIcon = icon(SquareTerminal, "TerminalIcon");
export const AuditIcon = icon(ScrollText, "AuditIcon");
export const KeyIcon = icon(KeyRound, "KeyIcon");
export const StopIcon = icon(Square, "StopIcon");
export const UserCheckIcon = icon(UserCheck, "UserCheckIcon");
export const UserXIcon = icon(UserX, "UserXIcon");
export const EyeIcon = icon(Eye, "EyeIcon");
